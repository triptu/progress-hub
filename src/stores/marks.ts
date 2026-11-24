import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { doneKey, viewKey } from "../core/marks.ts";
import type { MarkKind, Marks } from "../core/types.ts";

export const MARK_KINDS: readonly MarkKind[] = ["viewed", "dismissed"];

/** The key each kind of mark gives an item of a work's page. */
const ITEM_KEY: Record<MarkKind, (work: string, itemId: string) => string> = { viewed: viewKey, dismissed: doneKey };

/** For each work, the id each of its items had before it was reworded, as the id it has now. */
export type FormerIds = ReadonlyMap<string, ReadonlyMap<string, string>>;

/**
 * What the user marked in the hub, kept in one file in the progress home so every browser shows the same.
 * It is the hub's own file: no page is edited, and an agent never reads it.
 *
 * A mark stays under the id it was made on. An item an agent reworded is still marked by a mark on an earlier
 * id: `formerIds` says which those are, from the works' journals, each time the marks are read.
 */
export class MarkStore {
  private readonly sets: Record<MarkKind, ReadonlySet<string>> = { viewed: new Set(), dismissed: new Set() };

  private readonly file: string;
  private readonly formerIds: () => FormerIds;

  constructor(file: string, formerIds: () => FormerIds = () => new Map()) {
    this.file = file;
    this.formerIds = formerIds;
    let stored: unknown = null;
    try {
      stored = JSON.parse(readFileSync(file, "utf8"));
    } catch {
      // No file yet, or one this code didn't write. Nothing is marked.
    }
    if (typeof stored !== "object" || stored === null) return;
    for (const kind of MARK_KINDS) {
      const keys: unknown = (stored as Record<string, unknown>)[kind];
      if (Array.isArray(keys)) this.sets[kind] = new Set(keys.filter((key) => typeof key === "string"));
    }
  }

  /** Every key marked, and the key each item has now that was marked under an earlier one. */
  get(): Marks {
    const former = this.formerIds();
    const given = (kind: MarkKind) => {
      const now = keysNow(kind, former);
      return [...new Set([...this.sets[kind], ...[...this.sets[kind]].flatMap((key) => now.get(key) ?? [])])];
    };
    return { viewed: given("viewed"), dismissed: given("dismissed") };
  }

  /**
   * Marks the keys, or unmarks them, and says whether anything changed. A key is marked as sent. Unmarking an item
   * unmarks it under every id it has had. The file is replaced whole, so a crash
   * leaves the old one, and the marks in memory change only once the file holds them: a write that fails throws
   * and leaves both as they were.
   */
  change(kind: MarkKind, keys: readonly string[], on: boolean): boolean {
    const set = new Set(this.sets[kind]);
    if (on) {
      for (const key of keys) set.add(key);
    } else {
      const now = keysNow(kind, this.formerIds());
      const item = (key: string) => now.get(key) ?? key;
      const off = new Set(keys.map(item));
      for (const key of set) if (off.has(item(key))) set.delete(key);
    }
    if (set.size === this.sets[kind].size) return false;
    const next = `${this.file}.next`;
    writeFileSync(next, `${JSON.stringify({ viewed: [...this.sets.viewed], dismissed: [...this.sets.dismissed], [kind]: [...set] })}\n`);
    renameSync(next, this.file);
    this.sets[kind] = set;
    return true;
  }
}

/** Each earlier key of an item, as its key now. */
function keysNow(kind: MarkKind, former: FormerIds): Map<string, string> {
  return new Map([...former].flatMap(([work, ids]) => [...ids].map(([from, id]) => [ITEM_KEY[kind](work, from), ITEM_KEY[kind](work, id)] as const)));
}
