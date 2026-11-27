import { appendFileSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { isMissing, listWorks, readSessions, type WorkFolder } from "../../core/home.ts";
import { instant, pageEvents, partNames, pullRequestEvents, readJournal, replay, writeJournal, type PullRequestSighting } from "../../core/journal.ts";
import { mediaRefs, parsePage, type MediaRef } from "../../core/parse.ts";
import { liveMark, reason, splitItem, withoutLiveMark } from "../../core/text.ts";
import type { Health, Html, Instant, JournalEvent, Live, Media, Page, RenderedSection, SessionRef, WorkBody, WorkId } from "../../core/types.ts";
import { outcomesOf, type Outcome } from "../../core/outcomes.ts";
import { changesOf, type KeyChange } from "../../core/changes.ts";
import { findMedia, newestFirst } from "./media.ts";
import { renderInline, renderMarkdown } from "./render.ts";

/** A page this fresh may still be mid-write. */
const SETTLE_MS = 1000;

/** One work as the home holds it: its page as last read, its journal, its sessions and the files it shows. */
export interface Work {
  readonly folder: WorkFolder;
  /** Modification time and size of the version read, to spot a change from a stat alone. */
  readonly stamp: string;
  readonly mtime: Date;
  readonly page: Page;
  /** The work's sessions, from its folder, read on every scan. */
  readonly threads: readonly SessionRef[];
  readonly body: WorkBody;
  readonly events: readonly JournalEvent[];
  /** Lines of .history.jsonl that could not be read, as of the last read. */
  readonly skipped: number;
  /** What the page shows, as written. */
  readonly refs: readonly MediaRef[];
  /** Those of `refs` that exist in the folder, as of the last scan. */
  readonly media: readonly Media[];
  /** Why the journal could not be read or written on the last try. */
  readonly problem: string | null;
  /** What its outcomes.jsonl holds, as last read: the outcomes, the lines that could not be read, and the file's stamp. */
  readonly outcomes: { readonly stamp: string; readonly list: readonly Outcome[]; readonly skipped: number };
  /** What its changes.jsonl holds, as last read: the changes newest first, the lines that could not be read, and the file's stamp. */
  readonly changes: { readonly stamp: string; readonly list: readonly KeyChange[]; readonly skipped: number };
}

const NO_OUTCOMES = { stamp: "", list: [], skipped: 0 } as const;
const NO_CHANGES = { stamp: "", list: [], skipped: 0 } as const;

/** What `record` gives: the whole journal, or why it could not be read or written. */
type Recorded = { readonly ok: true; readonly events: JournalEvent[]; readonly skipped: number } | { readonly ok: false; readonly problem: string };

/**
 * The progress home as read from disk: every work's page, its journal in .history.jsonl, its sessions and
 * the files it shows. `scan` reads what changed, `record` writes a work's journal, and `check` says
 * whether everything could be read and written. `changed` is called whenever what is held changes.
 */
export class Pages {
  private readonly works = new Map<WorkId, Work>();
  /** What the last scan could not read in the home. Each is tried again on the next. */
  private failedReads: string[] = [];
  /** Whether everything in the home was read and every journal written, as of the last `check`. */
  health: Health = { ok: true };

  private readonly home: string;
  private readonly changed: () => void;

  constructor(home: string, changed: () => void) {
    this.home = home;
    this.changed = changed;
  }

  all(): Work[] {
    return [...this.works.values()];
  }

  get(id: WorkId): Work | undefined {
    return this.works.get(id);
  }

  /** Stats every page and reads the ones that changed, with each work's sessions and the files it shows. */
  scan(now: Date): void {
    this.failedReads = [];
    try {
      this.scanFolders(listWorks(this.home), now);
    } catch (error) {
      this.failedReads.push(`Can't read ${this.home}: ${reason(error)}`);
    }
  }

  /** A page that can't be read is kept as last read. A work is forgotten only when the home was read and its page is gone. */
  private scanFolders(folders: readonly WorkFolder[], now: Date): void {
    const seen = new Set<WorkId>();
    for (const folder of folders) {
      seen.add(folder.id);
      try {
        this.scanPage(folder, now);
        this.scanThreads(folder.id);
        this.scanMedia(folder.id);
        this.scanOutcomes(folder.id);
        this.scanChanges(folder.id);
      } catch (error) {
        const path = error instanceof Error && "syscall" in error ? ("path" in error ? String(error.path) : folder.file) : null;
        this.failedReads.push(path !== null ? `Can't read ${path}: ${reason(error)}` : `The hub failed on ${folder.file}: ${reason(error)}`);
      }
    }
    for (const id of this.works.keys()) {
      if (!seen.has(id)) {
        this.works.delete(id);
        this.changed();
      }
    }
  }

  /** The home is healthy when everything in it was read and every journal written. A problem that replaces the last ones starts a new time. */
  check(now: Date): void {
    const problems = [...this.failedReads, ...[...this.works.values()].flatMap((work) => work.problem ?? [])];
    const before = this.health.ok ? "" : this.health.reason;
    const reasons = problems.join(" ");
    if (reasons === before) return;
    const ongoing = problems.filter((problem) => before.includes(problem));
    for (const problem of problems) if (!ongoing.includes(problem)) console.error(`progress: ${problem}`);
    const since = this.health.ok || ongoing.length === 0 ? instant(now) : this.health.since;
    this.health = reasons === "" ? { ok: true } : { ok: false, since, reason: reasons };
    this.changed();
  }

  /** Every session any page names. */
  sessions(): Set<SessionRef> {
    const threads = new Set<SessionRef>();
    for (const work of this.works.values()) {
      for (const thread of work.threads) threads.add(thread);
    }
    return threads;
  }

  private scanPage(folder: WorkFolder, now: Date): void {
    const stat = statSync(folder.file);
    const stamp = `${folder.file}:${stat.mtimeMs}:${stat.size}`;
    const known = this.works.get(folder.id);
    if (known?.stamp === stamp) return;
    // A time in the future (a copied file, a clock set back) counts as settled once it is far from now.
    if (Math.abs(now.getTime() - stat.mtime.getTime()) < SETTLE_MS) return;
    const text = readFileSync(folder.file, "utf8");
    // An empty page is most likely being rewritten. Reading it would show every item as removed.
    if (text.trim() === "") return;
    const mtime = stat.mtime;
    const page = parsePage(text, folder.dir);
    const events = known?.events ?? [];
    const body = this.renderBody(folder.id, page, events);
    this.works.set(folder.id, { folder, stamp, mtime, page, threads: known?.threads ?? [], body, events, skipped: known?.skipped ?? 0, refs: mediaRefs(text), media: known?.media ?? [], problem: known?.problem ?? null, outcomes: known?.outcomes ?? NO_OUTCOMES, changes: known?.changes ?? NO_CHANGES });
    this.changed();
  }

  /**
   * Writes the events this version of the page and the pull requests seen for it add to the work's journal.
   * Until a write succeeds the work keeps the events it had, so the next refresh finds them missing and tries again.
   */
  record(work: Work, sightings: readonly PullRequestSighting[]): void {
    const { page } = work;
    const missing = (past: readonly JournalEvent[]) => {
      const changes = pageEvents(past, page, work.mtime);
      return [...changes, ...pullRequestEvents([...past, ...changes], sightings)];
    };
    if (missing(work.events).length === 0) {
      if (work.problem !== null) this.works.set(work.folder.id, { ...work, problem: null });
      return;
    }
    const recorded = this.append(work.folder, missing);
    if (!recorded.ok) {
      this.works.set(work.folder.id, { ...work, problem: recorded.problem });
      return;
    }
    this.works.set(work.folder.id, { ...work, events: recorded.events, skipped: recorded.skipped, body: this.renderBody(work.folder.id, page, recorded.events), problem: null });
    this.changed();
  }

  private scanThreads(id: WorkId): void {
    const work = this.works.get(id);
    if (!work) return;
    const threads = readSessions(work.folder.dir);
    if (threads.join("\n") === work.threads.join("\n")) return;
    this.works.set(id, { ...work, threads });
    this.changed();
  }

  /** Stats the files a work's page shows, since one can arrive or change after the page does. */
  private scanMedia(id: WorkId): void {
    const work = this.works.get(id);
    if (!work) return;
    const media = findMedia(id, work.folder.dir, work.refs);
    if (JSON.stringify(media) === JSON.stringify(work.media)) return;
    // The page's HTML carries each picture's size and time, so it is drawn again for the file that arrived or changed.
    this.works.set(id, { ...work, media, body: this.renderBody(id, work.page, work.events) });
    this.changed();
  }

  /**
   * Reads the work's outcomes.jsonl when it changed. A reading is no change to the page, so nothing is journalled:
   * the store's version goes up, which is all a machine linked to a central hub needs to send again.
   */
  private scanOutcomes(id: WorkId): void {
    const work = this.works.get(id);
    if (!work) return;
    const path = join(work.folder.dir, "outcomes.jsonl");
    const stamp = stampOf(path);
    if (stamp === work.outcomes.stamp) return;
    const read = outcomesOf(stamp === "" ? "" : readFileSync(path, "utf8"));
    this.works.set(id, { ...work, outcomes: { stamp, list: read.outcomes, skipped: read.skipped.length } });
    this.changed();
  }

  /** Reads the work's changes.jsonl when it changed. Like a reading, a change is no change to the page, so nothing is journalled. */
  private scanChanges(id: WorkId): void {
    const work = this.works.get(id);
    if (!work) return;
    const path = join(work.folder.dir, "changes.jsonl");
    const stamp = stampOf(path);
    if (stamp === work.changes.stamp) return;
    const read = changesOf(stamp === "" ? "" : readFileSync(path, "utf8"));
    this.works.set(id, { ...work, changes: { stamp, list: read.list, skipped: read.skipped } });
    this.changed();
  }

  /** Every work's media, newest first. */
  media(): Media[] {
    return newestFirst([...this.works.values()].flatMap((work) => work.media));
  }

  /**
   * Appends what `change` finds missing from the journal on disk, read again just before, and returns
   * the whole journal. Another hub on the same home, or this one before a restart, may have written
   * the same events already; deriving them from the file rather than from memory writes each once.
   * When the journal can't be read or written, the caller keeps what it had, so the events are
   * derived and written again on the next try.
   */
  private append(folder: WorkFolder, change: (past: readonly JournalEvent[]) => JournalEvent[]): Recorded {
    const path = join(folder.dir, ".history.jsonl");
    let text = "";
    try {
      text = readFileSync(path, "utf8");
    } catch (error) {
      if (!isMissing(error)) return { ok: false, problem: `Can't read ${path}: ${reason(error)}` };
    }
    const journal = readJournal(text);
    const fresh = change(journal.events);
    if (fresh.length === 0) return { ok: true, ...journal };
    try {
      // A crash mid-append leaves a last line with no newline. Start on a line of our own, so only that line is lost.
      appendFileSync(path, (text === "" || text.endsWith("\n") ? "" : "\n") + writeJournal(fresh));
    } catch (error) {
      return { ok: false, problem: `Can't write ${path}: ${reason(error)}` };
    }
    return { ok: true, events: [...journal.events, ...fresh], skipped: journal.skipped };
  }

  private renderBody(work: WorkId, page: Page, events: readonly JournalEvent[]): WorkBody {
    const dir = join(this.home, work);
    const seen = replay(events);
    const names = partNames(page);
    const sections: RenderedSection[] = page.sections.map((section, index) => ({
      heading: section.heading,
      kind: section.kind,
      html: renderMarkdown(section.markdown, work, dir),
      changedAt: seen.parts?.get(names[index] ?? "")?.at ?? null,
      items: section.items.map((item) => ({
        id: item.id,
        title: item.title,
        ...renderItem(item.markdown, work, dir, section.kind === "shipped"),
        since: seen.items.get(item.id)?.since ?? null,
        editedAt: seen.items.get(item.id)?.editedAt ?? null,
        live: section.kind === "shipped" ? liveOf(item.markdown, seen.items.get(item.id)?.liveAt ?? null, work, dir) : null,
        prs: [],
        commits: [],
      })),
    }));
    return { goal: renderMarkdown(page.goal, work, dir), summary: renderMarkdown(page.summary, work, dir), sections };
  }
}

/** A file's modification time and size, to spot a change from a stat alone. Empty when there is no file. */
function stampOf(path: string): string {
  try {
    const stat = statSync(path);
    return `${stat.mtimeMs}:${stat.size}`;
  } catch (error) {
    if (!isMissing(error)) throw error;
    return "";
  }
}

/** An item's title line and what is under it, as HTML. A Shipped item's line about being live is left out: the hub shows it as a mark. */
export function renderItem(markdown: string, work: WorkId, dir: string, shipped = false): { titleHtml: Html; html: Html; important: boolean } {
  const { title, body, important } = splitItem(markdown);
  return { titleHtml: renderInline(title, work, dir), html: renderMarkdown(shipped ? withoutLiveMark(body) : body, work, dir), important };
}

function liveOf(markdown: string, at: Instant | null, work: WorkId, dir: string): Live | null {
  const mark = liveMark(markdown);
  return mark && { on: mark.on, note: renderInline(mark.note, work, dir), at: mark.on ? at : null };
}
