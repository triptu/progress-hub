import { useSyncExternalStore } from "react";
import type { MouseEvent } from "react";
import { workNames, type WorkNames } from "../../core/names.ts";
import type { WorkId } from "../../core/types.ts";

/** The id of the todos on a Home screen, which is where a link to them scrolls. */
export const TODOS_ANCHOR = "todos";

/** The tabs, in order. They are the same for everything and for one work, which only narrows what each shows. */
export const TABS = ["main", "board", "activity", "media"] as const;
export type Tab = (typeof TABS)[number];

/**
 * Where the user is: everything (`work` is null) or one work, and which tab of it.
 * Paths are `/`, `/board`, `/activity`, `/media`, and the same under `/w/<work>`.
 * `focus` is the `#` part: on a work's Home one of its media or a section, to scroll to.
 * `card` is the board's card shown in full, as `?card=<key>`, and `open` the media shown large over whatever is on screen, as `?open=<src>`.
 */
interface Route {
  readonly work: WorkId | null;
  readonly tab: Tab;
  readonly focus: string | null;
  readonly open: string | null;
  readonly card: string | null;
}

const isTab = (value: string): value is Tab => TABS.some((tab) => tab === value);

/** The name each work the hub shows has in an address. Empty until the hub's state is in, when a name is taken as an id. */
let names: WorkNames = workNames([]);

/** The id of a lane of the board, which is where a link to it scrolls. */
export const laneAnchor = (lane: string) => `lane-${lane}`;

/** Where the tabs of earlier builds went, so an old link still lands on what it showed. */
const MOVED: Readonly<Record<string, { readonly tab: Tab; readonly focus: string }>> = {
  needs: { tab: "board", focus: laneAnchor("needs") },
  "in-progress": { tab: "board", focus: laneAnchor("doing") },
  next: { tab: "board", focus: laneAnchor("next") },
  shipped: { tab: "board", focus: laneAnchor("shipped") },
  todos: { tab: "main", focus: TODOS_ANCHOR },
};

export function parseRoute(url: URL): Route {
  const parts = url.pathname.split("/").filter(Boolean);
  const inWork = parts[0] === "w" && parts[1] !== undefined;
  const tab = (inWork ? parts[2] : parts[0]) ?? "main";
  const moved = MOVED[tab];
  return {
    work: inWork ? named(decodeURIComponent(parts[1] ?? "")) : null,
    tab: isTab(tab) ? tab : (moved?.tab ?? "main"),
    focus: url.hash ? decodeURIComponent(url.hash.slice(1)) : (moved?.focus ?? null),
    open: url.searchParams.get("open"),
    card: url.searchParams.get("card"),
  };
}

/** The work a name in an address stands for. An id is taken as it is, so an address of an earlier build still opens. */
const named = (name: string): WorkId => names.idOf.get(name) ?? (name as WorkId);

export function routeHref(route: { readonly work: WorkId | null; readonly tab?: Tab; readonly focus?: string | null; readonly open?: string | null; readonly card?: string | null }): string {
  const base = route.work === null ? "" : `/w/${encodeURIComponent(names.nameOf.get(route.work) ?? route.work)}`;
  const tab = route.tab && route.tab !== "main" ? `/${route.tab}` : "";
  const shown = [route.card ? `card=${encodeURIComponent(route.card)}` : "", route.open ? `open=${encodeURIComponent(route.open)}` : ""].filter(Boolean).join("&");
  const focus = route.focus ? `#${encodeURIComponent(route.focus)}` : "";
  return `${base}${tab || (base ? "" : "/")}${shown ? `?${shown}` : ""}${focus}`;
}

const listeners = new Set<() => void>();
let current = parseRoute(new URL(location.href));
// An address of an earlier build is rewritten as where it landed, so what is copied from the bar is the new one.
if (location.pathname.split("/").some((part) => part in MOVED)) history.replaceState(history.state, "", routeHref(current));

function sync() {
  current = parseRoute(new URL(location.href));
  for (const listener of listeners) listener();
}

/**
 * Tells the addresses which works the hub shows. The address on screen is read again, since a name in it may now
 * stand for a work, and an address that carries an id is rewritten as the work's name.
 */
export function nameWorks(ids: readonly WorkId[]): void {
  names = workNames(ids);
  const next = parseRoute(new URL(location.href));
  const shown = decodeURIComponent(location.pathname.split("/").filter(Boolean)[1] ?? "");
  if (next.work !== null && shown !== (names.nameOf.get(next.work) ?? next.work)) history.replaceState(history.state, "", routeHref(next));
  if (next.work !== current.work) {
    current = next;
    for (const listener of listeners) listener();
  }
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

const here = () => location.pathname + location.search + location.hash;
/** Where a history entry was opened from, which it carries, so closing what it opened can be a step back, also after a reload. */
const openedFrom = (state: unknown): string | null => (typeof state === "object" && state !== null && "from" in state && typeof state.from === "string" ? state.from : null);

export function navigate(href: string, replace = false) {
  if (href === here()) return;
  if (replace) {
    history.replaceState(history.state, "", href);
  } else {
    leave();
    const from = here();
    entry = ++newest;
    place = null;
    history.pushState({ entry, from }, "", href);
  }
  sync();
}

/**
 * Closes what is open over a screen, such as a card of the board, and shows `href`, the screen without it.
 * When it was opened from that very screen, this is a step back, so Back does not open it again.
 */
export function close(href: string) {
  if (openedFrom(history.state) === href) history.back();
  else navigate(href, true);
}

/** Shows one of the media large, over whatever is on screen now: a tab, or a card open on the board. */
export const showMedia = (src: string) => navigate(routeHref({ work: current.work, tab: current.tab, card: current.card, open: src }));

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
