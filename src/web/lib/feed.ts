import type { Commit, FeedEntry, Html, Instant, PullRequest, WorkId } from "../../core/types.ts";
import { githubRefs, shortRefs } from "../../core/refs.ts";
import { firstSentence } from "../../core/text.ts";
import { viewKey } from "./marks.ts";
import { matches } from "./needs.ts";
import { dayOf, isToday } from "./time.ts";

export type Tone = "needs" | "asked" | "cleared" | "doing" | "next" | "decided" | "shipped" | "started" | "finished" | "reopened" | "status";

/** How much a line matters to someone skimming: what needs them or what a page marked, what moved the work on, and the rest. */
export type Weight = "high" | "normal" | "low";

/**
 * What one journal event says in the feed. Removed decisions and shipped lines, and an emptied summary, say nothing.
 * `key` is what the user marks to say they have looked at it. Only what shipped has one.
 */
export type FeedLine =
  | {
      readonly kind: "text";
      readonly key: string | null;
      readonly tone: Tone;
      readonly weight: Weight;
      /** What changed, without the tone's own word, as plain text for search and short lists. Empty when the tone says it all. */
      readonly text: string;
      /** The same as inline HTML, as the work's page shows it. Null when there is only the plain text. */
      readonly titleHtml: Html | null;
      readonly html: Html | null;
      /** On GitHub: the pull request or commit a Shipped line links first, known to the hub or not. */
      readonly href: string | null;
      readonly prs: readonly PullRequest[];
      readonly commits: readonly Commit[];
    }
  | { readonly kind: "pr"; readonly key: string | null; readonly weight: Weight; readonly change: "opened" | "merged" | "closed"; readonly pr: PullRequest };

export const TONE_LABEL: Record<Tone, string> = {
  needs: "Needs you",
  asked: "Asked",
  cleared: "Resolved",
  doing: "In progress",
  next: "Next up",
  decided: "Decided",
  shipped: "Shipped",
  started: "Started",
  finished: "Finished",
  reopened: "Reopened",
  status: "Status",
};

const TONE_WEIGHT: Record<Tone, Weight> = { doing: "low", next: "low", needs: "high", asked: "normal", shipped: "normal", finished: "normal", decided: "low", cleared: "low", started: "low", reopened: "low", status: "low" };

function text(entry: FeedEntry, tone: Tone, words: string, extra: Partial<Extract<FeedLine, { kind: "text" }>> = {}): FeedLine {
  const item = tone !== "started" && tone !== "finished" && tone !== "reopened" && tone !== "status";
  return { kind: "text", key: null, tone, weight: entry.important ? "high" : TONE_WEIGHT[tone], text: words, titleHtml: item ? entry.titleHtml : null, html: null, href: null, prs: [], commits: [], ...extra };
}

/**
 * `stillOpen` says whether a Needs you item is still on its page. One that has since left is "Asked":
 * it happened, and it no longer needs anyone.
 */
export function describe(entry: FeedEntry, stillOpen: (entry: FeedEntry) => boolean = () => true): FeedLine | null {
  const event = entry.event;
  switch (event.kind) {
    case "started":
      return text(entry, "started", "The page was created.");
    case "done":
      return text(entry, "finished", "The page says this work is done.");
    case "reopened":
      return text(entry, "reopened", "The page says this work is going again.");
    case "pr":
      return { kind: "pr", key: event.change === "merged" ? event.pr.url : null, weight: event.change === "merged" ? "normal" : "low", change: event.change, pr: event.pr };
    case "summary": {
      const words = firstSentence(event.text);
      return words ? text(entry, "status", words) : null;
    }
    case "added":
      if (event.section === "needs") return stillOpen(entry) ? text(entry, "needs", event.item.title, { html: entry.html }) : text(entry, "asked", event.item.title);
      if (event.section === "decisions") return text(entry, "decided", event.item.title);
      if (event.section === "doing" || event.section === "next") return text(entry, event.section, event.item.title);
      return text(entry, "shipped", withoutLeadingRef(shortRefs(event.item.title), entry), {
        key: viewKey(entry.work, event.item.id),
        href: entry.prs[0]?.url ?? entry.commits[0]?.url ?? firstLink(event.item.markdown),
        prs: entry.prs,
        commits: entry.commits,
      });
    case "removed":
      return event.section === "needs" ? text(entry, "cleared", event.item.title) : null;
  }
}

/** What shipped, in a few words for a short list: the line as written, or the title of a pull request no line names. */
export function shippedWords(line: FeedLine): { readonly text: string; readonly href: string | null } {
  return line.kind === "text" ? { text: line.text, href: line.href } : { text: line.pr.title, href: line.pr.url };
}

/** The line as plain text, for search. */
function lineText(line: FeedLine): string {
  if (line.kind === "text") return `${TONE_LABEL[line.tone]} ${line.text}`;
  const verb = { opened: "Opened", merged: "Merged", closed: "Closed" }[line.change];
  return `${verb} #${line.pr.number} ${line.pr.title}`;
}

/** An entry the feed shows, whose work, project or line holds the query. */
export function feedMatches(entry: FeedEntry, query: string): boolean {
  const line = describe(entry);
  return line !== null && matches(query, entry.workTitle, entry.project, lineText(line));
}

/**
 * A Shipped line often opens with the pull request it is about: "#16565 Every dependency version…".
 * The line's chips already show that pull request, so the sentence starts at its first word.
 */
function withoutLeadingRef(words: string, entry: FeedEntry): string {
  // Only where the words after it stand on their own: "#26 is open" needs its subject.
  const lead = /^(#\d+|[0-9a-f]{7})[\s:,.]+(?=\p{Lu})/u.exec(words);
  if (!lead) return words;
  const shown = entry.prs.some((pr) => `#${pr.number}` === lead[1]) || entry.commits.some((commit) => commit.sha.startsWith(lead[1] ?? " "));
  return shown ? words.slice(lead[0].length) : words;
}

/** The first pull request or commit some Markdown links, as the address of the pull request or commit itself. */
function firstLink(markdown: string): string | null {
  const ref = githubRefs(markdown)[0];
  if (!ref) return null;
  return `https://github.com/${ref.repo}/${ref.kind === "pr" ? `pull/${ref.number}` : `commit/${ref.sha}`}`;
}

function isShipped(entry: FeedEntry): boolean {
  const event = entry.event;
  return (event.kind === "added" && event.section === "shipped") || (event.kind === "pr" && event.change === "merged");
}

/**
 * The feed with each thing said once. A merged pull request that a Shipped line on a page names is
 * left to that line, which the agent wrote and which lists it. A line the page has since taken away
 * is left out: when an agent rewords a line, only the new wording shows.
 */
export function onceEach(feed: readonly FeedEntry[]): readonly FeedEntry[] {
  const written = new Set(feed.flatMap((entry) => entry.prs.map((pr) => pr.url)));
  const itemKey = (entry: FeedEntry, id: string) => `${entry.work}/${id}`;
  // Newest first, so a removal is met before the line it removed, and a line written again after it is kept.
  const removed = new Set<string>();
  return feed.filter((entry) => {
    const { event } = entry;
    if (event.kind === "pr") return event.change !== "merged" || !written.has(event.pr.url);
    if (event.kind === "removed" && event.section !== "needs") removed.add(itemKey(entry, event.item.id));
    if (event.kind === "added" && event.section !== "needs") return !removed.delete(itemKey(entry, event.item.id));
    return true;
  });
}

/** What shipped, newest first. */
export function shippedOf(feed: readonly FeedEntry[]): readonly FeedEntry[] {
  return onceEach(feed).filter(isShipped);
}

export function shippedToday(feed: readonly FeedEntry[], now: number): readonly FeedEntry[] {
  return shippedOf(feed).filter((entry) => isToday(entry.at, now));
}

/** One line of the feed: when it happened and the work it is from. */
export interface FeedRow {
  readonly at: Instant;
  readonly line: FeedLine;
  readonly work: WorkId;
  readonly workTitle: string;
  readonly project: string | null;
}

export interface FeedDay {
  readonly key: string;
  readonly label: string;
  readonly rows: readonly FeedRow[];
}

/** Days, newest first, and within a day every line in the order it happened, newest first. Home and a work read the same way. */
export function groupFeed(feed: readonly FeedEntry[], now: number, stillOpen?: (entry: FeedEntry) => boolean): readonly FeedDay[] {
  const days: { key: string; label: string; rows: FeedRow[] }[] = [];
  for (const entry of feed) {
    const line = describe(entry, stillOpen);
    if (!line) continue;
    const day = dayOf(entry.at, now);
    let current = days.at(-1);
    if (current?.key !== day.key) {
      current = { ...day, rows: [] };
      days.push(current);
    }
    current.rows.push({ at: entry.at, line, work: entry.work, workTitle: entry.workTitle, project: entry.project });
  }
  return days;
}

/** Days with only the lines `keep` accepts. */
export function filterDays(days: readonly FeedDay[], keep: (line: FeedLine) => boolean): readonly FeedDay[] {
  return days.map((day) => ({ ...day, rows: day.rows.filter(({ line }) => keep(line)) })).filter((day) => day.rows.length > 0);
}
