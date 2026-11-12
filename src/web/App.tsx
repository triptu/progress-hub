import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { MagnifyingGlassIcon, MoonIcon, SunIcon, WarningIcon } from "@phosphor-icons/react";
import type { FeedEntry, Health, HubState, NeedEntry, WorkId } from "../core/types.ts";
import { useDismissed } from "./lib/dismissed.ts";
import { describe, feedMatches, groupFeed, onceEach, shippedOf, shippedToday } from "./lib/feed.ts";
import { useMarks, useUnsavedMark } from "./lib/marks.ts";
import { byKind, mediaDays, mediaItems } from "./lib/media.ts";
import type { MediaItem, MediaKind } from "./lib/media.ts";
import { matches, needKey, needText } from "./lib/needs.ts";
import { usePersisted } from "./lib/persist.ts";
import { keepLooks, projectLooks, readKeptLooks } from "./lib/project.ts";
import { navigate, placeToReturnTo, routeHref, TABS, useRoute } from "./lib/route.ts";
import type { Tab } from "./lib/route.ts";
import { listenForChanges, useHub, useMedia, useReachable, useWork } from "./lib/store.ts";
import { useTheme } from "./lib/theme.ts";
import { clock, exact, isToday, useNow } from "./lib/time.ts";
import { isUnread, markSeen, useSeen } from "./lib/unread.ts";
import { splitWorks, workMatches } from "./lib/works.ts";
import { Board } from "./views/Board.tsx";
import { Empty } from "./views/Empty.tsx";
import { Feed } from "./views/Feed.tsx";
import { Artifacts, Media, Viewer } from "./views/Media.tsx";
import { Needs } from "./views/Needs.tsx";
import { Plan } from "./views/Plan.tsx";
import { Todos } from "./views/Todos.tsx";
import { todosFor } from "./lib/todos.ts";
import { Link, ProjectLooks } from "./views/parts.tsx";
import { Resizer, Sidebar } from "./views/Sidebar.tsx";
import { freshCount, Goal, WorkHead, WorkPage } from "./views/WorkPage.tsx";
import s from "./App.module.css";

const OK: Health = { ok: true };
const SIDE = { initial: 288, min: 240, max: 480 };
const NO_MEDIA: readonly MediaItem[] = [];

const readWidth = (stored: unknown) => (typeof stored === "number" && stored >= SIDE.min && stored <= SIDE.max ? stored : SIDE.initial);
const readOpen = (stored: unknown) => stored === true;

/** The first tab is everything about where you are: all ongoing work on Home, the whole page on a work. */
const TAB_LABEL: Record<Tab, string> = { main: "Ongoing", needs: "Needs you", todos: "Todos", "in-progress": "In progress", next: "Next up", shipped: "Shipped", activity: "Activity", media: "Media" };

export function App() {
  const route = useRoute();
  const hub = useHub();
  const workId = route.work;
  const detail = useWork(workId);
  const media = useMedia(route.tab === "media" || workId !== null);
  const now = useNow();
  const seen = useSeen();
  const dismissed = useDismissed();
  const viewed = useMarks("viewed");
  const [query, setQuery] = useState("");
  const [sideWidth, setSideWidth] = usePersisted("progress:side-width", readWidth);
  const [settledOpen, setSettledOpen] = usePersisted("progress:settled-open", readOpen);
  const app = useRef<HTMLDivElement>(null);
  const screen = useRef<HTMLElement>(null);
  const search = useRef<HTMLInputElement>(null);

  useEffect(listenForChanges, []);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const typing = event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement;
      if ((event.key === "/" && !typing) || (event.key === "k" && (event.metaKey || event.ctrlKey))) {
        event.preventDefault();
        search.current?.focus();
        search.current?.select();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const works = hub?.works ?? null;
  const { ongoing, settled } = useMemo(() => splitWorks(works ?? []), [works]);
  const settledIds = useMemo(() => new Set(settled.map((work) => work.id)), [settled]);
  const allNeeds = hub?.needs ?? [];
  // What still counts: on ongoing work, or from an agent no page claims.
  const isOpen = (entry: NeedEntry) => entry.work === null || !settledIds.has(entry.work);
  const openNeeds = allNeeds.filter(isOpen);
  useEffect(() => {
    document.title = openNeeds.length ? `(${openNeeds.length}) Progress` : "Progress";
  }, [openNeeds.length]);

  const summary = works?.find((work) => work.id === workId) ?? detail?.summary ?? null;
  // Read before the effect below records this visit, so the page can mark what is new since the last one.
  const seenBefore = useMemo(() => (workId ? (seen.works[workId] ?? seen.since) : seen.since), [workId]);
  useEffect(() => {
    if (summary) markSeen(summary.id, summary.lastChangeAt);
  }, [summary?.id, summary?.lastChangeAt]);

  const loaded = hub !== null && (workId === null || detail !== null);
  // Opening one of the media large keeps the grid where it was.
  const routeKey = routeHref({ work: route.work, tab: route.tab, focus: route.focus });
  useLayoutEffect(() => {
    for (const marked of screen.current?.querySelectorAll(".spot") ?? []) marked.classList.remove("spot");
    // Back and Forward return to where the screen was left. Run again once the data is in, when the page has its full height.
    const back = placeToReturnTo();
    if (back !== null) {
      screen.current?.scrollTo({ top: back });
      return;
    }
    if (workId !== null && route.tab === "main" && route.focus) {
      const target = screen.current?.querySelector(`[src="${CSS.escape(route.focus)}"], [src^="${CSS.escape(`${route.focus}?v=`)}"]`);
      if (target) {
        for (let fold = target.closest("details"); fold; fold = fold.parentElement?.closest("details") ?? null) fold.open = true;
        (target.closest(".fig") ?? target).classList.add("spot");
        target.scrollIntoView({ block: "center" });
        return;
      }
    }
    const target = route.tab === "needs" && route.focus ? document.getElementById(route.focus) : null;
    if (target) target.scrollIntoView({ block: "start" });
    else screen.current?.scrollTo({ top: 0 });
    // Scroll only when the screen changes, or once its data first arrives.
  }, [routeKey, loaded]);

  // On a narrow screen the tabs scroll sideways. The open one is always in view.
  useEffect(() => {
    document.querySelector(`.${s.tab}[aria-current="page"]`)?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [route.tab]);

  // One work's feed is whole. Home's is the newest of everything.
  const feed = (workId === null ? hub?.feed : detail?.feed) ?? [];
  const inScope = (entry: NeedEntry) => workId === null || entry.work === workId;
  const shownNeeds = allNeeds.filter((entry) => inScope(entry) && matches(query, needText(entry)));
  // An ask is still open while the hub lists it. One that has left its page shows in the feed as something that was asked.
  const openKeys = useMemo(() => new Set(allNeeds.filter(isOpen).map(needKey)), [allNeeds, settledIds]);
  const stillOpen = useCallback((entry: FeedEntry) => entry.event.kind === "added" && openKeys.has(`${entry.work}:${entry.event.item.id}`), [openKeys]);
  const activityDays = useMemo(() => groupFeed(onceEach(feed).filter((entry) => feedMatches(entry, query)), now, stillOpen), [feed, query, now, stillOpen]);
  const shipped = useMemo(() => shippedOf(feed), [feed]);
  const shippedDays = useMemo(() => groupFeed(shipped.filter((entry) => feedMatches(entry, query)), now), [shipped, query, now]);
  const today = useMemo(() => shippedToday(hub?.feed ?? [], now), [hub?.feed, now]);
  // What is in progress and what is planned: one work's on its tabs, and on Home every ongoing work's.
  const plan = useMemo(
    () => (hub?.plan ?? []).filter((entry) => (workId === null ? !settledIds.has(entry.work) : entry.work === workId) && matches(query, entry.workTitle, entry.project, entry.item === null ? `#${entry.pr.number} ${entry.pr.title}` : entry.item.title)),
    [hub?.plan, workId, settledIds, query],
  );
  const allMedia = useMemo(() => (media && works ? mediaItems(media, works, "") : null), [media, works]);
  const workMedia = useMemo(() => allMedia?.filter((item) => item.work === workId) ?? NO_MEDIA, [allMedia, workId]);
  const [mediaKinds, setMediaKinds] = useState<ReadonlySet<MediaKind>>(new Set());
  // What the Media tab holds: this screen's media, narrowed to the kinds picked there and then to what the search matches.
  // The kinds on offer come from the whole screen, so they stay put while the search narrows it.
  const listed = useMemo(() => {
    const all = workId === null ? allMedia : allMedia && workMedia;
    return all ? byKind(all, mediaKinds) : null;
  }, [allMedia, workMedia, workId, mediaKinds]);
  const shownMedia = useMemo(() => listed?.items.filter((item) => matches(query, item.label, item.workTitle, item.project)) ?? null, [listed, query]);
  // The viewer opens over whatever tab holds the tile, and closing it leaves the user there.
  const mediaHref = useCallback((open: string | null) => routeHref({ work: workId, tab: route.tab, open }), [workId, route.tab]);
  const moveMedia = useCallback((item: MediaItem) => navigate(mediaHref(item.src), true), [mediaHref]);
  const closeMedia = useCallback(() => navigate(mediaHref(null), true), [mediaHref]);
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
  const hasImportant = useMemo(() => onceEach(feed).some((entry) => describe(entry, stillOpen)?.weight === "high"), [feed, stillOpen]);
  const unread = (work: Parameters<typeof isUnread>[0]) => isUnread(work, seen);
  const unreadSources = useMemo(() => (hub?.sources ?? []).filter((source) => !source.health.ok).map((source) => source.label), [hub?.sources]);
  const noWork = works !== null && works.length === 0 && (hub?.home.ok ?? true);
  // On settled work every item is a leftover, and the dismissed ones no longer count.
  const scopedCount = allNeeds.filter((entry) => inScope(entry) && (isOpen(entry) || (workId !== null && !dismissed.has(needKey(entry))))).length;
  // Needs you carries a dot while something waits on the user.
  const waiting = summary?.settled ? 0 : workId === null ? openNeeds.length : scopedCount;
  // The user's own list: one work's on its tabs, everything on Home. The tab counts what is still to do.
  const todos = useMemo(() => todosFor(hub?.todos ?? [], works ?? [], workId, query), [hub?.todos, works, workId, query]);
  const allToDo = useMemo(() => (hub?.todos ?? []).filter((todo) => todo.doneAt === null).length, [hub?.todos]);
  const toDo = useMemo(() => todosFor(hub?.todos ?? [], works ?? [], workId, "").filter((todo) => todo.doneAt === null).length, [hub?.todos, works, workId]);
  const fresh = useMemo(() => freshCount(detail, seenBefore), [detail, seenBefore]);

  return (
    <ProjectLooks value={looks}>
      <div className="app" ref={app} style={{ "--side-w": `${sideWidth}px`, ...(summary ? { "--here": looks(summary.project ?? summary.id).colour } : {}) } as CSSProperties}>
        <Sidebar
          ongoing={works === null ? null : shownOngoing}
          settled={shownSettled}
          hasSettled={settled.length > 0}
          current={workId}
          searching={query.trim() !== ""}
          isUnread={unread}
          needs={openNeeds.length}
          todos={allToDo}
          settledOpen={settledOpen}
          onSettledOpen={setSettledOpen}
          now={now}
        />
        <Resizer width={sideWidth} {...SIDE} onPreview={(width) => app.current?.style.setProperty("--side-w", `${width}px`)} onCommit={setSideWidth} />
        <div className="main">
          <header className="topbar">
            <Link href={routeHref({ work: null, tab: route.tab })} className="brand">
              <span className="brand-mark" aria-hidden />
              progress
            </Link>
            <nav className={s.tabs} aria-label={workId === null ? "Home" : (summary?.title ?? "Work")}>
              {TABS.map((tab) => (
                <Link key={tab} href={routeHref({ work: workId, tab })} className={s.tab} current={route.tab === tab}>
                  {tab === "main" && workId !== null ? "All" : TAB_LABEL[tab]}
                  {tab === "needs" && waiting > 0 ? <span className={s.tabDot} role="img" aria-label={`${waiting} waiting`} title={`${waiting} waiting on you`} /> : null}
                  {tab === "todos" && toDo > 0 ? <span className="n">{toDo}</span> : null}
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
              <kbd aria-hidden>/</kbd>
            </label>
            <ThemeSwitch />
          </header>
          <Trouble home={hub?.home ?? OK} sources={hub?.sources ?? []} stores={hub?.stores ?? []} />
          <main className="screen" ref={screen}>
            {noWork ? <Empty /> : workId === null ? home() : work(workId)}
          </main>
          {viewer()}
        </div>
      </div>
    </ProjectLooks>
  );

  function home() {
    switch (route.tab) {
      case "main":
        return (
          <Board
            works={works === null ? null : shownOngoing}
            settled={shownSettled}
            needs={shownNeeds.filter(isOpen)}
            shipped={today.filter((entry) => feedMatches(entry, query))}
            query={query.trim()}
            isUnread={unread}
            viewed={viewed}
            now={now}
          />
        );
      case "needs":
        return (
          <Needs needs={shownNeeds.filter(isOpen)} settled={shownNeeds.filter((entry) => !isOpen(entry))} dismissed={dismissed} scoped={false} query={query} unread={unreadSources} sub="Across all ongoing work, oldest first" now={now} />
        );
      case "todos":
        return <Todos todos={todos} works={works ?? []} scope={null} query={query} sub="Yours, for later" />;
      case "in-progress":
        return (
          <Plan entries={plan.filter((entry) => entry.state === "doing")} scoped={false} tab="in-progress" empty={query ? `Nothing matches “${query}”.` : "No page lists anything as in progress, and no pull request is open."} title="In progress" sub="What each ongoing work is doing now" now={now} />
        );
      case "next":
        return (
          <Plan entries={plan.filter((entry) => entry.state === "next")} scoped={false} tab="next" empty={query ? `Nothing matches “${query}”.` : "No page lists anything under Next."} title="Next up" sub="What each ongoing work has planned, in the order its page lists it" now={now} />
        );
      case "shipped":
        return (
          <Feed days={shippedDays} only="shipped" tab="shipped" hasImportant={hasImportant} viewed={viewed} scoped={false} empty={query ? `Nothing matches “${query}”.` : "Nothing has shipped yet."} title="Shipped" sub="Across all work, newest first" now={now} />
        );
      case "activity":
        return (
          <Feed days={activityDays} tab="activity" hasImportant={hasImportant} viewed={viewed} scoped={false} empty={query ? `Nothing matches “${query}”.` : "Nothing has happened yet."} title="Activity" sub="What happened across all work, newest first" now={now} />
        );
      case "media":
        return mediaView(null);
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
    // A document opens in a tab of its own, so the viewer steps over it.
    const shown = (workId !== null && route.tab !== "media" ? workMedia : (shownMedia ?? [])).filter((item) => item.kind !== "file");
    const at = route.open === null ? -1 : shown.findIndex((item) => item.src === route.open);
    const item = shown[at];
    return item ? <Viewer item={item} prev={shown[at - 1] ?? null} next={shown[at + 1] ?? null} at={at + 1} of={shown.length} onMove={moveMedia} onClose={closeMedia} now={now} /> : null;
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
    const head = <WorkHead summary={summary} fresh={route.tab === "main" ? fresh : 0} now={now} />;
    const goal = <Goal html={detail?.summary.id === summary.id ? detail.body.goal : null} text={summary.goal} />;
    const mine = allNeeds.filter((entry) => entry.work === summary.id && !(summary.settled && dismissed.has(needKey(entry))));
    const artifacts = workMedia.some((item) => item.kind !== "image") ? <Artifacts items={workMedia} scope={summary.id} /> : null;
    switch (route.tab) {
      case "main":
        return (
          <div className="wrap">
            {head}
            <WorkPage key={summary.id} summary={summary} detail={detail} goal={goal} artifacts={artifacts} needs={mine} onDismiss={(key) => dismissed.dismiss([key])} media={workMedia} viewed={viewed} query={query} seenBefore={seenBefore} scroller={screen} now={now} />
          </div>
        );
      case "needs":
        return (
          <Needs needs={summary.settled ? [] : shownNeeds} settled={summary.settled ? shownNeeds : []} dismissed={dismissed} scoped query={query} unread={unreadSources} now={now}>
            {head}
            {goal}
          </Needs>
        );
      case "todos":
        return (
          <Todos todos={todos} works={works ?? []} scope={summary.id} query={query} lead={goal}>
            {head}
          </Todos>
        );
      case "in-progress":
        return (
          <Plan entries={plan.filter((entry) => entry.state === "doing")} scoped tab="in-progress" empty={query ? `Nothing matches “${query}”.` : "The page has no In progress section, and no pull request is open."} title="In progress" lead={goal} now={now}>
            {head}
          </Plan>
        );
      case "next":
        return (
          <Plan entries={plan.filter((entry) => entry.state === "next")} scoped tab="next" empty={query ? `Nothing matches “${query}”.` : "The page lists nothing under Next."} title="Next up" lead={goal} now={now}>
            {head}
          </Plan>
        );
      case "shipped":
        return (
          <Feed days={shippedDays} only="shipped" tab="shipped" hasImportant={hasImportant} viewed={viewed} scoped empty={query ? `Nothing matches “${query}”.` : "Nothing has shipped here yet."} title="Shipped" lead={goal} aside={artifacts} now={now}>
            {head}
          </Feed>
        );
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
    }
  }
}

/** Says so when the hub can't read what it shows. Nothing is drawn while all is well. */
function Trouble(props: { readonly home: Health; readonly sources: HubState["sources"]; readonly stores: HubState["stores"] }) {
  const reachable = useReachable();
  const unsaved = useUnsavedMark();
  const lines = [
    reachable ? null : { key: "hub", text: "Can't reach the hub. This is what it last sent.", reason: "" },
    unsaved ? { key: "mark", text: "The hub didn't save what you just marked, so it is shown as it was. Click it again.", reason: "" } : null,
    ...[
      { name: "the pages", health: props.home },
      ...props.sources.map((source) => ({ name: source.label, health: source.health })),
    ].map(({ name, health }) =>
      health.ok ? null : { key: name, text: `Can't read ${name} since ${isToday(health.since, Date.now()) ? clock(health.since) : exact(health.since)}. This is what was last read${name === "the pages" ? "" : ", and agents may have changed since"}.`, reason: health.reason },
    ),
    // Another machine that is off or asleep is no fault of the hub's: one quiet line says its work is as last heard.
    ...props.stores.map((store) => (store.health.ok ? null : { key: `store ${store.id}`, text: `Can't reach ${store.label}. Its work is shown as it last was.`, reason: store.health.reason })),
  ].filter((line) => line !== null);
  if (!lines.length) return null;
  return (
    <div className={s.trouble} role="status">
      <div className={s.troubleIn}>
        {lines.map((line) => (
          <p key={line.key} title={line.reason}>
            <WarningIcon weight="fill" aria-hidden />
            {line.text}
          </p>
        ))}
      </div>
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
