/**
 * `progress change`: what its words and flags say, checked, as one line of a work's changes.jsonl.
 * Everything here is pure; main.ts reads the files and appends the line under the page's lock.
 */
import { CHANGE_KINDS, changeKey, MOST_CHANGE_BYTES, WEB_LINK, type ChangeFile, type ChangeKind, type KeyChange } from "./core/changes.ts";
import { diffOfFiles, headline, isSql } from "./core/ddl.ts";
import type { Instant, SessionRef } from "./core/types.ts";
import { flagsOf, one, UsageError } from "./flags.ts";

export const CHANGE_USAGE = `progress change db <migration file>... --pr <link> --why "<one line>"
    --db "<name>"         which database, when the project has more than one
  Run it when a pull request adds a migration or changes a schema, with that pull request's
  migration files. Run again for the same pull request, it replaces what was recorded.`;

/** What the command was asked, before its files are read. */
export interface ChangeAsk {
  readonly kind: ChangeKind;
  /** The files as given, to be read from where the command runs. */
  readonly paths: readonly string[];
  readonly pr: string;
  readonly why: string;
  readonly db: string | undefined;
  readonly work: string | undefined;
}

export function readChange(args: readonly string[]): ChangeAsk {
  const { words, flags } = flagsOf(args, ["pr", "why", "db", "work"]);
  for (const [name, values] of flags) if (values.some((value) => /[\r\n]/.test(value))) throw new UsageError(`--${name} is one line.`);
  const [kind, ...paths] = words;
  if (kind === undefined) throw new UsageError(`Say what kind of change it is, and give its files.\n${CHANGE_USAGE}`);
  if (!(CHANGE_KINDS as readonly string[]).includes(kind)) throw new UsageError(`"${kind}" is not a kind of change the hub reads. It reads ${CHANGE_KINDS.join(", ")}.\n${CHANGE_USAGE}`);
  if (paths.length === 0) throw new UsageError(`Give the migration files the pull request adds.\n${CHANGE_USAGE}`);
  const pr = one(flags, "pr")?.trim();
  if (pr === undefined) throw new UsageError(`Give the pull request the change is in, with --pr <link>.\n${CHANGE_USAGE}`);
  if (!WEB_LINK.test(pr)) throw new UsageError(`--pr is a link to the pull request, and "${pr}" is not one.`);
  const why = one(flags, "why")?.trim();
  if (why === undefined) throw new UsageError(`Say why, in one line, with --why "<why>".\n${CHANGE_USAGE}`);
  return { kind: kind as ChangeKind, paths, pr, why, db: one(flags, "db")?.trim(), work: one(flags, "work")?.trim() };
}

const kb = (bytes: number) => `${Math.ceil(bytes / 1024)} KB`;

/** Refuses files too large to keep, from their sizes alone, before any is read. */
export function checkSizes(bytes: number): void {
  if (bytes > MOST_CHANGE_BYTES) throw new UsageError(`The files are ${kb(bytes)}, and a change keeps at most ${kb(MOST_CHANGE_BYTES)}. Give the migrations this pull request adds, not a dump of the schema. Nothing was written.`);
}

/**
 * The line the ask makes with its files read, and what the command says about it: what the hub reads from the SQL, so
 * the agent sees at once whether it was read as meant. Throws `UsageError` when the files are too large to keep.
 */
export function changeLine(ask: ChangeAsk, files: readonly ChangeFile[], earlier: readonly KeyChange[], at: Instant, by: SessionRef | null): { readonly change: KeyChange; readonly said: string } {
  checkSizes(files.reduce((sum, file) => sum + new TextEncoder().encode(file.sql).byteLength, 0));
  const change: KeyChange = { at, ...(by ? { by } : {}), kind: ask.kind, pr: ask.pr, why: ask.why, ...(ask.db ? { db: ask.db } : {}), files };
  const before = earlier.find((other) => changeKey(other) === changeKey(change));
  const read = headline(diffOfFiles(files)).map((part) => part.text).join(", ");
  const notSql = files.filter((file) => !isSql(file.path)).map((file) => file.path);
  const said = [
    before ? `Recorded the change in ${ask.pr} again. It replaces the one recorded at ${before.at}.` : `Recorded a database change in ${ask.pr}.`,
    read ? `The hub reads: ${read}.` : "The hub found no table changes in the SQL. It shows the files as written.",
    ...(notSql.length ? [`${notSql.join(", ")} ${notSql.length === 1 ? "is" : "are"} not SQL, so the hub shows ${notSql.length === 1 ? "it" : "them"} as written.`] : []),
  ];
  return { change, said: said.join("\n") };
}
