import { useId, useLayoutEffect, useRef, useState } from "react";
import type { CSSProperties, PointerEvent } from "react";
import { formatValue, isSmall, seriesOf, standing, WHERE_LABEL, type Change, type Outcome, type Series, type Verdict, type Where } from "../../core/outcomes.ts";
import { amountText, changeText, slotAt, slotsOf, ticksOf } from "../lib/outcomes.ts";
import { CaretDownIcon, CaretUpIcon } from "@phosphor-icons/react";
import s from "./Chart.module.css";

/** What a chart marks beside its readings: when each change took effect, and when other shipped work went live. */
export interface Marks {
  readonly changes: readonly { readonly at: number; readonly label: string }[];
  readonly lives: readonly number[];
}

const NO_MARKS: Marks = { changes: [], lives: [] };

/** The width the element has on screen, followed as it changes. */
function useWidth<T extends HTMLElement>(): [React.RefObject<T | null>, number] {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => setWidth(Math.round(entry?.contentRect.width ?? 0)));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return [ref, width];
}

/**
 * How a line is drawn: a place as a step line in its own style, a label as a straight line in a project colour by
 * its place among the labels, and faint when its latest reading counted too few.
 */
const faint = (series: Series) => series.labelled && isSmall(series.readings.at(-1)!);
const colourOf = (all: readonly Series[], series: Series) => (series.labelled ? ({ "--c": `var(--p${all.filter((other) => other.labelled).indexOf(series) % 6})` } as CSSProperties) : undefined);

/**
 * An outcome's readings over time, one line per place it was measured for those with no label, and one per label
 * for those with one. A labelled outcome lists its labels under the chart, and each row lights its line.
 */
export function OutcomeChart(props: { readonly outcome: Outcome; readonly marks?: Marks }) {
  const { outcome } = props;
  const [hovered, setHovered] = useState<string | null>(null);
  const [pinned, setPinned] = useState<string | null>(null);
  const all = seriesOf(outcome);
  const labelled = all.filter((series) => series.labelled);
  const drawn = all.some((line) => line.readings.length >= 2);
  const lit = hovered ?? pinned;
  return (
    <figure className={s.chart}>
      {drawn ? <Plot name={outcome.name} lines={all} unit={outcome.unit} target={outcome.target} marks={props.marks ?? NO_MARKS} lit={lit} /> : null}
      {labelled.length ? (
        <ul className={s.rows}>
          {labelled.map((line) => {
            const last = line.readings.at(-1)!;
            const amount = amountText(last, outcome.unit, outcome.counted);
            const stands = standing(outcome, line.readings);
            return (
              <li key={line.key}>
                <button
                  type="button"
                  className={`row-btn ${s.row}`}
                  style={colourOf(all, line)}
                  data-small={faint(line) ? "" : undefined}
                  data-lit={lit === null ? undefined : lit === line.key ? "on" : "off"}
                  aria-pressed={drawn ? pinned === line.key : undefined}
                  disabled={!drawn}
                  onPointerEnter={() => setHovered(line.key)}
                  onPointerLeave={() => setHovered(null)}
                  onClick={() => setPinned(pinned === line.key ? null : line.key)}
                >
                  <span className={s.rowLabel}>
                    {drawn ? <span className={s.swatch} aria-hidden /> : null}
                    {line.label}
                  </span>
                  <span className={s.rowValue}>
                    <b>{amount.main}</b>
                    {amount.counts ? <span className={s.counts}>{amount.counts}</span> : null}
                  </span>
                  <span className={s.rowChange}>{stands ? <Delta verdict={stands.verdict} change={stands.change} /> : null}</span>
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}
      {drawn ? <Legend lines={labelled.length ? [] : all} marks={props.marks ?? NO_MARKS} target={outcome.target} unit={outcome.unit} /> : null}
    </figure>
  );
}

const HEIGHT = 208;
const LEFT = 48;
const RIGHT = 16;
const BOTTOM = 28;
const MARK_ROW = 18;
/** How close two change marks may be before they share one label. */
const MARK_ROOM = 64;

/** Change marks with one label for those too close to name apart: "2 changes", with each named in its title. */
function markGroups(marks: readonly { readonly x: number; readonly label: string }[]): { readonly xs: number[]; readonly label: string; readonly title: string }[] {
  const groups: { xs: number[]; labels: string[] }[] = [];
  for (const mark of [...marks].sort((a, b) => a.x - b.x)) {
    const last = groups.at(-1);
    if (last && mark.x - last.xs[0]! < MARK_ROOM) {
      last.xs.push(mark.x);
      last.labels.push(mark.label);
    } else groups.push({ xs: [mark.x], labels: [mark.label] });
  }
  return groups.map(({ xs, labels }) => ({ xs, label: labels.length === 1 ? labels[0]! : `${labels.length} changes`, title: labels.join(", ") }));
}

/** How many decimals a scale's numbers need, so each is written with the same. Read from 3e-7 as from 0.25, and at most the 20 a number is written with. */
const decimalsOf = (ticks: readonly number[]) =>
  Math.min(
    20,
    Math.max(
      0,
      ...ticks.map((tick) => {
        const [digits = "", power = "0"] = tick.toExponential().split("e");
        return (digits.split(".")[1]?.length ?? 0) - Number(power);
      }),
    ),
  );

/** The chart itself: the scale, the lines, what took effect when, and the values under the pointer. */
function Plot(props: { readonly name: string; readonly lines: readonly Series[]; readonly unit: string; readonly target: number | null; readonly marks: Marks; readonly lit: string | null }) {
  const { lines, unit, target, marks, lit } = props;
  const [box, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const slots = slotsOf(lines);
  // The scale fits the lines that counted enough. A faint one is cut where it leaves it.
  const fitted = lines.some((line) => !faint(line)) ? lines.filter((line) => !faint(line)) : lines;
  const values = [...fitted.flatMap((line) => line.readings.map((r) => r.value)), ...(target !== null ? [target] : [])];
  const clip = `plot-${useId().replace(/:/g, "")}`;
  const ticks = ticksOf(Math.min(...values), Math.max(...values), 4);
  const digits = decimalsOf(ticks);
  const low = ticks[0] ?? 0;
  const high = ticks.at(-1) ?? 1;
  // A labelled line is named at its end, which takes room on the right: its name and value, or on a phone its value.
  const ends = lines.some((line) => line.labelled);
  const wide = width >= 560;
  // As much room as the longest end label takes, so the chart fills its column.
  const endChars = Math.max(0, ...lines.filter((line) => line.labelled).map((line) => (wide ? `${line.label} ` : "").length + amountText(line.readings.at(-1)!, unit).main.length));
  const right = ends ? Math.min(160, 16 + endChars * 7) : RIGHT;
  const plotWidth = Math.max(0, width - LEFT - right);
  const step = plotWidth / Math.max(1, slots.labels.length);
  const x = (slot: number) => LEFT + (slot + 0.5) * step;
  const changes = markGroups(marks.changes.map((mark) => ({ x: x(slotAt(slots.times, mark.at)), label: mark.label })).filter((mark) => mark.x >= LEFT && mark.x <= LEFT + plotWidth));
  const top = 12 + (changes.length ? MARK_ROW : 0);
  const y = (value: number) => top + (1 - (value - low) / (high - low || 1)) * (HEIGHT - top - BOTTOM);
  // As many places named as their words fit, with a gap between.
  const labelWidth = Math.max(0, ...slots.labels.map((label) => label.length)) * 7 + 20;
  const every = Math.max(1, Math.ceil(slots.labels.length / Math.max(1, Math.floor(plotWidth / labelWidth))));
  const lives = marks.lives.map((at) => x(slotAt(slots.times, at))).filter((at) => at >= LEFT && at <= LEFT + plotWidth);
  // End labels move apart so two lines that end close together stay readable.
  const endYs = lines.map((line) => y(line.readings.at(-1)?.value ?? 0));
  const placed = [...endYs];
  const order = endYs.map((_, i) => i).sort((a, b) => endYs[a]! - endYs[b]!);
  order.forEach((index, k) => {
    const prev = order[k - 1];
    if (prev !== undefined && placed[index]! - placed[prev]! < 14) placed[index] = placed[prev]! + 14;
  });

  const onMove = (event: PointerEvent<SVGSVGElement>) => {
    const left = event.clientX - event.currentTarget.getBoundingClientRect().left;
    const slot = Math.round((left - LEFT) / step - 0.5);
    setHover(slot >= 0 && slot < slots.labels.length ? slot : null);
  };
  const hovered = hover === null ? [] : lines.flatMap((line) => line.readings.filter((r) => slots.of(r) === hover).map((reading) => ({ line, reading })));
  // Faint lines are drawn first, behind the others.
  const drawOrder = [...lines].sort((a, b) => Number(!faint(a)) - Number(!faint(b)));
  // The target is named in the scale's own column, so its words never sit on a line. A tick too near it gives way.
  const ticksShown = target === null ? ticks : ticks.filter((tick) => Math.abs(y(tick) - y(target)) >= 12);
  // The tip sits under the change labels, beside the guide, on the side with room.
  const tipX = hover === null ? 0 : x(hover);
  const tipSide = tipX > LEFT + plotWidth * 0.6 ? "left" : "right";

  return (
    <div className={s.plot} ref={box}>
      {width > 0 ? (
        <svg width={width} height={HEIGHT} className={s.svg} role="img" aria-label={`${props.name} over ${slots.labels.length} readings`} onPointerMove={onMove} onPointerLeave={() => setHover(null)}>
          <clipPath id={clip}>
            <rect x={LEFT - 6} y={top - 6} width={plotWidth + right + 6} height={HEIGHT - BOTTOM - top + 12} />
          </clipPath>
          {ticks.map((tick) => (
            <line key={tick} x1={LEFT} x2={LEFT + plotWidth} y1={y(tick)} y2={y(tick)} className={s.grid} />
          ))}
          {ticksShown.map((tick) => (
            <text key={tick} x={LEFT - 8} y={y(tick)} className={s.tick} textAnchor="end" dominantBaseline="middle">
              {formatValue(tick, unit, digits)}
            </text>
          ))}
          {target !== null ? (
            <g>
              <line x1={LEFT} x2={LEFT + plotWidth} y1={y(target)} y2={y(target)} className={s.target} />
              <text x={LEFT - 8} y={y(target)} className={s.targetLabel} textAnchor="end" dominantBaseline="middle">
                {formatValue(target, unit, Math.max(digits, decimalsOf([target])))}
              </text>
            </g>
          ) : null}
          {lives.map((at, i) => (
            <line key={i} x1={at} x2={at} y1={HEIGHT - BOTTOM - 8} y2={HEIGHT - BOTTOM} className={s.live} />
          ))}
          {changes.map((group, i) => {
            const middle = (group.xs[0]! + group.xs.at(-1)!) / 2;
            const half = group.label.length * 3.6 + 4;
            return (
              <g key={i}>
                <title>{group.title}</title>
                {group.xs.map((at, j) => (
                  <line key={j} x1={at} x2={at} y1={top - 2} y2={HEIGHT - BOTTOM} className={s.change} />
                ))}
                <text x={Math.min(Math.max(middle, LEFT + half), width - half)} y={12} className={s.changeLabel} textAnchor="middle">
                  {group.label}
                </text>
              </g>
            );
          })}
          {drawOrder.map((line) => {
            const i = lines.indexOf(line);
            const points = line.readings.map((r) => [x(slots.of(r)), y(r.value)] as const);
            const path = points.map(([px, py], j) => (j === 0 ? `M${px},${py}` : line.labelled ? `L${px},${py}` : `H${px}V${py}`)).join("");
            const last = line.readings.at(-1)!;
            return (
              <g
                key={line.key}
                className={s.line}
                style={colourOf(lines, line)}
                data-where={line.labelled ? undefined : line.where}
                data-small={faint(line) ? "" : undefined}
                data-lit={lit === null ? undefined : lit === line.key ? "on" : "off"}
                clipPath={faint(line) ? `url(#${clip})` : undefined}
              >
                <path d={path} className={s.stroke} />
                {points.map(([px, py], j) => (
                  <circle key={j} cx={px} cy={py} r={(faint(line) ? 2 : 3.5) + (hover === slots.of(line.readings[j]!) ? 1.5 : 0)} className={s.dot} />
                ))}
                {line.labelled ? (
                  <text x={x(slots.of(last)) + 8} y={placed[i]} className={s.endLabel} dominantBaseline="middle">
                    {wide ? `${line.label} ${amountText(last, unit).main}` : amountText(last, unit).main}
                  </text>
                ) : null}
              </g>
            );
          })}
          {hover !== null ? <line x1={x(hover)} x2={x(hover)} y1={top} y2={HEIGHT - BOTTOM} className={s.guide} /> : null}
          {slots.labels.map((label, i) =>
            named(i, slots.labels.length, every) && label !== slots.labels[i - 1] ? (
              <text key={i} x={x(i)} y={HEIGHT - 8} className={s.tick} textAnchor="middle">
                {label}
              </text>
            ) : null,
          )}
        </svg>
      ) : (
        <div className={s.svg} style={{ height: HEIGHT }} />
      )}
      {hover !== null && hovered.length ? (
        <div className={s.tip} data-side={tipSide} style={{ left: tipX, top } as CSSProperties}>
          {hovered.length === 1 ? (
            <span>
              {slots.labels[hover]} · {lines.length > 1 ? `${hovered[0]!.line.label} ` : ""}
              <b>{amountText(hovered[0]!.reading, unit).main}</b>
            </span>
          ) : (
            <>
              <span>{slots.labels[hover]}</span>
              {hovered.map(({ line, reading }) => (
                <span key={line.key}>
                  {line.label} <b>{amountText(reading, unit).main}</b>
                </span>
              ))}
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}

/** What the chart's marks mean, for a chart with no rows under it. */
function Legend(props: { readonly lines: readonly Series[]; readonly marks: Marks; readonly target: number | null; readonly unit: string }) {
  if (props.lines.length === 0 && props.target === null && props.marks.changes.length === 0 && props.marks.lives.length === 0) return null;
  return (
    <figcaption className={s.legend}>
      {props.lines.map((line) => (
        <span key={line.key} className={s.key}>
          <svg width="20" height="10" className={s.line} data-where={line.labelled ? undefined : line.where} aria-hidden>
            <line x1="0" x2="20" y1="5" y2="5" className={s.stroke} />
            <circle cx="10" cy="5" r="3" className={s.dot} />
          </svg>
          {line.label}
        </span>
      ))}
      {props.marks.changes.length ? (
        <span className={s.key}>
          <svg width="20" height="10" aria-hidden>
            <line x1="0" x2="20" y1="9.5" y2="9.5" className={s.keyBase} />
            <line x1="10" x2="10" y1="0" y2="9.5" className={s.change} />
            <circle cx="10" cy="1.5" r="1.5" className={s.keyPin} />
          </svg>
          Change
        </span>
      ) : null}
      {props.marks.lives.length ? (
        <span className={s.key}>
          <svg width="20" height="10" aria-hidden>
            <line x1="0" x2="20" y1="9.5" y2="9.5" className={s.keyBase} />
            <line x1="10" x2="10" y1="4" y2="9.5" className={s.live} />
          </svg>
          Went live
        </span>
      ) : null}
      {props.target !== null ? (
        <span className={s.key}>
          <svg width="20" height="10" aria-hidden>
            <line x1="0" x2="20" y1="5" y2="5" className={s.target} />
          </svg>
          Target {formatValue(props.target, props.unit)}
        </span>
      ) : null}
    </figcaption>
  );
}

/** A few values as a line the size of a word, coloured by whether the last is better than the first. */
export function Sparkline(props: { readonly values: readonly number[]; readonly verdict: Verdict; readonly size?: "s" | "m" }) {
  const { values } = props;
  const [w, h] = props.size === "s" ? [44, 14] : [64, 18];
  if (values.length < 2) return <span className={s.spark} data-size={props.size ?? "m"} aria-hidden />;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const points = values.map((value, i) => [1.5 + (i / (values.length - 1)) * (w - 3), 1.5 + (1 - (value - min) / (max - min || 1)) * (h - 3)] as const);
  const last = points.at(-1)!;
  return (
    <svg width={w} height={h} className={s.spark} data-size={props.size ?? "m"} data-verdict={props.verdict} aria-hidden>
      <polyline points={points.map(([px, py]) => `${px},${py}`).join(" ")} />
      <circle cx={last[0]} cy={last[1]} r={1.75} />
    </svg>
  );
}

/** Better or worse as an arrow and how far, in the colour that says which. "Unclear" when the agent said so. */
export function Delta(props: { readonly verdict: Verdict; readonly change: Change | null; readonly unclear?: boolean }) {
  const { change, verdict } = props;
  if (props.unclear) {
    return (
      <span className={s.delta} data-verdict="unclear">
        Unclear
      </span>
    );
  }
  // From zero there is no share to give, only which way it went.
  if (change === null) {
    return verdict === "unclear" ? null : (
      <span className={s.delta} data-verdict={verdict}>
        {verdict === "better" ? "Better" : "Worse"}
      </span>
    );
  }
  if (change.by === 0) {
    return (
      <span className={s.delta} data-verdict="unclear">
        No change
      </span>
    );
  }
  return (
    <span className={s.delta} data-verdict={verdict} title={verdict === "unclear" ? "Too few counted, or no direction set, to call it better or worse" : verdict === "better" ? "Better" : "Worse"}>
      {change.by < 0 ? <CaretDownIcon weight="fill" aria-label="down" /> : <CaretUpIcon weight="fill" aria-label="up" />}
      {changeText(change)}
    </span>
  );
}

/** Where a number was measured: production and CI solid, local outlined, a guess dashed. */
export function WhereTag(props: { readonly where: Where }) {
  return (
    <span className={s.where} data-where={props.where}>
      {WHERE_LABEL[props.where]}
    </span>
  );
}

/** Whether the axis names a slot: about every `every`th, and always the last, with room before it. */
const named = (i: number, count: number, every: number) => i === count - 1 || (i % every === 0 && count - 1 - i >= Math.ceil(every * 0.7));
