import { expect, test } from "bun:test";
import { markdownBody } from "../src/web/lib/markdown.ts";

test("a Markdown document keeps a transcript's lines and reads a paragraph wrapped by hand as one", () => {
  const transcript = ["[00:43:29] User: hi! how does this work?", "[00:43:29] Assistant (0.5 s): Hi, I'm your assistant. Sign up here.", "[00:46:55] -- Ana signed up --"].join("\n");
  expect(markdownBody(transcript).match(/<br>/g)?.length).toBe(2);

  const list = ["Search the web, fetch and read any public page, and watch YouTube videos you link", "Answer anything from general knowledge - explain, analyze, compare, brainstorm"].join("\n");
  expect(markdownBody(list)).toContain("<br>");

  const wrapped = [
    "is `docs/design/creator-room.md`; the rebuild's shape: `apps/room` is the new app built beside the old",
    "`apps/web`, served at `/room` until it covers the loop, then swapped to `/` and the old app deleted. The",
    "slices before it are merged, and this is the last one.",
  ].join("\n");
  expect(markdownBody(wrapped)).not.toContain("<br>");
  expect(markdownBody(`- ${wrapped.split("\n").join("\n  ")}`)).not.toContain("<br>");
});
