import { Children, createContext, useContext, useMemo, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import { ArrowSquareOutIcon, CaretRightIcon, FileHtmlIcon, GitCommitIcon, GlobeSimpleIcon, GitMergeIcon, GitPullRequestIcon, StarIcon, XCircleIcon } from "@phosphor-icons/react";
import type { Commit, Html, Instant, OpenLink, PullRequest, WorkId, WorkSummary } from "../../core/types.ts";
import { sanitize } from "../lib/html.ts";
import { projectLook } from "../lib/project.ts";
import { followLink } from "../lib/route.ts";
import { exact, relative } from "../lib/time.ts";
import { PHASE_LABEL, phaseOf } from "../lib/works.ts";
import s from "./parts.module.css";

export function Link(props: { readonly href: string; readonly className?: string; readonly style?: CSSProperties; readonly title?: string; readonly current?: boolean; readonly children: ReactNode }) {
  return (
    <a href={props.href} className={props.className} style={props.style} title={props.title} aria-current={props.current ? "page" : undefined} onClick={followLink}>
      {props.children}
    </a>
  );
}

export function When(props: { readonly at: Instant; readonly now: number; readonly className?: string }) {
  return (
    <time className={props.className ?? "when"} dateTime={props.at} title={exact(props.at)}>
      {relative(props.at, props.now)}
    </time>
  );
}

/** "added 5m ago", "stopped just now": when something happened, in words. */
export function Ago(props: { readonly verb: string; readonly at: Instant; readonly now: number; readonly className?: string }) {
  const recent = props.now - Date.parse(props.at) < 60_000;
  return (
    <span className={props.className}>
      {props.verb}{" "}
      <time dateTime={props.at} title={exact(props.at)}>
        {recent ? "just now" : `${relative(props.at, props.now)} ago`}
      </time>
    </span>
  );
}

/** The look of each project on screen; App gives it the projects the hub holds. */
export const ProjectLooks = createContext(projectLook);

/** The colour a work's project has on screen, as the style that hands it to CSS. */
export function useProjectColour(project: string): CSSProperties {
  return { "--proj": useContext(ProjectLooks)(project).colour } as CSSProperties;
}

/**
 * A work's face: its project's icon on a tile of the project's colour. With `work`, a dot in the corner
 * says it needs the user or has agents running.
 */
export function Avatar(props: { readonly project: string | null; readonly fallback: string; readonly work?: WorkSummary; readonly size?: "xs" | "s" | "m" }) {
  const { Icon, colour } = useContext(ProjectLooks)(props.project ?? props.fallback);
  const phase = props.work ? phaseOf(props.work) : null;
  return (
    <span className={`avatar${phase === "settled" ? " quiet" : ""}`} data-size={props.size ?? "m"} style={{ "--proj": colour } as CSSProperties}>
      <Icon aria-hidden />
      {phase === "needs" || phase === "working" ? <span className="avatar-dot" data-phase={phase} role="img" aria-label={PHASE_LABEL[phase]} title={PHASE_LABEL[phase]} /> : null}
    </span>
  );
}

/** What a work is doing, as a word in a small pill. */
export function PhasePill(props: { readonly work: WorkSummary }) {
  const phase = phaseOf(props.work);
  return <span className="pill" data-phase={phase}>{PHASE_LABEL[phase]}</span>;
}

/** The mark of an item its page flagged as one not to miss. */
export function Important() {
  return (
    <span className={s.star} role="img" aria-label="Marked important" title="The page marked this as important">
      <StarIcon weight="fill" aria-hidden />
    </span>
  );
}

export function RichHtml(props: { readonly html: Html; readonly className?: string }) {
  const clean = useMemo(() => sanitize(props.html), [props.html]);
  if (!clean.trim()) return null;
  return <div className={`prose ${props.className ?? ""}`} dangerouslySetInnerHTML={{ __html: clean }} />;
}

/** An item's title line: server HTML with no block around it. */
export function InlineHtml(props: { readonly html: Html }) {
  const clean = useMemo(() => sanitize(props.html), [props.html]);
  return <span className="prose-inline" dangerouslySetInnerHTML={{ __html: clean }} />;
}

/** The one way out of the hub: the agent's own session, in its harness. */
export function ThreadButton(props: { readonly href: string | null; readonly label: string }) {
  if (!props.href) return null;
  return (
    <a className="btn" href={props.href} aria-label={props.label} title={props.label}>
      <span className={s.btnLabel}>{props.label}</span>
      <ArrowSquareOutIcon aria-hidden />
    </a>
  );
}

/** A try link in a few words: what the page calls it, else its address without the scheme, or a file's last two folders. */
function tryName(link: OpenLink): string {
  if (link.label) return link.label;
  if (/^https?:\/\//i.test(link.url) && URL.canParse(link.url)) {
    const { host, pathname } = new URL(link.url);
    return host + (pathname === "/" ? "" : pathname);
  }
  return link.url.replace(/^file:\/\//i, "").replace(/[?#].*$/, "").split("/").filter(Boolean).slice(-2).join("/");
}

/** Whether this browser is on the machine the hub runs on, which is the only place a file there can be opened. */
const onHubMachine = () => /^(127\.0\.0\.1|localhost)$/.test(location.hostname);

function tryState(link: OpenLink): { readonly word: string; readonly hint: string } {
  const file = !/^https?:\/\//i.test(link.url);
  if (link.up === false) return { word: "down", hint: file ? "The file is not there." : "Nothing is answering at this address." };
  if (link.href === null && !onHubMachine()) return { word: "away", hint: "A file on the machine the hub runs on. Open the hub there to open it." };
  // A dot is for a server, which runs or doesn't. A file that is there keeps its icon.
  return { word: link.up && !file ? "up" : "", hint: file ? "Opens the file in your browser." : link.up ? "Running." : "" };
}

/**
 * Where to open what a work is building, as one button each. A dot says whether a server on this machine
 * answers. A file kept outside the work's folder is opened by the hub, in the browser of the machine it runs on.
 */
export function TryLinks(props: { readonly work: WorkId; readonly links: readonly OpenLink[] }) {
  return (
    <>
      {props.links.map((link) => {
        const { word, hint } = tryState(link);
        const Icon = /^https?:\/\//i.test(link.url) ? GlobeSimpleIcon : FileHtmlIcon;
        const inside = (
          <>
            {word === "up" || word === "down" ? <span className={s.tryDot} data-state={word} aria-hidden /> : <Icon aria-hidden />}
            <span className={s.btnLabel}>{tryName(link)}</span>
          </>
        );
        const title = `${link.url}${hint ? `\n${hint}` : ""}`;
        if (link.href !== null) {
          return (
            <a key={link.url} className={`btn ${s.try}`} data-state={word} href={link.href} target="_blank" rel="noopener noreferrer" title={title}>
              {inside}
            </a>
          );
        }
        return (
          <button key={link.url} type="button" className={`btn ${s.try}`} data-state={word} title={title} disabled={word === "down" || word === "away"} onClick={() => void fetch("/api/open", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ work: props.work, url: link.url }) })}>
            {inside}
          </button>
        );
      })}
    </>
  );
}

function PrIcon(props: { readonly state: PullRequest["state"] }) {
  if (props.state === "merged") return <GitMergeIcon className={s.refIcon} data-state={props.state} aria-hidden />;
  if (props.state === "closed") return <XCircleIcon className={s.refIcon} data-state={props.state} aria-hidden />;
  return <GitPullRequestIcon className={s.refIcon} data-state={props.state} aria-hidden />;
}

/** The states a pull request's icon doesn't make plain on its own. A merge and an open pull request are told by the icon and its colour. */
const SAID_STATES: readonly PullRequest["state"][] = ["draft", "closed"];

/**
 * A pull request on one line, opening on GitHub: its icon, number and title, and its state in a word where the
 * icon doesn't say it. `plain` leaves the word out, for a list whose heading already says it of every row.
 */
export function PrRow(props: { readonly pr: PullRequest; readonly plain?: boolean }) {
  const { pr } = props;
  return (
    <a className="ref" href={pr.url} target="_blank" rel="noopener noreferrer" title={`${pr.title} (${pr.state})`}>
      <PrIcon state={pr.state} />
      <span className={s.refNum}>#{pr.number}</span>
      <span className={s.refTitle}>{pr.title}</span>
      {SAID_STATES.includes(pr.state) && !props.plain ? <span className={s.refState}>{pr.state}</span> : null}
    </a>
  );
}

/**
 * The pull requests and commits a line is about, one to a row under it: number and title, so several can
 * be told apart. `said` is the line when it is the pull request's own title, which the chip then leaves out.
 */
export function RefChips(props: { readonly prs: readonly PullRequest[]; readonly commits: readonly Commit[]; readonly said?: string | undefined }) {
  if (props.prs.length + props.commits.length === 0) return null;
  return (
    <span className={s.chips}>
      {props.prs.map((pr) => (
        <a key={pr.url} className={s.chip} href={pr.url} target="_blank" rel="noopener noreferrer" title={`${pr.title} (${pr.state})`}>
          <PrIcon state={pr.state} />
          <span className={s.chipNum}>#{pr.number}</span>
          {pr.title && pr.title !== props.said ? <span className={s.chipTitle}>{pr.title}</span> : null}
          {SAID_STATES.includes(pr.state) ? <span className={s.chipState}>{pr.state}</span> : null}
        </a>
      ))}
      {props.commits.map((commit) => (
        <a key={commit.sha} className={s.chip} href={commit.url} target="_blank" rel="noopener noreferrer" title={commit.subject}>
          <GitCommitIcon className={s.refIcon} aria-hidden />
          <span className={s.chipNum}>{commit.sha.slice(0, 7)}</span>
          {commit.subject ? <span className={s.chipTitle}>{commit.subject}</span> : null}
        </a>
      ))}
    </span>
  );
}

/** The heading a Home screen starts with. */
export function ViewHead(props: { readonly title: string; readonly sub?: ReactNode; readonly children?: ReactNode }) {
  return (
    <header className="view-head">
      <div className={s.viewHeadText}>
        <h1>{props.title}</h1>
        {props.sub ? <p className={s.viewSub}>{props.sub}</p> : null}
      </div>
      {props.children}
    </header>
  );
}

/**
 * The row that names a tab's list, with what acts on the list at its right. On Home it is the screen's
 * title. On a work it is a heading under the goal, so it is plain where the goal ends and the list begins.
 */
export function ListHead(props: { readonly title: string; readonly sub?: string | undefined; readonly scoped: boolean; readonly children?: ReactNode }) {
  const tools = props.children ? <div className="tools">{props.children}</div> : null;
  if (!props.scoped) return <ViewHead title={props.title} sub={props.sub}>{tools}</ViewHead>;
  return (
    <div className={s.listHead}>
      <h2 className="sec-title">{props.title}</h2>
      {tools}
    </div>
  );
}

/** A long list that shows its first `show` rows, and the rest on request. Its control looks and reads like every other fold. */
export function Fold(props: { readonly show: number; readonly noun: string; readonly className?: string; readonly children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const rows = Children.toArray(props.children);
  const hidden = rows.length - props.show;
  return (
    <>
      <ul className={props.className ?? "rows"}>{open || hidden <= 1 ? rows : rows.slice(0, props.show)}</ul>
      {hidden > 1 ? (
        <button type="button" className={s.foldBtn} onClick={() => setOpen(!open)} aria-expanded={open}>
          <CaretRightIcon weight="bold" aria-hidden />
          {open ? `Hide ${hidden} ${props.noun}` : `Show ${hidden} more ${props.noun}`}
        </button>
      ) : null}
    </>
  );
}
