import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { DevicesIcon, MagnifyingGlassIcon, MoonIcon, SidebarSimpleIcon, SunIcon, WarningIcon, XIcon } from "@phosphor-icons/react";
import { planOf } from "../core/plan.ts";
import type { FeedEntry, Instant, NeedEntry, WorkId, WorkSummary } from "../core/types.ts";
import { cardMatches, freshness, needCard, planCards } from "./lib/board.ts";
import type { BoardCard } from "./lib/board.ts";
import { devicesOf } from "./lib/devices.ts";
import { useDismissed } from "./lib/dismissed.ts";
import { groupFeed, rowMatches, rowsOf, rowsSince } from "./lib/feed.ts";
import { useMarks, useUnsavedMark } from "./lib/marks.ts";
import { byKind, folderItems, mediaDays, mediaItems, opensInHub } from "./lib/media.ts";
import type { MediaItem, MediaKind } from "./lib/media.ts";
import { matches, needKey, needText } from "./lib/needs.ts";
import { usePersisted } from "./lib/persist.ts";
import { keepLooks, projectLooks, readKeptLooks } from "./lib/project.ts";
import { close, navigate, placeToReturnTo, routeHref, showMedia, TABS, useRoute } from "./lib/route.ts";
import type { Tab } from "./lib/route.ts";
import { listenForChanges, useChanges, useHub, useMedia, useReachable, useWork } from "./lib/store.ts";
import { changeDays } from "./lib/changes.ts";
import { useTheme } from "./lib/theme.ts";
import { useNow } from "./lib/time.ts";
import { BOARD_SEEN, CHANGES_SEEN, isUnread, markSeen, outcomesSeen, useSeen } from "./lib/unread.ts";
import { splitWorks, workMatches } from "./lib/works.ts";
import { Board } from "./views/Board.tsx";
import { Devices } from "./views/Devices.tsx";
import { Empty } from "./views/Empty.tsx";
import { Feed } from "./views/Feed.tsx";
import { Home } from "./views/Home.tsx";
import { Outcomes } from "./views/Outcomes.tsx";
import { Changes } from "./views/Changes.tsx";
import { Artifacts, Media, Viewer } from "./views/Media.tsx";
import { Todos } from "./views/Todos.tsx";
import { todosFor } from "./lib/todos.ts";
import { Link, ProjectLooks, Resizer } from "./views/parts.tsx";
import { Sidebar } from "./views/Sidebar.tsx";
import { Goal, WorkHead, WorkPage } from "./views/WorkPage.tsx";
import s from "./App.module.css";

const SIDE = { initial: 288, min: 240, max: 480 };
const NO_MEDIA: readonly MediaItem[] = [];
const NO_NEEDS: readonly NeedEntry[] = [];

const readWidth = (stored: unknown) => (typeof stored === "number" && stored >= SIDE.min && stored <= SIDE.max ? stored : SIDE.initial);
const readOpen = (stored: unknown) => stored === true;
const readShown = (stored: unknown) => stored !== false;

/** The tabs are the same for everything and for one work. Home is where each starts: every ongoing work, or the work's own page. */
const TAB_LABEL: Record<Tab, string> = { main: "Home", board: "Board", activity: "Activity", media: "Media", changes: "Key changes", outcomes: "Outcomes" };

const later = (a: Instant, b: Instant): Instant => (Date.parse(a) > Date.parse(b) ? a : b);
/** The latest of some times, or null with none. */
const latestOf = (times: readonly (Instant | undefined)[]): Instant | null => times.reduce<Instant | null>((a, b) => (b === undefined ? a : a === null ? b : later(a, b)), null);

export function App() {
  const route = useRoute();
  const hub = useHub();
  const workId = route.work;
  const detail = useWork(workId);
  // A screen that shows media asks for it at once. Any other asks once its own state is in, so a picture pressed on a card or in the feed opens without a wait.
  const media = useMedia(route.tab === "media" || workId !== null || route.open !== null || hub !== null);
  const now = useNow();
  const seen = useSeen();
  const dismissed = useDismissed();
  const reachable = useReachable();
  // The machines the hub shows work from and what the hub depends on. The bar's button says the worst of it.
  const devices = useMemo(() => devicesOf(hub, reachable), [hub, reachable]);
  // Asked for from the bar. It is about the whole hub, so it opens over whatever is on screen, not in its place.
  const [devicesOpen, setDevicesOpen] = useState(false);
  const viewed = useMarks("viewed");
  const [query, setQuery] = useState("");
  const [sideWidth, setSideWidth] = usePersisted("progress:side-width", readWidth);
  const [settledOpen, setSettledOpen] = usePersisted("progress:settled-open", readOpen);
  const [sideShown, setSideShown] = usePersisted("progress:side-shown", readShown);
  // A phone has no room for the sidebar beside the screen. There it is a drawer over it, opened to pick a work and gone once one is picked.
  const [drawer, setDrawer] = useState(false);
  const drawerSwitch = useRef<HTMLButtonElement>(null);
  useEffect(() => setDrawer(false), [route.work, route.tab]);
  useEffect(() => {
    if (!drawer) return;
    const main = document.querySelector<HTMLElement>(".main");
    if (main) main.inert = true;
    document.querySelector<HTMLElement>("#side a")?.focus({ preventScroll: true });
    const onKey = (event: KeyboardEvent) => (event.key === "Escape" ? setDrawer(false) : undefined);
    window.addEventListener("keydown", onKey);
    // Picking the work that is already open goes nowhere, and still closes the drawer.
    const side = document.getElementById("side");
    const onPick = (event: MouseEvent) => (event.target instanceof Element && event.target.closest("a") ? setDrawer(false) : undefined);
    side?.addEventListener("click", onPick);
    // A window made wide again has its sidebar back, and no drawer.
    const phone = matchMedia("(max-width: 760px)");
    const onWide = () => (phone.matches ? undefined : setDrawer(false));
    phone.addEventListener("change", onWide);
    return () => {
      window.removeEventListener("keydown", onKey);
      side?.removeEventListener("click", onPick);
      phone.removeEventListener("change", onWide);
      if (main) main.inert = false;
      drawerSwitch.current?.focus({ preventScroll: true });
    };
  }, [drawer]);
  // The slide is for the switch. A page that opens with the sidebar hidden just opens.
  const [sideMoved, setSideMoved] = useState(false);
  const toggleSide = useCallback(() => {
    setSideMoved(true);
    setSideShown(!sideShown);
  }, [sideShown, setSideShown]);
  const app = useRef<HTMLDivElement>(null);
  const screen = useRef<HTMLElement>(null);
  const search = useRef<HTMLInputElement>(null);

  useEffect(listenForChanges, []);
  // A picture in a page opens large over the hub, where it is, and not in a tab of its own, and so does a Markdown
  // document the hub lists. A click with a key held still opens the file.
  const listedDocs = useRef<ReadonlySet<string>>(new Set());
  useEffect(() => {
    const onClick = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const link = event.target instanceof Element ? event.target.closest("a[href]") : null;
      const src = link?.getAttribute("href")?.replace(/[?#].*$/, "") ?? "";
      if (!src.startsWith("/files/") || !(link?.matches(".fig") || listedDocs.current.has(src))) return;
      event.preventDefault();
      showMedia(src);
    };
    document.addEventListener("click", onClick);
    return () => document.removeEventListener("click", onClick);
  }, []);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const typing = event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement;
      // An open dialog has the keys.
      if (document.querySelector("dialog[open]")) return;
      if ((event.key === "/" && !typing) || (event.key === "k" && (event.metaKey || event.ctrlKey))) {
        event.preventDefault();
        search.current?.focus();
        search.current?.select();
      }
      if (event.key === "[" && !typing && !event.metaKey && !event.ctrlKey && !event.altKey) toggleSide();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggleSide]);

  // An ask the user marked done is off every list and every count. Its page still holds it, and the hub does not change a page.
  const allNeeds = hub?.needs ?? NO_NEEDS;
  const asks = useMemo(() => allNeeds.filter((entry) => !dismissed.has(needKey(entry))), [allNeeds, dismissed]);
  const works = useMemo(() => {
    if (!hub) return null;
    const waiting = new Map<WorkId, number>();
    for (const entry of asks) if (entry.work) waiting.set(entry.work, (waiting.get(entry.work) ?? 0) + 1);
    return hub.works.map((work): WorkSummary => ({ ...work, needsCount: waiting.get(work.id) ?? 0 }));
  }, [hub?.works, asks]);
  const { ongoing, settled } = useMemo(() => splitWorks(works ?? []), [works]);
  const settledIds = useMemo(() => new Set(settled.map((work) => work.id)), [settled]);
  // What still counts across everything: on ongoing work, or from an agent no page claims.
  const isOpen = (entry: NeedEntry) => entry.work === null || !settledIds.has(entry.work);
  const openNeeds = asks.filter(isOpen);
  useEffect(() => {
    document.title = openNeeds.length ? `(${openNeeds.length}) Progress` : "Progress";
  }, [openNeeds.length]);

  const summary = works?.find((work) => work.id === workId) ?? detail?.summary ?? null;
  // Read before the effects below record this visit, so the screen can mark what is new since the last one.
  const seenBefore = useMemo(() => (workId ? (seen.works[workId] ?? seen.since) : seen.since), [workId]);
  const onBoard = workId === null && route.tab === "board";
  const boardSeenBefore = useMemo(() => seen.works[BOARD_SEEN] ?? seen.since, [onBoard]);
  useEffect(() => {
    if (summary) markSeen(summary.id, summary.lastChangeAt);
  }, [summary?.id, summary?.lastChangeAt]);
  const newest = works?.[0]?.lastChangeAt;
  useEffect(() => {
    if (onBoard && newest) markSeen(BOARD_SEEN, newest);
  }, [onBoard, newest]);
  const onOutcomes = workId !== null && route.tab === "outcomes";
  const outcomesSeenBefore = useMemo(() => (workId ? (seen.works[outcomesSeen(workId)] ?? seen.since) : seen.since), [workId, onOutcomes]);

  // Key changes: the newest one here, across everything or in the open work, and the newest the tab had shown before this visit.
  const onChanges = route.tab === "changes";
  const newestChange = useMemo(() => latestOf((workId === null ? (works ?? []) : summary ? [summary] : []).map((work) => work.latestChange)), [works, summary, workId]);
  const changesSeenBefore = useMemo(() => seen.works[CHANGES_SEEN] ?? seen.since, [workId, onChanges]);
  const changesWaiting = newestChange !== null && Date.parse(newestChange) > Date.parse(seen.works[CHANGES_SEEN] ?? seen.since);
  const allChanges = useChanges(workId === null && onChanges);

  const loaded = hub !== null && (workId === null || detail !== null);
  // A work's Outcomes tab is there once it has readings, as its card says, and Key changes once there are some.
  const ownDetail = detail?.summary.id === workId ? detail : null;
  const tabs = TABS.filter((tab) => (tab !== "outcomes" || (summary?.outcomes ?? 0) > 0) && (tab !== "changes" || newestChange !== null));
  // Outcomes on a work with no readings, from an address typed or kept from before, is that work's Home, and so is Key changes with none.
  useEffect(() => {
    if (route.tab === "outcomes" && workId !== null && ownDetail && !ownDetail.outcomes?.length) navigate(routeHref({ work: workId, focus: null }), true);
    if (route.tab === "changes" && (workId === null ? works !== null : ownDetail !== null) && newestChange === null) navigate(routeHref({ work: workId, focus: null }), true);
  }, [route.tab, workId, ownDetail, works, newestChange]);
  // What the tab shows: everything's changes once they are in, or the open work's from its page.
  const shownChanges = useMemo(() => {
    if (!onChanges) return null;
    if (workId === null) return allChanges;
    return ownDetail ? (ownDetail.changes ?? []).map((change) => ({ ...change, work: ownDetail.summary.id, workTitle: ownDetail.summary.title, project: ownDetail.summary.project })) : null;
  }, [onChanges, workId, allChanges, ownDetail]);
  const changesDays = useMemo(() => (shownChanges ? changeDays(shownChanges, query, changesSeenBefore, now) : null), [shownChanges, query, changesSeenBefore, now]);
  // Seen only once shown, up to the newest change on screen: a filter that shows none marks nothing.
  const newestShown = useMemo(() => latestOf((changesDays ?? []).flatMap((day) => day.cards.map((card) => card.change.at))), [changesDays]);
  useEffect(() => {
    if (newestShown) markSeen(CHANGES_SEEN, newestShown);
  }, [newestShown]);
  // Opening one of the media large, or a card of the board, keeps the screen where it was.
  const routeKey = routeHref({ work: route.work, tab: route.tab, focus: route.focus });
  useLayoutEffect(() => {
    for (const marked of screen.current?.querySelectorAll(".spot") ?? []) marked.classList.remove("spot");
    // Back and Forward return to where the screen was left. Run again once the data is in, when the page has its full height.
    const back = placeToReturnTo();
    if (back !== null) {
      screen.current?.scrollTo({ top: back });
      return;
    }
    // A part of the screen by its name: the todos, a lane of the board.
    const named = route.focus ? document.getElementById(route.focus) : null;
    if (named) {
      named.scrollIntoView({ block: "start", inline: "start" });
      return;
    }
    if (route.tab === "main" && route.focus) {
      // On a work's Home, one of its media.
      const target = workId === null ? null : screen.current?.querySelector(`[src="${CSS.escape(route.focus)}"], [src^="${CSS.escape(`${route.focus}?v=`)}"]`);
      if (target) {
        for (let fold = target.closest("details"); fold; fold = fold.parentElement?.closest("details") ?? null) fold.open = true;
        (target.closest(".fig") ?? target).classList.add("spot");
        target.scrollIntoView({ block: "center" });
        return;
      }
    }
    screen.current?.scrollTo({ top: 0 });
    // Scroll only when the screen changes, or once its data first arrives.
  }, [routeKey, loaded]);

  // On a narrow screen the tabs scroll sideways. The open one is always in view.
  useEffect(() => {
    document.querySelector(`.${s.tab}[aria-current="page"]`)?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [route.tab]);

  // One work's feed is whole. Home's is the newest of everything.
  const feed = (workId === null ? hub?.feed : detail?.feed) ?? [];
  // An ask is still open while the hub lists it. One that has left its page shows in the feed as something that was asked.
  const openKeys = useMemo(() => new Set(allNeeds.filter(isOpen).map(needKey)), [allNeeds, settledIds]);
  const stillOpen = useCallback((entry: FeedEntry) => entry.event.kind === "added" && openKeys.has(`${entry.work}:${entry.event.item.id}`), [openKeys]);
  const rows = useMemo(() => rowsOf(feed, stillOpen), [feed, stillOpen]);
  const activityDays = useMemo(() => groupFeed(rows.filter((row) => rowMatches(row, query)), now), [rows, query, now]);
  const hasImportant = useMemo(() => rows.some((row) => row.line.weight === "high"), [rows]);
  // What the feed tells of the open work since it was last opened: the reason its dot was lit.
  const since = useMemo(() => (workId !== null && detail?.summary.id === workId ? rowsSince(rows, seenBefore) : []), [rows, workId, detail?.summary.id, seenBefore]);

  // The open work's plan, from its page, which has all it ever shipped. Null until the page has loaded.
  const workPlan = useMemo(() => (detail && detail.summary.id === workId ? planOf({ work: detail.summary.id, workTitle: detail.summary.title, project: detail.summary.project }, detail.body.sections, detail.pullRequests) : null), [detail, workId]);
  // The board's cards: across everything, what ongoing work holds; on a work, all of its own.
  const { cards, doneCards, asking } = useMemo(() => {
    const inScope = (entry: NeedEntry) => (workId === null ? isOpen(entry) : entry.work === workId);
    // Across everything, what the hub's state holds. On a work, its own plan once its page has loaded, and until then the part of it the state holds.
    const held = [...(hub?.plan ?? []), ...(hub?.shipped ?? [])];
    const plan = workId === null ? held.filter((entry) => !settledIds.has(entry.work)) : (workPlan ?? held.filter((entry) => entry.work === workId));
    const shown = (card: BoardCard) => cardMatches(card, query);
    return {
      // How many asks wait here, whatever the filter shows of them.
      asking: asks.filter(inScope).length,
      cards: [...asks.filter(inScope).map(needCard), ...planCards(plan)].filter(shown),
      doneCards: allNeeds.filter((entry) => inScope(entry) && dismissed.has(needKey(entry))).map(needCard).filter(shown),
    };
  }, [hub?.plan, hub?.shipped, workPlan, workId, asks, allNeeds, dismissed, settledIds, query]);
  // On a work a card is new since the work was last opened. Across everything it is new since the board was, or the work.
  const freshOf = useCallback(
    (card: BoardCard) => freshness(card.at, card.editedAt, workId !== null ? seenBefore : later(boardSeenBefore, (card.work && seen.works[card.work]) || seen.since)),
    [workId, seenBefore, boardSeenBefore, seen],
  );
  const boardHref = useCallback((card: string | null) => routeHref({ work: workId, tab: "board", card }), [workId]);
  const allMedia = useMemo(() => (media && works ? mediaItems(media, works, "") : null), [media, works]);
  listedDocs.current = useMemo(() => new Set((allMedia ?? []).filter((item) => item.kind === "folder" || (item.kind === "file" && opensInHub(item))).map((item) => item.src)), [allMedia]);
  const workMedia = useMemo(() => allMedia?.filter((item) => item.work === workId) ?? NO_MEDIA, [allMedia, workId]);
  const [mediaKinds, setMediaKinds] = useState<ReadonlySet<MediaKind>>(new Set());
  // What the Media tab holds: this screen's media, narrowed to the kinds picked there and then to what the search matches.
  // The kinds on offer come from the whole screen, so they stay put while the search narrows it.
  const listed = useMemo(() => {
    const all = workId === null ? allMedia : allMedia && workMedia;
    return all ? byKind(all, mediaKinds) : null;
  }, [allMedia, workMedia, workId, mediaKinds]);
  const shownMedia = useMemo(() => listed?.items.filter((item) => matches(query, item.label, item.workTitle, item.project)) ?? null, [listed, query]);
  // The viewer opens over whatever holds the picture, a tab or an open card, and closing it leaves the user there.
  const mediaHref = useCallback((open: string | null) => routeHref({ work: workId, tab: route.tab, card: route.card, open }), [workId, route.tab, route.card]);
  const moveMedia = useCallback((item: MediaItem) => navigate(mediaHref(item.src), true), [mediaHref]);
  const closeMedia = useCallback(() => close(mediaHref(null)), [mediaHref]);
  // A project keeps the icon and colour it was first given, so it reads as the same project every day.
  const [storedLooks, storeLooks] = usePersisted("progress:looks", readKeptLooks);
  const keptLooks = useMemo(() => keepLooks((works ?? []).map((work) => work.project ?? work.id), storedLooks), [works, storedLooks]);
  useEffect(() => {
    if (keptLooks !== storedLooks) storeLooks(keptLooks);
  }, [keptLooks, storedLooks, storeLooks]);
  const looks = useMemo(() => projectLooks(keptLooks), [keptLooks]);

  // The work being read stays in the sidebar whatever the filter says.
  const shownOngoing = ongoing.filter((work) => work.id === workId || workMatches(work, query));
  const shownSettled = settled.filter((work) => work.id === workId || workMatches(work, query));
  const unread = (work: Parameters<typeof isUnread>[0]) => isUnread(work, seen);
  const unreadSources = useMemo(() => (hub?.sources ?? []).filter((source) => !source.health.ok).map((source) => source.label), [hub?.sources]);
  const noWork = works !== null && works.length === 0 && (hub?.home.ok ?? true);
  // The board carries a dot while something waits on the user.
  const waiting = workId === null ? openNeeds.length : summary?.settled ? 0 : asks.filter((entry) => entry.work === workId).length;
  // The user's own list: one work's on its Home, everything on Home.
  const todos = useMemo(() => todosFor(hub?.todos ?? [], works ?? [], workId, query), [hub?.todos, works, workId, query]);
  const todoList = <Todos todos={todos} works={works ?? []} scope={workId} query={query} />;

  return (
    <ProjectLooks value={looks}>
      <div className="app" ref={app} data-side={sideShown ? undefined : "closed"} data-side-moved={sideMoved ? "" : undefined} data-drawer={drawer ? "" : undefined} style={{ "--side-w": `${sideWidth}px` } as CSSProperties}>
        <Sidebar ongoing={works === null ? null : shownOngoing} settled={shownSettled} hasSettled={settled.length > 0} shown={sideShown || drawer} current={workId} searching={query.trim() !== ""} isUnread={unread} needs={openNeeds.length} settledOpen={settledOpen} onSettledOpen={setSettledOpen} now={now} />
        {sideShown ? (
          <Resizer
            label="Sidebar width"
            edge="end"
            className={s.sideResizer}
            width={sideWidth}
            {...SIDE}
            onPreview={(width) => app.current?.style.setProperty("--side-w", `${width}px`)}
            onCommit={setSideWidth}
          />
        ) : null}
        {/* The sidebar's switch and the brand stand in the window's corner, whether the sidebar is there or not. */}
        <div className="corner">
          <button type="button" className="icon-btn" aria-expanded={sideShown} aria-controls="side" aria-label={sideShown ? "Hide the sidebar" : "Show the sidebar"} title={`${sideShown ? "Hide" : "Show"} the sidebar. Key: [`} onClick={toggleSide}>
            <SidebarSimpleIcon aria-hidden />
          </button>
          <Link href={routeHref({ work: null, tab: route.tab })} className="brand">
            <span className="brand-mark" aria-hidden />
            progress
          </Link>
        </div>
        {drawer ? <div className="drawer-scrim" onClick={() => setDrawer(false)} /> : null}
        <div className="main">
          <header className="topbar">
            <button ref={drawerSwitch} type="button" className="icon-btn drawer-switch" aria-expanded={drawer} aria-controls="side" aria-label="Show the list of work" title="Show the list of work" onClick={() => setDrawer(true)}>
              <SidebarSimpleIcon aria-hidden />
            </button>
            <Link href={routeHref({ work: null, tab: route.tab })} className="brand">
              <span className="brand-mark" aria-hidden />
              progress
            </Link>
            <nav className={s.tabs} aria-label={workId === null ? "Everything" : (summary?.title ?? "Work")}>
              {tabs.map((tab) => (
                <Link key={tab} href={routeHref({ work: workId, tab })} className={s.tab} current={route.tab === tab}>
                  {/* The dot hangs off the word's corner and takes no room, so a tab is as wide with it as without, and its word stays in the middle. */}
                  <span className={s.tabName}>
                    {TAB_LABEL[tab]}
                    {tab === "board" && waiting > 0 ? <span className={s.tabDot} role="img" aria-label={waiting === 1 ? "1 needs you" : `${waiting} need you`} title={waiting === 1 ? "1 needs you" : `${waiting} need you`} /> : null}
                    {tab === "changes" && changesWaiting && !onChanges ? <span className={s.tabDot} data-kind="new" role="img" aria-label="New since you last looked" title="New since you last looked" /> : null}
                  </span>
                </Link>
              ))}
            </nav>
            <label className={s.search}>
              <MagnifyingGlassIcon aria-hidden />
              <input
                ref={search}
                type="search"
                placeholder="Filter"
                aria-label="Filter what is on screen"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key !== "Escape") return;
                  setQuery("");
                  event.currentTarget.blur();
                }}
              />
              {query ? (
                <button
                  type="button"
                  className={s.searchClear}
                  aria-label="Clear the filter"
                  title="Clear the filter"
                  onClick={() => {
                    setQuery("");
                    search.current?.focus();
                  }}
                >
                  <XIcon aria-hidden />
                </button>
              ) : (
                <kbd aria-hidden>/</kbd>
              )}
            </label>
            {/* What can't be reached is said here, in a dot, and never in a line that takes room from the screen. */}
            <button type="button" className={`icon-btn ${s.devices}`} aria-haspopup="dialog" aria-expanded={devicesOpen} aria-label={devices.trouble ? `Devices. ${devices.trouble}` : "Devices"} title={devices.trouble ? `Devices. ${devices.trouble}` : "Devices"} onClick={() => setDevicesOpen(true)}>
              <DevicesIcon aria-hidden />
              {devices.worst === "ok" ? null : <span className={s.devicesDot} data-status={devices.worst} />}
            </button>
            <ThemeSwitch />
          </header>
          <main className="screen" ref={screen}>
            {noWork ? <Empty /> : workId === null ? home() : work(workId)}
          </main>
          {viewer()}
          <Unsaved />
          {devicesOpen ? <Devices devices={devices} loaded={hub !== null} now={now} onClose={() => setDevicesOpen(false)} /> : null}
        </div>
      </div>
    </ProjectLooks>
  );

  function board(head?: React.ReactNode) {
    return (
      <Board cards={cards} done={doneCards} asking={asking} scope={workId} loading={hub === null} whole={loaded} query={query.trim()} unread={unreadSources} freshOf={freshOf} viewed={viewed} dismissed={dismissed} open={route.card} hrefOf={boardHref} now={now}>
        {head}
      </Board>
    );
  }

  function home() {
    switch (route.tab) {
      case "main":
        return (
          <Home works={works === null ? null : shownOngoing} settled={shownSettled} needs={openNeeds} query={query.trim()} isUnread={unread} now={now}>
            {works === null ? null : todoList}
          </Home>
        );
      case "board":
        return board();
      case "activity":
        return (
          <Feed days={activityDays} tab="activity" hasImportant={hasImportant} viewed={viewed} scoped={false} empty={query ? `Nothing matches “${query}”.` : "Nothing has happened yet."} title="Activity" sub="What happened across all work, newest first" now={now} />
        );
      case "media":
        return mediaView(null);
      case "changes":
        return <Changes days={changesDays} query={query.trim()} scope={null} />;
      case "outcomes":
        // Only a work has one. An address for everything's never reaches here: it reads as Home.
        return null;
    }
  }

  function mediaView(head: React.ReactNode) {
    return (
      <Media days={shownMedia ? mediaDays(shownMedia, now) : null} kinds={listed?.kinds ?? []} chosen={mediaKinds} onChosen={setMediaKinds} query={query} scope={workId} sub="Images, videos, pages and documents from every work, newest first">
        {head}
      </Media>
    );
  }

  /** One of the media shown large, over the screen it was opened from, with its neighbours in that screen's list. */
  function viewer() {
    // On the Media tab the arrows step through what its filters show. Anywhere else they stay in the work the picture is from.
    // A document the hub can't show opens in a tab of its own, so the viewer steps over it.
    const from = route.tab === "media" || workId !== null ? null : (allMedia?.find((item) => item.src === route.open)?.work ?? null);
    const shown = (route.tab === "media" ? (shownMedia ?? []) : workId !== null ? workMedia : (allMedia ?? []).filter((item) => item.work === from)).filter(opensInHub);
    // A file opened from a folder steps through that folder's files.
    const folder = shown.some((item) => item.src === route.open) ? null : (allMedia ?? []).find((item) => item.kind === "folder" && item.files?.some((file) => file.src === route.open));
    const list = folder ? folderItems(folder).filter(opensInHub) : shown;
    const at = route.open === null ? -1 : list.findIndex((item) => item.src === route.open);
    const item = list[at];
    return item ? <Viewer item={item} prev={list[at - 1] ?? null} next={list[at + 1] ?? null} at={at + 1} of={list.length} onMove={moveMedia} onClose={closeMedia} now={now} /> : null;
  }

  function work(id: WorkId) {
    if (!summary) {
      return works === null ? null : (
        <div className="wrap">
          <p className="nothing">
            There's no work called “{id}”. <Link href={routeHref({ work: null, tab: route.tab })}>Go to Home</Link>
          </p>
        </div>
      );
    }
    const head = <WorkHead summary={summary} now={now} />;
    const goal = <Goal html={detail?.summary.id === summary.id ? detail.body.goal : null} text={summary.goal} />;
    const artifacts = workMedia.some((item) => item.kind !== "image") ? <Artifacts items={workMedia} scope={summary.id} /> : null;
    switch (route.tab) {
      case "main":
        return (
          <div className="wrap">
            {head}
            <WorkPage
              key={summary.id}
              summary={summary}
              detail={detail}
              plan={workPlan ?? []}
              goal={goal}
              artifacts={artifacts}
              todos={todoList}
              needs={asks.filter((entry) => entry.work === summary.id)}
              done={allNeeds.filter((entry) => entry.work === summary.id && dismissed.has(needKey(entry))).map(needKey)}
              dismissed={dismissed}
              since={since}
              viewed={viewed}
              query={query}
              seenBefore={seenBefore}
              scroller={screen}
              now={now}
            />
          </div>
        );
      case "board":
        return board(head);
      case "activity":
        return (
          <Feed days={activityDays} tab="activity" hasImportant={hasImportant} viewed={viewed} scoped empty={query ? `Nothing matches “${query}”.` : "Nothing has happened here yet."} title="Activity" lead={goal} aside={artifacts} now={now}>
            {head}
          </Feed>
        );
      case "media":
        return mediaView(
          <>
            {head}
            {goal}
          </>,
        );
      case "changes":
        return (
          <Changes days={changesDays} query={query.trim()} scope={summary.id}>
            {head}
            {goal}
          </Changes>
        );
      case "outcomes":
        return ownDetail?.outcomes?.length ? (
          <Outcomes key={summary.id} detail={ownDetail} seenBefore={outcomesSeenBefore} onSeen={(at) => markSeen(outcomesSeen(summary.id), at)} now={now}>
            {head}
            {goal}
          </Outcomes>
        ) : (
          <div className="wrap">
            {head}
            {goal}
          </div>
        );
    }
  }
}

/** A mark or a todo the hub didn't save is said over the screen's foot for a few seconds, since the change was undone. It takes no room. */
function Unsaved() {
  const unsaved = useUnsavedMark();
  return (
    <div className={s.notice} role="status">
      {unsaved ? (
        <p>
          <WarningIcon weight="fill" aria-hidden />
          Couldn't save that. Try again.
        </p>
      ) : null}
    </div>
  );
}

/** Light or dark. It follows the system until you pick the other one here. */
function ThemeSwitch() {
  const [theme, toggle] = useTheme();
  const other = theme === "dark" ? "light" : "dark";
  return (
    <button type="button" className={`icon-btn ${s.themeSwitch}`} aria-label={`Switch to the ${other} theme`} title={`Switch to the ${other} theme`} onClick={toggle}>
      {theme === "dark" ? <SunIcon aria-hidden /> : <MoonIcon aria-hidden />}
    </button>
  );
}
