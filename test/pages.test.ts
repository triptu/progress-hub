import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parsePage } from "../src/core/parse.ts";
import { goalLine, liveMark, splitItem, withoutLiveMark } from "../src/core/text.ts";
import type { Page, SectionKind } from "../src/core/types.ts";

const pages = join(import.meta.dir, "pages");

function read(name: string): Page {
  const dir = join(pages, name);
  return parsePage(readFileSync(join(dir, "progress.md"), "utf8"), dir);
}

function titles(page: Page, kind: SectionKind): string[] {
  return page.sections.filter((s) => s.kind === kind).flatMap((s) => s.items.map((i) => i.title));
}

test("the sync page reads as six asks, three decisions and nine shipped entries", () => {
  const page = read("sync-reliability");
  expect(page.title).toBe("Sync reliability");
  expect(page.project).toBe("kestrel");
  expect(page.goal).toStartWith("Notes sync between phone and desktop");
  expect(page.summary).toStartWith("Six things need you");
  expect(titles(page, "needs")).toEqual([
    "Sign in to the second Codex account",
    "Test device farm quota",
    "Nightly backup job is stuck",
    "Release run 88120456 shows failed",
    "Conflict tests red on main since this morning",
    "Offline edits take long to appear",
  ]);
  expect(titles(page, "decisions")).toHaveLength(3);
  const shipped = titles(page, "shipped");
  expect(shipped).toHaveLength(9);
  expect(shipped).toContain("Agent tooling now uses the newest review model.");
  expect(titles(page, "doing")).toHaveLength(2);
  expect(titles(page, "next")).toHaveLength(3);
  expect(page.sections.filter((s) => s.kind === null).map((s) => s.heading)).toEqual(["Ideas"]);
  expect(page.notes).toEqual([]);
});

test("the search page reads as two asks and keeps its table as written", () => {
  const page = read("search-speed");
  expect(titles(page, "needs")).toEqual(["Ship the new index to everyone, or behind a flag first?", "Approve the larger phone download"]);
  expect(titles(page, "shipped")).toHaveLength(5);
  expect(page.sections.find((s) => s.kind === "shipped")?.items[1]?.markdown).toContain("![Search popover, before and after](images/search-popover.png)");
  expect(titles(page, "decisions")).toHaveLength(3);
  expect(page.sections.find((s) => s.heading === "Measured")?.markdown).toContain("| 50,000 notes | 310 ms | 84 ms |");
  expect(page.notes).toEqual([]);
});

test("a blocker written as a paragraph is one Needs you item", () => {
  const page = parsePage("---\ntitle: X\n---\n\n## Needs you (1)\n\nThe deploy key expired. Rotate it in the console.\n");
  expect(titles(page, "needs")).toEqual(["The deploy key expired. Rotate it in the console."]);
  for (const nothing of ["None right now.", "Nothing right now."]) expect(titles(parsePage(`## Needs you\n\n${nothing}\n`), "needs")).toEqual([]);
});

test("headings inside code fences and the leading title heading are not sections", () => {
  const page = parsePage("# Search speed\n\nWhere it stands.\n\n## Notes\n\n```md\n## Needs you\n### not an item\n```\n");
  expect(page.title).toBe("Search speed");
  expect(page.summary).toBe("Where it stands.");
  expect(page.sections.map((s) => s.heading)).toEqual(["Notes"]);
});

test("check notes name the likely mistakes", () => {
  const dir = mkdtempSync(join(tmpdir(), "progress-parse-"));
  writeFileSync(join(dir, "here.png"), "");
  const page = parsePage(
    [
      "## Blocked on you",
      "",
      "## Shipped",
      "",
      "- Fixed the login loop in #123.",
      "- ![ok](here.png) ![gone](missing.png) ![out](../other/x.png) [abs](/tmp/scratch/a.png)",
    ].join("\n"),
    dir,
  );
  const notes = page.notes.join("\n");
  expect(notes).toContain('"Blocked on you" looks like "Needs you"');
  expect(notes).toContain("#123 with no link");
  expect(notes).toContain('"missing.png" points at a file that does not exist');
  expect(notes).toContain('"../other/x.png" leaves the work\'s folder');
  expect(notes).toContain('"/tmp/scratch/a.png" points outside');
  expect(notes).not.toContain("here.png");
});

test("an item splits into its title line and the body under it", () => {
  expect(splitItem("### Pick a `mode`\n\nWhy it matters.")).toEqual({ title: "Pick a `mode`", body: "Why it matters.", important: false });
  expect(splitItem("- [x] Shipped [the fix](https://x.test/1).\n\n  ![Before](a.png)")).toEqual({ title: "Shipped [the fix](https://x.test/1).", body: "![Before](a.png)", important: false });
  expect(splitItem("1. One line only")).toEqual({ title: "One line only", body: "", important: false });
});

test("an item that starts with ! is marked important, and the mark is not part of its title or id", () => {
  expect(splitItem("- ! Sync no longer loses edits.")).toEqual({ title: "Sync no longer loses edits.", body: "", important: true });
  expect(splitItem("### ! Pick a region").important).toBe(true);
  expect(splitItem("- !important is a CSS word").important).toBe(false);
  const page = parsePage("## Shipped\n\n- ! Sync no longer loses edits.\n- Docs updated.\n");
  expect(page.sections[0]?.items.map((item) => item.id)).toEqual(["shipped/Sync no longer loses edits.", "shipped/Docs updated."]);
  // An agent that swaps the bullet for the mark still gets its own item.
  const swapped = parsePage("## Shipped\n\n- Docs updated.\n! Sync no longer loses edits.\n- Tests pass.\n");
  expect(swapped.sections[0]?.items.map((item) => [item.title, splitItem(item.markdown).important])).toEqual([["Docs updated.", false], ["Sync no longer loses edits.", true], ["Tests pass.", false]]);
});

test("an item is known by its title as written, and a repeat of it by its place", () => {
  const page = parsePage("## Needs you\n\n### Use API?\n### Use API!\n### Use API?\n");
  expect(page.sections[0]?.items.map((i) => i.id)).toEqual(["needs/Use API?", "needs/Use API!", "needs/Use API?/2"]);
});

/** Needs you as agents write it, and the items a person reading the page would expect. */
const NEEDS: readonly (readonly [string, readonly string[]])[] = [
  ["# Needs you\n\n### Sign in to Claude 2\nThe account is logged out, so two agents wait.\n", ["Sign in to Claude 2"]],
  ["# Needs you\n\nThe deploy key expired. Rotate it in the console.\n", ["The deploy key expired. Rotate it in the console."]],
  ["## Needs you\n\nNo access to staging yet; please grant the deploy key.\n", ["No access to staging yet; please grant the deploy key."]],
  ["## Needs you\n\nNone of the agents can push until you rotate the token.\n", ["None of the agents can push until you rotate the token."]],
  ["## Needs you\n\nNothing yet, but the release waits on legal sign-off tomorrow.\n", ["Nothing yet, but the release waits on legal sign-off tomorrow."]],
  ["## Needs you\n\n- No deploy key on staging; grant it.\n", ["No deploy key on staging; grant it."]],
  ["## Needs you\n\nNothing right now.\n", []],
  ["## Needs you\n\n_None for now._\n", []],
  ["## Needs you\n\n**No blockers.**\n", []],
  ["## Needs you\n\nN/A\n", []],
  ["## Needs you\n\nNothing is waiting at the moment!\n", []],
  ["## Needs you\n\n- None right now.\n", []],
  ["## Needs you\n\n", []],
  ["## Needs you\n\n- [x] Sign in to Claude 2\n- [ ] Approve the staging deploy\n", ["Approve the staging deploy"]],
  ["## Needs you\n\n- [x] Sign in to Claude 2\n- [X] Approve the staging deploy\n", []],
  ["## Needs you\n\nTwo things:\n\n- [x] Sign in to Claude 2\n", []],
  ["## Needs you\n\nNo access to staging yet; please grant the deploy key.\n\n- [x] Previous request done\n", ["No access to staging yet; please grant the deploy key."]],
  ["## Needs your eyes later\n\n- Read the migration notes when the run ends\n", []],
  ["## Needs you (2)\n\n- Sign in to Claude 2\n- Approve the staging deploy\n", ["Sign in to Claude 2", "Approve the staging deploy"]],
  ["## Needs you: today\n\n- Approve the staging deploy\n", ["Approve the staging deploy"]],
];

const HEADINGS: readonly (readonly [string, SectionKind | null])[] = [
  ["Decision log", "decisions"],
  ["Decisions", "decisions"],
  ["Decisional notes", null],
  ["Shipped today", "shipped"],
  ["Shipping plan", null],
  ["Needs your review", null],
  ["In progress", "doing"],
  ["In review", "doing"],
  ["Next", "next"],
  ["Next up", "next"],
  ["To do", "next"],
  ["Nextcloud setup", null],
  ["Ideas", null],
];

test.each(HEADINGS)("the heading %p is read as %p", (heading, kind) => {
  expect(parsePage(`## ${heading}\n\n- An entry\n`).sections[0]?.kind ?? null).toBe(kind);
});

test.each(NEEDS)("Needs you in %p reads as %p", (source, expected) => {
  expect(titles(parsePage(source), "needs")).toEqual([...expected]);
});

test("a page's goal is its Goal section, or the summary paragraph that starts with Goal:, and a page with neither is told so", () => {
  const section = parsePage("Indexing is done.\n\n## Goal\n\n- Search in under 100 ms.\n- One index format.\n\n## Ideas\n\n- Later.\n");
  expect(section.goal).toBe("- Search in under 100 ms.\n- One index format.");
  expect(goalLine(section.goal)).toBe("Search in under 100 ms. One index format.");
  expect(goalLine("- Fast search\n- One index format")).toBe("Fast search · One index format");
  expect(section.sections.map((s) => s.heading)).toEqual(["Ideas"]);
  expect(section.summary).toBe("Indexing is done.");

  const lead = parsePage("Goal: CI that fails only for real problems.\n\nMain is green.\n");
  expect([lead.goal, lead.summary]).toEqual(["CI that fails only for real problems.", "Main is green."]);

  const none = parsePage("Main is green.\n");
  expect(none.goal).toBe("");
  expect(none.notes.some((note) => note.includes("no goal"))).toBe(true);
});

test("In progress and Next are lists, and a ticked box in them is done", () => {
  const page = parsePage("## In progress\n\n- Moving the app to the new index.\n\n## Next\n\n1. Rebuild on schema change.\n- [x] Measure a small vault.\n2. Measure a large vault.\n");
  expect(titles(page, "doing")).toEqual(["Moving the app to the new index."]);
  expect(titles(page, "next")).toEqual(["Rebuild on schema change.", "Measure a large vault."]);
  expect(page.sections.find((s) => s.kind === "next")?.markdown).toContain("Measure a small vault.");
});

test("the places to try a work are the links under Try it and the front matter's try, each once", () => {
  const page = parsePage(
    "---\ntitle: X\ntry: http://localhost:5173\n---\n\nGoal: see it.\n\n## Try it\n\n- [Web app](http://localhost:5173)\n- Storybook at http://localhost:6006/\n- [Demo](/Users/me/app/dist/index.html), a file with no server\n- [Mock](mock.html) and [the fix](https://github.com/o/r/pull/7)\n",
    "/tmp/none",
  );
  expect(page.links).toEqual([
    { label: "", url: "http://localhost:5173" },
    { label: "", url: "http://localhost:6006/" },
    { label: "Demo", url: "/Users/me/app/dist/index.html" },
    { label: "Mock", url: "mock.html" },
  ]);
  // A file to try may live where it was built, so it is not flagged as leaving the folder.
  expect(page.notes.join("\n")).not.toContain("/Users/me/app/dist/index.html");
  expect(parsePage("## Running\n\nDev server: <http://127.0.0.1:3000>\n").links).toEqual([{ label: "", url: "http://127.0.0.1:3000" }]);
  expect(parsePage("## Ideas\n\n- See http://localhost:1\n").links).toEqual([]);
});

test("a Shipped item's line about being live is read as a mark, with its words, and is not part of what is under the title", () => {
  expect(liveMark("- The cursor stays put.\n  Desktop and web.\n\n  Live: in desktop 4.18.")).toEqual({ on: true, note: "in desktop 4.18." });
  expect(liveMark("### The cursor stays put\n\n**Not live:** the deploy is run by hand.")).toEqual({ on: false, note: "the deploy is run by hand." });
  expect(liveMark("- The cursor stays put.\n  Not live yet: waits on the release.")?.on).toBe(false);
  expect(liveMark("- The cursor stays put.\n  Live")).toEqual({ on: true, note: "" });
  // The item's own first line is what shipped, and words that only begin with the mark are words.
  expect(liveMark("- Live: the new page is up.")).toBeNull();
  expect(liveMark("- The Live page is up.\n  Live updates arrive in a second.")).toBeNull();
  expect(withoutLiveMark("Desktop and web.\n\nLive: in desktop 4.18.\n\n![After](a.png)")).toBe("Desktop and web.\n\n![After](a.png)");
  // A page can show the mark as an example: code is not read, and stays as written.
  const sample = "### The format has a live mark\n\n```md\nLive: in desktop 4.18.\n```\n\n    Live: indented code\n";
  expect(liveMark(sample)).toBeNull();
  expect(withoutLiveMark("```md\nLive: in desktop 4.18.\n```")).toBe("```md\nLive: in desktop 4.18.\n```");
  // Under a heading, what is indented is code on its own too, and the item keeps it.
  expect(liveMark("### The format has a live mark\n\n    Live: indented code")).toBeNull();
  expect(splitItem("### The format has a live mark\n\n    Live: indented code").body).toBe("    Live: indented code");
  expect(liveMark("- The cursor stays put.\r\n  Live: on the web.".replace(/\r\n?/g, "\n"))).toEqual({ on: true, note: "on the web." });
});

test("check says when a first line runs to a paragraph, and when Needs you says nothing and then asks", () => {
  const long = `- ${"The index is rebuilt in place after an edit and every call site passes the changed note. ".repeat(3)}`;
  expect(parsePage(`## Goal\n\nFast search.\n\n## In progress\n\n${long}\n`).notes.join(" ")).toContain("In progress: an item's first line runs past 160 characters");
  expect(parsePage(`## Goal\n\nFast search.\n\n## Decisions\n\n${long}\n`).notes).toEqual([]);
  const mixed = parsePage("## Goal\n\nFast search.\n\n## Needs you\n\nNothing right now. All seven PRs are drafts, waiting for your review.\n");
  expect(titles(mixed, "needs")).toHaveLength(1);
  expect(mixed.notes.join(" ")).toContain("says nothing is needed and then says more");
});
