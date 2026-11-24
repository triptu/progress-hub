import { expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WorkId } from "../src/core/types.ts";
import { DiskStore } from "../src/stores/disk/index.ts";
import { CHILD, fixture, ROOT } from "./t3-fixture.ts";

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

test("check tells the agent which asks the user marked done in the hub", () => {
  const { home, env } = setup();
  progress(["new", "Search speed"], env);
  writeFileSync(join(home, "search-speed", "progress.md"), "Summary.\n\n## Goal\n\nFast search.\n\n## Needs you\n\n### Pick a region\n\n### Sign in again\n");
  expect(progress(["check", "search-speed"], env).out).toContain("Nothing to fix.");
  writeFileSync(join(home, ".marks.json"), JSON.stringify({ viewed: [], dismissed: ["search-speed:needs/Pick a region"] }));
  const out = progress(["check", "search-speed"], env).out;
  expect(out).toContain('the user marked "Pick a region" done in the hub');
  expect(out).not.toContain('"Sign in again" done');

  // An ask the user marked done is still done once an agent rewords it, by what the hub's journal recorded.
  const from = { section: "needs", item: { id: "needs/Sign in again", title: "Sign in again", markdown: "### Sign in again" } };
  const to = { id: "needs/Sign in again to Claude", title: "Sign in again to Claude", markdown: "### Sign in again to Claude" };
  writeFileSync(
    join(home, "search-speed", ".history.jsonl"),
    `${JSON.stringify({ at: "2026-11-10T08:00:00.000Z", kind: "started", items: [from], summary: "Summary.", parts: {} })}\n${JSON.stringify({ at: "2026-11-10T09:00:00.000Z", kind: "edited", section: "needs", item: to, from: from.item.id })}\n`,
  );
  writeFileSync(join(home, "search-speed", "progress.md"), "Summary.\n\n## Needs you\n\n### Sign in again to Claude\n");
  writeFileSync(join(home, ".marks.json"), JSON.stringify({ viewed: [], dismissed: ["search-speed:needs/Sign in again"] }));
  expect(progress(["check", "search-speed"], env).out).toContain('the user marked "Sign in again to Claude" done in the hub');
});

test("new from a thread that has a page says so when another title was asked for", () => {
  const { env } = setup();
  const thread = { ...env, T3CODE_THREAD_ID: "thread-a" };
  expect(progress(["new", "Search speed"], thread).err).not.toContain("already has a page");
  expect(progress(["new", "Search speed"], thread).err).not.toContain("already has a page");
  const second = progress(["new", "Billing export"], thread);
  expect(second.out).toContain("search-speed/progress.md");
  expect(second.err).toContain("No new page was made. This thread already has the page printed here");
  expect(second.err).toContain("Never make a second page by hand.");
});

test("new from a subagent makes no page and says the parent's page is the one to keep", () => {
  const { home, env } = setup();
  const t3 = { ...env, PROGRESS_T3_DB: fixture().db };
  expect(progress(["new", "Progress hub"], { ...t3, T3CODE_THREAD_ID: ROOT }).code).toBe(0);
  const child = progress(["new", "Build the parser"], { ...t3, T3CODE_THREAD_ID: CHILD });
  expect(child.out).toStartWith(`${join(home, "progress-hub", "progress.md")}\n`);
  expect(child.err).toContain("No new page was made. This thread is a subagent, so the page printed here is its parent thread's, and it is the one to keep.");
  expect(child.err).toContain("Never make a second page by hand.");
  expect(readdirSync(home)).toEqual(["progress-hub"]);
});

test("join from a thread on another page changes nothing, unless --move takes it off that one", () => {
  const { home, env } = setup();
  const thread = { ...env, T3CODE_THREAD_ID: "thread-a" };
  progress(["new", "Search speed"], thread);
  progress(["new", "Billing export"], { ...env, T3CODE_THREAD_ID: "thread-b" });
  const sessions = (work: string) => readFileSync(join(home, work, ".sessions"), "utf8");

  const refused = progress(["join", "billing-export"], thread);
  expect(refused.code).toBe(1);
  expect(refused.err).toContain(`This thread is already on search-speed: ${join(home, "search-speed", "progress.md")}. A thread keeps one page, so nothing changed.`);
  expect(refused.err).toContain("run progress join billing-export --move");
  expect(sessions("search-speed")).toBe("t3:thread-a\n");
  expect(sessions("billing-export")).toBe("t3:thread-b\n");
  // Joining the page it is on already is fine.
  expect(progress(["join", "search-speed"], thread).code).toBe(0);

  const moved = progress(["join", "billing-export", "--move"], thread);
  expect(moved.code).toBe(0);
  expect(moved.out).toStartWith(`${join(home, "billing-export", "progress.md")}\n`);
  expect(moved.err).toContain("Took this thread off search-speed.");
  expect(sessions("search-speed")).toBe("");
  expect(sessions("billing-export")).toBe("t3:thread-b\nt3:thread-a\n");
  expect(progress(["path"], thread).out).toBe(`${join(home, "billing-export", "progress.md")}\n`);
});

test("path names every page a thread is on, and says that is not meant to be", () => {
  const { home, env } = setup();
  const thread = { ...env, T3CODE_THREAD_ID: "thread-a" };
  progress(["new", "Search speed"], thread);
  // What a page made by hand and joined before join refused it left behind.
  progress(["new", "Billing export"], { ...env, T3CODE_THREAD_ID: "thread-b" });
  writeFileSync(join(home, "billing-export", ".sessions"), "t3:thread-b\nt3:thread-a\n");
  const result = progress(["path"], thread);
  expect(result.code).toBe(0);
  expect(result.out.trim().split("\n").sort()).toEqual([join(home, "billing-export", "progress.md"), join(home, "search-speed", "progress.md")]);
  expect(result.err).toContain("This thread is on 2 pages, which is not meant to be: a thread keeps one page.");
  expect(progress(["path"], { ...env, T3CODE_THREAD_ID: "thread-b" }).err).not.toContain("pages");
});

/** A page shaped like the real ones the hand-written scripts broke: sections out of order, freeform sections between them, pictures and nested lines. */
const KEPT = `---
title: Sync reliability
---

Sync drops edits on flaky networks.

## Goal

No lost edits.

## Needs you

### Sign in again
Run \`claude auth login\`. The nightly run waits on it.

## Where things are

- Branches: \`sync/retry\`.
- Results: [report](report.html).

## Shipped

- https://github.com/acme/app/pull/12 Retries back off.

  ![Before and after](images/retry.png)
- https://github.com/acme/app/pull/9 The log names the device.

## Decisions

- Chose exponential backoff.

## In progress

- Retry queue survives a restart.
  - Two of nine tests still fail on Windows.
- https://github.com/acme/app/pull/14 Conflicts show both versions.

## Next

1. Measure on a 3G profile.
2. Drop the old sync path.

## Ideas

\`\`\`
## Shipped
- not a real line
\`\`\`
`;

function keptPage(env: Record<string, string>, home: string): string {
  progress(["new", "Sync reliability"], env);
  const file = join(home, "sync-reliability", "progress.md");
  writeFileSync(file, KEPT);
  return file;
}

test("the page commands change only the lines they are about, wherever the sections are", () => {
  const { home, env } = setup();
  const thread = { ...env, T3CODE_THREAD_ID: "thread-a" };
  const file = keptPage(thread, home);
  const run = (...args: string[]) => {
    const result = progress(args, thread);
    expect(result.code).toBe(0);
    return result.out;
  };
  // Clearing the last ask leaves the freeform section after it as it was.
  expect(run("remove", "sign in")).toContain('Removed "Sign in again" from Needs you.');
  expect(run("move", "survives a restart", "shipped", "--pr", "https://github.com/acme/app/pull/15", "--not-live", "in the next desktop release")).toContain('Moved "Retry queue survives a restart." from In progress to Shipped.');
  expect(run("live", "#15", "in desktop 4.18")).toContain("now says Live: in desktop 4.18");
  expect(run("move", "https://github.com/acme/app/pull/14", "next")).toContain("from In progress to Next");
  run("add", "decisions", "Chose one queue per device.");
  run("add", "doing", "Measure on a 3G profile");
  run("summary", "Retries back off and survive a restart.");
  expect(readFileSync(file, "utf8")).toBe(`---
title: Sync reliability
---

Retries back off and survive a restart.

## Goal

No lost edits.

## Needs you

## Where things are

- Branches: \`sync/retry\`.
- Results: [report](report.html).

## Shipped

- https://github.com/acme/app/pull/15 Retry queue survives a restart.
  - Two of nine tests still fail on Windows.

  Live: in desktop 4.18
- https://github.com/acme/app/pull/12 Retries back off.

  ![Before and after](images/retry.png)
- https://github.com/acme/app/pull/9 The log names the device.

## Decisions

- Chose one queue per device.
- Chose exponential backoff.

## In progress

- Measure on a 3G profile

## Next

1. Measure on a 3G profile.
2. Drop the old sync path.
3. https://github.com/acme/app/pull/14 Conflicts show both versions.

## Ideas

\`\`\`
## Shipped
- not a real line
\`\`\`
`);
});


/** A page in a work's folder, written as given, and a way to run the page commands on it. */
function page(text: string | Uint8Array) {
  const { home, env } = setup();
  progress(["new", "Search speed"], env);
  const file = join(home, "search-speed", "progress.md");
  writeFileSync(file, text);
  const run = (...args: string[]) => progress([...args, "--work", "search-speed"], env);
  return { home, env, file, run, read: () => readFileSync(file, "utf8") };
}

test("a page command that can't tell which line is meant changes nothing and says what to do", () => {
  const { home, env } = setup();
  const file = keptPage(env, home);
  const work = ["--work", "sync-reliability"];
  const missing = progress(["remove", "dark mode", ...work], env);
  expect(missing.code).toBe(1);
  expect(missing.err).toContain('No item matches "dark mode". progress check lists the items.');
  const many = progress(["move", "the", "shipped", ...work], env);
  expect(many.code).toBe(1);
  expect(many.err).toContain('"the" matches 2 items');
  expect(many.err).toContain("Shipped: https://github.com/acme/app/pull/9 The log names the device.");
  expect(many.err).toContain("Next: Drop the old sync path.");
  expect(progress(["live", "Chose exponential", "on main", ...work], env).err).toContain('"Chose exponential backoff." is under Decisions. Only a Shipped item says whether it is live');
  expect(progress(["add", "shipped", "https://github.com/acme/app/pull/9 The log names the device.", ...work], env).err).toContain('Shipped already has "https://github.com/acme/app/pull/9 The log names the device."');
  expect(progress(["add", "doing", `${"A line that says far too much. ".repeat(6)}`, ...work], env).err).toContain("put the rest on the lines under it");
  expect(progress(["add", "next", "## Ideas", ...work], env).err).toContain("would start a section or an item");
  expect(progress(["remove", "sign in"], env).err).toContain("add --work <work>");
  expect(readFileSync(file, "utf8")).toBe(KEPT);
});

test("adding an ask takes away the Nothing right now beside it", () => {
  const { run, read } = page("Fast.\n\n## Goal\n\nFast search.\n\n## Needs you\n\nNothing right now.\n\n## Next\n\n- Measure.\n");
  expect(run("add", "needs", "Pick a region.").code).toBe(0);
  expect(read()).toBe("Fast.\n\n## Goal\n\nFast search.\n\n## Needs you\n\n### Pick a region.\n\n## Next\n\n- Measure.\n");
});

test("a flag given with its value as one argument is read as the flag, and never written into the line", () => {
  const { env, read } = page("Fast.\n\n## Next\n\n- Measure.\n");
  // What a shell that does not split a variable hands over for `progress add next "..." $WORK`.
  expect(progress(["add", "next", "Pick a region.", "--work search-speed"], env).code).toBe(0);
  expect(read()).toBe("Fast.\n\n## Next\n\n- Measure.\n- Pick a region.\n");
  // A line of its own may still start with two dashes.
  expect(progress(["add", "next", "--force is never passed.", "--work", "search-speed"], env).code).toBe(0);
  expect(read()).toEndWith("- Pick a region.\n- --force is never passed.\n");
});

test("moving a line into a Needs you that says Nothing right now takes that away", () => {
  const { run, read } = page("Fast.\n\n## Needs you\n\nNothing right now.\n\n## Next\n\n- Pick a region.\n");
  expect(run("move", "pick a region", "needs").code).toBe(0);
  expect(read()).toBe("Fast.\n\n## Needs you\n\n### Pick a region.\n\n## Next\n\n");
});

// ---------------------------------------------------------------- Naming a line

test("a name is whole words of a first line, or a whole link, and picks one line or none", () => {
  const text = [
    "Fast.",
    "",
    "## Needs you",
    "",
    "Approve rollout today, the window closes at five.",
    "",
    "## Next",
    "",
    "- Ship the retry queue.",
    "- Tell support before we ship the retry queue.",
    "- Approve rollout tomorrow.",
    "- Replicate data.",
    "- https://host/path/other",
    "- [Same ask](https://example.com/one)",
    "- [Same ask](https://example.com/two)",
    "",
  ].join("\n");
  const { run, read } = page(text);
  const refused = (args: string[], says: string) => {
    const result = run(...args);
    expect(result.code).toBe(1);
    expect(result.err).toContain(says);
  };
  refused(["remove", "ship the retry"], '"ship the retry" matches 2 items');
  refused(["remove", "queue retry the"], 'No item matches "queue retry the"');
  refused(["remove", "cat"], 'No item matches "cat"');
  refused(["remove", "https://host/path"], 'No item matches "https://host/path"');
  refused(["remove", "<br>"], "Name the item");
  // An ask written as prose is still a line the name can match, so the bullet beside it is not taken for it.
  refused(["remove", "Approve rollout"], '"Approve rollout" matches 2 items');
  refused(["remove", "approve rollout today"], "an ask written as prose under Needs you");
  // Removing the first of two lines that share a name would hand the second one's place in the hub to it.
  refused(["remove", "https://example.com/one"], 'Two lines under Next share the name "Same ask"');
  refused(["move", "https://example.com/one", "shipped"], 'Two lines under Next share the name "Same ask"');
  expect(read()).toBe(text);

  expect(run("remove", "https://host/path/other").code).toBe(0);
  expect(run("remove", "replicate DATA").code).toBe(0);
  expect(run("remove", "https://example.com/two").code).toBe(0);
  expect(read()).toBe(text.replace("- Replicate data.\n- https://host/path/other\n", "").replace("- [Same ask](https://example.com/two)\n", ""));
});

test("a name that is a link or a path matches only a line that links exactly it", () => {
  const text = [
    "## Next",
    "",
    "- [Manual](docs/setup.md)",
    "- Fix docs setup md rendering",
    "- [Contact](mailto:ops@example.com)",
    "- Mailto ops example com alert",
    "- Credentials:",
    "- [Doc](https://example.com/wiki/Foo_(bar))",
    "- [Folder](https://example.com/dir/)",
    "- Example",
    "  ```",
    "  https://example.com/manual",
    "  ```",
    "",
  ].join("\n");
  const { run, read } = page(text);
  // An address cut short, a folder without its slash, or one only inside code is no link the line holds.
  for (const name of ["https://example.com/wiki/Foo_", "https://example.com/dir", "https://example.com/manual"]) {
    expect(run("remove", name).err).toContain(`No item matches "${name}"`);
  }
  expect(read()).toBe(text);
  expect(run("remove", "docs/setup.md").code).toBe(0);
  expect(run("remove", "mailto:ops@example.com").code).toBe(0);
  expect(run("remove", "https://example.com/wiki/Foo_(bar)").code).toBe(0);
  // A colon at the end is the line's words.
  expect(run("remove", "Credentials:").code).toBe(0);
  expect(read()).toBe(
    text.replace("- [Manual](docs/setup.md)\n", "").replace("- [Contact](mailto:ops@example.com)\n", "").replace("- [Doc](https://example.com/wiki/Foo_(bar))\n", "").replace("- Credentials:\n", ""),
  );
});

test("a name that fits many lines lists them, or says how many more", () => {
  const { run } = page(`## Next\n\n${Array.from({ length: 8 }, (_, n) => `- Common ${n}\n`).join("")}`);
  const result = run("remove", "Common");
  expect(result.err).toContain('"Common" matches 8 items');
  expect(result.err).toContain("Next: Common 5\n  and 2 more\n");
});

test("a move to Shipped with --pr leaves the line naming that pull request", () => {
  const { run, read } = page("## Doing\n\n- https://github.com/a/b/pull/123 Work\n- Other https://github.com/a/b/pull/12\n\n## Shipped\n\n- Prior\n");
  expect(run("move", "Work", "shipped", "--pr", "https://github.com/a/b/pull/12").code).toBe(0);
  // A line that links the pull request already keeps its words as they are.
  expect(run("move", "Other", "shipped", "--pr", "https://github.com/a/b/pull/12").code).toBe(0);
  expect(read()).toBe("## Doing\n\n## Shipped\n\n- Other https://github.com/a/b/pull/12\n- https://github.com/a/b/pull/12 https://github.com/a/b/pull/123 Work\n- Prior\n");
});

// ---------------------------------------------------------------- What a command may change

test("text given to a command is one line, and a live mark lands where the hub reads it", () => {
  const text = "Fast.\n\n## Shipped\n\n- Example\n- Probe\n\n  ```\n  still open\n";
  const { run, read } = page(text);
  expect(run("live", "Example", "one\r\ntwo").err).toContain("has a line break");
  expect(run("live", "Example", "--not-live", "one\ntwo").err).toContain("has a line break");
  expect(run("add", "shipped", "One", "--live", "a\nb").err).toContain("has a line break");
  expect(run("summary", "First.\nSecond.").err).toContain("has a line break");
  expect(run("live", "Example", "prod\n").err).toContain("has a line break");
  expect(run("remove", "probe\n").err).toContain("has a line break");
  // Text that starts an item would be read as one.
  expect(run("summary", "- item").err).toContain("starts with -, which would start a section or an item");
  expect(run("add", "next", "- - item").err).toContain("starts with -");
  expect(run("add", "next", "1. item").err).toContain("starts with 1.");
  expect(run("live", "Example", "--not-live", "* soon").err).toContain("starts with *");
  // The item ends in a code block that is never closed, so a mark added at its end would be code.
  expect(run("live", "Probe", "released").err).toContain('The hub would not read "Live: released" on "Probe"');
  expect(read()).toBe(text);
});

test("an edit leaves every other line as it was, byte for byte", () => {
  // Mixed line endings, a heading item with its text right under it, and lines of spaces at the end.
  const text = "---\r\ntitle: Mixed\r\n---\r\n\r\nFast.\n\n## Shipped\r\n\r\n### Probe title\nBody text.\nLive: old\r\n\n## Next\n\n- One\r\n\n  \n\n";
  const { run, read } = page(text);
  expect(run("live", "probe title", "new").code).toBe(0);
  expect(read()).toBe(text.replace("Live: old", "Live: new"));
  expect(run("add", "next", "Two").code).toBe(0);
  expect(read()).toBe(text.replace("Live: old", "Live: new").replace("- One\r\n", "- One\r\n- Two\r\n"));
  expect(run("add", "decisions", "Chose one.").code).toBe(0);
  expect(read()).toEndWith("- Two\r\n\n  \n\n## Decisions\r\n\r\n- Chose one.\r\n");
});

test("a page that is not UTF-8 is left as it is", () => {
  const bytes = new Uint8Array([...new TextEncoder().encode("R"), 0xe9, ...new TextEncoder().encode("sum\xe9.\n\n## Next\n\n- Measure.\n")]);
  const { file, run } = page(bytes);
  const result = run("add", "next", "New");
  expect(result.code).toBe(1);
  expect(result.err).toContain("not UTF-8");
  expect(new Uint8Array(readFileSync(file))).toEqual(bytes);
});

test("the summary keeps the front matter of a page that starts with a byte order mark", () => {
  const text = "\uFEFF---\ntitle: Important\nproject: alpha\n---\n\nOld.\n\n## Next\n- Good\n";
  const { run, read } = page(text);
  expect(run("summary", "New.").code).toBe(0);
  expect(read()).toBe(text.replace("Old.", "New."));
});

test("the summary leaves a goal paragraph's own lines as they were", () => {
  const text = "---\r\ntitle: Example\r\n---\r\n\r\nOld summary.\n\nGoal: Save it\nverbatim.\n\n## Next\n- Keep\n";
  const { run, read } = page(text);
  expect(run("summary", "New summary.").code).toBe(0);
  expect(read()).toBe("---\r\ntitle: Example\r\n---\r\n\r\nNew summary.\r\n\r\nGoal: Save it\nverbatim.\n\r\n## Next\n- Keep\n");
});

test("an edited page keeps its permissions", () => {
  const { file, run } = page("Fast.\n\n## Next\n\n- Measure.\n");
  chmodSync(file, 0o600);
  expect(run("add", "next", "New").code).toBe(0);
  expect(statSync(file).mode & 0o777).toBe(0o600);
});

// ---------------------------------------------------------------- Commands at once

/** Holds the page's lock as a command does, having started to write, until it is killed. */
function holder(folder: string) {
  const script = `
    const { Database } = require("bun:sqlite");
    const db = new Database(${JSON.stringify(join(folder, ".progress.lock"))}, { create: true });
    db.run("BEGIN IMMEDIATE");
    require("node:fs").writeFileSync(${JSON.stringify(join(folder, ".progress.md.tmp"))}, "half a page");
    console.log("held");
    setInterval(() => {}, 1000);`;
  return Bun.spawn(["bun", "-e", script], { stdout: "pipe" });
}

for (const killed of [false, true]) {
  test(`twenty page commands at once all land${killed ? ", after one was killed holding the page" : ""}`, async () => {
    const { home, env, file, read } = page("Fast.\n\n## Next\n\n- Measure.\n");
    const folder = join(home, "search-speed");
    const held = killed ? holder(folder) : null;
    if (held) await held.stdout.getReader().read();
    const { T3CODE_THREAD_ID: _, ...rest } = process.env;
    const lines = Array.from({ length: 20 }, (_, n) => `Measure case ${n + 1}.`);
    const runs = lines.map((line) => Bun.spawn(["bun", main, "add", "next", line, "--work", "search-speed"], { env: { ...rest, ...env }, cwd: tmpdir(), stderr: "pipe" }));
    if (held) {
      await Bun.sleep(300);
      held.kill(9);
    }
    expect(await Promise.all(runs.map((run) => run.exited))).toEqual(lines.map(() => 0));
    for (const line of lines) expect(read()).toContain(`- ${line}`);
    expect(statSync(file).isFile()).toBe(true);
    expect(readdirSync(folder).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  }, 30_000);
}

// ---------------------------------------------------------------- Rewording, lines under, and what a Shipped line says

const WORK = [
  "Fast.",
  "",
  "## In progress",
  "",
  "- https://github.com/a/b/pull/57 Devices opens as a dialog. Built, in review as pull request 57.",
  "  Two of nine tests fail.",
  "",
  "  ![The dialog](images/dialog.png)",
  "- Retry queue survives a restart.",
  "",
  "## Next",
  "",
  "1. Measure on a 3G profile.",
  "",
  "## Shipped",
  "",
  "- https://github.com/a/b/pull/9 The log names the device.",
  "",
].join("\n");

for (const name of ["devices opens", "#57", "pull/57", "https://github.com/a/b/pull/57"]) {
  test(`reword changes only the first line of the line named by "${name}", keeping its link, its place and what is under it`, () => {
    const { run, read } = page(WORK);
    const result = run("reword", name, "Devices opens as a dialog.");
    expect(result.code).toBe(0);
    expect(result.out).toContain(' as "https://github.com/a/b/pull/57 Devices opens as a dialog." in In progress.');
    expect(read()).toBe(WORK.replace(" Built, in review as pull request 57.", ""));
  });

  test(`move --as takes the line named by "${name}" to Shipped with its new words`, () => {
    const { run, read } = page(WORK);
    expect(run("move", name, "shipped", "--as", "Devices opens as a dialog.").code).toBe(0);
    expect(read()).toBe(
      WORK.replace("- https://github.com/a/b/pull/57 Devices opens as a dialog. Built, in review as pull request 57.\n  Two of nine tests fail.\n\n  ![The dialog](images/dialog.png)\n", "").replace(
        "## Shipped\n\n",
        "## Shipped\n\n- https://github.com/a/b/pull/57 Devices opens as a dialog.\n  Two of nine tests fail.\n\n  ![The dialog](images/dialog.png)\n",
      ),
    );
  });
}

test("pull/n names the pull request as #n does, and a whole link picks between two repositories' pull/n", () => {
  const text = "## Next\n\n- https://github.com/a/b/pull/9 One.\n- https://github.com/c/d/pull/9 Two.\n- https://github.com/a/b/pull/90 Three.\n";
  const { run, read } = page(text);
  expect(run("remove", "pull/9").err).toContain('"pull/9" matches 2 items');
  expect(run("remove", "pull/9").err).not.toContain("Three.");
  expect(run("remove", "https://github.com/c/d/pull/9").code).toBe(0);
  expect(run("remove", "pull/9").code).toBe(0);
  expect(read()).toBe("## Next\n\n- https://github.com/a/b/pull/90 Three.\n");
});

test("a line reworded by the command is the same line to the hub, however much of it changed: it keeps its time and the user's marks", () => {
  const { home, file, run } = page(WORK);
  utimesSync(file, new Date("2026-11-10T09:00:00Z"), new Date("2026-11-10T09:00:00Z"));
  const hub = new DiskStore(home, [], async () => null);
  hub.refresh(new Date("2026-11-10T09:30:00Z"));
  const journal = join(home, "search-speed", ".history.jsonl");
  const doing = () => hub.detail("search-speed" as WorkId)?.body.sections.find((section) => section.kind === "doing")?.items.map((item) => [item.title, item.since]);

  // Two rewordings before the hub reads the page again, neither keeping a word of the line before it.
  expect(run("reword", "retry queue", "Failed sends are tried again after the app restarts.").code).toBe(0);
  expect(run("reword", "failed sends", "Nothing is lost when the app is closed mid-send.").code).toBe(0);
  // A line the hub has not met has no time to keep, so nothing is written about it.
  expect(run("add", "next", "Try a slower phone.").code).toBe(0);
  const met = readFileSync(journal, "utf8");
  expect(run("reword", "slower phone", "Borrow the oldest handset in the office.").code).toBe(0);
  expect(readFileSync(journal, "utf8")).toBe(met);

  hub.refresh(new Date(Date.now() + 60_000));
  expect(doing()).toEqual([
    ["https://github.com/a/b/pull/57 Devices opens as a dialog. Built, in review as pull request 57.", "2026-11-10T09:00:00.000Z"],
    ["Nothing is lost when the app is closed mid-send.", "2026-11-10T09:00:00.000Z"],
  ]);
  expect(hub.formerIds().get("search-speed")?.get("doing/Retry queue survives a restart.")).toBe("doing/Nothing is lost when the app is closed mid-send.");
  // The hub wrote nothing more about the line: the journal already said what happened to it.
  expect(readFileSync(journal, "utf8").split("\n").filter((line) => line.includes("closed mid-send") || line.includes("Failed sends")).map((line) => JSON.parse(line).kind)).toEqual(["edited", "edited"]);
});

test("reword with --under and --pr adds lines after what is under the item, and the pull request at its start", () => {
  const { run, read } = page(WORK);
  expect(run("reword", "retry queue", "Retry queue survives a restart and a crash.", "--pr", "https://github.com/a/b/pull/60", "--under", "Tested on macOS.", "--under", "- Windows next.").code).toBe(0);
  expect(run("reword", "devices opens", "Devices opens as a dialog. Built, in review as pull request 57.", "--under", "Both reviews passed.", "--under", "One nit left.").code).toBe(0);
  // A line that needs no new words still takes lines under it.
  expect(run("reword", "measure", "Measure on a 3G profile.", "--under", "On the slowest phone.").out).toContain('Added a line under "Measure on a 3G profile." in Next.');
  expect(read()).toBe(
    WORK.replace("  ![The dialog](images/dialog.png)\n", "  ![The dialog](images/dialog.png)\n\n  Both reviews passed.\n\n  One nit left.\n")
      .replace("- Retry queue survives a restart.\n", "- https://github.com/a/b/pull/60 Retry queue survives a restart and a crash.\n  Tested on macOS.\n\n  - Windows next.\n")
      .replace("1. Measure on a 3G profile.\n", "1. Measure on a 3G profile.\n   On the slowest phone.\n"),
  );
});

test("move --as gives a line new words on its way to Shipped, with --under and --pr, and the rest of the page stays", () => {
  const { run, read } = page(WORK);
  const result = run("move", "pull/57", "shipped", "--as", "Devices opens as a dialog.", "--under", "Shipped in two pull requests.", "--live", "on main");
  expect(result.code).toBe(0);
  expect(result.out).toContain('from In progress to Shipped, now "https://github.com/a/b/pull/57 Devices opens as a dialog.".');
  // To another section --pr puts the pull request on the line too.
  expect(run("move", "retry queue", "next", "--pr", "https://github.com/a/b/pull/61").code).toBe(0);
  expect(read()).toBe(
    [
      "Fast.",
      "",
      "## In progress",
      "",
      "## Next",
      "",
      "1. Measure on a 3G profile.",
      "2. https://github.com/a/b/pull/61 Retry queue survives a restart.",
      "",
      "## Shipped",
      "",
      "- https://github.com/a/b/pull/57 Devices opens as a dialog.",
      "  Two of nine tests fail.",
      "",
      "  ![The dialog](images/dialog.png)",
      "",
      "  Shipped in two pull requests.",
      "",
      "  Live: on main",
      "- https://github.com/a/b/pull/9 The log names the device.",
      "",
    ].join("\n"),
  );
});

test("add takes --under and --pr", () => {
  const { run, read } = page(WORK);
  expect(run("add", "next", "Drop the old sync path.", "--pr", "https://github.com/a/b/pull/62", "--under", "After the 3G numbers.", "--under", "Ask support first.").code).toBe(0);
  expect(read()).toBe(WORK.replace("1. Measure on a 3G profile.\n", "1. Measure on a 3G profile.\n2. https://github.com/a/b/pull/62 Drop the old sync path.\n   After the 3G numbers.\n\n   Ask support first.\n"));
});

for (const [line, phrase] of [
  ["Devices opens as a dialog, in review.", "in review"],
  ["The deploy is Waiting On three DNS records.", "waiting on"],
  ["The deploy waits on three DNS records.", "waits on"],
  ["A subagent is building it.", "is building"],
] as const) {
  test(`a move to Shipped refuses to carry over a line that says "${phrase}", and takes the words given with --as`, () => {
    const text = `## In progress\n\n- ${line}\n  More.\n\n## Shipped\n\n- Prior.\n`;
    const name = line.split(" ").slice(0, 3).join(" ");
    const { run, read } = page(text);
    const refused = run("move", name, "shipped", "--pr", "https://github.com/a/b/pull/5");
    expect(refused.code).toBe(1);
    expect(refused.err).toContain(`says "${phrase}", which was true while it was under way`);
    expect(refused.err).toContain(`  progress move "${name}" shipped --pr https://github.com/a/b/pull/5 --work search-speed --as "<what is now true>"\n`);
    expect(read()).toBe(text);
    // Words given now are the agent's to choose, the same phrase among them: a shipped thing may be about waiting.
    expect(run("move", name, "shipped", "--as", `The queue ${phrase} nothing.`).code).toBe(0);
    expect(read()).toBe(`## In progress\n\n## Shipped\n\n- The queue ${phrase} nothing.\n  More.\n- Prior.\n`);
    expect(run("add", "shipped", `A second thing that ${phrase} the first.`).code).toBe(0);
  });
}

test("a line that opens with a date is refused, by add, reword and --as", () => {
  const { run, read } = page(WORK);
  for (const line of ["Nov 24: chose the queue.", "24 Nov the queue was chosen.", "2026-11-24 chose the queue.", "**November 3rd** chose it."]) {
    const result = run("add", "decisions", line);
    expect(result.code).toBe(1);
    expect(result.err).toContain("The line opens with a date");
    expect(result.err).toContain("The hub records when each line appeared");
  }
  expect(run("reword", "retry queue", "Nov 24: retry queue.").err).toContain('The line opens with a date, "Nov 24"');
  expect(run("move", "retry queue", "next", "--as", "2026-11-24 retry queue.").err).toContain('The line opens with a date, "2026-11-24"');
  expect(read()).toBe(WORK);
  // A date after the first words is part of the fact, and a number that is no date is fine.
  expect(run("add", "decisions", "Chose to ship on Nov 24.").code).toBe(0);
  expect(run("add", "next", "3 marbles fall.").code).toBe(0);
});

test("check names lines edited in by hand that open with a date, once per section", () => {
  const { env } = page(
    [
      "## Decisions",
      "",
      ...Array.from({ length: 60 }, (_, n) => `- Nov ${(n % 28) + 1}: picked the queue that keeps every retry, number ${n}.`),
      "- Chose to ship on Nov 24.",
      "",
      "## Next",
      "",
      "- 3 of 9 tests fail.",
      "- **2026-11-24** measure on a 3G profile.",
      "",
    ].join("\n"),
  );
  const out = progress(["check", "search-speed"], env).out;
  expect(out).toContain('  - Decisions: 60 items\' first lines open with a date; the first is "Nov 1: picked the queue that keeps every retry, number 0". The hub records when each line appeared, so take the date off the line.\n');
  expect(out).toContain('  - Next: "2026-11-24 measure on a 3G profile" opens with a date. The hub records when each line appeared, so take the date off the line.\n');
  expect(out.match(/opens? with a date/g)).toHaveLength(2);
});

test("check names Shipped lines edited in by hand that still say they are under way", () => {
  const phrases = ["in review", "waiting on", "waits on", "is building"];
  const { env } = page(
    [
      "## In progress",
      "",
      "- The deploy is waiting on DNS.",
      "",
      "## Shipped",
      "",
      ...phrases.map((phrase) => `- Devices dialog, which ${phrase} the last step.`),
      "- The log names the device.",
      "  Its follow-up is in review.",
      "",
    ].join("\n"),
  );
  const out = progress(["check", "search-speed"], env).out;
  expect(out).toContain(
    '  - Shipped: 4 items still say they are under way; the first is "Devices dialog, which in review the last step", which says "in review". Give each the words that are true now, with what is still open under it: progress reword "<line>" "<what is now true>" --under "<what is still open>".\n',
  );
  expect(out.match(/under way/g)).toHaveLength(1);
});

test("a page the commands wrote has none of these notes", () => {
  const { env, run } = page("Fast.\n\n## Goal\n\nRetries survive.\n\n## In progress\n\n- Retry queue survives a restart.\n");
  for (const args of [
    ["add", "decisions", "Chose to ship on Nov 24."],
    ["add", "next", "3 of 9 tests fail."],
    ["add", "doing", "Wire the March 3 numbers in."],
    ["move", "retry queue", "shipped"],
    ["reword", "retry queue", "Retry queue survives a restart, built on 2026-11-24."],
  ]) {
    expect(run(...args).code).toBe(0);
  }
  expect(progress(["check", "search-speed"], env).out).toContain("Nothing to fix.");
});

test("the sample pages check clean", () => {
  const env = { PROGRESS_HOME: join(import.meta.dir, "pages"), HOME: mkdtempSync(join(tmpdir(), "progress-cli-")) };
  for (const work of ["search-speed", "sync-reliability"]) expect(progress(["check", work], env).out).toContain("Nothing to fix.");
});

test("a first line over the limit is refused with the command that splits it, ready to run", () => {
  const { run, read } = page(WORK);
  const first = "Once pull request #148 is live, re-read 60 days of records.";
  const rest = `${"Then compare every count with the old one, and write down each gap with its cause. ".repeat(2)}Done.`;
  const refused = run("add", "next", `${first} ${rest}`, "--under", "Ask the owner first.");
  expect(refused.code).toBe(1);
  expect(refused.err).toContain("put the rest on the lines under it, with --under");
  expect(refused.err).toContain(`  progress add next "${first}" --under "Ask the owner first." --work search-speed\n`.replace('--under "Ask the owner first."', `--under "${rest}" --under "Ask the owner first."`));
  expect(read()).toBe(WORK);
  // The refused --as of a move is split the same way.
  expect(run("move", "retry queue", "next", "--as", `${first} ${rest}`).err).toContain(`  progress move "retry queue" next --as "${first}" --work search-speed --under "${rest}"\n`);
  expect(run("add", "next", first, "--under", rest, "--under", "Ask the owner first.").code).toBe(0);
  expect(read()).toBe(WORK.replace("1. Measure on a 3G profile.\n", `1. Measure on a 3G profile.\n2. ${first}\n   ${rest}\n\n   Ask the owner first.\n`));
});

test("a whole link names only the line that links exactly it, never another repository's pull request of the same number", () => {
  const { run, read } = page(WORK);
  const other = run("move", "https://github.com/a/other/pull/57", "shipped", "--as", "Moved.");
  expect(other.code).toBe(1);
  expect(other.err).toContain("No item matches");
  expect(run("reword", "other/pull/57", "Reworded.").code).toBe(1);
  expect(read()).toBe(WORK);
});

test("reword with no new line writes under the item, or puts its pull request in front, and leaves its words", () => {
  const { run, read } = page(WORK);
  const under = run("reword", "retry queue", "--under", "Now in review.", "--pr", "https://github.com/a/b/pull/60");
  expect(under.code).toBe(0);
  expect(read()).toBe(WORK.replace("- Retry queue survives a restart.\n", "- https://github.com/a/b/pull/60 Retry queue survives a restart.\n  Now in review.\n"));
});

test("new words that open with a link replace the links the line started with", () => {
  const { run, read } = page(WORK);
  expect(run("reword", "devices opens", "https://github.com/a/b/pull/58 Devices opens as a dialog.").code).toBe(0);
  expect(read()).toContain("- https://github.com/a/b/pull/58 Devices opens as a dialog.\n  Two of nine tests fail.");
  expect(read()).not.toContain("pull/57 https://");
});

test("a refused --under, a reword to a taken name and a move within a section change nothing and say what to do", () => {
  const { run, read } = page(WORK);
  expect(run("add", "next", "New", "--under", "## Heading").err).toContain("would start a section or an item");
  expect(run("add", "shipped", "New", "--under", "Live: on main").err).toContain("not with --under");
  expect(run("reword", "retry queue", "--under", "Live: on main").err).toContain('progress live "<line>" "<where>"');
  expect(run("reword", "retry queue", "https://github.com/a/b/pull/57 Devices opens as a dialog. Built, in review as pull request 57.").err).toContain("In progress already has");
  expect(run("move", "retry queue", "doing").err).toContain('is already under In progress. To change its words, progress reword "<its words>" "<its new first line>"');
  expect(run("reword", "retry queue").err).toContain("Name the line and give its new first line");
  expect(read()).toBe(WORK);
});
