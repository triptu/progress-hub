import { useMemo, useSyncExternalStore } from "react";
import type { MarkKind } from "../../core/types.ts";
import { refreshHub, useHub } from "./store.ts";

/**
 * What the user marked: shipped things they have looked at, and Needs you items they waved away.
 * The hub keeps the marks, so the laptop and the phone show the same. A click shows at once: it is
 * held here until the hub's state says the same.
 */
const pending = new Map<string, boolean>();
const listeners = new Set<() => void>();
let turn = 0;
/** The last change didn't reach the hub's file, so the screen went back to what the hub holds. */
let unsaved = false;

const id = (kind: MarkKind, key: string) => `${kind}\n${key}`;

function emit() {
  turn++;
  for (const listener of listeners) listener();
}

/** Resolves to whether the hub saved the change. */
function send(kind: MarkKind, keys: readonly string[], on: boolean): Promise<boolean> {
  if (keys.length === 0) return Promise.resolve(true);
  for (const key of keys) pending.set(id(kind, key), on);
  emit();
  return fetch("/api/marks", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ kind, keys, on }) })
    .then((response) => (response.ok ? refreshHub().then(() => true) : false))
    .catch(() => false)
    .then((saved) => {
      // A later click on the same key has its own request, and this one must not undo it.
      for (const key of keys) if (pending.get(id(kind, key)) === on) pending.delete(id(kind, key));
      unsaved = !saved;
      emit();
      return saved;
    });
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

/** True after a mark the hub didn't save, until one is saved. The screen says so, since the click was undone. */
export const useUnsavedMark = () => useSyncExternalStore(subscribe, () => unsaved);

export interface MarkSet {
  has(key: string): boolean;
  /** Both resolve to whether the hub saved the change. */
  add(keys: readonly string[]): Promise<boolean>;
  remove(keys: readonly string[]): Promise<boolean>;
}

export function useMarks(kind: MarkKind): MarkSet {
  const stored = useHub()?.marks[kind];
  const at = useSyncExternalStore(subscribe, () => turn);
  return useMemo(() => {
    const set = new Set(stored);
    const has = (key: string) => pending.get(id(kind, key)) ?? set.has(key);
    return {
      has,
      add: (keys) => send(kind, keys.filter((key) => !has(key)), true),
      remove: (keys) => send(kind, keys.filter(has), false),
    };
  }, [kind, stored, at]);
}

/** A row's viewed mark: whether it is on, and the click that changes it. Undefined when the row has nothing to mark. */
export function viewedOf(marks: MarkSet, key: string | null): { readonly on: boolean; readonly set: (on: boolean) => void } | undefined {
  if (key === null) return undefined;
  return { on: marks.has(key), set: (on) => void (on ? marks.add([key]) : marks.remove([key])) };
}

/**
 * What marks a Shipped line as viewed: the line itself. Two lines about one pull request are two
 * things to look at, so the pull requests a line names play no part.
 */
export function viewKey(work: string, itemId: string): string {
  return `${work}/${itemId}`;
}

/** Something that shipped and the user has not marked as viewed. What has no key can't be marked, so it never waits. */
export function toView(marks: MarkSet, key: string | null): boolean {
  return key !== null && !marks.has(key);
}
