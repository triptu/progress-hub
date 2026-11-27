import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { gzip } from "node:zlib";
import type { Health, Instant, Marks, Todo, WorkDetail } from "../core/types.ts";
import type { DiskStore } from "../stores/disk/index.ts";
import { linkedFiles } from "./received.ts";
import { readOrNull } from "../core/reader.ts";
import { credentialMachine, FORMAT, MOST_FILE_BYTES, MOST_FILES, readOrders, readTakenTodos, SEND_PATH, UPLOAD_PATH, type Answer, type FileRef, type MarkOrder, type Send, type Snapshot, type StateSend } from "./protocol.ts";

/** Where this machine sends, the credential it was linked with, and the machine id that credential was made for. */
export interface Link {
  readonly url: string;
  readonly credential: string;
  readonly machine: string;
}

/** `$PROGRESS_CENTRAL`, else `~/.config/progress/central`, beside the file that records the progress home. */
export function linkFile(env: Record<string, string | undefined> = process.env): string {
  return env.PROGRESS_CENTRAL?.trim() || join(env.XDG_CONFIG_HOME?.trim() || join(env.HOME?.trim() || homedir(), ".config"), "progress", "central");
}

/** The link in `path`, or null when this machine is not linked to a central hub. Throws, saying why, when the file is there and can't be used. */
export function readLink(path: string): Link | null {
  if (!existsSync(path)) return null;
  let link: Partial<Link>;
  try {
    link = JSON.parse(readFileSync(path, "utf8")) as Partial<Link>;
  } catch (error) {
    throw new Error(`${path} can't be read (${error instanceof Error ? error.message : String(error)}). Run progress link again.`);
  }
  if (typeof link?.url !== "string" || !URL.canParse(link.url) || typeof link.credential !== "string" || credentialMachine(link.credential) === null) {
    throw new Error(`${path} is not a link to a central hub. Run progress link again.`);
  }
  return { url: link.url.replace(/\/+$/, ""), credential: link.credential, machine: credentialMachine(link.credential)! };
}

/** Writes the link in one step, readable by this user only from the moment it exists. The machine is read from the credential. */
export function writeLink(path: string, link: Link): void {
  mkdirSync(dirname(path), { recursive: true });
  const next = `${path}.${process.pid}.new`;
  writeFileSync(next, `${JSON.stringify({ url: link.url, credential: link.credential }, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  renameSync(next, path);
}

/** This machine's name, as the central hub labels its works. */
export const machineLabel = () => hostname().split(".")[0] || "machine";

/** One request to the central hub, gzipped off the thread that serves the local hub. Throws, saying why, unless it was taken. */
export async function post(link: Link, body: Send, send: typeof fetch = fetch): Promise<Answer> {
  const response = await send(link.url + SEND_PATH, {
    method: "POST",
    headers: { Authorization: `Bearer ${link.credential}`, "Content-Type": "application/gzip" },
    body: await promisify(gzip)(JSON.stringify(body)),
    signal: AbortSignal.timeout(60_000),
  }).catch(() => {
    // Refused, timed out, or no network: said in words a person reads, not in the runtime's.
    throw new Error("It did not answer.");
  });
  if (response.status === 401) throw new Error("It refused this machine's credential.");
  const answer = (await response.json().catch(() => null)) as Answer | null;
  if (!response.ok || answer === null) throw new Error(answer?.error ?? `It answered ${response.status}.`);
  return answer;
}

const SOON_MS = 10_000;
const HELLO_MS = 60_000;
const RETRY_MS = 30_000;

/**
 * Sends this machine's state to the central hub, from inside the hub's server. On a change, at most every
 * 10 seconds. After 60 quiet seconds, a hello. After a failure, again 30 seconds later. Nothing is queued:
 * the next send that succeeds carries the state as it is then. What the hub holds is the hub's to say: each
 * state names every page and file, and the hub answers with what it lacks. A state is timed by this machine's
 * clock: if the clock steps back, the hub refuses sends with 409 until it catches up, and this tries again every
 * 30 seconds. After the hub's storage is emptied, a machine shows again at its next change or restart.
 *
 * An answer may carry marks changed on the central hub, as orders for this machine. Each is applied with `apply`,
 * which writes the marks file as a click on this machine's own hub does, and each send says the highest order
 * applied since the hub started. One that restarts says 0 and is handed the same orders again, which change nothing.
 *
 * The answer to a state may also name the todos the central hub has taken into the user's list. They are let go of
 * with `release`, which removes them from the todos file in one write, so the file holds
 * only the todos the central hub has not taken yet.
 */
export class Sender {
  private readonly link: Link;
  private readonly own: DiskStore;
  private readonly extras: () => { marks: Marks; todos: readonly Todo[] };
  private readonly apply: (order: MarkOrder) => void;
  private readonly release: (todos: readonly string[]) => void;
  private readonly changes: () => string;
  private readonly fetch: typeof fetch;
  private readonly log: (line: string) => void;
  /** What `changes` said at the last send that went through. */
  private sentChanges: string | null = null;
  /** The highest number of an order from the central hub that the marks file holds. */
  private applied = 0;
  private lastAt = 0;
  private retryAt = 0;
  private busy = false;
  private said = "";
  /** Whether the last send went through, and since when none has. */
  private reached: Health = { ok: true };
  private readonly digests = new Map<string, { size: number; mtime: number; digest: string }>();
  /** Files left out, each named in the log once. One is looked at again on each send, but never read. */
  private readonly left = new Set<string>();

  constructor(options: { link: Link; own: DiskStore; extras: () => { marks: Marks; todos: readonly Todo[] }; apply?: (order: MarkOrder) => void; release?: (todos: readonly string[]) => void; changes: () => string; fetch?: typeof fetch; log?: (line: string) => void }) {
    this.link = options.link;
    this.own = options.own;
    this.extras = options.extras;
    this.apply = options.apply ?? (() => undefined);
    this.release = options.release ?? (() => undefined);
    this.changes = options.changes;
    this.fetch = options.fetch ?? fetch;
    this.log = options.log ?? ((line) => console.log(line));
  }

  /** Called on each of the hub's looks. Starts a send when one is due, and never waits for it. */
  tick(now = Date.now()): void {
    if (this.busy || now < this.retryAt) return;
    const changed = this.changes() !== this.sentChanges;
    if ((changed && now - this.lastAt >= SOON_MS) || now - this.lastAt >= HELLO_MS) void this.run();
  }

  /** One send, whatever is due. Resolves to whether it went through. */
  async run(): Promise<boolean> {
    if (this.busy) return false;
    this.busy = true;
    const changes = this.changes();
    try {
      const { orders, todos } = await this.send(changes === this.sentChanges);
      this.sentChanges = changes;
      if (todos.length > 0) this.release(todos);
      // Said applied only once the file holds it: a write that fails throws, and the rest wait for the next send.
      for (const order of [...orders].sort((a, b) => a.n - b.n)) {
        this.apply(order);
        this.applied = Math.max(this.applied, order.n);
      }
      // The next send is a state, even when applying them changed nothing: only a state lets the hub drop them.
      if (orders.length > 0) this.sentChanges = null;
      this.retryAt = 0;
      this.say(`progress: sending to ${this.link.url} as ${this.link.machine}`);
      this.reached = { ok: true };
      return true;
    } catch (error) {
      this.retryAt = Date.now() + RETRY_MS;
      const reason = error instanceof Error ? error.message : String(error);
      this.say(`progress: the central hub at ${this.link.url} did not take this machine's state: ${reason}`);
      this.reached = { ok: false, since: this.reached.ok ? (new Date().toISOString() as Instant) : this.reached.since, reason };
      return false;
    } finally {
      this.lastAt = Date.now();
      this.busy = false;
    }
  }

  /** Where this machine sends, and whether its last send went through. */
  status(): { readonly url: string; readonly health: Health } {
    return { url: this.link.url, health: this.reached };
  }

  /** Logs a line when it differs from the last, so a hub that stays down is said once. */
  private say(line: string): void {
    if (line !== this.said) this.log(line);
    this.said = line;
  }

  /** One send, and the orders and the todos taken that its answer carries. */
  private async send(quiet: boolean): Promise<{ orders: readonly MarkOrder[]; todos: readonly string[] }> {
    const orders = (answer: Answer) => ({ orders: readOrNull(readOrders, answer.marks ?? []) ?? [], todos: readOrNull(readTakenTodos, answer.todos ?? []) ?? [] });
    if (quiet) return orders(await post(this.link, { format: FORMAT, kind: "hello", applied: this.applied }, this.fetch));
    const store = this.own.state();
    // Read with the marks, so the marks this state carries hold every order up to it.
    const applied = this.applied;
    const state: Snapshot = { store, media: await this.own.media(), ...this.extras() };
    const pages: Record<string, string> = {};
    const json = new Map<string, string>();
    const details: WorkDetail[] = [];
    for (const work of store.works) {
      const detail = await this.own.detail(work.id);
      if (!detail) throw new Error(`The page of ${work.id} went away while it was read.`);
      const text = JSON.stringify(detail);
      json.set(work.id, text);
      pages[work.id] = new Bun.CryptoHasher("sha256").update(text).digest("hex");
      details.push(detail);
    }
    const files = await this.files(new Set(store.works.map((work) => work.id as string)), await linkedFiles({ state, details }));
    const body: StateSend = { format: FORMAT, kind: "state", applied, label: machineLabel(), at: Date.now(), state, pages, files: files.map((file) => file.ref) };
    const answer = await post(this.link, body, this.fetch);
    if (!answer.missing) return orders(answer);
    for (const digest of answer.missing.files) {
      const file = files.find((entry) => entry.ref.digest === digest);
      if (!file) throw new Error("The hub asked for a file this machine did not name.");
      const upload = await this.fetch(`${this.link.url}${UPLOAD_PATH}${digest}`, {
        method: "PUT",
        headers: { Authorization: `Bearer ${this.link.credential}` },
        body: Bun.file(file.real),
        signal: AbortSignal.timeout(300_000),
      });
      if (!upload.ok) throw new Error(`An upload was refused (${upload.status}): ${(await upload.text()).slice(0, 200)}`);
    }
    const bodies: Record<string, string> = {};
    for (const work of answer.missing.pages) bodies[work] = json.get(work) ?? "";
    const again = await post(this.link, { ...body, bodies }, this.fetch);
    if (again.missing) throw new Error("The hub still lacks pages or files after they were sent.");
    return orders(again);
  }

  /**
   * The files this machine's state and pages show, in one of its works and inside that work's own folder. A file's
   * digest is worked out again only when it changed. A file that can't be sent is left out, and said once.
   */
  private async files(works: ReadonlySet<string>, linked: ReadonlySet<string>): Promise<{ ref: FileRef; real: string }[]> {
    const found = new Map<string, { ref: FileRef; real: string }>();
    const leave = (path: string, why: string) => {
      if (this.left.has(path)) return;
      this.left.add(path);
      this.log(`progress: ${path} is not sent to the central hub: ${why}`);
    };
    for (const raw of linked) {
      let path: string;
      try {
        path = raw.split("/").map(decodeURIComponent).join("/");
      } catch {
        continue;
      }
      if (found.has(path) || !works.has(path.slice(0, path.indexOf("/")))) continue;
      if (found.size >= MOST_FILES) {
        leave(path, `the hub takes at most ${MOST_FILES} files from one machine.`);
        continue;
      }
      const real = this.own.fileOnDisk(raw, "work");
      if (real === null || real === "outside") {
        leave(path, real === null ? "it is not there." : "it is outside its work's folder.");
        continue;
      }
      const stat = statSync(real, { throwIfNoEntry: false });
      // A folder a page links is listed, and its files are named on their own.
      if (stat?.isDirectory()) continue;
      if (!stat?.isFile()) {
        leave(path, "it is not a file.");
        continue;
      }
      if (stat.size > MOST_FILE_BYTES) {
        leave(path, `it is larger than the ${MOST_FILE_BYTES / 1024 / 1024} MiB the hub takes.`);
        continue;
      }
      let known = this.digests.get(real);
      if (known?.size !== stat.size || known.mtime !== stat.mtimeMs) {
        const hasher = new Bun.CryptoHasher("sha256");
        for await (const chunk of Bun.file(real).stream()) hasher.update(chunk);
        known = { size: stat.size, mtime: stat.mtimeMs, digest: hasher.digest("hex") };
        this.digests.set(real, known);
      }
      found.set(path, { ref: { path, digest: known.digest, size: known.size, type: Bun.file(real).type }, real });
    }
    return [...found.values()];
  }
}

/**
 * Links this machine to a central hub with a credential made for it on the machine that deployed the hub: checks
 * the address and the credential with a hello, and writes the link. The machine's id is the one in the credential.
 */
export async function linkTo(address: string, credential: string, path: string, send: typeof fetch = fetch): Promise<Link> {
  if (!URL.canParse(address)) throw new Error(`${address} is not an address.`);
  const url = new URL(address);
  if (url.protocol !== "https:" && !/^(localhost|127\.0\.0\.1)$/.test(url.hostname)) throw new Error("A central hub is reached over https.");
  const machine = credentialMachine(credential);
  if (machine === null) throw new Error("That is not a machine's credential. Make one with bun run credential in progress/cloud, on the machine that deployed the hub.");
  const link: Link = { url: url.origin, credential, machine };
  await post(link, { format: FORMAT, kind: "hello" }, send).catch((error: unknown) => {
    throw new Error(`${link.url} did not take this machine: ${error instanceof Error ? error.message : String(error)}`);
  });
  writeLink(path, link);
  return link;
}
