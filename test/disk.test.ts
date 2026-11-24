import { expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, renameSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Instant, SessionRef, WorkId } from "../src/core/types.ts";
import { planOf } from "../src/core/plan.ts";
import { DiskStore } from "../src/stores/disk/index.ts";
import { t3Source } from "../src/t3/source.ts";
import { NOTHING, SourceError, type AgentSource } from "../src/sources/source.ts";
import type { Runner } from "../src/stores/disk/github.ts";
import { CHILD, GRANDCHILD, ROOT, fixture } from "./t3-fixture.ts";

const noGh: Runner = async () => null;

/** A work's plan as the browser makes it for the work's own board: from the sections and pull requests of its page. */
function planFor(hub: DiskStore, id: string) {
  const detail = hub.detail(id as WorkId);
  return detail ? planOf({ work: detail.summary.id, workTitle: detail.summary.title, project: detail.summary.project }, detail.body.sections, detail.pullRequests) : [];
}

// Root reads and writes whatever a file's mode says, so a file can't be made unreadable for it.
const asRoot = process.getuid?.() === 0;

test("when T3 stops being readable the hub says why and keeps the last good read", () => {
  const files = fixture();
  const home = mkdtempSync(join(tmpdir(), "progress-home-"));
  mkdirSync(join(home, "hub"));
  writeFileSync(join(home, "hub", "progress.md"), "Summary.\n");
  writeFileSync(join(home, "hub", ".sessions"), `t3:${ROOT}`);
  utimesSync(join(home, "hub", "progress.md"), new Date("2026-11-10T09:00:00Z"), new Date("2026-11-10T09:00:00Z"));
  const hub = new DiskStore(home, [t3Source(files)], noGh);
  hub.refresh();
  expect(hub.state().sources[0]?.health.ok).toBe(true);
  expect(hub.detail("hub" as WorkId)?.agents).toHaveLength(3);

  renameSync(files.db, `${files.db}.moved`);
  hub.refresh();
  const health = hub.state().sources[0]?.health ?? { ok: true as const };
  expect(health.ok).toBe(false);
  if (!health.ok) expect(health.reason).toContain("could not be opened");
  expect(hub.detail("hub" as WorkId)?.agents).toHaveLength(3);
  expect(hub.state().needs.filter((n) => n.source === "stall")).toHaveLength(2);
});

test("a page that appears after the hub started, and a thread that joins it, get their agents on the next tick", () => {
  const home = mkdtempSync(join(tmpdir(), "progress-home-"));
  const hub = new DiskStore(home, [t3Source(fixture())], noGh);
  hub.refresh();
  mkdirSync(join(home, "late"));
  writeFileSync(join(home, "late", "progress.md"), "Summary.\n");
  utimesSync(join(home, "late", "progress.md"), new Date("2026-11-10T09:00:00Z"), new Date("2026-11-10T09:00:00Z"));
  hub.refresh();
  expect(hub.detail("late" as WorkId)?.agents).toHaveLength(0);
  writeFileSync(join(home, "late", ".sessions"), `t3:${ROOT}\n`);
  hub.refresh();
  expect(hub.state().works.map((w) => w.needsCount > 0)).toEqual([true]);
  expect(hub.detail("late" as WorkId)?.agents).toHaveLength(3);
});

test("a Shipped line lists every pull request it names, and the work's other pull requests stay apart", () => {
  const home = mkdtempSync(join(tmpdir(), "progress-home-"));
  mkdirSync(join(home, "hub"));
  const file = join(home, "hub", "progress.md");
  writeFileSync(file, "Summary.\n\n## Shipped\n");
  writeFileSync(join(home, "hub", ".sessions"), `t3:${ROOT}`);
  utimesSync(file, new Date("2026-11-10T09:00:00Z"), new Date("2026-11-10T09:00:00Z"));
  const hub = new DiskStore(home, [t3Source(fixture())], noGh);
  hub.refresh();
  expect(hub.detail("hub" as WorkId)?.pullRequests.map((pr) => pr.number)).toEqual([7]);

  writeFileSync(file, `Summary.\n\n## Shipped\n\n- https://github.com/o/r/pull/7 The parser, with https://github.com/o/r/pull/8. Also https://github.com/o/r/pull/7: twice.\n`);
  utimesSync(file, new Date("2026-11-10T09:30:00Z"), new Date("2026-11-10T09:30:00Z"));
  hub.refresh();
  const item = planFor(hub, "hub")[0]?.item;
  expect(item?.prs.map((pr) => [pr.number, pr.state])).toEqual([[7, "merged"]]);
  expect(item?.titleHtml as string | undefined).toBe(
    '<a href="https://github.com/o/r/pull/7">#7</a> The parser, with <a href="https://github.com/o/r/pull/8">https://github.com/o/r/pull/8</a>. Also <a href="https://github.com/o/r/pull/7">#7</a>: twice.',
  );
  const added = hub.state().feed.find((entry) => entry.event.kind === "added");
  expect(added?.prs.map((pr) => pr.number)).toEqual([7]);
});

test("links T3 doesn't know get their title from gh on a later state, without holding up this one", async () => {
  const home = mkdtempSync(join(tmpdir(), "progress-home-"));
  mkdirSync(join(home, "hub"));
  const file = join(home, "hub", "progress.md");
  writeFileSync(file, "Summary.\n\n## Shipped\n\n- https://github.com/o/r/pull/8 and https://github.com/o/r/commit/4be71c9 shipped.\n");
  utimesSync(file, new Date("2026-11-10T09:00:00Z"), new Date("2026-11-10T09:00:00Z"));
  const gh: Runner = async (args) =>
    args[0] === "pr"
      ? JSON.stringify({ number: 8, title: "Teammate's fix", state: "OPEN", isDraft: false, mergedAt: null, createdAt: "2026-11-10T08:00:00Z", url: "https://github.com/o/r/pull/8" })
      : JSON.stringify({ sha: "4be71c9aa", message: "Reset the clock", url: "https://github.com/o/r/commit/4be71c9aa" });
  const hub = new DiskStore(home, [], gh);
  hub.refresh();
  const item = () => {
    return planFor(hub, "hub")[0]?.item;
  };
  expect(item()?.prs).toEqual([]);
  const version = hub.version;
  await Bun.sleep(20);
  expect(hub.version).toBeGreaterThan(version);
  expect(item()?.prs.map((pr) => [pr.number, pr.title])).toEqual([[8, "Teammate's fix"]]);
  expect(item()?.commits.map((c) => c.subject)).toEqual(["Reset the clock"]);
  expect(item()?.titleHtml as string | undefined).toBe('<a href="https://github.com/o/r/pull/8">#8</a> and <a href="https://github.com/o/r/commit/4be71c9">4be71c9</a> shipped.');
});

test("two hubs on one home write each change to the history once, and both show it once", () => {
  const home = mkdtempSync(join(tmpdir(), "progress-home-"));
  mkdirSync(join(home, "hub"));
  const file = join(home, "hub", "progress.md");
  const history = join(home, "hub", ".history.jsonl");
  writeFileSync(file, "Summary.\n\n## Decisions\n\n- First call.\n");
  writeFileSync(join(home, "hub", ".sessions"), `t3:${ROOT}`);
  utimesSync(file, new Date("2026-11-10T09:00:00Z"), new Date("2026-11-10T09:00:00Z"));
  const first = new DiskStore(home, [t3Source(fixture())], noGh);
  const second = new DiskStore(home, [t3Source(fixture())], noGh);
  first.refresh();
  second.refresh();

  writeFileSync(file, "Summary.\n\n## Decisions\n\n- Second call.\n- First call.\n");
  utimesSync(file, new Date("2026-11-10T09:30:00Z"), new Date("2026-11-10T09:30:00Z"));
  second.refresh();
  first.refresh();

  const kinds = readFileSync(history, "utf8")
    .trim()
    .split("\n")
    .map((line) => {
      const event = JSON.parse(line) as { kind: string; change?: string };
      return event.change ? `${event.kind} ${event.change}` : event.kind;
    });
  expect(kinds.sort()).toEqual(["added", "pr merged", "pr opened", "started"]);
  for (const hub of [first, second]) {
    expect(hub.state().feed.map((entry) => entry.event.kind).sort()).toEqual(["added", "pr", "pr", "started"]);
  }
});

test("a history that already holds a change twice shows it once", () => {
  const home = mkdtempSync(join(tmpdir(), "progress-home-"));
  mkdirSync(join(home, "hub"));
  const file = join(home, "hub", "progress.md");
  writeFileSync(file, "Summary.\n\n## Decisions\n\n- First call.\n");
  utimesSync(file, new Date("2026-11-10T09:00:00Z"), new Date("2026-11-10T09:00:00Z"));
  const added = JSON.stringify({ at: "2026-11-10T08:30:00.000Z", kind: "added", section: "decisions", item: { id: "decisions/First call.", title: "First call.", markdown: "- First call." } });
  const started = JSON.stringify({ at: "2026-11-10T08:00:00.000Z", kind: "started", items: [], summary: "Summary." });
  writeFileSync(join(home, "hub", ".history.jsonl"), `${started}\n${added}\n${added}\n`);
  const hub = new DiskStore(home, [], noGh);
  hub.refresh();
  expect(hub.state().feed.map((entry) => entry.event.kind)).toEqual(["added", "started"]);
});

test("a rewording two hubs both wrote keeps the line's time and is told once", () => {
  const home = mkdtempSync(join(tmpdir(), "progress-home-"));
  mkdirSync(join(home, "hub"));
  const file = join(home, "hub", "progress.md");
  writeFileSync(file, "Summary.\n\n## Needs you\n\n### Give the deploy token R2 permission before the merge\n");
  utimesSync(file, new Date("2026-11-10T09:00:00Z"), new Date("2026-11-10T09:00:00Z"));
  const [from, to] = ["Give the deploy token R2 permission", "Give the deploy token R2 permission before the merge"];
  const item = (title: string) => ({ id: `needs/${title}`, title, markdown: `### ${title}` });
  const edited = (at: string) => JSON.stringify({ at, kind: "edited", section: "needs", item: item(to), from: item(from).id });
  const started = JSON.stringify({ at: "2026-11-10T08:00:00.000Z", kind: "started", items: [{ section: "needs", item: item(from) }], summary: "Summary.", parts: {} });
  writeFileSync(join(home, "hub", ".history.jsonl"), `${started}\n${edited("2026-11-10T09:00:00.000Z")}\n${edited("2026-11-10T09:00:01.000Z")}\n`);
  const hub = new DiskStore(home, [], noGh);
  hub.refresh();
  expect(hub.state().needs.flatMap((entry) => (entry.source === "page" ? [entry.since] : []))).toEqual(["2026-11-10T08:00:00.000Z" as Instant]);
  expect(hub.state().feed.map((entry) => entry.event.kind)).toEqual(["edited", "started"]);
});

test.skipIf(asRoot)("a home that can't be read keeps its works and says so, and a page that can't be read is kept as last read", () => {
  const parent = mkdtempSync(join(tmpdir(), "progress-home-"));
  const home = join(parent, "home");
  mkdirSync(join(home, "hub"), { recursive: true });
  const file = join(home, "hub", "progress.md");
  writeFileSync(file, "---\ntitle: Hub\n---\n\nSummary.\n\n## Needs you\n\n### Sign in\n");
  utimesSync(file, new Date("2026-11-10T09:00:00Z"), new Date("2026-11-10T09:00:00Z"));
  const hub = new DiskStore(home, [], noGh);
  hub.refresh();
  expect(hub.state().health.ok).toBe(true);

  renameSync(home, `${home}.unmounted`);
  hub.refresh(new Date("2026-11-10T10:00:00Z"));
  const down = hub.state();
  expect(down.works.map((w) => w.title)).toEqual(["Hub"]);
  expect(down.needs).toHaveLength(1);
  expect(down.health.ok ? null : [down.health.since as string, down.health.reason]).toEqual(["2026-11-10T10:00:00.000Z", expect.stringContaining(`Can't read ${home}:`)]);

  renameSync(`${home}.unmounted`, home);
  chmodSync(file, 0o000);
  utimesSync(file, new Date("2026-11-10T09:30:00Z"), new Date("2026-11-10T09:30:00Z"));
  hub.refresh(new Date("2026-11-10T10:01:00Z"));
  const page = hub.state();
  expect(page.works.map((w) => w.title)).toEqual(["Hub"]);
  expect(page.health.ok ? null : [page.health.since as string, page.health.reason]).toEqual(["2026-11-10T10:01:00.000Z", expect.stringContaining(`Can't read ${file}:`)]);

  chmodSync(file, 0o644);
  hub.refresh(new Date("2026-11-10T10:02:00Z"));
  expect(hub.state().health.ok).toBe(true);
});

test.skipIf(asRoot)("a journal write that fails is reported and made again on the next scan, and a journal that can't be read is not an empty history", () => {
  const home = mkdtempSync(join(tmpdir(), "progress-home-"));
  mkdirSync(join(home, "hub"));
  const file = join(home, "hub", "progress.md");
  const journal = join(home, "hub", ".history.jsonl");
  writeFileSync(file, "Summary.\n\n## Needs you\n");
  utimesSync(file, new Date("2026-11-10T09:00:00Z"), new Date("2026-11-10T09:00:00Z"));
  const hub = new DiskStore(home, [], noGh);
  hub.refresh(new Date("2026-11-10T10:00:00Z"));

  chmodSync(journal, 0o444);
  writeFileSync(file, "Summary.\n\n## Needs you\n\n### Sign in\n");
  utimesSync(file, new Date("2026-11-10T09:30:00Z"), new Date("2026-11-10T09:30:00Z"));
  hub.refresh(new Date("2026-11-10T10:01:00Z"));
  const failed = hub.state();
  expect(failed.health.ok ? null : failed.health.reason).toContain(`Can't write ${journal}:`);
  expect(failed.feed.map((f) => f.event.kind)).toEqual(["started"]);
  expect(failed.needs.map((n) => n.source === "page" && n.title)).toEqual(["Sign in"]);

  chmodSync(journal, 0o644);
  hub.refresh(new Date("2026-11-10T10:02:00Z"));
  const saved = hub.state();
  expect(saved.health.ok).toBe(true);
  expect(saved.feed.map((f) => f.event.kind)).toEqual(["added", "started"]);
  expect(readFileSync(journal, "utf8").split("\n").filter((line) => line.includes('"added"'))).toHaveLength(1);

  chmodSync(journal, 0o000);
  writeFileSync(file, "Summary.\n\n## Needs you\n");
  utimesSync(file, new Date("2026-11-10T09:40:00Z"), new Date("2026-11-10T09:40:00Z"));
  hub.refresh(new Date("2026-11-10T10:03:00Z"));
  const unreadable = hub.state();
  expect(unreadable.health.ok ? null : unreadable.health.reason).toContain(`Can't read ${journal}:`);
  expect(unreadable.feed.map((f) => f.event.kind)).toEqual(["added", "started"]);
  chmodSync(journal, 0o644);
});

test("an empty or just-written page is not read yet, so nothing shows as removed", () => {
  const home = mkdtempSync(join(tmpdir(), "progress-home-"));
  mkdirSync(join(home, "hub"));
  const file = join(home, "hub", "progress.md");
  const put = (text: string, time: string) => {
    writeFileSync(file, text);
    utimesSync(file, new Date(time), new Date(time));
  };
  put("Summary.\n\n## Needs you\n\n### Sign in\n", "2026-11-10T09:00:00Z");
  const hub = new DiskStore(home, [], noGh);
  hub.refresh(new Date("2026-11-10T10:00:00Z"));
  put("", "2026-11-10T09:30:00Z");
  hub.refresh(new Date("2026-11-10T10:01:00Z"));
  put("## Needs you\n", "2026-11-10T10:02:00Z");
  hub.refresh(new Date("2026-11-10T10:02:00.400Z"));
  expect(hub.state().needs.map((n) => n.source === "page" && n.title)).toEqual(["Sign in"]);
  expect(hub.state().feed.map((f) => f.event.kind)).toEqual(["started"]);
});

test("a half-written last line of the journal loses only itself", () => {
  const home = mkdtempSync(join(tmpdir(), "progress-home-"));
  mkdirSync(join(home, "hub"));
  const file = join(home, "hub", "progress.md");
  const journal = join(home, "hub", ".history.jsonl");
  writeFileSync(file, "Summary.\n\n## Needs you\n");
  utimesSync(file, new Date("2026-11-10T09:00:00Z"), new Date("2026-11-10T09:00:00Z"));
  new DiskStore(home, [], noGh).refresh(new Date("2026-11-10T10:00:00Z"));
  writeFileSync(journal, `${readFileSync(journal, "utf8")}{"at":"2026-11-10T09:10:00.000Z","kind":"add`);

  writeFileSync(file, "Summary.\n\n## Needs you\n\n### Sign in\n");
  utimesSync(file, new Date("2026-11-10T09:30:00Z"), new Date("2026-11-10T09:30:00Z"));
  new DiskStore(home, [], noGh).refresh(new Date("2026-11-10T10:01:00Z"));

  const restarted = new DiskStore(home, [], noGh);
  restarted.refresh(new Date("2026-11-10T10:02:00Z"));
  expect(restarted.state().feed.map((f) => f.event.kind)).toEqual(["added", "started"]);
  expect(restarted.detail("hub" as WorkId)?.notes.filter((note) => note.includes(".history.jsonl"))).toHaveLength(1);
});

test("a rewritten summary moves the work up and enters the feed, and so does a section written elsewhere on the page", () => {
  const home = mkdtempSync(join(tmpdir(), "progress-home-"));
  const put = (work: string, text: string, time: string) => {
    mkdirSync(join(home, work), { recursive: true });
    writeFileSync(join(home, work, "progress.md"), text);
    utimesSync(join(home, work, "progress.md"), new Date(time), new Date(time));
  };
  put("search", "---\ntitle: Search\n---\n\nIndexing is half done.\n\n## Ideas\n\n- Cache results.\n", "2026-11-10T08:00:00Z");
  put("sync", "---\ntitle: Sync\n---\n\nConflicts are fixed.\n", "2026-11-10T09:00:00Z");
  const hub = new DiskStore(home, [], noGh);
  hub.refresh(new Date("2026-11-10T10:00:00Z"));
  expect(hub.state().works.map((w) => w.title)).toEqual(["Sync", "Search"]);

  put("search", "---\ntitle: Search\n---\n\nIndexing is done. Next is the ranking pass.\n\n## Ideas\n\n- Cache results.\n", "2026-11-10T09:30:00Z");
  hub.refresh(new Date("2026-11-10T10:01:00Z"));
  const state = hub.state();
  expect(state.works.map((w) => [w.title, w.preview])).toEqual([
    ["Search", "Indexing is done."],
    ["Sync", "Conflicts are fixed."],
  ]);
  const top = state.feed[0];
  expect(top ? [top.workTitle, top.event.kind === "summary" && top.event.text] : null).toEqual(["Search", "Indexing is done. Next is the ranking pass."]);

  put("sync", "---\ntitle: Sync\n---\n\nConflicts are fixed.\n\n## Ideas\n\n- Batch writes.\n", "2026-11-10T09:45:00Z");
  hub.refresh(new Date("2026-11-10T10:02:00Z"));
  expect(hub.state().works.map((w) => w.title)).toEqual(["Sync", "Search"]);
  const newest = hub.state().feed[0];
  expect(newest ? [newest.workTitle, newest.event.kind === "part" && [newest.event.change, newest.event.heading]] : null).toEqual(["Sync", ["added", "Ideas"]]);
});

test("a page dated in the future is read", () => {
  const home = mkdtempSync(join(tmpdir(), "progress-home-"));
  mkdirSync(join(home, "copied"));
  const file = join(home, "copied", "progress.md");
  writeFileSync(file, "---\ntitle: Copied\n---\n\nSummary.\n\n## Needs you\n\n### Sign in\n");
  utimesSync(file, new Date("2026-11-11T09:00:00Z"), new Date("2026-11-11T09:00:00Z"));
  const hub = new DiskStore(home, [], noGh);
  hub.refresh(new Date("2026-11-10T10:00:00Z"));
  expect(hub.state().works.map((w) => [w.title, w.needsCount])).toEqual([["Copied", 1]]);
});

test("one work can have sessions from two harnesses, and one that can't be read leaves the other showing", () => {
  const at = "2026-11-10T09:00:00.000Z" as Instant;
  let broken = false;
  // A second harness, as an adapter would write it: its own ids, its own link, translated into the hub's words.
  const other: AgentSource = {
    id: "other",
    label: "Other",
    detect: () => null,
    link: (session) => `other://open/${session}`,
    read(sessions) {
      if (broken) throw new SourceError("Other is not running.");
      const known = sessions.filter((id) => id === "s1") as SessionRef[];
      const agent = { thread: "s1" as SessionRef, title: "Other agent", status: "working" as const, model: null, account: null, branch: null, worktree: null, startedAt: at, lastActivityAt: at, link: "other://open/s1" };
      return { ...NOTHING, roots: new Map(known.map((id) => [id, id])), agents: new Map(known.map((id) => [id, [agent]])), projects: new Map(known.map((id) => [id, "elsewhere"])) };
    },
  };
  const home = mkdtempSync(join(tmpdir(), "progress-home-"));
  mkdirSync(join(home, "both"));
  writeFileSync(join(home, "both", "progress.md"), "Summary.\n");
  writeFileSync(join(home, "both", ".sessions"), `t3:${ROOT}\nother:s1\n`);
  utimesSync(join(home, "both", "progress.md"), new Date(at), new Date(at));
  const hub = new DiskStore(home, [t3Source(fixture()), other], noGh);
  hub.refresh();
  const sessions = (): string[] => (hub.detail("both" as WorkId)?.agents ?? []).map((agent) => agent.thread).sort();
  expect(sessions()).toEqual(["other:s1", `t3:${CHILD}`, `t3:${GRANDCHILD}`, `t3:${ROOT}`].sort());
  expect(hub.detail("both" as WorkId)?.agents.find((agent) => agent.thread === "other:s1")?.link).toBe("other://open/s1");
  expect(hub.state().sources.map((source) => [source.label, source.health.ok])).toEqual([["T3", true], ["Other", true]]);

  broken = true;
  hub.refresh();
  expect(hub.state().sources.map((source) => [source.label, source.health.ok])).toEqual([["T3", true], ["Other", false]]);
  // What was last read stays, so the page does not lose agents while a harness is down.
  expect(sessions()).toHaveLength(4);
});

test("the plan holds what a work has planned, has under way and has shipped, with a merged pull request no line names", () => {
  const home = mkdtempSync(join(tmpdir(), "progress-home-"));
  mkdirSync(join(home, "hub"));
  const file = join(home, "hub", "progress.md");
  const page = (live: string) => `Summary.\n\n## In progress\n\n- Moving the reader.\n\n## Next\n\n- Measure it.\n\n## Shipped\n\n- The helper resets the clock.\n  It ran late twice.\n\n  ${live}\n`;
  writeFileSync(file, page("Not live: the deploy is run by hand."));
  writeFileSync(join(home, "hub", ".sessions"), `t3:${ROOT}`);
  utimesSync(file, new Date("2026-11-10T09:00:00Z"), new Date("2026-11-10T09:00:00Z"));
  const hub = new DiskStore(home, [t3Source(fixture())], noGh);
  hub.refresh(new Date("2026-11-10T10:00:00Z"));
  // What shipped is sent beside the plan, which a hub of an earlier build reads and knows two states of.
  const plan = () => [...hub.state().plan, ...hub.state().shipped].map((entry) => [entry.state, entry.item?.title ?? `#${entry.pr?.number}`]);
  expect(hub.state().plan.map((entry) => entry.state)).toEqual(["doing", "next"]);
  expect(plan()).toEqual([
    ["doing", "Moving the reader."],
    ["next", "Measure it."],
    ["shipped", "The helper resets the clock."],
    ["shipped", "#7"],
  ]);
  expect(hub.state().works[0]?.shipped).toBe(2);
  const shipped = () => planFor(hub, "hub").find((entry) => entry.item?.title === "The helper resets the clock.")?.item;
  expect(shipped()?.live).toEqual({ on: false, note: "the deploy is run by hand." as never, at: null });
  // The mark is shown as a mark, so it is not also in the text under the line.
  expect(shipped()?.html as string | undefined).toBe("<p>It ran late twice.</p>\n");

  writeFileSync(file, page("Live: on the web."));
  utimesSync(file, new Date("2026-11-10T11:00:00Z"), new Date("2026-11-10T11:00:00Z"));
  hub.refresh(new Date("2026-11-10T11:01:00Z"));
  expect(shipped()?.live).toEqual({ on: true, note: "on the web." as never, at: "2026-11-10T11:00:00.000Z" as Instant });
  expect(hub.state().feed[0]?.event.kind).toBe("live");

  // Across everything, only what shipped lately. A work's own page keeps all of it.
  hub.refresh(new Date("2026-12-20T00:00:00Z"));
  expect(plan().filter(([state]) => state === "shipped")).toEqual([]);
  expect(planFor(hub, "hub").filter((entry) => entry.state === "shipped")).toHaveLength(2);
});

test("a work's change time is that of the latest thing the feed tells, so a change that tells nothing lights no dot", () => {
  const home = mkdtempSync(join(tmpdir(), "progress-home-"));
  mkdirSync(join(home, "hub"));
  const file = join(home, "hub", "progress.md");
  const put = (text: string, time: string) => {
    writeFileSync(file, text);
    utimesSync(file, new Date(time), new Date(time));
  };
  put("Summary.\n\n## Next\n\n- Measure it.\n- Ship it.\n", "2026-11-10T09:00:00Z");
  const hub = new DiskStore(home, [], noGh);
  hub.refresh(new Date("2026-11-10T09:30:00Z"));
  // A line leaving Next is not told, and neither is a blank line added to the file.
  put("Summary.\n\n## Next\n\n\n- Ship it.\n", "2026-11-10T10:00:00Z");
  hub.refresh(new Date("2026-11-10T10:30:00Z"));
  expect(hub.state().works[0]?.lastChangeAt).toBe("2026-11-10T09:00:00.000Z" as Instant);
  // Text written under a line is.
  put("Summary.\n\n## Next\n\n- Ship it.\n  After the review.\n", "2026-11-10T11:00:00Z");
  hub.refresh(new Date("2026-11-10T11:30:00Z"));
  const state = hub.state();
  expect(state.works[0]?.lastChangeAt).toBe("2026-11-10T11:00:00.000Z" as Instant);
  expect(state.feed[0]?.event.kind).toBe("edited");
  expect(planFor(hub, "hub")[0]?.item?.editedAt).toBe("2026-11-10T11:00:00.000Z" as Instant);
});

test("a reworded line is the same item: it keeps its time, and the feed tells it once in its new words", () => {
  const home = mkdtempSync(join(tmpdir(), "progress-home-"));
  mkdirSync(join(home, "hub"));
  const file = join(home, "hub", "progress.md");
  const put = (needs: string, shipped: string, time: string) => {
    writeFileSync(file, `Summary.\n\n## Needs you\n\n### ${needs}\n\n## Shipped\n\n${shipped && `- https://github.com/o/r/pull/105 ${shipped}\n`}`);
    utimesSync(file, new Date(time), new Date(time));
  };
  put("Give the deploy token R2 permission", "", "2026-11-10T08:00:00Z");
  const hub = new DiskStore(home, [], noGh);
  hub.refresh(new Date("2026-11-10T08:30:00Z"));
  put("Give the deploy token R2 permission", "App code is 789 lines net against main, after the elegance round.", "2026-11-10T09:00:00Z");
  hub.refresh(new Date("2026-11-10T09:30:00Z"));
  const shippedId = () => planFor(hub, "hub").find((entry) => entry.state === "shipped")?.item?.id ?? "";
  const needId = () => hub.state().needs.flatMap((entry) => (entry.source === "page" ? [entry.itemId] : []))[0] ?? "";

  put("Give the deploy token R2 permission before the merge", "App code is 798 lines net against main, after the second elegance round.", "2026-11-10T10:00:00Z");
  hub.refresh(new Date("2026-11-10T10:30:00Z"));
  const shipped = planFor(hub, "hub").find((entry) => entry.state === "shipped")?.item;
  expect([shipped?.title, shipped?.since, shipped?.editedAt]).toEqual([
    "https://github.com/o/r/pull/105 App code is 798 lines net against main, after the second elegance round.",
    "2026-11-10T09:00:00.000Z" as Instant,
    "2026-11-10T10:00:00.000Z" as Instant,
  ]);
  expect(hub.state().needs.flatMap((entry) => (entry.source === "page" ? [entry.since] : []))).toEqual(["2026-11-10T08:00:00.000Z" as Instant]);
  // The rewording is told as an edit, and the line's arrival is told in its new words, so its viewed mark is the same.
  expect(hub.state().feed.flatMap((entry) => ("item" in entry.event ? [[entry.event.kind, entry.event.at, entry.event.item.id]] : []))).toEqual([
    ["edited", "2026-11-10T10:00:00.000Z" as Instant, needId()],
    ["edited", "2026-11-10T10:00:00.000Z" as Instant, shippedId()],
    ["added", "2026-11-10T09:00:00.000Z" as Instant, shippedId()],
  ]);
});

test("a reworded line is told in its new words only from when it was added: an earlier line of the same words keeps them", () => {
  const home = mkdtempSync(join(tmpdir(), "progress-home-"));
  mkdirSync(join(home, "hub"));
  const file = join(home, "hub", "progress.md");
  const put = (needs: string, time: string) => {
    writeFileSync(file, `Summary.\n\n## Needs you\n\n${needs && `### ${needs}\n`}`);
    utimesSync(file, new Date(time), new Date(time));
  };
  const hub = new DiskStore(home, [], noGh);
  const [ask, askNow] = ["Give the deploy token R2 permission", "Give the deploy token R2 permission before the merge"];
  put("", "2026-11-10T08:00:00Z");
  hub.refresh(new Date("2026-11-10T08:30:00Z"));
  for (const [needs, time] of [[ask, "09:00"], ["", "10:00"], [ask, "11:00"], [askNow, "12:00"]] as const) {
    put(needs, `2026-11-10T${time}:00Z`);
    hub.refresh(new Date(`2026-11-10T${time}:30Z`));
  }
  const feed = (hub.detail("hub" as WorkId)?.feed ?? []).toReversed().flatMap((entry) => ("item" in entry.event ? [`${entry.event.kind} ${entry.event.item.title}`] : []));
  expect(feed).toEqual([`added ${ask}`, `removed ${ask}`, `added ${askNow}`, `edited ${askNow}`]);
});

test("a line is joined to its old wording only when plainly the same: not under another pull request, and not when two lines could be it", () => {
  const home = mkdtempSync(join(tmpdir(), "progress-home-"));
  mkdirSync(join(home, "hub"));
  const file = join(home, "hub", "progress.md");
  const put = (text: string, time: string) => {
    writeFileSync(file, text);
    utimesSync(file, new Date(time), new Date(time));
  };
  put(
    "Summary.\n\n## Next\n\n- Measure search on a big vault.\n\n## Decisions\n\n- Chose launchd over cron, because cron skips a run when the Mac sleeps.\n\n## Shipped\n\n- https://github.com/o/r/pull/7 The parser is in, with its tests.\n",
    "2026-11-10T09:00:00Z",
  );
  const hub = new DiskStore(home, [], noGh);
  hub.refresh(new Date("2026-11-10T09:30:00Z"));
  put(
    "Summary.\n\n## Next\n\n- Measure search on a big vault on a Mac.\n- Measure search on a big vault on a PC.\n\n## Decisions\n\n- Chose launchd over cron, since cron skips a run when the Mac is asleep.\n\n## Shipped\n\n- https://github.com/o/r/pull/8 The parser is in, with its tests.\n",
    "2026-11-10T10:00:00Z",
  );
  hub.refresh(new Date("2026-11-10T10:30:00Z"));
  const changes = (hub.detail("hub" as WorkId)?.feed ?? []).filter((entry) => entry.event.at === "2026-11-10T10:00:00.000Z");
  expect(changes.map((entry) => [entry.event.kind, "item" in entry.event ? entry.event.item.title : null])).toEqual([
    ["added", "Measure search on a big vault on a Mac."],
    ["added", "Measure search on a big vault on a PC."],
    ["edited", "Chose launchd over cron, since cron skips a run when the Mac is asleep."],
    ["added", "https://github.com/o/r/pull/8 The parser is in, with its tests."],
  ]);

  // Two real pairs: a link's destination and a bare commit id each say which thing a line is about.
  put("Summary.\n\n## Needs you\n\n### Approve [the build](https://github.com/a/r/pull/1) today\n\n## Next\n\n- Ask Sam to deploy main (174e89f): all the speed-ups above.\n", "2026-11-10T11:00:00Z");
  hub.refresh(new Date("2026-11-10T11:30:00Z"));
  put("Summary.\n\n## Needs you\n\n### Approve [the build](https://github.com/a/r/pull/2) today please\n\n## Next\n\n- Ask Sam to deploy main (f63177c): all the speed-ups above.\n", "2026-11-10T12:00:00Z");
  hub.refresh(new Date("2026-11-10T12:30:00Z"));
  const journal = readFileSync(join(home, "hub", ".history.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line) as { at: string; kind: string });
  expect(journal.filter((event) => event.at === "2026-11-10T12:00:00.000Z").map((event) => event.kind)).toEqual(["removed", "removed", "added", "added"]);
});
