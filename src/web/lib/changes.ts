import type { WorkChange } from "../../core/changes.ts";
import { diffOfFiles, headline, type Diff, type HeadlinePart, type Mark, type Row, type TableDiff } from "../../core/ddl.ts";
import type { Instant } from "../../core/types.ts";
import { matches } from "./needs.ts";
import { dayOf } from "./time.ts";

/** A change as the tab shows it: what its SQL does, worked out here, its headline, and whether it is new since the user last looked. */
export interface ChangeCard {
  readonly change: WorkChange;
  readonly diff: Diff;
  readonly headline: readonly HeadlinePart[];
  readonly fresh: boolean;
}

export interface ChangeDay {
  readonly key: string;
  readonly label: string;
  readonly cards: readonly ChangeCard[];
}

/** When a change happened as the tab dates it: when its pull request merged, else when it was recorded. */
export const changeTime = (change: WorkChange): Instant => change.pull?.mergedAt ?? change.at;

/** What a table's head says about it beside its name. A table only changed says nothing: its rows say what changed. */
export function tableMark(table: TableDiff): string | null {
  if (table.rebuilt) return "Rebuilt";
  const marks: Partial<Record<Mark, string>> = { added: "New table", dropped: "Dropped", replaced: "Replaced", renamed: table.from ? `Renamed from ${table.from}` : "Renamed" };
  return marks[table.mark] ?? null;
}

/** The word a row of each kind is named by beside its name, or in place of it when it has none. A column needs none. */
export const ROW_WORD: Readonly<Record<Row["kind"], string>> = { column: "", index: "index", constraint: "constraint", trigger: "trigger", policy: "policy", security: "security", data: "data", other: "change" };

/** Every word the card shows, so the filter finds what is on screen: names, marks, kinds, types and tags. */
function shownText(card: ChangeCard): (string | null)[] {
  const { change, diff } = card;
  return [
    change.why,
    change.workTitle,
    change.project,
    change.db ?? null,
    change.pull ? `#${change.pull.number} ${change.pull.title}` : change.pr,
    ...change.files.map((file) => file.path),
    ...card.headline.map((part) => part.text),
    ...diff.tables.flatMap((table) => [table.name, tableMark(table), table.module ?? null, ...table.rows.flatMap((row) => [row.mark, row.name, row.from ?? null, ROW_WORD[row.kind], row.detail, ...row.tags])]),
    ...diff.objects.flatMap((object) => [object.mark, object.kind, object.name, object.detail, ...object.tags]),
  ];
}

/** The changes in days, newest first, each with what it does, narrowed to what the filter matches. New is newer than `seenBefore`. */
export function changeDays(changes: readonly WorkChange[], query: string, seenBefore: Instant, now: number): ChangeDay[] {
  const days = new Map<string, { label: string; cards: ChangeCard[] }>();
  const cards = changes
    .map((change): ChangeCard => {
      const diff = diffOfFiles(change.files);
      return { change, diff, headline: headline(diff), fresh: Date.parse(change.at) > Date.parse(seenBefore) };
    })
    .filter((card) => matches(query, ...shownText(card)))
    .sort((a, b) => Date.parse(changeTime(b.change)) - Date.parse(changeTime(a.change)));
  for (const card of cards) {
    const { key, label } = dayOf(changeTime(card.change), now);
    const day = days.get(key) ?? { label, cards: [] };
    day.cards.push(card);
    days.set(key, day);
  }
  return [...days].map(([key, day]) => ({ key, ...day }));
}
