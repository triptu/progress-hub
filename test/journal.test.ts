import { expect, test } from "bun:test";
import { pageEvents, pullRequestEvents, readJournal, replay, writeJournal } from "../src/core/journal.ts";
import { parsePage } from "../src/core/parse.ts";
import type { Instant, JournalEvent, PullRequest } from "../src/core/types.ts";

const t0 = new Date("2026-11-10T09:00:00.000Z");
const later = (ms: number) => new Date(t0.getTime() + ms);

const first = "## Needs you\n\n### Sign in Claude 2\n\n## Shipped\n\n- The Mac app is reinstalled.\n";
const second = "## Needs you\n\n### Pick a layout\n\n## Shipped\n\n- The Mac app is reinstalled.\n";

test("the first sight of a page is one started event carrying its items, at the file's time", () => {
  const events = pageEvents([], parsePage(first), t0);
  expect(events).toHaveLength(1);
  const [started] = events;
  expect(started?.kind).toBe("started");
  expect(started?.at).toBe("2026-11-10T09:00:00.000Z" as Instant);
  if (started?.kind === "started") expect(started.items.map((i) => i.item.title)).toEqual(["Sign in Claude 2", "The Mac app is reinstalled."]);
});

test("a changed page gives removed and added events at its modification time, and the same version again gives none", () => {
  const past = pageEvents([], parsePage(first), t0);
  const edited = parsePage(second);
  const events = pageEvents(past, edited, later(120_000));
  expect(events.map((e) => [e.kind, e.at, "item" in e ? e.item.title : null])).toEqual([
    ["removed", "2026-11-10T09:02:00.000Z", "Sign in Claude 2"],
    ["added", "2026-11-10T09:02:00.000Z", "Pick a layout"],
  ]);
  expect(pageEvents([...past, ...events], edited, later(120_000))).toEqual([]);
  expect(replay([...past, ...events]).items.get("needs/Pick a layout")?.since).toBe("2026-11-10T09:02:00.000Z" as Instant);
});

test("a reworded item is one item leaving and one arriving; a reworded body changes nothing", () => {
  const past = pageEvents([], parsePage(first), t0);
  const body = "## Needs you\n\n### Sign in Claude 2\n\nRun claude auth login.\n\n## Shipped\n\n- The Mac app is reinstalled.\n";
  expect(pageEvents(past, parsePage(body), later(10_000))).toEqual([]);
  const reworded = "## Needs you\n\n### Sign in to Claude 2\n\n## Shipped\n\n- The Mac app is reinstalled.\n";
  expect(pageEvents(past, parsePage(reworded), later(10_000)).map((e) => e.kind)).toEqual(["removed", "added"]);
});

test("marking the page done and reopening it are events", () => {
  const past = pageEvents([], parsePage(first), t0);
  const done = pageEvents(past, parsePage(`---\nstatus: done\n---\n${first}`), later(10_000));
  expect(done.map((e) => e.kind)).toEqual(["done"]);
  expect(pageEvents([...past, ...done], parsePage(first), later(30_000)).map((e) => e.kind)).toEqual(["reopened"]);
});

test("pull request events use the pull request's own times and are recorded once", () => {
  const pr: PullRequest = { url: "https://github.com/o/r/pull/1", repo: "o/r", number: 1, title: "Fix", state: "open", openedAt: null, mergedAt: null };
  const linkedAt = "2026-11-10T08:00:00.000Z" as Instant;
  const opened = pullRequestEvents([], [{ pr, closedAt: null, linkedAt }]);
  expect(opened.map((e) => [e.kind === "pr" && e.change, e.at])).toEqual([["opened", linkedAt]]);
  const merged = { ...pr, state: "merged" as const, mergedAt: "2026-11-10T08:30:00.000Z" as Instant };
  const events = pullRequestEvents(opened, [{ pr: merged, closedAt: merged.mergedAt, linkedAt }]);
  expect(events.map((e) => [e.kind === "pr" && e.change, e.at])).toEqual([["merged", merged.mergedAt]]);
  expect(pullRequestEvents([...opened, ...events], [{ pr: merged, closedAt: merged.mergedAt, linkedAt }])).toEqual([]);
});

test("the history file survives a bad line", () => {
  const events: JournalEvent[] = pageEvents([], parsePage(first), t0);
  const text = `${writeJournal(events)}{not json\n{"at":"2026-11-10T10:00:00Z","kind":"mystery"}\n`;
  const read = readJournal(text);
  expect(read.events).toEqual(events);
  expect(read.skipped).toBe(2);
});
