import { afterAll, expect, test } from "bun:test";
import { mediaRefs } from "../src/core/parse.ts";
import { mkdirSync, mkdtempSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HubState, Media } from "../src/core/types.ts";
import { serve } from "../src/server/serve.ts";

const root = mkdtempSync(join(tmpdir(), "progress-media-"));
const home = join(root, "home");
const outside = join(root, "outside");
for (const dir of [join(home, "alpha", "images"), join(home, "beta", "shots"), outside]) mkdirSync(dir, { recursive: true });

const at = (iso: string) => new Date(iso);
function put(path: string, body: string, time: Date) {
  writeFileSync(path, body);
  utimesSync(path, time, time);
}

put(join(home, "alpha", "images", "first.png"), "png", at("2026-11-08T10:00:00Z"));
put(join(home, "alpha", "images", "second shot.jpg"), "jpg", at("2026-11-10T09:00:00Z"));
put(join(home, "alpha", "demo.mp4"), "mp4", at("2026-11-09T12:00:00Z"));
put(join(home, "alpha", "mock.html"), "<p>mock</p>", at("2026-11-09T08:00:00Z"));
put(join(home, "alpha", ".hidden.png"), "png", at("2026-11-10T10:00:00Z"));
put(join(outside, "secret.png"), "secret", at("2026-11-10T11:00:00Z"));
symlinkSync(join(outside, "secret.png"), join(home, "alpha", "images", "leak.png"));
put(join(home, "beta", "shots", "b.png"), "png", at("2026-11-07T10:00:00Z"));
put(join(home, "beta", "clip.webm"), "webm", at("2026-11-07T11:00:00Z"));

put(
  join(home, "alpha", "progress.md"),
  [
    "---\ntitle: Alpha\n---\n",
    "Summary.\n",
    "![First](images/first.png)",
    "![Second, from today](images/second%20shot.jpg)",
    "![Demo](demo.mp4)",
    "![Option A](mock.html)",
    "![First again](images/first.png)",
    "![Gone](images/missing.png)",
    "![Hidden](.hidden.png)",
    "![Leak](images/leak.png)",
    "![Other work](../beta/shots/b.png)",
    "![Absolute](/etc/hosts.png)",
    "![Web](https://example.com/x.png)\n",
  ].join("\n"),
  at("2026-11-10T08:00:00Z"),
);
put(
  join(home, "beta", "progress.md"),
  '---\ntitle: Beta\n---\n\n<img src="shots/b.png" alt="B &amp; C"><video controls><source src="clip.webm"></video><img src="../alpha/images/first.png" alt="Not mine">\n',
  at("2026-11-07T12:00:00Z"),
);

const running = serve({ home, port: 0, sources: [] });
afterAll(() => running.stop());

test("/api/media lists what each page shows inside its own folder, newest first by the file's own time, and an image saved later on the next scan", async () => {
  const media = (await (await fetch(`${running.url}/api/media`)).json()) as Media[];
  expect(media.map((m) => [m.work, m.kind, m.src, m.caption, m.at])).toEqual([
    ["alpha", "image", "/files/alpha/images/second%20shot.jpg", "Second, from today", "2026-11-10T09:00:00.000Z"],
    ["alpha", "video", "/files/alpha/demo.mp4", "Demo", "2026-11-09T12:00:00.000Z"],
    ["alpha", "page", "/files/alpha/mock.html", "Option A", "2026-11-09T08:00:00.000Z"],
    ["alpha", "image", "/files/alpha/images/first.png", "First", "2026-11-08T10:00:00.000Z"],
    ["beta", "video", "/files/beta/clip.webm", "", "2026-11-07T11:00:00.000Z"],
    ["beta", "image", "/files/beta/shots/b.png", "B & C", "2026-11-07T10:00:00.000Z"],
  ]);
  const state = (await (await fetch(`${running.url}/api/state`)).json()) as HubState;
  expect(state.latestMedia?.caption).toBe("Second, from today");

  put(join(home, "alpha", "images", "missing.png"), "png", at("2026-11-10T12:00:00Z"));
  running.own.refresh();
  const later = (await (await fetch(`${running.url}/api/media`)).json()) as Media[];
  expect(later[0]?.caption).toBe("Gone");
});

test("a link to a file is an artifact, named by the link's words", () => {
  const refs = mediaRefs("See [how it **works**](how-it-works.html), the [report](out/report.pdf), [the queries](audit.sql), [the repo](https://github.com/o/r) and [the code](src/main.ts).\n\n![Shot](a.png)\n");
  expect(refs).toEqual([
    { kind: "page", target: "how-it-works.html", caption: "how it works" },
    { kind: "file", target: "out/report.pdf", caption: "report" },
    { kind: "file", target: "audit.sql", caption: "the queries" },
    { kind: "image", target: "a.png", caption: "Shot" },
  ]);
});

test("a link to a folder in the work's folder is one item with the files in it, by name as a person sorts them", async () => {
  mkdirSync(join(home, "gamma", "queries", "deep"), { recursive: true });
  put(join(home, "gamma", "queries", "d10.json"), "{}", at("2026-11-12T10:00:00Z"));
  put(join(home, "gamma", "queries", "d2.json"), "{}", at("2026-11-12T11:00:00Z"));
  put(join(home, "gamma", "queries", "deep", "x.sql"), "select 1", at("2026-11-12T09:00:00Z"));
  put(join(home, "gamma", "queries", ".secret"), "no", at("2026-11-12T12:00:00Z"));
  mkdirSync(join(home, "gamma", "empty"));
  put(join(home, "gamma", "progress.md"), "---\ntitle: Gamma\n---\n\nSee [the queries](queries/), [nothing](empty) and [the site](https://example.com/docs).\n", at("2026-11-12T12:00:00Z"));
  running.own.refresh();
  const media = ((await (await fetch(`${running.url}/api/media`)).json()) as Media[]).filter((m) => m.work === "gamma");
  expect(media.map((m) => [m.kind, m.src, m.caption, m.at])).toEqual([["folder", "/files/gamma/queries", "the queries", "2026-11-12T11:00:00.000Z"]]);
  expect(media[0]?.files?.map((f) => [f.name, f.src])).toEqual([
    ["d2.json", "/files/gamma/queries/d2.json"],
    ["d10.json", "/files/gamma/queries/d10.json"],
    ["deep/x.sql", "/files/gamma/queries/deep/x.sql"],
  ]);
});
