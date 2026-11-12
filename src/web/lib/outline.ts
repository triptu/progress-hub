import type { Agent, AgentStatus, Instant, NeedEntry, PullRequest, RenderedSection, WorkDetail } from "../../core/types.ts";
import type { MediaItem } from "./media.ts";
import { matches, needText } from "./needs.ts";

/** The colour a section speaks in. Plain sections are the ones the hub reads nothing from. */
type SectionTone = "needs" | "agents" | "doing" | "next" | "shipped" | "prs" | "decisions" | "media" | "plain";

interface PartBase {
  /** The element id the outline scrolls to. */
  readonly id: string;
  readonly title: string;
  readonly tone: SectionTone;
  /** How many things it holds. Null for prose. */
  readonly count: number | null;
  /** What those things are doing, such as "4 working · 9 finished". Empty when the count says it all. */
  readonly detail: string;
  /** How many of them the user has not seen yet. */
  readonly fresh: number;
}

/** One section of a work's page as the hub draws it: the page's own sections, and the ones the hub adds from the harnesses. */
export type Part = PartBase &
  (
    | {
        readonly kind: "needs";
        readonly entries: readonly NeedEntry[];
        /** The work is over, so what its page still lists may no longer matter. */
        readonly leftover: boolean;
      }
    | {
        readonly kind: "agents";
        /** Those still at work first, then the rest, newest activity first. */
        readonly agents: readonly Agent[];
        /** The branch every agent is on, said once above the list. Null when they differ. */
        readonly sharedBranch: string | null;
      }
    | {
        readonly kind: "items";
        /** Null for a Shipped list the hub made from merged pull requests, on a page with no Shipped section. */
        readonly section: RenderedSection | null;
        /** Merged pull requests that no line of the section names. They close the list. */
        readonly merged: readonly PullRequest[];
      }
    | { readonly kind: "prs"; readonly prs: readonly PullRequest[] }
    | { readonly kind: "prose"; readonly section: RenderedSection }
    | { readonly kind: "media"; readonly items: readonly MediaItem[] }
  );

export const AGENT_STATUS: Record<AgentStatus, { readonly label: string; readonly order: number }> = {
  working: { label: "Working", order: 0 },
  waiting: { label: "Waiting on you", order: 1 },
  failed: { label: "Failed", order: 2 },
  idle: { label: "Idle", order: 3 },
  finished: { label: "Finished", order: 4 },
  stopped: { label: "Stopped", order: 5 },
};

const PR_ORDER: Record<PullRequest["state"], number> = { open: 0, draft: 1, merged: 2, closed: 3 };

/** The words in a piece of server HTML, for the filter. */
function textOf(html: string): string {
  return html.replace(/<[^>]+>/g, " ");
}

export function isFresh(since: Instant | null, seenBefore: Instant): boolean {
  return since !== null && Date.parse(since) > Date.parse(seenBefore);
}

/**
 * The page in reading order. Needs you leads, then the pull requests still open. The page's own sections keep
 * the order they were written in. The agents come after them, then what settled work still lists under
 * Needs you, and the media close the page.
 * `needs` is what the hub lists for this work, without what the user dismissed.
 */
export function partsOf(detail: WorkDetail, allNeeds: readonly NeedEntry[], allMedia: readonly MediaItem[], seenBefore: Instant, query = ""): readonly Part[] {
  const hit = (...texts: readonly string[]) => matches(query, ...texts);
  const needs = allNeeds.filter((entry) => hit(needText(entry)));
  const media = allMedia.filter((item) => hit(item.label));
  // Under a filter a section keeps the lines that match. One the hub reads nothing from stays whole when anything in it matches.
  const sections = detail.body.sections.map((section) => ({ ...section, items: section.items.filter((item) => hit(item.title, textOf(item.html))) })).filter((section) => section.kind !== null || hit(section.heading, textOf(section.html)));
  const agents = detail.agents.filter((agent) => hit(agent.title, agent.branch ?? ""));
  const pullRequests = detail.pullRequests.filter((pr) => hit(pr.title, `#${pr.number}`));
  const parts: Part[] = [];
  const ids = new Set<string>();
  const idFor = (name: string) => {
    const base = `s-${name.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-|-$/g, "") || "section"}`;
    let id = base;
    for (let n = 2; ids.has(id); n++) id = `${base}-${n}`;
    ids.add(id);
    return id;
  };
  const freshIn = (section: RenderedSection) => section.items.filter((item) => isFresh(item.since, seenBefore)).length;

  const stalls = needs.filter((entry) => entry.source === "stall").length;
  const asks: Part | null =
    needs.length === 0
      ? null
      : {
          kind: "needs",
          id: idFor("needs you"),
          title: detail.summary.settled ? "Left on settled work" : "Needs you",
          tone: detail.summary.settled ? "plain" : "needs",
          leftover: detail.summary.settled,
          count: needs.length,
          detail: stalls ? `${stalls} ${stalls === 1 ? "agent" : "agents"} waiting on you` : "",
          fresh: needs.filter((entry) => entry.source === "page" && isFresh(entry.since, seenBefore)).length,
          entries: needs,
        };
  // A live ask leads. What settled work still lists may no longer matter, so it closes the page.
  if (asks && !detail.summary.settled) parts.push(asks);

  // Who is doing the work is a detail to look up, not to read first: it comes after the page's own sections, folded.
  const sorted = [...agents].sort((a, b) => AGENT_STATUS[a.status].order - AGENT_STATUS[b.status].order || Date.parse(b.lastActivityAt) - Date.parse(a.lastActivityAt));
  const crew: Part | null =
    sorted.length === 0
      ? null
      : { kind: "agents", id: idFor("agents"), title: "Agents", tone: "agents", count: null, detail: "", fresh: 0, agents: sorted, sharedBranch: sorted.length > 1 && sorted.every((agent) => agent.branch === sorted[0]?.branch) ? (sorted[0]?.branch ?? null) : null };

  // A pull request shows once. One still open or in draft is work in flight, listed first.
  // One that merged is something shipped: under the Shipped line that names it, or on its own after them.
  const inFlight = pullRequests.filter((pr) => pr.state === "open" || pr.state === "draft").sort((a, b) => PR_ORDER[a.state] - PR_ORDER[b.state] || b.number - a.number);
  if (inFlight.length > 0) {
    parts.push({ kind: "prs", id: idFor("open pull requests"), title: "Open pull requests", tone: "prs", count: inFlight.length, detail: inFlight.every((pr) => pr.state === "draft") ? "all drafts" : "", fresh: 0, prs: inFlight });
  }
  const named = new Set(detail.body.sections.flatMap((section) => section.items.flatMap((item) => item.prs.map((pr) => pr.url))));
  const unnamed = pullRequests.filter((pr) => pr.state === "merged" && !named.has(pr.url)).sort((a, b) => (b.mergedAt ?? "").localeCompare(a.mergedAt ?? ""));
  const shippedAt = sections.findLastIndex((section) => section.kind === "shipped");

  for (const [index, section] of sections.entries()) {
    if (section.kind === "needs") continue;
    if (section.kind !== null) {
      const merged = index === shippedAt ? unnamed : [];
      if (section.items.length + merged.length === 0 && query.trim() !== "") continue;
      parts.push({ kind: "items", id: idFor(section.heading), title: section.heading, tone: section.kind, count: section.items.length + merged.length, detail: "", fresh: freshIn(section), section, merged });
    } else {
      parts.push({ kind: "prose", id: idFor(section.heading), title: section.heading, tone: "plain", count: null, detail: "", fresh: 0, section });
    }
  }
  // A page with no Shipped section still shows what merged.
  if (shippedAt === -1 && unnamed.length > 0) {
    parts.push({ kind: "items", id: idFor("shipped"), title: "Shipped", tone: "shipped", count: unnamed.length, detail: "", fresh: 0, section: null, merged: unnamed });
  }
  if (crew) parts.push(crew);
  if (asks && detail.summary.settled) parts.push(asks);
  if (media.length > 0) parts.push({ kind: "media", id: idFor("media"), title: "Media", tone: "media", count: media.length, detail: "", fresh: 0, items: media });
  return parts;
}
