import { Database } from "bun:sqlite";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { PullRequestSighting } from "../core/journal.ts";
import { SourceError, type SourceRead, type StalledAgent } from "../sources/source.ts";
import type { Agent, AgentStatus, Instant, PullRequestState, SessionRef } from "../core/types.ts";

/** Where T3 keeps the files this reads. Only ever opened for reading. */
export interface T3Files {
  readonly db: string;
  readonly settings: string;
  readonly environmentId: string;
}

/**
 * `$PROGRESS_T3_DB` replaces the database path, and `off` means don't read T3 at all. Null too on a machine
 * T3 has never run on: it has no T3 folder and this is not one of T3's threads, so there is nothing to read
 * and nothing wrong.
 */
export function t3Files(home = homedir(), env: Record<string, string | undefined> = process.env): T3Files | null {
  const db = env.PROGRESS_T3_DB?.trim();
  if (db === "off") return null;
  const dir = join(home, ".t3", "userdata");
  if (!db && !env.T3CODE_THREAD_ID && !existsSync(dir)) return null;
  return { db: db || join(dir, "statev2.sqlite"), settings: join(dir, "settings.json"), environmentId: join(dir, "environment-id") };
}

export class T3Error extends SourceError {}

const T = "orchestration_v2_projection_";
const LIVE = new Set(["preparing", "queued", "starting", "running", "waiting"]);
const STATUS: Record<string, AgentStatus> = {
  preparing: "working",
  queued: "working",
  starting: "working",
  running: "working",
  waiting: "waiting",
  completed: "finished",
  failed: "failed",
  interrupted: "stopped",
  cancelled: "stopped",
  rolled_back: "stopped",
};

/** Opens a thread in the T3 desktop app, which registers `t3code://threads/<environment>/<thread>`. */
export function threadLink(environmentId: string | null, thread: SessionRef): string {
  return environmentId === null ? `t3-thread://v1/${thread}` : `t3code://threads/${encodeURIComponent(environmentId)}/${encodeURIComponent(thread)}`;
}

export function readEnvironmentId(files: T3Files): string | null {
  try {
    return readFileSync(files.environmentId, "utf8").trim() || null;
  } catch {
    return null;
  }
}

/**
 * One short read transaction over T3's database. Indexed lookups, plus one scan of the runtime requests
 * (a few hundred rows), which finds every agent waiting on the user, including one no page names.
 * Throws a T3Error with a plain reason when the database is missing, locked or shaped differently.
 */
export function readT3(threads: readonly SessionRef[], files: T3Files): SourceRead {
  const accounts = readAccounts(files.settings);
  const environmentId = readEnvironmentId(files);
  let db: Database;
  try {
    db = new Database(files.db, { readonly: true, strict: true });
  } catch (error) {
    throw new T3Error(`T3's database could not be opened at ${files.db}: ${message(error)}`);
  }
  try {
    db.exec("PRAGMA query_only=ON; PRAGMA busy_timeout=1000; BEGIN");
    try {
      return new Reader(db, accounts, environmentId).read(threads);
    } finally {
      db.exec("ROLLBACK");
    }
  } catch (error) {
    if (error instanceof T3Error) throw error;
    throw new T3Error(`T3's database could not be read: ${message(error)}`);
  } finally {
    db.close();
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

interface ThreadRow {
  readonly id: SessionRef;
  readonly title: string;
  readonly projectId: string;
  readonly createdAt: Instant;
  readonly updatedAt: Instant;
  readonly deleted: boolean;
  readonly root: SessionRef;
  readonly model: string | null;
  readonly instance: string | null;
  readonly branch: string | null;
  readonly worktree: string | null;
  readonly settled: boolean;
  readonly pullRequests: readonly PullRequestSighting[];
}

interface RunRow {
  readonly status: string;
  readonly model: string | null;
  readonly instance: string | null;
  readonly times: readonly Instant[];
}

class Reader {
  private readonly threadQuery;
  private readonly runQuery;
  private readonly childQuery;
  private readonly userMessageQuery;
  private readonly projectQuery;
  private readonly pendingQuery;
  private readonly cardQuery;
  private readonly threads = new Map<SessionRef, ThreadRow | null>();

  private readonly accounts: ReadonlyMap<string, string>;
  private readonly environmentId: string | null;

  constructor(db: Database, accounts: ReadonlyMap<string, string>, environmentId: string | null) {
    this.accounts = accounts;
    this.environmentId = environmentId;
    this.threadQuery = db.query(`SELECT thread_id, title, project_id, created_at, updated_at, deleted_at, payload_json FROM ${T}threads WHERE thread_id = ?`);
    this.runQuery = db.query(`SELECT status, requested_at, completed_at, payload_json FROM ${T}runs WHERE thread_id = ? ORDER BY ordinal DESC LIMIT 1`);
    this.childQuery = db.query(`SELECT child_thread_id FROM ${T}subagents WHERE thread_id = ? AND child_thread_id IS NOT NULL`);
    this.userMessageQuery = db.query(
      `SELECT updated_at FROM ${T}messages WHERE thread_id = ? AND role = 'user' AND coalesce(json_extract(payload_json, '$.createdBy'), 'user') = 'user' ORDER BY updated_at DESC LIMIT 1`,
    );
    this.projectQuery = db.query("SELECT title FROM projection_projects WHERE project_id = ?");
    this.pendingQuery = db.query(`SELECT runtime_request_id, thread_id, node_id, kind, created_at, payload_json FROM ${T}runtime_requests WHERE status = 'pending'`);
    this.cardQuery = db.query(`SELECT payload_json FROM ${T}turn_items WHERE node_id = ? AND thread_id = ? AND type IN ('approval_request', 'user_input_request')`);
  }

  read(asked: readonly SessionRef[]): SourceRead {
    const roots = new Map<SessionRef, SessionRef>();
    for (const id of asked) {
      const thread = this.thread(id);
      if (thread) roots.set(id, thread.root);
    }
    const agents = new Map<SessionRef, Agent[]>();
    const pullRequests = new Map<SessionRef, PullRequestSighting[]>();
    const lastUserMessageAt = new Map<SessionRef, Instant>();
    const projects = new Map<SessionRef, string>();
    const settled = new Set<SessionRef>();
    for (const root of new Set(roots.values())) {
      const rootRow = this.thread(root);
      if (!rootRow) continue;
      if (rootRow.settled) settled.add(root);
      const project = this.projectQuery.get(rootRow.projectId);
      if (isRow(project) && typeof project.title === "string") projects.set(root, project.title);
      const list: Agent[] = [];
      const prs = new Map<string, PullRequestSighting>();
      let lastUser: Instant | null = null;
      for (const thread of this.descendants(rootRow)) {
        list.push(this.agent(thread));
        for (const pr of thread.pullRequests) prs.set(pr.pr.url, pr);
        const message = this.userMessageQuery.get(thread.id);
        const at = isRow(message) ? instantOrNull(message.updated_at) : null;
        if (at !== null && (lastUser === null || at > lastUser)) lastUser = at;
      }
      agents.set(root, list);
      pullRequests.set(root, [...prs.values()]);
      if (lastUser !== null) lastUserMessageAt.set(root, lastUser);
    }
    return { roots, agents, pullRequests, lastUserMessageAt, projects, settled, stalls: this.stalls() };
  }

  private descendants(root: ThreadRow): ThreadRow[] {
    const found: ThreadRow[] = [];
    const seen = new Set<SessionRef>();
    const queue: ThreadRow[] = [root];
    for (let thread = queue.shift(); thread; thread = queue.shift()) {
      if (seen.has(thread.id)) continue;
      seen.add(thread.id);
      found.push(thread);
      for (const row of this.childQuery.all(thread.id)) {
        const child = isRow(row) && typeof row.child_thread_id === "string" ? this.thread(row.child_thread_id as SessionRef) : null;
        if (child) queue.push(child);
      }
    }
    return found;
  }

  private thread(id: SessionRef): ThreadRow | null {
    const cached = this.threads.get(id);
    if (cached !== undefined) return cached;
    const row = this.threadQuery.get(id);
    const parsed = row === null ? null : parseThread(row);
    this.threads.set(id, parsed && !parsed.deleted ? parsed : null);
    return this.threads.get(id) ?? null;
  }

  private run(id: SessionRef): RunRow | null {
    const row = this.runQuery.get(id);
    if (row === null) return null;
    if (!isRow(row)) throw shape("a run");
    const payload = json(row.payload_json, "a run");
    const selection = isRow(payload.modelSelection) ? payload.modelSelection : {};
    return {
      status: text(row.status, "a run's status"),
      model: optionalText(selection.model),
      instance: optionalText(payload.providerInstanceId),
      times: [row.requested_at, payload.startedAt, row.completed_at].map(instantOrNull).filter((t): t is Instant => t !== null),
    };
  }

  private agent(thread: ThreadRow): Agent {
    const run = this.run(thread.id);
    const instance = run?.instance ?? thread.instance;
    const activity = [thread.updatedAt, ...(run?.times ?? [])].sort();
    return {
      thread: thread.id,
      title: thread.title,
      model: run?.model ?? thread.model,
      account: instance === null ? null : (this.accounts.get(instance) ?? instance),
      branch: thread.branch,
      worktree: thread.worktree,
      status: run === null ? "idle" : (STATUS[run.status] ?? "working"),
      startedAt: thread.createdAt,
      lastActivityAt: activity.at(-1) ?? thread.updatedAt,
      link: threadLink(this.environmentId, thread.id),
    };
  }

  private stalls(): StalledAgent[] {
    const stalls: StalledAgent[] = [];
    for (const row of this.pendingQuery.all()) {
      if (!isRow(row)) throw shape("a runtime request");
      const threadId = text(row.thread_id, "a request's thread") as SessionRef;
      const thread = this.thread(threadId);
      if (!thread) continue;
      const run = this.run(threadId);
      if (!run || !LIVE.has(run.status)) continue;
      const request = json(row.payload_json, "a runtime request");
      const capability = isRow(request.responseCapability) ? request.responseCapability.type : undefined;
      if (capability === "message") continue;
      const requestId = text(row.runtime_request_id, "a request's id");
      const card = this.cardQuery
        .all(text(row.node_id, "a request's node"), threadId)
        .map((r) => (isRow(r) ? json(r.payload_json, "a request card") : {}))
        .find((c) => c.requestId === requestId);
      const ask = row.kind === "user_input" ? "question" : "approval";
      stalls.push({
        root: thread.root,
        agentTitle: thread.title,
        stall: { thread: threadId, ask, text: card ? cardText(card) : null, since: instantOf(row.created_at, "a request's time") },
      });
    }
    return stalls.sort((a, b) => (a.stall.since < b.stall.since ? -1 : a.stall.since > b.stall.since ? 1 : 0));
  }
}

function cardText(card: Record<string, unknown>): string | null {
  if (typeof card.prompt === "string" && card.prompt.trim() !== "") return card.prompt;
  if (!Array.isArray(card.questions)) return null;
  const questions = card.questions.map((q) => (isRow(q) && typeof q.question === "string" ? q.question : null)).filter((q): q is string => q !== null);
  return questions.length > 0 ? questions.join("\n\n") : null;
}

function parseThread(row: unknown): ThreadRow {
  if (!isRow(row)) throw shape("a thread");
  const payload = json(row.payload_json, "a thread");
  const id = text(row.thread_id, "a thread's id") as SessionRef;
  const lineage = isRow(payload.lineage) ? payload.lineage : {};
  const selection = isRow(payload.modelSelection) ? payload.modelSelection : {};
  const prs = Array.isArray(payload.pullRequests) ? payload.pullRequests : [];
  return {
    id,
    title: text(row.title, "a thread's title"),
    projectId: text(row.project_id, "a thread's project"),
    createdAt: instantOf(row.created_at, "a thread's creation time"),
    updatedAt: instantOf(row.updated_at, "a thread's update time"),
    deleted: row.deleted_at !== null,
    root: (optionalText(lineage.rootThreadId) ?? id) as SessionRef,
    model: optionalText(selection.model),
    instance: optionalText(payload.providerInstanceId) ?? optionalText(selection.instanceId),
    branch: optionalText(payload.branch),
    worktree: optionalText(payload.worktreePath),
    settled: instantOrNull(payload.settledAt) !== null,
    pullRequests: prs.map(parsePullRequest).filter((pr): pr is PullRequestSighting => pr !== null),
  };
}

function parsePullRequest(value: unknown): PullRequestSighting | null {
  if (!isRow(value)) return null;
  const { url, repository, number, linkedAt } = value;
  const linked = instantOrNull(linkedAt);
  if (typeof url !== "string" || typeof repository !== "string" || typeof number !== "number" || linked === null) return null;
  const snapshot = isRow(value.snapshot) ? value.snapshot : {};
  const raw = snapshot.state;
  const state: PullRequestState = raw === "merged" ? "merged" : raw === "closed" ? "closed" : snapshot.isDraft === true ? "draft" : "open";
  return {
    pr: {
      url,
      repo: repository,
      number,
      // T3 may not have the title yet. The number is shown beside it everywhere, so nothing stands in for it.
      title: optionalText(snapshot.title) ?? "",
      state,
      openedAt: instantOrNull(snapshot.createdAt),
      mergedAt: instantOrNull(snapshot.mergedAt),
    },
    closedAt: instantOrNull(snapshot.closedAt),
    linkedAt: linked,
  };
}

/** Provider instance id to the name T3 shows, such as "Claude 4". Missing or odd settings give no names. */
function readAccounts(path: string): Map<string, string> {
  const accounts = new Map<string, string>();
  try {
    const settings: unknown = JSON.parse(readFileSync(path, "utf8"));
    const instances = isRow(settings) && isRow(settings.providerInstances) ? settings.providerInstances : {};
    for (const [id, instance] of Object.entries(instances)) {
      if (isRow(instance) && typeof instance.displayName === "string") accounts.set(id, instance.displayName);
    }
  } catch {
    return accounts;
  }
  return accounts;
}

function isRow(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function shape(what: string): T3Error {
  return new T3Error(`T3's database has changed shape: ${what} is not what this reader expects. The hub needs an update for this T3 version.`);
}

function text(value: unknown, what: string): string {
  if (typeof value !== "string") throw shape(what);
  return value;
}

function optionalText(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

function json(value: unknown, what: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(text(value, what));
    if (isRow(parsed)) return parsed;
  } catch {
    throw shape(what);
  }
  throw shape(what);
}

function instantOrNull(value: unknown): Instant | null {
  if (typeof value !== "string") return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : (new Date(ms).toISOString() as Instant);
}

function instantOf(value: unknown, what: string): Instant {
  const at = instantOrNull(value);
  if (at === null) throw shape(what);
  return at;
}
