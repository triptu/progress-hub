import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionRef } from "../src/core/types.ts";
import { readT3, t3Files, T3Error } from "../src/t3/read.ts";
import { CHILD, fixture, GRANDCHILD, LONE, ROOT } from "./t3-fixture.ts";

test("threads resolve to their root, and every thread under the root is an agent", () => {
  const read = readT3([CHILD, "not-in-t3" as SessionRef], fixture());
  expect([...read.roots]).toEqual([[CHILD, ROOT]]);
  const agents = read.agents.get(ROOT) ?? [];
  expect(agents.map((a) => [a.thread, a.status])).toEqual([
    [ROOT, "finished"],
    [CHILD, "working"],
    [GRANDCHILD, "waiting"],
  ]);
  expect(agents[0]).toMatchObject({ model: "claude-fable-5-2", account: "Claude 4", branch: "progress/core", worktree: "/w/core", link: "t3code://threads/env-1/root-1" });
  expect(agents[1]?.link).toBe("t3code://threads/env-1/thread%3Adelegated-task%3Achild%253A1");
  expect(read.projects.get(ROOT)).toBe("harbor");
  expect(read.lastUserMessageAt.get(ROOT) as string | undefined).toBe("2026-11-10T09:15:00.000Z");
});

test("pull requests come from the thread's linked snapshot", () => {
  const [sighting] = readT3([ROOT], fixture()).pullRequests.get(ROOT) ?? [];
  expect(sighting?.pr).toMatchObject({ repo: "o/r", number: 7, title: "Parser", state: "merged", mergedAt: "2026-11-10T09:20:00.000Z" });
});

test("only blocking requests on live runs are stalls, subagents and threads with no page included", () => {
  const stalls = readT3([], fixture()).stalls;
  expect(stalls.map((s) => [s.root, s.stall.thread, s.stall.ask, s.stall.text])).toEqual([
    [LONE, LONE, "question", "Which Mac?"],
    [ROOT, CHILD, "approval", "git push --force"],
  ]);
});

test("a missing database is a plain error", () => {
  const files = fixture();
  expect(() => readT3([], { ...files, db: join(files.db, "..", "gone.sqlite") })).toThrow(T3Error);
});

test("a machine T3 has never run on has no T3 to read, unless this is one of its threads or a database is named", () => {
  const home = mkdtempSync(join(tmpdir(), "progress-no-t3-"));
  expect(t3Files(home, {})).toBeNull();
  expect(t3Files(home, { T3CODE_THREAD_ID: "8f2c" })).not.toBeNull();
  expect(t3Files(home, { PROGRESS_T3_DB: "/somewhere/state.sqlite" })?.db).toBe("/somewhere/state.sqlite");
  mkdirSync(join(home, ".t3", "userdata"), { recursive: true });
  expect(t3Files(home, {})?.db).toBe(join(home, ".t3", "userdata", "statev2.sqlite"));
  expect(t3Files(home, { PROGRESS_T3_DB: "off" })).toBeNull();
});
