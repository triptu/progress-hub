import { statSync } from "node:fs";
import { join } from "node:path";
import { localPath, mediaKind } from "../../core/parse.ts";
import { imageSize } from "./image-size.ts";
import type { Html, WorkId } from "../../core/types.ts";

/** The URL a page's relative path is served at. */
export function fileUrl(work: WorkId, path: string): string {
  const parts = path.split("/").filter((part) => part !== "" && part !== ".");
  return `/files/${encodeURIComponent(work)}/${parts.map(encodeURIComponent).join("/")}`;
}

/**
 * A picture's address with the file's time on it. The hub lets a browser keep what it loads from such an
 * address for good, so a reload shows the picture at once; a changed file has a new address.
 * The app builds the same address from a media item's time, in `pictureSrc`.
 */
function versioned(url: string, file: string): string {
  try {
    return `${url}?v=${statSync(file).mtime.getTime()}`;
  } catch {
    return url;
  }
}

function rewrite(work: WorkId, target: string): string {
  const path = localPath(target);
  if (path === null || path === "" || path.startsWith("/") || path.startsWith("~")) return target;
  const suffix = /[?#].*$/.exec(target)?.[0] ?? "";
  return fileUrl(work, path) + suffix;
}

function attr(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

/**
 * Markdown to HTML for the browser, which sanitises it. Relative links point into /files/<work>/;
 * image syntax with a video becomes a player, and with an HTML file a sandboxed frame. An image
 * opens in full on a click and shows its alt text as a caption. It stays inline, so images in a row
 * still share one paragraph and flow as a gallery. With `dir`, the work's folder, an image the page keeps
 * there carries its pixel size, so the browser holds its room before it loads.
 */
export function renderMarkdown(markdown: string, work: WorkId, dir?: string): Html {
  const local = (name: string) => ({
    element(el: HTMLRewriterTypes.Element) {
      const value = el.getAttribute(name);
      if (value) el.setAttribute(name, rewrite(work, value));
    },
  });
  let inLink = 0;
  return new HTMLRewriter()
    .on("a", {
      element(el) {
        inLink++;
        el.onEndTag(() => {
          inLink--;
        });
      },
    })
    .on("a[href]", local("href"))
    .on("video[src], audio[src], source[src], iframe[src]", local("src"))
    .on("video[poster]", local("poster"))
    .on("img[src]", {
      element(el) {
        const raw = el.getAttribute("src") ?? "";
        const src = attr(rewrite(work, raw));
        // Attribute values come back as written in the HTML, already escaped.
        const label = el.getAttribute("alt") ?? "";
        const kind = mediaKind(raw);
        if (kind === "video") el.replace(`<video controls preload="metadata" src="${src}" title="${label}"></video>`, { html: true });
        else if (kind === "page") el.replace(`<iframe sandbox="allow-scripts" src="${src}" title="${label}"></iframe>`, { html: true });
        else {
          const path = localPath(raw);
          const file = dir && path !== null && !path.startsWith("/") && !path.startsWith("~") && !path.split("/").includes("..") ? join(dir, path) : null;
          el.setAttribute("src", file && !/[?#]/.test(raw) ? versioned(rewrite(work, raw), file) : rewrite(work, raw));
          const size = file ? imageSize(file) : null;
          if (size) el.setAttribute("style", `--w:${size.width};--h:${size.height}`);
          if (inLink > 0) return;
          el.before(`<a class="fig" href="${src}" target="_blank" rel="noopener noreferrer">`, { html: true });
          el.after(`${label ? `<span class="cap" aria-hidden="true">${label.replace(/</g, "&lt;").replace(/>/g, "&gt;")}</span>` : ""}</a>`, { html: true });
        }
      },
    })
    .transform(Bun.markdown.html(markdown, { autolinks: true })) as Html;
}

/** One line of Markdown as inline HTML, for an item's title. */
export function renderInline(markdown: string, work: WorkId, dir?: string): Html {
  return renderMarkdown(markdown, work, dir).replace(/^<p>([\s\S]*)<\/p>\s*$/, "$1") as Html;
}
