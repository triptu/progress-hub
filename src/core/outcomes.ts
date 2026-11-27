/**
 * Outcomes: the numbers a work moves, kept as readings in `<work>/outcomes.jsonl`, one JSON object per line,
 * appended by `progress measure`. A reading is never a page change: it enters no journal, no feed and no order.
 *
 * A line records a value, sets the definition, or says what is due. Definitions are sticky: a line that changes
 * how an outcome is measured starts a new definition, and the readings before it are never compared with the
 * ones after.
 */
import { githubRefs, sameRef } from "./refs.ts";
import { count, either, flag, listOf, oneOf, orElse, orNone, orNull, readJsonl, shape, tableOf, text, unread, type Reader, type Skipped } from "./reader.ts";
import type { Instant, SessionRef } from "./types.ts";

/** Where a number was measured. Production and CI are real use; local is one machine; a guess is no measurement. */
export const WHERE = ["prod", "ci", "local", "guess"] as const;
export type Where = (typeof WHERE)[number];
export const WHERE_LABEL: Readonly<Record<Where, string>> = { prod: "Prod", ci: "CI", local: "Local", guess: "Guess" };
export type Better = "lower" | "higher";

/** What a line may say about the outcome itself. Each holds until a later line changes it. */
export interface Definition {
  /** "%", "ms", "$" and so on. Fixed by the first value. */
  readonly unit?: string;
  readonly better?: Better;
  readonly target?: number;
  /** This is the work's north star. The last line that says so wins, so a work has one. */
  readonly star?: true;
  /** How it is measured, in the agent's words. */
  readonly how?: string;
  /** The section it is listed under, such as "Guardrails". */
  readonly group?: string;
  /** What its counts count, such as "searches", from `--n "19,530 searches"`. */
  readonly counted?: string;
}

interface Said {
  /** Stamped by the command, never typed. */
  readonly at: Instant;
  /** The session that ran the command. Absent when it ran outside any harness the hub reads. */
  readonly by?: SessionRef;
  readonly outcome: string;
  /** A segment: job=arm64, client=web. `day=part` marks a reading of part of a window, never joined to full ones. */
  readonly labels?: Readonly<Record<string, string>>;
  /** A pull request or commit link, or a few words: the change this reading is about. */
  readonly change?: string;
  /** The difference is inside the noise. */
  readonly unclear?: true;
  /** The change was not kept. */
  readonly dropped?: true;
  /** How many things were counted. */
  readonly n?: number;
  readonly window?: string;
  /** The saved query, script or link that gives the number again. */
  readonly source?: string;
  readonly note?: string;
  readonly set?: Definition;
}

/** A line with a number. Where it was measured goes with every number. */
export interface Measured extends Said {
  readonly value: number;
  readonly where: Where;
  /** The value before, for a one-off before and after. */
  readonly from?: number;
  /** The denominator, so 244 of 1,114 shows as counts and a rate. */
  readonly of?: number;
  readonly due?: never;
}

/** A line with no number: it sets the definition, or says a reading is due later. */
export interface Unmeasured extends Said {
  readonly value?: never;
  readonly where?: Where;
  readonly from?: never;
  readonly of?: never;
  /** The date a reading is expected, as YYYY-MM-DD. */
  readonly due?: string;
}

export type Reading = Measured | Unmeasured;

export const isMeasured = (reading: Reading): reading is Measured => reading.value !== undefined;

/**
 * One outcome as the hub shows it: its definition now, and its readings, oldest first. A rate, whose readings give
 * `--of`, is in percent: each reading's value is its share, and its `of` stays, so its counts can be told.
 */
export interface Outcome {
  readonly name: string;
  /** Empty for a plain count, and "%" for a rate. */
  readonly unit: string;
  readonly better: Better | null;
  readonly target: number | null;
  readonly star: boolean;
  readonly how: string | null;
  readonly group: string | null;
  /** What its counts count, such as "searches". */
  readonly counted: string | null;
  /** The readings of the definition it has now. */
  readonly readings: readonly Reading[];
  /** The definitions before it, oldest first, each in its own unit. No chart compares their readings with the ones now. */
  readonly earlier: readonly Earlier[];
}

/** A definition an outcome had before: its unit and how it was measured, and its readings. */
export interface Earlier {
  readonly unit: string;
  readonly how: string | null;
  readonly readings: readonly Reading[];
}

/** How far a number moved: in points for a percentage, else as a share of where it started, in percent. */
export interface Change {
  readonly by: number;
  readonly in: "points" | "percent";
}

export type Verdict = "better" | "worse" | "unclear";

/** The north star as a work's card shows it, worked out by the store so the card needs no readings and decides nothing. */
export interface StarLine {
  readonly outcome: string;
  readonly unit: string;
  /** Where the headline stands now. Null when the star is split by a label, or has no full reading yet. */
  readonly now: {
    readonly value: number;
    readonly of: number | null;
    readonly where: Where;
    /** When that reading was taken. */
    readonly at: Instant;
    /** From the headline's first reading. Null with one reading, or too few counted to say. */
    readonly change: Change | null;
    readonly verdict: Verdict;
  } | null;
  /** The headline's last few values, oldest first, for its small line. */
  readonly values: readonly number[];
  /** The latest value of each label, when the star is split by one: the first `STAR_LABELS` to appear. */
  readonly split: readonly { readonly label: string; readonly value: number; readonly of: number | null }[];
  /** How many labels there are past those. */
  readonly more: number;
  /** The soonest date a reading of it is due. */
  readonly due: string | null;
}

const STAR_VALUES = 12;
/** The labels a split star's card line carries, so a card stays small however many labels its star has. */
const STAR_LABELS = 50;

/**
 * What a work's outcomes may take on its page, in bytes of JSON, definitions and readings together. It keeps a page
 * well under what one row of the central hub holds: an outcome whose definition doesn't fit is left out, and past
 * it the oldest readings go, though each line keeps its first.
 */
export const OUTCOMES_BUDGET = 4 * 1024 * 1024;

// ---------------------------------------------------------------- Reading the file

const where = oneOf(...WHERE);
const none: Reader<undefined> = orNone<never>(unread);
const labels: Reader<Record<string, string>> = tableOf(text);
const definition = shape<Definition>({
  unit: orNone(text),
  better: orNone(oneOf("lower", "higher")),
  target: orNone(count),
  star: orNone(oneOf(true)),
  how: orNone(text),
  group: orNone(text),
  counted: orNone(text),
});
const said = {
  at: text<Instant>,
  by: orNone(text<SessionRef>),
  outcome: (value: unknown) => (typeof value === "string" && value.trim() !== "" ? value : unread()),
  labels: orNone(labels),
  change: orNone(text),
  unclear: orNone(oneOf(true)),
  dropped: orNone(oneOf(true)),
  n: orNone(count),
  window: orNone(text),
  source: orNone(text),
  note: orNone(text),
  set: orNone(definition),
};

/** One reading, as a line of the file or a hub sends it. A value with no `where`, or a `due` beside a value, is refused. */
export const readReading: Reader<Reading> = either<Reading>(
  shape<Measured>({ ...said, value: count, where, from: orNone(count), of: orNone(count), due: none }),
  shape<Unmeasured>({ ...said, value: none, where: orNone(where), from: none, of: none, due: orNone(text) }),
);

export const readOutcome = shape<Outcome>({
  name: text,
  unit: text,
  better: orNull(oneOf("lower", "higher")),
  target: orNull(count),
  star: flag,
  how: orNull(text),
  group: orNull(text),
  counted: orElse(orNull(text), null),
  readings: listOf(readReading),
  earlier: listOf(shape<Earlier>({ unit: text, how: orNull(text), readings: listOf(readReading) })),
});

const change = shape<Change>({ by: count, in: oneOf("points", "percent") });
const verdict = oneOf("better", "worse", "unclear");

export const readStarLine = shape<StarLine>({
  outcome: text,
  unit: text,
  now: orNull(shape({ value: count, of: orNull(count), where, at: text<Instant>, change: orNull(change), verdict })),
  values: listOf(count),
  split: listOf(shape({ label: text, value: count, of: orNull(count) })),
  more: count,
  due: orNull(text),
});

export type { Skipped };

/** The readings in a file's text, each with its line's number, and the lines that could not be read. */
export function readOutcomes(file: string): { readonly readings: Reading[]; readonly lines: number[]; readonly skipped: Skipped[] } {
  const read = readJsonl(file, readReading, "a reading");
  return { readings: read.values, lines: read.lines, skipped: read.skipped };
}

/** A work's outcomes from its outcomes.jsonl, and every line left out of them, in order. */
export function outcomesOf(file: string): { readonly outcomes: Outcome[]; readonly skipped: Skipped[] } {
  const read = readOutcomes(file);
  const skipped = [...read.skipped];
  const outcomes = foldOutcomes(read.readings, (index, why) => skipped.push({ line: read.lines[index]!, why }));
  return { outcomes, skipped: skipped.sort((a, b) => a.line - b.line) };
}

// ---------------------------------------------------------------- Folding

interface Building {
  name: string;
  unit: string;
  /** Whether the definition's readings are counts of a whole, which its first value fixes. Null before it. */
  rate: boolean | null;
  better: Better | null;
  target: number | null;
  how: string | null;
  group: string | null;
  counted: string | null;
  readings: Reading[];
  earlier: Earlier[];
  /** Where each of its readings, of every definition, is in what was folded. */
  indices: number[];
}

/** Whether a line saying `how` starts a new definition: a new way of measuring, once there are numbers measured the old way. */
export function redefines(outcome: Pick<Outcome, "how" | "readings">, how: string | undefined): boolean {
  return how !== undefined && outcome.how !== null && how !== outcome.how && outcome.readings.some(isMeasured);
}

/**
 * The outcomes the readings make, in the order each was first measured. A reading that can't be one of them, such
 * as a count of nothing, is left out and named to `skip` by its place in `readings`.
 */
export function foldOutcomes(readings: readonly Reading[], skip: (index: number, why: string) => void = () => undefined): Outcome[] {
  const byName = new Map<string, Building>();
  let star: string | null = null;
  for (const [index, reading] of readings.entries()) {
    if (reading.of !== undefined && (reading.of <= 0 || reading.value < 0 || reading.value > reading.of)) {
      skip(index, "its count is not from 0 to its --of, which is more than 0");
      continue;
    }
    let outcome = byName.get(reading.outcome);
    if (!outcome) {
      outcome = { name: reading.outcome, unit: "", rate: null, better: null, target: null, how: null, group: null, counted: null, readings: [], earlier: [], indices: [] };
      byName.set(reading.outcome, outcome);
    }
    const set = reading.set;
    if (set) {
      if (redefines(outcome, set.how)) {
        outcome.earlier.push({ unit: outcome.unit, how: outcome.how, readings: outcome.readings });
        outcome.readings = [];
        if (outcome.rate) outcome.unit = "";
        outcome.rate = null;
      }
      outcome.unit = set.unit ?? outcome.unit;
      outcome.better = set.better ?? outcome.better;
      outcome.target = set.target ?? outcome.target;
      outcome.how = set.how ?? outcome.how;
      outcome.group = set.group ?? outcome.group;
      outcome.counted = set.counted ?? outcome.counted;
      if (set.star) star = reading.outcome;
    }
    if (isMeasured(reading)) {
      // A rate is told in percent once, here. A line written by hand that can't be one is left out.
      const rate = reading.of !== undefined;
      outcome.rate ??= rate;
      if (rate !== outcome.rate) {
        skip(index, outcome.rate ? `"${outcome.name}" is a rate, and this line has no --of` : `"${outcome.name}" is a plain number, and this line has an --of`);
        continue;
      }
      if (rate) {
        outcome.unit = "%";
        outcome.readings.push({ ...reading, value: (reading.value / reading.of!) * 100 });
        outcome.indices.push(index);
        continue;
      }
    }
    outcome.readings.push(reading);
    outcome.indices.push(index);
  }
  const { outcomes, kept } = within([...byName.values()], OUTCOMES_BUDGET);
  for (const left of byName.values()) {
    if (outcomes.includes(left)) continue;
    for (const index of left.indices) skip(index, `"${left.name}", with its definition and each line's first reading, is past the ${OUTCOMES_BUDGET / 1024 / 1024} MB a work's outcomes may take`);
  }
  return outcomes.map(({ rate: _, indices: __, ...outcome }) => ({ ...outcome, star: outcome.name === star, readings: outcome.readings.filter((r) => kept.has(r)), earlier: outcome.earlier.map((before) => ({ ...before, readings: before.readings.filter((r) => kept.has(r)) })).filter((before) => before.readings.length > 0) }));
}

/** What a value takes as JSON in a list, in bytes as it is sent. */
const sizeOf = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength + 1;

/**
 * The outcomes and readings a work's page carries, within `bytes` of JSON with the definitions they are told with.
 * An outcome is kept with its definition and each line's first reading of the definition it has now, so a line still
 * says where it started, or left out when those don't fit. Then the newest of the rest. So no busy work makes a page too large to send.
 */
function within(all: readonly Building[], bytes: number): { readonly outcomes: Building[]; readonly kept: Set<Reading> } {
  let left = bytes;
  const kept = new Set<Reading>();
  // An outcome is told with its definition and each line's first reading, or not at all. An earlier definition is told once a reading of it is.
  const outcomes = all.filter((outcome) => {
    const firsts = new Map<string, Reading>();
    for (const r of outcome.readings) if (isMeasured(r) && !firsts.has(seriesKey(r))) firsts.set(seriesKey(r), r);
    const size = sizeOf({ ...outcome, readings: [], earlier: [], indices: undefined }) + [...firsts.values()].reduce((sum, r) => sum + sizeOf(r), 0);
    if (size > left) return false;
    left -= size;
    for (const first of firsts.values()) kept.add(first);
    return true;
  });
  const told = new Set<Earlier>();
  const rest = outcomes
    .flatMap((outcome) => [...outcome.readings.map((reading): { reading: Reading; before?: Earlier } => ({ reading })), ...outcome.earlier.flatMap((before) => before.readings.map((reading) => ({ reading, before })))])
    .sort((a, b) => (a.reading.at < b.reading.at ? 1 : a.reading.at > b.reading.at ? -1 : 0));
  for (const { reading, before } of rest) {
    const size = sizeOf(reading) + (before && !told.has(before) ? sizeOf({ ...before, readings: [] }) : 0);
    if (kept.has(reading) || size > left) continue;
    kept.add(reading);
    if (before) told.add(before);
    left -= size;
  }
  return { outcomes, kept };
}

// ---------------------------------------------------------------- Lines

/** A reading's labels as one key, the same whatever order they were given in, and never the same for two different sets. */
export function labelsKey(labels: Readonly<Record<string, string>> | undefined): string {
  return labels ? JSON.stringify(Object.entries(labels).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : "";
}

/** The line a reading belongs to: readings join only with the same place and labels. */
export const seriesKey = (reading: Reading) => `${reading.where ?? ""}|${labelsKey(reading.labels)}`;

/** A reading of part of a window, which is never the next point after full ones. */
export const isPart = (reading: Reading) => reading.labels?.day === "part";

/** A reading's labels as a person reads them: the values, as written. */
export function labelText(labels: Readonly<Record<string, string>> | undefined): string {
  return labels ? Object.values(labels).join(" · ") : "";
}

/** The places a headline may come from, most trusted first. A guess is never a headline. */
const HEADLINE: readonly Where[] = ["prod", "ci", "local"];

/** One line of an outcome's readings: one place, or one label from the most trusted place it was measured. */
export interface Series {
  readonly key: string;
  /** The label's values, or for readings with no label, the place. */
  readonly label: string;
  readonly where: Where;
  readonly labelled: boolean;
  /** Its full readings, oldest first. A reading of part of a window is on no line. */
  readonly readings: readonly Measured[];
}

/**
 * Every line of an outcome: one per place for its readings with no label, in the order of `WHERE`, then one per
 * label, from the most trusted place that label was measured. A guess is drawn, but never split by a label.
 */
export function seriesOf(outcome: Pick<Outcome, "readings">): Series[] {
  const plain = new Map<Where, Measured[]>();
  const labelled = new Map<string, Measured[]>();
  for (const r of outcome.readings) {
    if (!isMeasured(r) || isPart(r)) continue;
    if (!r.labels) plain.set(r.where, [...(plain.get(r.where) ?? []), r]);
    else if (r.where !== "guess") labelled.set(labelsKey(r.labels), [...(labelled.get(labelsKey(r.labels)) ?? []), r]);
  }
  const places = WHERE.flatMap((where) => {
    const readings = plain.get(where);
    return readings ? [{ key: seriesKey(readings[0]!), label: WHERE_LABEL[where], where, labelled: false, readings }] : [];
  });
  const labels = [...labelled.values()].map((all) => {
    const where = HEADLINE.find((place) => all.some((r) => r.where === place)) ?? "local";
    const readings = all.filter((r) => r.where === where);
    return { key: seriesKey(readings[0]!), label: labelText(readings[0]?.labels), where, labelled: true, readings };
  });
  return [...places, ...labels];
}

/** The outcome's main line: its readings with no label, from the most trusted place it was measured. Null when every reading has a label. */
export function headline(outcome: Pick<Outcome, "readings">): Series | null {
  const places = seriesOf(outcome).filter((series) => !series.labelled);
  return HEADLINE.map((where) => places.find((series) => series.where === where)).find((series) => series !== undefined) ?? null;
}

/**
 * The due dates still open: the latest said for each set of labels, unless a reading of the same labels has come
 * since, from the place it is due from. A due date with no place is met by a reading from any place but a guess.
 */
export function openDue(outcome: Pick<Outcome, "readings">): Unmeasured[] {
  const latest = new Map<string, Unmeasured>();
  for (const r of outcome.readings) if (r.due !== undefined) latest.set(labelsKey(r.labels), r);
  return [...latest.values()].filter(
    (due) => !outcome.readings.some((r) => isMeasured(r) && r.at > due.at && labelsKey(r.labels) === labelsKey(due.labels) && (due.where === undefined ? r.where !== "guess" : r.where === due.where)),
  );
}

/**
 * Today as a due date is written, YYYY-MM-DD, in the calendar of the one reading it: the hub's viewer, or the
 * machine `progress check` runs on. A due date is a calendar day, so both say it is late from the same morning.
 */
export function today(now: number): string {
  const day = new Date(now);
  return `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, "0")}-${String(day.getDate()).padStart(2, "0")}`;
}

// ---------------------------------------------------------------- Better or worse

/** How many a folded rate's reading counted, of its whole: 244 of 1,114. */
export const countOf = (reading: Pick<Measured, "value" | "of">): number => Math.round(((reading.of ?? 0) * reading.value) / 100);

/** Too few counted to say anything. */
export function isSmall(reading: Pick<Measured, "n" | "of">): boolean {
  const counted = reading.of ?? reading.n;
  return counted !== undefined && counted < 30;
}

/**
 * How far a line moved from `before` to the reading `after` gives, and whether that is better, from the numbers and
 * the direction. A reading that counted too few says neither. The agent can only say unclear. Every view that says
 * how a number moved reads this, and none works it out again.
 */
export function moved(outcome: Pick<Outcome, "unit" | "better">, before: number, after: Pick<Measured, "value" | "unclear" | "where" | "n" | "of">): { readonly change: Change | null; readonly verdict: Verdict } {
  if (isSmall(after)) return { change: null, verdict: "unclear" };
  const unclear = after.unclear || after.where === "guess" || outcome.better === null || before === after.value;
  return { change: changeOf(before, after.value, outcome.unit), verdict: unclear ? "unclear" : after.value < before === (outcome.better === "lower") ? "better" : "worse" };
}

/** How far `after` is from `before`: in points for a percentage, else in percent of `before`, which can't be from zero. */
export function changeOf(before: number, after: number, unit: string): Change | null {
  if (unit === "%") return { by: after - before, in: "points" };
  return before === 0 ? null : { by: ((after - before) / Math.abs(before)) * 100, in: "percent" };
}

/** Where a line stands: its latest reading against its first, and whether that is better. */
export interface Standing {
  readonly latest: Measured;
  readonly base: Measured;
  /** Null with one reading, or when the latest counted too few to say. */
  readonly change: Change | null;
  readonly verdict: Verdict;
}

/** Where a line of an outcome stands. */
export function standing(outcome: Pick<Outcome, "unit" | "better">, readings: readonly Measured[]): Standing | null {
  const latest = readings.at(-1);
  const base = readings[0];
  if (!latest || !base) return null;
  return { latest, base, ...(latest === base ? { change: null, verdict: "unclear" } : moved(outcome, base.value, latest)) };
}

/** The number with its unit, as a person writes it: 2.96%, 738 ms, $1.28, 1,015. `digits` fixes its decimals, as a scale's numbers share theirs. */
export function formatValue(value: number, unit: string, digits?: number): string {
  const most = Math.abs(value) >= 1000 ? 0 : Math.abs(value) >= 100 ? 1 : 2;
  const number = value.toLocaleString("en-US", digits === undefined ? { maximumFractionDigits: Number.isInteger(value) ? 0 : most } : { minimumFractionDigits: digits, maximumFractionDigits: digits });
  if (unit === "") return number;
  if (unit === "%") return `${number}%`;
  if (/^[$€£]$/.test(unit)) return value < 0 ? `-${unit}${number.slice(1)}` : `${unit}${number}`;
  return `${number} ${unit}`;
}

// ---------------------------------------------------------------- The star

export function starOf(outcomes: readonly Outcome[]): Outcome | null {
  return outcomes.find((outcome) => outcome.star) ?? null;
}

/** The north star as a card shows it. Null when no outcome is the star. */
export function starLine(outcomes: readonly Outcome[]): StarLine | null {
  const star = starOf(outcomes);
  if (!star) return null;
  const line = headline(star);
  const stands = line ? standing(star, line.readings) : null;
  // In the order the labels first appeared, which a new label never reorders.
  const labelled = line ? [] : seriesOf(star).filter((series) => series.labelled);
  const split = labelled.slice(0, STAR_LABELS).map(({ label, readings }) => ({ label, value: readings.at(-1)!.value, of: readings.at(-1)!.of ?? null }));
  const due = openDue(star).map((r) => r.due ?? "").sort()[0] ?? null;
  return {
    outcome: star.name,
    unit: star.unit,
    now: stands ? { value: stands.latest.value, of: stands.latest.of ?? null, where: stands.latest.where, at: stands.latest.at, change: stands.change, verdict: stands.verdict } : null,
    values: (line?.readings ?? []).slice(-STAR_VALUES).map((r) => r.value),
    split,
    more: labelled.length - split.length,
    due,
  };
}

// ---------------------------------------------------------------- What `progress check` says

/**
 * What a prod reading lacks for anyone to check it: its window, and a source. A source holds for the readings after
 * it in the same definition, as a saved query gives each reading again, so only the window is said every time.
 */
export function uncheckable(outcome: Pick<Outcome, "readings"> | null, reading: Pick<Measured, "where" | "window" | "source">): string[] {
  if (reading.where !== "prod") return [];
  const source = reading.source ?? outcome?.readings.findLast((r) => r.source !== undefined)?.source;
  return [...(reading.window === undefined ? ["--window"] : []), ...(source === undefined ? ["--source"] : [])];
}

/** The reasons for lines left out that `progress check` names, each with its first line. */
const SKIPPED_NAMED = 5;

/** Line numbers as a person reads them: line 2, lines 2 and 5, lines 2, 5, 9 and 4 more. */
function linesText(lines: readonly number[]): string {
  if (lines.length === 1) return `line ${lines[0]}`;
  const words = lines.length > 3 ? [...lines.slice(0, 3).map(String), `${lines.length - 3} more`] : lines.map(String);
  return `lines ${words.slice(0, -1).join(", ")} and ${words.at(-1)}`;
}

/**
 * What `progress check` prints about a work's outcomes, and what it names to fix: a star with no way to measure it
 * again, a production number nobody can check, a shipped change measured only on one machine, and a reading past due.
 */
export function outcomeCheck(outcomes: readonly Outcome[], shipped: readonly string[], skipped: readonly Skipped[], today: string): { readonly lines: string[]; readonly notes: string[] } {
  const byWhy = Map.groupBy(skipped, (entry) => entry.why);
  const notes = [...byWhy].slice(0, SKIPPED_NAMED).map(([why, entries]) => `Outcomes: ${linesText(entries.map((entry) => entry.line))} of outcomes.jsonl ${entries.length === 1 ? "is" : "are"} left out: ${why}. Fix it by hand, or record the reading again with progress measure.`);
  const unnamed = [...byWhy.values()].slice(SKIPPED_NAMED).flat().length;
  if (unnamed > 0) notes.push(`Outcomes: ${unnamed} more lines of outcomes.jsonl are left out.`);
  if (outcomes.length === 0) return { lines: [], notes };
  const all = outcomes.flatMap((outcome) => outcome.readings);
  const star = starOf(outcomes);
  const latest = all.filter(isMeasured).sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0)).at(-1);
  const lines = [`Outcomes: ${outcomes.length === 1 ? "1 outcome" : `${outcomes.length} outcomes`}, ${all.length === 1 ? "1 reading" : `${all.length} readings`}${latest ? `, the latest at ${latest.at}` : ""}`];
  if (star) {
    const now = headline(star)?.readings.at(-1);
    lines.push(`North star: ${star.name}${now ? `, ${formatValue(now.value, star.unit)} in ${WHERE_LABEL[now.where]}` : ""}`);
    if (star.how === null) notes.push(`Outcomes: the north star "${star.name}" does not say how it is measured. progress measure "${star.name}" --how "<how it is measured>"`);
  } else {
    lines.push("North star: none. Mark the one number this work moves with --star.");
  }
  for (const outcome of outcomes) {
    const prod = outcome.readings.filter((r): r is Measured => isMeasured(r) && r.where === "prod").at(-1);
    const lacks = prod ? uncheckable({ readings: outcome.readings.slice(0, outcome.readings.indexOf(prod)) }, prod) : [];
    if (lacks.length) notes.push(`Outcomes: the latest prod reading of "${outcome.name}" has no ${lacks.join(" or ")}, so nobody can check it. Give ${lacks.length === 1 ? "it" : "them"} on the next reading.`);
    for (const due of openDue(outcome)) if (due.due !== undefined && due.due < today) notes.push(`Outcomes: a reading of "${outcome.name}" was due on ${due.due}. Record it, or say when it is due now with --due.`);
  }
  const shippedRefs = shipped.flatMap(githubRefs);
  const changes = new Map<string, Measured[]>();
  for (const r of all) if (isMeasured(r) && r.change !== undefined) changes.set(r.change, [...(changes.get(r.change) ?? []), r]);
  for (const [change, readings] of changes) {
    const refs = githubRefs(change);
    const isShipped = refs.some((ref) => shippedRefs.some((other) => sameRef(ref, other)));
    if (isShipped && readings.every((r) => r.where === "local" || r.where === "guess")) notes.push(`Outcomes: ${change} has shipped, and its only readings are local. Measure what it did in prod or CI.`);
  }
  return { lines, notes };
}
