import type { Agent, Commit, FeedEntry, Health, Html, Instant, Item, JournalEvent, Live, Media, NeedEntry, OpenLink, PlanEntry, PullRequest, RenderedItem, RenderedSection, SessionRef, Stall, WorkBody, WorkDetail, WorkId, WorkSummary } from "../core/types.ts";
import { count, either, flag, listOf, oneOf, orElse, orNone, orNull, readOrNull, shape, tableOf, text, variant } from "../core/reader.ts";
import { FROM, type StoreState } from "../stores/store.ts";

/*
 * What a machine sends the central hub, checked and made the hub's own: every work's id and every address a
 * browser loads names the machine it came from.
 */

/** A work's id on this hub, given the machine it lives on. */
const idFrom = (machine: Machine, work: string) => `${machine.id}${FROM}${work}` as WorkId;

/** The fields that hold an address, and the ones that hold HTML a page rendered. */
const ADDRESS = new Set(["url", "href", "link", "threadLink", "src"]);
const HTML = new Set(["html", "titleHtml"]);
const FILE_ATTRIBUTES = ["src", "href", "poster"];

/** An address a browser would run instead of open is no address. A harness's own scheme, such as the one that opens a thread, is fine. */
const address = (value: string) => (/^\s*(javascript|data|vbscript):/i.test(value) ? "" : value);

/**
 * What a machine sent, made this hub's own, field by field. A file its pages show is fetched through this hub,
 * since the browser can't reach the machine: `/files/<work>/…` becomes `/files/<id>~<work>/…`.
 */
function adopt<T>(machine: Machine, value: T): Promise<T> {
  return mapAddresses(value, (path) => (path.startsWith("/files/") ? `/files/${machine.id}${FROM}${path.slice("/files/".length)}` : path));
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

// ---------------------------------------------------------------- What a machine may send

/*
 * A machine's hub is another program, perhaps another version of this one, perhaps broken or hostile. What it sends is
 * read as unknown, in one place, into the types the hub and the app read, down to each variant: one entry the app
 * can't draw would stop a whole screen. What is read is built again from what was checked, so nothing else it
 * sent is kept. A send that can't be read is refused, and the hub keeps what it had. A field a hub of an earlier
 * build leaves out is read as what that build meant.
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

/** A state as a machine sends it: its own works, and nothing of its health, which this hub says. */
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

/** The machine that sent a state, as the works it adopts are named: its id leads each work's id, and its label says where a work runs. */
export interface Machine {
  readonly id: string;
  readonly label: string;
}

/** One work's summary from a machine, as this hub lists it. */
function adoptWork(machine: Machine, work: WorkSummary): WorkSummary {
  return {
    ...work,
    id: idFrom(machine, work.id),
    machine: machine.label,
    // A file kept outside the work's folder can only be opened on its own machine, so it is not offered here.
    // A link from another machine is a web address or a file fetched through this hub. Anything else is left out.
    links: work.links.filter((link) => link.href !== null && /^(https?:\/\/|\/files\/)/i.test(link.href)),
  };
}

/** A machine's state as this hub holds it. Throws when it is not a state this hub can read, such as another version's. */
export async function readState(machine: Machine, sent: unknown): Promise<Omit<StoreState, "health">> {
  const read = readOrNull(storeState, sent);
  if (read === null) throw new Error("It sent something this hub can't read. It may run another version.");
  const adopted = await adopt(machine, read);
  return {
    ...adopted,
    works: adopted.works.map((work) => adoptWork(machine, work)),
    // A stalled thread is named with its machine too, so a mark on it is about that machine's thread.
    needs: adopted.needs.map((need) =>
      need.source === "page" ? { ...need, work: idFrom(machine, need.work) } : { ...need, work: need.work === null ? null : idFrom(machine, need.work), stall: { ...need.stall, thread: `${machine.id}${FROM}${need.stall.thread}` as SessionRef } },
    ),
    plan: adopted.plan.map((entry) => ({ ...entry, work: idFrom(machine, entry.work) })),
    shipped: adopted.shipped.map((entry) => ({ ...entry, work: idFrom(machine, entry.work) })),
    feed: adopted.feed.map((entry) => ({ ...entry, work: idFrom(machine, entry.work) })),
    latestMedia: adopted.latestMedia ? { ...adopted.latestMedia, work: idFrom(machine, adopted.latestMedia.work) } : null,
    // A harness that machine can't read is named with the machine, so the hub never says nothing waits when it can't know.
    sources: adopted.sources.map((source) => ({ ...source, id: `${machine.id}${FROM}${source.id}`, label: `${source.label} on ${machine.label}` })),
  };
}

/** One work's page from a machine, as this hub holds it. Null when it is not a page this hub can read. */
export async function readDetail(machine: Machine, sent: unknown): Promise<WorkDetail | null> {
  const read = readOrNull(workDetail, sent);
  if (read === null) return null;
  const adopted = await adopt(machine, read);
  const here = <T extends { readonly work: WorkId }>(entry: T): T => ({ ...entry, work: idFrom(machine, entry.work) });
  return { ...adopted, summary: adoptWork(machine, adopted.summary), feed: adopted.feed.map(here) };
}

/** A machine's media, each under its work's id on this hub. Null when it is not a list this hub can read. */
export async function readMedia(machine: Machine, sent: unknown): Promise<Media[] | null> {
  const read = readOrNull(listOf(media), sent);
  return read === null ? null : (await adopt(machine, read)).map((item) => ({ ...item, work: idFrom(machine, item.work) }));
}
