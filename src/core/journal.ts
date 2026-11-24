import { githubRefs } from "./refs.ts";
import { firstSentence, liveMark, splitItem } from "./text.ts";
import type { Instant, Item, JournalEvent, Page, Parts, PullRequest, PullRequestState, SectionKind } from "./types.ts";

interface Placed {
  readonly section: SectionKind;
  readonly item: Item;
  readonly since: Instant;
  readonly editedAt: Instant | null;
  readonly liveAt: Instant | null;
  readonly formerly: readonly string[];
}

interface Replayed {
  readonly started: boolean;
  readonly done: boolean;
  /** The summary as of the last event. Null when no event recorded it. */
  readonly summary: string | null;
  /**
   * Items on the page as of the last event, with when each first appeared and when its text last changed after that,
   * and the ids it had before, each once, since it was last added. An id is no earlier wording once an item has it again.
   */
  readonly items: ReadonlyMap<string, Placed>;
  /** The page's parts as of the last event, with when each was last written. Null in a journal no hub that follows edits has written to. */
  readonly parts: ReadonlyMap<string, { readonly mark: string; readonly at: Instant | null }> | null;
  /** The last state recorded for each pull request, by URL. */
  readonly prs: ReadonlyMap<string, "opened" | "merged" | "closed">;
}

export function instant(date: Date): Instant {
  return date.toISOString() as Instant;
}

export function replay(events: readonly JournalEvent[]): Replayed {
  let started = false;
  let done = false;
  let summary: string | null = null;
  const items = new Map<string, Placed>();
  // An item first read as live went live no later than then.
  const liveFrom = (item: Item, at: Instant) => (isLive(item) ? at : null);
  // A part the journal only noted has no time: nothing is known of when it was written.
  const noted = (marks: Parts) => new Map(Object.entries(marks).map(([heading, mark]) => [heading, { mark, at: null as Instant | null }]));
  const prs = new Map<string, "opened" | "merged" | "closed">();
  let parts: Map<string, { mark: string; at: Instant | null }> | null = null;
  // A wording in use belongs to the item that has it now: from then on it is no earlier wording of another.
  const put = (id: string, entry: Placed) => {
    if (!items.has(id)) for (const [other, known] of items) if (known.formerly.includes(id)) items.set(other, { ...known, formerly: known.formerly.filter((from) => from !== id) });
    items.set(id, entry);
  };
  for (const event of events) {
    switch (event.kind) {
      case "started":
        started = true;
        summary = event.summary;
        for (const { section, item } of event.items) put(item.id, { section, item, since: event.at, editedAt: null, liveAt: liveFrom(item, event.at), formerly: [] });
        if (event.parts) parts = noted(event.parts);
        break;
      case "noted":
        // An item keeps the time it first appeared. One the journal missed starts now.
        for (const { section, item } of event.items) {
          const known = items.get(item.id);
          put(item.id, { section, item, since: known?.since ?? event.at, editedAt: null, liveAt: isLive(item) ? (known?.liveAt ?? null) : null, formerly: known?.formerly ?? [] });
        }
        parts = noted(event.parts);
        break;
      case "edited": {
        const known = items.get(event.from ?? event.item.id);
        const formerly = event.from !== undefined && known ? [...known.formerly.filter((id) => id !== event.from && id !== event.item.id), event.from] : (known?.formerly ?? []);
        if (event.from !== undefined) items.delete(event.from);
        put(event.item.id, { section: event.section, item: event.item, since: known?.since ?? event.at, editedAt: event.at, liveAt: isLive(event.item) ? (known?.liveAt ?? null) : null, formerly });
        break;
      }
      case "live": {
        const known = items.get(event.item.id);
        put(event.item.id, { section: "shipped", item: event.item, since: known?.since ?? event.at, editedAt: known?.editedAt ?? null, liveAt: event.at, formerly: known?.formerly ?? [] });
        break;
      }
      case "part":
        parts ??= new Map();
        if (event.change === "removed") parts.delete(event.heading);
        else parts.set(event.heading, { mark: event.mark, at: event.at });
        break;
      case "summary":
        summary = event.text;
        break;
      case "added":
        put(event.item.id, { section: event.section, item: event.item, since: event.at, editedAt: null, liveAt: liveFrom(event.item, event.at), formerly: [] });
        break;
      case "removed":
        items.delete(event.item.id);
        break;
      case "done":
        done = true;
        break;
      case "reopened":
        done = false;
        break;
      case "pr":
        prs.set(event.pr.url, event.change);
        break;
    }
  }
  return { started, done, summary, items, parts, prs };
}

/** The id each item had before it was reworded, as the id it has now: what keeps the user's marks made on an earlier wording on it. */
export function formerIds(events: readonly JournalEvent[]): Map<string, string> {
  return new Map([...replay(events).items].flatMap(([id, { formerly }]) => formerly.map((from) => [from, id] as const)));
}

/** The events that take the journal from `past` to this version of the page, changed at `mtime`. Empty when nothing changed. */
export function pageEvents(past: readonly JournalEvent[], page: Page, mtime: Date): JournalEvent[] {
  const at = instant(mtime);
  const current = new Map<string, { section: SectionKind; item: Item }>();
  for (const section of page.sections) {
    if (section.kind === null) continue;
    for (const item of section.items) current.set(item.id, { section: section.kind, item });
  }

  const parts = partsOf(page);
  const before = replay(past);
  if (!before.started) {
    const started: JournalEvent = { at, kind: "started", items: [...current.values()], summary: page.summary, parts };
    return page.done ? [started, { at, kind: "done" }] : [started];
  }

  const events: JournalEvent[] = [];
  const left = [...before.items.values()].filter(({ item }) => !current.has(item.id));
  const renamed = reworded(
    left,
    [...current.values()].filter(({ item }) => !before.items.has(item.id)),
  );
  const kept = new Set(renamed.values());
  for (const { section, item } of left) {
    if (!kept.has(item.id)) events.push({ at, kind: "removed", section, item });
  }
  // A journal begun before edits were followed holds each item as it first read. The page as it reads now is
  // noted once, so what was edited over those days is not reported as edited today.
  const follows = before.parts !== null;
  for (const [id, { section, item }] of current) {
    const known = before.items.get(id);
    const from = renamed.get(id);
    if (from !== undefined) events.push({ at, kind: "edited", section, item, from });
    else if (!known) events.push({ at, kind: "added", section, item });
    else if (!follows || known.item.markdown === item.markdown) continue;
    // Going live is the one edit with a name: it is when what shipped can be tried.
    else if (section === "shipped" && isLive(item) && !isLive(known.item)) events.push({ at, kind: "live", item });
    else events.push({ at, kind: "edited", section, item });
  }
  if (before.parts === null) {
    events.push({ at, kind: "noted", items: [...current.values()], parts });
  } else {
    for (const [heading, { mark }] of before.parts) {
      if (!(heading in parts)) events.push({ at, kind: "part", heading, change: "removed", mark });
    }
    for (const [heading, mark] of Object.entries(parts)) {
      const known = before.parts.get(heading);
      if (known?.mark !== mark) events.push({ at, kind: "part", heading, change: known === undefined ? "added" : "edited", mark });
    }
  }
  if (page.summary !== before.summary) events.push({ at, kind: "summary", text: page.summary });
  if (page.done !== before.done) events.push({ at, kind: page.done ? "done" : "reopened" });
  return events;
}

/**
 * How much of its wording a reworded first line keeps, at least, to still be the same item. Two weeks of real pages
 * showed rewordings above this and different items below it, such as one round of a run followed by the next.
 */
const SAME_WORDING = 0.7;

/**
 * The items that left a list in one save and came back reworded: the id each arriving item had before.
 * A wrong match hides something new from the user, so a pair is joined only when it is plainly the same item:
 * - both are in one section,
 * - their first lines share most of their words,
 * - each is the other's one closest match,
 * - and lines that both name something, by a link, a `#123` or a commit id, name at least one thing in common.
 */
function reworded(left: readonly { readonly section: SectionKind; readonly item: Item }[], arrived: readonly { readonly section: SectionKind; readonly item: Item }[]): Map<string, string> {
  const score = (a: (typeof left)[number], b: (typeof arrived)[number]) => {
    if (a.section !== b.section) return 0;
    const [ra, rb] = [refs(a.item), refs(b.item)];
    if (ra.size > 0 && rb.size > 0 && ra.isDisjointFrom(rb)) return 0;
    return sharedWords(a.item.title, b.item.title);
  };
  // The one entry of `options` that scores best, or null when none reaches the bar or two tie for it.
  const closest = <T>(options: readonly T[], of: (option: T) => number): T | null => {
    const [first, second] = options
      .map((option) => ({ option, value: of(option) }))
      .filter(({ value }) => value >= SAME_WORDING)
      .sort((x, y) => y.value - x.value);
    return first !== undefined && (second === undefined || second.value < first.value) ? first.option : null;
  };
  const renamed = new Map<string, string>();
  for (const b of arrived) {
    const a = closest(left, (option) => score(option, b));
    if (a !== null && closest(arrived, (option) => score(a, option)) === b) renamed.set(b.item.id, a.item.id);
  }
  return renamed;
}

/** The share of words two lines have in common, from 0 to 1. Links are left out: a changed number at the end of one is still the same line. */
function sharedWords(a: string, b: string): number {
  const words = (text: string) => text.toLowerCase().replace(/https?:\/\/\S+/g, " ").match(/[\p{L}\p{N}]+/gu) ?? [];
  const [wa, wb] = [words(a), words(b)];
  if (wa.length + wb.length === 0) return 0;
  const counts = new Map<string, number>();
  for (const word of wa) counts.set(word, (counts.get(word) ?? 0) + 1);
  let common = 0;
  for (const word of wb) {
    const n = counts.get(word) ?? 0;
    if (n === 0) continue;
    common++;
    counts.set(word, n - 1);
  }
  return (2 * common) / (wa.length + wb.length);
}

/**
 * What an item's first line names, as written, so the destinations of its links count: each link, each pull request
 * or issue by its number, and each commit id of seven to forty hex digits, whole.
 */
function refs(item: Item): Set<string> {
  const line = splitItem(item.markdown).title.toLowerCase();
  const links = (line.match(/https?:\/\/[^\s<>()[\]`"']+/g) ?? []).map((link) => link.replace(/[.,:;!?]+$/, ""));
  const numbers = [...line.matchAll(/(?<![\w&/])#(\d+)\b|\/pull\/(\d+)\b/g)].map((match) => `#${match[1] ?? match[2]}`);
  const commits = line.match(/\b[0-9a-f]{7,40}\b/g) ?? [];
  return new Set([...links, ...numbers, ...commits]);
}

function isLive(item: Item): boolean {
  return liveMark(item.markdown)?.on === true;
}

/** The heading the goal is recorded under, whether the page gives it a section or a paragraph. */
export const GOAL_PART = "Goal";

/**
 * The name each of a page's sections is recorded under as a part, in the page's order: its heading, with a count on
 * one written twice, as items have. Null for a section with no text of its own, which is no part.
 */
export function partNames(page: Page): (string | null)[] {
  const taken = new Set([GOAL_PART]);
  return page.sections.map((section) => {
    if (section.markdown.trim() === "") return null;
    let name = section.heading;
    for (let n = 2; taken.has(name); n++) name = `${section.heading}/${n}`;
    taken.add(name);
    return name;
  });
}

/** A page's parts, each with a mark that changes when its text does. */
function partsOf(page: Page): Parts {
  const mark = (text: string) => Bun.hash(text).toString(36);
  const parts: Record<string, string> = page.goal.trim() === "" ? {} : { [GOAL_PART]: mark(page.goal) };
  partNames(page).forEach((name, index) => {
    if (name !== null) parts[name] = mark(page.sections[index]?.markdown ?? "");
  });
  return parts;
}

/**
 * Whether an event is something to tell the user. The rest only keep the journal's own account: the page as
 * first noted, a line that left a list other than Needs you, and a summary that was emptied.
 */
export function speaks(event: JournalEvent): boolean {
  switch (event.kind) {
    case "noted":
      return false;
    case "removed":
      return event.section === "needs";
    case "summary":
      return firstSentence(event.text) !== "";
    default:
      return true;
  }
}

/**
 * What a journal tells the user, in the journal's order: its events that speak, each thing once.
 * - A line the page has since taken away is left out with what happened to it: when an agent rewrites a line
 *   into a different one, only the new line is told.
 * - A line reworded in place is one item: what is told about it carries its words as they are now.
 * - A pull request's merge is left to the Shipped line that names it, which the agent wrote about it.
 *
 * A work's feed is this, and so is the time it last changed, so its dot never lights for something no feed tells.
 */
export function told(events: readonly JournalEvent[]): JournalEvent[] {
  // Backwards, so a removal is met before the line it removed, and a line written again after it is kept.
  const gone = new Set<string>();
  // A reworded line is told by the words it has now, from the time it was added. Before that, a line of the same
  // words was another item.
  const renamed = new Map<string, Item>();
  const kept = events.toReversed().flatMap((original): JournalEvent[] => {
    const later = "item" in original ? renamed.get(original.item.id) : undefined;
    const event = later === undefined ? original : { ...original, item: later };
    if (original.kind === "added") renamed.delete(original.item.id);
    if (original.kind === "edited" && original.from !== undefined) {
      renamed.delete(original.item.id);
      renamed.set(original.from, later ?? original.item);
    }
    if (!speaks(event)) {
      if (event.kind === "removed") gone.add(event.item.id);
      return [];
    }
    if (!("item" in event) || event.kind === "removed") return [event];
    return (event.kind === "added" ? !gone.delete(event.item.id) : !gone.has(event.item.id)) ? [event] : [];
  });
  const shipped = (event: JournalEvent) => event.kind === "live" || ((event.kind === "added" || event.kind === "edited") && event.section === "shipped");
  const named = new Set(kept.flatMap((event) => (shipped(event) && "item" in event ? githubRefs(event.item.markdown) : [])).flatMap((ref) => (ref.kind === "pr" ? [`${ref.repo}#${ref.number}`.toLowerCase()] : [])));
  return kept.filter((event) => !(event.kind === "pr" && event.change === "merged" && named.has(`${event.pr.repo}#${event.pr.number}`.toLowerCase()))).reverse();
}

/** A pull request as a harness last saw it, with the times its own state changes happened. */
export interface PullRequestSighting {
  readonly pr: PullRequest;
  readonly closedAt: Instant | null;
  /** When the harness linked it to a session, used when GitHub gave no open time. */
  readonly linkedAt: Instant;
}

const RANK: Record<PullRequestState, number> = { draft: 0, open: 0, merged: 1, closed: 1 };

/** `pr` events for pull requests that are new to this journal, or that merged or closed since it last saw them. */
export function pullRequestEvents(past: readonly JournalEvent[], sightings: readonly PullRequestSighting[]): JournalEvent[] {
  const seen = replay(past).prs;
  const events: JournalEvent[] = [];
  for (const { pr, closedAt, linkedAt } of sightings) {
    const last = seen.get(pr.url);
    if (last === undefined) events.push({ at: pr.openedAt ?? linkedAt, kind: "pr", change: "opened", pr });
    if (RANK[pr.state] === 0 || last === "merged" || last === "closed") continue;
    if (pr.state === "merged") events.push({ at: pr.mergedAt ?? closedAt ?? linkedAt, kind: "pr", change: "merged", pr });
    else events.push({ at: closedAt ?? linkedAt, kind: "pr", change: "closed", pr });
  }
  return events;
}

// ---------------------------------------------------------------- .history.jsonl

/**
 * One line per event. Lines that do not parse are skipped and counted, so one bad line never loses the rest.
 * A line repeated word for word is read once: two hubs on one home once wrote every change twice.
 * So is a rewording written twice at two times, or written late, from a wording already gone.
 */
export function readJournal(text: string): { events: JournalEvent[]; skipped: number } {
  const events: JournalEvent[] = [];
  const seen = new Set<string>();
  let skipped = 0;
  for (const line of text.split("\n")) {
    if (line.trim() === "" || seen.has(line)) continue;
    seen.add(line);
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      skipped++;
      continue;
    }
    const event = toEvent(value);
    if (event) events.push(event);
    else skipped++;
  }
  return { events: renamedOnce(events), skipped };
}

/**
 * A journal without a rewording of a line that is no longer there, as two hubs that read one folder once wrote it:
 * the second finds the line already renamed, or renamed again since.
 */
function renamedOnce(events: readonly JournalEvent[]): JournalEvent[] {
  const on = new Set<string>();
  return events.filter((event) => {
    if (event.kind === "started" || event.kind === "noted") for (const { item } of event.items) on.add(item.id);
    else if (event.kind === "added" || event.kind === "live") on.add(event.item.id);
    else if (event.kind === "removed") on.delete(event.item.id);
    else if (event.kind === "edited" && event.from !== undefined) {
      if (!on.has(event.from)) return false;
      on.delete(event.from);
      on.add(event.item.id);
    }
    return true;
  });
}

export function writeJournal(events: readonly JournalEvent[]): string {
  return events.map((event) => `${JSON.stringify(event)}\n`).join("");
}

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isInstant(value: unknown): value is Instant {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

function isSection(value: unknown): value is SectionKind {
  return value === "needs" || value === "doing" || value === "next" || value === "decisions" || value === "shipped";
}

function toItem(value: unknown): Item | null {
  if (!isObject(value)) return null;
  const { id, title, markdown } = value;
  return typeof id === "string" && typeof title === "string" && typeof markdown === "string" ? { id, title, markdown } : null;
}

function toParts(value: unknown): Parts | null {
  if (!isObject(value)) return null;
  const parts: Record<string, string> = {};
  for (const [heading, mark] of Object.entries(value)) if (typeof mark === "string") parts[heading] = mark;
  return parts;
}

function toPullRequest(value: unknown): PullRequest | null {
  if (!isObject(value)) return null;
  const { url, repo, number, title, state, openedAt, mergedAt } = value;
  if (typeof url !== "string" || typeof repo !== "string" || typeof number !== "number" || typeof title !== "string") return null;
  if (state !== "draft" && state !== "open" && state !== "merged" && state !== "closed") return null;
  return {
    url,
    repo,
    number,
    title,
    state,
    openedAt: isInstant(openedAt) ? openedAt : null,
    mergedAt: isInstant(mergedAt) ? mergedAt : null,
  };
}

function toEvent(value: unknown): JournalEvent | null {
  if (!isObject(value) || !isInstant(value.at)) return null;
  const at = value.at;
  switch (value.kind) {
    case "started":
    case "noted": {
      if (!Array.isArray(value.items)) return null;
      const items: { section: SectionKind; item: Item }[] = [];
      for (const entry of value.items) {
        const item = isObject(entry) ? toItem(entry.item) : null;
        if (!item || !isObject(entry) || !isSection(entry.section)) return null;
        items.push({ section: entry.section, item });
      }
      const parts = toParts(value.parts);
      if (value.kind === "noted") return parts ? { at, kind: "noted", items, parts } : null;
      return { at, kind: "started", items, summary: typeof value.summary === "string" ? value.summary : null, ...(parts ? { parts } : {}) };
    }
    case "part": {
      const { heading, change, mark } = value;
      return typeof heading === "string" && typeof mark === "string" && (change === "added" || change === "edited" || change === "removed") ? { at, kind: "part", heading, change, mark } : null;
    }
    case "live": {
      const item = toItem(value.item);
      return item ? { at, kind: "live", item } : null;
    }
    case "added":
    case "removed": {
      const item = toItem(value.item);
      return item && isSection(value.section) ? { at, kind: value.kind, section: value.section, item } : null;
    }
    case "edited": {
      const item = toItem(value.item);
      if (!item || !isSection(value.section)) return null;
      return typeof value.from === "string" ? { at, kind: "edited", section: value.section, item, from: value.from } : { at, kind: "edited", section: value.section, item };
    }
    case "summary":
      return typeof value.text === "string" ? { at, kind: "summary", text: value.text } : null;
    case "done":
    case "reopened":
      return { at, kind: value.kind };
    case "pr": {
      const pr = toPullRequest(value.pr);
      const change = value.change;
      return pr && (change === "opened" || change === "merged" || change === "closed") ? { at, kind: "pr", change, pr } : null;
    }
    default:
      return null;
  }
}
