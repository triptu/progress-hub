import { expect, test } from "bun:test";
import { GitHub, type Runner } from "../src/stores/disk/github.ts";

/** A `gh` that answers from `answers`, which a test changes as GitHub would, and a clock the test moves. */
function setup(answers: Record<string, string | null>) {
  let now = 0;
  const run: Runner = async (args) => answers[args[2] ?? ""] ?? answers[args[1] ?? ""] ?? null;
  const github = new GitHub(run, () => undefined, () => now);
  /** What the hub would show for the pull request now, once the lookup it queued has run. */
  const seen = async () => {
    github.pullRequest("o/r", 5);
    await github.settled();
    return github.pullRequest("o/r", 5);
  };
  return { github, seen, later: (ms: number) => (now += ms) };
}

const URL = "https://github.com/o/r/pull/5";
const pr = (state: string, isDraft = false) =>
  JSON.stringify({ number: 5, title: "Faster search", state, isDraft, mergedAt: state === "MERGED" ? "2026-11-10T10:00:00Z" : null, createdAt: "2026-11-10T09:00:00Z", url: URL });

test("a pull request is unknown until gh has answered, and a merged one stays as it was read", async () => {
  const answers: Record<string, string | null> = { [URL]: pr("MERGED") };
  const { github, seen, later } = setup(answers);
  expect(github.pullRequest("o/r", 5)).toBeNull();
  expect(await seen()).toMatchObject({ number: 5, title: "Faster search", state: "merged", mergedAt: "2026-11-10T10:00:00.000Z" });
  // Merged is final, so it is not asked about again.
  answers[URL] = pr("OPEN");
  later(24 * 60 * 60_000);
  expect((await seen())?.state).toBe("merged");
});

test("an open pull request shows a change five minutes after it was last read, not before", async () => {
  const answers: Record<string, string | null> = { [URL]: pr("OPEN", true) };
  const { seen, later } = setup(answers);
  expect((await seen())?.state).toBe("draft");
  answers[URL] = pr("MERGED");
  later(4 * 60_000);
  expect((await seen())?.state).toBe("draft");
  later(2 * 60_000);
  expect((await seen())?.state).toBe("merged");
});

test("when gh fails the pull request stays unknown or as last read, and it is tried again five minutes later", async () => {
  const answers: Record<string, string | null> = {};
  const { seen, later } = setup(answers);
  expect(await seen()).toBeNull();
  answers[URL] = pr("OPEN");
  later(60_000);
  expect(await seen()).toBeNull();
  later(5 * 60_000);
  expect((await seen())?.state).toBe("open");
  answers[URL] = "not json";
  later(6 * 60_000);
  expect((await seen())?.state).toBe("open");
});

test("a commit resolves to its full hash and the first line of its message", async () => {
  const { github } = setup({ "repos/o/r/commits/4be71c9": JSON.stringify({ sha: "4be71c9aa", message: "Reset the clock\n\nBody.", url: "https://github.com/o/r/commit/4be71c9aa" }) });
  github.commit("o/r", "4be71c9");
  await github.settled();
  expect(github.commit("o/r", "4be71c9")).toMatchObject({ sha: "4be71c9aa", subject: "Reset the clock" });
});
