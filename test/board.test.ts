import { expect, test } from "bun:test";
import type { Html, Instant, PlanEntry, PullRequest, RenderedItem, WorkId } from "../src/core/types.ts";
import { cardMatches, freshness, laneCards, planCards } from "../src/web/lib/board.ts";

const pr = (number: number): PullRequest => ({ url: `https://github.com/o/r/pull/${number}`, repo: "o/r", number, title: `Change ${number}`, state: "merged", openedAt: null, mergedAt: `2026-11-10T0${number}:00:00.000Z` as Instant });
const item = (title: string, since: string | null, prs: readonly PullRequest[] = []): RenderedItem => ({ id: `shipped/${title}`, title, titleHtml: title as Html, html: "" as Html, important: false, since: since as Instant | null, editedAt: null, live: null, prs, commits: [] });
const from = (work: string) => ({ work: work as WorkId, workTitle: work, project: null });

test("two works that share a session show its merged pull request once, and a line that names it keeps it", () => {
  const plan: PlanEntry[] = [
    { ...from("a"), state: "shipped", item: null, pr: pr(1) },
    { ...from("a"), state: "shipped", item: null, pr: pr(2) },
    { ...from("b"), state: "shipped", item: item("The parser is in.", "2026-11-10T05:00:00.000Z", [pr(2)]), pr: null },
    { ...from("b"), state: "shipped", item: null, pr: pr(1) },
    { ...from("b"), state: "next", item: item("Measure it.", null), pr: null },
  ];
  const cards = planCards(plan);
  expect(cards.map((card) => [card.work, card.lane, card.title])).toEqual([
    ["a", "shipped", "Change 1"],
    ["b", "shipped", "The parser is in."],
    ["b", "next", "Measure it."],
  ]);
  // What shipped reads newest first, and each card is marked viewed by its own key.
  expect(laneCards(cards, "shipped").map((card) => [card.title, card.viewKey])).toEqual([
    ["The parser is in.", "b/shipped/The parser is in."],
    ["Change 1", "https://github.com/o/r/pull/1"],
  ]);
  expect(cards.map((card) => cardMatches(card, "#2"))).toEqual([false, true, false]);
});

test("a card is new when it arrived after the last look, and edited when only its text changed since", () => {
  const [card] = planCards([{ ...from("a"), state: "doing", item: { ...item("Moving the reader.", "2026-11-10T05:00:00.000Z"), editedAt: "2026-11-10T07:00:00.000Z" as Instant }, pr: null }]);
  if (!card) throw new Error("no card");
  expect(["2026-11-10T04:00:00.000Z", "2026-11-10T06:00:00.000Z", "2026-11-10T08:00:00.000Z"].map((seen) => freshness(card.at, card.editedAt, seen as Instant))).toEqual(["new", "edited", null]);
});
