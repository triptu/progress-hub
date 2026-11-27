import type { Html } from "../../core/types.ts";
import { sanitize } from "./html.ts";
import { markdownBody } from "./markdown.ts";
import type { DocumentFormat } from "./media.ts";

/** The most rows of a table file shown. A longer one says how many more the file has. */
const MOST_ROWS = 2000;

/**
 * A document as HTML to show in the hub, from the file's text and the address it was loaded from. The central hub
 * keeps only a file's bytes, so the browser renders it.
 */
export function documentHtml(text: string, src: string, format: DocumentFormat): string {
  switch (format) {
    case "markdown":
      return markdownHtml(text, src);
    case "table":
      return tableHtml(text, /\.tsv$/i.test(src.replace(/[?#].*$/, "")) ? "\t" : ",");
    case "json":
      return codeHtml(laidOut(text));
    case "text":
      return codeHtml(text, /\.(diff|patch)$/i.test(src.replace(/[?#].*$/, "")));
  }
}

/**
 * Markdown, without its front matter. A relative link or picture is read from the file's own folder. A path elsewhere
 * on the machine keeps its words, as on a work's page, since the hub can't open it.
 */
function markdownHtml(markdown: string, src: string): string {
  const doc = new DOMParser().parseFromString(markdownBody(markdown), "text/html");
  const base = new URL(src, location.origin);
  for (const [selector, name] of [["a[href]", "href"], ["img[src]", "src"], ["video[src]", "src"], ["source[src]", "src"]] as const) {
    for (const el of doc.querySelectorAll(selector)) {
      const value = el.getAttribute(name) ?? "";
      if (/^(\/(?!\/)|~)/.test(value) && name === "href") {
        el.removeAttribute("href");
        el.setAttribute("title", `Outside the work's folder, so the hub can't open it: ${value}`);
      } else if (value && !/^([a-z][a-z0-9+.-]*:|#|\/)/i.test(value)) {
        const url = new URL(value, base);
        el.setAttribute(name, url.pathname + url.search + url.hash);
      }
    }
  }
  return sanitize(doc.body.innerHTML as Html);
}

/** JSON laid out two spaces to a level, or as written when it does not parse. */
function laidOut(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

/** Text as it is, in the code face. In a diff, each added and removed line says so, for its colour. */
function codeHtml(text: string, diff = false): string {
  const pre = document.createElement("pre");
  const code = pre.appendChild(document.createElement("code"));
  if (!diff) code.textContent = text;
  else {
    for (const line of text.split("\n")) {
      const row = code.appendChild(document.createElement("span"));
      row.textContent = `${line}\n`;
      const kind = line.startsWith("+++") || line.startsWith("---") ? "file" : line.startsWith("+") ? "add" : line.startsWith("-") ? "del" : line.startsWith("@@") ? "hunk" : null;
      if (kind) row.dataset.line = kind;
    }
  }
  return pre.outerHTML;
}

/** A CSV or TSV file as a table, its first row the head. A quoted CSV field may hold commas, quotes and line breaks. */
function tableHtml(text: string, separator: "," | "\t"): string {
  const rows = separator === "\t" ? text.split(/\r?\n/).map((line) => line.split("\t")) : csvRows(text);
  while (rows.length && rows.at(-1)!.every((cell) => cell === "")) rows.pop();
  const table = document.createElement("table");
  const [head, ...body] = rows;
  if (head) {
    const tr = table.createTHead().insertRow();
    for (const cell of head) tr.appendChild(document.createElement("th")).textContent = cell;
  }
  const tbody = table.createTBody();
  for (const row of body.slice(0, MOST_ROWS)) {
    const tr = tbody.insertRow();
    for (const cell of row) tr.insertCell().textContent = cell;
  }
  const more = body.length - MOST_ROWS;
  return table.outerHTML + (more > 0 ? `<p>${more.toLocaleString()} more rows are in the file.</p>` : "");
}

function csvRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  const endCell = () => {
    row.push(cell);
    cell = "";
  };
  const endRow = () => {
    endCell();
    rows.push(row);
    row = [];
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quoted && c === '"' && text[i + 1] === '"') {
      cell += '"';
      i++;
    } else if (c === '"') quoted = !quoted;
    else if (quoted) cell += c;
    else if (c === ",") endCell();
    else if (c === "\n") endRow();
    else if (c !== "\r") cell += c;
  }
  if (cell !== "" || row.length) endRow();
  return rows;
}
