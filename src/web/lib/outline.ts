import type { Agent, AgentStatus, Instant, NeedEntry, RenderedSection, WorkDetail } from "../../core/types.ts";
import { freshness } from "./board.ts";
import { matches, needText } from "./needs.ts";

/** The colour a section speaks in. Plain sections are the ones the hub reads nothing from. */
type SectionTone = "needs" | "agents" | "decisions" | "plain";

interface PartBase {
  /** The element id the outline scrolls to. */
  readonly id: string;
  readonly title: string;
  readonly tone: SectionTone;
  /** How many things it holds. Null for prose. */
  readonly count: number | null;
  /** What those things are doing, such as "2 agents waiting on you". Empty when the count says it all. */
  readonly detail: string;
  /** What the user has not seen of it yet, in words: "2 new", "edited". Empty when they have seen it all. */
  readonly fresh: string;
}

/**
 * One section of a work's Home as the hub draws it: the page's own sections, and the agents the hub adds from
 * the harnesses. What the work has planned, under way and shipped is on its board, and its pictures on Media.
 */
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
    | { readonly kind: "items"; readonly section: RenderedSection }
    | { readonly kind: "prose"; readonly section: RenderedSection }
  );

export const AGENT_STATUS: Record<AgentStatus, { readonly label: string; readonly order: number }> = {
  working: { label: "Working", order: 0 },
  waiting: { label: "Waiting on you", order: 1 },
  failed: { label: "Failed", order: 2 },
  idle: { label: "Idle", order: 3 },
  finished: { label: "Finished", order: 4 },
  stopped: { label: "Stopped", order: 5 },
};

/** The words in a piece of server HTML, for the filter. */
function textOf(html: string): string {
  return html.replace(/<[^>]+>/g, " ");
}


/**
 * A work's Home in reading order. Needs you leads, then the page's own sections in the order they were written,
 * without the three the board holds. The agents come after them, then what settled work still lists under Needs you.
 * `needs` is what the hub lists for this work, without what the user marked done.
 */
export function partsOf(detail: WorkDetail, allNeeds: readonly NeedEntry[], seenBefore: Instant, query = ""): readonly Part[] {
  const hit = (...texts: readonly string[]) => matches(query, ...texts);
  const needs = allNeeds.filter((entry) => hit(needText(entry)));
  // Under a filter a section keeps the lines that match. One the hub reads nothing from stays whole when anything in it matches.
  const sections = detail.body.sections
    .filter((section) => section.kind === null || section.kind === "decisions")
    .map((section) => ({ ...section, items: section.items.filter((item) => hit(item.title, textOf(item.html))) }))
    .filter((section) => section.kind !== null || hit(section.heading, textOf(section.html)));
  const agents = detail.agents.filter((agent) => hit(agent.title, agent.branch ?? ""));
  const parts: Part[] = [];
  const ids = new Set<string>();
  const idFor = (name: string) => {
    const base = `s-${name.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-|-$/g, "") || "section"}`;
    let id = base;
    for (let n = 2; ids.has(id); n++) id = `${base}-${n}`;
    ids.add(id);
    return id;
  };
  const count = (n: number, word: string) => (n > 0 ? `${n} ${word}` : "");

  const stalls = needs.filter((entry) => entry.source === "stall").length;
  const settled = detail.summary.settled;
  const asks: Part | null =
    needs.length === 0
      ? null
      : {
          kind: "needs",
          id: idFor("needs you"),
          title: settled ? "Left on settled work" : "Needs you",
          tone: settled ? "plain" : "needs",
          leftover: settled,
          count: needs.length,
          detail: stalls ? `${stalls} ${stalls === 1 ? "agent" : "agents"} waiting on you` : "",
          fresh: count(needs.filter((entry) => entry.source === "page" && freshness(entry.since, null, seenBefore)).length, "new"),
          entries: needs,
        };
  // A live ask leads. What settled work still lists may no longer matter, so it closes the page.
  if (asks && !settled) parts.push(asks);

  for (const section of sections) {
    const edited = freshness(section.changedAt, null, seenBefore) !== null;
    if (section.kind === null) {
      parts.push({ kind: "prose", id: idFor(section.heading), title: section.heading, tone: "plain", count: null, detail: "", fresh: edited ? "edited" : "", section });
      continue;
    }
    if (section.items.length === 0 && query.trim() !== "") continue;
    const marks = section.items.map((item) => freshness(item.since, item.editedAt, seenBefore));
    const fresh = [count(marks.filter((mark) => mark === "new").length, "new"), count(marks.filter((mark) => mark === "edited").length, "edited")].filter(Boolean).join(", ");
    parts.push({ kind: "items", id: idFor(section.heading), title: section.heading, tone: "decisions", count: section.items.length, detail: "", fresh: fresh || (edited ? "edited" : ""), section });
  }

  // Who is doing the work is a detail to look up, not to read first: it comes after the page's own sections, folded.
  const sorted = [...agents].sort((a, b) => AGENT_STATUS[a.status].order - AGENT_STATUS[b.status].order || Date.parse(b.lastActivityAt) - Date.parse(a.lastActivityAt));
  if (sorted.length > 0) {
    parts.push({ kind: "agents", id: idFor("agents"), title: "Agents", tone: "agents", count: null, detail: "", fresh: "", agents: sorted, sharedBranch: sorted.length > 1 && sorted.every((agent) => agent.branch === sorted[0]?.branch) ? (sorted[0]?.branch ?? null) : null });
  }
  if (asks && settled) parts.push(asks);
  return parts;
}
