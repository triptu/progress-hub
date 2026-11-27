import { useEffect, useSyncExternalStore } from "react";
import type { HubState, Media, WorkDetail, WorkId } from "../../core/types.ts";
import type { WorkChange } from "../../core/changes.ts";
import { nameWorks } from "./route.ts";

/**
 * The hub's data, keyed by API path. Each path keeps the raw JSON it last received, so a refresh
 * that returns the same bytes changes nothing and nothing redraws.
 */

interface Entry {
  readonly raw: string;
  readonly value: unknown;
}

const entries = new Map<string, Entry>();
/** Paths this page has fetched itself, as opposed to ones it took over from the page before a reload. */
const fetched = new Set<string>();
const watched = new Map<string, number>();
const inflight = new Map<string, Promise<void>>();
const listeners = new Set<() => void>();
let reachable = true;

function emit() {
  for (const listener of listeners) listener();
}

const WORK = "/api/work/";

/**
 * Keeps what a path answered. The state says which works there are, which is what the addresses name them from.
 * A work asked for by the name in an address is kept under its id too, which is what the app asks by from then on.
 */
function keep(path: string, raw: string): void {
  const value: unknown = JSON.parse(raw);
  entries.set(path, { raw, value });
  if (path === "/api/state") nameWorks(((value as HubState).works ?? []).map((work) => work.id));
  if (path.startsWith(WORK)) {
    const own = `${WORK}${encodeURIComponent((value as WorkDetail).summary.id)}`;
    if (own !== path && !entries.has(own)) entries.set(own, { raw, value });
  }
}

/** Paths asked for again while a request was out. That answer may be older than the ask, so each is fetched once more. */
const stale = new Set<string>();

function refresh(path: string): Promise<void> {
  const running = inflight.get(path);
  if (running) {
    stale.add(path);
    return running.then(() => inflight.get(path));
  }
  const request = fetch(path)
    .then(async (response) => {
      if (response.status === 401) signedOut();
      if (!response.ok) throw new Error(`${path}: ${response.status}`);
      const raw = await response.text();
      const changed = entries.get(path)?.raw !== raw;
      if (changed) keep(path, raw);
      fetched.add(path);
      if (changed || !reachable) {
        reachable = true;
        emit();
      }
    })
    .catch(() => {
      if (reachable) {
        reachable = false;
        emit();
      }
    })
    .finally(() => {
      inflight.delete(path);
      if (stale.delete(path)) void refresh(path);
    });
  inflight.set(path, request);
  return request;
}

/**
 * The hub is behind a sign-in and this browser's session has ended: nothing it answered stays, in memory or in
 * the tab's storage, and a reload shows its sign-in page.
 */
function signedOut(): void {
  entries.clear();
  fetched.clear();
  try {
    sessionStorage.removeItem(KEPT);
  } catch {
    // No storage.
  }
  emit();
  location.reload();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function useResource<T>(path: string | null): T | null {
  useEffect(() => {
    if (!path) return;
    watched.set(path, (watched.get(path) ?? 0) + 1);
    void refresh(path);
    return () => {
      const count = (watched.get(path) ?? 1) - 1;
      if (count > 0) watched.set(path, count);
      else watched.delete(path);
    };
  }, [path]);
  return useSyncExternalStore(subscribe, () => (path ? ((entries.get(path)?.value as T | undefined) ?? null) : null));
}

export const useHub = () => useResource<HubState>("/api/state");

/** Whether this hub is behind a sign-in, so the app offers a way to sign out. */
export const useSignedIn = () => useHub()?.signedIn === true;

/**
 * Fetches what the first screen shows before anything is drawn, so it is drawn once, whole, with nothing
 * arriving later to push the rest down. The hub answers in milliseconds; a hub that doesn't is not waited for.
 */
export function prime(paths: readonly string[], patience = 1500): Promise<void> {
  return Promise.race([Promise.all(paths.map(refresh)).then(() => undefined), new Promise<void>((resolve) => setTimeout(resolve, patience))]);
}

/** The app's own script, as the hub's page names it: a new build has a new name. */
const scriptOf = (html: string) => /<script[^>]+src="([^"]+)"/.exec(html)?.[1]?.split("/").pop() ?? null;

const KEPT = "progress:on-screen";

/**
 * A reload draws the screen from what this tab was showing, so the page never goes blank while the hub
 * is asked again. `takeOver` says whether every one of `paths` was there; the hub is still asked, and
 * its answer replaces what was taken over.
 *
 * Only the same build's data is taken over, since another build may shape it differently. And a page
 * hands on only what it fetched itself: if what it took over ever failed to draw, the reload after
 * starts from the hub instead of from the same data.
 */
export function takeOver(paths: readonly string[]): boolean {
  const app = scriptOf(document.documentElement.outerHTML);
  addEventListener("pagehide", () => {
    // A hub behind a sign-in keeps its answers to the browser's session, never in the tab's storage.
    if ((entries.get("/api/state")?.value as HubState | undefined)?.signedIn) return;
    try {
      sessionStorage.setItem(KEPT, JSON.stringify({ app, raw: Object.fromEntries([...watched.keys()].filter((path) => fetched.has(path)).map((path) => [path, entries.get(path)?.raw])) }));
    } catch {
      // No room, or no storage. The next load asks the hub first, as a new tab does.
    }
  });
  try {
    const kept = JSON.parse(sessionStorage.getItem(KEPT) ?? "null") as { app?: unknown; raw?: Record<string, unknown> } | null;
    sessionStorage.removeItem(KEPT);
    if (app === null || kept?.app !== app) return false;
    for (const [path, raw] of Object.entries(kept.raw ?? {})) if (typeof raw === "string") keep(path, raw);
  } catch {
    return false;
  }
  return paths.every((path) => entries.has(path));
}

/** Fetches the state now, and resolves once an answer newer than this call has arrived. */
export const refreshHub = () => refresh("/api/state");

/** Every work's key changes, newest first, asked for only while a screen shows them. */
export const useChanges = (wanted: boolean) => useResource<WorkChange[]>(wanted ? "/api/changes" : null);

export const useWork = (id: WorkId | null) => useResource<WorkDetail>(id ? `/api/work/${encodeURIComponent(id)}` : null);

/** False after a request to the hub failed, until one succeeds. */
export const useReachable = () => useSyncExternalStore(subscribe, () => reachable);

/** Refetches everything on screen whenever the server says state changed, and after a reconnect. */
export function listenForChanges(): () => void {
  const events = new EventSource("/api/events");
  const refreshWatched = () => {
    for (const path of watched.keys()) void refresh(path);
  };
  // The stream breaks when the hub restarts, which it does after an install. A tab left open then runs the
  // old app against the new hub, so once the stream is back it checks for a newer app and loads it.
  let dropped = false;
  events.addEventListener("open", () => {
    if (dropped) void loadNewerApp();
    dropped = false;
    refreshWatched();
  });
  events.addEventListener("message", refreshWatched);
  events.addEventListener("error", () => {
    dropped = true;
    if (reachable) {
      reachable = false;
      emit();
    }
  });
  return () => events.close();
}

async function loadNewerApp(): Promise<void> {
  const running = scriptOf(document.documentElement.outerHTML);
  const served = await fetch("/", { cache: "no-store" })
    .then((response) => (response.ok ? response.text() : null))
    .catch(() => null);
  const latest = served === null ? null : scriptOf(served);
  // A reload keeps the screen and where it was scrolled, so the newer app takes over in place.
  if (running !== null && latest !== null && running !== latest) location.reload();
}

/** Every work's media. Fetched only while `on`, so the state stays small. */
export const useMedia = (on: boolean) => useResource<readonly Media[]>(on ? "/api/media" : null);
