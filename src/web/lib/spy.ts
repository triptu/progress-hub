import { useCallback, useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import type { RefObject } from "react";

/**
 * Which of the sections with these ids the reader is in: the last one whose top has passed a line
 * a third of the way down the scrolling `root`. None, while what sits above the first section is still being read. `pin` marks a section the reader chose in the outline:
 * a short one near the page's end can't reach that line, so it stays marked until they scroll themselves.
 */
export function useActiveSection(ids: readonly string[], root: RefObject<HTMLElement | null>): readonly [string | null, (id: string) => void] {
  const [active, setActive] = useState<string | null>(null);
  const pinned = useRef(false);
  const key = ids.join("\n");
  useEffect(() => {
    const scroller = root.current;
    if (!scroller) return;
    const measure = () => {
      if (pinned.current) return;
      const box = scroller.getBoundingClientRect();
      const line = box.top + box.height / 3;
      let current: string | null = null;
      for (const id of ids) {
        const top = document.getElementById(id)?.getBoundingClientRect().top;
        if (top !== undefined && top <= line) current = id;
      }
      setActive(current);
    };
    const release = () => {
      pinned.current = false;
    };
    // The first reading is drawn before the browser paints, and is taken once the screen has been scrolled back
    // to where a reload or Back left it, so the outline never shows one frame of the wrong section.
    queueMicrotask(() => flushSync(measure));
    scroller.addEventListener("scroll", measure, { passive: true });
    scroller.addEventListener("wheel", release, { passive: true });
    scroller.addEventListener("touchmove", release, { passive: true });
    window.addEventListener("keydown", release);
    window.addEventListener("resize", measure);
    return () => {
      scroller.removeEventListener("scroll", measure);
      scroller.removeEventListener("wheel", release);
      scroller.removeEventListener("touchmove", release);
      window.removeEventListener("keydown", release);
      window.removeEventListener("resize", measure);
    };
    // `key` stands for `ids`, which is a new array on every render.
  }, [key, root]);
  const pin = useCallback((id: string) => {
    pinned.current = true;
    setActive(id);
  }, []);
  return [active, pin];
}
