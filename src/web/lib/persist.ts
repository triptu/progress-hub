import { useCallback, useSyncExternalStore } from "react";

/**
 * A small value kept in this browser's localStorage, such as the sidebar's width.
 * `read` turns whatever was stored into a valid value, so a bad or older entry falls back to the default.
 */
const listeners = new Set<() => void>();
const cache = new Map<string, unknown>();

function load<T>(key: string, read: (stored: unknown) => T): T {
  if (cache.has(key)) return cache.get(key) as T;
  let stored: unknown = null;
  try {
    stored = JSON.parse(localStorage.getItem(key) ?? "null");
  } catch {
    // A value this code didn't write. The default takes over.
  }
  const value = read(stored);
  cache.set(key, value);
  return value;
}

export function usePersisted<T>(key: string, read: (stored: unknown) => T): readonly [T, (value: T) => void] {
  const value = useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => load(key, read),
  );
  const set = useCallback(
    (next: T) => {
      cache.set(key, next);
      localStorage.setItem(key, JSON.stringify(next));
      for (const listener of listeners) listener();
    },
    [key],
  );
  return [value, set];
}
