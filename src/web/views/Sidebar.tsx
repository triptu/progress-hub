import { useRef } from "react";
import type { KeyboardEvent, PointerEvent } from "react";
import { CaretDownIcon, CaretRightIcon, HouseIcon } from "@phosphor-icons/react";
import type { WorkId, WorkSummary } from "../../core/types.ts";
import { routeHref, useRoute } from "../lib/route.ts";
import { useSignedIn } from "../lib/store.ts";
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
  /** Hidden by its switch: still there, slid out of the window, and nothing in it takes focus. */
  readonly shown: boolean;
  /** The open work, or null on Home. */
  readonly current: WorkId | null;
  readonly searching: boolean;
  readonly isUnread: (work: WorkSummary) => boolean;
  /** How many things need the user across ongoing work, shown on Home. */
  readonly needs: number;
  readonly settledOpen: boolean;
  readonly onSettledOpen: (open: boolean) => void;
  readonly now: number;
}

/** Everything on top, ongoing work under it, and settled work folded away at the bottom. */
export function Sidebar(props: SidebarProps) {
  const { ongoing, settled } = props;
  // A search opens the fold on what it found. Folded, the fold still shows the open work, alone, so the user sees where they are and can fold the rest away.
  const settledOpen = props.settledOpen || props.searching;
  const settledShown = settledOpen ? settled : settled.filter((work) => work.id === props.current);
  const { tab } = useRoute();
  const onHome = props.current === null;
  // Moving between everything and a work keeps the tab that is open.
  const home = routeHref({ work: null, tab });
  const signedIn = useSignedIn();
  return (
    <aside className="side" id="side" inert={!props.shown}>
      <div className="side-head" />
      <nav className={s.sideNav} aria-label="Work">
        <Link href={home} className={s.homeRow} current={onHome}>
          <span className={`avatar ${s.home}`} data-size="s">
            <HouseIcon weight={onHome ? "fill" : "regular"} aria-hidden />
          </span>
          <span className={s.rowTitle}>Everything</span>
          {props.needs > 0 ? (
            <span className="n" title={`${props.needs} ${props.needs === 1 ? "needs" : "need"} you`}>
              {props.needs}
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
          <section className={`${s.sideSettled}${settledShown.length > 0 ? ` ${s.open}` : ""}`}>
            <button type="button" className={s.sideLabel} aria-expanded={settledOpen} onClick={() => props.onSettledOpen(!props.settledOpen)}>
              <span>Settled</span>
              {settledOpen ? <CaretDownIcon weight="bold" aria-hidden /> : <CaretRightIcon weight="bold" aria-hidden />}
              <span className="n">{settled.length}</span>
            </button>
            {settledShown.length > 0 ? <Rows works={settledShown} dense {...props} /> : null}
          </section>
        ) : null}
      </nav>
      {/* A hub behind a sign-in, such as a central one, can be left. The hub answers with its sign-in page. */}
      {signedIn ? (
        <form method="post" action="/auth/signout" className={s.signOut}>
          <button type="submit" className={s.sideLabel}>
            Sign out
          </button>
        </form>
      ) : null}
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
