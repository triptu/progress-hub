import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const main = join(import.meta.dir, "..", "src", "main.ts");

function progress(args: string[], env: Record<string, string>) {
  const { T3CODE_THREAD_ID: _, ...rest } = process.env;
  const result = Bun.spawnSync(["bun", main, ...args], { env: { ...rest, ...env }, cwd: tmpdir() });
  return { code: result.exitCode, out: result.stdout.toString(), err: result.stderr.toString() };
}

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "progress-cli-"));
  const home = join(dir, "home");
  mkdirSync(home);
  return { dir, home, env: { PROGRESS_HOME: home, HOME: dir, XDG_CONFIG_HOME: join(dir, "config") } };
}

test("new twice gives one page and never overwrites it", () => {
  const { home, env } = setup();
  const first = progress(["new", "Search speed"], env);
  expect(first.code).toBe(0);
  const file = join(home, "search-speed", "progress.md");
  expect(first.out).toBe(`${file}\nhttp://127.0.0.1:4747/w/search-speed\n`);
  expect(readFileSync(file, "utf8")).toStartWith("---\ntitle: Search speed\n---\n");

  writeFileSync(file, "edited by the agent\n");
  expect(progress(["new", "Search speed"], env).out).toBe(first.out);
  expect(readFileSync(file, "utf8")).toBe("edited by the agent\n");
  expect(readdirSync(join(home, "search-speed"))).toEqual(["progress.md"]);
});

test("new from a thread is keyed on the thread, and join and path find it", () => {
  const { home, env } = setup();
  const thread = { ...env, T3CODE_THREAD_ID: "thread-a" };
  const made = progress(["new", "Search speed"], thread);
  expect(made.code).toBe(0);
  expect(readFileSync(join(home, "search-speed", ".sessions"), "utf8").trim()).toBe("t3:thread-a");
  expect(progress(["new", "Another title"], thread).out).toBe(made.out);
  expect(progress(["new", "Search speed"], { ...env, T3CODE_THREAD_ID: "thread-b" }).out).toContain("search-speed-2/progress.md");

  const page = readFileSync(join(home, "search-speed", "progress.md"), "utf8");
  expect(progress(["join", "search-speed"], { ...env, T3CODE_THREAD_ID: "thread-c" }).code).toBe(0);
  expect(progress(["join", "search-speed"], { ...env, T3CODE_THREAD_ID: "thread-c" }).code).toBe(0);
  expect(readFileSync(join(home, "search-speed", ".sessions"), "utf8").split("\n").filter((line) => line !== "")).toEqual(["t3:thread-a", "t3:thread-c"]);
  expect(readFileSync(join(home, "search-speed", "progress.md"), "utf8")).toBe(page);
  expect(progress(["path"], { ...env, T3CODE_THREAD_ID: "thread-c" }).out.trim()).toBe(join(home, "search-speed", "progress.md"));
});

test("check says what the hub read and what to fix", () => {
  const { home, env } = setup();
  progress(["new", "Search speed"], env);
  const out = progress(["check", "search-speed"], env).out;
  expect(out).toContain("Title: Search speed");
  expect(out).toContain("Needs you: nothing");
  expect(out).toContain("Summary: Replace this line");
  progress(["new", 'Fix the "retry" button: again'], env);
  expect(progress(["check", "fix-the-retry-button-again"], env).out).toContain('Title: Fix the "retry" button: again');
  // The page's own path, as `new` prints it, names the work too.
  expect(progress(["check", join(home, "search-speed", "progress.md")], env).out).toContain("Title: Search speed");
  expect(progress(["check", "nope"], env).err).toContain(`no progress.md in ${join(home, "nope")}`);
});

test("new makes a page on a machine with no git", () => {
  const { dir, home, env } = setup();
  // A PATH with Bun on it and nothing else.
  const bin = join(dir, "bin");
  mkdirSync(bin);
  symlinkSync(process.execPath, join(bin, "bun"));
  const made = progress(["new", "Search speed"], { ...env, PATH: bin });
  expect(made.err).toBe("");
  expect(made.out).toStartWith(`${join(home, "search-speed", "progress.md")}\n`);
});

test("with no home it says how to set one", () => {
  const { dir } = setup();
  const result = progress(["new", "X"], { PROGRESS_HOME: join(tmpdir(), "does-not-exist-progress"), HOME: dir, XDG_CONFIG_HOME: join(dir, "config") });
  expect(result.code).toBe(1);
  expect(result.err).toContain("PROGRESS_HOME");
  const unset = progress(["new", "X"], { PROGRESS_HOME: "", HOME: dir, XDG_CONFIG_HOME: join(dir, "config") });
  expect(unset.code).toBe(1);
  expect(unset.err).toContain("setup.sh");
});

test("the home is the folder setup recorded in the config file", () => {
  const { dir, home } = setup();
  const config = join(dir, "config");
  mkdirSync(join(config, "progress"), { recursive: true });
  writeFileSync(join(config, "progress", "home"), `${home}\n`);
  const made = progress(["new", "Search speed"], { PROGRESS_HOME: "", HOME: dir, XDG_CONFIG_HOME: config });
  expect(made.code).toBe(0);
  expect(made.out).toStartWith(`${join(home, "search-speed", "progress.md")}\n`);
});

test("new leaves an older page's folder alone and takes the next free name", () => {
  const { home, env } = setup();
  mkdirSync(join(home, "search-speed"));
  writeFileSync(join(home, "search-speed", "progress.html"), "<title>Search speed</title>");
  mkdirSync(join(home, "search-speed-2"));
  expect(progress(["new", "Search speed"], env).out).toStartWith(`${join(home, "search-speed-3", "progress.md")}\n`);
  expect(readdirSync(join(home, "search-speed"))).toEqual(["progress.html"]);
  expect(readdirSync(join(home, "search-speed-2"))).toEqual([]);
});
