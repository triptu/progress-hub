import type { ReactNode } from "react";
import { CaretRightIcon, HandPalmIcon } from "@phosphor-icons/react";
import type { NeedEntry, WorkId, WorkSummary } from "../../core/types.ts";
import { cardName } from "../lib/board.ts";
import { needKey, needTitle } from "../lib/needs.ts";
import { routeHref } from "../lib/route.ts";
import { plural } from "../lib/works.ts";
import { Ago, Avatar, Link, PhasePill, TryLinks, ViewHead, When } from "./parts.tsx";
import s from "./Home.module.css";

interface HomeProps {
  /** Ongoing work. Null while the first load is on its way. */
  readonly works: readonly WorkSummary[] | null;
  /** Settled work, listed under the cards where there is no sidebar to hold it. */
  readonly settled: readonly WorkSummary[];
  /** What needs the user across ongoing work, oldest first, without what they marked done. */
  readonly needs: readonly NeedEntry[];
  /** A filter is on, so an empty list means nothing matches it. */
  readonly query: string;
  readonly isUnread: (work: WorkSummary) => boolean;
  /** What closes the screen: the user's own list. */
  readonly children?: ReactNode;
  readonly now: number;
}

/** How many of a work's asks its card names before the rest are a count. */
const CARD_ASKS = 2;

/** Home: every ongoing work as a card that says what it is for, where it stands and what it waits on. */
export function Home(props: HomeProps) {
  const { works } = props;
  const asks = new Map<WorkId, NeedEntry[]>();
  for (const entry of props.needs) if (entry.work) asks.set(entry.work, [...(asks.get(entry.work) ?? []), entry]);
  return (
    <div className="wrap">
      <ViewHead title="Home" />
      {works === null ? (
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
              <Card work={work} unread={props.isUnread(work)} asks={asks.get(work.id) ?? []} now={props.now} />
            </li>
          ))}
        </ul>
      )}
      {props.settled.length ? (
        <details className={`fold ${s.settled}`}>
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
      {props.children}
    </div>
  );
}

function Card(props: { readonly work: WorkSummary; readonly unread: boolean; readonly asks: readonly NeedEntry[]; readonly now: number }) {
  const { work, asks } = props;
  const board = routeHref({ work: work.id, tab: "board" });
  const counts = [
    work.doing ? `${work.doing} in progress` : null,
    work.next ? `${work.next} next up` : null,
    work.shipped > 0 ? `${work.shipped} shipped` : null,
  ].filter((count) => count !== null);
  return (
    <article className={s.card}>
      <Avatar project={work.project} fallback={work.id} />
      <div className={s.cardMain}>
      <div className={s.cardTop}>
        <h2 className={s.cardTitle}>
          <Link href={routeHref({ work: work.id })} className={s.cardOpen}>
            {work.title}
          </Link>
        </h2>
        {props.unread ? <span className="unread-dot" role="img" aria-label="Changed since you last opened it" title="Changed since you last opened it" /> : null}
        <PhasePill work={work} />
      </div>
      <p className={s.cardMeta}>
        {work.project ? `${work.project} · ` : ""}
        {work.machine ? `${work.machine} · ` : ""}
        <Ago verb="changed" at={work.lastChangeAt} now={props.now} />
      </p>
      {/* What it waits on the user for comes before what it is for: it is why this card is read first. */}
      {asks.length ? (
        <ul className={s.cardAsks}>
          {asks.slice(0, CARD_ASKS).map((entry) => (
            <li key={needKey(entry)}>
              <Link href={routeHref({ work: work.id, tab: "board", card: cardName(needKey(entry)) })} className={s.cardAsk}>
                <HandPalmIcon weight="fill" aria-hidden />
                <span>{needTitle(entry)}</span>
              </Link>
            </li>
          ))}
          {asks.length > CARD_ASKS ? (
            <li>
              <Link href={board} className={`${s.cardAsk} ${s.cardAskMore}`}>
                {plural(asks.length - CARD_ASKS, "more ask")}
              </Link>
            </li>
          ) : null}
        </ul>
      ) : null}
      {work.goal ? (
        <p className={s.cardGoal}>
          <b className={s.goalLabel}>Goal</b>
          {work.goal}
        </p>
      ) : null}
      {work.summary ? <p className={s.cardSum}>{work.summary}</p> : null}
      <footer className={s.cardFoot}>
        {counts.length ? (
          <Link href={board} className={s.cardCounts} title="Open its board">
            {counts.join(" · ")}
          </Link>
        ) : null}
        {work.links.length ? (
          <span className={s.cardTry}>
            <TryLinks work={work.id} links={work.links} />
          </span>
        ) : null}
      </footer>
      </div>
    </article>
  );
}
