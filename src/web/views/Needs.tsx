import type { ReactNode } from "react";
import { CaretRightIcon, ChatCircleDotsIcon, CheckCircleIcon, QuestionIcon, ShieldCheckIcon, XIcon } from "@phosphor-icons/react";
import type { NeedEntry, Stall } from "../../core/types.ts";
import type { Dismissed } from "../lib/dismissed.ts";
import { needKey, needSince, nothingWaiting } from "../lib/needs.ts";
import { routeHref } from "../lib/route.ts";
import { plural } from "../lib/works.ts";
import { Ago, Important, InlineHtml, Link, ListHead, RichHtml, ThreadButton } from "./parts.tsx";
import s from "./Needs.module.css";

interface NeedsProps {
  /** On ongoing work, oldest first. */
  readonly needs: readonly NeedEntry[];
  /** Still written on the page of work that is over. These can be dismissed. */
  readonly settled: readonly NeedEntry[];
  readonly dismissed: Dismissed;
  /** Every card is from the open work, so none says which work it is from. */
  readonly scoped: boolean;
  readonly query: string;
  /** The harnesses that can't be read now, by name. */
  readonly unread: readonly string[];
  /** On Home, what the list covers. */
  readonly sub?: string;
  /** What sits above the list on a work: the work's head and goal. */
  readonly children?: ReactNode;
  readonly now: number;
}

export function Needs(props: NeedsProps) {
  const { needs, dismissed } = props;
  const left = props.settled.filter((entry) => !dismissed.has(needKey(entry)));
  const gone = props.settled.filter((entry) => dismissed.has(needKey(entry)));
  return (
    <div className={`wrap ${s.needsView}`}>
      {props.children}
      <ListHead title="Needs you" sub={props.sub} scoped={props.scoped} />
      {needs.map((entry) => (
        <NeedCard key={needKey(entry)} entry={entry} scoped={props.scoped} now={props.now} />
      ))}
      {needs.length ? null : props.query ? (
        <p className="nothing">Nothing matches “{props.query}”.</p>
      ) : (
        <p className={s.allClear}>
          <CheckCircleIcon weight="fill" aria-hidden />
          {nothingWaiting(props.unread)}
        </p>
      )}
      {left.length ? (
        // What settled work still lists may no longer matter, so it stays folded where live asks are read. On the work's own tab it is all there is.
        <details className={`fold ${s.leftover}`} open={props.scoped}>
          <summary>
            <CaretRightIcon weight="bold" aria-hidden />
            <span className="when-closed">Show {left.length} left on settled work</span>
            <span className="when-open">Hide {left.length} left on settled work</span>
          </summary>
          <div className={s.leftoverHead}>
            <p>Still on pages you settled. Dismiss what's done.</p>
            <button type="button" className="btn" onClick={() => dismissed.dismiss(left.map(needKey))}>
              Dismiss all {left.length}
            </button>
          </div>
          {left.map((entry) => (
            <NeedCard key={needKey(entry)} entry={entry} scoped={props.scoped} onDismiss={() => dismissed.dismiss([needKey(entry)])} now={props.now} />
          ))}
        </details>
      ) : null}
      {gone.length ? (
        <p className={s.dismissedNote}>
          {plural(gone.length, "dismissed item")} hidden.{" "}
          <button type="button" className="more" onClick={() => dismissed.restore(gone.map(needKey))}>
            Show again
          </button>
        </p>
      ) : null}
    </div>
  );
}

/** One thing that needs the user, drawn the same on the Needs you tab and on a work's page. */
export function NeedCard(props: { readonly entry: NeedEntry; readonly scoped: boolean; readonly onDismiss?: (() => void) | undefined; readonly now: number }) {
  const { entry } = props;
  const stalled = entry.source === "stall";
  return (
    <article className={`${s.need}${stalled ? " stalled" : ""}${props.onDismiss ? ` ${s.leftoverItem}` : ""}`} id={needKey(entry)}>
      <div className={s.needTop}>
        <h3>
          {entry.source === "page" && entry.important ? <Important /> : null}
          {entry.source === "page" ? <InlineHtml html={entry.titleHtml} /> : entry.agentTitle}
        </h3>
        {props.onDismiss ? (
          <button type="button" className="icon-btn" onClick={props.onDismiss} aria-label="Dismiss" title="Dismiss">
            <XIcon aria-hidden />
          </button>
        ) : null}
      </div>
      <p className={s.needSrc}>
        {props.scoped || !entry.work ? null : (
          <>
            <Link href={routeHref({ work: entry.work, tab: "needs" })}>{entry.workTitle}</Link>
            {" · "}
          </>
        )}
        <Ago verb={stalled ? "stopped" : "added"} at={needSince(entry)} now={props.now} />
      </p>
      {entry.source === "page" ? (
        <>
          <RichHtml html={entry.html} />
          {entry.repliedSince ? (
            <p className={s.replied}>
              <ChatCircleDotsIcon aria-hidden />
              You've written in the thread since, so this may be settled.
            </p>
          ) : null}
          <div className={s.acts}>
            <ThreadButton href={entry.threadLink} label="Answer in thread" />
          </div>
        </>
      ) : (
        <>
          <StallBody stall={entry.stall} />
          <div className={s.acts}>
            <ThreadButton href={entry.threadLink} label={entry.stall.ask === "approval" ? "Allow or deny in thread" : "Answer in thread"} />
          </div>
        </>
      )}
    </article>
  );
}

/** What a stalled agent waits on, with the question or command in full. */
function StallBody(props: { readonly stall: Stall }) {
  const { stall } = props;
  const approval = stall.ask === "approval";
  return (
    <>
      <p className={s.ask}>
        {approval ? <ShieldCheckIcon aria-hidden /> : <QuestionIcon aria-hidden />}
        {approval ? "Waiting for your approval to run:" : "Waiting for your answer:"}
      </p>
      {stall.text === null ? (
        <p className={s.muted}>The {approval ? "action" : "question"} wasn't kept. It's in the thread.</p>
      ) : approval ? (
        <pre className="cmd">
          <code>{stall.text}</code>
        </pre>
      ) : (
        <p className={`${s.askText} prose-inline`}>
          {/* A harness keeps the question as plain text. Text between backticks is code, as it is on a page. */}
          {stall.text.split("`").map((piece, index) => (index % 2 === 1 ? <code key={index}>{piece}</code> : piece))}
        </p>
      )}
    </>
  );
}
