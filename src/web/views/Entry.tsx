import { useMemo } from "react";
import type { ReactNode } from "react";
import { CheckCircleIcon, CircleIcon } from "@phosphor-icons/react";
import type { Commit, Html, Instant, PullRequest } from "../../core/types.ts";
import type { Weight } from "../lib/feed.ts";
import { sanitize, withoutLeadingRef, withoutTrailingCommits } from "../lib/html.ts";
import { Avatar, Important, Link, RefChips, RichHtml, useProjectColour, When } from "./parts.tsx";
import s from "./Entry.module.css";

export interface EntryProps {
  /** What kind of change this is: it colours the dot. "shipped", "needs", "decided", "merged" and so on. */
  readonly kind: string;
  readonly weight: Weight;
  /** The kind in words, before the line. Left out where the screen or section already says it. */
  readonly label?: string | undefined;
  /** The line as inline HTML, as the page wrote it. */
  readonly html?: Html | null | undefined;
  /** The line as plain text, used when there is no HTML. */
  readonly text?: string;
  /** What the page wrote under the line. */
  readonly body?: Html | undefined;
  readonly prs?: readonly PullRequest[];
  readonly commits?: readonly Commit[];
  /** The page marked the line as one not to miss. */
  readonly important?: boolean;
  /** New since the user last had the page open. */
  readonly fresh?: boolean;
  readonly at: Instant | null;
  /** The line above shows the same time, so this one leaves it out and a burst reads as one moment. */
  readonly sameTime?: boolean;
  /** Where the line is from, on a screen that holds more than one work: the work's name, its project's face and the way to it. */
  readonly from?: { readonly title: string; readonly project: string; readonly href: string } | undefined;
  /** For something that shipped: whether the user marked it as looked at, and the click that changes that. */
  readonly viewed?: { readonly on: boolean; readonly set: (on: boolean) => void } | undefined;
  readonly now: number;
  readonly children?: ReactNode;
}

/**
 * One thing that happened, drawn the same wherever it shows: a dot that says what kind it was, the line
 * as its page wrote it, its pull requests under it with their titles, and when.
 */
export function Entry(props: EntryProps) {
  const prs = props.prs ?? [];
  const commits = props.commits ?? [];
  const line = useMemo(() => (props.html ? withoutTrailingCommits(sanitize(withoutLeadingRef(props.html, prs, commits)) as Html, commits) : null), [props.html, prs, commits]);
  const lineProps = line === null ? { children: props.text ?? "" } : { dangerouslySetInnerHTML: { __html: line } };
  const viewed = props.viewed;
  const colour = useProjectColour(props.from?.project ?? "");
  return (
    <li style={props.from ? colour : undefined} className={`${s.tl}${props.fresh ? ` ${s.fresh}` : ""}${props.from ? ` ${s.from}` : ""}${viewed?.on ? ` ${s.viewed}` : ""}`} data-weight={props.weight} data-kind={props.kind} title={props.fresh ? "New since you last looked" : undefined}>
      <span className={s.tlDot} aria-hidden />
      <div className={s.tlBody}>
        {props.from ? (
          <Link href={props.from.href} className="tl-from">
            <Avatar project={props.from.project} fallback={props.from.project} size="xs" />
            <span>{props.from.title}</span>
          </Link>
        ) : null}
        <p className={`${s.tlText} prose-inline`}>
          {props.important ? <Important /> : null}
          {props.label ? <span className={s.tone}>{props.label}</span> : null}
          <span className={s.tlLine} {...lineProps} />
        </p>
        {props.body ? <RichHtml html={props.body} className={s.tlMore} /> : null}
        <RefChips prs={prs} commits={commits} said={props.text} />
        {props.children}
      </div>
      {props.at ? <When at={props.at} now={props.now} className={`${s.stamp}${props.sameTime ? ` ${s.same}` : ""}`} /> : null}
      {viewed ? (
        <button type="button" className={s.tlView} aria-pressed={viewed.on} aria-label="Viewed" title={viewed.on ? "Viewed. Click to mark as not viewed." : "Mark as viewed"} onClick={() => viewed.set(!viewed.on)}>
          {viewed.on ? <CheckCircleIcon weight="fill" aria-hidden /> : <CircleIcon aria-hidden />}
        </button>
      ) : null}
    </li>
  );
}
