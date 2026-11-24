import { useSyncExternalStore } from "react";
import type { Instant, WorkId, WorkSummary } from "../../core/types.ts";

/**
 * Which work changed since the user last opened it. Lives only in this browser's localStorage.
 * `since` is when this browser first opened the hub, so older changes don't all start unread.
 */
interface Seen {
  readonly since: Instant;
  readonly works: Readonly<Record<string, Instant>>;
}

const KEY = "progress:seen";
/** The name the board across everything is recorded under, beside the works. No work's folder can have it. */
export const BOARD_SEEN = "~board" as WorkId;
const listeners = new Set<() => void>();

function read(): Seen {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(KEY) ?? "null");
    if (stored && typeof stored === "object" && "since" in stored && "works" in stored) return stored as Seen;
  } catch {
    // Fall through to a fresh record.
  }
  const fresh: Seen = { since: new Date().toISOString() as Instant, works: {} };
  localStorage.setItem(KEY, JSON.stringify(fresh));
  return fresh;
}

let seen = read();

window.addEventListener("storage", (event) => {
  if (event.key !== KEY) return;
  seen = read();
  for (const listener of listeners) listener();
});

export function useSeen(): Seen {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => seen,
  );
}

export function isUnread(work: WorkSummary, record: Seen): boolean {
  return Date.parse(work.lastChangeAt) > Date.parse(record.works[work.id] ?? record.since);
}

export function markSeen(id: WorkId, at: Instant) {
  const last = seen.works[id];
  if (last && Date.parse(last) >= Date.parse(at)) return;
  seen = { since: seen.since, works: { ...seen.works, [id]: at } };
  localStorage.setItem(KEY, JSON.stringify(seen));
  for (const listener of listeners) listener();
}
