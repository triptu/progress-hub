import { Database } from "bun:sqlite";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionRef } from "../src/core/types.ts";
import type { T3Files } from "../src/t3/read.ts";

export const ROOT = "root-1" as SessionRef;
export const CHILD = "thread:delegated-task:child%3A1" as SessionRef;
export const GRANDCHILD = "grandchild-1" as SessionRef;
export const LONE = "lone-1" as SessionRef;

/** A T3 database built with T3's real table definitions: a root with a subagent and a grandchild, and one lone thread. */
export function fixture(): T3Files {
  const dir = mkdtempSync(join(tmpdir(), "progress-t3-"));
  const files = { db: join(dir, "statev2.sqlite"), settings: join(dir, "settings.json"), environmentId: join(dir, "environment-id") };
  writeFileSync(files.settings, JSON.stringify({ providerInstances: { claudeAgent_4: { driver: "claudeAgent", displayName: "Claude 4" } } }));
  writeFileSync(files.environmentId, "env-1\n");
  const db = new Database(files.db, { strict: true });
  db.exec(readFileSync(join(import.meta.dir, "t3-schema.sql"), "utf8"));

  db.query("INSERT INTO projection_projects (project_id, title, workspace_root, scripts_json, created_at, updated_at) VALUES ('p1', 'harbor', '/x', '[]', '2026-11-10T08:00:00Z', '2026-11-10T08:00:00Z')").run();
  const thread = db.query(
    "INSERT INTO orchestration_v2_projection_threads (thread_id, project_id, title, default_provider, runtime_mode, interaction_mode, created_at, updated_at, payload_json) VALUES (?, 'p1', ?, 'claudeAgent', 'full-access', 'default', ?, ?, ?)",
  );
  const lineage = (parent: SessionRef | null, root: SessionRef) => ({ parentThreadId: parent, relationshipToParent: parent ? "subagent" : null, rootThreadId: root });
  thread.run(ROOT, "Progress hub", "2026-11-10T09:00:00.000Z", "2026-11-10T09:30:00.000Z", JSON.stringify({
    providerInstanceId: "claudeAgent_4",
    modelSelection: { instanceId: "claudeAgent_4", model: "claude-fable-5-2" },
    branch: "progress/core",
    worktreePath: "/w/core",
    lineage: lineage(null, ROOT),
    pullRequests: [{
      host: "github.com", repository: "o/r", number: 7, url: "https://github.com/o/r/pull/7", source: "agent", linkedAt: "2026-11-10T09:10:00.000Z",
      snapshot: { state: "merged", title: "Parser", isDraft: false, mergedAt: "2026-11-10T09:20:00Z", closedAt: "2026-11-10T09:20:00Z" },
    }],
  }));
  thread.run(CHILD, "Build the parser", "2026-11-10T09:05:00.000Z", "2026-11-10T09:40:00.000Z", JSON.stringify({ lineage: lineage(ROOT, ROOT), modelSelection: { model: "claude-opus-5-5" } }));
  thread.run(GRANDCHILD, "Review", "2026-11-10T09:06:00.000Z", "2026-11-10T09:41:00.000Z", JSON.stringify({ lineage: lineage(CHILD, ROOT) }));
  thread.run(LONE, "Lonely run", "2026-11-10T07:00:00.000Z", "2026-11-10T07:00:00.000Z", JSON.stringify({ lineage: lineage(null, LONE) }));

  const subagent = db.query(
    "INSERT INTO orchestration_v2_projection_subagents (subagent_id, thread_id, parent_node_id, provider, child_thread_id, origin, status, updated_at, payload_json) VALUES (?, ?, 'n', 'claudeAgent', ?, 'app_owned', 'running', '2026-11-10T09:05:00Z', '{}')",
  );
  subagent.run("s1", ROOT, CHILD);
  subagent.run("s2", CHILD, GRANDCHILD);

  const run = db.query("INSERT INTO orchestration_v2_projection_runs (run_id, thread_id, ordinal, provider, status, requested_at, payload_json) VALUES (?, ?, ?, 'claudeAgent', ?, ?, '{}')");
  run.run("r1", ROOT, 1, "running", "2026-11-10T09:00:00.000Z");
  run.run("r2", ROOT, 2, "completed", "2026-11-10T09:31:00.000Z");
  run.run("r3", CHILD, 1, "running", "2026-11-10T09:05:00.000Z");
  run.run("r4", GRANDCHILD, 1, "waiting", "2026-11-10T09:06:00.000Z");
  run.run("r5", LONE, 1, "running", "2026-11-10T07:00:00.000Z");

  const request = db.query("INSERT INTO orchestration_v2_projection_runtime_requests (runtime_request_id, thread_id, node_id, kind, status, created_at, payload_json) VALUES (?, ?, ?, ?, 'pending', ?, ?)");
  const card = db.query("INSERT INTO orchestration_v2_projection_turn_items (turn_item_id, thread_id, node_id, ordinal, type, status, updated_at, payload_json) VALUES (?, ?, ?, 1, ?, 'waiting', '2026-11-10T09:00:00Z', ?)");
  request.run("q1", CHILD, "n1", "command_approval", "2026-11-10T09:35:00.000Z", JSON.stringify({ responseCapability: { type: "decision" } }));
  card.run("t1", CHILD, "n1", "approval_request", JSON.stringify({ requestId: "q1", prompt: "git push --force" }));
  request.run("q2", LONE, "n2", "user_input", "2026-11-10T07:01:00.000Z", JSON.stringify({ responseCapability: { type: "answer" } }));
  card.run("t2", LONE, "n2", "user_input_request", JSON.stringify({ requestId: "q2", questions: [{ question: "Which Mac?" }] }));
  request.run("q3", GRANDCHILD, "n3", "user_input", "2026-11-10T09:07:00.000Z", JSON.stringify({ responseCapability: { type: "message" } }));
  request.run("q4", ROOT, "n4", "command_approval", "2026-11-10T09:08:00.000Z", JSON.stringify({ responseCapability: { type: "decision" } }));

  const message = db.query("INSERT INTO orchestration_v2_projection_messages (message_id, thread_id, role, streaming, created_at, updated_at, payload_json) VALUES (?, ?, 'user', 0, ?, ?, ?)");
  message.run("m1", ROOT, "2026-11-10T09:15:00.000Z", "2026-11-10T09:15:00.000Z", JSON.stringify({ text: "go", createdBy: "user" }));
  message.run("m2", ROOT, "2026-11-10T09:45:00.000Z", "2026-11-10T09:45:00.000Z", JSON.stringify({ text: "Delegated task finished", createdBy: "agent" }));
  db.close();
  return files;
}
