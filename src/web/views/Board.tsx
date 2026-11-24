import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { ReactNode } from "react";
import { createPortal } from "react-dom";
import { ArrowCounterClockwiseIcon, ArrowsInLineHorizontalIcon, ArrowsOutLineHorizontalIcon, BroadcastIcon, CaretLeftIcon, CaretRightIcon, CheckCircleIcon, CheckIcon, ChecksIcon, CircleDashedIcon, CircleHalfIcon, CircleIcon, GitPullRequestIcon, HandPalmIcon, HourglassSimpleIcon, RocketLaunchIcon, XIcon } from "@phosphor-icons/react";
import type { Icon } from "@phosphor-icons/react";
import { LONG_TITLE } from "../../core/text.ts";
import type { Live, PullRequest, WorkId } from "../../core/types.ts";
import { LANE_LABEL, LANES, laneCards } from "../lib/board.ts";
import type { BoardCard, Lane } from "../lib/board.ts";
import type { Dismissed } from "../lib/dismissed.ts";
import { firstImage, sanitize, withoutLeadingRef, withoutLinks, withoutTrailingCommits, wordsOf } from "../lib/html.ts";
import { viewedOf } from "../lib/marks.ts";
import { usePersisted } from "../lib/persist.ts";
import type { MarkSet } from "../lib/marks.ts";
import { nothingWaiting } from "../lib/needs.ts";
import { close, laneAnchor, navigate, routeHref } from "../lib/route.ts";
import { plural } from "../lib/works.ts";
import { AskBody, AskThread } from "./Needs.tsx";
import { Ago, Avatar, Fold, Important, Link, PrIcon, PrRow, RefChips, RichHtml, useProjectColour, ViewHead, When } from "./parts.tsx";
import s from "./Board.module.css";

interface BoardProps {
  /** Every lane's cards, already narrowed to what the screen is about and to the filter, without the asks marked done. */
  readonly cards: readonly BoardCard[];
  /** How many asks wait here, whatever the filter shows of them. */
  readonly asking: number;
  /** The asks the user marked done. They are off the board until asked for. */
  readonly done: readonly BoardCard[];
  /** The open work, whose cards these are, so none says which work it is from. Null across everything. */
  readonly scope: WorkId | null;
  /** The first load is on its way. */
  readonly loading: boolean;
  /** Every card there is to show has loaded, so one the address names and the board lacks is gone. */
  readonly whole: boolean;
  readonly query: string;
  /** The harnesses that can't be read now, by name. */
  readonly unread: readonly string[];
  /** Whether a card is new or edited since the user last looked. */
  readonly freshOf: (card: BoardCard) => "new" | "edited" | null;
  readonly viewed: MarkSet;
  readonly dismissed: Dismissed;
  /** The card shown in full, by its key. */
  readonly open: string | null;
  /** The address of this board with a card open, or with none. */
  readonly hrefOf: (card: string | null) => string;
  /** What sits above the lanes on a work: the work's head. */
  readonly children?: ReactNode;
  readonly now: number;
}

export const LANE_ICON: Record<Lane, Icon> = { needs: HandPalmIcon, next: CircleDashedIcon, doing: CircleHalfIcon, shipped: RocketLaunchIcon };

/** How many cards a lane opens with. Shipped runs to hundreds on a long piece of work. */
const LANE_FIRST = 24;

/** The lane given the board's width, as this browser keeps it. */
const readWide = (stored: unknown): Lane | null => LANES.find((lane) => lane === stored) ?? null;

/** Left and right step between the lanes' own controls, the switches and the folded lanes, without a walk through every card between them. */
function stepLanes(event: { readonly key: string; readonly currentTarget: HTMLElement; preventDefault(): void }) {
  const step = event.key === "ArrowLeft" ? -1 : event.key === "ArrowRight" ? 1 : 0;
  if (!step) return;
  const controls = [...document.querySelectorAll<HTMLElement>("[data-lane-control]")];
  const next = controls[controls.indexOf(event.currentTarget) + step];
  if (!next) return;
  event.preventDefault();
  next.focus();
}

/** A phone shows a lane at a time already, so none is widened there. */
const PHONE = matchMedia("(max-width: 760px)");
const usePhone = () =>
  useSyncExternalStore(
    (listener) => {
      PHONE.addEventListener("change", listener);
      return () => PHONE.removeEventListener("change", listener);
    },
    () => PHONE.matches,
  );

/**
 * Everything that is waiting, planned, under way or shipped, as one board: a lane each, and one kind of card.
 * A card opens in full beside the board, where the next and the one before are a key away.
 * Nothing is dragged: the pages say where a thing stands, and the board shows it.
 */
export function Board(props: BoardProps) {
  // The asks marked done are shown on request, and only while there are some: the switch has nowhere to sit once the last is brought back.
  const [asked, setShowDone] = useState(false);
  const showDone = asked && props.done.length > 0;
  const scoped = props.scope !== null;
  const lanes = LANES.map((lane) => ({ lane, cards: [...laneCards(props.cards, lane), ...(lane === "needs" && showDone ? props.done : [])] }));
  const home = lanes.find(({ cards }) => cards.some((card) => card.name === props.open))?.cards;
  const at = home?.findIndex((card) => card.name === props.open) ?? -1;
  const opened = home?.[at];
  const isDone = (card: BoardCard) => props.dismissed.has(card.key);
  const change = props.dismissed.change;
  // With nothing waiting, the lane for it gives its room to the other three. What the filter shows has no say, so typing
  // never brings the lane or takes it away. It stays while a harness can't be read, since then "nothing" is not known.
  const idle = (lane: Lane) => lane === "needs" && props.asking === 0 && !showDone && !props.loading && props.unread.length === 0;
  // The switch that shows the asks marked done is one small button while the lane is away and sits in the lane's head while it is there. Focus follows it.
  const switched = useRef(false);
  useEffect(() => {
    if (switched.current) document.querySelector<HTMLElement>("[data-done-switch]")?.focus({ preventScroll: true });
    switched.current = false;
  }, [showDone]);
  const setShown = (show: boolean) => {
    switched.current = true;
    setShowDone(show);
  };
  // Marking the last ask done takes the lane away, and the button pressed with it. Focus goes to what is left of the lane.
  const away = idle("needs");
  useEffect(() => {
    if (away && document.activeElement === document.body) document.querySelector<HTMLElement>("[data-done-switch]")?.focus({ preventScroll: true });
  }, [away]);
  // One lane can be given the board's width, to be skimmed: each of its cards is a row that says all it has, and the other lanes fold into its head, each a press away.
  const [kept, setWide] = usePersisted("progress:board-wide", readWide);
  const phone = usePhone();
  const wide = kept !== null && !phone && !idle(kept) ? kept : null;
  // A widened lane that empties is forgotten, so it does not come back wide on its own when something next lands in it.
  const emptied = kept !== null && !props.loading && idle(kept);
  useEffect(() => {
    if (emptied) setWide(null);
  }, [emptied]);
  // A folded lane that is pressed is gone, and the widened one stands where it was. Focus goes to that lane's own switch.
  const widened = useRef(false);
  useEffect(() => {
    if (widened.current) document.querySelector<HTMLElement>("section[data-wide] [data-wide-switch]")?.focus({ preventScroll: true });
    widened.current = false;
  }, [wide]);
  const widen = (lane: Lane) => {
    widened.current = true;
    setWide(lane);
  };
  const folded = ({ lane, cards }: { readonly lane: Lane; readonly cards: readonly BoardCard[] }) =>
    idle(lane) ? null : <Folded key={lane} lane={lane} count={props.loading ? null : lane === "needs" ? cards.filter((card) => !isDone(card)).length : cards.length} onWide={() => widen(lane)} />;
  // A card the address names and the board no longer has: the line left its page, or its ask was marked done. The address goes back to the board's own.
  const gone = props.open !== null && !opened && props.whole && props.query === "";
  useEffect(() => {
    if (gone) navigate(props.hrefOf(null), true);
  }, [gone]);
  // The open card stays in sight in its lane as the arrows step through it.
  useEffect(() => {
    if (props.open) document.querySelector(`[data-card="${CSS.escape(props.open)}"]`)?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [props.open]);
  return (
    <div className={s.board}>
      {props.children ?? <ViewHead title="Board" />}
      {props.query !== "" && !props.loading && lanes.every(({ cards }) => cards.length === 0) ? (
        // Said once, not in each of four empty lanes.
        <p className="nothing">Nothing on the board matches “{props.query}”.</p>
      ) : (
      <div className={s.lanes}>
        {lanes.map(({ lane, cards }, at) =>
          wide !== null ? (
            lane === wide ? (
              <LaneView key={lane} {...props} scoped={scoped} lane={lane} cards={cards} isDone={isDone} showDone={showDone} onShowDone={setShown} wide onWide={() => setWide(null)} before={lanes.slice(0, at).map(folded)} after={lanes.slice(at + 1).map(folded)} />
            ) : null
          ) : !idle(lane) ? (
            <LaneView key={lane} {...props} scoped={scoped} lane={lane} cards={cards} isDone={isDone} showDone={showDone} onShowDone={setShown} wide={false} onWide={() => setWide(lane)} />
          ) : props.done.length ? (
            // All that is left of the lane is the way back to the asks marked done.
            <button key={lane} type="button" data-done-switch className={`icon-btn ${s.laneRail}`} aria-label={`Nothing needs you. Show the ${plural(props.done.length, "ask")} you marked done.`} title={`Nothing needs you. Show the ${plural(props.done.length, "ask")} you marked done.`} onClick={() => setShown(true)}>
              <HandPalmIcon aria-hidden />
            </button>
          ) : null,
        )}
      </div>
      )}
      {opened && home ? (
        <Sheet
          card={opened}
          prev={home[at - 1] ?? null}
          next={home[at + 1] ?? null}
          at={at + 1}
          of={home.length}
          viewed={props.viewed}
          done={isDone(opened)}
          onDone={(on) => {
            if (!on) return change.restore([opened.key]);
            change.dismiss([opened.key]);
            // The ask leaves its lane, and the next one opens: a list of asks is worked through without closing and opening.
            if (!showDone) navigate(props.hrefOf((home[at + 1] ?? home[at - 1])?.name ?? null), true);
          }}
          hrefOf={props.hrefOf}
          now={props.now}
        />
      ) : null}
    </div>
  );
}

type LaneProps = BoardProps & { readonly scoped: boolean; readonly lane: Lane; readonly isDone: (card: BoardCard) => boolean; readonly showDone: boolean; readonly onShowDone: (show: boolean) => void; readonly wide: boolean; readonly onWide: () => void; readonly before?: ReactNode; readonly after?: ReactNode };

/** A lane folded into the head of the one that has the board's width: its mark, its name and its count. A press gives it the width. */
function Folded(props: { readonly lane: Lane; readonly count: number | null; readonly onWide: () => void }) {
  const LaneIcon = LANE_ICON[props.lane];
  const label = LANE_LABEL[props.lane];
  return (
    <button type="button" data-lane-control className={s.laneFolded} data-lane={props.lane} onKeyDown={stepLanes} title={`Give ${label} the board's width`} onClick={props.onWide}>
      <LaneIcon weight={props.lane === "needs" ? "fill" : "bold"} aria-hidden />
      {label}
      {props.count === null ? null : <span className="n">{props.count}</span>}
    </button>
  );
}

/** How far down each lane was read, by what it holds and its name, for as long as the tab is open: a look at another tab and back finds each lane where it was left. */
const lanePlaces = new Map<string, number>();

function LaneView(props: LaneProps) {
  const { lane, cards, viewed } = props;
  const change = props.dismissed.change;
  const LaneIcon = LANE_ICON[lane];
  const id = laneAnchor(lane);
  // At the board's width a lane is skimmed top to bottom, so each card is there whole. In a column it is a card that opens.
  const Shown = props.wide ? RowView : CardView;
  const place = `${props.scope ?? ""}/${lane}`;
  const body = useRef<HTMLDivElement>(null);
  // A filter shortens a lane and the browser pulls it up. That is not where it was read to, so it is not kept, and the lane goes back when the filter is cleared.
  const whole = props.query === "";
  useLayoutEffect(() => {
    if (whole) body.current?.scrollTo({ top: lanePlaces.get(place) ?? 0 });
  }, [place, props.loading, whole]);
  // The shipped lane is where what landed is worked through: one button marks all of it viewed, and takes that back.
  const [marked, setMarked] = useState<readonly string[] | null>(null);
  const toView = lane === "shipped" ? cards.flatMap((card) => (card.viewKey !== null && !viewed.has(card.viewKey) ? [card.viewKey] : [])) : [];
  const waiting = toView.length > 0;
  useEffect(() => {
    if (waiting) setMarked(null);
  }, [waiting]);
  const open = lane === "needs" ? cards.filter((card) => !props.isDone(card)).length : cards.length;
  return (
    <section className={s.lane} data-lane={lane} data-wide={props.wide ? "" : undefined} aria-labelledby={id}>
      <header className={s.laneHead}>
        {props.before}
        <span className={s.laneName}>
          <LaneIcon weight={lane === "needs" ? "fill" : "bold"} aria-hidden />
          <h2 id={id}>{LANE_LABEL[lane]}</h2>
          {props.loading ? null : <span className="n">{open}</span>}
        </span>
        {props.after}
        <span className={s.laneEnd}>
        {waiting ? (
          <button
            type="button"
            className={`btn ${s.laneTool}`}
            title={`Mark ${plural(toView.length, "card")} viewed`}
            onClick={() => {
              void viewed.add(toView);
              setMarked(toView);
            }}
          >
            <ChecksIcon aria-hidden />
            <span className={s.laneToolLabel}>Mark all</span>
          </button>
        ) : marked ? (
          <button
            type="button"
            className={`btn ${s.laneTool}`}
            title="Marked viewed. Click to take that back."
            onClick={() => {
              void viewed.remove(marked);
              setMarked(null);
            }}
          >
            <ArrowCounterClockwiseIcon aria-hidden />
            <span className={s.laneToolLabel}>Undo</span>
          </button>
        ) : null}
        {/* In the lane's head, like what acts on Shipped, so marking an ask done moves nothing under it. */}
        {lane === "needs" && props.done.length ? (
          <button type="button" data-done-switch className={`btn ${s.laneTool}`} aria-pressed={props.showDone} title={props.showDone ? "Showing the asks you marked done. Click to hide them." : "Show the asks you marked done"} onClick={() => props.onShowDone(!props.showDone)}>
            {props.done.length} done
          </button>
        ) : null}
        <button type="button" data-wide-switch data-lane-control onKeyDown={stepLanes} className={`icon-btn tool ${s.laneWide}`} aria-pressed={props.wide} aria-label={props.wide ? "Show every lane" : `Give ${LANE_LABEL[lane]} the board's width`} title={props.wide ? "Show every lane" : `Give ${LANE_LABEL[lane]} the board's width`} onClick={props.onWide}>
          {props.wide ? <ArrowsInLineHorizontalIcon aria-hidden /> : <ArrowsOutLineHorizontalIcon aria-hidden />}
        </button>
        </span>
      </header>
      <div className={s.laneBody} ref={body} onScroll={(event) => (whole ? lanePlaces.set(place, event.currentTarget.scrollTop) : undefined)}>
        {props.loading ? (
          <ul className={s.cards} aria-hidden>
            {[0, 1].map((n) => (
              <li key={n} className={`${s.card} ${s.ghost}`} />
            ))}
          </ul>
        ) : cards.length ? (
          <Fold show={LANE_FIRST} noun="cards" className={s.cards} reveal={cards.findIndex((card) => card.name === props.open)} grow={props.wide}>
            {cards.map((card) => (
              <li key={card.key}>
                <Shown card={card} scoped={props.scoped} open={card.name === props.open} fresh={props.freshOf(card)} viewed={viewed} done={props.isDone(card)} onDone={lane === "needs" ? (on) => (on ? change.dismiss([card.key]) : change.restore([card.key])) : undefined} href={props.hrefOf(card.name)} now={props.now} />
              </li>
            ))}
          </Fold>
        ) : (
          <p className={s.laneEmpty}>{props.query ? "Nothing here matches." : EMPTY[lane](props)}</p>
        )}
        {lane === "shipped" && !props.scoped && cards.length && !props.query ? <p className={s.laneFoot}>The last two weeks. A work's own board has all it shipped.</p> : null}
      </div>
    </section>
  );
}

const EMPTY: Record<Lane, (props: BoardProps) => string> = {
  needs: (props) => nothingWaiting(props.unread),
  next: () => "Nothing is planned.",
  doing: () => "Nothing is in progress.",
  shipped: (props) => (props.scope !== null ? "Nothing has shipped yet." : "Nothing shipped in the last two weeks."),
};

/** A pull request a line opens with that the hub has no details for: it still gets a chip, from the link alone. */
const LEAD_PR = /^<a [^>]*href="([^"]+\/pull\/\d+)[^"]*"[^>]*>(#\d+)<\/a>[\s:,.]*(?=\p{Lu})/u;

/**
 * The card's line as its page wrote it, without the pull request it opens with, which its chips show, and
 * without links: the whole card is one. `lead` is that pull request when the hub knows no more of it than its link.
 */
function useLine(card: BoardCard): { readonly html: string | null; readonly lead: { readonly href: string; readonly label: string } | null } {
  return useMemo(() => {
    if (!card.titleHtml) return { html: null, lead: null };
    const clean = sanitize(withoutTrailingCommits(withoutLeadingRef(card.titleHtml, card.prs, card.commits), card.commits));
    const lead = LEAD_PR.exec(clean);
    return { html: withoutLinks(lead ? clean.slice(lead[0].length) : clean), lead: lead?.[1] && lead[2] ? { href: lead[1], label: lead[2] } : null };
  }, [card.titleHtml, card.prs, card.commits]);
}

/** How many pull requests a card names before the rest are a count. */
const CARD_PRS = 2;

interface CardProps {
  readonly card: BoardCard;
  readonly scoped: boolean;
  /** This is the card shown in full beside the board. */
  readonly open: boolean;
  readonly fresh: "new" | "edited" | null;
  readonly viewed: MarkSet;
  /** An ask the user marked done. */
  readonly done: boolean;
  /** Marks an ask done, or takes that back. Undefined in the other lanes. */
  readonly onDone: ((on: boolean) => void) | undefined;
  readonly href: string;
  readonly now: number;
}

function CardView(props: CardProps) {
  const { card } = props;
  const { html: line, lead } = useLine(card);
  const image = useMemo(() => (card.body ? firstImage(card.body) : null), [card.body]);
  // An ask is read before it is opened, so it shows how it goes on. The other lanes are told by their line.
  const more = useMemo(() => (card.lane !== "needs" ? "" : card.need?.source === "stall" ? (card.need.stall.text ?? "") : card.body ? wordsOf(card.body) : ""), [card]);
  const seen = viewedOf(props.viewed, card.viewKey);
  const colour = useProjectColour(card.project ?? card.work ?? "");
  const stall = card.need?.source === "stall" ? card.need.stall : null;
  return (
    <article className={s.card} data-card={card.name} data-lane={card.lane} data-quiet={seen?.on || props.done || undefined}>
      {props.scoped || !card.workTitle ? null : (
        <p className={s.cardFrom} style={colour} title={card.workTitle}>
          <Avatar project={card.project} fallback={card.work ?? card.workTitle} size="xs" />
          <span>{card.workTitle}</span>
        </p>
      )}
      <h3 className={s.cardTitle}>
        <Link href={props.href} className={s.cardOpen} current={props.open}>
          {card.important ? <Important /> : null}
          {line === null ? card.title : <span className="prose-inline" dangerouslySetInnerHTML={{ __html: line }} />}
        </Link>
      </h3>
      {props.fresh ? <span className={s.cardDot} role="img" aria-label={FRESH[props.fresh]} title={FRESH[props.fresh]} /> : null}
      {more ? <p className={s.cardMore}>{more}</p> : null}
      {image ? (
        // The card's picture opens large like any picture of a page, and not the card: it is what was pressed.
        <a className={`fig ${s.cardFig}`} aria-label={`Open the picture for: ${card.title}`} href={image.src.replace(/\?v=\d+$/, "")} {...(image.src.startsWith("/files/") ? {} : { target: "_blank", rel: "noopener noreferrer" })}>
          <img className={s.cardShot} src={image.src} alt="" loading="lazy" />
        </a>
      ) : null}
      <footer className={s.cardFoot}>
        {stall ? <span className={s.cardNote}>{stall.ask === "approval" ? "Wants approval" : "Asked a question"}</span> : null}
        {card.prs.slice(0, CARD_PRS).map((pr) => (
          <PrChip key={pr.url} pr={pr} />
        ))}
        {lead ? (
          <a className={s.cardPr} href={lead.href} target="_blank" rel="noopener noreferrer">
            <GitPullRequestIcon aria-hidden />
            <span>{lead.label}</span>
          </a>
        ) : null}
        {card.prs.length > CARD_PRS ? <span className={s.cardNote}>+{card.prs.length - CARD_PRS}</span> : null}
        {card.live ? <LiveMark live={card.live} /> : null}
        <span className={s.cardEnd}>
          {card.at ? <When at={card.at} now={props.now} /> : null}
          <Marks {...props} />
        </span>
      </footer>
    </article>
  );
}

/**
 * Everything a card holds, in the order it is read: where it is from and when, its line, what its page says under
 * it with its pictures, whether it is live, and its pull requests. The open card shows this, and so does each row of
 * a lane given the board's width. A row is `dense`: it says whether it is live and names its pull requests on the
 * line with the time, where the open card gives each a line of its own.
 */
function CardWhole(props: { readonly card: BoardCard; readonly scoped: boolean; readonly heading: "h2" | "h3"; readonly dense?: boolean; readonly now: number }) {
  const { card, dense } = props;
  const need = card.need;
  // In a row the pull requests are chips beside the time, so the line does not open with one of them again.
  const line = useMemo(() => (card.titleHtml === null ? null : sanitize(dense ? withoutTrailingCommits(withoutLeadingRef(card.titleHtml, card.prs, card.commits), card.commits) : card.titleHtml)), [card.titleHtml, card.prs, card.commits, dense]);
  const colour = useProjectColour(card.project ?? card.work ?? "");
  // A pull request that is the card says its name once, as the card's line. Its number and state go beside the time.
  const own = card.titleHtml === null && card.prs.length === 1 ? (card.prs[0] ?? null) : null;
  // A line that still opens with a pull request's link names it there, so a row gives it no chip as well.
  const led = dense ? /^<a [^>]*>#(\d+)<\/a>/.exec(line ?? "")?.[1] : undefined;
  return (
    <div className={s.whole}>
      <p className={s.wholeFrom}>
        {card.work && card.workTitle && !props.scoped ? (
          <Link href={routeHref({ work: card.work, tab: "board" })} className={s.wholeWork} style={colour} title="Open its board">
            <Avatar project={card.project} fallback={card.work} size="xs" />
            <span>{card.workTitle}</span>
          </Link>
        ) : null}
        {card.at ? <Ago verb={card.lane === "shipped" ? "shipped" : need?.source === "stall" ? "stopped" : "added"} at={card.at} now={props.now} /> : null}
        {dense ? card.prs.filter((pr) => String(pr.number) !== led).map((pr) => <PrChip key={pr.url} pr={pr} />) : own ? <PrChip pr={own} /> : null}
        {dense && card.live ? (
          <span className={s.wholeLiveLine}>
            <LiveMark live={card.live} worded />
            {card.live.note ? <span className="prose-inline" dangerouslySetInnerHTML={{ __html: sanitize(card.live.note) }} /> : null}
            {card.live.at ? <Ago verb="since" at={card.live.at} now={props.now} /> : null}
          </span>
        ) : null}
      </p>
      {/* A line that runs to a paragraph is read as one, not shouted as a heading. */}
      <props.heading className={s.wholeTitle} data-long={card.title.length > LONG_TITLE || undefined}>
        {card.important ? <Important /> : null}
        {line === null ? card.title : <span className="prose-inline" dangerouslySetInnerHTML={{ __html: line }} />}
      </props.heading>
      {need ? <AskBody entry={need} /> : card.body ? <RichHtml html={card.body} /> : null}
      {card.live && !dense ? (
        <p className={s.wholeLive}>
          <LiveMark live={card.live} worded />
          {card.live.note ? <span className="prose-inline" dangerouslySetInnerHTML={{ __html: sanitize(card.live.note) }} /> : null}
          {card.live.at ? <Ago verb="since" at={card.live.at} now={props.now} className={s.wholeLiveAt} /> : null}
        </p>
      ) : null}
      {card.prs.length && !own && !dense ? (
        <ul className={`rows ${s.wholePrs}`}>
          {card.prs.map((pr) => (
            <li key={pr.url}>
              <PrRow pr={pr} />
            </li>
          ))}
        </ul>
      ) : null}
      <RefChips prs={[]} commits={card.commits} />
    </div>
  );
}

/**
 * A card in a lane given the board's width: all of it, so the lane is read by scrolling and nothing has to be opened.
 * What marks it stands at the row's end, where it is on every row.
 */
function RowView(props: CardProps) {
  const { card } = props;
  const seen = viewedOf(props.viewed, card.viewKey);
  return (
    <article className={s.row} data-card={card.name} data-lane={card.lane} data-quiet={seen?.on || props.done || undefined}>
      <CardWhole card={card} scoped={props.scoped} heading="h3" dense now={props.now} />
      <p className={s.rowEnd}>
        {props.fresh ? <span className={s.rowDot} role="img" aria-label={FRESH[props.fresh]} title={FRESH[props.fresh]} /> : null}
        <Marks {...props} />
      </p>
      {card.need ? (
        <p className={s.rowFoot}>
          <AskThread entry={card.need} />
        </p>
      ) : null}
    </article>
  );
}

/** What the user does to a card from the board: mark what shipped viewed, or an ask done. */
function Marks(props: CardProps) {
  const seen = viewedOf(props.viewed, props.card.viewKey);
  return (
    <>
      {seen ? (
        <button type="button" className={s.cardMark} aria-pressed={seen.on} aria-label="Viewed" title={seen.on ? "Viewed. Click to mark as not viewed." : "Mark viewed"} onClick={() => seen.set(!seen.on)}>
          {seen.on ? <CheckCircleIcon weight="fill" aria-hidden /> : <CircleIcon aria-hidden />}
        </button>
      ) : null}
      {props.onDone ? (
        <button type="button" className={s.cardMark} aria-pressed={props.done} aria-label="Done" title={props.done ? "Marked done. Click to bring it back." : "Mark done. It leaves your lists, and the page is not changed."} onClick={() => props.onDone?.(!props.done)}>
          {props.done ? <CheckCircleIcon weight="fill" aria-hidden /> : <CheckIcon aria-hidden />}
        </button>
      ) : null}
    </>
  );
}

/**
 * Whether what shipped can be tried yet. On a card it is an icon alone, and pointing at it says which and the page's
 * own words about it. The open card has the room to say it in a word.
 */
export function LiveMark(props: { readonly live: Live; readonly worded?: boolean }) {
  const says = props.live.on ? "Live" : "Not live";
  const Mark = props.live.on ? BroadcastIcon : HourglassSimpleIcon;
  if (props.worded) {
    return (
      <span className={s.live} data-on={props.live.on || undefined}>
        <Mark aria-hidden />
        {says}
      </span>
    );
  }
  const words = wordsOf(props.live.note);
  const label = words ? `${says}: ${words}` : says;
  return (
    <span className={s.live} data-on={props.live.on || undefined} role="img" aria-label={label} title={label}>
      <Mark aria-hidden />
    </span>
  );
}

/** A pull request as its state's icon and its number, opening on GitHub. The card's line says what it is. */
function PrChip(props: { readonly pr: PullRequest }) {
  const { pr } = props;
  return (
    <a className={s.cardPr} href={pr.url} target="_blank" rel="noopener noreferrer" title={`${pr.title} (${pr.state})`}>
      <PrIcon state={pr.state} />
      <span>#{pr.number}</span>
    </a>
  );
}

const FRESH = { new: "New since you last looked", edited: "Edited since you last looked" } as const;

const isTyping = (event: KeyboardEvent) => event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement;

interface SheetProps {
  readonly card: BoardCard;
  /** Its neighbours in its lane. */
  readonly prev: BoardCard | null;
  readonly next: BoardCard | null;
  readonly at: number;
  readonly of: number;
  readonly viewed: MarkSet;
  readonly done: boolean;
  readonly onDone: (on: boolean) => void;
  readonly hrefOf: (card: string | null) => string;
  readonly now: number;
}

/**
 * One card in full, beside the board: everything its page wrote under the line, its pictures at their size,
 * its pull requests by name. The arrows step through its lane, so a lane is read without closing and opening.
 */
function Sheet(props: SheetProps) {
  const { card, prev, next, hrefOf } = props;
  const LaneIcon = LANE_ICON[card.lane];
  const seen = viewedOf(props.viewed, card.viewKey);
  const shut = () => close(hrefOf(null));
  const move = (to: BoardCard | null) => (to ? navigate(hrefOf(to.name), true) : undefined);
  // The sheet is the only thing to use while it is open. When it closes, the card last shown has focus, wherever the sheet was opened from.
  const shown = useRef("");
  shown.current = card.name;
  useEffect(() => {
    const app = document.getElementById("root");
    if (app) app.inert = true;
    return () => {
      if (app) app.inert = false;
      // The card last shown, or when it has left the board, as an ask marked done does, the first card there is.
      (document.querySelector<HTMLElement>(`[data-card="${CSS.escape(shown.current)}"] h3 a`) ?? document.querySelector<HTMLElement>("[data-card] h3 a"))?.focus({ preventScroll: true });
    };
  }, []);
  // While a picture is open over the card, the keys are the picture's.
  const self = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (self.current?.inert) return;
      if (event.key === "Escape") shut();
      else if (isTyping(event) || event.metaKey || event.ctrlKey || event.altKey) return;
      else if (event.key === "ArrowLeft" || event.key === "ArrowUp" || event.key === "k") move(prev);
      else if (event.key === "ArrowRight" || event.key === "ArrowDown" || event.key === "j") move(next);
      else return;
      event.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });
  // Opening what shipped is viewing it.
  useEffect(() => {
    if (card.viewKey !== null && !props.viewed.has(card.viewKey)) void props.viewed.add([card.viewKey]);
  }, [card.viewKey]);
  // Each card starts at its top.
  const body = useRef<HTMLDivElement>(null);
  useEffect(() => {
    body.current?.scrollTo({ top: 0 });
  }, [card.key]);

  const need = card.need;
  return createPortal(
    <div ref={self} className={s.scrim} onClick={(event) => (event.target === event.currentTarget ? shut() : undefined)}>
      <aside className={s.sheet} role="dialog" aria-modal="true" aria-label={card.title} data-lane={card.lane}>
        <header className={s.sheetHead}>
          <span className={s.sheetLane}>
            <LaneIcon weight={card.lane === "needs" ? "fill" : "bold"} aria-hidden />
            {LANE_LABEL[card.lane]}
          </span>
          <span className={s.sheetAt}>{props.of > 1 ? `${props.at} of ${props.of}` : null}</span>
          <button type="button" className="icon-btn" onClick={() => move(prev)} disabled={!prev} aria-label="Previous card" title="Previous (←)">
            <CaretLeftIcon weight="bold" aria-hidden />
          </button>
          <button type="button" className="icon-btn" onClick={() => move(next)} disabled={!next} aria-label="Next card" title="Next (→)">
            <CaretRightIcon weight="bold" aria-hidden />
          </button>
          <button type="button" className="icon-btn" onClick={shut} aria-label="Close" title="Close (Esc)" autoFocus>
            <XIcon aria-hidden />
          </button>
        </header>
        <div className={s.sheetBody} ref={body}>
          <CardWhole card={card} scoped={false} heading="h2" now={props.now} />
        </div>
        <footer className={s.sheetFoot}>
          {need ? <AskThread entry={need} /> : null}
          {need ? (
            <button type="button" className="btn" aria-pressed={props.done} title={props.done ? "It goes back on your lists." : "It leaves your lists, and the page is not changed."} onClick={() => props.onDone(!props.done)}>
              {props.done ? <ArrowCounterClockwiseIcon aria-hidden /> : <CheckIcon aria-hidden />}
              {props.done ? "Bring back" : "Mark done"}
            </button>
          ) : null}
          {seen ? (
            <button type="button" className="btn" aria-pressed={seen.on} onClick={() => seen.set(!seen.on)}>
              {seen.on ? <CheckCircleIcon weight="fill" aria-hidden /> : <CircleIcon aria-hidden />}
              {seen.on ? "Viewed" : "Mark viewed"}
            </button>
          ) : null}
        </footer>
      </aside>
    </div>,
    document.body,
  );
}
