import type { Instant, Item, JournalEvent, Page, PullRequest, PullRequestState, SectionKind } from "./types.ts";

interface Replayed {
  readonly started: boolean;
  readonly done: boolean;
  /** The summary as of the last event. Null when no event recorded it. */
  readonly summary: string | null;
  /** Items on the page as of the last event, with when each first appeared. */
  readonly items: ReadonlyMap<string, { readonly section: SectionKind; readonly item: Item; readonly since: Instant }>;
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
  const items = new Map<string, { section: SectionKind; item: Item; since: Instant }>();
  const prs = new Map<string, "opened" | "merged" | "closed">();
  for (const event of events) {
    switch (event.kind) {
      case "started":
        started = true;
        summary = event.summary;
        for (const { section, item } of event.items) items.set(item.id, { section, item, since: event.at });
        break;
      case "summary":
        summary = event.text;
        break;
      case "added":
        items.set(event.item.id, { section: event.section, item: event.item, since: event.at });
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
  return { started, done, summary, items, prs };
}

/** The events that take the journal from `past` to this version of the page, changed at `mtime`. Empty when nothing changed. */
export function pageEvents(past: readonly JournalEvent[], page: Page, mtime: Date): JournalEvent[] {
  const at = instant(mtime);
  const current = new Map<string, { section: SectionKind; item: Item }>();
  for (const section of page.sections) {
    if (section.kind === null) continue;
    for (const item of section.items) current.set(item.id, { section: section.kind, item });
  }

  const before = replay(past);
  if (!before.started) {
    const started: JournalEvent = { at, kind: "started", items: [...current.values()], summary: page.summary };
    return page.done ? [started, { at, kind: "done" }] : [started];
  }

  const events: JournalEvent[] = [];
  for (const [id, { section, item }] of before.items) {
    if (!current.has(id)) events.push({ at, kind: "removed", section, item });
  }
  for (const [id, { section, item }] of current) {
    if (!before.items.has(id)) events.push({ at, kind: "added", section, item });
  }
  if (page.summary !== before.summary) events.push({ at, kind: "summary", text: page.summary });
  if (page.done !== before.done) events.push({ at, kind: page.done ? "done" : "reopened" });
  return events;
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
  return { events, skipped };
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
    case "started": {
      if (!Array.isArray(value.items)) return null;
      const items: { section: SectionKind; item: Item }[] = [];
      for (const entry of value.items) {
        const item = isObject(entry) ? toItem(entry.item) : null;
        if (!item || !isObject(entry) || !isSection(entry.section)) return null;
        items.push({ section: entry.section, item });
      }
      return { at, kind: "started", items, summary: typeof value.summary === "string" ? value.summary : null };
    }
    case "added":
    case "removed": {
      const item = toItem(value.item);
      return item && isSection(value.section) ? { at, kind: value.kind, section: value.section, item } : null;
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
