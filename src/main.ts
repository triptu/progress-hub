import { Database } from "bun:sqlite";
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import FORMAT from "../FORMAT.md" with { type: "text" };
import { goalLine } from "./core/text.ts";
import { basename, dirname, join, resolve } from "node:path";
import { addSession, dropSessions, HomeError, listWorks, progressHome, readSessions, type WorkFolder } from "./core/home.ts";
import { formerIds, instant, readJournal, replay, writeJournal } from "./core/journal.ts";
import { doneKey } from "./core/marks.ts";
import { parsePage, SECTION_LABEL } from "./core/parse.ts";
import type { Page, SectionKind, SessionRef } from "./core/types.ts";
import { linkFile, linkTo, readLink } from "./central/send.ts";
import { addItem, type Edit, EditError, type Live, moveItem, removeItem, type Retry, rewordItem, sectionNamed, setLive, setSummary } from "./edit.ts";
import { MarkStore } from "./stores/marks.ts";
import { findRemotes, RemoteStore } from "./stores/remote.ts";
import { agentSources } from "./sources/index.ts";
import { readFrom, refOf, SourceError, type AgentSource, type SourceRead } from "./sources/source.ts";

const USAGE = `progress: one Markdown progress page per piece of work, and a hub in the browser above them.

  progress new "<title>"     create the folder and page for this thread and print the path.
                             Run again from the same thread, it prints the same path.
  progress join <work>       add this thread to work that already has a page, and print the path.
                             A thread keeps one page: from a thread on another page it changes
                             nothing, unless --move takes the thread off that page.
  progress path              the page this thread belongs to. Works from a subagent too.
  progress check [<work>]    what the hub reads from the page, anything to fix on it, and any ask
                             the user marked done in the hub.
  progress todo "<text>"     add to the user's todos in the hub, for something they asked to be
                             reminded of. Linked to this thread's work when it has a page.
  progress format            print the page format, for an agent that has not read it.
  progress link <address>    send this machine's work to a central hub at that address, with a
                             credential made for this machine on standard input, and restart the hub.
  progress serve             start the hub on http://127.0.0.1:4747 ($PROGRESS_PORT changes the port).
                             It answers only to 127.0.0.1, localhost and the names in $PROGRESS_HOSTS
                             (comma separated), such as the machine's tailnet names.

Keeping the page. Each command changes only the lines it is about, or changes nothing and says why.
A line is named by words that stand together in its first line, in any case, or by a link or
#number it holds, given whole. pull/57 names it as #57 does.
Any other name with no spaces that holds a /, or a : with more after it, is a link or path, and
matches only a line that links exactly it. A name that fits more than one line changes nothing.
Text given to a command is one line. A first line opens with no date: the hub records when each
line appeared. Sections are needs, doing, next, decisions and shipped.
Where a command writes a first line, --pr <url> puts the pull request at its start, unless the
line links it already, and --under "<line>", given once for each line, writes lines under it,
after any that are there. Where the work stands goes under the line, never in it.
--work <work> names another page. Editing the file by hand is still fine.

  progress summary "<text>"  replace the summary at the top of the page.
  progress add <section> "<line>"
                             add an item. Decisions and Shipped go at the top, the rest at the end.
                             To Shipped, --live "<where>" or --not-live "<what it waits on>".
  progress move "<line>" <section>
                             move an item, with what is under it, such as from doing to shipped.
                             --as "<new first line>" rewords it on the way, keeping the links it
                             starts with. To Shipped, --live or --not-live as above. A line that
                             says it is still under way goes to Shipped only with --as.
  progress reword "<line>" ["<new first line>"]
                             change an item's first line where it is, keeping its section, its
                             place, what is under it and the links it starts with. It stays the
                             same item in the hub, with its time and what the user marked on it,
                             however much of it changes. With no new line it only takes --under
                             or --pr.
  progress live "<line>" "<where>"
                             say a Shipped item is live, or --not-live "<what it waits on>".
  progress remove "<line>"   take an item off, such as an ask that is settled.

The pages live in $PROGRESS_HOME, else in the folder setup.sh recorded in
~/.config/progress/home. new and join record the work's agent sessions in <work>/.sessions.
A hub linked with progress link sends to the central hub named in ~/.config/progress/central,
or in the file $PROGRESS_CENTRAL names.
T3's database is read from ~/.t3/userdata/statev2.sqlite, or $PROGRESS_T3_DB; set it to
"off" to read no T3 data.
The hub also shows the work of your other machines' hubs: the machines T3 is linked to, on the
same port, and any named in $PROGRESS_PEERS as label=http://host:port, separated by commas.`;

class UsageError extends Error {}

function port(): number {
  const raw = process.env.PROGRESS_PORT;
  if (raw === undefined || raw === "") return 4747;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 65535) throw new UsageError(`PROGRESS_PORT is "${raw}", which is not a port number.`);
  return n;
}

function hubLink(work: string): string {
  return `http://127.0.0.1:${port()}/w/${encodeURIComponent(work)}`;
}

/** The agent session this command runs in, and the harness that started it. Null outside any harness the hub reads. */
function currentSession(): { readonly source: AgentSource; readonly ref: SessionRef } | null {
  for (const source of agentSources()) {
    const session = source.detect(process.env);
    if (session) return { source, ref: refOf(source.id, session) };
  }
  return null;
}

const NO_SESSION = "must run inside an agent session of a harness the hub reads. In T3 that is any agent thread, where T3CODE_THREAD_ID is set.";

interface Located {
  readonly root: SessionRef;
  readonly project: string | null;
  readonly read: SourceRead | null;
}

/** This session's root, so a subagent lands on its parent's page. Falls back to the session itself when its harness can't be read. */
function locate(current: { readonly source: AgentSource; readonly ref: SessionRef }, pageSessions: readonly SessionRef[]): Located {
  const { source, ref } = current;
  try {
    const read = readFrom(source, [ref, ...pageSessions]);
    const root = read.roots.get(ref) ?? ref;
    return { root, project: read.projects.get(root) ?? null, read };
  } catch (error) {
    if (!(error instanceof SourceError)) throw error;
    console.error(`${error.message}\nUsing the session id as it is, so a subagent may not find its parent's page.`);
    return { root: ref, project: null, read: null };
  }
}

function pagesIn(home: string): { folder: WorkFolder; threads: SessionRef[] }[] {
  return listWorks(home).map((folder) => ({ folder, threads: readSessions(folder.dir) }));
}

/** Whether a session in a page's `.sessions` is this thread: the thread's root, or another session under that root. */
function isOurs(located: Located): (id: SessionRef) => boolean {
  return (id) => id === located.root || (located.read?.roots.get(id) ?? id) === located.root;
}

/** The pages this thread is on. One at most is meant to be. */
function pagesOf(pages: readonly { folder: WorkFolder; threads: readonly SessionRef[] }[], located: Located): WorkFolder[] {
  return pages.filter(({ threads }) => threads.some(isOurs(located))).map(({ folder }) => folder);
}

function pageOf(pages: readonly { folder: WorkFolder; threads: readonly SessionRef[] }[], located: Located): WorkFolder | null {
  return pagesOf(pages, located)[0] ?? null;
}

function slugify(title: string): string {
  return (
    title
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60)
      .replace(/-+$/, "") || "work"
  );
}

/** The repository this command runs in, by its folder's name. Null outside one, and where there is no git. */
function gitProject(): string | null {
  let common: string;
  try {
    const result = Bun.spawnSync(["git", "rev-parse", "--path-format=absolute", "--git-common-dir"], { stderr: "ignore" });
    if (result.exitCode !== 0) return null;
    common = result.stdout.toString().trim();
  } catch {
    return null;
  }
  return common === "" ? null : basename(basename(common) === ".git" ? dirname(common) : common.replace(/\.git$/, ""));
}

function starter(title: string, project: string | null): string {
  return [
    "---",
    `title: ${title}`,
    ...(project ? [`project: ${project}`] : []),
    "---",
    "",
    "Replace this line with where the work stands, in one or two sentences.",
    "",
    "## Goal",
    "",
    "Replace this line with what this work is for: the broader things it should achieve, in a line or two.",
    "",
    "## Needs you",
    "",
    "## In progress",
    "",
    "## Next",
    "",
    "## Decisions",
    "",
    "## Shipped",
    "",
  ].join("\n");
}

/** Makes a new folder for a work. False when anything already has that name, such as an older page's folder. */
function claimFolder(dir: string): boolean {
  try {
    mkdirSync(dir);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "EEXIST") return false;
    throw error;
  }
}

function commandNew(args: readonly string[]): void {
  const title = args.join(" ").trim();
  if (title === "") throw new UsageError('Give the work a title: progress new "<title>"');
  const home = progressHome();
  const thread = currentSession();
  const pages = pagesIn(home);
  const located = thread ? locate(thread, pages.flatMap((p) => p.threads)) : null;
  if (located) {
    const existing = pageOf(pages, located);
    if (existing) {
      // Said aloud, since an agent that asked for a second page would otherwise write over the first, or make one by hand.
      if (located.root !== thread?.ref) {
        console.error("No new page was made. This thread is a subagent, so the page printed here is its parent thread's, and it is the one to keep. Report what you did to the parent thread, which writes the page. Never make a second page by hand.");
      } else if (existing.id !== slugify(title)) {
        console.error("No new page was made. This thread already has the page printed here, and a thread keeps one page. Work that needs a page of its own is started in a thread of its own. Never make a second page by hand.");
      }
      return printPage(existing.file, existing.id);
    }
  }
  const project = located?.project ?? gitProject();
  const base = slugify(title);
  for (let n = 1; n < 100; n++) {
    const work = n === 1 ? base : `${base}-${n}`;
    const file = join(home, work, "progress.md");
    if (!located && existsSync(file)) return printPage(file, work);
    if (!claimFolder(dirname(file))) continue;
    if (located) addSession(dirname(file), located.root);
    writeFileSync(file, starter(title, project));
    return printPage(file, work);
  }
  throw new Error(`Could not find a free folder name for "${title}" in ${home}.`);
}

function printPage(file: string, work: string): void {
  console.log(file);
  console.log(hubLink(work));
}

/** Puts this thread on a work's page. A thread keeps one page, so one already on another moves only when asked to. */
function commandJoin(args: readonly string[]): void {
  const move = args.includes("--move");
  const rest = args.filter((arg) => arg !== "--move");
  const work = rest[0];
  if (!work || rest.length > 1) throw new UsageError("Name the work to join: progress join <work>, with --move to take this thread off the page it is on.");
  const thread = currentSession();
  if (!thread) throw new UsageError(`progress join ${NO_SESSION}`);
  const home = progressHome();
  const dir = join(home, work);
  const file = join(dir, "progress.md");
  if (!existsSync(file)) throw new UsageError(`There is no page at ${file}. progress check lists what the hub can read.`);
  const pages = pagesIn(home);
  const located = locate(thread, pages.flatMap((p) => p.threads));
  const others = pagesOf(pages, located).filter((folder) => resolve(folder.dir) !== resolve(dir));
  if (others.length > 0 && !move) {
    throw new UsageError(
      `This thread is already on ${others.map((folder) => folder.id).join(" and ")}: ${others.map((folder) => folder.file).join(", ")}. A thread keeps one page, so nothing changed. To take this thread off it and put it on ${work}, run progress join ${work} --move.`,
    );
  }
  for (const folder of others) dropSessions(folder.dir, isOurs(located));
  addSession(dir, located.root);
  if (others.length > 0) console.error(`Took this thread off ${others.map((folder) => folder.id).join(" and ")}.`);
  printPage(file, work);
}

function commandPath(): void {
  const thread = currentSession();
  if (!thread) throw new UsageError(`progress path ${NO_SESSION}`);
  const pages = pagesIn(progressHome());
  const found = pagesOf(pages, locate(thread, pages.flatMap((p) => p.threads)));
  if (found.length === 0) throw new UsageError('This thread has no page yet. Run progress new "<title>" to make one.');
  if (found.length > 1) {
    console.error(`This thread is on ${found.length} pages, which is not meant to be: a thread keeps one page. Run progress join <work> --move with the one to keep, and the thread leaves the others.`);
  }
  for (const folder of found) console.log(folder.file);
}

/** The hub keeps the list, so the todo is handed to the one that is running. */
async function commandTodo(args: readonly string[]): Promise<void> {
  const text = args.join(" ").trim();
  if (text === "") throw new UsageError('Say what to remember: progress todo "<text>"');
  const thread = currentSession();
  const pages = thread ? pagesIn(progressHome()) : [];
  const located = thread ? locate(thread, pages.flatMap((p) => p.threads)) : null;
  const work = located ? (pageOf(pages, located)?.id ?? null) : null;
  const hub = `http://127.0.0.1:${port()}`;
  const response = await fetch(`${hub}/api/todos`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: hub },
    body: JSON.stringify({ op: "add", text, work, project: work === null ? (located?.project ?? null) : null }),
  }).catch(() => null);
  if (!response?.ok) throw new UsageError(`The hub at ${hub} did not take the todo. It may not be running: progress serve starts it.`);
  console.log(`Added to the user's todos${work ? `, linked to ${work}` : ""}. They are at ${hub}/#todos`);
}

/** The work's folder: named by a path to it or its page, by its name, or else the one this thread belongs to. */
function workFolder(target: string | undefined, usage: string): string {
  let folder: string;
  // A path names the work's folder or the page in it, which is what `new` prints.
  if (target !== undefined && (target.includes("/") || target === ".")) folder = basename(target) === "progress.md" ? dirname(resolve(target)) : resolve(target);
  else if (target !== undefined) folder = join(progressHome(), target);
  else {
    const thread = currentSession();
    if (!thread) throw new UsageError(usage);
    const pages = pagesIn(progressHome());
    const found = pageOf(pages, locate(thread, pages.flatMap((p) => p.threads)));
    if (!found) throw new UsageError('This thread has no page yet. Run progress new "<title>" to make one.');
    folder = found.dir;
  }
  if (existsSync(folder) && statSync(folder).isFile()) folder = dirname(folder);
  if (!existsSync(join(folder, "progress.md"))) throw new UsageError(`There is no progress.md in ${folder}.`);
  return folder;
}

function commandCheck(args: readonly string[]): void {
  const folder = workFolder(args[0], "Name the work to check: progress check <work>");
  const md = join(folder, "progress.md");
  const page = parsePage(readFileSync(md, "utf8"), folder);
  printCheck(page, readSessions(folder), md, markedDone(page, folder));
}

/** The words and flags of a page command. A flag takes the word after it, and a flag given again adds another value. */
function flagsOf(args: readonly string[], known: readonly string[]): { words: string[]; flags: Map<string, string[]> } {
  const words: string[] = [];
  const flags = new Map<string, string[]>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? "";
    // A shell that keeps a variable whole hands over "--work <work>" as one argument. A known flag is read from it; any other line of text may start with two dashes.
    const whole = /^--([a-z-]+)\s+(.+)$/s.exec(arg);
    const name = whole?.[1] && known.includes(whole[1]) ? whole : /^--([a-z-]+)(?:=(.*))?$/s.exec(arg);
    if (!name?.[1]) {
      words.push(arg);
      continue;
    }
    if (!known.includes(name[1])) throw new UsageError(`progress has no --${name[1]} here. It takes ${known.map((flag) => `--${flag}`).join(", ")}.`);
    const value = name[2] ?? args[++i];
    if (value === undefined || value.trim() === "") throw new UsageError(`--${name[1]} needs a value after it.`);
    flags.set(name[1], [...(flags.get(name[1]) ?? []), value]);
  }
  return { words, flags };
}

/** A flag's value. Given twice, the last one counts. */
const one = (flags: Map<string, string[]>, name: string) => flags.get(name)?.at(-1);

function liveFlag(flags: Map<string, string[]>): Live | null {
  const on = one(flags, "live");
  const off = one(flags, "not-live");
  if (on !== undefined && off !== undefined) throw new UsageError("Give --live or --not-live, not both.");
  return on !== undefined ? { on: true, note: on } : off !== undefined ? { on: false, note: off } : null;
}

function sectionArg(name: string | undefined, usage: string): SectionKind {
  const kind = name === undefined ? null : sectionNamed(name);
  if (!kind) throw new UsageError(`${name === undefined ? "Name a section" : `"${name}" is not a section the hub reads`}. Use needs, doing, next, decisions or shipped.\n${usage}`);
  return kind;
}

/** The flags each page command takes, besides --work. */
const EDITS = {
  summary: [],
  add: ["pr", "under", "live", "not-live"],
  move: ["as", "pr", "under", "live", "not-live"],
  reword: ["pr", "under"],
  live: ["not-live"],
  remove: [],
} as const;
type EditCommand = keyof typeof EDITS;

const isEdit = (command: string | undefined): command is EditCommand => command !== undefined && Object.hasOwn(EDITS, command);

/**
 * Runs `work` holding the page's lock: a write transaction on `.progress.lock`, a small SQLite file beside the
 * page. The system lets go of it when the process ends, however it ends, so progress commands on one page take
 * turns and a killed one never leaves the page locked. A hand edit made in the same instant as a command can
 * still be lost.
 */
function withPageLock<T>(folder: string, work: () => T): T {
  const db = new Database(join(folder, ".progress.lock"), { create: true });
  try {
    db.run("PRAGMA busy_timeout = 30000");
    try {
      db.run("BEGIN IMMEDIATE");
    } catch (error) {
      if ((error as { code?: string }).code?.startsWith("SQLITE_BUSY")) throw new UsageError("Another progress command has been editing this page for 30 seconds. Nothing was written. Run this again.");
      throw error;
    }
    try {
      return work();
    } finally {
      db.run("ROLLBACK");
    }
  } finally {
    db.close();
  }
}

/**
 * Replaces the page in one rename, so the hub never reads half of it, with the page's own permissions.
 * Under the lock no other command is writing, so one fixed name serves, and a file a killed command left is overwritten.
 */
function writePage(file: string, text: string): void {
  const mode = statSync(file).mode & 0o7777;
  const temp = join(dirname(file), ".progress.md.tmp");
  try {
    writeFileSync(temp, text, { mode });
    chmodSync(temp, mode);
    renameSync(temp, file);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
}

/** Edits the page, holding its lock from the read to the write. */
function commandEdit(command: EditCommand, args: readonly string[]): void {
  const { words, flags } = flagsOf(args, ["work", ...EDITS[command]]);
  const folder = workFolder(one(flags, "work"), `progress ${command} needs to know the page: run it from the thread that owns the page, or add --work <work>.`);
  const file = join(folder, "progress.md");
  const live = liveFlag(flags);
  const said = withPageLock(folder, () => {
    let before: string;
    try {
      // Decoded only when no byte is lost, so every line the edit does not touch is written back as it was.
      before = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(readFileSync(file));
    } catch {
      throw new UsageError(`The page is not UTF-8 text, so the command can't edit it without changing other lines. Nothing was written: ${file}`);
    }
    let edit: Edit;
    try {
      edit = editOf(command, before, words, flags, live);
    } catch (error) {
      if (error instanceof EditError) throw new UsageError(`${error.message}${error.retry ? `\n  ${again(command, words, flags, error.retry)}` : ""}\nThe page is unchanged: ${file}`);
      throw error;
    }
    if (edit.text !== before) writePage(file, edit.text);
    if (edit.renamed) keepItem(folder, file, edit.renamed);
    return edit.said;
  });
  console.log(said);
  console.log(file);
}

/**
 * Tells the hub's journal that a line reworded just now is the line it was, so it keeps its time and what the user
 * marked on it however much of it changed. Left to itself the hub takes a line that kept few of its words for a
 * new one. It is written while the page is too fresh for the hub to read, so the hub finds it there when it does.
 * A line the journal has not met has nothing to keep, and a journal that can't be written leaves the hub to compare
 * the words as it does for an edit made by hand.
 */
function keepItem(folder: string, file: string, renamed: NonNullable<Edit["renamed"]>): void {
  const path = join(folder, ".history.jsonl");
  try {
    const text = readFileSync(path, "utf8");
    if (!replay(readJournal(text).events).items.has(renamed.from)) return;
    appendFileSync(path, (text.endsWith("\n") ? "" : "\n") + writeJournal([{ at: instant(statSync(file).mtime), kind: "edited", ...renamed }]));
  } catch {}
}

/** The command as it was given, with the item's first line and the lines under it that `retry` says, written so a shell reads it back. */
function again(command: EditCommand, words: readonly string[], flags: Map<string, string[]>, retry: Retry): string {
  const next = new Map(flags);
  const args = command === "move" ? words : [words[0] ?? "", retry.line];
  if (command === "move") next.set("as", [retry.line]);
  const under = [...retry.under, ...(flags.get("under") ?? [])];
  if (under.length > 0) next.set("under", under);
  const quote = (text: string) => (/^[\w@%+=:,./#-]+$/.test(text) ? text : `"${text.replace(/["\\$`]/g, "\\$&")}"`);
  return ["progress", command, ...args.map(quote), ...[...next].flatMap(([name, values]) => values.map((value) => `--${name} ${quote(value)}`))].join(" ");
}

function editOf(command: EditCommand, before: string, words: readonly string[], flags: Map<string, string[]>, live: Live | null): Edit {
  const line = { pr: one(flags, "pr") ?? null, under: flags.get("under") ?? [] };
  switch (command) {
    case "summary":
      return setSummary(before, words.join(" "));
    case "add":
      return addItem(before, sectionArg(words[0], 'progress add <section> "<line>"'), words.slice(1).join(" "), live, line);
    case "move": {
      const usage = 'progress move "<words of the line, or its pull request>" <section>';
      if (words.length !== 2) throw new UsageError(`Name the line and where it goes: ${usage}`);
      return moveItem(before, words[0] ?? "", sectionArg(words[1], usage), { ...line, live, as: one(flags, "as") ?? null });
    }
    case "reword":
      if (words.length !== 2 && !(words.length === 1 && (line.under?.length || line.pr))) {
        throw new UsageError('Name the line and give its new first line, or what goes under it: progress reword "<words of the line, or its pull request>" "<new first line>" [--under "<line>"]');
      }
      return rewordItem(before, words[0] ?? "", words[1] ?? null, line);
    case "live": {
      const note = words.slice(1).join(" ");
      const usage = 'progress live "<words of the line, or its pull request>" "<where it is live>", or --not-live "<what it waits on>"';
      if (words.length === 0 || (note.trim() === "" && !live) || (note.trim() !== "" && live)) throw new UsageError(`Name the Shipped line and say where it is live: ${usage}`);
      return setLive(before, words[0] ?? "", live ?? { on: true, note });
    }
    case "remove":
      if (words.length !== 1) throw new UsageError('Name the line to take off: progress remove "<words of the line, or its pull request>"');
      return removeItem(before, words[0] ?? "");
  }
}

/**
 * The asks on a page that the user marked done in the hub. The hub never edits a page, so this is how the
 * agent that owns the page hears of it.
 */
function markedDone(page: Page, folder: string): string[] {
  const work = basename(folder);
  const history = join(folder, ".history.jsonl");
  // An ask the user marked done before an agent reworded it is still done: the hub's journal says what it was called.
  const earlier = formerIds(existsSync(history) ? readJournal(readFileSync(history, "utf8")).events : []);
  const done = new Set(new MarkStore(join(dirname(folder), ".marks.json"), () => new Map([[work, earlier]])).get().dismissed);
  return page.sections
    .filter((section) => section.kind === "needs")
    .flatMap((section) => section.items)
    .filter((item) => done.has(doneKey(work, item.id)))
    .map((item) => `Needs you: the user marked "${short(item.title)}" done in the hub. Take it off the page, and write the outcome under Decisions if there is one.`);
}

const short = (title: string) => (title.length > 110 ? `${title.slice(0, 109)}…` : title);

function printCheck(page: Page, threads: readonly SessionRef[], file: string, more: readonly string[]): void {
  const out: string[] = [file, "", `Title: ${page.title}`, `Project: ${page.project ?? "not set"}`];
  out.push(`Threads: ${threads.length === 0 ? "none, so the hub can't show its agents or pull requests" : threads.join(", ")}`);
  if (page.done) out.push("Status: done");
  out.push(`Goal: ${page.goal === "" ? "missing. Add a \"## Goal\" section: what this work is for, in a line or two." : goalLine(page.goal)}`);
  if (page.links.length > 0) out.push(`Try it: ${page.links.map((link) => (link.label ? `${link.label} (${link.url})` : link.url)).join(", ")}`);
  out.push(`Summary: ${page.summary === "" ? "missing. Write one or two sentences under the front matter." : (page.summary.split("\n")[0] ?? "")}`);
  for (const kind of ["needs", "doing", "next", "decisions", "shipped"] as const) {
    const sections = page.sections.filter((s) => s.kind === kind);
    const name = SECTION_LABEL[kind];
    if (sections.length === 0) {
      out.push("", `${name}: no section`);
      continue;
    }
    const items = sections.flatMap((s) => s.items);
    out.push("", `${sections.map((s) => s.heading).join(" + ")}: ${items.length === 0 ? "nothing" : `${items.length} ${items.length === 1 ? "item" : "items"}`}`);
    for (const item of items) out.push(`  - ${short(item.title)}`);
  }
  const other = page.sections.filter((s) => s.kind === null).map((s) => s.heading);
  if (other.length > 0) out.push("", `Drawn as written: ${other.join(", ")}`);
  const notes = [...page.notes, ...more];
  out.push("", notes.length === 0 ? "Nothing to fix." : "To fix:");
  for (const note of notes) out.push(`  - ${note}`);
  console.log(out.join("\n"));
}

async function commandLink(args: readonly string[]): Promise<void> {
  const address = args[0];
  if (!address) throw new UsageError("progress link <address>: the central hub's address, with this machine's credential on standard input.");
  const credential = (process.stdin.isTTY ? "" : await Bun.stdin.text()).trim();
  if (credential === "") throw new UsageError(`Give this machine's credential on standard input: progress link ${address} < <its file>`);
  const path = linkFile();
  const link = await linkTo(address, credential, path).catch((error: unknown) => {
    throw new UsageError(`progress link: ${error instanceof Error ? error.message : String(error)}`);
  });
  console.log(`Linked as ${link.machine}. The link is in ${path}.`);
  // The hub's login service, as setup.sh starts it, reads the default link. It is restarted so it starts sending.
  const service = `gui/${process.getuid?.() ?? 0}/progress.hub`;
  if (!process.env.PROGRESS_CENTRAL && process.platform === "darwin" && Bun.spawnSync(["launchctl", "print", service], { stdout: "ignore", stderr: "ignore" }).exitCode === 0) {
    Bun.spawnSync(["launchctl", "kickstart", "-k", service]);
    console.log("The hub restarted, and sends from now on.");
  } else {
    console.log("Restart progress serve, and it sends from then on.");
  }
}

async function commandServe(): Promise<void> {
  const { serve } = await import("./server/serve.ts");
  const home = progressHome();
  const hosts = (process.env.PROGRESS_HOSTS ?? "").split(",").map((name) => name.trim()).filter((name) => name !== "");
  // The user's other machines: the ones a harness is linked to, and any named in the environment.
  const own = new Set(["127.0.0.1", "localhost", ...hosts].map((name) => name.toLowerCase()));
  // A link that can't be used is said once, and the hub runs as it does with none.
  let central = null;
  try {
    central = readLink(linkFile());
  } catch (error) {
    console.log(`progress: sending to no central hub. ${error instanceof Error ? error.message : String(error)}`);
  }
  const running = serve({ home, port: port(), hosts, central, others: findRemotes(agentSources(), port(), own).map((remote) => new RemoteStore(remote)) });
  console.log(`Progress hub on ${running.url}, reading ${home}${central ? `, sending to ${central.url} as ${central.machine}` : ""}`);
  for (const source of running.own.state().sources) if (!source.health.ok) console.log(`${source.label}: ${source.health.reason}`);
}

async function main(argv: readonly string[]): Promise<void> {
  const [command, ...args] = argv;
  if (isEdit(command)) return commandEdit(command, args);
  switch (command) {
    case "new":
      return commandNew(args);
    case "join":
      return commandJoin(args);
    case "path":
      return commandPath();
    case "check":
      return commandCheck(args);
    case "todo":
      return commandTodo(args);
    case "format":
      console.log(FORMAT.trimEnd());
      return;
    case "link":
      return commandLink(args);
    case "serve":
      return commandServe();
    case undefined:
    case "help":
    case "--help":
    case "-h":
      console.log(USAGE);
      return;
    default:
      throw new UsageError(`progress has no command "${command}".\n\n${USAGE}`);
  }
}

try {
  await main(process.argv.slice(2));
} catch (error) {
  if (error instanceof UsageError || error instanceof HomeError || error instanceof SourceError) {
    console.error(error.message);
    process.exit(1);
  }
  throw error;
}
