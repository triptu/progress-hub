import type { ReactNode, RefObject } from "react";
import { CaretRightIcon } from "@phosphor-icons/react";
import type { Agent, Html, Instant, NeedEntry, PlanEntry, WorkDetail, WorkId, WorkSummary } from "../../core/types.ts";
import { freshness, LANE_LABEL, planCards } from "../lib/board.ts";
import type { Lane } from "../lib/board.ts";
import type { Dismissed } from "../lib/dismissed.ts";
import type { FeedRow } from "../lib/feed.ts";
import type { MarkSet } from "../lib/marks.ts";
import { usePersisted } from "../lib/persist.ts";
import { modelName } from "../lib/model.ts";
import { needKey } from "../lib/needs.ts";
import { AGENT_STATUS, partsOf } from "../lib/outline.ts";
import type { Part } from "../lib/outline.ts";
import { routeHref } from "../lib/route.ts";
import { useActiveSection } from "../lib/spy.ts";
import { PHASE_LABEL, phaseOf, plural } from "../lib/works.ts";
import { relative } from "../lib/time.ts";
import { LANE_ICON } from "./Board.tsx";
import { Entry } from "./Entry.tsx";
import { Timeline } from "./Feed.tsx";
import { NeedCard } from "./Needs.tsx";
import { Ago, Avatar, Fold, Link, RichHtml, ThreadButton, TryLinks, When } from "./parts.tsx";
import s from "./WorkPage.module.css";

/**
 * A work's name, the way to its thread, and one line under the name: its project, what it is doing and
 * when it last changed. It sits above every tab of the work and is the same on each.
 */
export function WorkHead(props: { readonly summary: WorkSummary; readonly now: number }) {
  const { summary, now } = props;
  const phase = phaseOf(summary);
  return (
    <header className="work-head">
      <div className={s.workTitle}>
        <h1>{summary.title}</h1>
      </div>
      {summary.links.length > 0 ? (
        <div className={s.workTry}>
          <TryLinks work={summary.id} links={summary.links} />
        </div>
      ) : null}
      <ThreadButton href={summary.threadLink} label="Open thread" />
      <p className={s.workState}>
        <span className={s.workProject}>
          <Avatar project={summary.project} fallback={summary.id} size="xs" />
          {summary.project ?? summary.id}
        </span>
        {summary.machine ? <span title="The machine this work lives on">{summary.machine}</span> : null}
        <span className={s.phase} data-phase={phase}>{PHASE_LABEL[phase]}</span>
        <Ago verb="changed" at={summary.lastChangeAt} now={now} className={s.ago} />
      </p>
    </header>
  );
}

const readClosed = (stored: unknown) => stored === true;

/**
 * What the work is for: the first thing under a work's head on every tab, in the same place on each.
 * It folds away, and stays folded from tab to tab and work to work until it is opened again.
 * `html` is the goal as the page wrote it; `text` stands in until the page has loaded.
 */
export function Goal(props: { readonly html: Html | null; readonly text: string }) {
  const [closed, setClosed] = usePersisted("progress:goal-closed", readClosed);
  if (!props.html?.trim() && !props.text) return null;
  return (
    <section className={`${s.stated} ${s.goal}`} aria-label="Goal">
      <button type="button" className={`${s.statedLabel} ${s.goalToggle}`} aria-expanded={!closed} title={closed ? "Show the goal" : "Hide the goal"} onClick={() => setClosed(!closed)}>
        Goal
        <CaretRightIcon weight="bold" aria-hidden />
      </button>
      {closed ? null : props.html?.trim() ? <RichHtml html={props.html} className={s.lead} /> : <p className={s.lead}>{props.text}</p>}
    </section>
  );
}

interface WorkPageProps {
  readonly summary: WorkSummary;
  /** Null while the page loads. */
  readonly detail: WorkDetail | null;
  /** What the work has planned, has in progress and has shipped: its board, counted here. */
  readonly plan: readonly PlanEntry[];
  /** What this work needs from the user, from the hub's list, without what they marked done. */
  readonly needs: readonly NeedEntry[];
  /** The asks they marked done, by key. */
  readonly done: readonly string[];
  readonly dismissed: Dismissed;
  /** What the feed tells of this work since the user last had it open, newest first. */
  readonly since: readonly FeedRow[];
  /** What the work is for, which opens the page as it opens every tab. */
  readonly goal: ReactNode;
  /** The files the work made, listed under the outline. */
  readonly artifacts: ReactNode;
  /** What closes the page: the user's own list for this work. */
  readonly todos: ReactNode;
  /** The filter. Sections keep what matches it. */
  readonly query: string;
  /** When the user last had this page open before now. Anything newer is marked new. */
  readonly seenBefore: Instant;
  /** What the user marked as viewed. */
  readonly viewed: MarkSet;
  /** The element that scrolls the page, which the outline follows. */
  readonly scroller: RefObject<HTMLElement | null>;
  readonly now: number;
}

/** How many of the new lines a work's Home opens with. Activity has them all. */
const SINCE_FIRST = 5;

/**
 * A work's Home: what is new, what it is for, what it waits on, where it stands, and the page's own sections,
 * with an outline beside them. What it has planned, under way and shipped is on its board.
 */
export function WorkPage(props: WorkPageProps) {
  const { summary, detail, now } = props;
  const change = props.dismissed.change;
  const parts = detail ? partsOf(detail, props.needs, props.seenBefore, props.query) : [];
  const [active, pin] = useActiveSection(
    parts.map((part) => part.id),
    props.scroller,
  );
  const asksNow = (part: Part) => part.kind === "needs" && !part.leftover;
  const section = (part: Part) => (
    <Section key={part.id} part={part}>
      <PartBody part={part} seenBefore={props.seenBefore} dismissed={props.dismissed} now={now} />
    </Section>
  );

  return (
    <>
      {detail ? (
        <div className={s.workGrid}>
          <div className={s.workBody}>
            {props.since.length ? (
              <section className={s.since} aria-labelledby="since-title">
                <h2 className={s.statedLabel} id="since-title">
                  New since you last looked
                </h2>
                <Timeline rows={props.since} scoped tab="activity" first={SINCE_FIRST} noun="changes" now={now} />
              </section>
            ) : null}
            {props.goal}
            {/* A live ask is why the page was opened, so it comes right after what the work is for. */}
            {parts.filter(asksNow).map(section)}
            {props.done.length ? (
              <p className={s.doneNote}>
                {plural(props.done.length, "ask")} marked done.
{" "}
                <button type="button" className="more" onClick={() => change.restore(props.done)}>
                  Bring back
                </button>
              </p>
            ) : null}
            <Stated label="Where it stands" html={detail.body.summary} />
            <Strip work={summary.id} plan={props.plan} viewed={props.viewed} />
            {parts.length === 0 && props.query.trim() ? <p className="nothing">Nothing on this page matches “{props.query.trim()}”.</p> : null}
            {parts.filter((part) => !asksNow(part)).map(section)}
            {props.todos}
            {/* What the page's agent should fix. `progress check` tells it the same, so here it is a note at the foot. */}
            {detail.notes.length ? (
              <details className={`fold ${s.notes}`}>
                <summary>
                  <CaretRightIcon weight="bold" aria-hidden />
                  <span>{plural(detail.notes.length, "thing")} for the agent to fix on this page</span>
                </summary>
                <ul>
                  {detail.notes.map((note) => (
                    <li key={note}>{note}</li>
                  ))}
                </ul>
              </details>
            ) : null}
          </div>
          {parts.length > 1 || props.artifacts ? (
            <div className="side-rail">
              {parts.length > 1 ? <Outline parts={parts} active={active} onPick={pin} /> : null}
              {props.artifacts}
            </div>
          ) : null}
        </div>
      ) : null}
    </>
  );
}

/** A short statement about the whole work, under its label: where things stand. */
function Stated(props: { readonly label: string; readonly html: Html }) {
  if (!props.html.trim()) return null;
  return (
    <div className={s.stated}>
      <p className={s.statedLabel}>{props.label}</p>
      <RichHtml html={props.html} className={s.lead} />
    </div>
  );
}

const STRIP: readonly Exclude<Lane, "needs">[] = ["next", "doing", "shipped"];

/** How much the work has planned, under way and shipped, each a way to its board. */
function Strip(props: { readonly work: WorkId; readonly plan: readonly PlanEntry[]; readonly viewed: MarkSet }) {
  const cards = planCards(props.plan);
  if (cards.length === 0) return null;
  const board = routeHref({ work: props.work, tab: "board" });
  return (
    <nav className={s.strip} aria-label="On its board">
      {STRIP.map((lane) => {
        const mine = cards.filter((card) => card.lane === lane);
        const toView = mine.filter((card) => card.viewKey !== null && !props.viewed.has(card.viewKey)).length;
        const notLive = mine.filter((card) => card.live?.on === false).length;
        const LaneIcon = LANE_ICON[lane];
        return (
          <Link key={lane} href={board} className={s.stripLane} data-lane={lane}>
            <LaneIcon weight="bold" aria-hidden />
            <span className={s.stripCount}>{mine.length}</span>
            <span>{LANE_LABEL[lane].toLowerCase()}</span>
            {notLive > 0 ? <span className={s.stripNote}>{notLive} not live</span> : null}
            {toView > 0 ? <span className={s.stripNote}>{toView} not viewed</span> : null}
          </Link>
        );
      })}
    </nav>
  );
}

function Outline(props: { readonly parts: readonly Part[]; readonly active: string | null; readonly onPick: (id: string) => void }) {
  return (
    <nav aria-label="On this page">
      <p className="outline-title">On this page</p>
      <ul>
        {props.parts.map((part) => (
          <li key={part.id}>
            <button
              type="button"
              className="ol"
              aria-current={props.active === part.id ? "location" : undefined}
              onClick={() => {
                props.onPick(part.id);
                document.getElementById(part.id)?.scrollIntoView({ block: "start", behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
              }}
            >
              <span className="ol-name">{part.title}</span>
              {part.fresh ? <span className={s.olNew} role="img" aria-label={part.fresh} title={`${part.fresh} since you last looked`} /> : null}
              {part.count === null ? null : <span className="n">{part.count}</span>}
            </button>
          </li>
        ))}
      </ul>
    </nav>
  );
}

function Section(props: { readonly part: Part; readonly children: ReactNode }) {
  const { part } = props;
  return (
    <section className={s.sec} data-tone={part.tone} id={part.id} aria-labelledby={`${part.id}-h`}>
      <h2 className={s.secHead} id={`${part.id}-h`}>
        <span className={s.secLine}>
          <span className="sec-title">{part.title}</span>
          {part.count === null ? null : <span className="n">{part.count}</span>}
          {part.detail ? <span className={s.secDetail}>{part.detail}</span> : null}
          {part.fresh ? <span className={s.new}>{part.fresh}</span> : null}
        </span>
      </h2>
      {props.children}
    </section>
  );
}

function PartBody(props: { readonly part: Part; readonly seenBefore: Instant; readonly dismissed: Dismissed; readonly now: number }) {
  const { part, now } = props;
  const change = props.dismissed.change;
  switch (part.kind) {
    case "needs":
      return (
        <>
          {part.entries.map((entry) => (
            <NeedCard key={needKey(entry)} entry={entry} quiet={part.leftover} onDone={() => change.dismiss([needKey(entry)])} now={now} />
          ))}
        </>
      );
    case "agents":
      return (
        <details className="fold">
          <summary>
            <CaretRightIcon weight="bold" aria-hidden />
            <span className="when-closed">Show {plural(part.agents.length, "agent")}</span>
            <span className="when-open">Hide {plural(part.agents.length, "agent")}</span>
          </summary>
          {part.sharedBranch ? (
            <p className={`${s.secNote} prose-inline`}>
              All on <code>{part.sharedBranch}</code>
            </p>
          ) : null}
          <AgentList agents={part.agents} branches={part.sharedBranch === null} now={now} />
        </details>
      );
    case "items": {
      const { items } = part.section;
      return (
        <>
          <RichHtml html={part.section.html} />
          <Fold show={8} noun={part.title.toLowerCase()} className="timeline">
            {items.map((item, index) => (
              <Entry
                key={item.id}
                kind="decided"
                weight={item.important ? "high" : "normal"}
                html={item.titleHtml}
                body={item.html}
                important={item.important}
                fresh={freshness(item.since, item.editedAt, props.seenBefore)}
                at={item.since}
                sameTime={relative(item.since, now) === relative(items[index - 1]?.since ?? null, now)}
                now={now}
              />
            ))}
          </Fold>
        </>
      );
    }
    case "prose":
      return <RichHtml html={part.section.html} />;
  }
}

function AgentList(props: { readonly agents: readonly Agent[]; readonly branches: boolean; readonly now: number }) {
  return (
    <ul className={`rows ${s.agents}`}>
      {props.agents.map((agent) => (
        <li key={agent.thread}>
          <a className={s.agent} data-status={agent.status} href={agent.link}>
            <span className={s.dot} aria-hidden />
            <span className={s.agentBody}>
              <span className={s.agentTitle}>{agent.title}</span>
              <span className={s.agentMeta}>
                {[agent.model === null ? null : modelName(agent.model), agent.account, props.branches ? agent.branch : null].filter(Boolean).join(" · ")}
              </span>
            </span>
            <span className={s.agentStatus}>
              <span className={s.agentLabel}>{AGENT_STATUS[agent.status].label}</span>
              <When at={agent.lastActivityAt} now={props.now} />
            </span>
          </a>
        </li>
      ))}
    </ul>
  );
}
