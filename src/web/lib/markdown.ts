import { marked, type Token } from "marked";

/**
 * Markdown as HTML, without its front matter. A line break is kept, as in a chat or a GitHub comment: agents write
 * transcripts and logs a line to an entry. A paragraph wrapped by hand at a fixed width is read as one, as Markdown
 * reads it, so its lines don't end short of the column.
 */
export function markdownBody(markdown: string): string {
  return marked.parse(markdown.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, ""), {
    async: false,
    breaks: true,
    walkTokens(token) {
      if ((token.type === "paragraph" || token.type === "text") && token.tokens && wrappedByHand(token.raw)) token.tokens = unbroken(token.tokens);
    },
  });
}

/**
 * Whether a paragraph's lines are one text wrapped at a fixed width: every line but the last near the same length,
 * and most going on into the next mid-sentence, in lower case. A transcript or a list a line to an entry varies in
 * length, or ends each line, or starts the next with a capital, a timestamp or a quote.
 */
export function wrappedByHand(raw: string): boolean {
  const lines = raw.trimEnd().split("\n");
  const body = lines.slice(0, -1);
  if (body.length === 0 || body.some((line) => line.length < 50 || line.length > 120)) return false;
  const lengths = body.map((line) => line.length);
  if (Math.max(...lengths) - Math.min(...lengths) > 30) return false;
  const goesOn = body.filter((line, at) => !/[.!?:;)\]]["'”’]?\s*$/.test(line) && /^\s*[a-z0-9`(*_]/.test(lines[at + 1] ?? "")).length;
  return goesOn * 2 > body.length;
}

const unbroken = (tokens: Token[]): Token[] => tokens.map((token) => (token.type === "br" ? { type: "text", raw: " ", text: " " } : "tokens" in token && token.tokens ? { ...token, tokens: unbroken(token.tokens) } : token));
