import type { WorkId } from "./types.ts";

/** Parts a work's id from the store it came from, in `<store>~<work>`. Not a character a folder name is given. */
export const FROM = "~";

/**
 * The name each work has in an address, both ways. A hub that shows several machines' works knows each by its
 * machine and its name there (`<machine>~<name>`). An address carries the name alone, so it reads as the work
 * and stays the same whatever the machine is called. Where two machines have a work of one name, the second
 * has `~2` after it, and so on, in the order of the machines' ids.
 */
export interface WorkNames {
  readonly idOf: ReadonlyMap<string, WorkId>;
  readonly nameOf: ReadonlyMap<WorkId, string>;
}

export function workNames(ids: readonly WorkId[]): WorkNames {
  const sharing = new Map<string, WorkId[]>();
  for (const id of ids) {
    const name = id.slice(id.indexOf(FROM) + 1);
    sharing.set(name, [...(sharing.get(name) ?? []), id]);
  }
  const idOf = new Map<string, WorkId>();
  const nameOf = new Map<WorkId, string>();
  for (const [name, holders] of sharing) {
    holders.sort().forEach((id, n) => {
      const shown = n === 0 ? name : `${name}${FROM}${n + 1}`;
      idOf.set(shown, id);
      nameOf.set(id, shown);
    });
  }
  return { idOf, nameOf };
}
