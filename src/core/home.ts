import { appendFileSync, existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { SessionRef, WorkId } from "./types.ts";

export class HomeError extends Error {}

/**
 * `$PROGRESS_HOME`, else the folder setup recorded in `~/.config/progress/home`.
 * Setup chooses the home; this never guesses, so every command and the hub use the same one.
 */
export function progressHome(env: Record<string, string | undefined> = process.env): string {
  const set = env.PROGRESS_HOME?.trim();
  if (set) {
    if (!isFolder(set)) throw new HomeError(`PROGRESS_HOME is ${set}, which is not a folder. Create it or point PROGRESS_HOME at the progress home.`);
    return set;
  }
  const config = join(env.XDG_CONFIG_HOME?.trim() || join(env.HOME?.trim() || homedir(), ".config"), "progress", "home");
  let recorded: string;
  try {
    recorded = readFileSync(config, "utf8").trim();
  } catch {
    recorded = "";
  }
  if (recorded === "") throw new HomeError(`No progress home is set on this machine. Run the hub's setup.sh, which records one in ${config}, or set PROGRESS_HOME.`);
  if (!isFolder(recorded)) throw new HomeError(`The progress home in ${config} is ${recorded}, which is not a folder. Create it, or run the hub's setup.sh again.`);
  return recorded;
}

function isFolder(path: string): boolean {
  return existsSync(path) && statSync(path).isDirectory();
}

export interface WorkFolder {
  readonly id: WorkId;
  readonly dir: string;
  /** The page: the folder's progress.md. */
  readonly file: string;
}

/** Every folder in the home that holds a page. Throws when the home itself can't be read. */
export function listWorks(home: string): WorkFolder[] {
  const works: WorkFolder[] = [];
  for (const name of readdirSync(home).sort()) {
    if (name.startsWith(".")) continue;
    const dir = join(home, name);
    const file = join(dir, "progress.md");
    if (isFile(file)) works.push({ id: name as WorkId, dir, file });
  }
  return works;
}

function lines(file: string): string[] {
  try {
    return readFileSync(file, "utf8").split("\n").map((line) => line.trim()).filter((line) => line !== "");
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }
}

/** The agent sessions that work on a work: `<work>/.sessions`, one reference per line, such as `t3:8f2c…`. */
export function readSessions(dir: string): SessionRef[] {
  return [...new Set(lines(join(dir, ".sessions")))] as SessionRef[];
}

/** Adds a session with one append, so sessions added at the same time are all kept. */
export function addSession(dir: string, session: SessionRef): void {
  if (readSessions(dir).includes(session)) return;
  appendFileSync(join(dir, ".sessions"), `${session}\n`);
}

/** A file that is there but can't be stat-ed counts as there, so reading it fails loudly instead of the work vanishing. */
function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch (error) {
    return !isMissing(error);
  }
}

export function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && (error.code === "ENOENT" || error.code === "ENOTDIR");
}
