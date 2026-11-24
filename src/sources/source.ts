import type { PullRequestSighting } from "../core/journal.ts";
import type { Agent, Instant, SessionRef, Stall } from "../core/types.ts";

/**
 * A harness or orchestrator that runs agents: the port every one of them is read through.
 * The hub knows only this. What a harness calls its sessions, how it stores them and what states it
 * has stay inside its adapter, which translates them into the hub's words.
 *
 * Inside an adapter a session is known by the harness's own id. Outside it, by a `SessionRef`:
 * `<source id>:<the harness's id>`, so one work can have sessions from several harnesses.
 */
export interface AgentSource {
  /** Short and stable: it is written into every reference to one of this harness's sessions. */
  readonly id: string;
  /** The harness's name as the user knows it, for a line such as "Can't read T3". */
  readonly label: string;
  /** The session this process runs in, when the harness started it: the harness's own id. */
  detect(env: Record<string, string | undefined>): string | null;
  /** What the harness knows about these sessions, by its own ids. Throws a SourceError with a plain reason when it can't be read. */
  read(sessions: readonly string[]): SourceRead;
  /** Where the user opens a session to read it and answer it. Null when the harness has no such link. */
  link(session: string): string | null;
}

/** One read of a harness. Every part may be empty: a harness says what it knows, and the hub shows no more than that. */
export interface SourceRead {
  /** The root of each asked-for session the harness knows: the session the user started, above any agent it spawned. */
  readonly roots: ReadonlyMap<SessionRef, SessionRef>;
  /** Every session under each root, the root included. */
  readonly agents: ReadonlyMap<SessionRef, readonly Agent[]>;
  readonly pullRequests: ReadonlyMap<SessionRef, readonly PullRequestSighting[]>;
  /** The user's last message in any session under each root. */
  readonly lastUserMessageAt: ReadonlyMap<SessionRef, Instant>;
  readonly projects: ReadonlyMap<SessionRef, string>;
  /** The roots the user has marked as over in the harness. */
  readonly settled: ReadonlySet<SessionRef>;
  /** Every agent stopped until the user answers, from any session the harness knows. */
  readonly stalls: readonly StalledAgent[];
}

export interface StalledAgent {
  readonly root: SessionRef;
  readonly agentTitle: string;
  readonly stall: Stall;
}

export class SourceError extends Error {}

export const NOTHING: SourceRead = { roots: new Map(), agents: new Map(), pullRequests: new Map(), lastUserMessageAt: new Map(), projects: new Map(), settled: new Set(), stalls: [] };

export const refOf = (source: string, session: string) => `${source}:${session}` as SessionRef;

/** A reference's source and the harness's own id. A harness's id may itself hold colons, so only the first one parts them. */
export function partsOf(ref: SessionRef): { readonly source: string; readonly session: string } {
  const at = ref.indexOf(":");
  return { source: ref.slice(0, at), session: ref.slice(at + 1) };
}

/**
 * Reads a harness for the sessions among `refs` that are its own, and gives the answer with every session
 * as a reference. This is the one way the hub reads a source, so nothing outside an adapter sees a bare id.
 */
export function readFrom(source: AgentSource, refs: Iterable<SessionRef>): SourceRead {
  const mine = [...refs].map(partsOf).filter((part) => part.source === source.id);
  return namespaced(source.id, source.read(mine.map((part) => part.session)));
}

function namespaced(source: string, read: SourceRead): SourceRead {
  const ref = (session: SessionRef) => refOf(source, session);
  const keyed = <V>(map: ReadonlyMap<SessionRef, V>, value: (v: V) => V = (v) => v) => new Map([...map].map(([key, v]) => [ref(key), value(v)]));
  return {
    roots: keyed(read.roots, ref),
    agents: keyed(read.agents, (agents) => agents.map((agent) => ({ ...agent, thread: ref(agent.thread) }))),
    pullRequests: keyed(read.pullRequests),
    lastUserMessageAt: keyed(read.lastUserMessageAt),
    projects: keyed(read.projects),
    settled: new Set([...read.settled].map(ref)),
    stalls: read.stalls.map((stalled) => ({ ...stalled, root: ref(stalled.root), stall: { ...stalled.stall, thread: ref(stalled.stall.thread) } })),
  };
}

/** Several harnesses' reads as one. Their references never collide, since each starts with its source. */
export function merged(reads: readonly SourceRead[]): SourceRead {
  const all = <K, V>(pick: (read: SourceRead) => ReadonlyMap<K, V>) => new Map(reads.flatMap((read) => [...pick(read)]));
  return {
    roots: all((r) => r.roots),
    agents: all((r) => r.agents),
    pullRequests: all((r) => r.pullRequests),
    lastUserMessageAt: all((r) => r.lastUserMessageAt),
    projects: all((r) => r.projects),
    settled: new Set(reads.flatMap((read) => [...read.settled])),
    stalls: reads.flatMap((read) => read.stalls),
  };
}
