import { expect, test } from "bun:test";
import type { FeedEntry, Instant, PullRequest, WorkId } from "../src/core/types.ts";
import { plain } from "../src/core/text.ts";
import { describe, feedMatches, onceEach, shippedOf } from "../src/web/lib/feed.ts";

const at = "2026-11-10T09:00:00.000Z" as Instant;
const pr: PullRequest = { url: "https://github.com/o/r/pull/7", repo: "o/r", number: 7, title: "The parser", state: "merged", openedAt: null, mergedAt: at };

function shipped(markdown: string, prs: readonly PullRequest[] = [], id = "shipped/x"): FeedEntry {
  const title = plain(markdown.replace(/^- /, ""));
  return { at, work: "w" as WorkId, workTitle: "W", project: null, event: { at, kind: "added", section: "shipped", item: { id, title, markdown } }, titleHtml: null, html: null, prs, commits: [], important: false };
}

test("a Shipped line in the feed links to the pull request it names, known to the hub or not, and reads it as its number", () => {
  expect(describe(shipped("- https://github.com/o/r/pull/9 Teammate's fix, see https://github.com/o/r/pull/7.", [pr]))).toMatchObject({
    text: "#9 Teammate's fix, see #7.",
    href: "https://github.com/o/r/pull/7",
  });
  expect(describe(shipped("- https://github.com/o/r/pull/9/files Teammate's fix."))).toMatchObject({ text: "#9 Teammate's fix.", href: "https://github.com/o/r/pull/9" });
  expect(describe(shipped("- [The parser](https://github.com/o/r/commit/4be71c9aa) is in."))).toMatchObject({ text: "The parser is in.", href: "https://github.com/o/r/commit/4be71c9aa" });
  expect(describe(shipped("- The Mac app is reinstalled."))).toMatchObject({ href: null });
});

test("search finds a feed entry by its work, its project or its line", () => {
  const entry = { ...shipped("- The parser is in."), workTitle: "Search work", project: "harbor" };
  expect(["search", "HARBOR", "parser", ""].map((query) => feedMatches(entry, query))).toEqual([true, true, true, true]);
  expect(feedMatches(entry, "zzz")).toBe(false);
});

test("a Shipped line that opens with a pull request it lists starts at its first word", () => {
  expect(describe(shipped("- https://github.com/o/r/pull/7 The parser is in. Tests pass.", [pr]))).toMatchObject({ text: "The parser is in. Tests pass." });
  // Words that need the number as their subject keep it.
  expect(describe(shipped("- https://github.com/o/r/pull/7 is open with everything.", [pr]))).toMatchObject({ text: "#7 is open with everything." });
  expect(describe(shipped("- https://github.com/o/r/pull/9 Teammate's fix."))).toMatchObject({ text: "#9 Teammate's fix." });
});

test("each Shipped line is marked viewed on its own, even when two name one pull request", () => {
  const line = (id: string) => describe(shipped("- https://github.com/o/r/pull/7 A change.", [pr], id));
  expect([line("shipped/the-parser")?.key, line("shipped/the-tests")?.key]).toEqual(["w/shipped/the-parser", "w/shipped/the-tests"]);
  // A pull request that merged with no line about it is marked by its address.
  const merge: FeedEntry = { ...shipped("-"), event: { at, kind: "pr", change: "merged", pr } };
  expect(describe(merge)?.key).toBe(pr.url);
  expect(describe({ ...merge, event: { at, kind: "pr", change: "opened", pr } })?.key).toBeNull();
});

test("a line an agent reworded shows once, with its new words", () => {
  const line = (kind: "added" | "removed", id: string, when: string): FeedEntry => {
    const entry = shipped(`- ${id}`);
    return { ...entry, at: when as Instant, event: { at: when as Instant, kind, section: "shipped", item: { id, title: id, markdown: `- ${id}` } } };
  };
  // Newest first, as the hub sends it: written, reworded an hour later, and one line taken away and written again.
  const feed = [line("added", "back", "2026-11-10T12:00:00.000Z"), line("removed", "back", "2026-11-10T11:00:00.000Z"), line("added", "new words", "2026-11-10T10:00:00.000Z"), line("removed", "old words", "2026-11-10T10:00:00.000Z"), line("added", "back", "2026-11-10T09:30:00.000Z"), line("added", "old words", "2026-11-10T09:00:00.000Z")];
  expect(shippedOf(feed).map((entry) => [entry.event.kind === "added" && entry.event.item.id, entry.at])).toEqual([
    ["back", "2026-11-10T12:00:00.000Z"],
    ["new words", "2026-11-10T10:00:00.000Z"],
  ]);
  expect(onceEach(feed).filter((entry) => entry.event.kind === "added")).toHaveLength(2);
});
