import { useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { ArrowRightIcon, CaretRightIcon, CircleDashedIcon, StarIcon } from "@phosphor-icons/react";
import { formatValue, headline, today, isMeasured, isPart, isSmall, labelText, seriesOf, standing, starOf, type Measured, type Outcome, type Reading } from "../../core/outcomes.ts";
import type { Instant, WorkDetail } from "../../core/types.ts";
import { amountText, windowText, withinDay, changeGroups, changeName, changeTime, differenceText, isChange, liveMarks, waitingOn, type ChangeGroup, type Waiting } from "../lib/outcomes.ts";
import { Ago, When } from "./parts.tsx";
import { Delta, OutcomeChart, Sparkline, WhereTag, type Marks } from "./Chart.tsx";
import s from "./Outcomes.module.css";

const dueText = (due: string) => new Date(`${due}T12:00:00`).toLocaleDateString(undefined, { day: "numeric", month: "short" });

/** A change's short name for a chart's mark: its number, or its first words. */
const markLabel = (group: ChangeGroup, detail: WorkDetail) => changeName(group, detail).label ?? (group.change.length > 16 ? `${group.change.slice(0, 15)}…` : group.change);

/**
 * A work's Outcomes: the number it moves and its line, what is waiting on data, what each change did, and the other
 * numbers it keeps, in the sections the agent grouped them in. The layout is fixed; the readings fill it.
 */
export function Outcomes(props: { readonly detail: WorkDetail; readonly seenBefore: Instant; readonly onSeen: (at: Instant) => void; readonly now: number; readonly children: ReactNode }) {
  const { detail, now } = props;
  const outcomes = detail.outcomes ?? [];
  const groups = useMemo(() => changeGroups(outcomes), [outcomes]);
  const marks = useMemo((): Marks => {
    const lives = liveMarks(detail);
    return {
      changes: groups.filter((group) => !group.dropped).map((group) => ({ at: Date.parse(changeTime(group, lives)), label: markLabel(group, detail) })),
      lives: lives.filter((mark) => !isChange(mark, groups)).map((mark) => Date.parse(mark.at)),
    };
  }, [detail, groups]);
  const star = starOf(outcomes);
  const waiting = waitingOn(outcomes, groups, today(now));
  const kept = groups.filter((group) => !group.dropped);
  const dropped = groups.filter((group) => group.dropped);
  // An outcome measured only as what a change did is told under that change. One the agent grouped is always listed.
  const listed = outcomes.filter((outcome) => !outcome.star && (outcome.group !== null || outcome.readings.some((r) => !isMeasured(r) || r.change === undefined)));
  const sections = [...new Set(listed.map((outcome) => outcome.group))].sort((a, b) => (a === null ? 1 : b === null ? -1 : 0));

  return (
    <div className="wrap">
      {props.children}
      <div className={s.grid}>
        {star ? <StarBlock outcome={star} detail={detail} seenBefore={props.seenBefore} onSeen={props.onSeen} marks={marks} now={now} /> : null}
        {waiting.length ? (
          <section className={s.waiting} aria-labelledby="waiting-title">
            <h2 className="sec-title" id="waiting-title">
              Waiting on data <span className="n">{waiting.length}</span>
            </h2>
            <ul className={s.waitList}>
              {waiting.map((entry, i) => (
                <WaitingRow key={i} entry={entry} detail={detail} />
              ))}
            </ul>
          </section>
        ) : null}
        {groups.length ? (
          <section className={s.changes} aria-labelledby="changes-title">
            {kept.length ? (
              <>
                <h2 className="sec-title" id="changes-title">
                  What changed it <span className="n">{kept.length}</span>
                </h2>
                <ul className={s.changeList}>
                  {kept.map((group) => (
                    <ChangeView key={group.change} group={group} detail={detail} />
                  ))}
                </ul>
              </>
            ) : null}
            {dropped.length ? (
              <details className={`fold ${s.dropped}`} id={kept.length ? undefined : "changes-title"}>
                <summary>
                  <CaretRightIcon weight="bold" aria-hidden />
                  <span>
                    Tried and dropped <span className="n">{dropped.length}</span>
                  </span>
                </summary>
                <ul className={s.changeList}>
                  {dropped.map((group) => (
                    <ChangeView key={group.change} group={group} detail={detail} />
                  ))}
                </ul>
              </details>
            ) : null}
          </section>
        ) : null}
        {sections.length ? (
          <div className={s.measured}>
            {sections.map((group) => {
              const members = listed.filter((outcome) => outcome.group === group);
              return (
                <section key={group ?? ""} className={s.group} aria-label={group ?? "Also measured"}>
                  <h2 className="sec-title">
                    {group ?? (star || sections.length > 1 ? "Also measured" : "Measured")} <span className="n">{members.length}</span>
                  </h2>
                  <ul className={s.rows}>
                    {members.map((outcome) => (
                      <OutcomeRow key={outcome.name} outcome={outcome} detail={detail} marks={marks} now={now} />
                    ))}
                  </ul>
                </section>
              );
            })}
          </div>
        ) : null}
      </div>
    </div>
  );
}

/** What the star's labels split it by: "by client". */
function byWhat(outcome: Outcome): string | null {
  const labelled = outcome.readings.find((r) => r.labels && !isPart(r));
  return labelled?.labels ? `by ${Object.keys(labelled.labels).join(" and ")}` : null;
}

function StarBlock(props: { readonly outcome: Outcome; readonly detail: WorkDetail; readonly seenBefore: Instant; readonly onSeen: (at: Instant) => void; readonly marks: Marks; readonly now: number }) {
  const { outcome, now } = props;
  const unit = outcome.unit;
  const line = headline(outcome)?.readings ?? [];
  const stands = standing(outcome, line);
  const latest = stands?.latest;
  // The newest reading of part of a window, when it is newer than the last full one: a row, never the next point.
  const part = outcome.readings.filter((r): r is Measured => isMeasured(r) && isPart(r) && r.where !== "guess").at(-1);
  const lastPart = part && (!latest || part.at > latest.at) ? part : null;
  // What moved since the user last had the work open: the reading then against the newest.
  const seen = Date.parse(props.seenBefore);
  const then = line.filter((r) => Date.parse(r.at) <= seen).at(-1);
  const since = then && latest && Date.parse(latest.at) > seen && latest.value !== then.value && !isSmall(latest) ? latest.value - then.value : null;
  // The visit is recorded once the star is on screen, by its newest reading, whatever line that is on.
  const newest = outcome.readings.filter(isMeasured).at(-1)?.at;
  const { onSeen } = props;
  useEffect(() => {
    if (newest) onSeen(newest);
  }, [newest]);
  const about = [byWhat(outcome), outcome.better ? `${outcome.better} is better` : null, outcome.target !== null ? `target ${formatValue(outcome.target, unit)}` : null].filter(Boolean);

  return (
    <section className={s.star} aria-labelledby="star-title">
      <h2 className={s.starName} id="star-title">
        <StarIcon weight="fill" aria-hidden />
        {outcome.name}
      </h2>
      {about.length ? <p className={s.starAbout}>{about.join(" · ")}</p> : null}
      {stands && latest ? (
        <>
          <div className={s.figureRow}>
            <span className={s.figure}>{amountText(latest, outcome.unit).main}</span>
            <span className={s.figureSide}>
              {stands.change ? (
                <span>
                  <Delta verdict={stands.verdict} change={stands.change} /> from {formatValue(stands.base.value, unit)}
                </span>
              ) : null}
              {since !== null ? (
                <span className={s.sinceLooked}>
                  {since < 0 ? "Down" : "Up"} {differenceText(since, unit)} since you last looked
                </span>
              ) : null}
            </span>
          </div>
          <p className={s.meta}>
            <WhereTag where={latest.where} />
            <span>{[windowText(latest.window), amountText(latest, outcome.unit, outcome.counted).counts].filter(Boolean).join(" · ")}</span>
            <Ago verb="" at={latest.at} now={now} />
          </p>
        </>
      ) : null}
      <OutcomeChart outcome={outcome} marks={props.marks} />
      {lastPart ? (
        <p className={s.part}>
          <span className={s.partLabel}>{withinDay(lastPart.window) ? "Part of a day" : lastPart.window}</span>
          <b>{amountText(lastPart, outcome.unit).main}</b>
          <span>{[withinDay(lastPart.window) ? windowText(lastPart.window) : null, amountText(lastPart, outcome.unit, outcome.counted).counts].filter(Boolean).join(" · ")}</span>
        </p>
      ) : null}
      <How outcome={outcome} />
      <Readings outcome={outcome} detail={props.detail} now={now} />
    </section>
  );
}

/** The saved query or script most of an outcome's readings give, said once, under How. */
function usualSource(outcome: Outcome): string | undefined {
  const counts = new Map<string, number>();
  for (const { source } of outcome.readings) if (source !== undefined) counts.set(source, (counts.get(source) ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1])[0]?.[0];
}

/** How it is measured, in the agent's words, with the saved query or script that gives it again. */
function How(props: { readonly outcome: Outcome }) {
  const source = usualSource(props.outcome);
  if (props.outcome.how === null && source === undefined) return null;
  return (
    <p className={s.how}>
      <b>How</b> {props.outcome.how ?? ""} {source ? <Source source={source} /> : null}
    </p>
  );
}

/** The session that wrote a reading: its title, opening it, when the hub knows it. */
function Session(props: { readonly by: string; readonly detail: WorkDetail }) {
  const agent = props.detail.agents.find((entry) => entry.thread === props.by);
  return agent ? (
    <a href={agent.link} title="Open the session that wrote it">
      {agent.title}
    </a>
  ) : (
    <span className={s.dim} title={props.by}>
      {props.by.length > 18 ? `${props.by.slice(0, 17)}…` : props.by}
    </span>
  );
}

function Source(props: { readonly source: string }) {
  return /^https?:\/\//i.test(props.source) ? (
    <a href={props.source} target="_blank" rel="noreferrer">
      {props.source.replace(/^https?:\/\/(www\.)?/, "").slice(0, 48)}
    </a>
  ) : (
    <code>{props.source}</code>
  );
}

function WaitingRow(props: { readonly entry: Waiting; readonly detail: WorkDetail }) {
  const { entry } = props;
  if (entry.kind === "due") {
    return (
      <li className={s.wait} data-late={entry.late ? "" : undefined}>
        <CircleDashedIcon aria-hidden />
        <span>
          <span className={s.waitTitle}>
            {entry.outcome.name}
            {entry.labels ? ` · ${entry.labels}` : ""}
          </span>
          <span className={s.waitNote}>{[`${entry.late ? "Was due" : "Ready"} ${dueText(entry.due)}`, entry.note].filter(Boolean).join(" · ")}</span>
        </span>
      </li>
    );
  }
  const name = changeName(entry.group, props.detail);
  const local = entry.group.rows.filter((row) => row.reading.where === "local" || row.reading.where === "guess");
  return (
    <li className={s.wait}>
      <CircleDashedIcon aria-hidden />
      <span>
        <span className={s.waitTitle}>
          <ChangeTitle change={entry.group.change} label={name.label} title={name.title} />
        </span>
        <span className={s.waitNote}>
          {local.map((row, i) => (
            <span key={i} className={s.waitPart}>
              <WhereTag where={row.reading.where} /> {row.before !== null ? `${formatValue(row.before, row.outcome.unit)} → ` : ""}
              {formatValue(row.after, row.outcome.unit)} {row.outcome.name}
            </span>
          ))}
          <span className={s.waitPart}>{entry.measured ? "Prod: no clear change yet" : "Not measured in prod yet"}</span>
        </span>
      </span>
    </li>
  );
}

function ChangeTitle(props: { readonly change: string; readonly label: string | null; readonly title: string }) {
  return props.label ? (
    <>
      <a href={props.change} target="_blank" rel="noreferrer" className={s.ref}>
        {props.label}
      </a>{" "}
      {props.title}
    </>
  ) : (
    <>{props.title}</>
  );
}

function ChangeView(props: { readonly group: ChangeGroup; readonly detail: WorkDetail }) {
  const { group } = props;
  const name = changeName(group, props.detail);
  const notes = [...new Set(group.rows.flatMap((row) => row.reading.note ?? []))];
  return (
    <li className={s.change}>
      <h3 className={s.changeName}>
        <ChangeTitle change={group.change} label={name.label} title={name.title} />
      </h3>
      <ul>
        {group.rows.map((row, i) => (
          <li key={i} className={s.changeRow}>
            <span className={s.changeWhat}>
              {row.outcome.name}
              {row.reading.labels ? <span className={s.dim}> · {labelText(row.reading.labels)}</span> : null}
            </span>
            <span className={s.changeNums}>
              {row.before !== null ? (
                <>
                  <span className={s.dim}>{formatValue(row.before, row.outcome.unit)}</span>
                  <ArrowRightIcon aria-label="to" className={s.arrow} />
                </>
              ) : null}
              <span>{formatValue(row.after, row.outcome.unit)}</span>
            </span>
            <span className={s.changeDelta}>{row.before !== null ? <Delta verdict={row.verdict} change={row.change} unclear={row.reading.unclear === true} /> : null}</span>
            <WhereTag where={row.reading.where} />
          </li>
        ))}
      </ul>
      {notes.map((note) => (
        <p key={note} className={s.changeNote}>
          {note}
        </p>
      ))}
    </li>
  );
}

/**
 * One outcome as a row: its name, from its first reading to its latest, where, when and a small line. It opens in
 * place into its own chart, how it is measured and its readings.
 */
function OutcomeRow(props: { readonly outcome: Outcome; readonly detail: WorkDetail; readonly marks: Marks; readonly now: number }) {
  const { outcome, now } = props;
  const [open, setOpen] = useState(false);
  const unit = outcome.unit;
  const line = headline(outcome)?.readings ?? [];
  const stands = standing(outcome, line);
  const latest = stands?.latest;
  const newest = outcome.readings.filter(isMeasured).at(-1);
  // The latest from each other place it was measured, beside the headline: never joined to it.
  const others = latest ? seriesOf(outcome).flatMap((series) => (!series.labelled && series.where !== latest.where ? series.readings.slice(-1) : [])) : [];
  // How it is measured is said once it is open, under How.
  const sub = byWhat(outcome);
  return (
    <li className={s.row} data-open={open ? "" : undefined}>
      <button type="button" className={`row-btn ${s.rowHead}`} aria-expanded={open} onClick={() => setOpen(!open)}>
        <span className={s.rowName}>
          <CaretRightIcon weight="bold" aria-hidden className={s.rowCaret} />
          <span>
            {outcome.name}
            {sub ? <span className={s.rowSub}>{sub}</span> : null}
          </span>
        </span>
        <span className={s.rowNums}>
          {stands && latest ? (
            <>
              {latest !== stands.base ? (
                <>
                  <span className={s.dim}>{formatValue(stands.base.value, unit)}</span>
                  <ArrowRightIcon aria-label="to" className={s.arrow} />
                </>
              ) : null}
              <b>{amountText(latest, outcome.unit).main}</b>
              <Delta verdict={stands.verdict} change={stands.change} />
              <WhereTag where={latest.where} />
              {others.map((other) => (
                <span key={other.where} className={s.other}>
                  <WhereTag where={other.where} />
                  {amountText(other, outcome.unit).main}
                </span>
              ))}
            </>
          ) : null}
          {newest ? <When at={newest.at} now={now} className={s.rowWhen} /> : null}
        </span>
        <Sparkline values={line.map((r) => r.value)} verdict={stands?.verdict ?? "unclear"} />
      </button>
      {open ? (
        <div className={s.rowOpen}>
          <OutcomeChart outcome={outcome} marks={props.marks} />
          <How outcome={outcome} />
          <Readings outcome={outcome} detail={props.detail} now={now} />
        </div>
      ) : null}
    </li>
  );
}

/** Every reading of an outcome, newest first, with where it came from and the session that wrote it. */
function Readings(props: { readonly outcome: Outcome; readonly detail: WorkDetail; readonly now: number }) {
  const { outcome } = props;
  const usual = usualSource(outcome);
  // Each reading is told in the unit of its own definition.
  const all = [...outcome.readings.map((reading) => ({ reading, unit: outcome.unit, earlier: false })), ...outcome.earlier.flatMap((before) => before.readings.map((reading) => ({ reading, unit: before.unit, earlier: true })))].sort((a, b) => (a.reading.at < b.reading.at ? 1 : -1));
  return (
    <details className={`fold ${s.readings}`}>
      <summary>
        <CaretRightIcon weight="bold" aria-hidden />
        <span>
          Readings <span className="n">{all.length}</span>
        </span>
      </summary>
      <ol className={s.readingList}>
        {all.map(({ reading, unit, earlier }, i) => (
          <ReadingRow key={i} reading={reading} unit={unit} earlier={earlier} usual={usual} counted={outcome.counted} detail={props.detail} now={props.now} />
        ))}
      </ol>
    </details>
  );
}

function ReadingRow(props: { readonly reading: Reading; readonly unit: string; readonly earlier: boolean; readonly usual: string | undefined; readonly counted: string | null; readonly detail: WorkDetail; readonly now: number }) {
  const { reading, unit } = props;
  // The source most readings share is said once, under How.
  const source = reading.source !== props.usual ? reading.source : undefined;
  const by = reading.by;
  const what = isMeasured(reading)
    ? `${reading.from !== undefined ? `${formatValue(reading.from, unit)} → ` : ""}${amountText(reading, unit).main}`
    : reading.due !== undefined
      ? `Ready ${dueText(reading.due)}`
      : "Definition";
  const facts = [
    labelText(reading.labels),
    windowText(reading.window),
    isMeasured(reading) ? amountText(reading, unit, props.counted).counts : null,
    reading.unclear ? "unclear" : null,
    reading.dropped ? "dropped" : null,
    props.earlier ? "earlier definition" : null,
  ].filter(Boolean);
  return (
    <li className={s.reading} data-earlier={props.earlier ? "" : undefined}>
      <When at={reading.at} now={props.now} className={s.readingWhen} />
      <span className={s.readingBody}>
        <span className={s.readingTop}>
          <b>{what}</b>
          {reading.where ? <WhereTag where={reading.where} /> : null}
          {facts.length ? <span className={s.dim}>{facts.join(" · ")}</span> : null}
        </span>
        {reading.change || source || reading.note || by ? (
          <span className={s.readingMore}>
            {reading.change ? <span>{/^https?:\/\//.test(reading.change) ? <Source source={reading.change} /> : reading.change}</span> : null}
            {source ? <Source source={source} /> : null}
            {reading.note ? <span>{reading.note}</span> : null}
            {by ? <Session by={by} detail={props.detail} /> : null}
          </span>
        ) : null}
      </span>
    </li>
  );
}
