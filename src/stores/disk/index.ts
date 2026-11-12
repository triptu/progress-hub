import { realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, normalize, relative, sep } from "node:path";
import { instant, replay } from "../../core/journal.ts";
import { BARE_GITHUB_LINK, githubRefs, refLabel, shortRefs, type GitHubRef } from "../../core/refs.ts";
import { localPath, SECTION_LABEL } from "../../core/parse.ts";
import { firstParagraph, firstSentence, goalLine } from "../../core/text.ts";
import type { Commit, FeedEntry, Html, Instant, JournalEvent, Media, NeedEntry, OpenLink, PlanEntry, PullRequest, RenderedItem, RenderedSection, SessionRef, TryLink, WorkBody, WorkDetail, WorkId, WorkSummary } from "../../core/types.ts";
import { agentSources } from "../../sources/index.ts";
import type { AgentSource } from "../../sources/source.ts";
import { FEED_LIMIT, type StoreState, type WorkStore } from "../store.ts";
import { Agents } from "./agents.ts";
import { GitHub, runGh, type Runner } from "./github.ts";
import { Pages, renderItem, type Work } from "./pages.ts";
import { Probes } from "./probe.ts";
import { fileUrl } from "./render.ts";

/**
 * This machine's works: the progress home on disk, with what the agent harnesses and GitHub say about each.
 * It is the default store, and needs nothing but a folder. `Pages` reads the home and `Agents` the
 * harnesses; this class builds the answers from the two. The only thing written is each work's .history.jsonl.
 */
export class DiskStore implements WorkStore {
  /** Lets a caller tell whether anything changed since it last looked. */
  version = 0;

  private readonly home: string;
  private readonly pages: Pages;
  private readonly agents: Agents;
  private readonly github: GitHub;
  private readonly probes: Probes;

  constructor(home: string, sources: readonly AgentSource[] = agentSources(), gh: Runner = runGh) {
    const changed = () => this.version++;
    this.home = home;
    this.pages = new Pages(home, changed);
    this.agents = new Agents(sources, changed);
    this.github = new GitHub(gh, changed);
    this.probes = new Probes(changed);
  }

  /** Reads the pages that changed and the agent harnesses, then journals what both show that the journals lack. */
  refresh(now = new Date()): void {
    this.pages.scan(now);
    this.agents.read(this.pages.sessions(), now);
    for (const work of this.pages.all()) this.pages.record(work, this.agents.sightings(work.threads));
    this.probes.refresh(this.pages.all().flatMap((work) => work.page.links.map((link) => link.url)));
    this.pages.check(now);
  }

  /** Every work's media, newest first. */
  media(): Media[] {
    return this.pages.media();
  }

  private threadLinkOf(work: Work): string | null {
    const first = work.threads[0];
    return first === undefined ? null : this.agents.linkTo(first);
  }

  private projectOf(work: Work): string | null {
    if (work.page.project !== null) return work.page.project;
    return this.agents.projectOf(work.threads);
  }

  private needItems(work: Work): { id: string; title: string; markdown: string; since: Instant }[] {
    const fallback = instant(work.mtime);
    const seen = replay(work.events);
    return work.page.sections
      .filter((s) => s.kind === "needs")
      .flatMap((s) => s.items)
      .map((item) => ({ ...item, since: seen.items.get(item.id)?.since ?? fallback }));
  }

  private summary(work: Work): WorkSummary {
    const agents = this.agents.agentsOf(work.threads);
    const last = work.events.reduce<JournalEvent | null>((latest, e) => (latest === null || e.at >= latest.at ? e : latest), null);
    const { page } = work;
    const working = agents.filter((a) => a.status === "working" || a.status === "waiting").length;
    const roots = this.agents.rootsOf(work.threads);
    const prs = this.pullRequestsOf(work);
    return {
      id: work.folder.id,
      title: page.title,
      project: this.projectOf(work),
      machine: null,
      settled: page.done || (working === 0 && roots.length > 0 && roots.every((root) => this.agents.isSettled(root))),
      lastChangeAt: last !== null && last.at > instant(work.mtime) ? last.at : instant(work.mtime),
      preview: (last && last.kind !== "started" ? preview(last) : "") || firstSentence(page.summary) || firstSentence(page.goal) || "No changes yet",
      summary: firstParagraph(page.summary),
      goal: goalLine(page.goal),
      needsCount: this.needItems(work).length + this.agents.stallsOf(work.threads).length,
      workingAgents: working,
      agents: agents.length,
      pullRequests: { total: prs.length, merged: prs.filter((pr) => pr.state === "merged").length },
      shipped: page.sections.filter((section) => section.kind === "shipped").reduce((sum, section) => sum + section.items.length, 0),
      threadLink: this.threadLinkOf(work),
      links: (page?.links ?? []).map((link) => this.openLink(work, link)),
    };
  }

  /** A try link as the hub can open it: a web address as it is, a file in the work's folder through /files, and a file elsewhere by its path. */
  private openLink(work: Work, link: TryLink): OpenLink {
    if (/^https?:\/\//i.test(link.url)) return { ...link, href: link.url, up: this.probes.up(link.url) };
    const path = filePath(link.url, work.folder.dir);
    const inside = path === null ? null : relative(work.folder.dir, path);
    const served = inside !== null && inside !== "" && !inside.startsWith("..") && !isAbsolute(inside) && !inside.split(sep).some((part) => part.startsWith("."));
    return { ...link, href: served && inside !== null ? fileUrl(work.folder.id, inside.split(sep).join("/")) : null, up: path !== null && isFile(path) };
  }

  /**
   * The path of a file a work lists under Try it and keeps outside its folder, when it is an HTML file that is there.
   * This is all the hub will open on the user's machine: never a path the page does not list.
   */
  fileToOpen(id: WorkId, url: string): string | null {
    const work = this.pages.get(id);
    const link = work?.page.links.find((entry) => entry.url === url);
    if (!work || !link || /^https?:\/\//i.test(url)) return null;
    const path = filePath(url, work.folder.dir);
    return path !== null && /\.html?$/i.test(path) && isFile(path) ? path : null;
  }

  /** A file inside a work's folder. Dotfiles and anything whose real path leaves the home are refused. */
  async file(path: string): Promise<Response> {
    const notFound = new Response("Not found", { status: 404 });
    let parts: string[];
    try {
      parts = path.split("/").map(decodeURIComponent);
    } catch {
      return notFound;
    }
    if (parts.length < 2 || parts.some((part) => part === "" || part.startsWith(".") || part.includes(sep) || part.includes("\\"))) return notFound;
    let real: string;
    let realHome: string;
    try {
      real = realpathSync(join(this.home, ...parts));
      realHome = realpathSync(this.home);
    } catch {
      return notFound;
    }
    if (!real.startsWith(realHome + sep)) return new Response("Forbidden", { status: 403 });
    const body = Bun.file(real);
    return (await body.exists()) ? new Response(body) : notFound;
  }

  state(): StoreState {
    const works = this.pages.all();
    const summaries = works.map((w) => this.summary(w)).sort((a, b) => (a.lastChangeAt < b.lastChangeAt ? 1 : a.lastChangeAt > b.lastChangeAt ? -1 : 0));
    const needs: NeedEntry[] = [];
    const attributed = new Set<SessionRef>();
    for (const work of works) {
      const lastUser = this.agents.rootsOf(work.threads)
        .map((root) => this.agents.lastUserMessageAt(root))
        .filter((at): at is Instant => at !== undefined)
        .sort()
        .at(-1);
      for (const item of this.needItems(work)) {
        needs.push({
          source: "page",
          work: work.folder.id,
          workTitle: work.page.title,
          project: this.projectOf(work),
          itemId: item.id,
          title: item.title,
          ...renderItem(item.markdown, work.folder.id, work.folder.dir),
          since: item.since,
          repliedSince: lastUser !== undefined && lastUser > item.since,
          threadLink: this.threadLinkOf(work),
        });
      }
      for (const root of this.agents.rootsOf(work.threads)) attributed.add(root);
    }
    for (const stalled of this.agents.stalls) {
      const work = attributed.has(stalled.root) ? works.find((w) => this.agents.rootsOf(w.threads).includes(stalled.root)) : undefined;
      needs.push({
        source: "stall",
        work: work?.folder.id ?? null,
        workTitle: work?.page.title ?? null,
        project: work ? this.projectOf(work) : this.agents.projectOfRoot(stalled.root),
        agentTitle: stalled.agentTitle,
        stall: stalled.stall,
        threadLink: this.agents.linkTo(stalled.stall.thread),
      });
    }
    needs.sort((a, b) => (sinceOf(a) < sinceOf(b) ? -1 : sinceOf(a) > sinceOf(b) ? 1 : 0));

    // In the order the works are listed, so a work's items stay together.
    const plan: PlanEntry[] = summaries.flatMap((summary) => {
      const work = this.pages.get(summary.id);
      if (!work) return [];
      const from = { work: summary.id, workTitle: summary.title, project: summary.project };
      const items = work.body.sections.flatMap((section) => (section.kind === "doing" || section.kind === "next" ? section.items.map((item) => ({ ...from, state: section.kind as "doing" | "next", item: this.withRefs(work, item), pr: null })) : []));
      // A pull request still open is in progress whether or not the page says so. One an item names is left to that item.
      const named = new Set(items.flatMap((entry) => entry.item.prs.map((pr) => pr.url)));
      const open = this.pullRequestsOf(work).filter((pr) => (pr.state === "open" || pr.state === "draft") && !named.has(pr.url));
      return [...items, ...open.map((pr) => ({ ...from, state: "doing" as const, item: null, pr }))];
    });

    const feed: FeedEntry[] = works
      .flatMap((work) => work.events.map((event) => ({ work, event })))
      .sort(newestEventFirst)
      .slice(0, FEED_LIMIT)
      .map(({ work, event }) => this.feedEntry(work, event));

    return { works: summaries, needs, plan, feed, latestMedia: this.pages.media()[0] ?? null, sources: this.agents.health(), health: this.pages.health };
  }

  private feedEntry(work: Work, event: JournalEvent): FeedEntry {
    const item = event.kind === "added" || event.kind === "removed" ? renderItem(event.item.markdown, work.folder.id, work.folder.dir) : null;
    const refs: Refs = event.kind === "added" && event.section === "shipped" ? this.refs(event.item.markdown, work) : { prs: [], commits: [] };
    return {
      at: event.at,
      work: work.folder.id,
      workTitle: work.page.title,
      project: this.projectOf(work),
      event,
      titleHtml: item ? shortenRefs(item.titleHtml, refs) : null,
      html: item && event.kind === "added" && event.section === "needs" ? item.html : null,
      ...refs,
      important: item?.important ?? false,
    };
  }

  /** An item with the pull requests and commits it links, and their links shortened to numbers. */
  private withRefs(work: Work, item: RenderedItem): RenderedItem {
    const refs = this.refs(item.titleHtml + item.html, work);
    return { ...item, titleHtml: shortenRefs(item.titleHtml, refs), html: shortenRefs(item.html, refs), ...refs };
  }

  detail(id: WorkId): WorkDetail | null {
    const work = this.pages.get(id);
    if (!work) return null;
    const body: WorkBody = { ...work.body, sections: work.body.sections.map((section) => (REFS_IN.includes(section.kind) ? { ...section, items: section.items.map((item) => this.withRefs(work, item)) } : section)) };
    const { notes } = work.page;
    const skipped = work.skipped === 0 ? [] : [work.skipped === 1 ? "1 line of .history.jsonl could not be read and was skipped." : `${work.skipped} lines of .history.jsonl could not be read and were skipped.`];
    const feed = work.events
      .map((event) => ({ event }))
      .sort(newestEventFirst)
      .map(({ event }) => this.feedEntry(work, event));
    return { summary: this.summary(work), body, agents: this.agents.agentsOf(work.threads), pullRequests: this.pullRequestsOf(work), feed, notes: [...notes, ...skipped] };
  }

  private pullRequestsOf(work: Work): PullRequest[] {
    return this.agents.sightings(work.threads).map((s) => s.pr);
  }

  /** The pull requests and commits some Markdown or HTML links, in order: from a harness when it has them linked to the work, else from GitHub. */
  private refs(text: string, work: Work): Refs {
    const linked = new Map(this.pullRequestsOf(work).map((pr) => [prKey(pr.repo, pr.number), pr]));
    const prs = new Map<string, PullRequest>();
    const commits = new Map<string, Commit>();
    for (const ref of githubRefs(text)) {
      if (ref.kind === "pr") {
        const key = prKey(ref.repo, ref.number);
        const pr = linked.get(key) ?? this.github.pullRequest(ref.repo, ref.number);
        if (pr) prs.set(key, pr);
      } else {
        // A commit shows as soon as its line does. Its subject follows when GitHub has answered.
        const commit = this.github.commit(ref.repo, ref.sha) ?? { url: ref.url, repo: ref.repo, sha: ref.sha, subject: "" };
        commits.set(commit.sha, commit);
      }
    }
    return { prs: [...prs.values()], commits: [...commits.values()] };
  }
}

/** The file a try link names, as a path from the root. `~` is the home folder, and a relative path starts at the work's folder. */
function filePath(url: string, dir: string): string | null {
  const path = localPath(url);
  if (path === null || path === "") return null;
  return normalize(path.startsWith("~/") ? join(homedir(), path.slice(2)) : isAbsolute(path) ? path : join(dir, path));
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** The sections whose items name pull requests and commits worth showing as chips. */
const REFS_IN: readonly (RenderedSection["kind"])[] = ["shipped", "doing", "next"];

function newestEventFirst(a: { readonly event: JournalEvent }, b: { readonly event: JournalEvent }): number {
  return a.event.at < b.event.at ? 1 : a.event.at > b.event.at ? -1 : 0;
}

function sinceOf(entry: NeedEntry): Instant {
  return entry.source === "page" ? entry.since : entry.stall.since;
}

function preview(event: Exclude<JournalEvent, { kind: "started" }>): string {
  switch (event.kind) {
    case "added":
      return `${SECTION_LABEL[event.section]}: ${shortRefs(event.item.title).replace(/^(#\d+|[0-9a-f]{7})[\s:,.]+(?=\p{Lu})/u, "")}`;
    case "removed":
      return `Removed from ${SECTION_LABEL[event.section]}: ${shortRefs(event.item.title)}`;
    case "done":
      return "Marked done";
    case "reopened":
      return "Reopened";
    case "pr":
      return `Pull request ${event.change}: ${event.pr.title}`;
    case "summary":
      return firstSentence(event.text);
  }
}

interface Refs {
  readonly prs: readonly PullRequest[];
  readonly commits: readonly Commit[];
}

function prKey(repo: string, number: number): string {
  return `${repo.toLowerCase()}#${number}`;
}

/** A bare link written as its URL reads as the pull request's number or the commit's short hash, once the hub knows it. */
function shortenRefs(html: Html, refs: Refs): Html {
  if (refs.prs.length === 0 && refs.commits.length === 0) return html;
  const known = (ref: GitHubRef) =>
    ref.kind === "pr" ? refs.prs.some((p) => prKey(p.repo, p.number) === prKey(ref.repo, ref.number)) : refs.commits.some((c) => c.sha.startsWith(ref.sha));
  const linked = html.replace(BARE_GITHUB_LINK, (url) => `<a href="${url}">${url}</a>`);
  return linked.replace(/<a href="([^"]+)">\1<\/a>/g, (whole, url: string) => {
    const [ref] = githubRefs(url);
    return ref && url.startsWith(ref.url) && known(ref) ? `<a href="${url}">${refLabel(ref)}</a>` : whole;
  }) as Html;
}
