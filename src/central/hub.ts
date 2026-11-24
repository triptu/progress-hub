import type { Health, HubState, Marks, Media, Todo, WorkDetail, WorkId } from "../core/types.ts";
import { read } from "../server/routes.ts";
import { readDetail, readMedia, readState, type Peer } from "../stores/remote.ts";
import { FROM, Stores, type OtherStore, type StoreState, type WorkStore } from "../stores/store.ts";
import { adoptMarks, ownMark, ownsMark } from "../core/marks.ts";
import { sha256Hex } from "./login.ts";
import { listOf, readOrNull } from "../core/reader.ts";
import { FORMAT, MOST_MACHINE_BYTES, MOST_MACHINES, MOST_ORDERS, MOST_ROW_BYTES, MOST_SEND_BYTES, readCapped, readMarks, readSend, readTodo, type Answer, type Forgotten, type HeldMachine, type MarkChange, type MarkOrder, type StateSend } from "./protocol.ts";

/**
 * The central hub's one Durable Object: what every machine sent, kept in its SQLite storage, and the hub's
 * reads answered from it by the same `Stores` and routes a machine's own hub runs. Files are in a private bucket,
 * under the machine's id and the file's digest, and are served only through the paths the machine's state names.
 *
 * Who a machine is comes from the Worker, which read it from the machine's credential. The routes under `/_/`
 * are the Worker's alone: it sends a browser only `/api/`, `/files/` and a change to marks it has read to `/_/marks`,
 * and the deployer's orders to `/_/machines` and `/_/forget`.
 *
 * A machine's own marks file stays the one place its marks are kept. A mark changed here is an order for the
 * machine whose works it is about. The hub keeps the order, shows it over the marks that machine last sent, and
 * hands it over in its answer to the machine's next send. The machine applies it to its file as a click on its own
 * hub would, and says so in its sends. The order goes only once a state the hub shows says the machine applied it,
 * so the mark is always in one of the two. If the user changes the same mark the other way on the machine's own
 * hub before the machine has taken the order, the order still arrives and wins.
 *
 * Written against the parts of Cloudflare's API it uses, so the tests run it as it is.
 */
export interface Kv {
  get(key: string): unknown;
  put(key: string, value: string): void;
  delete(key: string): unknown;
  list(options: { prefix: string; limit?: number }): Iterable<[string, unknown]>;
}

export interface HubContext {
  readonly storage: { readonly kv: Kv; transactionSync<T>(run: () => T): T; setAlarm(at: number): unknown };
  getWebSockets(): readonly { send(message: string): void }[];
  acceptWebSocket(socket: unknown): void;
}

export interface Bucket {
  get(key: string): Promise<{ readonly body: ReadableStream } | null>;
  head(key: string): Promise<unknown>;
  list(options: { prefix: string; cursor?: string }): Promise<{ readonly objects: readonly { readonly key: string }[]; readonly truncated: boolean; readonly cursor?: string }>;
  delete(keys: string[]): Promise<unknown>;
}

/** The header the Worker names the sending machine in, from its credential. */
export const MACHINE_HEADER = "x-progress-machine";

/** What a machine whose credential is refused is told: the same for one this hub never made and one removed. */
export const NOT_LINKED = "A machine sends the credential it was linked with.";

/** A machine that has sent nothing for this long is shown the way a peer that stopped answering is. */
export const QUIET_MS = 150_000;
/** How far ahead of the hub's clock a machine's may run. A state from further ahead would hold back every later one. */
const AHEAD_MS = 10 * 60_000;
/**
 * Calls one send may make to the bucket. Cloudflare allows 1,000 calls to its own services, R2 among them, in one
 * request on the free plan (10,000 on paid); half is kept for everything else.
 */
const MOST_BUCKET_CALLS = 500;
/** Up to this many files the hub doesn't know are asked about one by one. For more, the machine's folder is listed, a thousand names a call. */
const ASK_EACH_UP_TO = 20;

/** A machine's files are kept under its own folder, never shared with another machine's, even for the same bytes. */
const folderOf = (machine: string) => `files/${machine}/`;
export const fileKey = (machine: string, digest: string) => `${folderOf(machine)}${digest}`;

/** A machine's state as this hub holds it: every id and address made this hub's own. */
interface Held {
  readonly store: Omit<StoreState, "health">;
  readonly media: readonly Media[];
  readonly marks: Marks;
  readonly todos: readonly Todo[];
}

interface Kept {
  readonly digest: string;
  readonly type: string;
}

/** What a machine's newest send that lacked something may upload: the files it named that the bucket lacks, by digest, with their sizes. */
interface Pending {
  readonly at: number;
  readonly files: Record<string, number>;
}

/** The orders kept for a machine: the last number given, and the last thing asked for each kind and key, the key as the hub shows it. */
interface Orders {
  readonly last: number;
  readonly orders: readonly MarkOrder[];
}

const NO_ORDERS: Orders = { last: 0, orders: [] };

/** What the hub shows for a machine. It changes in one step, and only to a state the machine read later. */
interface Shown {
  readonly label: string;
  readonly at: number;
  readonly held: Held;
  /** Each work's page, by its hash. */
  readonly pages: Readonly<Record<string, string>>;
  /** Each file its pages show, by its path. */
  readonly files: Readonly<Record<string, Kept>>;
}

/*
 * The storage, by key:
 *   shown:<machine>          what is shown for it (Shown)
 *   page:<machine>:<work>    a work's page, adopted
 *   heard:<machine>          when it last sent anything the hub took, apart from what is shown
 *   pending:<machine>        what its newest send that lacked something may upload (Pending)
 *   stored:<machine>         the bytes of the files it has put in the bucket
 *   orders:<machine>         the marks changed here that it has not shown it applied (Orders)
 *   forgotten:<machine>      when the deployer removed it: its credential is refused from then on
 *   spent:<key>              a nonce or a token used to sign in, until it expires
 *   spentBy:<until>:<key>    the same, in the order they expire
 */

/** The central hub keeps no works of its own. */
const NOTHING: WorkStore = { version: 0, refresh() {}, state: () => null, detail: () => null, media: () => [], file: async () => new Response("Not found", { status: 404 }) };

const parse = <T>(stored: unknown): T | null => (typeof stored === "string" ? (JSON.parse(stored) as T) : null);

class Refused extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export class CentralHub {
  private shown: Map<string, Shown> | null = null;
  private readonly heard = new Map<string, number>();

  private readonly ctx: HubContext;
  private readonly files: Bucket;

  constructor(ctx: HubContext, files: Bucket) {
    this.ctx = ctx;
    this.files = files;
  }

  private get kv(): Kv {
    return this.ctx.storage.kv;
  }

  private load(): Map<string, Shown> {
    if (this.shown) return this.shown;
    const shown = new Map<string, Shown>();
    for (const [key, stored] of this.kv.list({ prefix: "shown:" })) {
      const machine = key.slice("shown:".length);
      const state = parse<Shown>(stored);
      if (!state) continue;
      shown.set(machine, state);
      this.heard.set(machine, Number(this.kv.get(`heard:${machine}`) ?? 0));
    }
    this.shown = shown;
    return shown;
  }

  async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    const now = Date.now();
    const machine = request.headers.get(MACHINE_HEADER);
    if (request.method === "POST" && path === "/_/forget" && machine) return this.forget(machine);
    if (request.method === "GET" && path === "/_/machines") return this.machines();
    if (request.method === "POST" && path === "/_/stored" && machine) return this.stored(machine, request);
    if (machine && this.forgotten(machine)) return new Response(NOT_LINKED, { status: 401 });
    if (request.method === "POST" && path === "/_/send" && machine) return this.receive(machine, request, now);
    if (request.method === "POST" && path === "/_/admit" && machine) return this.admit(machine, request);
    if (request.method === "POST" && path === "/_/spend") return this.spend(await request.json(), now);
    if (request.method === "POST" && path === "/_/marks") return this.mark((await request.json()) as MarkChange, now);
    if (path === "/api/events") return this.listen();
    if (path.startsWith("/files/")) {
      // A copy the browser keeps is used only after it asks: the Worker answers that only to a session.
      const ref = this.ref(path.slice("/files/".length));
      if (ref && request.headers.get("if-none-match") === etag(ref.kept)) return new Response(null, { status: 304, headers: { ETag: etag(ref.kept) } });
    }
    return (await read(request, { stores: this.stores(now), state: () => this.state(now) })) ?? new Response("Not found", { status: 404 });
  }

  /** Called when a machine may have gone quiet since the last request. */
  alarm(): void {
    this.changed();
    this.wake(Date.now());
  }

  // ---------------------------------------------------------------- Reads

  private health(machine: string, now: number): Health {
    const heard = this.heard.get(machine) ?? 0;
    return now - heard < QUIET_MS ? { ok: true } : { ok: false, since: new Date(heard).toISOString() as never, reason: "It has sent nothing since then. It may be asleep or offline." };
  }

  private stores(now: number): Stores {
    const others = [...this.load()].map(([machine, { label, held, pages }]): OtherStore => ({
      ...NOTHING,
      id: machine,
      label,
      state: () => ({ ...held.store, health: this.health(machine, now) }),
      detail: (work: WorkId) => {
        const own = work.slice(machine.length + FROM.length);
        return Object.hasOwn(pages, own) ? parse<WorkDetail>(this.kv.get(`page:${machine}:${own}`)) : null;
      },
      media: () => held.media,
      file: (path: string) => this.file(path),
    }));
    return new Stores(NOTHING, others);
  }

  /**
   * The hub's state: every machine's, with each one's todos, and its marks with the orders it has not taken laid
   * over them. Marks can be changed from here, and todos can't.
   */
  private state(now: number): HubState {
    const machines = [...this.load()];
    const marks = machines.map(([machine, shown]) => withOrders(shown.held.marks, this.orders(machine).orders));
    return {
      ...this.stores(now).state(),
      marks: { viewed: marks.flatMap((m) => m.viewed), dismissed: marks.flatMap((m) => m.dismissed) },
      todos: machines.flatMap(([, shown]) => shown.held.todos).sort((a, b) => (a.addedAt < b.addedAt ? 1 : a.addedAt > b.addedAt ? -1 : 0)),
      todosReadOnly: true,
      signedIn: true,
    };
  }

  /** The file at a path after `/files/`, `<machine>~<work>/…`, when that machine's state names it. */
  private ref(path: string): { machine: string; kept: Kept } | null {
    const at = path.indexOf(FROM);
    if (at <= 0) return null;
    const machine = path.slice(0, at);
    let own: string;
    try {
      own = path.slice(at + FROM.length).split("/").map(decodeURIComponent).join("/");
    } catch {
      return null;
    }
    const files = this.load().get(machine)?.files;
    const kept = files && Object.hasOwn(files, own) ? files[own] : undefined;
    return kept ? { machine, kept } : null;
  }

  /** A file a machine's page shows, by the path the machine named it at. Anything else is not found. */
  private async file(path: string): Promise<Response> {
    const ref = this.ref(path);
    const object = ref ? await this.files.get(fileKey(ref.machine, ref.kept.digest)) : null;
    return object && ref ? new Response(object.body, { headers: { "Content-Type": ref.kept.type, ETag: etag(ref.kept) } }) : new Response("Not found", { status: 404 });
  }

  // ---------------------------------------------------------------- What a page listens to

  private listen(): Response {
    const Pair = (globalThis as unknown as { WebSocketPair: new () => Record<0 | 1, unknown> }).WebSocketPair;
    const pair = new Pair();
    this.ctx.acceptWebSocket(pair[1]);
    return new Response(null, { status: 101, webSocket: pair[0] } as ResponseInit);
  }

  private changed(): void {
    for (const socket of this.ctx.getWebSockets()) {
      try {
        socket.send("changed");
      } catch {
        // A page that went away.
      }
    }
  }

  /** Sets the alarm for when the next machine that is heard from now would go quiet. */
  private wake(now: number): void {
    const next = Math.min(...[...this.heard.values()].map((heard) => heard + QUIET_MS).filter((at) => at > now));
    if (Number.isFinite(next)) void this.ctx.storage.setAlarm(next + 1000);
  }

  // ---------------------------------------------------------------- What a machine sends

  private async receive(machine: string, request: Request, now: number): Promise<Response> {
    let sent;
    try {
      sent = readSend(JSON.parse(await unzip(request)));
    } catch (error) {
      return reply(error instanceof Refused ? error.status : 400, { error: error instanceof Refused ? error.message : "The request is not gzipped JSON." });
    }
    if (typeof sent === "string") return reply(400, { error: sent });
    if (sent.kind === "hello") {
      this.hear(machine, now);
      this.above(machine, sent.applied ?? 0, now);
      return reply(200, this.handOver(machine, sent.applied ?? 0));
    }
    try {
      return await this.take(machine, sent, now);
    } catch (error) {
      if (error instanceof Refused) return reply(error.status, { error: error.message });
      return reply(500, { error: `It could not be kept: ${error instanceof Error ? error.message : String(error)}` });
    }
  }

  /** A hello: the machine is alive. Only a machine whose state is shown is kept track of. It touches nothing shown. */
  private hear(machine: string, now: number): void {
    if (!this.load().has(machine)) return;
    const quiet = !this.health(machine, now).ok;
    this.kv.put(`heard:${machine}`, String(now));
    this.heard.set(machine, now);
    if (quiet) this.changed();
    this.wake(now);
  }

  /**
   * A machine's state. Shown only when the hub holds every page and file it names, and only when the machine read
   * it after the state shown now. A send refused on the way changes nothing shown.
   */
  private async take(machine: string, sent: StateSend, now: number): Promise<Response> {
    if (sent.at > now + AHEAD_MS) throw new Refused(400, "This machine's clock is ahead of the hub's. Set it right and it sends again.");
    // Asked first, and again with no wait before each write: another send may have been shown or named its files meanwhile.
    const mayTake = () => {
      if (this.forgotten(machine)) throw new Refused(401, NOT_LINKED);
      const shown = this.load().get(machine);
      if (!shown && this.load().size >= MOST_MACHINES) throw new Refused(403, `This hub shows at most ${MOST_MACHINES} machines.`);
      if (shown && shown.at >= sent.at) throw new Refused(409, "A newer state from this machine is shown.");
      if ((parse<Pending>(this.kv.get(`pending:${machine}`))?.at ?? 0) > sent.at) throw new Refused(409, "A newer state from this machine is waiting for its files.");
      return shown;
    };
    const before = mayTake();

    const peer: Peer = { id: machine, label: sent.label, host: null };
    const held = await adoptHeld(peer, sent);
    const works = new Set(sent.state.store.works.map((work) => work.id as string));
    if (works.size !== Object.keys(sent.pages).length || ![...works].every((work) => Object.hasOwn(sent.pages, work))) throw new Refused(400, "The pages named are not the works the state lists.");
    if (!sent.files.every((file) => works.has(file.path.slice(0, file.path.indexOf("/"))))) throw new Refused(400, "A file named is not in one of the machine's works.");

    // Each page and the state are measured as they are stored: made this hub's own, a page can grow.
    const bodies = new Map<string, string>();
    for (const [work, json] of Object.entries(sent.bodies ?? {})) {
      if ((await sha256Hex(json)) !== sent.pages[work]) throw new Refused(400, `The page of ${work} is not the one its hash names.`);
      const page: unknown = JSON.parse(json);
      const detail = await readDetail(peer, page);
      if (detail === null || (page as WorkDetail).summary.id !== work) throw new Refused(400, `The page of ${work} is not one this hub can read.`);
      const row = JSON.stringify(detail);
      if (byteSize(row) > MOST_ROW_BYTES) throw new Refused(413, `The page of ${work} is larger than this hub keeps.`);
      bodies.set(work, row);
    }
    const next: Shown = { label: sent.label, at: sent.at, held, pages: sent.pages, files: Object.fromEntries(sent.files.map(({ path, digest, type }) => [path, { digest, type }])) };
    const row = JSON.stringify(next);
    if (byteSize(row) > MOST_ROW_BYTES) throw new Refused(413, "The state is larger than this hub keeps.");

    const lackingPages = [...works].filter((work) => !bodies.has(work) && before?.pages[work] !== sent.pages[work]);
    const known = new Set(Object.values(before?.files ?? {}).map((file) => file.digest));
    const sizes = new Map(sent.files.map((file) => [file.digest, file.size]));
    const lackingFiles = await this.absent(machine, [...sizes.keys()].filter((digest) => !known.has(digest)));
    if (lackingPages.length > 0 || lackingFiles.length > 0) {
      mayTake();
      // What the machine may upload: the files this send named that the bucket lacks, at the sizes it named.
      this.kv.put(`pending:${machine}`, JSON.stringify({ at: sent.at, files: Object.fromEntries(lackingFiles.map((digest) => [digest, sizes.get(digest)!])) } satisfies Pending));
      return reply(200, { missing: { pages: lackingPages, files: lackingFiles } });
    }

    this.ctx.storage.transactionSync(() => {
      const current = mayTake();
      if ([...works].some((work) => !bodies.has(work) && current?.pages[work] !== sent.pages[work])) throw new Refused(409, "Its pages changed while this send was read. Send again.");
      for (const [work, page] of bodies) this.kv.put(`page:${machine}:${work}`, page);
      for (const [key] of [...this.kv.list({ prefix: `page:${machine}:` })]) if (!works.has(key.slice(`page:${machine}:`.length))) this.kv.delete(key);
      this.kv.put(`shown:${machine}`, row);
      this.kv.put(`heard:${machine}`, String(now));
      this.kv.delete(`pending:${machine}`);
      // What this state says the machine applied is in its marks now, so those orders go.
      const orders = this.orders(machine);
      const left = orders.orders.filter((order) => order.n > (sent.applied ?? 0));
      if (left.length < orders.orders.length) this.kv.put(`orders:${machine}`, JSON.stringify({ last: orders.last, orders: left } satisfies Orders));
      this.above(machine, sent.applied ?? 0, now);
    });
    this.load().set(machine, next);
    this.heard.set(machine, now);
    this.changed();
    this.wake(now);
    return reply(200, this.handOver(machine, sent.applied ?? 0));
  }

  /** The digests the bucket lacks under this machine. Each is asked about once, or, for many, the machine's folder is listed. */
  private async absent(machine: string, digests: readonly string[]): Promise<string[]> {
    if (digests.length === 0) return [];
    if (digests.length <= ASK_EACH_UP_TO) {
      const there = await Promise.all(digests.map((digest) => this.files.head(fileKey(machine, digest))));
      return digests.filter((_, at) => !there[at]);
    }
    const lacking = new Set(digests);
    let cursor: string | undefined;
    for (let calls = 0; calls < MOST_BUCKET_CALLS && lacking.size > 0; calls++) {
      const page = await this.files.list({ prefix: folderOf(machine), ...(cursor ? { cursor } : {}) });
      for (const { key } of page.objects) lacking.delete(key.slice(folderOf(machine).length));
      if (!page.truncated) break;
      cursor = page.cursor;
    }
    // Past the calls allowed, a file is taken as missing: uploading it again only puts the same bytes back.
    return [...lacking];
  }

  /** Whether the machine may upload this file: its last send named it, at this size, and it has room left. Each is let in once. */
  private async admit(machine: string, request: Request): Promise<Response> {
    const { digest, size } = (await request.json()) as { digest: string; size: number };
    const pending = parse<Pending>(this.kv.get(`pending:${machine}`));
    if (!pending || !Object.hasOwn(pending.files, digest) || pending.files[digest] !== size) return new Response("This machine's last send named no such file, at that size.", { status: 403 });
    if (Number(this.kv.get(`stored:${machine}`) ?? 0) + size > MOST_MACHINE_BYTES) return new Response("This machine has put all the hub keeps for one machine.", { status: 413 });
    delete pending.files[digest];
    this.kv.put(`pending:${machine}`, JSON.stringify(pending));
    return new Response(null, { status: 204 });
  }

  /**
   * A file the Worker put in the bucket for the machine: only now do its bytes count. One that lands after its
   * machine was removed is deleted again, since the removal may have listed the folder before it was there.
   */
  private async stored(machine: string, request: Request): Promise<Response> {
    const { digest, size } = (await request.json()) as { digest: string; size: number };
    if (this.forgotten(machine)) {
      await this.files.delete([fileKey(machine, digest)]);
      return new Response(NOT_LINKED, { status: 401 });
    }
    this.kv.put(`stored:${machine}`, String(Number(this.kv.get(`stored:${machine}`) ?? 0) + size));
    return new Response(null, { status: 204 });
  }

  // ---------------------------------------------------------------- Marks changed here

  private orders(machine: string): Orders {
    return parse<Orders>(this.kv.get(`orders:${machine}`)) ?? NO_ORDERS;
  }

  /**
   * A machine that says it applied a higher number than this hub has given holds orders from before the hub's
   * storage was emptied. The next number goes above that, so a new order is never taken for one it already applied.
   * No further ahead than a clock may run, so a number a machine made up can't use the numbers up.
   */
  private above(machine: string, applied: number, now: number): void {
    const orders = this.orders(machine);
    const least = Math.min(applied, now + AHEAD_MS);
    if (least > orders.last) this.kv.put(`orders:${machine}`, JSON.stringify({ last: least, orders: orders.orders } satisfies Orders));
  }

  /** The part of an answer to a machine that carries the orders it has not said it applied, each key as the machine keeps it. */
  private handOver(machine: string, applied: number): Pick<Answer, "marks"> {
    const marks = this.orders(machine).orders.flatMap((order) => {
      const own = ownMark(order.kind, order.key);
      return order.n > applied && own ? [{ ...order, key: own.key }] : [];
    });
    return marks.length > 0 ? { marks } : {};
  }

  /**
   * A change to marks a signed-in browser asked for, as orders for the machines its keys name. Every key must name
   * a machine the hub shows, or nothing changes. A later order for a key replaces the one before it.
   */
  private mark(change: MarkChange, now: number): Response {
    const owners = change.keys.map((key) => ownMark(change.kind, key));
    // Each key is about something the machine it names has: one of its own works, or a thread of its that is stalled now.
    const theirs = (key: string, owner: { machine: string; key: string } | null) => {
      const shown = owner ? this.load().get(owner.machine) : undefined;
      if (!owner || !shown) return false;
      // Marked done only while that machine says the thread is stalled. Unmarked whenever, since the thread may have moved on.
      if (key.startsWith("stall:")) return ownsMark(change.kind, owner.key, new Set()) && (!change.on || shown.held.store.needs.some((need) => need.source === "stall" && `stall:${need.stall.thread}` === key));
      return ownsMark(change.kind, owner.key, new Set(shown.held.store.works.map((work) => work.id.slice(owner.machine.length + FROM.length))));
    };
    if (!change.keys.every((key, at) => theirs(key, owners[at] ?? null))) return new Response("A key is about nothing a machine this hub shows has.", { status: 400 });
    try {
      this.ctx.storage.transactionSync(() => {
        for (const machine of new Set(owners.map((owner) => owner!.machine))) {
          const before = this.orders(machine);
          const kept = new Map(before.orders.map((order) => [`${order.kind}\n${order.key}`, order]));
          let last = before.last;
          for (const [at, key] of change.keys.entries()) {
            if (owners[at]!.machine !== machine) continue;
            // From the clock as well, so a number stays above any a machine was handed before the hub's storage was emptied.
            last = Math.max(last + 1, now);
            kept.set(`${change.kind}\n${key}`, { n: last, kind: change.kind, key, on: change.on });
          }
          const row = JSON.stringify({ last, orders: [...kept.values()] } satisfies Orders);
          if (kept.size > MOST_ORDERS || byteSize(row) > MOST_ROW_BYTES) {
            throw new Refused(409, `${this.load().get(machine)!.label} has been away too long: the hub keeps at most ${MOST_ORDERS} changes for a machine until it takes them. Change this on that machine's own hub, or wait until it is back.`);
          }
          this.kv.put(`orders:${machine}`, row);
        }
      });
    } catch (error) {
      if (error instanceof Refused) return new Response(error.message, { status: error.status });
      throw error;
    }
    this.changed();
    return new Response(null, { status: 204 });
  }

  // ---------------------------------------------------------------- The deployer's orders

  private forgotten(machine: string): boolean {
    return this.kv.get(`forgotten:${machine}`) !== undefined;
  }

  /** Every machine the hub keeps anything for, with what the deployer needs to pick one to remove. */
  private machines(): Response {
    const ids = new Set<string>();
    for (const prefix of ["shown:", "pending:", "stored:"]) for (const [key] of this.kv.list({ prefix })) ids.add(key.slice(prefix.length));
    const held = [...ids].sort().map((id): HeldMachine => {
      const shown = this.load().get(id);
      return { id, label: shown?.label ?? null, heard: this.heard.get(id) ?? 0, works: shown ? Object.keys(shown.pages).length : null };
    });
    return Response.json(held);
  }

  /**
   * Removes a machine: everything kept for it goes in one step, and its credential is refused from then on, so a
   * send or an upload already on its way brings nothing back. Then its files go from the bucket, a page at a time.
   */
  private async forget(machine: string): Promise<Response> {
    this.ctx.storage.transactionSync(() => {
      for (const key of [`shown:${machine}`, `heard:${machine}`, `pending:${machine}`, `stored:${machine}`, `orders:${machine}`, ...[...this.kv.list({ prefix: `page:${machine}:` })].map(([key]) => key)]) this.kv.delete(key);
      this.kv.put(`forgotten:${machine}`, String(Date.now()));
    });
    this.load().delete(machine);
    this.heard.delete(machine);
    this.changed();
    let files = 0;
    let done = false;
    // Each page is listed from the start: the one before it is gone.
    for (let calls = 0; calls + 2 <= MOST_BUCKET_CALLS; calls += 2) {
      const page = await this.files.list({ prefix: folderOf(machine) });
      if (page.objects.length > 0) await this.files.delete(page.objects.map(({ key }) => key));
      files += page.objects.length;
      if (!page.truncated) {
        done = true;
        break;
      }
    }
    return Response.json({ files, done } satisfies Forgotten);
  }

  // ---------------------------------------------------------------- Sign-in

  /**
   * Spends a sign-in's nonce and token together: fresh only when neither was spent before, so each signs in once.
   * A few of the oldest spent marks that have expired go each time.
   */
  private spend(body: unknown, now: number): Response {
    const keys = (body as { keys: { key: string; until: number }[] }).keys;
    const fresh = this.ctx.storage.transactionSync(() => {
      const fresh = keys.every(({ key }) => this.kv.get(`spent:${key}`) === undefined);
      for (const { key, until } of keys) {
        this.kv.put(`spent:${key}`, String(until));
        this.kv.put(`spentBy:${String(until).padStart(15, "0")}:${key}`, "");
      }
      for (const [index] of [...this.kv.list({ prefix: "spentBy:", limit: 10 })]) {
        const [, until = "", key = ""] = /^spentBy:(\d+):(.*)$/.exec(index) ?? [];
        if (Number(until) >= now) break;
        this.kv.delete(index);
        this.kv.delete(`spent:${key}`);
      }
      return fresh;
    });
    return Response.json({ fresh });
  }
}

const reply = (status: number, body: Omit<Answer, "format">) => Response.json({ format: FORMAT, ...body } satisfies Answer, { status });

/** A machine's marks with the orders it has not taken laid over them. */
function withOrders(marks: Marks, orders: readonly MarkOrder[]): Marks {
  const laid = { viewed: new Set(marks.viewed), dismissed: new Set(marks.dismissed) };
  for (const order of orders) {
    if (order.on) laid[order.kind].add(order.key);
    else laid[order.kind].delete(order.key);
  }
  return { viewed: [...laid.viewed], dismissed: [...laid.dismissed] };
}

const byteSize = (text: string) => new TextEncoder().encode(text).byteLength;

const etag = (kept: Kept) => `"${kept.digest}"`;

/** The machine's state, checked as deep as the app reads it and made this hub's own. Throws `Refused` when it can't be read. */
async function adoptHeld(peer: Peer, sent: StateSend): Promise<Held> {
  const store = await readState(peer, sent.state.store).catch(() => {
    throw new Refused(400, "The state is not one this hub can read.");
  });
  const media = await readMedia(peer, sent.state.media);
  const marks = readOrNull(readMarks, sent.state.marks);
  const todos = readOrNull(listOf(readTodo), sent.state.todos);
  if (media === null || marks === null || todos === null) throw new Refused(400, "The media, the marks or the todos are not ones this hub can read.");
  const works = new Set(sent.state.store.works.map((work) => work.id as string));
  return { store, media, marks: adoptMarks(peer.id, marks, works), todos: todos.map((todo) => adoptTodo(peer.id, todo, works)) };
}

function adoptTodo(machine: string, todo: Todo, works: ReadonlySet<string>): Todo {
  return { ...todo, id: `${machine}${FROM}${todo.id}`, work: todo.work !== null && works.has(todo.work as string) ? (`${machine}${FROM}${todo.work}` as WorkId) : null };
}

/** A request's gzipped body as text, refused past `MOST_SEND_BYTES` as it is unpacked. */
async function unzip(request: Request): Promise<string> {
  if (!request.body) throw new Refused(400, "No body.");
  const text = await readCapped(request.body.pipeThrough(new DecompressionStream("gzip")), MOST_SEND_BYTES);
  if (text === null) throw new Refused(413, `A send holds at most ${MOST_SEND_BYTES} bytes unpacked.`);
  return text;
}
