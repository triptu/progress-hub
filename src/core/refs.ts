/** A GitHub pull request or commit link. `url` is the link as written, with any path after the number or hash. */
export type GitHubRef =
  | { readonly kind: "pr"; readonly url: string; readonly repo: string; readonly number: number }
  | { readonly kind: "commit"; readonly url: string; readonly repo: string; readonly sha: string };

const LINK = /https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/(?:pull\/(\d+)|commit\/([0-9a-f]{7,40}))(?!\w)(?:\/[\w/-]*)?/gi;

function toRef([url = "", repo = "", number, sha = ""]: readonly (string | undefined)[]): GitHubRef {
  return number !== undefined ? { kind: "pr", url, repo, number: Number(number) } : { kind: "commit", url, repo, sha: sha.toLowerCase() };
}

/** Every pull request and commit link in some text, in order. */
export function githubRefs(text: string): GitHubRef[] {
  return [...text.matchAll(LINK)].map(toRef);
}

/** A link as the pull request's number or the commit's short hash. */
export function refLabel(ref: GitHubRef): string {
  return ref.kind === "pr" ? `#${ref.number}` : ref.sha.slice(0, 7);
}

/** Text with its GitHub pull request and commit links written as the number or the short hash. */
export function shortRefs(text: string): string {
  return text.replace(LINK, (...match: (string | undefined)[]) => refLabel(toRef(match)));
}

/**
 * A line often opens with the pull request or commit it is about: "#16565 Every dependency version…".
 * This finds that reference where the words after it stand on their own: "#26 is open" needs its subject.
 */
export const LEADING_REF = /^(#\d+|[0-9a-f]{7})[\s:,.]+(?=\p{Lu})/u;

/** GitHub links in HTML text that no anchor holds yet, such as one the Markdown renderer left bare because a colon follows it. */
export const BARE_GITHUB_LINK = new RegExp(`(?<![="'>/\\w])${LINK.source}`, "gi");
