/**
 * The shapes everything else is built on.
 *
 * Three layers:
 *   Page      what a progress.md says, parsed. No times, nothing derived.
 *   Journal   what the hub saw change, appended to <work>/.history.jsonl. The only source of times. `progress reword`
 *             adds the one thing the hub can't see: that a line with new words is the line it was.
 *   Hub API   what the server sends the browser: pages joined with the journal and with what the harnesses know.
 */

/** A piece of work. The id is its folder name in the progress home. */
export type WorkId = string & { readonly __work: never };
/**
 * One agent session in some harness: `<source>:<the harness's own id>`, such as `t3:8f2c…`.
 * Inside a harness's adapter the same type holds the harness's own id, with no source in front.
 */
export type SessionRef = string & { readonly __thread: never };
/** An ISO 8601 UTC timestamp. Always produced by code, never read from a page. */
export type Instant = string & { readonly __instant: never };
/** Sanitised on the client before it is put in the document. */
export type Html = string & { readonly __html: never };

// ---------------------------------------------------------------- Page

/** The three sections the hub understands. Every other section is freeform. */
/** The sections the hub reads as lists. "doing" is what is in progress and "next" is what is planned. */
export type SectionKind = "needs" | "doing" | "next" | "decisions" | "shipped";

export interface Item {
  /** `<section>/<title>`, with `/2`, `/3` on exact repeats of a title in one section. Stable while the title is. */
  readonly id: string;
  /** Plain text of the `###` heading, or of the bullet's first line. */
  readonly title: string;
  /** Source of the whole item, heading or bullet marker included. */
  readonly markdown: string;
}

export interface Section {
  /** The heading as written. */
  readonly heading: string;
  readonly kind: SectionKind | null;
  /** Source under the heading. For a known section, only the text above the first item. */
  readonly markdown: string;
  /** Always empty for a freeform section. */
  readonly items: readonly Item[];
}

/** Where the user can open what a work is building: a dev server, a preview deploy, or for an app with no server, its HTML file. */
export interface TryLink {
  /** What the page calls it. Empty when the page gave only the address. */
  readonly label: string;
  /** A web address, or a file as the page wrote it: a path, or a `file://` address. */
  readonly url: string;
}

/** A try link as the hub can open it. */
export interface OpenLink extends TryLink {
  /** Where the browser goes: the web address, or the hub's own address for a file in the work's folder. Null for a file elsewhere on this machine, which only the hub can open, on that machine. */
  readonly href: string | null;
  /** Whether an address on this machine answers, or a file is there. Null for an address elsewhere, or one not tried yet. */
  readonly up: boolean | null;
}

export interface Page {
  readonly title: string;
  readonly project: string | null;
  readonly done: boolean;
  /** Source between the front matter and the first heading, without a "Goal:" paragraph. */
  readonly summary: string;
  /** What the work is for: the Goal section, or the summary's paragraph that starts "Goal:". Empty when the page has neither. */
  readonly goal: string;
  /** Where to open what is being built: the links of the "Try it" section, and the front matter's `try`. */
  readonly links: readonly TryLink[];
  /** Every section but Goal. */
  readonly sections: readonly Section[];
  /** What `progress check` prints. Parsing never fails; it leaves notes. */
  readonly notes: readonly string[];
}

// ---------------------------------------------------------------- Journal

/**
 * The parts of a page the hub reads no items from, each by its heading with a mark that changes when its
 * text does: the goal, every freeform section, and what a list section says above its items.
 */
export type Parts = Readonly<Record<string, string>>;

/**
 * One observed change. The hub compares each new version of a page with the last one it saw,
 * so these say what was seen, not what was meant: an item that left the page was "removed",
 * whether it was settled or deleted by mistake.
 */
export type JournalEvent =
  /**
   * The first time the hub saw the page. Carries the items and summary already on it, so they get a time without
   * flooding the feed. The summary is null in journals written before the hub recorded it.
   */
  | { readonly at: Instant; readonly kind: "started"; readonly items: readonly { readonly section: SectionKind; readonly item: Item }[]; readonly summary: string | null; readonly parts?: Parts }
  /**
   * The page as it stood when a hub that follows edits first read it: every item's text and every part's mark,
   * recorded without saying anything. It is written once, to a journal an earlier hub began.
   */
  | { readonly at: Instant; readonly kind: "noted"; readonly items: readonly { readonly section: SectionKind; readonly item: Item }[]; readonly parts: Parts }
  /** The summary was rewritten: the agent's status update. Carries the new summary as written. */
  | { readonly at: Instant; readonly kind: "summary"; readonly text: string }
  | { readonly at: Instant; readonly kind: "added"; readonly section: SectionKind; readonly item: Item }
  | { readonly at: Instant; readonly kind: "removed"; readonly section: SectionKind; readonly item: Item }
  /**
   * An item's text changed. Carries the item as it is now. `from` is the id it had before, when its first line
   * was reworded: the same item under a new name, which keeps its time and the user's marks.
   */
  | { readonly at: Instant; readonly kind: "edited"; readonly section: SectionKind; readonly item: Item; readonly from?: string }
  /** A Shipped item its page had as not live, or said nothing of, is now marked live. Carries the item as it is now. */
  | { readonly at: Instant; readonly kind: "live"; readonly item: Item }
  /** A part of the page the hub reads no items from was written, rewritten or taken away: the goal, or a section such as Ideas. */
  | { readonly at: Instant; readonly kind: "part"; readonly heading: string; readonly change: "added" | "edited" | "removed"; readonly mark: string }
  | { readonly at: Instant; readonly kind: "done" }
  | { readonly at: Instant; readonly kind: "reopened" }
  | { readonly at: Instant; readonly kind: "pr"; readonly change: "opened" | "merged" | "closed"; readonly pr: PullRequest };

// ---------------------------------------------------------------- From the harnesses

export type PullRequestState = "draft" | "open" | "merged" | "closed";

export interface PullRequest {
  readonly url: string;
  /** owner/name */
  readonly repo: string;
  readonly number: number;
  readonly title: string;
  readonly state: PullRequestState;
  readonly openedAt: Instant | null;
  readonly mergedAt: Instant | null;
}

/** A commit a page links to, as GitHub has it. */
export interface Commit {
  readonly url: string;
  /** owner/name */
  readonly repo: string;
  readonly sha: string;
  /** The first line of its message. */
  readonly subject: string;
}

/** preparing, queued, starting and running are "working". interrupted, cancelled and rolled_back are "stopped". */
export type AgentStatus = "working" | "waiting" | "finished" | "failed" | "stopped" | "idle";

export interface Agent {
  readonly thread: SessionRef;
  readonly title: string;
  readonly model: string | null;
  /** The provider account, such as "Claude 4". */
  readonly account: string | null;
  readonly branch: string | null;
  readonly worktree: string | null;
  readonly status: AgentStatus;
  readonly startedAt: Instant;
  readonly lastActivityAt: Instant;
  /** Opens the session in its harness. */
  readonly link: string;
}

/** An agent that cannot continue until the user acts in its thread. */
export interface Stall {
  readonly thread: SessionRef;
  readonly ask: "question" | "approval";
  /** The question, or the command or action awaiting approval. Null when the harness stored none. */
  readonly text: string | null;
  readonly since: Instant;
}

/** Something the hub reads could not be read. The hub keeps showing the last good data and says so. */
export type Health =
  | { readonly ok: true }
  | { readonly ok: false; readonly since: Instant; readonly reason: string };

// ---------------------------------------------------------------- Hub API

export interface WorkSummary {
  readonly id: WorkId;
  readonly title: string;
  readonly project: string | null;
  /** The machine the work lives on, by name, when it is not the one this hub runs on. */
  readonly machine: string | null;
  /** Over: the page says done, or every one of its sessions is settled in its harness. */
  readonly settled: boolean;
  /** When the latest thing the feed tells of this work happened. The file's change time on a page with no journal yet. */
  readonly lastChangeAt: Instant;
  /** One line: the latest thing that happened. */
  readonly preview: string;
  /** Where the work stands: the text above the page's first heading, without its images. */
  readonly summary: string;
  /** What the work is for, as one line of plain text. Empty when the page gives no goal. */
  readonly goal: string;
  readonly needsCount: number;
  readonly workingAgents: number;
  /** Every agent the work has started, finished ones included. */
  readonly agents: number;
  readonly pullRequests: { readonly total: number; readonly merged: number };
  /** How much it has planned, has under way and has shipped: lines of its page, and pull requests no line names. A hub of an earlier build sends only the last. */
  readonly next?: number;
  readonly doing?: number;
  readonly shipped: number;
  /** Opens the owning session in its harness. Null when the work has none. */
  readonly threadLink: string | null;
  /** Where to open what the work is building. */
  readonly links: readonly OpenLink[];
}

export type NeedEntry =
  | {
      readonly source: "page";
      readonly work: WorkId;
      readonly workTitle: string;
      readonly project: string | null;
      readonly itemId: string;
      readonly title: string;
      /** The title line, rendered inline. */
      readonly titleHtml: Html;
      /** The item without its title line. */
      readonly html: Html;
      readonly important: boolean;
      readonly since: Instant;
      /** The user has written in one of the work's threads since this item appeared. It may be settled. */
      readonly repliedSince: boolean;
      readonly threadLink: string | null;
    }
  | {
      readonly source: "stall";
      /** Null when the stalled agent belongs to no work with a page. */
      readonly work: WorkId | null;
      readonly workTitle: string | null;
      readonly project: string | null;
      readonly agentTitle: string;
      readonly stall: Stall;
      /** Null when the harness has no link to its sessions. */
      readonly threadLink: string | null;
    };

export interface FeedEntry {
  readonly at: Instant;
  readonly work: WorkId;
  readonly workTitle: string;
  readonly project: string | null;
  readonly event: JournalEvent;
  /** The item's title line as inline HTML, the same as on the work's page. Null for events that are not about an item. */
  readonly titleHtml: Html | null;
  /** The item's body without its title line, for "added" events in Needs you. */
  readonly html: Html | null;
  /** The pull requests an added Shipped item names, in the order it names them. */
  readonly prs: readonly PullRequest[];
  /** The same for the commits it links. */
  readonly commits: readonly Commit[];
  /** The page marked this item as one the user should not miss. False for events that are not about an item. */
  readonly important: boolean;
}

/**
 * What the user can mark in the hub. "viewed" holds what shipped that they have looked at: `<work>/<item id>`
 * for a Shipped line, or a pull request's address when it merged with no line about it (`prKey`). "dismissed" holds Needs you items they waved away.
 */
export type MarkKind = "viewed" | "dismissed";
export type Marks = Readonly<Record<MarkKind, readonly string[]>>;

/**
 * Something the user means to do later, kept by the hub. It may name the work or the project it is about.
 */
export interface Todo {
  readonly id: string;
  readonly text: string;
  /** More about it, in as many lines as it takes. Empty when there is none. */
  readonly description: string;
  readonly work: WorkId | null;
  readonly project: string | null;
  readonly addedAt: Instant;
  /** When it was ticked off. Null while it is still to do. */
  readonly doneAt: Instant | null;
}

/** What the page or the command line asks of the list: a new todo, one ticked or unticked, or one taken away. */
export type TodoChange =
  | { readonly op: "add"; readonly text: string; readonly description: string; readonly work: WorkId | null; readonly project: string | null }
  | { readonly op: "edit"; readonly id: string; readonly text: string; readonly description: string; readonly work: WorkId | null; readonly project: string | null }
  | { readonly op: "done"; readonly id: string; readonly on: boolean }
  | { readonly op: "remove"; readonly id: string }
  /** Puts back a todo that was removed, as it was. */
  | { readonly op: "restore"; readonly todo: Todo };

/**
 * One thing a work has planned, has in progress or has shipped: an item of its page's Next, In progress or
 * Shipped section, or a pull request no item names, in progress while it is open and shipped once it merged.
 */
export type PlanEntry = {
  readonly work: WorkId;
  readonly workTitle: string;
  readonly project: string | null;
  readonly state: "next" | "doing" | "shipped";
} & ({ readonly item: RenderedItem; readonly pr: null } | { readonly item: null; readonly pr: PullRequest });

export interface HubState {
  /** Newest change first. */
  readonly works: readonly WorkSummary[];
  /** Oldest first. */
  readonly needs: readonly NeedEntry[];
  /** What each work has in progress and planned, works in the order above and items in the order their page lists them. */
  readonly plan: readonly PlanEntry[];
  /** What each work shipped lately, in the same order. A work's own page holds everything it ever shipped. */
  readonly shipped: readonly PlanEntry[];
  /** Newest first, capped. */
  readonly feed: readonly FeedEntry[];
  /** The newest of all media, for the sidebar. The whole list is served on its own, at /api/media. */
  readonly latestMedia: Media | null;
  /** The progress home, its pages and their .history.jsonl files. */
  readonly home: Health;
  /** The stores beside the hub's own: on the central hub, each machine that sends to it, and whether it has been heard from lately. */
  readonly stores: readonly { readonly id: string; readonly label: string; readonly health: Health }[];
  /** Each harness the hub reads agents from, and whether it can be read. */
  readonly sources: readonly { readonly id: string; readonly label: string; readonly health: Health }[];
  /** The machine this hub runs on, when it keeps works of its own: its name, and the central hub it sends them to when it is linked to one, with whether the last send went through. */
  readonly machine?: { readonly label: string; readonly central: { readonly url: string; readonly health: Health } | null };
  readonly marks: Marks;
  /** The user's own list, newest first. */
  readonly todos: readonly Todo[];
  /** True when this hub is behind a sign-in: the app offers a way to sign out, and keeps none of its answers in the tab's storage. */
  readonly signedIn?: boolean;
}

/** An image, a video, or an HTML page (a built option or a mock) that a work's page shows. */
export interface Media {
  readonly work: WorkId;
  /** A "page" is an HTML file, and a "file" is any other document the page links: a PDF, a report, a data file. */
  readonly kind: "image" | "video" | "page" | "file";
  /** Where the browser loads it: under /files/<work>/, the same URL the work's page uses. */
  readonly src: string;
  /** The alt text as written. Empty when there is none. */
  readonly caption: string;
  /** The file's modification time. */
  readonly at: Instant;
}

/** What a Shipped item's page says about it being where the user would try it: deployed, released, installed. */
export interface Live {
  readonly on: boolean;
  /** The page's words after the mark: where it is live, or what it waits on. Empty when it gave none. */
  readonly note: Html;
  /** When the hub saw it go live. Null while it is not, and for one that was live when the hub first read it with no time to give. */
  readonly at: Instant | null;
}

export interface RenderedItem {
  readonly id: string;
  readonly title: string;
  /** The title line, rendered inline. */
  readonly titleHtml: Html;
  /** The item without its title line. */
  readonly html: Html;
  /** The page marked it as one the user should not miss. */
  readonly important: boolean;
  /** When the hub first saw it. Null on a page the hub has not journalled yet. */
  readonly since: Instant | null;
  /** When the text under its title last changed after that. Null when it reads as it first did. */
  readonly editedAt: Instant | null;
  /** Whether the user can try what a Shipped item describes, as its page says. Null when the page does not say, or the item has not shipped. */
  readonly live: Live | null;
  /** The pull requests a Shipped item names, in the order it names them. Only those the hub has details for. */
  readonly prs: readonly PullRequest[];
  /** The same for the commits it links. */
  readonly commits: readonly Commit[];
}

export interface RenderedSection {
  readonly heading: string;
  readonly kind: SectionKind | null;
  readonly html: Html;
  /** When the hub saw the section's own text written or rewritten: all of a freeform section, and what a list section says above its items. Null when it has not changed since the hub first read it. */
  readonly changedAt: Instant | null;
  readonly items: readonly RenderedItem[];
}

export interface WorkBody {
  readonly goal: Html;
  readonly summary: Html;
  /** Every section but Goal. A work's Home draws Decisions and the ones the hub reads no items from, and its plan is made from the rest. */
  readonly sections: readonly RenderedSection[];
}

export interface WorkDetail {
  readonly summary: WorkSummary;
  readonly body: WorkBody;
  readonly agents: readonly Agent[];
  /** Every pull request a harness links to the work's sessions. */
  readonly pullRequests: readonly PullRequest[];
  /** Everything the hub saw happen to this work, newest first. */
  readonly feed: readonly FeedEntry[];
  readonly notes: readonly string[];
}
