import type { PlanEntry, PullRequest, RenderedSection } from "./types.ts";

/**
 * A work's plan: the lines of its page's Next, In progress and Shipped sections, then the pull requests its
 * sessions hold that no line names, in progress while open and shipped once merged. The hub makes it for the
 * board across everything, and the browser for one work's board, from the same sections and pull requests.
 */
export function planOf(from: Pick<PlanEntry, "work" | "workTitle" | "project">, sections: readonly RenderedSection[], prs: readonly PullRequest[]): PlanEntry[] {
  const items = sections.flatMap((section) => (section.kind === "doing" || section.kind === "next" || section.kind === "shipped" ? section.items.map((item) => ({ ...from, state: section.kind as PlanEntry["state"], item, pr: null })) : []));
  const named = new Set(items.flatMap((entry) => entry.item.prs.map((pr) => pr.url)));
  const unnamed = prs.filter((pr) => !named.has(pr.url));
  const merged = unnamed.filter((pr) => pr.state === "merged").sort((a, b) => (b.mergedAt ?? "").localeCompare(a.mergedAt ?? ""));
  return [
    ...items,
    ...unnamed.filter((pr) => pr.state === "open" || pr.state === "draft").map((pr) => ({ ...from, state: "doing" as const, item: null, pr })),
    ...merged.map((pr) => ({ ...from, state: "shipped" as const, item: null, pr })),
  ];
}
