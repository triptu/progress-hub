import type { ReactNode, RefObject } from "react";
import { CaretRightIcon, WarningIcon } from "@phosphor-icons/react";
import type { Agent, Html, Instant, NeedEntry, WorkDetail, WorkId, WorkSummary } from "../../core/types.ts";
import { viewedOf, viewKey } from "../lib/marks.ts";
import type { MarkSet } from "../lib/marks.ts";
import type { MediaItem } from "../lib/media.ts";
import { usePersisted } from "../lib/persist.ts";
import { modelName } from "../lib/model.ts";
import { needKey } from "../lib/needs.ts";
import { AGENT_STATUS, isFresh, partsOf } from "../lib/outline.ts";
import type { Part } from "../lib/outline.ts";
import { useActiveSection } from "../lib/spy.ts";
import { PHASE_LABEL, phaseOf, plural } from "../lib/works.ts";
import { relative } from "../lib/time.ts";
import { Entry } from "./Entry.tsx";
import { Tile } from "./Media.tsx";
import { NeedCard } from "./Needs.tsx";
import { Ago, Avatar, Fold, PrRow, RichHtml, ThreadButton, TryLinks, When } from "./parts.tsx";
import s from "./WorkPage.module.css";

/**
 * A work's name, the way to its thread, and one line under the name: its project, what it is doing and
 * when it last changed. It sits above every tab of the work and is the same on each.
 */
export function WorkHead(props: { readonly summary: WorkSummary; readonly fresh: number; readonly now: number }) {
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
        {props.fresh > 0 ? <span className={s.new}>{props.fresh} new</span> : null}
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
  /** What this work needs from the user, from the hub's list, without what they dismissed. */
  readonly needs: readonly NeedEntry[];
  readonly onDismiss: (key: string) => void;
  /** What the work's page shows, newest first. */
  readonly media: readonly MediaItem[];
  /** What the work is for, which opens the page as it opens every tab. */
  readonly goal: ReactNode;
  /** The files the work made, listed under the outline. */
  readonly artifacts: ReactNode;
  /** The filter. Sections keep what matches it. */
  readonly query: string;
  /** When the user last had this page open before now. Anything newer is marked new. */
  readonly seenBefore: Instant;
  /** What the user marked as viewed. Each Shipped line has a mark to click. */
  readonly viewed: MarkSet;
  /** The element that scrolls the page, which the outline follows. */
  readonly scroller: RefObject<HTMLElement | null>;
  readonly now: number;
}

/** How many items on a work's page are new since `seenBefore`. */
export function freshCount(detail: WorkDetail | null, seenBefore: Instant): number {
  return detail ? partsOf(detail, [], [], seenBefore).reduce((sum, part) => sum + part.fresh, 0) : 0;
}

/** The whole page of one work: every section, in reading order, with an outline beside it. */
export function WorkPage(props: WorkPageProps) {
  const { summary, detail, now } = props;
  const parts = detail ? partsOf(detail, props.needs, props.media, props.seenBefore, props.query) : [];
  const [active, pin] = useActiveSection(
    parts.map((part) => part.id),
    props.scroller,
  );
  const asksNow = (part: Part) => part.kind === "needs" && !part.leftover;
  const section = (part: Part) => (
    <Section key={part.id} part={part}>
      <PartBody part={part} work={summary.id} seenBefore={props.seenBefore} viewed={props.viewed} onDismiss={props.onDismiss} now={now} />
    </Section>
  );

  return (
    <>
      {detail?.notes.length ? (
        <details className={s.notes}>
          <summary>
            <WarningIcon aria-hidden />
            {plural(detail.notes.length, "thing")} to fix on this page
          </summary>
          <ul>
            {detail.notes.map((note) => (
              <li key={note}>{note}</li>
            ))}
          </ul>
        </details>
      ) : null}

      {detail ? (
        <div className={s.workGrid}>
          <div className={s.workBody}>
            {props.goal}
            {/* A live ask is why the page was opened, so it comes right after what the work is for. */}
            {parts.filter(asksNow).map(section)}
            <Stated label="Where it stands" html={detail.body.summary} />
            {parts.length === 0 && props.query.trim() ? <p className="nothing">Nothing on this page matches “{props.query.trim()}”.</p> : null}
            {parts.filter((part) => !asksNow(part)).map(section)}
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
              {part.fresh > 0 ? <span className={s.olNew} role="img" aria-label={`${part.fresh} new`} title={`${part.fresh} new since you last looked`} /> : null}
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
          {part.fresh > 0 ? <span className={s.new}>{part.fresh} new</span> : null}
        </span>
      </h2>
      {props.children}
    </section>
  );
}

function PartBody(props: { readonly part: Part; readonly work: WorkId; readonly seenBefore: Instant; readonly viewed: MarkSet; readonly onDismiss: (key: string) => void; readonly now: number }) {
  const { part, now } = props;
  switch (part.kind) {
    case "needs":
      return (
        <>
          {part.entries.map((entry) => (
            <NeedCard key={needKey(entry)} entry={entry} scoped onDismiss={part.leftover ? () => props.onDismiss(needKey(entry)) : undefined} now={now} />
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
      const items = part.section?.items ?? [];
      // The dot's kind: what shipped, what is under way, what is planned, and a decision for the rest.
      const kind = part.tone === "shipped" || part.tone === "doing" || part.tone === "next" ? part.tone : "decided";
      return (
        <>
          {part.section ? <RichHtml html={part.section.html} /> : null}
          <Fold show={8} noun={part.title.toLowerCase()} className="timeline">
            {items.map((item, index) => (
              <Entry
                key={item.id}
                kind={kind}
                weight={item.important ? "high" : "normal"}
                html={item.titleHtml}
                body={item.html}
                prs={item.prs}
                commits={item.commits}
                important={item.important}
                fresh={isFresh(item.since, props.seenBefore)}
                at={item.since}
                sameTime={relative(item.since, now) === relative(items[index - 1]?.since ?? null, now)}
                viewed={kind === "shipped" ? viewedOf(props.viewed, viewKey(props.work, item.id)) : undefined}
                now={now}
              />
            ))}
            {/* What merged without a line of its own: the pull request's title stands in for one. */}
            {part.merged.map((pr) => (
              <Entry key={pr.url} kind="shipped" weight="normal" text={pr.title} prs={[pr]} at={pr.mergedAt} viewed={viewedOf(props.viewed, pr.url)} now={now} />
            ))}
          </Fold>
        </>
      );
    }
    case "prs":
      return (
        <Fold show={10} noun="open pull requests" className={`rows ${s.refs}`}>
          {part.prs.map((pr) => (
            <li key={pr.url}>
              <PrRow pr={pr} plain={part.detail !== ""} />
            </li>
          ))}
        </Fold>
      );
    case "prose":
      return <RichHtml html={part.section.html} />;
    case "media":
      return (
        <div className="tiles">
          {part.items.map((item) => (
            <Tile key={item.src} item={item} scope={props.work} />
          ))}
        </div>
      );
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
