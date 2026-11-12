import { instant, type PullRequestSighting } from "../../core/journal.ts";
import { reason } from "../../core/text.ts";
import type { Agent, Health, Instant, SessionRef } from "../../core/types.ts";
import { merged, NOTHING, partsOf, readFrom, type AgentSource, type SourceRead } from "../../sources/source.ts";

/**
 * What the agent harnesses say about the sessions the pages name: each session's root, the agents under
 * it, their pull requests, what is stalled and what is settled. A harness that can't be read keeps its
 * last good read and says why. `changed` is called whenever what is held changes.
 */
export class Agents {
  /** What every agent source last said, as one read, with each session by its reference. */
  private known: SourceRead = NOTHING;
  private readonly reads = new Map<string, SourceRead>();
  private readonly healths = new Map<string, Health>();

  /** The harnesses agents run in. Empty when none is read. */
  private readonly sources: readonly AgentSource[];
  private readonly changed: () => void;

  constructor(sources: readonly AgentSource[], changed: () => void) {
    this.sources = sources;
    this.changed = changed;
  }

  /** Reads each agent source for the sessions the pages name. A source that fails keeps its last good read and says why. */
  read(sessions: ReadonlySet<SessionRef>, now: Date): void {
    for (const source of this.sources) {
      const before = this.healths.get(source.id) ?? { ok: true };
      try {
        const read = readFrom(source, sessions);
        if (JSON.stringify(snapshotOf(read)) !== JSON.stringify(snapshotOf(this.reads.get(source.id) ?? NOTHING)) || !before.ok) this.changed();
        this.reads.set(source.id, read);
        this.healths.set(source.id, { ok: true });
      } catch (error) {
        const why = reason(error);
        if (before.ok || before.reason !== why) {
          this.healths.set(source.id, { ok: false, since: before.ok ? instant(now) : before.since, reason: why });
          this.changed();
        }
      }
    }
    this.known = merged([...this.reads.values()]);
  }

  /** Each harness, and whether it could be read. */
  health(): { readonly id: string; readonly label: string; readonly health: Health }[] {
    return this.sources.map((source) => ({ id: source.id, label: source.label, health: this.healths.get(source.id) ?? { ok: true } }));
  }

  /** Where the user opens a session, as the harness it belongs to says. */
  linkTo(session: SessionRef): string | null {
    const { source, session: id } = partsOf(session);
    return this.sources.find((candidate) => candidate.id === source)?.link(id) ?? null;
  }

  // What they say about one work, given the sessions its page names.

  rootsOf(threads: readonly SessionRef[]): SessionRef[] {
    const roots = new Set<SessionRef>();
    for (const thread of threads) {
      const root = this.known.roots.get(thread);
      if (root) roots.add(root);
    }
    return [...roots];
  }

  agentsOf(threads: readonly SessionRef[]): Agent[] {
    const agents = new Map<SessionRef, Agent>();
    for (const root of this.rootsOf(threads)) for (const agent of this.known.agents.get(root) ?? []) agents.set(agent.thread, agent);
    return [...agents.values()];
  }

  sightings(threads: readonly SessionRef[]): PullRequestSighting[] {
    const prs = new Map<string, PullRequestSighting>();
    for (const root of this.rootsOf(threads)) for (const pr of this.known.pullRequests.get(root) ?? []) prs.set(pr.pr.url, pr);
    return [...prs.values()];
  }

  stallsOf(threads: readonly SessionRef[]): SourceRead["stalls"] {
    const roots = new Set(this.rootsOf(threads));
    return this.known.stalls.filter((s) => roots.has(s.root));
  }

  /** The project a harness says the sessions work in. */
  projectOf(threads: readonly SessionRef[]): string | null {
    for (const root of this.rootsOf(threads)) {
      const project = this.known.projects.get(root);
      if (project) return project;
    }
    return null;
  }

  /** Every stalled agent, on a work or not. */
  get stalls(): SourceRead["stalls"] {
    return this.known.stalls;
  }

  projectOfRoot(root: SessionRef): string | null {
    return this.known.projects.get(root) ?? null;
  }

  isSettled(root: SessionRef): boolean {
    return this.known.settled.has(root);
  }

  lastUserMessageAt(root: SessionRef): Instant | undefined {
    return this.known.lastUserMessageAt.get(root);
  }
}

function snapshotOf(read: SourceRead): unknown {
  return [[...read.roots], [...read.agents], [...read.pullRequests], [...read.lastUserMessageAt], [...read.settled], read.stalls];
}
