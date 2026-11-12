import { CaretRightIcon, HandPalmIcon } from "@phosphor-icons/react";
import type { FeedEntry, NeedEntry, WorkId, WorkSummary } from "../../core/types.ts";
import { describe, shippedWords } from "../lib/feed.ts";
import { toView } from "../lib/marks.ts";
import type { MarkSet } from "../lib/marks.ts";
import { needKey, needSince, needTitle, needWhere } from "../lib/needs.ts";
import { routeHref } from "../lib/route.ts";
import { plural } from "../lib/works.ts";
import { Ago, Avatar, Link, PhasePill, TryLinks, ViewHead, When } from "./parts.tsx";
import s from "./Board.module.css";

interface BoardProps {
  /** Ongoing work. Null while the first load is on its way. */
  readonly works: readonly WorkSummary[] | null;
  /** Settled work, listed under the board where there is no sidebar to hold it. */
  readonly settled: readonly WorkSummary[];
  /** What needs the user across ongoing work, oldest first. */
  readonly needs: readonly NeedEntry[];
  /** What shipped today, newest first. */
  readonly shipped: readonly FeedEntry[];
  /** A filter is on, so an empty list means nothing matches it. */
  readonly query: string;
  readonly isUnread: (work: WorkSummary) => boolean;
  /** What the user marked as viewed. Those lines are quieter in Shipped today. */
  readonly viewed: MarkSet;
  readonly now: number;
}

const RAIL_ROWS = 6;

/** Home: the numbers that matter, then each ongoing work with where it stands and how far along it is. */
export function Board(props: BoardProps) {
  const { works, needs, shipped } = props;
  const loading = works === null;
  // Every ongoing work with something to open, in one place.
  const running = (works ?? []).filter((work) => work.links.length > 0);
  const firstNeed = new Map<WorkId, NeedEntry>();
  for (const entry of needs) if (entry.work && !firstNeed.has(entry.work)) firstNeed.set(entry.work, entry);

  return (
    <div className={`wrap ${s.board}`}>
      <div className={s.boardMain}>
        <ViewHead title="Ongoing" />
        {loading ? (
          <ul className={s.cards} aria-hidden>
            {[0, 1].map((n) => (
              <li key={n} className={`${s.card} ${s.ghost}`} />
            ))}
          </ul>
        ) : works.length === 0 ? (
          <p className="nothing">{props.query ? `Nothing matches “${props.query}”.` : "Nothing is going on. Finished work is under Settled."}</p>
        ) : (
          <ul className={s.cards}>
            {works.map((work) => (
              <li key={work.id}>
                <Card work={work} unread={props.isUnread(work)} need={firstNeed.get(work.id) ?? null} now={props.now} />
              </li>
            ))}
          </ul>
        )}
        {props.settled.length ? (
          <details className={`fold ${s.boardSettled}`}>
            <summary>
              <CaretRightIcon weight="bold" aria-hidden />
              <span>
                Settled <span className="n">{props.settled.length}</span>
              </span>
            </summary>
            <ul>
              {props.settled.map((work) => (
                <li key={work.id}>
                  <Link href={routeHref({ work: work.id })} className={s.miniWork}>
                    <Avatar project={work.project} fallback={work.id} work={work} size="s" />
                    <span className={s.miniTitle}>{work.title}</span>
                    <When at={work.lastChangeAt} now={props.now} />
                  </Link>
                </li>
              ))}
            </ul>
          </details>
        ) : null}
      </div>
      <aside className={s.boardRail}>
        {needs.length > 0 ? (
          <section className={`${s.block} ${s.needs}`}>
            <BlockHead title="Needs you" count={loading ? null : needs.length} href={routeHref({ work: null, tab: "needs" })} />
              <ul>
              {needs.slice(0, RAIL_ROWS).map((entry) => (
                <li key={needKey(entry)}>
                  <Link href={routeHref({ work: null, tab: "needs", focus: needKey(entry) })} className={s.mini}>
                    <span className={s.miniTitle}>{needTitle(entry)}</span>
                    <span className={s.miniSub}>
                      <span className={s.miniWhere}>{needWhere(entry)}</span>
                      <When at={needSince(entry)} now={props.now} />
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
            <More count={needs.length - RAIL_ROWS} href={routeHref({ work: null, tab: "needs" })} />
          </section>
        ) : null}
        {running.length > 0 ? (
          <section className={s.block}>
            <p className={s.blockHead}>
              <span className={s.blockTitle}>Try it</span>
            </p>
            <ul className={s.tryList}>
              {running.map((work) => (
                <li key={work.id}>
                  <span className={s.miniWhere}>{work.title}</span>
                  <span className={s.tryRow}>
                    <TryLinks work={work.id} links={work.links} />
                  </span>
                </li>
              ))}
            </ul>
          </section>
        ) : null}
        <section className={`${s.block} ${s.shipped}`}>
          <BlockHead title="Shipped today" count={loading ? null : shipped.length} href={routeHref({ work: null, tab: "shipped" })} />
          {loading || shipped.length || props.query ? null : <p className={s.blockEmpty}>Nothing has shipped today.</p>}
          <ul>
            {shipped.slice(0, RAIL_ROWS).map((entry, index) => (
              <li key={`${entry.work}@${entry.at}#${index}`} className={toView(props.viewed, describe(entry)?.key ?? null) ? undefined : s.viewed}>
                <ShippedMini entry={entry} now={props.now} />
              </li>
            ))}
          </ul>
          <More count={shipped.length - RAIL_ROWS} href={routeHref({ work: null, tab: "shipped" })} />
        </section>
      </aside>
    </div>
  );
}

function BlockHead(props: { readonly title: string; readonly count: number | null; readonly href: string }) {
  return (
    <Link href={props.href} className={s.blockHead}>
      <span className={s.blockTitle}>{props.title}</span>
      {props.count ? <span className="n">{props.count}</span> : null}
    </Link>
  );
}

function More(props: { readonly count: number; readonly href: string }) {
  if (props.count <= 0) return null;
  return (
    <Link href={props.href} className="more">
      {props.count} more
    </Link>
  );
}

function ShippedMini(props: { readonly entry: FeedEntry; readonly now: number }) {
  const { entry } = props;
  const line = describe(entry);
  if (!line) return null;
  const { text, href } = shippedWords(line);
  const body = (
    <>
      <span className={s.miniTitle}>{text}</span>
      <span className={s.miniSub}>
        <span className={s.miniWhere}>{entry.workTitle}</span>
        <When at={entry.at} now={props.now} />
      </span>
    </>
  );
  return href ? (
    <a className={s.mini} href={href} target="_blank" rel="noopener noreferrer">
      {body}
    </a>
  ) : (
    <Link href={routeHref({ work: entry.work })} className={s.mini}>
      {body}
    </Link>
  );
}

function Card(props: { readonly work: WorkSummary; readonly unread: boolean; readonly need: NeedEntry | null; readonly now: number }) {
  const { work, need } = props;
  const prs = work.pullRequests;
  return (
    <Link href={routeHref({ work: work.id })} className={s.card}>
      <Avatar project={work.project} fallback={work.id} />
      <span className={s.cardMain}>
        <span className={s.cardTop}>
          <span className={s.cardTitle}>{work.title}</span>
          {props.unread ? <span className="unread-dot" role="img" aria-label="Changed since you last opened it" title="Changed since you last opened it" /> : null}
          <PhasePill work={work} />
        </span>
        <span className={s.cardMeta}>
          {work.project ? `${work.project} · ` : ""}
          {work.machine ? `${work.machine} · ` : ""}
          <Ago verb="changed" at={work.lastChangeAt} now={props.now} />
        </span>
        {work.goal ? (
          <span className={s.cardGoal}>
            <b className={s.goalLabel}>Goal</b>
            {work.goal}
          </span>
        ) : null}
        {work.summary ? <span className={s.cardSum}>{work.summary}</span> : null}
        {need ? (
          <span className={s.cardNeed}>
            <HandPalmIcon weight="fill" aria-hidden />
            <span>
              <b>{work.needsCount > 1 ? `${work.needsCount} need you` : "Needs you"}</b> {needTitle(need)}
            </span>
          </span>
        ) : null}
        <span className={s.cardFoot}>
          {[work.shipped > 0 ? `${work.shipped} shipped` : null, prs.total > 0 ? `${prs.merged} of ${plural(prs.total, "pull request")} merged` : null].filter(Boolean).join(" · ")}
        </span>
      </span>
    </Link>
  );
}
