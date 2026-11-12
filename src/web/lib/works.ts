import type { WorkSummary } from "../../core/types.ts";
import { matches } from "./needs.ts";

/** What a work is doing, in the order the user cares: waiting on them, running, open but quiet, or over. */
type Phase = "needs" | "working" | "idle" | "settled";

export function phaseOf(work: WorkSummary): Phase {
  if (work.settled) return "settled";
  if (work.needsCount > 0) return "needs";
  return work.workingAgents > 0 ? "working" : "idle";
}

export const PHASE_LABEL: Record<Phase, string> = { needs: "Needs you", working: "Working", idle: "Idle", settled: "Settled" };

export function workMatches(work: WorkSummary, query: string): boolean {
  return matches(query, work.title, work.project, work.summary, work.preview);
}

/** The server's newest-first order, split into work still going and work that is over. */
export function splitWorks(works: readonly WorkSummary[]): { readonly ongoing: readonly WorkSummary[]; readonly settled: readonly WorkSummary[] } {
  return { ongoing: works.filter((work) => !work.settled), settled: works.filter((work) => work.settled) };
}

export function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}
