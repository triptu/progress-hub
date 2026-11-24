/** Markdown as plain text. Pure, so the browser uses it too. */

/** Plain text of a line of Markdown, for titles and ids. */
export function plain(markdown: string): string {
  return markdown
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/<[^>]+>/g, "")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/(\*\*|__|~~)(.*?)\1/g, "$2")
    .replace(/(^|\W)[*_](\S(?:.*?\S)?)[*_](?=\W|$)/g, "$1$2")
    .replace(/\s+/g, " ")
    .trim();
}

/** The first sentence of some Markdown's first paragraph, as plain text. */
export function firstSentence(markdown: string): string {
  const text = plain(markdown.split(/\n\s*\n/)[0] ?? "");
  return /^.*?[.!?](?=\s|$)/.exec(text)?.[0] ?? text;
}

/** A goal as one line: its paragraphs and list items, each as plain text. Sentences follow each other as prose, and a dot parts what isn't one. */
export function goalLine(markdown: string): string {
  const parts: string[] = [];
  for (const block of markdown.split(/\n\s*\n/)) {
    const lines = block.split("\n").filter((line) => line.trim() !== "");
    const listed = lines.length > 0 && lines.every((line) => /^\s*([-*+]|\d+[.)])\s+/.test(line) || /^\s{2,}\S/.test(line));
    if (listed) parts.push(...lines.filter((line) => /^\s*([-*+]|\d+[.)])\s+/.test(line)).map((line) => plain(line.replace(/^\s*([-*+]|\d+[.)])\s+/, ""))));
    else parts.push(plain(block));
  }
  return parts.filter((part) => part !== "").reduce((line, part) => (line === "" ? part : `${line}${/[.!?]$/.test(line) ? " " : " · "}${part}`), "");
}

/** The first paragraph of some Markdown that holds words, as plain text. Images are left out, not read as their alt text. */
export function firstParagraph(markdown: string): string {
  for (const block of markdown.replace(/!\[[^\]]*\]\([^)]*\)/g, "").split(/\n\s*\n/)) {
    const text = plain(block);
    if (text) return text;
  }
  return "";
}

/**
 * An item's first line without its `###` or bullet marker, and the lines after it, dedented.
 * A title that starts with `!` and a space is one the user should not miss; the mark is not part of the title.
 */
export function splitItem(markdown: string): { readonly title: string; readonly body: string; readonly important: boolean } {
  const [first = "", ...rest] = markdown.split("\n");
  const indents = rest.filter((line) => line.trim() !== "").map((line) => line.length - line.trimStart().length);
  // What is under a bullet is indented to sit in it. What is under a `###` heading is not, so an indent there is the text's own: code.
  const indent = indents.length === 0 || first.startsWith("#") ? 0 : Math.min(...indents);
  const title = first.replace(/^(###\s+|[-*+]\s+(\[[ xX]\]\s+)?|\d+[.)]\s+)/, "").replace(/\s+#+\s*$/, "");
  return {
    title: title.replace(/^!\s+/, ""),
    body: trimLines(rest.map((line) => line.slice(indent))).join("\n"),
    important: /^!\s+\S/.test(title),
  };
}

export function trimLines(lines: readonly string[]): readonly string[] {
  let start = 0;
  let end = lines.length;
  while (start < end && lines[start]?.trim() === "") start++;
  while (end > start && lines[end - 1]?.trim() === "") end--;
  return lines.slice(start, end);
}

/**
 * The line of a Shipped item that says whether the user can try it yet: `Live: in alpha 0.42` once it is where
 * they would use it, `Not live: the deploy is run by hand` while it has merged and is not. Emphasis around the
 * words is allowed, and so is the word alone.
 */
const LIVE_LINE = /^ {0,3}(?:\*\*|__)?(not live(?: yet)?|live)(?:\*\*|__)?[ \t]*(?::(?:\*\*|__)?[ \t]*(.*)|\.?[ \t]*)$/i;

/** Where the text under an item's title says whether it is live: the line, and what it says. Code is not read, so a page can show the mark as an example. */
export function liveLine(body: string): { readonly at: number; readonly on: boolean; readonly note: string } | null {
  let fence: string | null = null;
  for (const [at, line] of body.split("\n").entries()) {
    const mark = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (mark !== undefined && (fence === null || mark.startsWith(fence))) {
      fence = fence === null ? mark : null;
      continue;
    }
    const match = fence === null ? LIVE_LINE.exec(line) : null;
    if (match) return { at, on: match[1]?.toLowerCase() === "live", note: (match[2] ?? "").trim() };
  }
  return null;
}

/** What a Shipped item says about being live, with the words after the mark. Null when it does not say. */
export function liveMark(markdown: string): { readonly on: boolean; readonly note: string } | null {
  const found = liveLine(splitItem(markdown).body);
  return found && { on: found.on, note: found.note };
}

/** An item's text under its title without the line that says whether it is live, which the hub shows as a mark. */
export function withoutLiveMark(body: string): string {
  const found = liveLine(body);
  if (!found) return body;
  return body.split("\n").filter((_, at) => at !== found.at).join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

/** A first line past this many characters is a paragraph, not a name. */
export const LONG_TITLE = 160;

/** Why something failed, in the error's own words. */
export function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
