import type { MarkKind, Marks } from "./types.ts";

/**
 * The key the hub keeps a mark under for an item of a work's page. Viewed marks a Shipped line: the line itself,
 * so two lines about one pull request are two things to look at.
 */
export function viewKey(work: string, itemId: string): string {
  return `${work}/${itemId}`;
}

/** The key the hub keeps an ask under once the user marks it done. */
export function doneKey(work: string, itemId: string): string {
  return `${work}:${itemId}`;
}

/**
 * The key the hub keeps a merged pull request's viewed mark under, when no line is about it: its address, after the
 * machine of the work it shows on, as that work's id names it (`<machine>~`), so one machine's mark is about its own.
 */
export function prKey(work: string, url: string): string {
  return `${work.slice(0, work.indexOf("~") + 1)}${url}`;
}

/** What viewKey and doneKey put between the work and the item. */
const SEPARATOR: Record<MarkKind, string> = { viewed: "/", dismissed: ":" };

/**
 * A machine's marks as a hub that holds several machines keeps them. Every key gets `<machine>~` in front, the way
 * that machine's work ids and stalled threads do, so a mark counts only for the machine that sent it: one machine's
 * marks never hide another's. A mark on any other work is not that machine's to send, so it is left out. A new kind of key is added in `ownsMark` and in `ownMark`.
 */
export function adoptMarks(machine: string, marks: Marks, works: ReadonlySet<string>): Marks {
  const adopt = (kind: MarkKind) => (key: string) => {
    if (!ownsMark(kind, key, works)) return [];
    return [key.startsWith("stall:") ? `stall:${machine}~${key.slice("stall:".length)}` : `${machine}~${key}`];
  };
  return { viewed: marks.viewed.flatMap(adopt("viewed")), dismissed: marks.dismissed.flatMap(adopt("dismissed")) };
}

/**
 * Whether a mark's key, as a machine keeps it, is that machine's to hold: a pull request's address, a stalled
 * thread, or an item of one of its own works. A hub that hands a machine a mark asks this first, and the machine
 * asks it again before the mark reaches its file.
 */
export function ownsMark(kind: MarkKind, key: string, works: ReadonlySet<string>): boolean {
  if (/^https?:\/\//.test(key)) return true;
  // A thread another machine's hub named carries that machine's id, and is that machine's to mark.
  if (key.startsWith("stall:")) return !key.includes("~");
  const at = key.indexOf(SEPARATOR[kind]);
  return at > 0 && works.has(key.slice(0, at));
}

/**
 * The other way: the machine a key `adoptMarks` made is about, and the key as that machine keeps it. Null for a
 * key of any other shape. A machine's id holds no `~`, so the first one ends it.
 */
export function ownMark(kind: MarkKind, key: string): { machine: string; key: string } | null {
  const stall = key.startsWith("stall:");
  const adopted = stall ? key.slice("stall:".length) : key;
  const at = adopted.indexOf("~");
  const machine = adopted.slice(0, at);
  const own = adopted.slice(at + 1);
  if (at <= 0 || own === "") return null;
  if (stall) return { machine, key: `stall:${own}` };
  if (/^https?:\/\//.test(own)) return { machine, key: own };
  // A stalled thread's key always has the machine after `stall:`, never before it.
  return !own.startsWith("stall:") && own.indexOf(SEPARATOR[kind]) > 0 ? { machine, key: own } : null;
}
