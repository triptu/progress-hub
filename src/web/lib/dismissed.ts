import { useEffect, useMemo } from "react";
import { useMarks } from "./marks.ts";

const OLD_KEY = "progress:dismissed";

/**
 * Needs you items the user waved away, by their key. The hub never edits a page, so an item left on
 * the page of settled work stays there, and this just stops showing it.
 */
export function useDismissed() {
  const marks = useMarks("dismissed");
  // Earlier builds kept these in the browser. They move to the hub once, and the browser's copy goes when the hub has them.
  useEffect(() => {
    const stored = localStorage.getItem(OLD_KEY);
    if (stored === null) return;
    let old: unknown = null;
    try {
      old = JSON.parse(stored);
    } catch {
      // Not a list this code wrote.
    }
    void marks.add(Array.isArray(old) ? old.filter((key) => typeof key === "string") : []).then((saved) => {
      if (saved) localStorage.removeItem(OLD_KEY);
    });
  }, []);
  return useMemo(() => ({ has: marks.has, dismiss: (keys: readonly string[]) => void marks.add(keys), restore: (keys: readonly string[]) => void marks.remove(keys) }), [marks]);
}

export type Dismissed = ReturnType<typeof useDismissed>;
