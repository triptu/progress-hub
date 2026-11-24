import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HubState, Todo, WorkDetail } from "../src/core/types.ts";
import { MarkStore } from "../src/stores/marks.ts";
import { TodoStore } from "../src/stores/todos.ts";
import { serve } from "../src/server/serve.ts";
import { t3Source } from "../src/t3/source.ts";

const root = mkdtempSync(join(tmpdir(), "progress-serve-"));
const home = join(root, "home");
const outside = join(root, "outside");
mkdirSync(join(home, "alpha", "images"), { recursive: true });
mkdirSync(outside);
writeFileSync(join(outside, "secret.txt"), "secret");
writeFileSync(join(home, "alpha", "images", "a.png"), "png");
writeFileSync(join(home, "alpha", "mock.html"), "<p>mock</p>");
writeFileSync(join(home, "alpha", "images", "chart.svg"), '<svg xmlns="http://www.w3.org/2000/svg"><script>fetch("/api/state")</script></svg>');
writeFileSync(join(home, "alpha", ".history.jsonl"), "");
symlinkSync(join(outside, "secret.txt"), join(home, "alpha", "leak.txt"));
symlinkSync(outside, join(home, "alpha", "out"));
writeFileSync(
  join(home, "alpha", "progress.md"),
  "---\ntitle: Alpha\n---\n\nWhere it **stands**. More detail\non the next line.\n\n## Needs you\n\n### Pick one\n\n![Option A](mock.html)\n![Demo](images/demo.mp4)\n![Shot](images/a.png)\n",
);
const old = new Date(Date.now() - 60_000);
utimesSync(join(home, "alpha", "progress.md"), old, old);

const running = serve({ home, port: 0, sources: [t3Source({ db: join(root, "none.sqlite"), settings: join(root, "none.json"), environmentId: join(root, "none") })], hosts: ["mac.tail1234.ts.net"] });
afterAll(() => running.stop());

const get = (path: string) => fetch(running.url + path);

test("the state lists the work, its Needs you item, and says T3 could not be read", async () => {
  const state = (await (await get("/api/state")).json()) as HubState;
  expect(state.works.map((w) => [w.id, w.title, w.needsCount])).toEqual([["alpha", "Alpha", 1]]);
  expect(state.needs.map((n) => n.source === "page" && n.title)).toEqual(["Pick one"]);
  expect(state.feed.map((f) => f.event.kind)).toEqual(["started"]);
  expect(state.works[0]?.preview).toBe("Where it stands.");
  expect(state.sources.map((source) => [source.label, source.health.ok])).toEqual([["T3", false]]);
});

test("a work's page points its files at /files, with videos as players, pages in sandboxed frames and images captioned", async () => {
  // The ask is in the hub's state, which is where every screen reads asks from. The work's own answer is its page.
  const [item] = ((await (await get("/api/state")).json()) as HubState).needs.flatMap((need) => (need.source === "page" ? [need] : []));
  expect(item?.titleHtml as string | undefined).toBe("Pick one");
  const detail = (await (await get("/api/work/alpha")).json()) as WorkDetail;
  expect(detail.summary.title).toBe("Alpha");
  const html = item?.html ?? "";
  expect(html).not.toContain("Pick one");
  expect(html).toContain('<iframe sandbox="allow-scripts" src="/files/alpha/mock.html"');
  expect(html).toContain('<video controls preload="metadata" src="/files/alpha/images/demo.mp4"');
  // A picture loads from an address with the file's time on it; its link is the plain address.
  expect(html).toMatch(/<a class="fig" href="\/files\/alpha\/images\/a\.png" target="_blank" rel="noopener noreferrer"><img src="\/files\/alpha\/images\/a\.png\?v=\d+" alt="Shot" \/><span class="cap" aria-hidden="true">Shot<\/span><\/a>/);
  expect((await get("/api/work/nope")).status).toBe(404);
});

test("/files serves the work's files and refuses dotfiles and symlinks that leave the home", async () => {
  const image = await get("/files/alpha/images/a.png");
  expect(await image.text()).toBe("png");
  // The plain address is asked for again each time. One with the file's time on it names a version the browser may keep.
  expect(image.headers.get("cache-control")).toBe("no-cache");
  expect((await get("/files/alpha/images/a.png?v=1")).headers.get("cache-control")).toContain("immutable");
  const page = await get("/files/alpha/mock.html");
  expect(page.headers.get("content-security-policy")).toBe("sandbox allow-scripts");
  const svg = await get("/files/alpha/images/chart.svg");
  expect(svg.headers.get("content-security-policy")).toBe("sandbox");
  expect(svg.headers.get("x-content-type-options")).toBe("nosniff");
  expect((await get("/files/alpha/leak.txt")).status).toBe(403);
  expect((await get("/files/alpha/out/secret.txt")).status).toBe(403);
  expect((await get("/files/alpha/.history.jsonl")).status).toBe(404);
  expect((await get("/files/alpha/%2E%2E/%2E%2E/outside/secret.txt")).status).toBe(404);
});

test("the event stream says only that something changed", async () => {
  const own = join(root, "stream");
  mkdirSync(join(own, "beta"), { recursive: true });
  const hub = serve({ home: own, port: 0, sources: [] });
  try {
    const response = await fetch(`${hub.url}/api/events`);
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    const reader = response.body?.getReader();
    expect(new TextDecoder().decode((await reader?.read())?.value)).toBe(": open\n\n");
    writeFileSync(join(own, "beta", "progress.md"), "---\ntitle: Beta\n---\n\nWhere it stands.\n");
    utimesSync(join(own, "beta", "progress.md"), old, old);
    expect(new TextDecoder().decode((await reader?.read())?.value)).toBe("data: changed\n\n");
    await reader?.cancel();
  } finally {
    hub.stop();
  }
});

test("a request addressed to another host is refused, so a site can't read the hub through DNS rebinding", async () => {
  const port = new URL(running.url).port;
  const as = (host: string, path = "/api/state") => fetch(running.url + path, { headers: { Host: host } }).then((r) => r.status);
  expect(await as(`localhost:${port}`)).toBe(200);
  expect(await as(`mac.tail1234.ts.net:${port}`)).toBe(200);
  expect(await as(`attacker.example:${port}`)).toBe(403);
  expect(await as(`attacker.example:${port}`, "/files/alpha/images/a.png")).toBe(403);
  expect(await as(`attacker.example:${port}`, "/api/work/alpha")).toBe(403);
  expect(await as("localhost:1")).toBe(403);
  expect(await as(`evil.test@localhost:${port}`)).toBe(403);
  expect(await as(`localhost:${port}/evil`)).toBe(403);
});

test("a mark made from the hub's own page shows in the state and is kept in the home, and another site can't make one", async () => {
  const post = (body: unknown, origin: string) => fetch(`${running.url}/api/marks`, { method: "POST", headers: { "Content-Type": "application/json", Origin: origin }, body: JSON.stringify(body) });
  const marks = async () => ((await (await get("/api/state")).json()) as HubState).marks;
  const pr = "https://github.com/acme/app/pull/7";

  expect((await post({ kind: "viewed", keys: [pr, "alpha/shipped/A line."], on: true }, running.url)).status).toBe(204);
  expect((await post({ kind: "dismissed", keys: ["alpha:needs/Pick one"], on: true }, running.url)).status).toBe(204);
  expect(await marks()).toEqual({ viewed: [pr, "alpha/shipped/A line."], dismissed: ["alpha:needs/Pick one"] });
  expect(JSON.parse(readFileSync(join(home, ".marks.json"), "utf8"))).toEqual(await marks());

  expect((await post({ kind: "viewed", keys: [pr], on: false }, running.url)).status).toBe(204);
  expect((await marks()).viewed).toEqual(["alpha/shipped/A line."]);

  expect((await post({ kind: "viewed", keys: [pr], on: true }, "https://elsewhere.example")).status).toBe(403);
  expect((await post({ kind: "starred", keys: [pr], on: true }, running.url)).status).toBe(400);
  expect((await post({ kind: "viewed", keys: "everything", on: true }, running.url)).status).toBe(400);
  expect((await post({ kind: "viewed", keys: [pr] }, running.url)).status).toBe(400);
  expect((await marks()).viewed).toEqual(["alpha/shipped/A line."]);
});

test("a mark stays on a line an agent rewords: made before, sent under the old wording after, and unmarked for good", async () => {
  const dir = mkdtempSync(join(tmpdir(), "progress-reworded-"));
  mkdirSync(join(dir, "hub"));
  const file = join(dir, "hub", "progress.md");
  const put = (ask: string, shipped: string, time: string) => {
    writeFileSync(file, `Summary.\n\n## Needs you\n\n### ${ask}\n\n## Shipped\n\n- ${shipped}\n`);
    utimesSync(file, new Date(time), new Date(time));
  };
  const [ask, askNow] = ["Give the deploy token R2 permission", "Give the deploy token R2 permission before the merge"];
  const [line, lineNow] = ["The parser is in, with its tests.", "The parser is in, with all of its tests."];
  put(ask, line, "2026-11-10T08:00:00Z");
  let hub = serve({ home: dir, port: 0, sources: [] });
  const post = (kind: string, keys: string[], on: boolean) => fetch(`${hub.url}/api/marks`, { method: "POST", headers: { "Content-Type": "application/json", Origin: hub.url }, body: JSON.stringify({ kind, keys, on }) });
  const marks = async () => ((await (await fetch(`${hub.url}/api/state`)).json()) as HubState).marks;
  await post("dismissed", [`hub:needs/${ask}`], true);

  put(askNow, lineNow, "2026-11-10T09:00:00Z");
  hub.own.refresh();
  expect((await marks()).dismissed).toContain(`hub:needs/${askNow}`);

  // Done is undone on the line as it reads now, and that holds after the hub starts again.
  await post("dismissed", [`hub:needs/${askNow}`], false);
  expect((await marks()).dismissed).toEqual([]);
  hub.stop();
  hub = serve({ home: dir, port: 0, sources: [] });
  expect((await marks()).dismissed).toEqual([]);

  // A tab still showing the old wording marks it under the old id.
  await post("dismissed", [`hub:needs/${ask}`], true);
  expect((await marks()).dismissed).toContain(`hub:needs/${askNow}`);

  // Viewed under the second wording, and still viewed when the line goes back to its first.
  await post("viewed", [`hub/shipped/${lineNow}`], true);
  put(askNow, line, "2026-11-10T10:00:00Z");
  hub.own.refresh();
  expect((await marks()).viewed).toContain(`hub/shipped/${line}`);
  hub.stop();
});

test("a wording back on the page belongs to the line that has it: its mark is that line's, apart from the line it was reworded into", async () => {
  const dir = mkdtempSync(join(tmpdir(), "progress-reused-"));
  mkdirSync(join(dir, "hub"));
  const file = join(dir, "hub", "progress.md");
  const put = (asks: string[], shipped: string[], time: string) => {
    writeFileSync(file, `Summary.\n\n## Needs you\n\n${asks.map((ask) => `### ${ask}\n`).join("\n")}\n## Shipped\n\n${shipped.map((line) => `- ${line}\n`).join("")}`);
    utimesSync(file, new Date(time), new Date(time));
  };
  const [ask, askNow] = ["Give the deploy token R2 permission", "Give the deploy token R2 permission before the merge"];
  const [line, lineNow] = ["The parser is in, with its tests.", "The parser is in, with all of its tests."];
  put([ask], [line], "2026-11-10T08:00:00Z");
  const hub = serve({ home: dir, port: 0, sources: [] });
  const post = (kind: string, keys: string[], on: boolean) => fetch(`${hub.url}/api/marks`, { method: "POST", headers: { "Content-Type": "application/json", Origin: hub.url }, body: JSON.stringify({ kind, keys, on }) });
  const marks = async () => ((await (await fetch(`${hub.url}/api/state`)).json()) as HubState).marks;
  await post("dismissed", [`hub:needs/${ask}`], true);
  await post("viewed", [`hub/shipped/${line}`], true);
  put([askNow], [lineNow], "2026-11-10T09:00:00Z");
  hub.own.refresh();
  expect(await marks()).toEqual({ viewed: [`hub/shipped/${line}`, `hub/shipped/${lineNow}`], dismissed: [`hub:needs/${ask}`, `hub:needs/${askNow}`] });

  // The old wordings come back as lines of their own: each mark is theirs now, and the reworded lines are unmarked.
  put([askNow, ask], [lineNow, line], "2026-11-10T10:00:00Z");
  hub.own.refresh();
  expect(await marks()).toEqual({ viewed: [`hub/shipped/${line}`], dismissed: [`hub:needs/${ask}`] });

  // Marking the reworded lines and unmarking them leaves the others marked, and so does their going away again.
  await post("dismissed", [`hub:needs/${askNow}`], true);
  await post("viewed", [`hub/shipped/${lineNow}`], true);
  await post("dismissed", [`hub:needs/${askNow}`], false);
  await post("viewed", [`hub/shipped/${lineNow}`], false);
  put([askNow], [lineNow], "2026-11-10T11:00:00Z");
  hub.own.refresh();
  expect(await marks()).toEqual({ viewed: [`hub/shipped/${line}`], dismissed: [`hub:needs/${ask}`] });
  hub.stop();
});

test("a todo is added, ticked and removed through the hub, kept in the home, and another site can't change the list", async () => {
  const post = (body: unknown, origin = running.url) => fetch(`${running.url}/api/todos`, { method: "POST", headers: { "Content-Type": "application/json", Origin: origin }, body: JSON.stringify(body) }).then((r) => r.status);
  const todos = async () => ((await (await get("/api/state")).json()) as HubState).todos;

  expect(await post({ op: "add", text: "  Rotate the key  ", work: "alpha", project: null })).toBe(204);
  expect(await post({ op: "add", text: "Book the dentist" })).toBe(204);
  // Newest first, about a work, a project or nothing.
  expect((await todos()).map((todo) => [todo.text, todo.work, todo.project, todo.doneAt])).toEqual([
    ["Book the dentist", null, null, null],
    ["Rotate the key", "alpha", null, null],
  ]);
  expect((await todos()).map((todo) => todo.description)).toEqual(["", ""]);
  expect(JSON.parse(readFileSync(join(home, ".todos.json"), "utf8"))).toEqual(await todos());

  const [dentist, key] = await todos();
  expect(await post({ op: "done", id: key?.id, on: true })).toBe(204);
  expect((await todos())[1]?.doneAt).toBeString();
  expect(await post({ op: "done", id: key?.id, on: false })).toBe(204);
  expect((await todos())[1]?.doneAt).toBeNull();
  expect(await post({ op: "remove", id: dentist?.id })).toBe(204);
  expect((await todos()).map((todo) => todo.text)).toEqual(["Rotate the key"]);
  // What was removed can be put back as it was, in its place, and only once.
  expect(await post({ op: "restore", todo: dentist })).toBe(204);
  expect(await post({ op: "restore", todo: dentist })).toBe(204);
  expect((await todos()).map((todo) => todo.id)).toEqual([dentist?.id ?? "", key?.id ?? ""]);
  expect((await todos())[0]).toEqual(dentist as Todo);
  expect(await post({ op: "restore", todo: { text: "No id" } })).toBe(400);
  expect(await post({ op: "remove", id: dentist?.id })).toBe(204);

  // Its words, its description and what it is about can all be changed, and a change of nothing is no change.
  expect(await post({ op: "edit", id: key?.id, text: " Rotate both keys ", description: "The old one expires on the 20th.\nAsk ops first.", work: null, project: "acme" })).toBe(204);
  expect((await todos()).map((todo) => [todo.text, todo.description, todo.work, todo.project])).toEqual([["Rotate both keys", "The old one expires on the 20th.\nAsk ops first.", null, "acme"]]);
  expect(await post({ op: "edit", id: key?.id, text: "", description: "" })).toBe(400);
  expect(await post({ op: "edit", id: "no-such-todo", text: "Lost" })).toBe(204);
  expect((await todos()).map((todo) => todo.text)).toEqual(["Rotate both keys"]);
  expect(await post({ op: "edit", id: key?.id, text: "Rotate the key" })).toBe(204);

  expect(await post({ op: "add", text: "From elsewhere" }, "https://elsewhere.example")).toBe(403);
  expect(await post({ op: "add", text: "   " })).toBe(400);
  expect(await post({ op: "done", id: key?.id })).toBe(400);
  expect(await post({ op: "forget", id: key?.id })).toBe(400);
  expect((await todos()).map((todo) => todo.text)).toEqual(["Rotate the key"]);
});

test("a list written before todos had descriptions still loads, each with none", () => {
  const file = join(root, "old-todos.json");
  writeFileSync(file, JSON.stringify([{ id: "a", text: "Old one", work: null, project: null, addedAt: "2026-11-10T09:00:00.000Z", doneAt: null }, { text: "No id" }]));
  expect(new TodoStore(file).get().map((todo) => [todo.text, todo.description])).toEqual([["Old one", ""]]);
});

test("a mark the file could not take is not held in memory either, so asking again tries again", () => {
  const dir = join(root, "later");
  const store = new MarkStore(join(dir, ".marks.json"));
  expect(() => store.change("viewed", ["a"], true)).toThrow();
  expect(store.get().viewed).toEqual([]);
  mkdirSync(dir);
  expect(store.change("viewed", ["a"], true)).toBe(true);
  expect(new MarkStore(join(dir, ".marks.json")).get()).toEqual({ viewed: ["a"], dismissed: [] });
});

test("a page's image carries the pixel size read from the file's first bytes, and what is not an image carries none", async () => {
  const dir = join(root, "sizes");
  mkdirSync(join(dir, "gamma"), { recursive: true });
  // A PNG header for 640 by 360, a GIF header for 20 by 10, and a file that is neither.
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]), Buffer.from("IHDR"), Buffer.from([0, 0, 2, 0x80, 0, 0, 1, 0x68, 8, 6, 0, 0, 0])]);
  writeFileSync(join(dir, "gamma", "shot.png"), png);
  writeFileSync(join(dir, "gamma", "tiny.gif"), Buffer.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 20, 0, 10, 0, 0, 0]));
  writeFileSync(join(dir, "gamma", "notes.png"), "not an image");
  writeFileSync(join(dir, "gamma", "progress.md"), "---\ntitle: Gamma\n---\n\n![Shot](shot.png) ![Tiny](tiny.gif) ![Notes](notes.png) ![Missing](missing.png)\n\n## Goal\n\nSee it.\n");
  utimesSync(join(dir, "gamma", "progress.md"), old, old);
  const hub = serve({ home: dir, port: 0, sources: [] });
  try {
    const detail = (await (await fetch(`${hub.url}/api/work/gamma`)).json()) as WorkDetail;
    const sized = (name: string) => new RegExp(`<img src="/files/gamma/${name}[^"]*" alt="[^"]*"( style="[^"]*")?`).exec(detail.body.summary)?.[1]?.trim() ?? null;
    expect(["shot.png", "tiny.gif", "notes.png", "missing.png"].map(sized)).toEqual(['style="--w:640;--h:360"', 'style="--w:20;--h:10"', null, null]);
  } finally {
    hub.stop();
  }
});

test("a work's places to try say whether they answer, and the hub opens a listed file only", async () => {
  const dir = join(root, "try");
  const built = join(root, "built");
  mkdirSync(join(dir, "delta"), { recursive: true });
  mkdirSync(built);
  writeFileSync(join(built, "index.html"), "<p>app</p>");
  writeFileSync(join(built, "notes.txt"), "notes");
  writeFileSync(join(dir, "delta", "mock.html"), "<p>mock</p>");
  const app = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("ok") });
  const page = `---\ntitle: Delta\n---\n\nGoal: try it.\n\n## Try it\n\n- [App](http://127.0.0.1:${app.port})\n- [Stopped](http://127.0.0.1:1)\n- [Mock](mock.html)\n- [Built](${join(built, "index.html")})\n- [Gone](${join(built, "gone.html")})\n- [Preview](https://preview.example/x)\n`;
  writeFileSync(join(dir, "delta", "progress.md"), page);
  utimesSync(join(dir, "delta", "progress.md"), old, old);
  const opened: string[] = [];
  const hub = serve({ home: dir, port: 0, sources: [], open: (path) => opened.push(path) });
  try {
    const links = async () => ((await (await fetch(`${hub.url}/api/state`)).json()) as HubState).works[0]?.links ?? [];
    for (let tries = 0; tries < 40 && (await links()).some((link) => link.label === "App" && link.up === null); tries++) await Bun.sleep(50);
    expect((await links()).map((link) => [link.label, link.href, link.up])).toEqual([
      ["App", `http://127.0.0.1:${app.port}`, true],
      ["Stopped", "http://127.0.0.1:1", false],
      ["Mock", "/files/delta/mock.html", true],
      ["Built", null, true],
      ["Gone", null, false],
      ["Preview", "https://preview.example/x", null],
    ]);
    const open = (url: string, origin = hub.url) => fetch(`${hub.url}/api/open`, { method: "POST", headers: { "Content-Type": "application/json", Origin: origin }, body: JSON.stringify({ work: "delta", url }) });
    expect((await open(join(built, "index.html"))).status).toBe(204);
    expect(opened).toEqual([join(built, "index.html")]);
    // Not listed on the page, not there, not from the hub's own page: none is opened.
    expect((await open(join(built, "notes.txt"))).status).toBe(404);
    expect((await open(join(built, "gone.html"))).status).toBe(404);
    expect((await open(join(built, "index.html"), "https://elsewhere.example")).status).toBe(403);
    expect(opened).toHaveLength(1);
  } finally {
    hub.stop();
    app.stop(true);
  }
});
