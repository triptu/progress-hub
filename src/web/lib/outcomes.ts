import { countOf, formatValue, isMeasured, isSmall, labelText, moved, openDue, seriesKey, type Change, type Measured, type Outcome, type Verdict } from "../../core/outcomes.ts";
import { githubRefs, LEADING_REF, refLabel, sameRef, shortRefs, type GitHubRef } from "../../core/refs.ts";
import type { Instant, RenderedItem, WorkDetail } from "../../core/types.ts";

/** One reading that names a change: what it measured, from what to what, and whether that is better. */
export interface ChangeRow {
  readonly outcome: Outcome;
  readonly reading: Measured;
  readonly before: number | null;
  readonly after: number;
  readonly verdict: Verdict;
  /** Null with no value before, or too few counted to say. */
  readonly change: Change | null;
}

/** Every reading that names one change. */
export interface ChangeGroup {
  readonly change: string;
  readonly ref: GitHubRef | null;
  readonly rows: readonly ChangeRow[];
  /** The newest of its readings. */
  readonly at: Instant;
  readonly dropped: boolean;
}

/**
 * The readings that name a change, grouped by the change, newest first. The value before is the reading's own
 * `from`, else the reading before it on the same line. Better or worse comes from the numbers and the direction.
 */
export function changeGroups(outcomes: readonly Outcome[]): ChangeGroup[] {
  const groups = new Map<string, ChangeRow[]>();
  for (const outcome of outcomes) {
    const measured = outcome.readings.filter(isMeasured);
    measured.forEach((reading, index) => {
      if (reading.change === undefined) return;
      const previous = measured.slice(0, index).findLast((r) => seriesKey(r) === seriesKey(reading));
      const before = reading.from ?? previous?.value ?? null;
      const row: ChangeRow = { outcome, reading, before, after: reading.value, ...(before === null ? { change: null, verdict: "unclear" } : moved(outcome, before, reading)) };
      groups.set(reading.change, [...(groups.get(reading.change) ?? []), row]);
    });
  }
  return [...groups]
    .map(([change, rows]) => ({
      change,
      ref: githubRefs(change)[0] ?? null,
      rows,
      at: rows.map((row) => row.reading.at).sort().at(-1)!,
      dropped: rows.some((row) => row.reading.dropped),
    }))
    .sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
}

/** What a change is called: its pull request's number and the words of the line about it on the page, or the words the reading gave. */
export function changeName(group: Pick<ChangeGroup, "change" | "ref">, detail: WorkDetail): { readonly label: string | null; readonly title: string } {
  if (!group.ref) return { label: null, title: group.change };
  const ref = group.ref;
  const item = detail.body.sections.flatMap((section) => section.items).find((entry) => githubRefs(entry.title).some((other) => sameRef(ref, other)));
  const pr = ref.kind === "pr" ? detail.pullRequests.find((entry) => entry.repo.toLowerCase() === ref.repo.toLowerCase() && entry.number === ref.number) : undefined;
  const title = item ? shortRefs(item.title).replace(LEADING_REF, "").replace(/^#\d+\s*/, "") : (pr?.title ?? "");
  return { label: refLabel(ref), title };
}

/** What waits on data: readings due later, and changes with no clear result where real use is measured. */
export type Waiting =
  | { readonly kind: "due"; readonly outcome: Outcome; readonly labels: string; readonly due: string; readonly note: string | null; readonly late: boolean }
  | { readonly kind: "change"; readonly group: ChangeGroup; readonly measured: boolean };

export function waitingOn(outcomes: readonly Outcome[], groups: readonly ChangeGroup[], today: string): Waiting[] {
  const due: Waiting[] = outcomes.flatMap((outcome) =>
    openDue(outcome).map((reading) => ({ kind: "due" as const, outcome, labels: labelText(reading.labels), due: reading.due ?? "", note: reading.note ?? null, late: (reading.due ?? "") < today })),
  );
  const changes: Waiting[] = groups
    .filter((group) => !group.dropped && group.rows.some((row) => row.reading.where === "local" || row.reading.where === "guess") && !group.rows.some((row) => (row.reading.where === "prod" || row.reading.where === "ci") && row.verdict !== "unclear"))
    .map((group) => ({ kind: "change", group, measured: group.rows.some((row) => row.reading.where === "prod" || row.reading.where === "ci") }));
  return [...due.sort((a, b) => (a.kind === "due" && b.kind === "due" ? (a.due < b.due ? -1 : 1) : 0)), ...changes];
}

/** A change that went live, by when, from the Shipped lines that say so. */
export interface LiveMark {
  readonly at: Instant;
  readonly refs: readonly GitHubRef[];
}

export function liveMarks(detail: WorkDetail): LiveMark[] {
  return detail.body.sections
    .filter((section) => section.kind === "shipped")
    .flatMap((section) => section.items)
    .flatMap((item: RenderedItem) => (item.live?.on && item.live.at ? [{ at: item.live.at, refs: githubRefs(`${item.title} ${item.html}`) }] : []));
}

/** When a change took effect, for its mark on a chart: when it went live, else its first reading. */
export function changeTime(group: ChangeGroup, lives: readonly LiveMark[]): Instant {
  const live = group.ref ? lives.find((mark) => mark.refs.some((ref) => sameRef(ref, group.ref!))) : undefined;
  return live?.at ?? group.rows.map((row) => row.reading.at).sort()[0]!;
}

/** Whether a live mark is one of these changes, which a chart marks as the change. */
export const isChange = (mark: LiveMark, groups: readonly ChangeGroup[]) => groups.some((group) => group.ref && mark.refs.some((ref) => sameRef(ref, group.ref!)));

/** A change as words, without its sign, which its arrow gives: 4.7 pts, 19%. */
export function changeText(change: Change): string {
  const size = Math.abs(change.by);
  const number = size >= 10 ? String(Math.round(size)) : size >= 1 ? size.toFixed(1).replace(/\.0$/, "") : size.toFixed(2).replace(/0$/, "");
  return change.in === "points" ? `${number} ${number === "1" ? "pt" : "pts"}` : `${number}%`;
}

/** A difference between two numbers in the outcome's unit, without its sign: 0.55 points for a percentage, else the unit. */
export function differenceText(difference: number, unit: string): string {
  const size = Math.abs(difference);
  return unit === "%" ? `${formatValue(size, "")} ${size === 1 ? "point" : "points"}` : formatValue(size, unit);
}

/**
 * A reading's number as a person reads it, with its counts: "19,530 searches", or "n = 19,530" when the agent did
 * not say what was counted, and "244 of 1,114" for a rate. A rate counted from too few is its counts alone.
 */
export function amountText(reading: Pick<Measured, "value" | "of" | "n">, unit: string, counted: string | null = null): { readonly main: string; readonly counts: string | null } {
  const noun = counted ? ` ${counted}` : "";
  if (!reading.of) return { main: formatValue(reading.value, unit), counts: reading.n !== undefined ? (noun ? `${formatValue(reading.n, "")}${noun}` : `n = ${formatValue(reading.n, "")}`) : null };
  const counts = `${formatValue(countOf(reading), "")} of ${formatValue(reading.of, "")}${noun}`;
  return isSmall(reading) ? { main: counts, counts: null } : { main: formatValue(reading.value, unit), counts };
}

/** A reading's window as written, and "daily" for one that is a whole day. */
export const windowText = (window: string | undefined) => (window === undefined ? undefined : /^(a )?full (utc )?day$/i.test(window.trim()) ? "daily" : window);

/** Whether a reading's window is part of one day: a clock time, hours or minutes, or none said. */
export const withinDay = (window: string | undefined) => window === undefined || /\b\d{1,2}:\d{2}\b|\b\d+(\.\d+)?\s*(h|hrs?|hours?|mins?|minutes?)\b|\btoday\b/i.test(window);

const dayOf = (at: Instant) => new Date(at).toLocaleDateString(undefined, { day: "numeric", month: "short" });
const timeOf = (at: Instant) => new Date(at).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });

/** The places on a chart's x axis: their names, when each was first measured, and the place of each reading. */
export interface Slots {
  readonly labels: readonly string[];
  readonly times: readonly number[];
  readonly of: (reading: Measured) => number;
}

/**
 * The places on a chart's x axis, evenly spaced in the order they were measured. Each reading has its own, except
 * that labelled lines share one where they give the same window, such as one signup week: the nth reading of a
 * window on one label lines up with the nth of it on another. A place is named by its window when every place has
 * its own, else by its day, or by its time when all are on one day.
 */
export function slotsOf(lines: readonly { readonly key: string; readonly labelled: boolean; readonly readings: readonly Measured[] }[]): Slots {
  const keyOf = new Map<Measured, string>();
  const members = new Map<string, Measured[]>();
  for (const line of lines) {
    const seen = new Map<string, number>();
    line.readings.forEach((reading, i) => {
      let key = `${line.key}@${i}`;
      if (line.labelled && reading.window !== undefined) {
        const nth = seen.get(reading.window) ?? 0;
        seen.set(reading.window, nth + 1);
        key = `window:${reading.window}#${nth}`;
      }
      keyOf.set(reading, key);
      members.set(key, [...(members.get(key) ?? []), reading]);
    });
  }
  const firsts = [...members].map(([key, readings]) => ({ key, first: readings.reduce((a, b) => (b.at < a.at ? b : a)) })).sort((a, b) => (a.first.at < b.first.at ? -1 : a.first.at > b.first.at ? 1 : 0));
  const index = new Map(firsts.map(({ key }, i) => [key, i]));
  const windows = firsts.map(({ first }) => first.window);
  const named = windows.every((window, i) => window !== undefined && windows.indexOf(window) === i);
  const oneDay = new Set(firsts.map(({ first }) => dayOf(first.at))).size === 1;
  return {
    labels: firsts.map(({ first }) => (named ? first.window! : oneDay && firsts.length > 1 ? timeOf(first.at) : dayOf(first.at))),
    times: firsts.map(({ first }) => Date.parse(first.at)),
    of: (reading) => index.get(keyOf.get(reading) ?? "") ?? -1,
  };
}

/** Where a time falls among the slots, as a fractional slot: between the slots taken before and after it. */
export function slotAt(times: readonly number[], at: number): number {
  if (times.length === 0) return 0;
  if (at <= times[0]!) return -0.5;
  for (let i = 1; i < times.length; i++) {
    if (at <= times[i]!) return i - 1 + (at - times[i - 1]!) / Math.max(1, times[i]! - times[i - 1]!);
  }
  return times.length - 0.5;
}

/** Round numbers for a chart's scale, about `count` of them, covering the values. Values too far apart or too close for round steps get their own two. */
export function ticksOf(min: number, max: number, count = 3): number[] {
  if (min === max) {
    const pad = Math.abs(min) * 0.1 || 1;
    return ticksOf(min - pad, max + pad, count);
  }
  const rough = (max - min) / count;
  const power = 10 ** Math.floor(Math.log10(rough));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * power).find((s) => s >= rough) ?? rough;
  const start = Math.floor(min / step);
  const end = Math.ceil(max / step);
  // A step lost in the size of the numbers, such as 1 beside 10^16, never moves the count on.
  if (!Number.isFinite(step) || step <= 0 || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || end - start > 4 * count) return [min, max];
  const ticks: number[] = [];
  for (let i = start; i <= end; i++) ticks.push(Number((i * step).toPrecision(12)));
  return ticks;
}
