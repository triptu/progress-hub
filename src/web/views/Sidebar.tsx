import { useRef } from "react";
import type { KeyboardEvent, PointerEvent } from "react";
import { CaretDownIcon, CaretRightIcon, HouseIcon, ListChecksIcon } from "@phosphor-icons/react";
import type { WorkId, WorkSummary } from "../../core/types.ts";
import { routeHref, useRoute } from "../lib/route.ts";
import { phaseOf } from "../lib/works.ts";
import { Avatar, Link, When } from "./parts.tsx";
import s from "./Sidebar.module.css";

const WEEK = 7 * 24 * 60 * 60 * 1000;

interface SidebarProps {
  /** Null while the first load is on its way. */
  readonly ongoing: readonly WorkSummary[] | null;
  readonly settled: readonly WorkSummary[];
  /** Any work is settled, whether or not the filter shows it. */
  readonly hasSettled: boolean;
  /** The open work, or null on Home. */
  readonly current: WorkId | null;
  readonly searching: boolean;
  readonly isUnread: (work: WorkSummary) => boolean;
  /** How many things need the user across ongoing work, shown on Home. */
  readonly needs: number;
  /** How many of the user's todos are still to do, shown on Todos. */
  readonly todos: number;
  readonly settledOpen: boolean;
  readonly onSettledOpen: (open: boolean) => void;
  readonly now: number;
}

/** Home on top, ongoing work under it, and settled work folded away at the bottom. */
export function Sidebar(props: SidebarProps) {
  const { ongoing, settled } = props;
  const holdsCurrent = settled.some((work) => work.id === props.current);
  // A search and the open work both show through the fold.
  const settledOpen = props.settledOpen || props.searching || holdsCurrent;
  const { tab } = useRoute();
  // The user's whole list has a row of its own under Home, so it is one click from anywhere.
  const onTodos = props.current === null && tab === "todos";
  const onHome = props.current === null && !onTodos;
  // Moving between Home and a work keeps the tab that is open. From Todos, Home is Home's first tab, since Todos has its own row.
  const home = routeHref({ work: null, tab: tab === "todos" ? "main" : tab });
  return (
    <aside className="side">
      <Link href={home} className="brand">
        <span className="brand-mark" aria-hidden />
        progress
      </Link>
      <nav className={s.sideNav} aria-label="Work">
        <Link href={home} className={s.homeRow} current={onHome}>
          <span className={`avatar ${s.home}`} data-size="s">
            <HouseIcon weight={onHome ? "fill" : "regular"} aria-hidden />
          </span>
          <span className={s.rowTitle}>Home</span>
          {props.needs > 0 ? (
            <span className="n" title={`${props.needs} ${props.needs === 1 ? "needs" : "need"} you`}>
              {props.needs}
            </span>
          ) : null}
        </Link>
        <Link href={routeHref({ work: null, tab: "todos" })} className={`${s.homeRow} ${s.todosRow}`} current={onTodos}>
          <span className={`avatar ${s.home}`} data-size="s">
            <ListChecksIcon weight={onTodos ? "bold" : "regular"} aria-hidden />
          </span>
          <span className={s.rowTitle}>Todos</span>
          {props.todos > 0 ? (
            <span className="n" title={`${props.todos} still to do`}>
              {props.todos}
            </span>
          ) : null}
        </Link>
        <div className={s.sideList}>
          <p className={s.sideLabel}>
            <span>Ongoing</span>
            <span className="n">{ongoing?.length ?? ""}</span>
          </p>
          {ongoing === null ? (
            <ul aria-hidden>
              {[0, 1, 2].map((n) => (
                <li key={n} className={`${s.row} ${s.ghost}`} />
              ))}
            </ul>
          ) : ongoing.length === 0 ? (
            <p className={s.sideEmpty}>{props.searching ? "Nothing matches." : "Nothing is going on."}</p>
          ) : (
            <Rows works={ongoing} {...props} />
          )}
        </div>
        {props.hasSettled ? (
          <section className={`${s.sideSettled}${settledOpen ? ` ${s.open}` : ""}`}>
            <button type="button" className={s.sideLabel} aria-expanded={settledOpen} onClick={() => props.onSettledOpen(!props.settledOpen)}>
              <span>Settled</span>
              {settledOpen ? <CaretDownIcon weight="bold" aria-hidden /> : <CaretRightIcon weight="bold" aria-hidden />}
              <span className="n">{settled.length}</span>
            </button>
            {settledOpen ? <Rows works={settled} dense {...props} /> : null}
          </section>
        ) : null}
      </nav>
    </aside>
  );
}

/** `dense` is for settled work: one short line each, so many fit and the list reads as a log of what was done. */
function Rows(props: SidebarProps & { readonly works: readonly WorkSummary[]; readonly dense?: boolean }) {
  return (
    <ul>
      {props.works.map((work) => (
        <li key={work.id}>
          <Row work={work} on={work.id === props.current} unread={props.isUnread(work)} dense={props.dense ?? false} now={props.now} />
        </li>
      ))}
    </ul>
  );
}

function Row(props: { readonly work: WorkSummary; readonly on: boolean; readonly unread: boolean; readonly dense: boolean; readonly now: number }) {
  const { work } = props;
  const phase = phaseOf(work);
  const stale = phase === "idle" && props.now - Date.parse(work.lastChangeAt) > WEEK;
  const { tab } = useRoute();
  return (
    <Link href={routeHref({ work: work.id, tab })} className={`${s.row}${props.dense ? ` ${s.dense}` : ""}${props.unread ? ` ${s.unread}` : ""}${stale || phase === "settled" ? ` ${s.stale}` : ""}`} current={props.on} title={work.title}>
      <Avatar project={work.project} fallback={work.id} work={work} size={props.dense ? "xs" : "s"} />
      <span className={s.rowTitle}>{work.title}</span>
      {/* Which project it belongs to: short, steady, and never cut mid-sentence. */}
      {(work.project || work.machine) && !props.dense ? <span className={s.rowSub}>{[work.project, work.machine].filter(Boolean).join(" · ")}</span> : null}
      <span className={s.rowEnd}>
        {props.unread ? <span className="unread-dot" role="img" aria-label="Changed since you last opened it" /> : null}
        <When at={work.lastChangeAt} now={props.now} />
      </span>
    </Link>
  );
}

/** The sidebar's right edge. Drag it, or use the arrow keys, to set the width; a double click puts it back. */
export function Resizer(props: { readonly width: number; readonly min: number; readonly max: number; readonly initial: number; readonly onPreview: (width: number) => void; readonly onCommit: (width: number) => void }) {
  const dragging = useRef(false);
  const clamp = (width: number) => Math.round(Math.min(props.max, Math.max(props.min, width)));
  const move = (event: PointerEvent<HTMLDivElement>) => {
    if (dragging.current) props.onPreview(clamp(event.clientX));
  };
  const end = (event: PointerEvent<HTMLDivElement>) => {
    if (!dragging.current) return;
    dragging.current = false;
    event.currentTarget.releasePointerCapture(event.pointerId);
    props.onCommit(clamp(event.clientX));
  };
  const key = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = event.key === "ArrowLeft" ? -16 : event.key === "ArrowRight" ? 16 : 0;
    if (!step) return;
    event.preventDefault();
    props.onCommit(clamp(props.width + step));
  };
  return (
    <div
      className={s.resizer}
      role="separator"
      aria-orientation="vertical"
      aria-label="Sidebar width"
      aria-valuenow={props.width}
      aria-valuemin={props.min}
      aria-valuemax={props.max}
      tabIndex={0}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        dragging.current = true;
        event.currentTarget.setPointerCapture(event.pointerId);
        event.preventDefault();
      }}
      onPointerMove={move}
      onPointerUp={end}
      onPointerCancel={end}
      onDoubleClick={() => props.onCommit(props.initial)}
      onKeyDown={key}
    />
  );
}
