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

/** Why something failed, in the error's own words. */
export function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
