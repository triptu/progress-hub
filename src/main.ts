import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import FORMAT from "../FORMAT.md" with { type: "text" };
import { goalLine } from "./core/text.ts";
import { basename, dirname, join, resolve } from "node:path";
import { addSession, HomeError, listWorks, progressHome, readSessions, type WorkFolder } from "./core/home.ts";
import { parsePage, SECTION_LABEL } from "./core/parse.ts";
import type { Page, SessionRef } from "./core/types.ts";
import { findRemotes, RemoteStore } from "./stores/remote.ts";
import { agentSources } from "./sources/index.ts";
import { readFrom, refOf, SourceError, type AgentSource, type SourceRead } from "./sources/source.ts";

const USAGE = `progress: one Markdown progress page per piece of work, and a hub in the browser above them.

  progress new "<title>"     create the folder and page for this thread and print the path.
                             Run again from the same thread, it prints the same path.
  progress join <work>       add this thread to work that already has a page, and print the path.
  progress path              the page this thread belongs to. Works from a subagent too.
  progress check [<work>]    what the hub reads from the page, and anything it could not read.
  progress todo "<text>"     add to the user's todos in the hub, for something they asked to be
                             reminded of. Linked to this thread's work when it has a page.
  progress format            print the page format, for an agent that has not read it.
  progress serve             start the hub on http://127.0.0.1:4747 ($PROGRESS_PORT changes the port).
                             It answers only to 127.0.0.1, localhost and the names in $PROGRESS_HOSTS
                             (comma separated), such as the machine's tailnet names.

The pages live in $PROGRESS_HOME, else in the folder setup.sh recorded in
~/.config/progress/home. new and join record the work's agent sessions in <work>/.sessions.
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

function pageOf(pages: readonly { folder: WorkFolder; threads: readonly SessionRef[] }[], located: Located): WorkFolder | null {
  const rootOf = (id: SessionRef) => located.read?.roots.get(id) ?? id;
  return pages.find(({ threads }) => threads.some((id) => id === located.root || rootOf(id) === located.root))?.folder ?? null;
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
    if (existing) return printPage(existing.file, existing.id);
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

function commandJoin(args: readonly string[]): void {
  const work = args[0];
  if (!work || args.length > 1) throw new UsageError("Name the work to join: progress join <work>");
  const thread = currentSession();
  if (!thread) throw new UsageError(`progress join ${NO_SESSION}`);
  const home = progressHome();
  const dir = join(home, work);
  const file = join(dir, "progress.md");
  if (!existsSync(file)) throw new UsageError(`There is no page at ${file}. progress check lists what the hub can read.`);
  addSession(dir, locate(thread, readSessions(dir)).root);
  printPage(file, work);
}

function commandPath(): void {
  const thread = currentSession();
  if (!thread) throw new UsageError(`progress path ${NO_SESSION}`);
  const pages = pagesIn(progressHome());
  const found = pageOf(pages, locate(thread, pages.flatMap((p) => p.threads)));
  if (!found) throw new UsageError('This thread has no page yet. Run progress new "<title>" to make one.');
  console.log(found.file);
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
  console.log(`Added to the user's todos${work ? `, linked to ${work}` : ""}. They are at ${hub}/todos`);
}

function commandCheck(args: readonly string[]): void {
  const target = args[0];
  let folder: string;
  if (target !== undefined && (target.includes("/") || target === ".")) folder = resolve(target);
  else if (target !== undefined) folder = join(progressHome(), target);
  else {
    const thread = currentSession();
    if (!thread) throw new UsageError("Name the work to check: progress check <work>");
    const pages = pagesIn(progressHome());
    const found = pageOf(pages, locate(thread, pages.flatMap((p) => p.threads)));
    if (!found) throw new UsageError('This thread has no page yet. Run progress new "<title>" to make one.');
    folder = found.dir;
  }
  if (existsSync(folder) && statSync(folder).isFile()) folder = dirname(folder);
  const md = join(folder, "progress.md");
  if (!existsSync(md)) throw new UsageError(`There is no progress.md in ${folder}.`);
  printCheck(parsePage(readFileSync(md, "utf8"), folder), readSessions(folder), md);
}

function printCheck(page: Page, threads: readonly SessionRef[], file: string): void {
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
    for (const item of items) out.push(`  - ${item.title.length > 110 ? `${item.title.slice(0, 109)}…` : item.title}`);
  }
  const other = page.sections.filter((s) => s.kind === null).map((s) => s.heading);
  if (other.length > 0) out.push("", `Drawn as written: ${other.join(", ")}`);
  out.push("", page.notes.length === 0 ? "Nothing to fix." : "To fix:");
  for (const note of page.notes) out.push(`  - ${note}`);
  console.log(out.join("\n"));
}

async function commandServe(): Promise<void> {
  const { serve } = await import("./server/serve.ts");
  const home = progressHome();
  const hosts = (process.env.PROGRESS_HOSTS ?? "").split(",").map((name) => name.trim()).filter((name) => name !== "");
  // The user's other machines: the ones a harness is linked to, and any named in the environment.
  const own = new Set(["127.0.0.1", "localhost", ...hosts].map((name) => name.toLowerCase()));
  const running = serve({ home, port: port(), hosts, others: findRemotes(agentSources(), port(), own).map((remote) => new RemoteStore(remote)) });
  console.log(`Progress hub on ${running.url}, reading ${home}`);
  for (const source of running.own.state().sources) if (!source.health.ok) console.log(`${source.label}: ${source.health.reason}`);
}

async function main(argv: readonly string[]): Promise<void> {
  const [command, ...args] = argv;
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
