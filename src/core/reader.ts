/**
 * Reading a value another program sent into one of this program's types. A reader checks a value and builds it
 * again from what it checked, so a field no reader names never reaches the code that reads the result. It throws
 * `Unread` for a value it can't read. `shape<T>` takes a reader for each field `T` has, so the compiler refuses a
 * reader that misses a field of its type, or names one the type no longer has.
 */
export type Reader<T> = (value: unknown) => T;

export class Unread extends Error {}

export const unread = (): never => {
  throw new Unread("Not a value this program can read.");
};

type Value = Record<string, unknown>;
const isValue = (value: unknown): value is Value => typeof value === "object" && value !== null && !Array.isArray(value);

/** What `read` reads from `value`, or null when it can't. */
export function readOrNull<T>(read: Reader<T>, value: unknown): T | null {
  try {
    return read(value);
  } catch (error) {
    if (error instanceof Unread) return null;
    throw error;
  }
}

export const text = <S extends string = string>(value: unknown): S => (typeof value === "string" ? (value as S) : unread());
export const count: Reader<number> = (value) => (typeof value === "number" && Number.isFinite(value) ? value : unread());
export const flag: Reader<boolean> = (value) => (typeof value === "boolean" ? value : unread());
/** A string `pattern` matches. */
export const matching =
  (pattern: RegExp): Reader<string> =>
  (value) =>
    typeof value === "string" && pattern.test(value) ? value : unread();
export const oneOf =
  <const V extends readonly unknown[]>(...values: V): Reader<V[number]> =>
  (value) =>
    values.includes(value) ? (value as V[number]) : unread();
export const orNull =
  <T>(read: Reader<T>): Reader<T | null> =>
  (value) =>
    value === null ? null : read(value);
/** A field the type may leave out. */
export const orNone =
  <T>(read: Reader<T>): Reader<T | undefined> =>
  (value) =>
    value === undefined ? undefined : read(value);
/** A field the type has, that an earlier build leaves out: read as what that build meant. */
export const orElse =
  <T>(read: Reader<T>, fallback: T): Reader<T> =>
  (value) =>
    value === undefined ? fallback : read(value);
export const listOf =
  <T>(read: Reader<T>): Reader<T[]> =>
  (value) =>
    Array.isArray(value) ? value.map((item) => read(item)) : unread();
/** An object whose every value `read` reads, by any names. */
export const tableOf =
  <T>(read: Reader<T>): Reader<Record<string, T>> =>
  (value) =>
    isValue(value) ? Object.fromEntries(Object.entries(value).map(([name, item]) => [name, read(item)])) : unread();

/** A reader for each field of `T`, the ones it may leave out too. */
export type Fields<T> = { readonly [K in keyof Required<T>]: Reader<T[K]> };

export const shape =
  <T>(fields: Fields<T>): Reader<T> =>
  (value) => {
    if (!isValue(value)) return unread();
    const read: Value = {};
    for (const [name, field] of Object.entries<Reader<unknown>>(fields)) {
      const one = field(value[name]);
      if (one !== undefined) read[name] = one;
    }
    return read as T;
  };

/** The first of several readers that reads the value. */
export const either =
  <T>(...readers: readonly Reader<T>[]): Reader<T> =>
  (value) => {
    for (const read of readers) {
      try {
        return read(value);
      } catch (error) {
        if (!(error instanceof Unread)) throw error;
      }
    }
    return unread();
  };

/**
 * One of several shapes, by the value of `key`. It is read exactly: a field its kind does not have is refused, not
 * dropped, since code that asks whether a field is there would take the value for a kind that has it.
 */
export const variant =
  <T extends Record<K, string>, K extends keyof T & string>(key: K, kinds: { readonly [V in T[K]]: Fields<Omit<Extract<T, Record<K, V>>, K>> }): Reader<T> =>
  (value) => {
    if (!isValue(value) || typeof value[key] !== "string" || !Object.hasOwn(kinds, value[key])) return unread();
    const read: Value = { [key]: value[key], ...shape(kinds[value[key] as T[K]] as Fields<Value>)(value) };
    return Object.keys(value).every((name) => Object.hasOwn(read, name) || value[name] === undefined) ? (read as T) : unread();
  };

/** A line of a JSON Lines file left out, by its number from 1, and why. */
export interface Skipped {
  readonly line: number;
  readonly why: string;
}

/**
 * The values a JSON Lines file holds, each with its line's number, and the lines that could not be read. A line a
 * crash cut short is one of those. `noun` names what a line should be, for why one is left out.
 */
export function readJsonl<T>(file: string, read: Reader<T>, noun: string): { readonly values: T[]; readonly lines: number[]; readonly skipped: Skipped[] } {
  const values: T[] = [];
  const lines: number[] = [];
  const skipped: Skipped[] = [];
  file.split("\n").forEach((line, i) => {
    if (line.trim() === "") return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return void skipped.push({ line: i + 1, why: "it is not JSON" });
    }
    const value = readOrNull(read, parsed);
    if (value === null) return void skipped.push({ line: i + 1, why: `it is not ${noun} the hub reads` });
    values.push(value);
    lines.push(i + 1);
  });
  return { values, lines, skipped };
}
