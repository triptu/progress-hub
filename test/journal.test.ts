import { expect, test } from "bun:test";
import { pageEvents, pullRequestEvents, readJournal, replay, speaks, told, writeJournal } from "../src/core/journal.ts";
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

test("a different item is one item leaving and one arriving; a reworded body is that item edited, at the time it first appeared", () => {
  const past = pageEvents([], parsePage(first), t0);
  const body = "## Needs you\n\n### Sign in Claude 2\n\nRun claude auth login.\n\n## Shipped\n\n- The Mac app is reinstalled.\n";
  const edited = pageEvents(past, parsePage(body), later(10_000));
  expect(edited.map((e) => [e.kind, "item" in e ? e.item.title : null])).toEqual([["edited", "Sign in Claude 2"]]);
  expect(replay([...past, ...edited]).items.get("needs/Sign in Claude 2")?.since).toBe("2026-11-10T09:00:00.000Z" as Instant);
  expect(pageEvents([...past, ...edited], parsePage(body), later(20_000))).toEqual([]);
  const replaced = "## Needs you\n\n### Pick a region\n\n## Shipped\n\n- The Mac app is reinstalled.\n";
  expect(pageEvents(past, parsePage(replaced), later(10_000)).map((e) => e.kind)).toEqual(["removed", "added"]);
});

test("lines that name different pull requests are different items, while a line that adds one to the same is that line", () => {
  const next = (line: string) => parsePage(`## Next\n\n- ${line}\n`);
  const pr = (n: number) => `https://github.com/o/r/pull/${n}`;
  const change = (from: string, to: string) => pageEvents(pageEvents([], next(from), t0), next(to), later(10_000)).map((e) => e.kind);
  expect(change(`You say "merge", and ${pr(32)} goes in.`, `You say "merge", and ${pr(33)} goes in.`)).toEqual(["removed", "added"]);
  expect(change(`You say "merge", and ${pr(30)} goes in, then ${pr(31)} after it.`, `You say "merge", and ${pr(32)} goes in.`)).toEqual(["removed", "added"]);
  expect(change(`You say "merge", and ${pr(30)} goes in.`, `You say "merge", and ${pr(30)} goes in, then ${pr(31)} after it.`)).toEqual(["edited"]);
  expect(change(`You say "merge", and the fix goes in.`, `You say "merge", and ${pr(32)} goes in.`)).toEqual(["edited"]);
  const commit = (sha: string) => `https://github.com/o/r/commit/${sha}`;
  expect(change(`Deploy ${commit("174e89f0aa")} to staging.`, `Deploy ${commit("174e89f0bb")} to staging now.`)).toEqual(["removed", "added"]);
  expect(change("Review the deployment of commit abcdefa today", "Review the deployment of commit abcdefb today")).toEqual(["removed", "added"]);
  expect(change("Review the deployment of commit 1234567 today", "Review the deployment of commit 7654321 today")).toEqual(["removed", "added"]);
});

const plan = (when: string) => `Please review the final deployment plan ${when}`;

/** The journal of one Needs you list saved once per entry of `saves`, a second apart. */
function saves(...lists: string[][]): JournalEvent[] {
  const events: JournalEvent[] = [];
  lists.forEach((list, n) => events.push(...pageEvents(events, parsePage(`## Needs you\n\n${list.map((title) => `### ${title}\n`).join("\n")}`), later(n * 1000))));
  return events;
}

test("a line reworded back and forth holds each earlier wording once", () => {
  const events = saves([plan("today")], [plan("tomorrow")], [plan("today")], [plan("tomorrow")], [plan("today")]);
  expect(replay(events).items.get(`needs/${plan("today")}`)?.formerly).toEqual([`needs/${plan("tomorrow")}`]);
});

test("a rewording written late, from a wording already reworded again, brings nothing back", () => {
  const events = saves([plan("today")], [plan("tomorrow")], [plan("soon")]);
  const late = { ...events.find((event) => event.kind === "edited"), at: later(4000).toISOString() };
  const { events: read } = readJournal(`${writeJournal(events)}${JSON.stringify(late)}\n`);
  expect([...replay(read).items.keys()]).toEqual([`needs/${plan("soon")}`]);
});

test("a section the hub reads no items from is followed: written, rewritten and taken away, and so is the goal", () => {
  const page = (ideas: string, goal = "Sync never loses an edit.") => parsePage(`Standing still.\n\n## Goal\n\n${goal}\n\n${ideas}## Shipped\n\n- One.\n`);
  let journal = pageEvents([], page(""), t0);
  const step = (next: ReturnType<typeof page>, ms: number) => {
    const events = pageEvents(journal, next, later(ms));
    journal = [...journal, ...events];
    return events.map((e) => (e.kind === "part" ? [e.change, e.heading] : [e.kind]));
  };
  expect(step(page("## Ideas\n\nA smaller index.\n\n"), 1000)).toEqual([["added", "Ideas"]]);
  expect(step(page("## Ideas\n\nA smaller index, built at night.\n\n"), 2000)).toEqual([["edited", "Ideas"]]);
  expect(step(page("## Ideas\n\nA smaller index, built at night.\n\n"), 3000)).toEqual([]);
  expect(step(page("## Ideas\n\nA smaller index, built at night.\n\n", "Sync never loses an edit, on any device."), 4000)).toEqual([["edited", "Goal"]]);
  expect(step(page("", "Sync never loses an edit, on any device."), 5000)).toEqual([["removed", "Ideas"]]);
});

test("a journal begun before edits were followed notes the page once, and reports only what changes after", () => {
  // What an earlier hub wrote: the items as they first read, and nothing about the page's other parts.
  const old: JournalEvent[] = [{ at: "2026-11-10T09:00:00.000Z" as Instant, kind: "started", summary: "", items: [{ section: "shipped", item: { id: "shipped/One.", title: "One.", markdown: "- One." } }] }];
  const now = parsePage("## Shipped\n\n- One.\n  It took two tries.\n\n## Ideas\n\nA smaller index.\n");
  const noted = pageEvents(old, now, later(60_000));
  expect(noted.map((e) => e.kind)).toEqual(["noted"]);
  expect(noted.some(speaks)).toBe(false);
  expect(replay([...old, ...noted]).items.get("shipped/One.")?.since).toBe("2026-11-10T09:00:00.000Z" as Instant);
  expect(pageEvents([...old, ...noted], now, later(90_000))).toEqual([]);
  const after = parsePage("## Shipped\n\n- One.\n  It took three tries.\n\n## Ideas\n\nA smaller index.\n");
  expect(pageEvents([...old, ...noted], after, later(120_000)).map((e) => e.kind)).toEqual(["edited"]);
  expect(readJournal(writeJournal([...old, ...noted])).events).toEqual([...old, ...noted]);
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

test("a Shipped item that goes live is one event at that time, and what was live when first read is live from then", () => {
  const page = (mark: string) => parsePage(`## Shipped\n\n- The cursor stays put.\n  Desktop and web.${mark}\n- The helper resets the clock.\n\n  Live: on main.\n`);
  const past = pageEvents([], page("\n\n  Not live: the deploy is run by hand."), t0);
  expect(replay(past).items.get("shipped/The cursor stays put.")?.liveAt).toBeNull();
  expect(replay(past).items.get("shipped/The helper resets the clock.")?.liveAt).toBe("2026-11-10T09:00:00.000Z" as Instant);
  const live = pageEvents(past, page("\n\n  Live: on the web."), later(3_600_000));
  expect(live.map((e) => [e.kind, "item" in e ? e.item.title : null])).toEqual([["live", "The cursor stays put."]]);
  expect(live.every(speaks)).toBe(true);
  const after = replay([...past, ...live]).items.get("shipped/The cursor stays put.");
  expect([after?.since, after?.liveAt]).toEqual(["2026-11-10T09:00:00.000Z" as Instant, "2026-11-10T10:00:00.000Z" as Instant]);
  // Its words about being live changing is an edit, and taking the mark away ends it.
  expect(pageEvents([...past, ...live], page("\n\n  Live: on the web and in desktop 4.18."), later(7_200_000)).map((e) => e.kind)).toEqual(["edited"]);
  const gone = pageEvents([...past, ...live], page(""), later(7_200_000));
  expect(replay([...past, ...live, ...gone]).items.get("shipped/The cursor stays put.")?.liveAt).toBeNull();
  expect(readJournal(writeJournal(live)).events).toEqual(live);
});

test("a journal tells each thing once: a reworded line by its new words, and a merge by the Shipped line that names it", () => {
  const item = (title: string) => ({ id: `shipped/${title}`, title, markdown: `- ${title}` });
  const at = (minute: number) => `2026-11-10T09:${String(minute).padStart(2, "0")}:00.000Z` as Instant;
  const pr = (number: number): PullRequest => ({ url: `https://github.com/o/r/pull/${number}`, repo: "o/r", number, title: `Change ${number}`, state: "merged", openedAt: null, mergedAt: null });
  const named = { id: "shipped/The parser is in.", title: "The parser is in.", markdown: "- https://github.com/o/r/pull/7 The parser is in." };
  const journal: JournalEvent[] = [
    { at: at(0), kind: "started", items: [], summary: "" },
    { at: at(1), kind: "added", section: "shipped", item: item("old words") },
    { at: at(2), kind: "edited", section: "shipped", item: item("old words") },
    { at: at(3), kind: "removed", section: "shipped", item: item("old words") },
    { at: at(3), kind: "added", section: "shipped", item: item("new words") },
    { at: at(4), kind: "added", section: "shipped", item: named },
    // The page named the pull request before it merged. The merge is that line's news, and tells nothing more.
    { at: at(5), kind: "pr", change: "merged", pr: pr(7) },
    { at: at(6), kind: "pr", change: "merged", pr: pr(8) },
    { at: at(7), kind: "added", section: "next", item: { id: "next/Measure it.", title: "Measure it.", markdown: "- Measure it." } },
    { at: at(8), kind: "removed", section: "next", item: { id: "next/Measure it.", title: "Measure it.", markdown: "- Measure it." } },
    // A line under In progress names a pull request too. Its merge is news that no Shipped line tells, so it is told.
    { at: at(9), kind: "added", section: "doing", item: { id: "doing/The reader.", title: "The reader.", markdown: "- https://github.com/o/r/pull/9 The reader." } },
    { at: at(10), kind: "pr", change: "merged", pr: pr(9) },
  ];
  expect(told(journal).map((e) => [e.kind, "item" in e ? e.item.title : e.kind === "pr" ? `#${e.pr.number}` : null])).toEqual([
    ["started", null],
    ["added", "new words"],
    ["added", "The parser is in."],
    ["pr", "#8"],
    ["added", "The reader."],
    ["pr", "#9"],
  ]);
});
