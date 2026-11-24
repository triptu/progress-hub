import DOMPurify from "dompurify";
import type { Commit, Html, PullRequest } from "../../core/types.ts";
import { githubRefs, refLabel } from "../../core/refs.ts";

/**
 * Every piece of HTML from the server passes through here before it enters the document.
 * Scripts and event handlers go. Frames stay, always sandboxed and never same-origin, because
 * page files are served from this origin.
 */

const SANDBOX_ALLOWED = new Set(["allow-scripts", "allow-popups", "allow-forms", "allow-modals", "allow-downloads"]);

DOMPurify.addHook("afterSanitizeAttributes", (node) => {
  if (node.tagName === "IFRAME") {
    const asked = (node.getAttribute("sandbox") ?? "allow-scripts").split(/\s+/);
    node.setAttribute("sandbox", asked.filter((token) => SANDBOX_ALLOWED.has(token)).join(" "));
    node.setAttribute("loading", "lazy");
  }
  if (node.tagName === "A" && node.textContent === node.getAttribute("href")) {
    const ref = githubRefs(node.textContent ?? "")[0];
    if (ref && ref.url === node.textContent) node.textContent = refLabel(ref);
  }
  // A link out of the hub, or to a file a page keeps beside it, opens in a tab of its own, so the hub stays where it was.
  if (node.tagName === "A" && /^(https?:|\/files\/)/i.test(node.getAttribute("href") ?? "")) {
    node.setAttribute("target", "_blank");
    node.setAttribute("rel", "noopener noreferrer");
  }
  if (node.tagName === "IMG") node.setAttribute("loading", "lazy");
});

const CONFIG = {
  ADD_TAGS: ["iframe"],
  ADD_ATTR: ["sandbox", "allow", "allowfullscreen", "loading", "target", "controls", "playsinline", "muted", "loop", "poster", "open"],
  FORBID_TAGS: ["style", "form", "input", "button", "textarea", "select"],
};

export function sanitize(html: Html): string {
  return DOMPurify.sanitize(html, CONFIG);
}

/**
 * A line of server HTML without its links, their words kept, for a line that is itself one link.
 * A link written as its bare address reads as the site and the last part of the path, since an address
 * can't be followed from here and would fill the line.
 */
export function withoutLinks(html: string): string {
  return html
    .replace(/<a\b[^>]*>\s*(https?:\/\/[^<\s]+)\s*<\/a>/gi, (whole, address: string) => {
      if (!URL.canParse(address)) return whole;
      const { host, pathname } = new URL(address);
      const last = pathname.split("/").filter(Boolean).at(-1);
      return last ? `${host}/…/${last}` : host;
    })
    .replace(/<\/?a\b[^>]*>/gi, "");
}

/** The words of a piece of server HTML, for a short preview. */
export function wordsOf(html: Html): string {
  return (new DOMParser().parseFromString(sanitize(html), "text/html").body.textContent ?? "").replace(/\s+/g, " ").trim();
}

/** The first image in a piece of server HTML, for a thumbnail in the feed, with the pixel size the hub read for it. */
export function firstImage(html: Html): { readonly src: string; readonly size: { readonly "--w": string; readonly "--h": string } | null } | null {
  const img = new DOMParser().parseFromString(sanitize(html), "text/html").querySelector("img");
  const src = img?.getAttribute("src");
  if (!img || !src) return null;
  const width = img.style.getPropertyValue("--w");
  const height = img.style.getPropertyValue("--h");
  return { src, size: width && height ? { "--w": width, "--h": height } : null };
}

/**
 * A title line often opens with the pull request or commit it is about: "#16565 Every dependency version…".
 * Its chips already show that one, so the line starts at its first word.
 */
/**
 * A line often closes by naming the commits it landed in: "… Commit 3992d10." Its chips show those, so
 * that last sentence goes. One that says anything more than the commits stays.
 */
export function withoutTrailingCommits(html: Html, commits: readonly Commit[]): Html {
  const tail = /(?:^|\s)Commits?:?\s+((?:<a [^>]*>[0-9a-f]{7,40}<\/a>(?:\s*,\s*|\s+and\s+)?)+)\.?\s*$/.exec(html);
  const named = [...(tail?.[1] ?? "").matchAll(/>([0-9a-f]{7,40})</g)].map((match) => match[1] ?? "");
  if (!tail || !named.every((sha) => commits.some((commit) => commit.sha.startsWith(sha)))) return html;
  const rest = html.slice(0, tail.index).trimEnd();
  return rest === "" ? html : (rest as Html);
}

export function withoutLeadingRef(html: Html, prs: readonly PullRequest[], commits: readonly Commit[]): Html {
  // Only where the words after it stand on their own: "#26 is open" needs its subject.
  const lead = /^<a [^>]*>(#\d+|[0-9a-f]{7})<\/a>[\s:,.]*(?=\p{Lu})/u.exec(html);
  const label = lead?.[1];
  if (!lead || !label) return html;
  const shown = prs.some((pr) => `#${pr.number}` === label) || commits.some((commit) => commit.sha.startsWith(label));
  return shown ? (html.slice(lead[0].length) as Html) : html;
}
