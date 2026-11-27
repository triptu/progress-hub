import { expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WorkId } from "../src/core/types.ts";
import { DiskStore } from "../src/stores/disk/index.ts";
import { OUTCOMES_BUDGET } from "../src/core/outcomes.ts";
import { diffOfFiles } from "../src/core/ddl.ts";
import { MOST_ROW_BYTES } from "../src/central/protocol.ts";
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

test("on a machine linked to a central hub, new prints the page's address there, which opens on any device", () => {
  const { dir, home, env } = setup();
  const link = join(dir, "central");
  writeFileSync(link, JSON.stringify({ url: "https://hub.example/", credential: `pm_box-1.${"a".repeat(43)}` }));
  expect(progress(["new", "Search speed"], { ...env, PROGRESS_CENTRAL: link }).out).toBe(`${join(home, "search-speed", "progress.md")}\nhttps://hub.example/w/search-speed\n`);
  // A link that can't be read is no link: the page's address is this machine's.
  writeFileSync(link, "not a link");
  expect(progress(["new", "Search speed"], { ...env, PROGRESS_CENTRAL: link }).out).toContain("http://127.0.0.1:4747/w/search-speed");
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
  for (const work of ["search-speed", "sync-reliability", "tool-failures", "signup-growth"]) expect(progress(["check", work], env).out).toContain("Nothing to fix.");
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

test("measure appends a stamped reading, keeps the first unit, and check names what the readings lack", () => {
  const { home, env } = setup();
  const thread = { ...env, T3CODE_THREAD_ID: "thread-a" };
  progress(["new", "Tool failures"], thread);
  const file = join(home, "tool-failures", "outcomes.jsonl");
  const first = progress(["measure", "Failed tool calls", "3.51%", "--where", "prod", "--star", "--lower", "--target", "2%", "--n", "300,248 tool calls"], thread);
  expect(first.code).toBe(0);
  expect(first.out).toContain('"Failed tool calls" is the work\'s north star now.');
  const [line] = readFileSync(file, "utf8").split("\n");
  const reading = JSON.parse(line ?? "");
  expect(Date.now() - Date.parse(reading.at)).toBeLessThan(60_000);
  expect(reading).toMatchObject({ by: "t3:thread-a", outcome: "Failed tool calls", value: 3.51, where: "prod", n: 300248, set: { unit: "%", better: "lower", target: 2, star: true, counted: "tool calls" } });

  // A number in another unit, or with nowhere it was measured, is refused and nothing is written.
  const before = readFileSync(file, "utf8");
  const other = progress(["measure", "Failed tool calls", "29ms", "--where", "prod"], thread);
  expect(other.code).toBe(1);
  expect(other.err).toContain('"Failed tool calls" is measured in %, and 29ms is in ms');
  expect(progress(["measure", "Failed tool calls", "2.96%"], thread).err).toContain("Say where 2.96% was measured");
  expect(readFileSync(file, "utf8")).toBe(before);

  // The definition is sticky: a later reading writes only the number.
  expect(progress(["measure", "Failed tool calls", "2.96%", "--where", "prod", "--window", "Nov 25 full day"], thread).code).toBe(0);
  expect(JSON.parse(readFileSync(file, "utf8").split("\n")[1] ?? "").set).toBeUndefined();
  expect(progress(["measure", "Cohort kept", "--due", "2020-01-02", "--by", "client=web"], thread).code).toBe(0);

  const check = progress(["check", "tool-failures"], env).out;
  expect(check).toContain("North star: Failed tool calls, 2.96% in Prod");
  expect(check).toContain('the north star "Failed tool calls" does not say how it is measured');
  expect(check).toContain('the latest prod reading of "Failed tool calls" has no --source');
  expect(check).toContain('a reading of "Cohort kept" was due on 2020-01-02');
});

test("measures run at once each add their line", async () => {
  const { home, env } = setup();
  progress(["new", "Search speed"], env);
  const { T3CODE_THREAD_ID: _, ...rest } = process.env;
  const runs = Array.from({ length: 6 }, (_, i) => Bun.spawn(["bun", main, "measure", "Search median", `${80 + i}ms`, "--where", "ci", "--work", "search-speed"], { env: { ...rest, ...env }, cwd: tmpdir(), stderr: "pipe" }));
  expect(await Promise.all(runs.map((run) => run.exited))).toEqual([0, 0, 0, 0, 0, 0]);
  const lines = readFileSync(join(home, "search-speed", "outcomes.jsonl"), "utf8").trim().split("\n");
  expect(lines.map((line) => JSON.parse(line).value).sort()).toEqual([80, 81, 82, 83, 84, 85]);
});

test("a rate is fixed by its first reading, read in percent, and checked against its whole", () => {
  const { home, env } = setup();
  const thread = { ...env, T3CODE_THREAD_ID: "thread-a" };
  progress(["new", "Signup growth"], thread);
  const file = join(home, "signup-growth", "outcomes.jsonl");
  const run = (...args: string[]) => progress(["measure", "Active", ...args], thread);
  expect(run("244", "--of", "1114", "--where", "prod", "--star", "--higher", "--target", "25%").code).toBe(0);
  expect(JSON.parse(readFileSync(file, "utf8").split("\n")[0] ?? "")).toMatchObject({ value: 244, of: 1114, set: { target: 25 } });
  const before = readFileSync(file, "utf8");
  expect(run("250", "--where", "prod").err).toContain('"Active" is a rate');
  expect(run("1", "--of", "0", "--where", "prod").err).toContain("--of is the whole that was counted");
  expect(run("3", "--of", "2", "--where", "prod").err).toContain("a whole number from 0 to 2");
  expect(readFileSync(file, "utf8")).toBe(before);
  expect(run("260", "--of", "1100", "--from", "21.9%", "--where", "prod", "--window", "Nov 9 week", "--source", "q.sql").code).toBe(0);
  // check tells the rate, as the hub does, never the count alone.
  expect(progress(["check", "signup-growth"], env).out).toContain("North star: Active, 23.64% in Prod");

  expect(progress(["measure", "Plain", "20", "--where", "prod"], thread).code).toBe(0);
  expect(progress(["measure", "Plain", "5", "--of", "10", "--where", "prod"], thread).err).toContain('"Plain" is a plain number');
});

test("an outcome whose definition is more than a work's outcomes may take is left out, and check names it", () => {
  const { home, env } = setup();
  progress(["new", "Big how"], env);
  const line = (outcome: string, value: number, more: object = {}) => JSON.stringify({ at: `2026-01-0${value}T00:00:00Z`, outcome, value, where: "ci", ...more });
  writeFileSync(join(home, "big-how", "outcomes.jsonl"), [line("Kept", 1), line("Huge", 2, { set: { how: "h".repeat(OUTCOMES_BUDGET) } }), line("Huge", 3), line("Kept", 4), ""].join("\n"));
  // A long text is the agent's to give: measure writes it, and the budget decides what the page carries.
  expect(progress(["measure", "Kept", "5", "--where", "ci", "--work", "big-how", "--note", "n".repeat(2000)], env).code).toBe(0);
  const out = progress(["check", "big-how"], env).out;
  expect(out).toContain(`lines 2 and 3 of outcomes.jsonl are left out: "Huge", with its definition and each line's first reading, is past the 4 MB a work's outcomes may take`);
  const hub = new DiskStore(home, [], async () => null);
  hub.refresh(new Date(Date.now() + 60_000));
  expect(hub.detail("big-how" as WorkId)?.outcomes?.map((outcome) => [outcome.name, outcome.readings.map((r) => r.value)])).toEqual([["Kept", [1, 4, 5]]]);
});

test("check names each line of outcomes.jsonl left out, and why, and the hub's numbers stay numbers", () => {
  const { home, env } = setup();
  progress(["new", "Hand edits"], env);
  const line = (more: object) => JSON.stringify({ at: "2026-01-01T00:00:00Z", where: "prod", ...more });
  writeFileSync(
    join(home, "hand-edits", "outcomes.jsonl"),
    [line({ outcome: "Active", value: 5, of: 10 }), line({ outcome: "Gone", value: 1, of: 0 }), line({ outcome: "Active", value: 7 }), "{not json", line({ outcome: "Active", value: 3, of: 2 }), ""].join("\n"),
  );
  const out = progress(["check", "hand-edits"], env).out;
  expect(out).toContain("lines 2 and 5 of outcomes.jsonl are left out: its count is not from 0 to its --of");
  expect(out).toContain('line 3 of outcomes.jsonl is left out: "Active" is a rate, and this line has no --of');
  expect(out).toContain("line 4 of outcomes.jsonl is left out: it is not JSON");
  const hub = new DiskStore(home, [], async () => null);
  hub.refresh(new Date(Date.now() + 60_000));
  const detail = hub.detail("hand-edits" as WorkId);
  expect(detail?.outcomes?.map((outcome) => [outcome.name, outcome.readings.map((r) => r.value)])).toEqual([["Active", [50]]]);
});

test("a rate redefined as a percent measured directly keeps its unit, and takes the next reading in it", () => {
  const { home, env } = setup();
  progress(["new", "Kept rate"], env);
  const run = (...args: string[]) => progress(["measure", "Kept", ...args, "--work", "kept-rate"], env);
  expect(run("5", "--of", "50", "--where", "prod", "--how", "counted").code).toBe(0);
  expect(run("7%", "--where", "prod", "--how", "from the dashboard").out).toContain("7%");
  const next = run("7%", "--where", "prod");
  expect(next.err).toBe("");
  expect(next.code).toBe(0);
  const hub = new DiskStore(home, [], async () => null);
  hub.refresh(new Date(Date.now() + 60_000));
  expect(hub.detail("kept-rate" as WorkId)?.outcomes?.map((outcome) => [outcome.unit, outcome.readings.map((r) => r.value)])).toEqual([["%", [7, 7]]]);
});

test("a prod reading is told every flag it lacks to be checked, and a source holds for the readings after it", () => {
  const { env } = setup();
  progress(["new", "Checkable"], env);
  const run = (...args: string[]) => progress(["measure", ...args, "--work", "checkable"], env);
  expect(run("Bare", "5ms", "--where", "prod").out).toContain("checkable with its --window and --source. Give them next time.");
  expect(progress(["check", "checkable"], env).out).toContain('the latest prod reading of "Bare" has no --window or --source');
  expect(run("Kept", "5ms", "--where", "prod", "--how", "p50 of the day", "--source", "q.sql", "--window", "Nov 25").out).not.toContain("checkable with");
  expect(run("Kept", "6ms", "--where", "prod", "--window", "Nov 26").out).not.toContain("checkable with");
  expect(run("Kept", "7ms", "--where", "prod").out).toContain("checkable with its --window. Give it next time.");
  expect(progress(["check", "checkable"], env).out).toContain('the latest prod reading of "Kept" has no --window,');
});

test("measure --help prints its flags, and writes nothing", () => {
  const { env } = setup();
  const help = progress(["measure", "--help"], env);
  expect(help.code).toBe(0);
  expect(help.out).toContain("--where prod|ci|local|guess");
  expect(help.out).toContain("--source <file|link>");
});

test("change db keeps a pull request's migrations, a second run replaces them, and the hub shows what their SQL does", async () => {
  const { dir, home, env } = setup();
  const thread = { ...env, T3CODE_THREAD_ID: "thread-a" };
  progress(["new", "Routine waits"], thread);
  // The files are given from where the agent works, and kept by the path given.
  const repo = join(dir, "repo");
  mkdirSync(join(repo, "db", "migrations"), { recursive: true });
  writeFileSync(join(repo, "db", "migrations", "001_waits.sql"), "CREATE TABLE routine_waits (id uuid PRIMARY KEY, minutes integer NOT NULL DEFAULT 30);\n");
  const { T3CODE_THREAD_ID: _, ...rest } = process.env;
  const run = (args: string[]) => {
    const result = Bun.spawnSync(["bun", main, "change", "db", ...args], { env: { ...rest, ...thread }, cwd: join(repo, "db") });
    return { code: result.exitCode, out: result.stdout.toString(), err: result.stderr.toString() };
  };
  const pr = "https://github.com/acme/kestrel/pull/412";
  const first = run(["migrations/001_waits.sql", "--pr", pr, "--why", "Each routine waits this long for an offline computer"]);
  expect(first.code).toBe(0);
  expect(first.out).toContain("The hub reads: 1 new table.");

  // Nothing is written without a pull request, a why, or a file that is there.
  const file = join(home, "routine-waits", "changes.jsonl");
  const before = readFileSync(file, "utf8");
  expect(run(["migrations/001_waits.sql", "--why", "x"]).err).toContain("--pr <link>");
  expect(run(["migrations/001_waits.sql", "--pr", pr]).err).toContain('--why "<why>"');
  expect(run(["migrations/missing.sql", "--pr", pr, "--why", "x"]).err).toContain("There is no file at migrations/missing.sql");
  expect(readFileSync(file, "utf8")).toBe(before);

  // The pull request changed: the agent records it again, from its files tab, and the new SQL replaces the old.
  writeFileSync(join(repo, "db", "migrations", "002_paused.sql"), "ALTER TABLE routines ADD COLUMN paused_at timestamptz;\nCREATE INDEX CONCURRENTLY routines_paused_idx ON routines (paused_at) WHERE paused_at IS NOT NULL;\n");
  const again = run(["migrations/001_waits.sql", "migrations/002_paused.sql", "--pr", `${pr}/files`, "--why", "Routines wait for an offline computer, and can be paused", "--db", "Server"]);
  expect(again.out).toContain("It replaces the one recorded at");
  expect(again.out).toContain("The hub reads: 1 new table, 1 column added, 1 index added.");

  const hub = new DiskStore(home, [], async () => null);
  hub.refresh(new Date(Date.now() + 60_000));
  expect(hub.state().works[0]?.latestChange).toBeDefined();
  const [change] = hub.detail("routine-waits" as WorkId)?.changes ?? [];
  expect(change).toMatchObject({ by: "t3:thread-a", kind: "db", why: "Routines wait for an offline computer, and can be paused", db: "Server", pull: null });
  expect(change?.files.map((f) => f.path)).toEqual(["migrations/001_waits.sql", "migrations/002_paused.sql"]);
  // The hub keeps the SQL as written. What it does is read from it, wherever the change is shown.
  const diff = diffOfFiles(change?.files ?? []);
  expect(diff.tables.map((table) => [table.name, table.mark, table.rows.map((row) => `${row.mark} ${row.kind} ${row.name} ${row.detail} ${row.tags.join(", ")}`.trim())])).toEqual([
    ["routine_waits", "added", ["added column id uuid primary key", "added column minutes integer not null, default 30"]],
    ["routines", "changed", ["added column paused_at timestamptz", "added index routines_paused_idx (paused_at) concurrently, where paused_at IS NOT NULL"]],
  ]);
});

test("a work's key changes never make its page more than a central hub keeps: the newest that fit are shown, past one too large", () => {
  const { home, env } = setup();
  progress(["new", "Big changes"], env);
  const change = (n: number, bytes: number) => JSON.stringify({ at: `2026-01-${String(n).padStart(2, "0")}T00:00:00Z`, kind: "db", pr: `https://github.com/acme/app/pull/${n}`, why: `Change ${n}`, files: [{ path: "data.sql", sql: `-- ${"a".repeat(bytes)}` }] });
  // Written by hand past the command's limit: the newest is larger than a page may be, and the rest fill more than one.
  const lines = [...Array.from({ length: 60 }, (_, i) => change(i + 1, 127 * 1024)), change(61, 7 * 1024 * 1024), "not json", JSON.stringify({ at: "2026-02-01T00:00:00Z", kind: "db", pr: "mailto:someone@example.com", why: "x", files: [{ path: "a.sql", sql: "" }] })];
  writeFileSync(join(home, "big-changes", "changes.jsonl"), lines.join("\n"));
  const hub = new DiskStore(home, [], async () => null);
  hub.refresh(new Date(Date.now() + 60_000));
  const detail = hub.detail("big-changes" as WorkId);
  expect(new TextEncoder().encode(JSON.stringify(detail)).byteLength).toBeLessThan(MOST_ROW_BYTES);
  const kept = detail?.changes?.map((c) => c.why) ?? [];
  // The newest that fits is shown, though the one after it doesn't fit.
  expect(kept[0]).toBe("Change 60");
  expect(kept.length).toBeGreaterThan(30);
  expect(kept.length).toBeLessThan(60);
  expect(detail?.notes).toContain(`${61 - kept.length} key changes were left out: with the rest of the page, they are more than a central hub keeps for one work.`);
  // A line that is not JSON, and one whose pull request is not a web link, are left out and counted.
  expect(detail?.notes).toContain("2 lines of changes.jsonl could not be read and were left out.");
});
