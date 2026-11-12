import { useSyncExternalStore } from "react";
import type { MouseEvent } from "react";
import type { WorkId } from "../../core/types.ts";

/** The tabs, in order. They are the same for Home and for one work, which only narrows what each shows. */
export const TABS = ["main", "needs", "todos", "in-progress", "next", "shipped", "activity", "media"] as const;
export type Tab = (typeof TABS)[number];

/**
 * Where the user is: Home (`work` is null) or one work, and which tab of it.
 * Paths are `/`, `/needs`, `/todos`, `/in-progress`, `/next`, `/shipped`, `/activity`, `/media`, and the same under `/w/<work>`.
 * `focus` is the `#` part: a Needs you item to scroll to, or on a work's page one of its media.
 * `open` is the media shown large, as `?open=<src>`.
 */
interface Route {
  readonly work: WorkId | null;
  readonly tab: Tab;
  readonly focus: string | null;
  readonly open: string | null;
}

const isTab = (value: string): value is Tab => TABS.some((tab) => tab === value);

export function parseRoute(url: URL): Route {
  const parts = url.pathname.split("/").filter(Boolean);
  const inWork = parts[0] === "w" && parts[1] !== undefined;
  const tab = (inWork ? parts[2] : parts[0]) ?? "main";
  return {
    work: inWork ? (decodeURIComponent(parts[1] ?? "") as WorkId) : null,
    tab: isTab(tab) ? tab : "main",
    focus: url.hash ? decodeURIComponent(url.hash.slice(1)) : null,
    open: url.searchParams.get("open"),
  };
}

export function routeHref(route: { readonly work: WorkId | null; readonly tab?: Tab; readonly focus?: string | null; readonly open?: string | null }): string {
  const base = route.work === null ? "" : `/w/${encodeURIComponent(route.work)}`;
  const tab = route.tab && route.tab !== "main" ? `/${route.tab}` : "";
  const open = route.open ? `?open=${encodeURIComponent(route.open)}` : "";
  const focus = route.focus ? `#${encodeURIComponent(route.focus)}` : "";
  return `${base}${tab || (base ? "" : "/")}${open}${focus}`;
}

const listeners = new Set<() => void>();
let current = parseRoute(new URL(location.href));

function sync() {
  current = parseRoute(new URL(location.href));
  for (const listener of listeners) listener();
}

/**
 * Where each history entry was scrolled to when it was left, so Back, Forward and a reload return to the
 * same place. Entries are numbered in `history.state`, and the places are kept for the tab's lifetime.
 */
const entryOf = (state: unknown): number => (typeof state === "object" && state !== null && "entry" in state && typeof state.entry === "number" ? state.entry : 0);
const PLACES = "progress:places";
const places = new Map<number, number>(readPlaces());
let entry = entryOf(history.state);
let newest = Math.max(entry, ...places.keys());
let place: number | null = places.get(entry) ?? null;

function readPlaces(): [number, number][] {
  try {
    const stored: unknown = JSON.parse(sessionStorage.getItem(PLACES) ?? "[]");
    return Array.isArray(stored) ? stored.filter((pair): pair is [number, number] => Array.isArray(pair) && typeof pair[0] === "number" && typeof pair[1] === "number") : [];
  } catch {
    return [];
  }
}

// A reload, or the tab going away: note where the screen is, and keep the places for when it comes back.
window.addEventListener("pagehide", () => {
  leave();
  try {
    sessionStorage.setItem(PLACES, JSON.stringify([...places].slice(-50)));
  } catch {
    // No room, or storage is off. The page then opens at its top.
  }
});

function leave() {
  const screen = document.querySelector(".screen");
  if (screen) places.set(entry, screen.scrollTop);
}

window.addEventListener("popstate", () => {
  leave();
  entry = entryOf(history.state);
  place = places.get(entry) ?? null;
  sync();
});

export function navigate(href: string, replace = false) {
  if (href === location.pathname + location.search + location.hash) return;
  if (replace) {
    history.replaceState(history.state, "", href);
  } else {
    leave();
    entry = ++newest;
    place = null;
    history.pushState({ entry }, "", href);
  }
  sync();
}

/** Where the screen was scrolled to when the history entry now showing was last left. Null for one just opened. */
export const placeToReturnTo = () => place;

export function useRoute(): Route {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => current,
  );
}

/** Lets a plain `<a href>` move through history, while modifier clicks still open a new tab. */
export function followLink(event: MouseEvent<HTMLAnchorElement>) {
  if (event.defaultPrevented || event.button !== 0) return;
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  const target = event.currentTarget;
  if (target.target || target.origin !== location.origin) return;
  event.preventDefault();
  navigate(target.pathname + target.search + target.hash);
}
