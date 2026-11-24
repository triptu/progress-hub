import type { Commit, Html, Instant, Live, NeedEntry, PlanEntry, PullRequest, WorkId } from "../../core/types.ts";
import { prKey, viewKey } from "../../core/marks.ts";
import { matches, needKey, needSince, needTitle } from "./needs.ts";

/** The board's columns, left to right: what waits on the user, then the three states a piece of work moves through. */
export const LANES = ["needs", "next", "doing", "shipped"] as const;
export type Lane = (typeof LANES)[number];

export const LANE_LABEL: Record<Lane, string> = { needs: "Needs you", next: "Next up", doing: "In progress", shipped: "Shipped" };

/**
 * One card on the board, whatever it is: an ask, a line of a page's Next, In progress or Shipped section,
 * or a pull request no line names. Every lane draws the same card.
 */
export interface BoardCard {
  /** Tells the card apart on the board, and is what the user's marks are kept under. */
  readonly key: string;
  /** The card's name in the address when it is open: short, where a key holds its whole first line. */
  readonly name: string;
  readonly lane: Lane;
  /** Null for an agent stopped on a question that no page claims. */
  readonly work: WorkId | null;
  readonly workTitle: string | null;
  readonly project: string | null;
  /** The card's words as plain text, for the filter and where there is no HTML. */
  readonly title: string;
  readonly titleHtml: Html | null;
  /** What the page wrote under the line. */
  readonly body: Html | null;
  readonly prs: readonly PullRequest[];
  readonly commits: readonly Commit[];
  readonly important: boolean;
  /** When it arrived: an item first seen, a pull request opened or merged, an agent stopped. */
  readonly at: Instant | null;
  /** When its text last changed after that. */
  readonly editedAt: Instant | null;
  /** The ask behind a Needs you card, for what only an ask has: the thread to answer in, a stalled agent's question. */
  readonly need: NeedEntry | null;
  /** What marks a Shipped card as viewed. Null in the other lanes. */
  readonly viewKey: string | null;
  /** Whether what shipped can be tried yet, where its page says. */
  readonly live: Live | null;
}

/** A card's name for the address, from its key: 64 bits of it, so two cards on one board do not share a name. */
export function cardName(key: string): string {
  const half = (seed: number) => {
    let hash = seed;
    for (let at = 0; at < key.length; at++) hash = Math.imul(hash ^ key.charCodeAt(at), 0x01000193);
    return (hash >>> 0).toString(36);
  };
  return half(0x811c9dc5) + half(0x9747b28c);
}

export function needCard(entry: NeedEntry): BoardCard {
  const page = entry.source === "page";
  return {
    key: needKey(entry),
    name: cardName(needKey(entry)),
    lane: "needs",
    work: entry.work,
    workTitle: entry.workTitle,
    project: entry.project,
    title: needTitle(entry),
    titleHtml: page ? entry.titleHtml : null,
    body: page ? entry.html : null,
    prs: [],
    commits: [],
    important: page && entry.important,
    at: needSince(entry),
    editedAt: null,
    need: entry,
    viewKey: null,
    live: null,
  };
}

function planCard(entry: PlanEntry): BoardCard {
  const from = { lane: entry.state, work: entry.work, workTitle: entry.workTitle, project: entry.project, need: null };
  const shipped = entry.state === "shipped";
  if (entry.item === null) {
    const { pr } = entry;
    return { ...from, key: pr.url, name: cardName(pr.url), title: pr.title || `#${pr.number}`, titleHtml: null, body: null, prs: [pr], commits: [], important: false, at: shipped ? pr.mergedAt : pr.openedAt, editedAt: null, viewKey: shipped ? prKey(entry.work, pr.url) : null, live: null };
  }
  const { item } = entry;
  return {
    ...from,
    key: `${entry.work}/${item.id}`,
    name: cardName(`${entry.work}/${item.id}`),
    title: item.title,
    titleHtml: item.titleHtml,
    body: item.html,
    prs: item.prs,
    commits: item.commits,
    important: item.important,
    at: item.since,
    // A hub of an earlier build on another machine does not say.
    editedAt: item.editedAt ?? null,
    viewKey: shipped ? viewKey(entry.work, item.id) : null,
    live: item.live ?? null,
  };
}

/**
 * The cards of a plan, each machine's pull request once. Two works that share a session both hold its pull
 * requests, so one that merged with no line about it would show twice: the first work listed keeps it, and one a
 * line on that machine names is left to that line. Another machine's is its own (`prKey`).
 */
export function planCards(plan: readonly PlanEntry[]): BoardCard[] {
  const named = new Set(plan.flatMap((entry) => (entry.item ? entry.item.prs.map((pr) => prKey(entry.work, pr.url)) : [])));
  return plan.filter((entry) => entry.item !== null || (!named.has(prKey(entry.work, entry.pr.url)) && named.add(prKey(entry.work, entry.pr.url)))).map(planCard);
}

/** A lane's cards in the order it reads: asks oldest first, what shipped newest first, and the plan as its pages list it. */
export function laneCards(cards: readonly BoardCard[], lane: Lane): BoardCard[] {
  const mine = cards.filter((card) => card.lane === lane);
  if (lane !== "shipped") return mine;
  // A sort keeps the order of what it can't tell apart, so lines with no time stay where their page put them.
  return mine.sort((a, b) => (b.at ?? "").localeCompare(a.at ?? ""));
}

export function cardMatches(card: BoardCard, query: string): boolean {
  return matches(query, card.title, card.workTitle, card.project, ...card.prs.map((pr) => `#${pr.number} ${pr.title}`));
}

/**
 * Whether something that arrived at `at`, and whose text last changed at `editedAt`, is new or edited to someone
 * who last looked at `seenBefore`. What arrived since is new, however much it was edited after.
 */
export function freshness(at: Instant | null, editedAt: Instant | null | undefined, seenBefore: Instant): "new" | "edited" | null {
  const after = (when: Instant | null | undefined) => when !== null && when !== undefined && Date.parse(when) > Date.parse(seenBefore);
  return after(at) ? "new" : after(editedAt) ? "edited" : null;
}
