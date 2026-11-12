import { useSyncExternalStore } from "react";
import type { Instant } from "../../core/types.ts";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

let now = Date.now();
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | null = null;

/** The current time, ticking once a minute while anything shows a relative time. */
export function useNow(): number {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      timer ??= setInterval(() => {
        now = Date.now();
        for (const l of listeners) l();
      }, MINUTE);
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0 && timer) {
          clearInterval(timer);
          timer = null;
        }
      };
    },
    () => now,
  );
}

/** "now", "6m", "2h", "3d", then a short date. */
export function relative(at: Instant | null, nowMs: number): string {
  if (at === null) return "";
  const ms = nowMs - Date.parse(at);
  if (ms < MINUTE) return "now";
  if (ms < HOUR) return `${Math.floor(ms / MINUTE)}m`;
  if (ms < DAY) return `${Math.floor(ms / HOUR)}h`;
  if (ms < 30 * DAY) return `${Math.floor(ms / DAY)}d`;
  return new Date(at).toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

export function exact(at: Instant): string {
  return new Date(at).toLocaleString(undefined, {
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function clock(at: Instant | null): string {
  return at === null ? "" : new Date(at).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

function startOfDay(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export function isToday(at: Instant, nowMs: number): boolean {
  return Date.parse(at) >= startOfDay(nowMs);
}

/** A stable key and a label for the day an instant falls on: Today, Yesterday, a weekday, then a date. */
export function dayOf(at: Instant, nowMs: number): { readonly key: string; readonly label: string } {
  const start = startOfDay(Date.parse(at));
  const daysAgo = Math.round((startOfDay(nowMs) - start) / DAY);
  const date = new Date(start);
  const key = date.toDateString();
  if (daysAgo <= 0) return { key, label: "Today" };
  if (daysAgo === 1) return { key, label: "Yesterday" };
  if (daysAgo < 7) return { key, label: date.toLocaleDateString(undefined, { weekday: "long" }) };
  return { key, label: date.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" }) };
}
