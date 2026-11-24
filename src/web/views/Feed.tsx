import { useMemo, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import { CaretRightIcon, GitPullRequestIcon, HandPalmIcon, ListChecksIcon, PencilSimpleIcon, PulseIcon, RocketLaunchIcon, SignpostIcon, StarIcon } from "@phosphor-icons/react";
import type { Icon } from "@phosphor-icons/react";
import type { FeedDay, FeedLine, FeedRow, Tone } from "../lib/feed.ts";
import { filterDays, TONE_LABEL } from "../lib/feed.ts";
import { viewedOf } from "../lib/marks.ts";
import type { MarkSet } from "../lib/marks.ts";
import { firstImage } from "../lib/html.ts";
import { routeHref } from "../lib/route.ts";
import type { Tab } from "../lib/route.ts";
import { relative } from "../lib/time.ts";
import { plural } from "../lib/works.ts";
import { Entry } from "./Entry.tsx";
import type { EntryProps } from "./Entry.tsx";
import { Fold, ListHead } from "./parts.tsx";
import s from "./Feed.module.css";

interface FeedProps {
  readonly days: readonly FeedDay[];
  /** Every post is from the open work, so none says which work it is from. */
  readonly scoped: boolean;
  readonly empty: string;
  /** The tab these lines are on, for the links to each work's own. */
  readonly tab: Tab;
  /** The feed holds something the Important switch would keep, whatever the filter shows now. */
  readonly hasImportant: boolean;
  /** What the user marked as viewed. A line that shipped shows its mark. */
  readonly viewed: MarkSet;
  /** What opens the feed's column, above its filters: a work's goal. */
  readonly lead?: ReactNode;
  /** What the list is called: the tab's name. On Home `sub` says what it covers. */
  readonly title: string;
  readonly sub?: string;
  /** What sits above the feed on a work: the work's head. */
  /** What stands beside the feed, under its days: a work's artifacts. */
  readonly aside?: ReactNode;
  readonly children?: ReactNode;
  readonly now: number;
}


/**
 * What happened, as a timeline: a day, then each change at its time, with a dot on the rail that says
 * what kind it was. Home and a work read the same way; on Home each line also says which work it is from.
 * Small updates fold into one line.
 */
export function Feed(props: FeedProps) {
  const { viewed } = props;
  const [starred, setStarred] = useState(false);
  const [types, setTypes] = useState<ReadonlySet<Kind>>(new Set());
  // Activity holds every kind of change, so it can be narrowed to some kinds. A kind is offered only while the feed has it.
  const kinds = useMemo(() => KINDS.filter(({ kind }) => props.days.some((day) => day.rows.some(({ line }) => kindOf(line) === kind))), [props.days]);
  const chosen = kinds.filter(({ kind }) => types.has(kind)).map(({ kind }) => kind);
  const importantOnly = starred && props.hasImportant;
  const narrowed = importantOnly || chosen.length > 0;
  const days = useMemo(
    () => (narrowed ? filterDays(props.days, (line) => (!importantOnly || line.weight === "high") && (chosen.length === 0 || chosen.includes(kindOf(line)))) : props.days),
    [props.days, narrowed, importantOnly, chosen.join()],
  );
  const toggle = (kind: Kind) => setTypes(new Set(types.has(kind) ? [...types].filter((k) => k !== kind) : [...types, kind]));
  const tools =
    kinds.length > 1 || props.hasImportant ? (
      <>
        {kinds.length > 1
          ? kinds.map(({ kind, Icon, label }) => (
              <button key={kind} type="button" className="icon-btn tool" aria-pressed={types.has(kind)} aria-label={label} title={types.has(kind) ? `Showing ${label.toLowerCase()}. Click to stop narrowing to them.` : chosen.length ? `Show ${label.toLowerCase()} too` : `Show only ${label.toLowerCase()}`} onClick={() => toggle(kind)}>
                <Icon aria-hidden />
              </button>
            ))
          : null}
        {props.hasImportant ? (
          <button type="button" className={`icon-btn tool ${s.starTool}`} aria-pressed={importantOnly} aria-label="Only what is marked important" title={importantOnly ? "Showing only what pages marked important. Click to show everything." : "Show only what pages marked important"} onClick={() => setStarred(!starred)}>
            <StarIcon weight={importantOnly ? "fill" : "regular"} aria-hidden />
          </button>
        ) : null}
      </>
    ) : null;
  return (
    <div className="wrap">
      {props.children}
      <div className="feed-grid">
        <div className="feed-main">
          {props.lead}
          <ListHead title={props.title} sub={props.sub} scoped={props.scoped}>
            {tools}
          </ListHead>
          {days.map((day) => (
            <Day key={day.key} day={day} scoped={props.scoped} tab={props.tab} viewed={viewed} now={props.now} />
          ))}
          {days.length ? null : <p className="nothing">{props.days.length === 0 ? props.empty : chosen.length > 0 ? "Nothing of the kinds you picked is here." : "Nothing here is marked important."}</p>}
        </div>
        {days.length > 1 || props.aside ? (
          <div className="side-rail">
            {days.length > 1 ? <Rail days={days} /> : null}
            {props.aside}
          </div>
        ) : null}
      </div>
    </div>
  );
}

/** The kinds of change Activity can be narrowed to, each with the icon its button shows. */
type Kind = "shipped" | "needs" | "decided" | "plan" | "prs" | "status" | "edits";

const KINDS: readonly { readonly kind: Kind; readonly Icon: Icon; readonly label: string }[] = [
  { kind: "shipped", Icon: RocketLaunchIcon, label: "What shipped" },
  { kind: "needs", Icon: HandPalmIcon, label: "Asks of you" },
  { kind: "decided", Icon: SignpostIcon, label: "Decisions" },
  { kind: "plan", Icon: ListChecksIcon, label: "What is in progress or next" },
  { kind: "prs", Icon: GitPullRequestIcon, label: "Pull requests opened or closed" },
  { kind: "status", Icon: PulseIcon, label: "Status updates" },
  { kind: "edits", Icon: PencilSimpleIcon, label: "Edits to a page" },
];

function kindOf(line: FeedLine): Kind {
  if (line.kind === "pr") return line.change === "merged" ? "shipped" : "prs";
  switch (line.tone) {
    case "shipped":
    case "live":
      return "shipped";
    case "needs":
    case "asked":
    case "cleared":
      return "needs";
    case "decided":
      return "decided";
    case "doing":
    case "next":
      return "plan";
    case "edited":
    case "written":
    case "dropped":
      return "edits";
    default:
      return "status";
  }
}

/** Beside the feed: each day with how much it holds. Like the outline of a work's page, a row jumps to its place on this screen. */
function Rail(props: { readonly days: readonly FeedDay[] }) {
  // One day says nothing the screen doesn't.
  if (props.days.length < 2) return null;
  return (
    <nav className={s.rail} aria-label="Days">
      <p className="outline-title">By day</p>
      <ul>
        {props.days.map((day) => (
          <li key={day.key}>
            <button type="button" className="ol" onClick={() => document.getElementById(`day-${day.key}`)?.scrollIntoView({ block: "start" })}>
              <span className="ol-name">{day.label}</span>
              <span className="n">{day.rows.length}</span>
            </button>
          </li>
        ))}
      </ul>
    </nav>
  );
}

/** One day of the feed: what matters, then the small updates folded into one line. */
function Day(props: { readonly day: FeedDay; readonly scoped: boolean; readonly tab: Tab; readonly viewed: MarkSet; readonly now: number }) {
  const { day } = props;
  const shown = day.rows.filter(({ line }) => line.weight !== "low");
  const small = day.rows.filter(({ line }) => line.weight === "low");
  // A day of only small updates shows them; there is nothing to fold them under.
  const rows = shown.length ? shown : small;
  const folded = shown.length ? small : [];
  return (
    <section className="day" id={`day-${day.key}`}>
      <h2 className="day-head">{day.label}</h2>
      <Timeline rows={rows} scoped={props.scoped} tab={props.tab} viewed={props.viewed} now={props.now} />
      {folded.length ? (
        <details className="fold">
          <summary>
            <CaretRightIcon weight="bold" aria-hidden />
            <span className="when-closed">Show {plural(folded.length, "smaller update")}</span>
            <span className="when-open">Hide {plural(folded.length, "smaller update")}</span>
          </summary>
          {/* A busy day's small updates run long. They open ten at a time. */}
          <Timeline rows={folded} scoped={props.scoped} tab={props.tab} viewed={props.viewed} first={10} now={props.now} />
        </details>
      ) : null}
    </section>
  );
}

/** Lines of the feed as a timeline, on any screen that tells what happened. */
export function Timeline(props: { readonly rows: readonly FeedRow[]; readonly scoped: boolean; readonly tab: Tab; readonly viewed?: MarkSet | undefined; readonly first?: number; readonly noun?: string; readonly now: number }) {
  return (
    <Fold show={props.first ?? props.rows.length} noun={props.noun ?? "smaller updates"} className="timeline">
      {props.rows.map((row, index) => (
        <Line
          key={row.at + index}
          row={row}
          // On Home a row says which work it is from, and goes to the same tab of that work. That is all that differs from a work's own tab.
          from={props.scoped ? undefined : { title: row.workTitle, project: row.project ?? row.work, href: routeHref({ work: row.work, tab: props.tab }) }}
          sameTime={relative(row.at, props.now) === relative(props.rows[index - 1]?.at ?? null, props.now)}
          viewed={props.viewed}
          now={props.now}
        />
      ))}
    </Fold>
  );
}

const PR_VERB = { opened: "Opened", closed: "Closed" } as const;

function Line(props: { readonly row: FeedRow; readonly from: EntryProps["from"]; readonly sameTime: boolean; readonly viewed: MarkSet | undefined; readonly now: number }) {
  const viewed = props.viewed ? viewedOf(props.viewed, props.row.line.key) : undefined;
  const { line, at } = props.row;
  const shared = { from: props.from, at, sameTime: props.sameTime, now: props.now };
  const image = useMemo(() => (line.kind === "text" && line.html ? firstImage(line.html) : null), [line]);
  if (line.kind === "pr") {
    // A merge no line names is something that shipped, drawn as one: the pull request's title stands in for the line, as on the work's page.
    if (line.change === "merged") {
      return <Entry kind="shipped" weight={line.weight} text={line.pr.title} prs={[line.pr]} viewed={viewed} {...shared} />;
    }
    // The dot says what happened then, not what the pull request has become since. Its chip says that and opens it.
    return <Entry kind={line.change} weight={line.weight} label={PR_VERB[line.change]} text={line.pr.title} prs={[line.pr]} {...shared} />;
  }
  return (
    <Entry
      kind={line.tone}
      weight={line.weight}
      // What shipped is the feed's everyday line: its green dot says so, and only the other kinds are named.
      label={line.tone === "shipped" ? undefined : TONE_LABEL[line.tone]}
      html={line.titleHtml}
      text={line.text}
      prs={line.prs}
      commits={line.commits}
      important={line.weight === "high" && line.tone !== "needs"}
      viewed={viewed}
      {...shared}
    >
      {image ? (
        // The line's picture, small. It opens large like any picture of a page; one from elsewhere opens where it lives.
        <a className="fig" aria-label={`Open the picture for: ${line.text}`} href={image.src.replace(/\?v=\d+$/, "")} {...(image.src.startsWith("/files/") ? {} : { target: "_blank", rel: "noopener noreferrer" })}>
          <img className="shot" src={image.src} style={(image.size ?? undefined) as CSSProperties | undefined} alt="" loading="lazy" />
        </a>
      ) : null}
    </Entry>
  );
}
