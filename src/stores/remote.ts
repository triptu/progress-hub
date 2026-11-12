import type { Health, Media, WorkDetail, WorkId, WorkSummary } from "../core/types.ts";
import { instant } from "../core/journal.ts";
import type { AgentSource } from "../sources/source.ts";
import { FROM, type OtherStore, type StoreState } from "./store.ts";

/**
 * Another of the user's machines, read as a store: its hub is asked over HTTP for the works it keeps.
 * Everything about other machines is in this file. The hub and the server know only `WorkStore`.
 */
export interface Remote {
  /** Short and safe in an address: it leads the id of every work from that machine. */
  readonly id: string;
  readonly label: string;
  /** Where that machine's hub answers, such as `http://box.tailnet.ts.net:4747`. */
  readonly url: string;
}

const PATIENCE_MS = 3_000;
const EVERY_MS = 5_000;
const WHEN_DOWN_MS = 30_000;
/**
 * The other machines to read: those a harness is linked to, on this hub's port, and any named in
 * `$PROGRESS_PEERS` as `label=http://host:port` separated by commas. A machine is listed once, and never this one.
 */
export function findRemotes(sources: readonly AgentSource[], port: number, own: ReadonlySet<string>, env: Record<string, string | undefined> = process.env): Remote[] {
  const peers = new Map<string, Remote>();
  const add = (label: string, url: string) => {
    if (!URL.canParse(url)) return;
    const host = new URL(url).hostname.toLowerCase();
    // A name's first part, or a whole address when the host is one, so two machines never share an id.
    const base = (/^[\d.]+$|:/.test(host) ? host : (host.split(".")[0] ?? "")).replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
    // This hub itself is this machine on this port. Another port here is another hub.
    const self = own.has(host) && Number(new URL(url).port || 80) === port;
    const key = `${host}:${new URL(url).port}`;
    if (base === "" || self || peers.has(key)) return;
    const taken = new Set([...peers.values()].map((peer) => peer.id));
    let id = base;
    for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;
    peers.set(key, { id, label: label || id, url: url.replace(/\/+$/, "") });
  };
  for (const entry of (env.PROGRESS_PEERS ?? "").split(",").map((part) => part.trim()).filter((part) => part !== "")) {
    const named = /^([^=]+)=(.+)$/.exec(entry);
    add(named?.[1]?.trim() ?? "", named?.[2]?.trim() ?? entry);
  }
  for (const source of sources) for (const machine of source.machines?.() ?? []) add(machine.label, `http://${machine.host}:${port}`);
  return [...peers.values()];
}

/** A work's id on this hub, when it lives on another machine. */
const idFrom = (peer: Remote, work: string) => `${peer.id}${FROM}${work}` as WorkId;

/** The fields that hold an address, and the ones that hold HTML a page rendered. */
const ADDRESS = new Set(["url", "href", "link", "threadLink", "src"]);
const HTML = new Set(["html", "titleHtml"]);
const FILE_ATTRIBUTES = ["src", "href", "poster"];

/** An address a browser would run instead of open is no address. A harness's own scheme, such as the one that opens a thread, is fine. */
const address = (value: string) => (/^\s*(javascript|data|vbscript):/i.test(value) ? "" : value);

/**
 * What a peer sent, made this hub's own, field by field. A file its pages show is fetched through this hub,
 * since the browser may not reach the other machine: `/files/<work>/…` becomes `/files/<id>~<work>/…` in the fields
 * that are addresses and in the attributes of the HTML its pages rendered, however that HTML quotes them.
 */
function adopt<T>(peer: Remote, value: T): T {
  const route = (path: string) => (path.startsWith("/files/") ? `/files/${peer.id}${FROM}${path.slice("/files/".length)}` : path);
  const html = (text: string) => {
    let rewriter = new HTMLRewriter();
    for (const name of FILE_ATTRIBUTES) {
      rewriter = rewriter.on(`[${name}]`, {
        element(el) {
          const at = el.getAttribute(name);
          if (at !== null) el.setAttribute(name, route(at));
        },
      });
    }
    return rewriter.transform(text);
  };
  const walk = (part: unknown, key: string, parent: Record<string, unknown> | null): unknown => {
    if (typeof part === "string") {
      if (ADDRESS.has(key)) return key === "src" || key === "href" ? route(address(part)) : address(part);
      // A work's body holds its goal and summary as HTML. A work's summary holds them as plain words.
      return HTML.has(key) || ((key === "goal" || key === "summary") && Array.isArray(parent?.sections)) ? html(part) : part;
    }
    if (Array.isArray(part)) return part.map((item) => walk(item, key, parent));
    if (typeof part === "object" && part !== null) return Object.fromEntries(Object.entries(part).map(([name, item]) => [name, walk(item, name, part as Record<string, unknown>)]));
    return part;
  };
  return walk(value, "", null) as T;
}

// ---------------------------------------------------------------- What a peer may send

/*
 * A peer is another program, perhaps another version of this one, perhaps broken. What it sends is read
 * as unknown and checked for everything this hub and its page then rely on, in one place. An answer that
 * fails is no answer: the hub keeps what it had and says the machine can't be read.
 */
type Fields = Record<string, unknown>;
const isFields = (value: unknown): value is Fields => typeof value === "object" && value !== null && !Array.isArray(value);
const isText = (value: unknown): value is string => typeof value === "string";
const each = (value: unknown, check: (item: Fields) => boolean) => Array.isArray(value) && value.every((item) => isFields(item) && check(item));
const isHealth = (value: unknown) => isFields(value) && (value.ok === true || (value.ok === false && isText(value.since) && isText(value.reason)));

const isMedia = (m: Fields) => isText(m.work) && isText(m.src) && isText(m.at) && isText(m.caption) && isText(m.kind);
const isWork = (w: unknown): w is Fields =>
  isFields(w) && isText(w.id) && isText(w.title) && isText(w.lastChangeAt) && isText(w.summary) && isText(w.goal) && isText(w.preview) && typeof w.settled === "boolean" && isFields(w.pullRequests) && each(w.links, (l) => isText(l.url) && isText(l.label) && (l.href === null || isText(l.href)));
const isNeed = (n: Fields) => (n.work === null || isText(n.work)) && (n.source === "page" ? isText(n.since) && isText(n.itemId) && isText(n.title) && isText(n.html) : n.source === "stall" && isFields(n.stall) && isText(n.stall.since) && isText(n.stall.thread));
const isFeed = (f: Fields) => isText(f.at) && isText(f.work) && isText(f.workTitle) && isFields(f.event) && isText(f.event.kind) && Array.isArray(f.prs) && Array.isArray(f.commits);

function isState(value: unknown): value is StoreState {
  if (!isFields(value)) return false;
  return (
    Array.isArray(value.works) &&
    value.works.every(isWork) &&
    each(value.needs, isNeed) &&
    each(value.plan, (p) => isText(p.work) && isText(p.workTitle) && (p.state === "doing" || p.state === "next") && (isFields(p.item) || isFields(p.pr))) &&
    each(value.feed, isFeed) &&
    each(value.sources, (source) => isText(source.id) && isText(source.label) && isHealth(source.health)) &&
    (value.latestMedia === null || (isFields(value.latestMedia) && isMedia(value.latestMedia)))
  );
}

const isDetail = (value: unknown): value is WorkDetail =>
  isFields(value) && isWork(value.summary) && isFields(value.body) && Array.isArray(value.body.sections) && each(value.feed, isFeed) && Array.isArray(value.agents) && Array.isArray(value.pullRequests) && Array.isArray(value.notes);

/** One work's summary from a peer, as this hub lists it. */
function adoptWork(peer: Remote, work: WorkSummary): WorkSummary {
  const host = new URL(peer.url).hostname;
  const there = (url: string) => {
    if (!URL.canParse(url)) return url;
    const parsed = new URL(url);
    // An address on that machine means that machine, not the one the browser is on.
    if (!/^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])$/.test(parsed.hostname)) return url;
    parsed.hostname = host;
    return parsed.href.replace(/\/$/, url.endsWith("/") ? "/" : "");
  };
  return {
    ...work,
    id: idFrom(peer, work.id),
    machine: peer.label,
    // A file kept outside the work's folder can only be opened on its own machine, so it is not offered here.
    // A link from another machine is a web address or a file fetched through this hub. Anything else is left out.
    links: work.links.flatMap((link) => (link.href === null || !/^(https?:\/\/|\/files\/)/i.test(link.href) ? [] : [{ ...link, href: link.href.startsWith("/") ? link.href : there(link.href) }])),
  };
}

/** A peer's state as this hub holds it. Throws when it is not a state this hub can read, such as another version's. */
function readState(peer: Remote, answer: unknown): StoreState {
  if (!isState(answer)) throw new Error("It sent something this hub can't read. It may run another version.");
  const adopted = adopt(peer, answer);
  return {
    ...adopted,
    works: adopted.works.map((work) => adoptWork(peer, work)),
    needs: adopted.needs.map((need) => (need.work === null ? need : { ...need, work: idFrom(peer, need.work) })),
    plan: adopted.plan.map((entry) => ({ ...entry, work: idFrom(peer, entry.work) })),
    feed: adopted.feed.map((entry) => ({ ...entry, work: idFrom(peer, entry.work) })),
    latestMedia: adopted.latestMedia ? { ...adopted.latestMedia, work: idFrom(peer, adopted.latestMedia.work) } : null,
    // A harness that machine can't read is named with the machine, so the hub never says nothing waits when it can't know.
    sources: adopted.sources.map((source) => ({ ...source, id: `${peer.id}${FROM}${source.id}`, label: `${source.label} on ${peer.label}` })),
  };
}

export class RemoteStore implements OtherStore {
  /** Goes up whenever what the machine says, or whether it answers, changes. */
  version = 0;
  readonly id: string;
  readonly label: string;
  private readonly remote: Remote;
  private said: StoreState | null = null;
  private raw = "";
  private health: Health = { ok: true };
  private next = 0;
  private busy = false;

  constructor(remote: Remote) {
    this.remote = remote;
    this.id = remote.id;
    this.label = remote.label;
  }

  private get(path: string): Promise<Response> {
    // A machine is asked only at its own address: a redirect could point this hub at something only it can reach.
    return fetch(this.remote.url + path, { signal: AbortSignal.timeout(PATIENCE_MS), redirect: "error" });
  }

  /** Asks the machine for its own works, when it is due. One that doesn't answer keeps what it last said, and is asked less often. */
  refresh(now = new Date()): void {
    if (this.busy || now.getTime() < this.next) return;
    this.busy = true;
    void this.get("/api/state?own=1")
      .then(async (response) => {
        if (!response.ok) throw new Error(`It answered ${response.status}.`);
        const raw = await response.text();
        // Read before anything is counted as changed, so an answer that can't be read is not a change on every try.
        const said = raw === this.raw ? this.said : readState(this.remote, JSON.parse(raw));
        if (raw !== this.raw || !this.health.ok) this.version++;
        this.said = said;
        this.raw = raw;
        this.health = { ok: true };
        this.next = Date.now() + EVERY_MS;
      })
      .catch((error: unknown) => {
        const reason = error instanceof Error && error.name !== "TimeoutError" ? error.message : "It did not answer.";
        if (this.health.ok || this.health.reason !== reason) {
          this.health = { ok: false, since: this.health.ok ? instant(new Date()) : this.health.since, reason };
          this.version++;
        }
        this.next = Date.now() + WHEN_DOWN_MS;
      })
      .finally(() => {
        this.busy = false;
      });
  }

  /** What the machine last said, with whether it answers now. Null while it has never answered: it may simply have no hub. */
  state(): StoreState | null {
    return this.said ? { ...this.said, health: this.health } : null;
  }

  /**
   * The machine's answer, read and made this hub's own by `read`. Null when it is known to be away, doesn't
   * answer, or sends something `read` can't take, so one machine never breaks a screen.
   */
  private async ask<T>(path: string, read: (answer: unknown) => T | null): Promise<T | null> {
    if (!this.health.ok) return null;
    try {
      const response = await this.get(path);
      return response.ok ? read(await response.json()) : null;
    } catch {
      return null;
    }
  }

  /** One work's whole page, from the machine it lives on. */
  detail(work: WorkId): Promise<WorkDetail | null> {
    const there = work.slice(this.id.length + FROM.length);
    return this.ask(`/api/work/${encodeURIComponent(there)}`, (answer) => {
      if (!isDetail(answer)) return null;
      const detail = adopt(this.remote, answer);
      return { ...detail, summary: adoptWork(this.remote, detail.summary), feed: detail.feed.map((entry) => ({ ...entry, work: idFrom(this.remote, entry.work) })) };
    });
  }

  /** The machine's media, each under its work's id on this hub. None when it doesn't answer. */
  async media(): Promise<Media[]> {
    return (await this.ask("/api/media?own=1", (answer) => (each(answer, isMedia) ? adopt(this.remote, answer as Media[]).map((item) => ({ ...item, work: idFrom(this.remote, item.work) })) : null))) ?? [];
  }

  /** A file a work on the machine shows: its bytes and its type, and nothing else the machine said about it. */
  async file(path: string): Promise<Response> {
    const response = await this.get(`/files/${path.slice(this.id.length + FROM.length)}`).catch(() => null);
    if (!response) return new Response("That machine did not answer.", { status: 502 });
    const type = response.headers.get("content-type");
    return new Response(response.body, { status: response.status, headers: type ? { "Content-Type": type } : {} });
  }
}
