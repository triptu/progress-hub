/**
 * Key changes: the changes to a work's foundations that nobody should miss, such as a database migration, kept in
 * `<work>/changes.jsonl`, one JSON object per line, appended by `progress change`. Like a reading, a change is never
 * a page change: it enters no journal and no feed. A line keeps the files as written; what they do is worked out
 * when the hub reads them (`ddl.ts`), so a better reader shows old changes better too.
 */
import { githubRefs } from "./refs.ts";
import { listOf, matching, oneOf, orNone, orNull, readJsonl, shape, text, unread, type Reader } from "./reader.ts";
import type { Instant, PullRequest, SessionRef, WorkId } from "./types.ts";

/** The kinds of key change. Each is a word, so another kind is one more word here and a view for it. */
export const CHANGE_KINDS = ["db"] as const;
export type ChangeKind = (typeof CHANGE_KINDS)[number];

/** A file the change is made of, as written: a migration's SQL. */
export interface ChangeFile {
  /** As given to the command, or from the repository's root. Never a path on the machine. */
  readonly path: string;
  readonly sql: string;
}

/** One line of changes.jsonl. */
export interface KeyChange {
  /** Stamped by the command, never typed. */
  readonly at: Instant;
  /** The session that ran the command. Absent when it ran outside any harness the hub reads. */
  readonly by?: SessionRef;
  readonly kind: ChangeKind;
  /** The pull request the change is in: a web link. */
  readonly pr: string;
  /** Why, in one line. */
  readonly why: string;
  /** Which database, when a project has more than one. */
  readonly db?: string;
  readonly files: readonly ChangeFile[];
}

/** A change as a work's page carries it: with its pull request as GitHub has it, once the hub has asked. */
export interface ShownChange extends KeyChange {
  readonly pull: PullRequest | null;
}

/** A change across every work, with the work it is from. */
export interface WorkChange extends ShownChange {
  readonly work: WorkId;
  readonly workTitle: string;
  readonly project: string | null;
}

/** The SQL one change may keep, all its files together. A migration is a few kilobytes; past this it is a dump, not a change to read. */
export const MOST_CHANGE_BYTES = 128 * 1024;

/** A link a page may open: the web only, so no other scheme becomes a link. */
export const WEB_LINK = /^https?:\/\/\S+$/i;

const nonEmpty = (value: unknown): string => (typeof value === "string" && value.trim() !== "" ? value : unread());

const KEY_CHANGE = {
  at: text<Instant>,
  by: orNone(text<SessionRef>),
  kind: oneOf(...CHANGE_KINDS),
  pr: matching(WEB_LINK),
  why: nonEmpty,
  db: orNone(text),
  files: (value: unknown) => {
    const files = listOf(shape<ChangeFile>({ path: text, sql: text }))(value);
    return files.length > 0 ? files : unread();
  },
};

/** A change as a line of the file has it, or as a machine sends it with its pull request. */
export const readKeyChange: Reader<KeyChange> = shape<KeyChange>(KEY_CHANGE);
export const readShownChange = (pullRequest: Reader<PullRequest>): Reader<ShownChange> => {
  // The chip opens the pull request's own link, so it is held to the same rule.
  const onTheWeb: Reader<PullRequest> = (value) => {
    const pr = pullRequest(value);
    return WEB_LINK.test(pr.url) ? pr : unread();
  };
  return shape<ShownChange>({ ...KEY_CHANGE, pull: orNull(onTheWeb) });
};

/** The key one pull request's change of one kind has: a change recorded again, from any of its tabs, replaces the one before. */
export function changeKey(change: Pick<KeyChange, "kind" | "pr">): string {
  const ref = githubRefs(change.pr)[0];
  return `${change.kind} ${ref?.kind === "pr" ? `${ref.repo.toLowerCase()}#${ref.number}` : change.pr.trim()}`;
}

/** The changes in a file's text, oldest first, as written, and how many lines could not be read. */
export function readChanges(file: string): { readonly changes: KeyChange[]; readonly skipped: number } {
  const read = readJsonl(file, readKeyChange, "a change");
  return { changes: read.values, skipped: read.skipped.length };
}

/** A work's changes as the hub shows them, newest first: each pull request's latest line of each kind, dated when it was first recorded. */
export function changesOf(file: string): { readonly list: KeyChange[]; readonly skipped: number } {
  const read = readChanges(file);
  const latest = new Map<string, KeyChange>();
  for (const change of read.changes) {
    const key = changeKey(change);
    const first = latest.get(key);
    latest.delete(key);
    latest.set(key, first ? { ...change, at: first.at } : change);
  }
  return { list: [...latest.values()].sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0)), skipped: read.skipped };
}
