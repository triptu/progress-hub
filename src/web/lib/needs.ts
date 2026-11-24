import { doneKey } from "../../core/marks.ts";
import type { Instant, NeedEntry } from "../../core/types.ts";

/** An empty Needs you. While a harness can't be read, an agent stopped in it can't be seen, so this doesn't claim nothing waits. `unread` names the harnesses that can't be read. */
export function nothingWaiting(unread: readonly string[]): string {
  return unread.length === 0 ? "Nothing needs you." : `Nothing on the pages needs you. ${unread.join(" and ")} can't be read, so an agent stopped on a question may not show here.`;
}

/** A stable anchor for an entry on the Needs you screen. */
export function needKey(entry: NeedEntry): string {
  return entry.source === "page" ? doneKey(entry.work, entry.itemId) : `stall:${entry.stall.thread}`;
}

export function needTitle(entry: NeedEntry): string {
  return entry.source === "page" ? entry.title : entry.agentTitle;
}

function needAsk(entry: NeedEntry): string | null {
  if (entry.source === "page") return null;
  return entry.stall.ask === "approval" ? "Wants approval" : "Asked a question";
}

export function needWhere(entry: NeedEntry): string {
  const where = entry.workTitle ?? entry.project ?? "";
  const ask = needAsk(entry);
  return ask && where ? `${ask} · ${where}` : (ask ?? where);
}

export function needSince(entry: NeedEntry): Instant {
  return entry.source === "page" ? entry.since : entry.stall.since;
}

export function needText(entry: NeedEntry): string {
  return [needTitle(entry), entry.workTitle ?? "", entry.project ?? "", entry.source === "stall" ? (entry.stall.text ?? "") : ""].join(" ");
}

export function matches(query: string, ...texts: readonly (string | null)[]): boolean {
  const q = query.trim().toLowerCase();
  return !q || texts.some((text) => text?.toLowerCase().includes(q));
}
