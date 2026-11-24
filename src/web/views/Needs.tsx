import { ChatCircleDotsIcon, CheckIcon, QuestionIcon, ShieldCheckIcon } from "@phosphor-icons/react";
import { LONG_TITLE } from "../../core/text.ts";
import type { NeedEntry, Stall } from "../../core/types.ts";
import { needKey, needSince } from "../lib/needs.ts";
import { Ago, Important, InlineHtml, RichHtml, ThreadButton } from "./parts.tsx";
import s from "./Needs.module.css";

/**
 * One thing that needs the user, in full, on a work's Home. `quiet` is for what settled work still lists,
 * which may no longer matter. Marking it done takes it off the user's lists and leaves the page as it is.
 */
export function NeedCard(props: { readonly entry: NeedEntry; readonly quiet?: boolean; readonly onDone: () => void; readonly now: number }) {
  const { entry } = props;
  const stalled = entry.source === "stall";
  return (
    <article className={`${s.need}${stalled ? " stalled" : ""}`} data-quiet={props.quiet || undefined} id={needKey(entry)}>
      {/* An ask written as one paragraph is read as one, not shouted as a heading. */}
      <h3 data-long={(entry.source === "page" && entry.title.length > LONG_TITLE) || undefined}>
        {entry.source === "page" && entry.important ? <Important /> : null}
        {entry.source === "page" ? <InlineHtml html={entry.titleHtml} /> : entry.agentTitle}
      </h3>
      <p className={s.needSrc}>
        <Ago verb={stalled ? "stopped" : "added"} at={needSince(entry)} now={props.now} />
      </p>
      <AskBody entry={entry} />
      <div className={s.acts}>
        <AskThread entry={entry} />
        <button type="button" className="btn" title="It leaves your lists. The page is not changed." onClick={props.onDone}>
          <CheckIcon aria-hidden />
          Mark done
        </button>
      </div>
    </article>
  );
}

/** An ask in full, under its title: what its page wrote, or what a stalled agent waits on. The board's open card and a work's Home both show this. */
export function AskBody(props: { readonly entry: NeedEntry }) {
  const { entry } = props;
  if (entry.source === "stall") return <StallBody stall={entry.stall} />;
  return (
    <>
      <RichHtml html={entry.html} />
      {entry.repliedSince ? (
        <p className={s.replied}>
          <ChatCircleDotsIcon aria-hidden />
          You've written in the thread since, so this may be settled.
        </p>
      ) : null}
    </>
  );
}

/** The way to answer an ask: its agent's thread, named for what is asked there. */
export function AskThread(props: { readonly entry: NeedEntry }) {
  const { entry } = props;
  return <ThreadButton href={entry.threadLink} label={entry.source === "stall" && entry.stall.ask === "approval" ? "Allow or deny in thread" : "Answer in thread"} />;
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
