import type { Agent, Commit, FeedEntry, Health, Html, Instant, Item, JournalEvent, Live, Media, NeedEntry, OpenLink, PlanEntry, PullRequest, RenderedItem, RenderedSection, SessionRef, Stall, WorkBody, WorkDetail, WorkId, WorkSummary } from "../core/types.ts";
import { instant as instantOf } from "../core/journal.ts";
import { count, either, flag, listOf, oneOf, orElse, orNone, orNull, readOrNull, shape, tableOf, text, variant } from "../core/reader.ts";
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
const idFrom = (peer: Peer, work: string) => `${peer.id}${FROM}${work}` as WorkId;

/** The fields that hold an address, and the ones that hold HTML a page rendered. */
const ADDRESS = new Set(["url", "href", "link", "threadLink", "src"]);
const HTML = new Set(["html", "titleHtml"]);
const FILE_ATTRIBUTES = ["src", "href", "poster"];

/** An address a browser would run instead of open is no address. A harness's own scheme, such as the one that opens a thread, is fine. */
const address = (value: string) => (/^\s*(javascript|data|vbscript):/i.test(value) ? "" : value);

/**
 * What a peer sent, made this hub's own, field by field. A file its pages show is fetched through this hub,
 * since the browser may not reach the other machine: `/files/<work>/…` becomes `/files/<id>~<work>/…`.
 */
function adopt<T>(peer: Peer, value: T): Promise<T> {
  return mapAddresses(value, (path) => (path.startsWith("/files/") ? `/files/${peer.id}${FROM}${path.slice("/files/".length)}` : path));
}

/**
 * The files `value` links, each by its path after `/files/` and without a query: the files `adopt` routes, so
 * the ones a central hub can serve. Found only where `adopt` looks, never by searching other text.
 */
export async function linkedFiles(value: unknown): Promise<Set<string>> {
  const found = new Set<string>();
  await mapAddresses(value, (path) => {
    if (path.startsWith("/files/")) found.add(path.slice("/files/".length).replace(/[?#].*$/, ""));
    return path;
  });
  return found;
}

/**
 * `value` with `route` applied to every address a browser loads or opens: the fields that are addresses, and the
 * attributes of the HTML its pages rendered, however that HTML quotes them. HTML is rewritten as a response, the
 * one way both Bun and a Cloudflare Worker run `HTMLRewriter`.
 */
async function mapAddresses<T>(value: T, route: (path: string) => string): Promise<T> {
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
    return text.includes("/files/") ? rewriter.transform(new Response(text)).text() : text;
  };
  const walk = async (part: unknown, key: string, parent: Record<string, unknown> | null): Promise<unknown> => {
    if (typeof part === "string") {
      if (ADDRESS.has(key)) return key === "src" || key === "href" ? route(address(part)) : address(part);
      // A work's body holds its goal and summary as HTML. A work's summary holds them as plain words.
      return HTML.has(key) || ((key === "goal" || key === "summary") && Array.isArray(parent?.sections)) ? html(part) : part;
    }
    if (Array.isArray(part)) return Promise.all(part.map((item) => walk(item, key, parent)));
    if (typeof part === "object" && part !== null) return Object.fromEntries(await Promise.all(Object.entries(part).map(async ([name, item]) => [name, await walk(item, name, part as Record<string, unknown>)])));
    return part;
  };
  return (await walk(value, "", null)) as T;
}

// ---------------------------------------------------------------- What a peer may send

/*
 * A peer is another program, perhaps another version of this one, perhaps broken or hostile. What it sends is
 * read as unknown, in one place, into the types the hub and the app read, down to each variant: one entry the app
 * can't draw would stop a whole screen. What is read is built again from what was checked, so nothing else it
 * sent is kept. An answer that can't be read is no answer: the hub keeps what it had and says the machine can't be
 * read. A field a hub of an earlier build leaves out is read as what that build meant.
 */
const instant = text<Instant>;
const html = text<Html>;
const workId = text<WorkId>;
const pullRequest = shape<PullRequest>({ url: text, repo: text, number: count, title: text, state: oneOf("draft", "open", "merged", "closed"), openedAt: orNull(instant), mergedAt: orNull(instant) });
const commit = shape<Commit>({ url: text, repo: text, sha: text, subject: text });
const section = oneOf("needs", "doing", "next", "decisions", "shipped");
const item = shape<Item>({ id: text, title: text, markdown: text });
const items = listOf(shape({ section, item }));
const event = variant<JournalEvent, "kind">("kind", {
  started: { at: instant, items, summary: orElse(orNull(text), null), parts: orNone(tableOf(text)) },
  noted: { at: instant, items, parts: tableOf(text) },
  summary: { at: instant, text },
  added: { at: instant, section, item },
  removed: { at: instant, section, item },
  edited: { at: instant, section, item, from: orNone(text) },
  live: { at: instant, item },
  part: { at: instant, heading: text, change: oneOf("added", "edited", "removed"), mark: text },
  done: { at: instant },
  reopened: { at: instant },
  pr: { at: instant, change: oneOf("opened", "merged", "closed"), pr: pullRequest },
});
const rendered = shape<RenderedItem>({
  id: text,
  title: text,
  titleHtml: html,
  html,
  important: flag,
  since: orNull(instant),
  editedAt: orElse(orNull(instant), null),
  live: orElse(orNull(shape<Live>({ on: flag, note: html, at: orNull(instant) })), null),
  prs: listOf(pullRequest),
  commits: listOf(commit),
});
const feedEntry = shape<FeedEntry>({ at: instant, work: text, workTitle: text, project: orNull(text), event, titleHtml: orNull(html), html: orNull(html), prs: listOf(pullRequest), commits: listOf(commit), important: flag });
const media = shape<Media>({ work: text, kind: oneOf("image", "video", "page", "file"), src: text, caption: text, at: instant });
const workSummary = shape<WorkSummary>({
  id: text,
  title: text,
  project: orNull(text),
  machine: orNull(text),
  settled: flag,
  lastChangeAt: instant,
  preview: text,
  summary: text,
  goal: text,
  needsCount: count,
  workingAgents: count,
  agents: count,
  pullRequests: shape({ total: count, merged: count }),
  next: orNone(count),
  doing: orNone(count),
  shipped: count,
  threadLink: orNull(text),
  links: listOf(shape<OpenLink>({ label: text, url: text, href: orNull(text), up: orNull(flag) })),
});
const need = variant<NeedEntry, "source">("source", {
  page: { work: text, workTitle: text, project: orNull(text), itemId: text, title: text, titleHtml: html, html, important: flag, since: instant, repliedSince: flag, threadLink: orNull(text) },
  stall: {
    work: orNull(workId),
    workTitle: orNull(text),
    project: orNull(text),
    agentTitle: text,
    stall: shape<Stall>({ thread: text, ask: oneOf("question", "approval"), text: orNull(text), since: instant }),
    threadLink: orNull(text),
  },
});
const planned = { work: workId, workTitle: text, project: orNull(text), state: oneOf("doing", "next", "shipped") };
const planEntry = either<PlanEntry>(shape({ ...planned, item: rendered, pr: oneOf(null) }), shape({ ...planned, item: oneOf(null), pr: pullRequest }));
const health = either<Health>(shape({ ok: oneOf(true) }), shape<Extract<Health, { ok: false }>>({ ok: oneOf(false), since: instant, reason: text }));
const agent = shape<Agent>({
  thread: text,
  title: text,
  model: orNull(text),
  account: orNull(text),
  branch: orNull(text),
  worktree: orNull(text),
  status: oneOf("working", "waiting", "finished", "failed", "stopped", "idle"),
  startedAt: instant,
  lastActivityAt: instant,
  link: text,
});

/** A state as a peer answers it: its own works, and nothing of its health, which this hub says. */
const storeState = shape<Omit<StoreState, "health">>({
  works: listOf(workSummary),
  needs: listOf(need),
  plan: listOf(planEntry),
  shipped: orElse(listOf(planEntry), []),
  feed: listOf(feedEntry),
  sources: listOf(shape({ id: text, label: text, health })),
  latestMedia: orNull(media),
});

const workDetail = shape<WorkDetail>({
  summary: workSummary,
  body: shape<WorkBody>({ goal: html, summary: html, sections: listOf(shape<RenderedSection>({ heading: text, kind: orNull(section), html, changedAt: orElse(orNull(instant), null), items: listOf(rendered) })) }),
  agents: listOf(agent),
  pullRequests: listOf(pullRequest),
  feed: listOf(feedEntry),
  notes: listOf(text),
});

/** Who sent a state, as the works it adopts are named: its id leads each work's id, and its label says where a work runs. */
export interface Peer {
  readonly id: string;
  readonly label: string;
  /** Where the peer is reached. An address in its works that means "this machine" is pointed there. Null when there is nowhere. */
  readonly host: string | null;
}

const peerOf = (remote: Remote): Peer => ({ id: remote.id, label: remote.label, host: new URL(remote.url).hostname });

/** One work's summary from a peer, as this hub lists it. */
function adoptWork(peer: Peer, work: WorkSummary): WorkSummary {
  const there = (url: string) => {
    if (peer.host === null || !URL.canParse(url)) return url;
    const parsed = new URL(url);
    // An address on that machine means that machine, not the one the browser is on.
    if (!/^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])$/.test(parsed.hostname)) return url;
    parsed.hostname = peer.host;
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
export async function readState(peer: Peer, answer: unknown): Promise<Omit<StoreState, "health">> {
  const read = readOrNull(storeState, answer);
  if (read === null) throw new Error("It sent something this hub can't read. It may run another version.");
  const adopted = await adopt(peer, read);
  return {
    ...adopted,
    works: adopted.works.map((work) => adoptWork(peer, work)),
    // A stalled thread is named with its machine too, so a mark on it is about that machine's thread.
    needs: adopted.needs.map((need) =>
      need.source === "page" ? { ...need, work: idFrom(peer, need.work) } : { ...need, work: need.work === null ? null : idFrom(peer, need.work), stall: { ...need.stall, thread: `${peer.id}${FROM}${need.stall.thread}` as SessionRef } },
    ),
    plan: adopted.plan.map((entry) => ({ ...entry, work: idFrom(peer, entry.work) })),
    shipped: adopted.shipped.map((entry) => ({ ...entry, work: idFrom(peer, entry.work) })),
    feed: adopted.feed.map((entry) => ({ ...entry, work: idFrom(peer, entry.work) })),
    latestMedia: adopted.latestMedia ? { ...adopted.latestMedia, work: idFrom(peer, adopted.latestMedia.work) } : null,
    // A harness that machine can't read is named with the machine, so the hub never says nothing waits when it can't know.
    sources: adopted.sources.map((source) => ({ ...source, id: `${peer.id}${FROM}${source.id}`, label: `${source.label} on ${peer.label}` })),
  };
}

/** One work's page from a peer, as this hub holds it. Null when it is not a page this hub can read. */
export async function readDetail(peer: Peer, answer: unknown): Promise<WorkDetail | null> {
  const read = readOrNull(workDetail, answer);
  if (read === null) return null;
  const adopted = await adopt(peer, read);
  const here = <T extends { readonly work: WorkId }>(entry: T): T => ({ ...entry, work: idFrom(peer, entry.work) });
  return { ...adopted, summary: adoptWork(peer, adopted.summary), feed: adopted.feed.map(here) };
}

/** A peer's media, each under its work's id on this hub. Null when it is not a list this hub can read. */
export async function readMedia(peer: Peer, answer: unknown): Promise<Media[] | null> {
  const read = readOrNull(listOf(media), answer);
  return read === null ? null : (await adopt(peer, read)).map((item) => ({ ...item, work: idFrom(peer, item.work) }));
}

export class RemoteStore implements OtherStore {
  /** Goes up whenever what the machine says, or whether it answers, changes. */
  version = 0;
  readonly id: string;
  readonly label: string;
  private readonly remote: Remote;
  private said: Omit<StoreState, "health"> | null = null;
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
        const said = raw === this.raw ? this.said : await readState(peerOf(this.remote), JSON.parse(raw));
        if (raw !== this.raw || !this.health.ok) this.version++;
        this.said = said;
        this.raw = raw;
        this.health = { ok: true };
        this.next = Date.now() + EVERY_MS;
      })
      .catch((error: unknown) => {
        const reason = error instanceof Error && error.name !== "TimeoutError" ? error.message : "It did not answer.";
        if (this.health.ok || this.health.reason !== reason) {
          this.health = { ok: false, since: this.health.ok ? instantOf(new Date()) : this.health.since, reason };
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
  private async ask<T>(path: string, read: (answer: unknown) => Promise<T | null>): Promise<T | null> {
    if (!this.health.ok) return null;
    try {
      const response = await this.get(path);
      return response.ok ? await read(await response.json()) : null;
    } catch {
      return null;
    }
  }

  /** One work's whole page, from the machine it lives on. */
  detail(work: WorkId): Promise<WorkDetail | null> {
    const there = work.slice(this.id.length + FROM.length);
    return this.ask(`/api/work/${encodeURIComponent(there)}`, (answer) => readDetail(peerOf(this.remote), answer));
  }

  /** The machine's media, each under its work's id on this hub. None when it doesn't answer. */
  async media(): Promise<Media[]> {
    return (await this.ask("/api/media?own=1", (answer) => readMedia(peerOf(this.remote), answer))) ?? [];
  }

  /** A file a work on the machine shows: its bytes and its type, and nothing else the machine said about it. */
  async file(path: string): Promise<Response> {
    const response = await this.get(`/files/${path.slice(this.id.length + FROM.length)}`).catch(() => null);
    if (!response) return new Response("That machine did not answer.", { status: 502 });
    const type = response.headers.get("content-type");
    return new Response(response.body, { status: response.status, headers: type ? { "Content-Type": type } : {} });
  }
}
