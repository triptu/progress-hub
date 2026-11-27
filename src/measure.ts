/**
 * `progress measure`: what its words and flags say, checked, as one line of a work's outcomes.jsonl.
 * Everything here is pure; main.ts reads the file and appends the line under the page's lock.
 */
import { type Better, type Definition, foldOutcomes, formatValue, isMeasured, type Reading, redefines, uncheckable, WHERE, type Where, WHERE_LABEL } from "./core/outcomes.ts";
import type { Instant, SessionRef } from "./core/types.ts";
import { flagsOf, one as last, UsageError } from "./flags.ts";

const VALUED = ["where", "from", "of", "change", "by", "n", "window", "source", "note", "due", "target", "how", "group", "work"] as const;
const SWITCHES = ["unclear", "dropped", "lower", "higher", "star"] as const;
type Valued = (typeof VALUED)[number];
type Switch = (typeof SWITCHES)[number];

/** What the command was asked, before it is checked against the outcome's readings so far. */
export interface MeasureAsk {
  readonly outcome: string;
  readonly value: string | null;
  readonly flags: ReadonlyMap<string, readonly string[]>;
}

export const MEASURE_USAGE = `progress measure "<outcome>" <value> --where prod|ci|local|guess
    --from <value>        the value before, for a one-off before and after
    --of <count>          the denominator: 244 --of 1114
    --change <link|words> the change this reading is about
    --by <key>=<value>    a segment: job=arm64, client=web. --by day=part for part of a window
    --unclear | --dropped the difference is inside the noise | the change was not kept
    --n <count>           how many were counted, with what they are if you like: --n "19,530 searches"
    --window "<words>"  --source <file|link>  --note "<line>"
    --due <YYYY-MM-DD>    a reading expected later, with no value
  The definition, on the first reading and again only to change it:
    --lower | --higher  --target <value>  --star  --how "<how it is measured>"  --group "<section>"`;

/** The words and flags of `progress measure`, with the work it names, if it names one. */
export function readMeasure(args: readonly string[]): MeasureAsk & { readonly work: string | undefined } {
  const { words, flags } = flagsOf(args, VALUED, SWITCHES);
  for (const [name, values] of flags) if (values.some((value) => /[\r\n]/.test(value))) throw new UsageError(`--${name} is one line.`);
  const [outcome, value, ...rest] = words;
  if (outcome === undefined || outcome.trim() === "") throw new UsageError(`Name the outcome and give its value.\n${MEASURE_USAGE}`);
  if (rest.length > 0) throw new UsageError(`progress measure takes the outcome's name and one value, and "${rest.join(" ")}" is more. Put a name with spaces in quotes.`);
  if (/[\r\n]/.test(outcome)) throw new UsageError("An outcome's name is one line.");
  return { outcome: outcome.trim(), value: value ?? null, flags, work: last(flags, "work")?.trim() };
}

/** A number as written, with its unit before or after: 2.96%, 738ms, 22.4 s, $1.28, 1,015. */
export function parseValue(written: string): { readonly value: number; readonly unit: string } | null {
  const match = /^\s*([$€£])?\s*(-?(?:\d{1,3}(?:,\d{3})+|\d+)?(?:\.\d+)?)\s*([a-zA-Zµ%/]+)?\s*$/.exec(written);
  if (!match?.[2] || match[2] === "-" || (match[1] && match[3])) return null;
  const value = Number(match[2].replace(/,/g, ""));
  return Number.isFinite(value) ? { value, unit: match[1] ?? match[3] ?? "" } : null;
}

const one = (ask: MeasureAsk, name: Valued) => last(ask.flags, name)?.trim();
/** A flag's value as a field of the line, or nothing when it was not given. */
const given = <K extends Valued>(ask: MeasureAsk, name: K): { [P in K]?: string } => {
  const value = one(ask, name);
  return value === undefined ? {} : ({ [name]: value } as { [P in K]: string });
};

/** A count as written, with what it counts after it if given: 19530, 19,530 searches. */
function wholeOf(ask: MeasureAsk, name: "of" | "n"): { readonly value: number; readonly noun: string | undefined } | undefined {
  const written = one(ask, name);
  if (written === undefined) return undefined;
  const match = /^([\d,]+)(?:\s+(\D.*))?$/.exec(written);
  const value = Number(match?.[1]?.replace(/,/g, "") ?? NaN);
  if (!Number.isInteger(value) || value < 0) throw new UsageError(`--${name} is a count, a whole number such as 1114, with what it counts after it if you like ("19,530 searches"), and "${written}" is not.`);
  return { value, noun: match?.[2]?.trim() };
}

const unitName = (unit: string) => (unit === "" ? "plain numbers, with no unit" : unit);

/**
 * The line the ask makes, given the outcome's readings so far, and what the command says about it. Throws
 * `UsageError` with the reason when the ask can't be a reading, such as a value in another unit.
 */
export function measureLine(ask: MeasureAsk, earlier: readonly Reading[], at: Instant, by: SessionRef | null): { readonly reading: Reading; readonly said: string } {
  const name = ask.outcome;
  const outcomes = foldOutcomes(earlier);
  const current = outcomes.find((outcome) => outcome.name === name) ?? null;
  const has = (flag: Switch) => ask.flags.has(flag);
  const whereText = one(ask, "where");
  if (whereText !== undefined && !(WHERE as readonly string[]).includes(whereText)) throw new UsageError(`--where is prod, ci, local or guess, and "${whereText}" is not one.`);
  const place = whereText as Where | undefined;
  const due = one(ask, "due");
  if (has("lower") && has("higher")) throw new UsageError("Give --lower or --higher, not both.");
  const better: Better | undefined = has("lower") ? "lower" : has("higher") ? "higher" : undefined;
  const how = one(ask, "how");
  const parsed = ask.value === null ? null : parseValue(ask.value);
  if (ask.value !== null && parsed === null) throw new UsageError(`"${ask.value}" is not a number. Write it with its unit, such as 2.96%, 738ms, 22.4s or $1.28.`);

  // The first value fixes the unit, and whether the outcome is a rate, counted with --of. Only a new --how changes them.
  const measured = current?.readings.some(isMeasured) ?? false;
  const redefining = current !== null && redefines(current, how);
  const fixed = measured && !redefining ? current : null;
  const ofWritten = wholeOf(ask, "of");
  const nWritten = wholeOf(ask, "n");
  const of = ofWritten?.value;
  const n = nWritten?.value;
  const counted = nWritten?.noun ?? ofWritten?.noun;
  const rate = fixed ? fixed.readings.find(isMeasured)?.of !== undefined : of !== undefined;
  if (parsed && fixed && rate !== (of !== undefined)) {
    throw new UsageError(
      rate
        ? `"${name}" is a rate, a count of a whole. Give this reading's whole with --of, or start a new definition with a new --how. Nothing was written.`
        : `"${name}" is a plain number, and --of would make this reading a rate. Leave out --of, or start a new definition with a new --how. Nothing was written.`,
    );
  }
  if (parsed && fixed && !rate && parsed.unit !== fixed.unit) {
    throw new UsageError(`"${name}" is measured in ${unitName(fixed.unit)}, and ${ask.value} is in ${unitName(parsed.unit)}. Give it in ${unitName(fixed.unit)}, or start a new definition with a new --how. Nothing was written.`);
  }
  if (of !== undefined) {
    if (of === 0) throw new UsageError("--of is the whole that was counted, so it is more than 0.");
    if (parsed && (parsed.unit !== "" || !Number.isInteger(parsed.value) || parsed.value < 0 || parsed.value > of)) throw new UsageError(`With --of ${of}, the value is how many of them: a whole number from 0 to ${of}, and "${ask.value}" is not.`);
  }
  // --from and --target are in the outcome's unit, which for a rate is percent. A number with no unit is taken as in it.
  const unit = rate ? "%" : (parsed?.unit ?? (measured || current?.unit ? (current?.unit ?? "") : null));
  const inUnit = (flag: "from" | "target") => {
    const written = one(ask, flag);
    if (written === undefined) return undefined;
    const value = parseValue(written);
    if (!value) throw new UsageError(`--${flag} "${written}" is not a number.`);
    if (unit !== null && value.unit !== "" && value.unit !== unit) throw new UsageError(`--${flag} ${written} is in ${unitName(value.unit)}, and "${name}" is in ${unitName(unit)}.`);
    return value.value;
  };
  const from = inUnit("from");
  const target = inUnit("target");

  if (parsed) {
    if (place === undefined) throw new UsageError(`Say where ${ask.value} was measured: --where prod, ci, local, or guess for a number nobody measured.`);
    if (due !== undefined) throw new UsageError("--due is for a reading expected later, which has no value yet. Give the value, or --due, not both.");
  } else {
    for (const flag of ["from", "of"] as const) if (one(ask, flag) !== undefined) throw new UsageError(`--${flag} goes with a value.`);
    if (has("unclear")) throw new UsageError("--unclear goes with a value.");
  }
  if (has("dropped") && one(ask, "change") === undefined) throw new UsageError("--dropped says a change was not kept. Name it with --change.");
  if (due !== undefined && (!/^\d{4}-\d{2}-\d{2}$/.test(due) || Number.isNaN(Date.parse(due)))) throw new UsageError(`--due is a date as YYYY-MM-DD, and "${due}" is not.`);

  const labels: Record<string, string> = {};
  for (const pair of ask.flags.get("by") ?? []) {
    const match = /^([^=]+)=(.+)$/.exec(pair);
    if (!match?.[1]?.trim() || !match[2]?.trim()) throw new UsageError(`--by is a segment as <key>=<value>, such as job=arm64, and "${pair}" is not.`);
    labels[match[1].trim()] = match[2].trim();
  }

  // Only what changes the definition is written, so each line says what it changed.
  const set: { -readonly [K in keyof Definition]: Definition[K] } = {};
  // A new definition starts with no unit, so it writes the one its first value gives.
  if (parsed && !rate && (redefining || (!fixed && parsed.unit !== (current?.unit ?? "")))) set.unit = parsed.unit;
  if (better !== undefined && better !== current?.better) set.better = better;
  if (target !== undefined && target !== current?.target) set.target = target;
  if (has("star") && !current?.star) set.star = true;
  if (how !== undefined && how !== current?.how) set.how = how;
  if (counted !== undefined && counted !== current?.counted) set.counted = counted;
  const group = one(ask, "group");
  if (group !== undefined && group !== current?.group) set.group = group;
  const setting = Object.keys(set).length > 0;
  if (!parsed && due === undefined && !setting && one(ask, "note") === undefined) {
    throw new UsageError(`Give "${name}" a value, a --due date, or a change to its definition.\n${MEASURE_USAGE}`);
  }

  // The fields in the order a person reads a line: who and what, the number and where, then the rest.
  const head = { at, ...(by ? { by } : {}), outcome: name };
  const rest = {
    ...(Object.keys(labels).length ? { labels } : {}),
    ...given(ask, "change"),
    ...(has("unclear") ? { unclear: true as const } : {}),
    ...(has("dropped") ? { dropped: true as const } : {}),
    ...(n !== undefined ? { n } : {}),
    ...given(ask, "window"),
    ...given(ask, "source"),
    ...given(ask, "note"),
    ...(setting ? { set } : {}),
  };
  const reading: Reading = parsed
    ? { ...head, value: parsed.value, ...(of !== undefined ? { of } : {}), ...(from !== undefined ? { from } : {}), where: place!, ...rest }
    : { ...head, ...(place ? { where: place } : {}), ...(due !== undefined ? { due } : {}), ...rest };

  const shown = unit ?? "";
  const value = parsed ? (of !== undefined ? `${formatValue((parsed.value / of) * 100, "%")}, ${formatValue(parsed.value, "")} of ${formatValue(of, "")}` : formatValue(parsed.value, shown)) : "";
  const said = [
    parsed
      ? `Recorded "${name}": ${from !== undefined ? `${formatValue(from, shown)} to ` : ""}${value}, in ${WHERE_LABEL[place!]}.`
      : due !== undefined
        ? `Recorded that a reading of "${name}" is due on ${due}.`
        : `Recorded "${name}".`,
  ];
  if (redefining) said.push("This starts a new definition. The readings before it stay in its list, and no chart compares them with the ones after.");
  if (set.star) said.push(`"${name}" is the work's north star now.`);
  if ((set.star || current?.star) && (how ?? current?.how ?? null) === null) said.push(`Say how it is measured, so the next agent measures it the same way: --how "<how>".`);
  const lacks = parsed ? uncheckable(redefining ? null : current, { where: place!, ...given(ask, "window"), ...given(ask, "source") }) : [];
  if (lacks.length) said.push(`A prod number is checkable with its ${lacks.join(" and ")}. Give ${lacks.length === 1 ? "it" : "them"} next time.${lacks.includes("--source") ? " A --source holds for the readings after it." : ""}`);
  return { reading, said: said.join("\n") };
}
