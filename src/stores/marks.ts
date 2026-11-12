import { readFileSync, renameSync, writeFileSync } from "node:fs";
import type { MarkKind, Marks } from "../core/types.ts";

export const MARK_KINDS: readonly MarkKind[] = ["viewed", "dismissed"];

/**
 * What the user marked in the hub, kept in one file in the progress home so every browser shows the same.
 * It is the hub's own file: no page is edited, and an agent never reads it.
 */
export class MarkStore {
  private readonly sets: Record<MarkKind, ReadonlySet<string>> = { viewed: new Set(), dismissed: new Set() };

  private readonly file: string;

  constructor(file: string) {
    this.file = file;
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

  get(): Marks {
    return { viewed: [...this.sets.viewed], dismissed: [...this.sets.dismissed] };
  }

  /**
   * Marks the keys, or unmarks them, and says whether anything changed. The file is replaced whole, so a crash
   * leaves the old one, and the marks in memory change only once the file holds them: a write that fails throws
   * and leaves both as they were.
   */
  change(kind: MarkKind, keys: readonly string[], on: boolean): boolean {
    const set = new Set(this.sets[kind]);
    for (const key of keys) {
      if (on) set.add(key);
      else set.delete(key);
    }
    if (set.size === this.sets[kind].size) return false;
    const next = `${this.file}.next`;
    writeFileSync(next, `${JSON.stringify({ ...this.get(), [kind]: [...set] })}\n`);
    renameSync(next, this.file);
    this.sets[kind] = set;
    return true;
  }
}
