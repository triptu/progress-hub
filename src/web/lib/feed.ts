import type { Commit, FeedEntry, Html, Instant, Item, JournalEvent, PullRequest, WorkId } from "../../core/types.ts";
import { githubRefs, LEADING_REF, shortRefs } from "../../core/refs.ts";
import { firstSentence } from "../../core/text.ts";
import { prKey, viewKey } from "../../core/marks.ts";
import { matches } from "./needs.ts";
import { dayOf } from "./time.ts";

export type Tone = "needs" | "asked" | "cleared" | "doing" | "next" | "decided" | "shipped" | "started" | "finished" | "reopened" | "status" | "edited" | "written" | "dropped" | "live";

/** How much a line matters to someone skimming: what needs them or what a page marked, what moved the work on, and the rest. */
export type Weight = "high" | "normal" | "low";

/**
 * What one journal event says in the feed. Null for an event this hub has no words for.
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
  edited: "Edited",
  written: "New section",
  dropped: "Removed",
  live: "Live",
};

const TONE_WEIGHT: Record<Tone, Weight> = { doing: "low", next: "low", needs: "high", asked: "normal", shipped: "normal", finished: "normal", decided: "low", cleared: "low", started: "low", reopened: "low", status: "low", edited: "low", written: "low", dropped: "low", live: "normal" };

/** The item an event is about, read only for the kinds that have one. */
function itemOf(event: JournalEvent): Item | null {
  return event.kind === "added" || event.kind === "removed" || event.kind === "edited" || event.kind === "live" ? event.item : null;
}

function text(entry: FeedEntry, tone: Tone, words: string, extra: Partial<Extract<FeedLine, { kind: "text" }>> = {}): FeedLine {
  return { kind: "text", key: null, tone, weight: entry.important ? "high" : TONE_WEIGHT[tone], text: words, titleHtml: itemOf(entry.event) ? entry.titleHtml : null, html: null, href: null, prs: [], commits: [], ...extra };
}

/**
 * `stillOpen` says whether a Needs you item is still on its page. One that has since left is "Asked":
 * it happened, and it no longer needs anyone.
 */
export function describe(entry: FeedEntry, stillOpen: (entry: FeedEntry) => boolean = () => true): FeedLine | null {
  const event = entry.event;
  switch (event.kind) {
    case "edited":
      // A reworded ask is still an ask, so it keeps an ask's weight.
      return text(entry, "edited", event.item.title, event.section === "needs" ? { weight: "normal" } : {});
    case "live":
      return text(entry, "live", withoutLeadingRef(shortRefs(event.item.title), entry), { href: entry.prs[0]?.url ?? entry.commits[0]?.url ?? firstLink(event.item.markdown), prs: entry.prs, commits: entry.commits });
    case "part":
      return text(entry, ({ added: "written", edited: "edited", removed: "dropped" } as const)[event.change], event.heading);
    case "started":
      return text(entry, "started", "The page was created.");
    case "done":
      return text(entry, "finished", "The page says this work is done.");
    case "reopened":
      return text(entry, "reopened", "The page says this work is going again.");
    case "pr":
      return { kind: "pr", key: event.change === "merged" ? prKey(entry.work, event.pr.url) : null, weight: event.change === "merged" ? "normal" : "low", change: event.change, pr: event.pr };
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
      // A hub of an earlier build on another machine sends every removal. Only an ask that left is told.
      return event.section === "needs" ? text(entry, "cleared", event.item.title) : null;
    default:
      // The page as first noted, which no feed carries, or an event from a newer hub on another machine.
      return null;
  }
}

/** The line as plain text, for search. */
function lineText(line: FeedLine): string {
  if (line.kind === "text") return `${TONE_LABEL[line.tone]} ${line.text}`;
  const verb = { opened: "Opened", merged: "Merged", closed: "Closed" }[line.change];
  return `${verb} #${line.pr.number} ${line.pr.title}`;
}

/** A line without the pull request or commit it opens with, when its chips already show that one. */
function withoutLeadingRef(words: string, entry: FeedEntry): string {
  const lead = LEADING_REF.exec(words);
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

/**
 * The feed of several works with each machine's pull request told once. A work's own feed already tells each
 * thing once. Two works that share a session both hold its pull requests, so here what happened to one is told
 * for the first work listed, and a merge is left to the Shipped line that names it on either. Another machine's is
 * its own (`prKey`).
 */
export function onceEach(feed: readonly FeedEntry[]): readonly FeedEntry[] {
  const written = new Set(feed.flatMap((entry) => entry.prs.map((pr) => prKey(entry.work, pr.url))));
  const told = new Set<string>();
  return feed.filter(({ work, event }) => {
    if (event.kind !== "pr") return true;
    const once = `${event.change} ${prKey(work, event.pr.url)}`;
    if (told.has(once) || (event.change === "merged" && written.has(prKey(work, event.pr.url)))) return false;
    told.add(once);
    return true;
  });
}


/** One line of the feed: when it happened and the work it is from. */
export interface FeedRow {
  readonly at: Instant;
  readonly line: FeedLine;
  /** The item the line is about, as `<work>/<item id>`. Null for a line about the page or a pull request. */
  readonly item: string | null;
  readonly work: WorkId;
  readonly workTitle: string;
  readonly project: string | null;
}

export interface FeedDay {
  readonly key: string;
  readonly label: string;
  readonly rows: readonly FeedRow[];
}

/** The lines a feed tells, each thing once, in the feed's order. */
export function rowsOf(feed: readonly FeedEntry[], stillOpen?: (entry: FeedEntry) => boolean): FeedRow[] {
  return onceEach(feed).flatMap((entry) => {
    const line = describe(entry, stillOpen);
    const item = itemOf(entry.event);
    return line ? [{ at: entry.at, line, item: item ? `${entry.work}/${item.id}` : null, work: entry.work, workTitle: entry.workTitle, project: entry.project }] : [];
  });
}

/**
 * What is new on a work's page to someone who last looked at `seenBefore`: the feed's lines since then, newest
 * first, with each item's edits told once, and not at all for an item that itself arrived since. An ask still
 * open is left to the page's own Needs you, which is the next thing on it and marks it new.
 */
export function rowsSince(rows: readonly FeedRow[], seenBefore: Instant): FeedRow[] {
  const fresh = rows.filter((row) => Date.parse(row.at) > Date.parse(seenBefore) && !(row.line.kind === "text" && row.line.tone === "needs"));
  const edited = (row: FeedRow) => row.line.kind === "text" && row.line.tone === "edited";
  const said = new Set(fresh.flatMap((row) => (row.item !== null && !edited(row) ? [row.item] : [])));
  return fresh.filter((row) => row.item === null || !edited(row) || (!said.has(row.item) && said.add(row.item)));
}

/** Days, newest first, and within a day every line in the order it happened, newest first. Home and a work read the same way. */
export function groupFeed(rows: readonly FeedRow[], now: number): readonly FeedDay[] {
  const days: { key: string; label: string; rows: FeedRow[] }[] = [];
  for (const row of rows) {
    const day = dayOf(row.at, now);
    let current = days.at(-1);
    if (current?.key !== day.key) {
      current = { ...day, rows: [] };
      days.push(current);
    }
    current.rows.push(row);
  }
  return days;
}

/** A line as plain text with its work, for the filter. */
export function rowMatches(row: FeedRow, query: string): boolean {
  return matches(query, row.workTitle, row.project, lineText(row.line));
}

/** Days with only the lines `keep` accepts. */
export function filterDays(days: readonly FeedDay[], keep: (line: FeedLine) => boolean): readonly FeedDay[] {
  return days.map((day) => ({ ...day, rows: day.rows.filter(({ line }) => keep(line)) })).filter((day) => day.rows.length > 0);
}
