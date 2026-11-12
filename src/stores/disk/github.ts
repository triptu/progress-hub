import type { Commit, Instant, PullRequest, PullRequestState } from "../../core/types.ts";

/** Runs `gh` with these arguments and gives its output, or null when it is missing, signed out or fails. */
export type Runner = (args: readonly string[]) => Promise<string | null>;

const OPEN_REFRESH_MS = 5 * 60_000;
const RETRY_MS = 5 * 60_000;

interface Entry<T> {
  /** The last good answer, kept through later failures. */
  readonly value: T | null;
  readonly checkedAt: number;
}

/**
 * Titles and states for pull request and commit links that no harness has linked to the work, through `gh`.
 * A lookup never waits: it returns what is cached and queues a fetch, one `gh` at a time. An open pull
 * request is refreshed at most every five minutes, a merged or closed one never, and a failed lookup
 * is tried again after five minutes.
 */
export class GitHub {
  private readonly prs = new Map<string, Entry<PullRequest>>();
  private readonly commits = new Map<string, Entry<Commit>>();
  private readonly queued = new Map<string, () => Promise<void>>();
  private draining = false;
  private readonly run: Runner;
  private readonly onChange: () => void;
  private readonly now: () => number;

  constructor(run: Runner, onChange: () => void, now: () => number = Date.now) {
    this.run = run;
    this.onChange = onChange;
    this.now = now;
  }

  pullRequest(repo: string, number: number): PullRequest | null {
    const key = `pr ${repo.toLowerCase()}#${number}`;
    const entry = this.prs.get(key);
    const open = entry?.value?.state === "open" || entry?.value?.state === "draft";
    const due = entry === undefined || (entry.value === null ? this.since(entry) > RETRY_MS : open && this.since(entry) > OPEN_REFRESH_MS);
    if (due) {
      this.enqueue(key, async () => {
        const url = `https://github.com/${repo}/pull/${number}`;
        const out = await this.run(["pr", "view", url, "--json", "number,title,state,isDraft,mergedAt,createdAt,url"]);
        this.store(this.prs, key, out === null ? null : parsePullRequest(out, repo));
      });
    }
    return entry?.value ?? null;
  }

  commit(repo: string, sha: string): Commit | null {
    const key = `commit ${repo.toLowerCase()}@${sha.toLowerCase()}`;
    const entry = this.commits.get(key);
    if (entry === undefined || (entry.value === null && this.since(entry) > RETRY_MS)) {
      this.enqueue(key, async () => {
        const out = await this.run(["api", `repos/${repo}/commits/${sha}`, "--jq", "{sha: .sha, message: .commit.message, url: .html_url}"]);
        this.store(this.commits, key, out === null ? null : parseCommit(out, repo));
      });
    }
    return entry?.value ?? null;
  }

  /** Resolves once every queued lookup has run. For tests. */
  async settled(): Promise<void> {
    while (this.draining || this.queued.size > 0) await Bun.sleep(1);
  }

  private since(entry: Entry<unknown>): number {
    return this.now() - entry.checkedAt;
  }

  private store<T>(map: Map<string, Entry<T>>, key: string, value: T | null): void {
    const before = map.get(key)?.value ?? null;
    map.set(key, { value: value ?? before, checkedAt: this.now() });
    if (value !== null && JSON.stringify(value) !== JSON.stringify(before)) this.onChange();
  }

  private enqueue(key: string, job: () => Promise<void>): void {
    if (this.queued.has(key)) return;
    this.queued.set(key, job);
    if (!this.draining) void this.drain();
  }

  private async drain(): Promise<void> {
    this.draining = true;
    for (let next = this.queued.entries().next(); !next.done; next = this.queued.entries().next()) {
      const [key, job] = next.value;
      try {
        await job();
      } catch {
        // A lookup that throws counts as a failure; the entry stays as it was and is tried again later.
      }
      this.queued.delete(key);
    }
    this.draining = false;
  }
}

/** `gh`, with a time limit. Missing, signed out or failing all give null. */
export const runGh: Runner = async (args) => {
  try {
    const proc = Bun.spawn(["gh", ...args], { stdin: "ignore", stdout: "pipe", stderr: "ignore", timeout: 20_000 });
    const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    return code === 0 ? out : null;
  } catch {
    return null;
  }
};

function object(text: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function instant(value: unknown): Instant | null {
  if (typeof value !== "string" || value === "") return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : (new Date(ms).toISOString() as Instant);
}

function parsePullRequest(text: string, repo: string): PullRequest | null {
  const json = object(text);
  if (!json || typeof json.number !== "number" || typeof json.title !== "string" || typeof json.url !== "string") return null;
  const states: Record<string, PullRequestState> = { OPEN: json.isDraft === true ? "draft" : "open", MERGED: "merged", CLOSED: "closed" };
  const state = typeof json.state === "string" ? states[json.state] : undefined;
  if (!state) return null;
  return { url: json.url, repo, number: json.number, title: json.title, state, openedAt: instant(json.createdAt), mergedAt: instant(json.mergedAt) };
}

function parseCommit(text: string, repo: string): Commit | null {
  const json = object(text);
  if (!json || typeof json.sha !== "string" || typeof json.message !== "string" || typeof json.url !== "string") return null;
  return { url: json.url, repo, sha: json.sha, subject: json.message.split("\n")[0] ?? "" };
}
