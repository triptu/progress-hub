import type { Health, HubState, Media, WorkDetail, WorkId } from "../core/types.ts";

/**
 * A place works are kept and read from. This machine's progress home on disk is one, and the default.
 * Another machine's hub is one. The hub shows every store's works as one list.
 *
 * A store answers with finished state: pages already rendered, with what needs the user, the plan and
 * the feed worked out. So a store is something that can do that work or be handed it, such as a hub.
 */
export interface WorkStore {
  /** Goes up whenever what the store would answer changes. */
  readonly version: number;
  /** Looks for what changed. Called every couple of seconds, so a store that asks over a network paces itself. */
  refresh(now?: Date): void;
  /** What the store holds now. Null while it has never been read, so nothing is said about it yet. */
  state(): StoreState | null;
  /** One work's whole page, by the id the store's state gives it. */
  detail(work: WorkId): WorkDetail | null | Promise<WorkDetail | null>;
  /** Every picture, video, page and document the store's works show. */
  media(): readonly Media[] | Promise<readonly Media[]>;
  /**
   * A file one of the store's works shows, by the path in its address after `/files/`: the work's id, then the
   * path inside the work. The store gives the bytes and their type; how the browser may treat them is `Stores`'s rule.
   */
  file(path: string): Promise<Response>;
}

/** A store beside this machine's own. Its works carry its id, and the user is told when it stops answering. */
export interface OtherStore extends WorkStore {
  /** Short and safe in an address. It leads the id of every work from that store, as `<id>~<work>`, which is how a work's page and its files find their store. */
  readonly id: string;
  readonly label: string;
}

/** What a store says: its works and everything about them, and whether it could be read. */
export interface StoreState extends Pick<HubState, "works" | "needs" | "plan" | "feed" | "latestMedia" | "sources"> {
  readonly health: Health;
}

export const FEED_LIMIT = 300;

/** Parts a work's id from the store it came from, in `<store>~<work>`. Not a character a folder name is given. */
export const FROM = "~";


const newestFirst = <T extends { readonly at: string }>(rows: readonly T[]) => [...rows].sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));

/** Every store as one: this machine's own, and the others beside it. This is all the server knows about where works are kept. */
export class Stores {
  readonly own: WorkStore;
  private readonly others: readonly OtherStore[];

  constructor(own: WorkStore, others: readonly OtherStore[] = []) {
    this.own = own;
    this.others = others;
  }

  get version(): string {
    return [this.own, ...this.others].map((store) => store.version).join("/");
  }

  refresh(now?: Date): void {
    this.own.refresh(now);
    for (const store of this.others) store.refresh(now);
  }

  /** Every store's works, asks, plans and feed as one. A store that has never been read adds nothing and is not named. */
  state(): Omit<HubState, "marks" | "todos"> {
    const own = this.own.state();
    const heard = this.others.flatMap((store) => {
      const state = store.state();
      return state ? [{ store, state }] : [];
    });
    const all = [...(own ? [own] : []), ...heard.map(({ state }) => state)];
    const since = (need: HubState["needs"][number]) => (need.source === "page" ? need.since : need.stall.since);
    return {
      works: all.flatMap((state) => state.works).sort((a, b) => (a.lastChangeAt < b.lastChangeAt ? 1 : a.lastChangeAt > b.lastChangeAt ? -1 : 0)),
      needs: all.flatMap((state) => state.needs).sort((a, b) => (since(a) < since(b) ? -1 : since(a) > since(b) ? 1 : 0)),
      plan: all.flatMap((state) => state.plan),
      feed: newestFirst(all.flatMap((state) => state.feed)).slice(0, FEED_LIMIT),
      latestMedia: newestFirst(all.flatMap((state) => state.latestMedia ?? []))[0] ?? null,
      sources: all.flatMap((state) => state.sources),
      home: own?.health ?? { ok: true },
      stores: heard.map(({ store, state }) => ({ id: store.id, label: store.label, health: state.health })),
    };
  }

  /** The store a work's id names: another store when the id leads with its id, else this machine's own. */
  private of(work: string): WorkStore {
    return this.others.find((store) => work.startsWith(store.id + FROM)) ?? this.own;
  }

  detail(work: WorkId): WorkDetail | null | Promise<WorkDetail | null> {
    return this.of(work).detail(work);
  }

  async media(): Promise<Media[]> {
    const lists = await Promise.all([this.own, ...this.others].map((store) => store.media()));
    return newestFirst(lists.flat());
  }

  /**
   * A file a work shows, from the store its work's id names, served under the hub's own rules whichever
   * store it came from. An agent wrote these files, so none of them, opened on its own (an SVG, an HTML
   * page), runs script as the hub. `kept` says the address named one version of the file: the browser
   * may keep that for good, so a reload shows it at once. A file that could not be given is never kept.
   */
  async file(path: string, kept: boolean): Promise<Response> {
    const response = await this.of(path).file(path);
    response.headers.set("Cache-Control", kept && response.ok ? "private, max-age=31536000, immutable" : "no-cache");
    response.headers.set("Content-Security-Policy", /\.html?$/i.test(path) ? "sandbox allow-scripts" : "sandbox");
    response.headers.set("X-Content-Type-Options", "nosniff");
    return response;
  }
}
