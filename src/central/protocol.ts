import { flag, listOf, matching, oneOf, orNull, readOrNull, shape, tableOf, text, unread } from "../core/reader.ts";
import type { Instant, MarkKind, Marks, Media, Todo, WorkId } from "../core/types.ts";
import type { StoreState } from "../stores/store.ts";

/**
 * What a machine sends the central hub, and what it answers. A send is a hello, which says the machine is alive,
 * or the machine's whole state. The hub is the one that knows what it holds: a state names every page by a hash
 * of its content and every file by its digest, the hub answers with the ones it lacks, the machine sends those,
 * and only then does the hub show the new state. The machine keeps no record of what the hub has.
 *
 * Who is sending is never in the request: the hub reads the machine's id from its credential.
 */

/** Goes up when a request or an answer changes shape. A hub refuses a number it does not know, and says so. */
export const FORMAT = 2;

/** Where a machine sends, with its credential, and where it uploads a file the hub lacks: `UPLOAD_PATH<digest>`. */
export const SEND_PATH = "/api/machine";
export const UPLOAD_PATH = "/api/machine/files/";

/**
 * Where the deployer lists the machines the hub holds (GET), and removes one (`DELETE MACHINES_PATH/<machine id>`),
 * with an order signed by the machine key (`login.ts`). A browser's session opens neither.
 */
export const MACHINES_PATH = "/api/machines";

/** One machine the hub holds, as the deployer's list names it. `label` and `works` are null for one never shown. */
export interface HeldMachine {
  readonly id: string;
  readonly label: string | null;
  /** When it last sent anything the hub took, in ms, or 0. */
  readonly heard: number;
  readonly works: number | null;
}

/** What removing a machine did, beside forgetting it and refusing its credential: how many of its files went from the bucket. */
export interface Forgotten {
  readonly files: number;
  /** False when the bucket had more of its files than one request may delete. Removing it again deletes the rest. */
  readonly done: boolean;
}

/** A machine's id: made with its credential, short and safe in an address. It leads every key the hub keeps for it. */
export const MACHINE_ID = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;

/** The machine id a credential, `pm_<machine id>.<signature>`, names, as it says it. The hub checks the signature. */
export function credentialMachine(credential: string): string | null {
  const machine = /^pm_([^.]+)\.[A-Za-z0-9_-]{43}$/.exec(credential)?.[1];
  return machine !== undefined && MACHINE_ID.test(machine) ? machine : null;
}

/** A file's content digest, and a page's hash: SHA-256, in hex. */
export const DIGEST = /^[0-9a-f]{64}$/;

// ---------------------------------------------------------------- Limits

/*
 * What one machine may make the hub do. Each is checked before the work it bounds. A real machine's state is about
 * 0.8 MB, its pages about 3 MB, and its sends about 0.6 MB gzipped, so each limit leaves room several times over.
 */

/** Machines the hub keeps. Every one is loaded on each start of the hub's one Durable Object. */
export const MOST_MACHINES = 16;
/** A send as it arrives, gzipped. Checked from its length before a byte is unpacked. */
export const MOST_SEND_ZIPPED = 4 * 1024 * 1024;
/** A send unpacked. It is parsed whole in an isolate that has 128 MB, so it stays well below. */
export const MOST_SEND_BYTES = 16 * 1024 * 1024;
/** A machine's state, or one page, as the hub stores it: one row, and a Durable Object's row holds at most 8 MB. */
export const MOST_ROW_BYTES = 6 * 1024 * 1024;
/** Works, and so pages, one send names. */
export const MOST_PAGES = 1000;
/** Files one send names. */
export const MOST_FILES = 2000;
/** One file: a request to a Worker carries at most 100 MB (decimal) on Cloudflare's free and pro plans. */
export const MOST_FILE_BYTES = 95 * 1024 * 1024;
/**
 * All a machine may put in the bucket. Its files are deleted only when the machine is removed, so every file put counts, once it is there.
 * Uploads made at once may pass it by what one send names; then nothing more is let in.
 */
export const MOST_MACHINE_BYTES = 2 * 1024 * 1024 * 1024;

/*
 * What a signed-in browser may ask of the hub: a mark changed on a machine's works. The hub keeps it as an order
 * for that machine until the machine has taken it, so each limit bounds what is kept as well as what is read.
 */

/** A request to change marks, as it arrives. Read no further than this. */
export const MOST_MARKS_BYTES = 256 * 1024;
/** Keys one request to change marks names. */
export const MOST_MARK_KEYS = 1000;
/** One mark's key: a work's id and an item's id, which is the item's section and its words, or an address. */
export const MOST_MARK_KEY_CHARS = 2048;
/**
 * The orders the hub keeps for one machine that has not taken them yet, one for each kind and key. A machine takes
 * them at its next send, so only one away for long gathers many. Past this a new key is refused.
 */
export const MOST_ORDERS = 1000;

/** A stream as text when it is at most `most` bytes, read no further than that. Null for a larger one. */
export async function readCapped(stream: ReadableStream<Uint8Array>, most: number): Promise<string | null> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const parts: string[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > most) {
      void reader.cancel();
      return null;
    }
    parts.push(decoder.decode(value, { stream: true }));
  }
  parts.push(decoder.decode());
  return parts.join("");
}

// ---------------------------------------------------------------- The request

/** A file a machine's pages show: its path after `/files/` (the work, then the path in it, not encoded), its bytes' digest and size. */
export interface FileRef {
  readonly path: string;
  readonly digest: string;
  readonly size: number;
  readonly type: string;
}

/** A machine's whole state, as its own hub holds it: work ids are the machine's own. */
export interface Snapshot {
  readonly store: StoreState;
  readonly media: readonly Media[];
  readonly marks: Marks;
  readonly todos: readonly Todo[];
}

export interface Hello {
  readonly format: typeof FORMAT;
  readonly kind: "hello";
  /**
   * The highest number of an order (`MarkOrder`) the machine has applied to its marks file since it started. An
   * earlier build leaves it out, and the hub reads that as 0. A state carries it too.
   */
  readonly applied?: number;
}

export interface StateSend {
  readonly format: typeof FORMAT;
  readonly kind: "state";
  /** As a hello's: the marks in this state hold every order up to this number. */
  readonly applied?: number;
  /** The machine's name, as the hub labels its works. */
  readonly label: string;
  /** When the machine read this state, by its clock. The hub only moves a machine's state forward. */
  readonly at: number;
  readonly state: Snapshot;
  /** Every work's page, by the hash of the JSON that `bodies` would carry. */
  readonly pages: Readonly<Record<string, string>>;
  /** The pages the hub said it lacks, as that JSON. */
  readonly bodies?: Readonly<Record<string, string>>;
  /** Every file the machine's pages show. */
  readonly files: readonly FileRef[];
}

export type Send = Hello | StateSend;

/**
 * A mark changed on the central hub, for the machine whose works it is about: the key as that machine keeps it, and
 * whether to mark or unmark it. The number only goes up, so a machine says which it has applied with the highest.
 */
export interface MarkOrder {
  readonly n: number;
  readonly kind: MarkKind;
  readonly key: string;
  readonly on: boolean;
}

/**
 * The hub's answer. `missing` names the pages and files it lacks: nothing was shown, and the machine sends the
 * pages and uploads the files, then sends again. `marks` are the orders the machine has not said it applied.
 * An earlier build of a machine ignores them, so they stay waiting. `error` says why a request was refused.
 */
export interface Answer {
  readonly format: typeof FORMAT;
  readonly missing?: { readonly pages: readonly string[]; readonly files: readonly string[] };
  readonly marks?: readonly MarkOrder[];
  readonly error?: string;
}

/** A request to change marks, as the hub's page sends it, to the central hub or to a machine's own. */
export interface MarkChange {
  readonly kind: MarkKind;
  readonly keys: readonly string[];
  readonly on: boolean;
}

const MARK_KIND = oneOf("viewed", "dismissed");

/** A change to marks from a browser, or why it can't be taken: its shape, and its limits. Which machine each key names is the hub's to check. */
export function readMarkChange(value: unknown): MarkChange | string {
  const change = readOrNull(shape<MarkChange>({ kind: MARK_KIND, keys: listOf(text), on: flag }), value);
  if (change === null) return "A change to marks is a kind, a list of keys and on or off.";
  if (change.keys.length > MOST_MARK_KEYS) return `A change names at most ${MOST_MARK_KEYS} keys.`;
  if (!change.keys.every((key) => key.length > 0 && key.length <= MOST_MARK_KEY_CHARS)) return `A key is 1 to ${MOST_MARK_KEY_CHARS} characters.`;
  return change;
}

/** The orders in a hub's answer, as a machine reads them. */
export const readOrders = listOf(shape<MarkOrder>({ n: (value) => (Number.isSafeInteger(value) && (value as number) > 0 ? (value as number) : unread()), kind: MARK_KIND, key: text, on: flag }));

/** The `applied` a send says, or null when it is not a count. */
function readApplied(value: unknown): number | null {
  if (value === undefined) return 0;
  return Number.isSafeInteger(value) && (value as number) >= 0 ? (value as number) : null;
}

/**
 * A send as the hub reads it, or why it can't be read: its shape, and every limit a count or a size can be checked
 * against before anything is done with it. What the state and the pages hold is read when they are adopted.
 */
export function readSend(value: unknown): Send | string {
  if (typeof value !== "object" || value === null) return "The request is not an object.";
  const v = value as Record<string, unknown>;
  if (v.format !== FORMAT) return `The request is format ${String(v.format)}, and this hub reads format ${FORMAT}. Update progress on the machine or redeploy the hub.`;
  const applied = readApplied(v.applied);
  if (applied === null) return "The orders applied are not a count.";
  if (v.kind === "hello") return { format: FORMAT, kind: "hello", applied };
  if (v.kind !== "state") return "A request is a hello or a state.";
  if (typeof v.label !== "string" || v.label.length === 0 || v.label.length > 80) return "The machine's label is missing or too long.";
  if (typeof v.at !== "number" || !Number.isSafeInteger(v.at) || v.at <= 0) return "The state's time is not one this hub can read.";
  if (typeof v.state !== "object" || v.state === null) return "The state is not one this hub can read.";
  const pages = readOrNull(tableOf(matching(DIGEST)), v.pages);
  if (pages === null) return "The pages are not named by their hashes.";
  if (Object.keys(pages).length > MOST_PAGES) return `A send names at most ${MOST_PAGES} pages.`;
  const bodies = v.bodies === undefined ? {} : readOrNull(tableOf(text), v.bodies);
  if (bodies === null || !Object.keys(bodies).every((work) => Object.hasOwn(pages, work))) return "A page sent is not one the send names.";
  if (!Array.isArray(v.files)) return "The list of files is missing.";
  if (v.files.length > MOST_FILES) return `A send names at most ${MOST_FILES} files.`;
  const files = readOrNull(listOf(fileRef), v.files);
  if (files === null) return "The list of files is not one this hub can read.";
  if (new Set(files.map((file) => file.path)).size !== files.length) return "The list of files names a path twice.";
  const sizes = new Map(files.map((file) => [file.digest, file.size]));
  if ([...sizes.values()].reduce((sum, size) => sum + size, 0) > MOST_MACHINE_BYTES) return "The files are more than this hub keeps for one machine.";
  return { format: FORMAT, kind: "state", applied, label: v.label, at: v.at, state: v.state as Snapshot, pages, bodies, files };
}

/** A path as the machine's own hub serves it: a work's folder, then a path in it, with no part empty or hidden. */
const FILE_PATH = /^(?:[^/.][^/]*)(?:\/[^/.][^/]*)+$/;
/** A type a browser is told: `type/subtype`, perhaps with a charset. */
const FILE_TYPE = /^[a-z]+\/[a-z0-9.+-]+(?:;\s*charset=[a-z0-9_-]+)?$/i;

const fileRef = shape<FileRef>({
  path: (value) => (typeof value === "string" && value.length <= 1024 ? matching(FILE_PATH)(value) : unread()),
  digest: matching(DIGEST),
  size: (value) => (Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= MOST_FILE_BYTES ? (value as number) : unread()),
  type: matching(FILE_TYPE),
});

export const readMarks = shape<Marks>({ viewed: listOf(text), dismissed: listOf(text) });

export const readTodo = shape<Todo>({ id: text, text, description: text, work: orNull(text<WorkId>), project: orNull(text), addedAt: text<Instant>, doneAt: orNull(text<Instant>) });
