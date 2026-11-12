import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HubState, Todo, WorkDetail, WorkId } from "../src/core/types.ts";
import { MarkStore } from "../src/stores/marks.ts";
import { TodoStore } from "../src/stores/todos.ts";
import { findRemotes, RemoteStore } from "../src/stores/remote.ts";
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
  const detail = (await (await get("/api/work/alpha")).json()) as WorkDetail;
  const item = detail.body.sections[0]?.items[0];
  expect(item?.titleHtml as string | undefined).toBe("Pick one");
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

test("a hub shows another machine's work beside its own, fetches its pages and files through itself, and says when it stops answering", async () => {
  const there = join(root, "there");
  const here = join(root, "here");
  mkdirSync(join(there, "remote-work"), { recursive: true });
  mkdirSync(join(here, "local-work"), { recursive: true });
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]), Buffer.from("IHDR"), Buffer.from([0, 0, 0, 2, 0, 0, 0, 1, 8, 6, 0, 0, 0])]);
  writeFileSync(join(there, "remote-work", "shot.png"), png);
  writeFileSync(join(there, "remote-work", "progress.md"), "---\ntitle: Remote work\n---\n\nOn the box. ![Shot](shot.png)\n\n## Goal\n\nBe seen from the laptop.\n\n## Try it\n\n- [App](http://127.0.0.1:5173)\n\n## Needs you\n\n### Pick a region\n\n## Next\n\n- Ship it.\n");
  writeFileSync(join(here, "local-work", "progress.md"), "---\ntitle: Local work\n---\n\nOn the laptop.\n\n## Goal\n\nStay first.\n");
  utimesSync(join(there, "remote-work", "progress.md"), old, old);
  utimesSync(join(here, "local-work", "progress.md"), new Date(old.getTime() - 60_000), new Date(old.getTime() - 60_000));
  const remote = serve({ home: there, port: 0, sources: [] });
  const local = serve({ home: here, port: 0, sources: [], others: [new RemoteStore({ id: "box", label: "Box", url: remote.url.replace("127.0.0.1", "localhost") })] });
  try {
    const state = async () => (await (await fetch(`${local.url}/api/state`)).json()) as HubState;
    for (let tries = 0; tries < 60 && (await state()).works.length < 2; tries++) await Bun.sleep(50);
    const merged = await state();
    expect(merged.works.map((work): (string | null)[] => [work.id, work.title, work.machine])).toEqual([
      ["box~remote-work", "Remote work", "Box"],
      ["local-work", "Local work", null],
    ]);
    expect(merged.needs.map((need): string | null => need.work)).toEqual(["box~remote-work"]);
    expect(merged.plan.map((entry): string[] => [entry.work, entry.state])).toEqual([["box~remote-work", "next"]]);
    expect(merged.stores).toEqual([{ id: "box", label: "Box", health: { ok: true } }]);
    // An address on that machine means that machine, not the one the browser is on.
    expect(merged.works[0]?.links.map((link) => link.href)).toEqual(["http://localhost:5173"]);
    // This machine alone, which is what another hub asks for.
    expect(((await (await fetch(`${local.url}/api/state?own=1`)).json()) as HubState).works.map((work): string => work.id)).toEqual(["local-work"]);

    const detail = (await (await fetch(`${local.url}/api/work/${encodeURIComponent("box~remote-work")}`)).json()) as WorkDetail;
    expect(detail.summary.id as string).toBe("box~remote-work");
    expect(detail.body.summary).toMatch(/src="\/files\/box~remote-work\/shot\.png\?v=\d+"/);
    const file = await fetch(`${local.url}/files/box~remote-work/shot.png`);
    expect([file.status, file.headers.get("content-security-policy"), (await file.arrayBuffer()).byteLength]).toEqual([200, "sandbox", png.length]);
    expect((await fetch(`${local.url}/files/nobody~remote-work/shot.png`)).status).toBe(404);
    // The address with the file's time on it may be kept by the browser. A file that is not there never is, so it is asked for again.
    expect((await fetch(`${local.url}/files/box~remote-work/shot.png?v=1`)).headers.get("cache-control")).toContain("immutable");
    const missing = await fetch(`${local.url}/files/box~remote-work/gone.png?v=1`);
    expect([missing.status, missing.headers.get("cache-control")]).toEqual([404, "no-cache"]);
    const media = (await (await fetch(`${local.url}/api/media`)).json()) as { work: string; src: string }[];
    expect(media.map((item) => [item.work, item.src])).toEqual([["box~remote-work", "/files/box~remote-work/shot.png"]]);
    // Read again once the machine is gone: what it last said stays, and the store says it can't be reached.
    const direct = new RemoteStore({ id: "box", label: "Box", url: remote.url });
    direct.refresh();
    for (let tries = 0; tries < 60 && direct.state() === null; tries++) await Bun.sleep(25);
    remote.stop();
    direct.refresh(new Date(Date.now() + 60_000));
    for (let tries = 0; tries < 200 && direct.state()?.health.ok; tries++) await Bun.sleep(25);
    expect(direct.state()?.health.ok).toBe(false);
    expect(direct.state()?.works.map((work): string => work.id)).toEqual(["box~remote-work"]);
  } finally {
    remote.stop();
    local.stop();
  }
});

test("the machines to read are the ones a harness is linked to and the ones named, each once and never this one", () => {
  const linked = { id: "t", label: "T", detect: () => null, read: () => { throw new Error("unused"); }, link: () => null, machines: () => [{ id: "e1", label: "box-node", host: "t3-boat-1.tail1234.ts.net" }, { id: "e2", label: "me", host: "mac.tail1234.ts.net" }] };
  expect(findRemotes([linked], 4747, new Set(["127.0.0.1", "localhost", "mac.tail1234.ts.net"]), { PROGRESS_PEERS: "Studio=http://studio.tail1234.ts.net:4800/, http://t3-boat-1.tail1234.ts.net:4747" })).toEqual([
    { id: "studio", label: "Studio", url: "http://studio.tail1234.ts.net:4800" },
    { id: "t3-boat-1", label: "t3-boat-1", url: "http://t3-boat-1.tail1234.ts.net:4747" },
  ]);
});

test("a peer's file is served under the hub's own rules, a peer can't send the hub elsewhere, and a peer that answers badly breaks nothing", async () => {
  const secret = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("only this machine may read this") });
  // A peer that sends no safety headers, redirects, and answers the media list with something that is not JSON.
  const rogue = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      const path = new URL(req.url).pathname;
      if (path === "/files/w/page.html") return new Response("<script>1</script>", { headers: { "Content-Type": "text/html" } });
      if (path === "/files/w/elsewhere.png") return Response.redirect(`http://127.0.0.1:${secret.port}/`, 302);
      if (path === "/api/media") return new Response("<html>not json", { headers: { "Content-Type": "application/json" } });
      return new Response("Not found", { status: 404 });
    },
  });
  const own = join(root, "alone");
  mkdirSync(join(own, "mine"), { recursive: true });
  writeFileSync(join(own, "mine", "shot.png"), "x");
  writeFileSync(join(own, "mine", "progress.md"), "---\ntitle: Mine\n---\n\nGoal: stay up. ![Shot](shot.png)\n");
  utimesSync(join(own, "mine", "progress.md"), old, old);
  const hub = serve({ home: own, port: 0, sources: [], others: [new RemoteStore({ id: "rogue", label: "Rogue", url: `http://127.0.0.1:${rogue.port}` })] });
  try {
    const page = await fetch(`${hub.url}/files/rogue~w/page.html`);
    expect([page.status, page.headers.get("content-security-policy"), page.headers.get("x-content-type-options")]).toEqual([200, "sandbox allow-scripts", "nosniff"]);
    const sent = await fetch(`${hub.url}/files/rogue~w/elsewhere.png`);
    expect([sent.status, await sent.text()]).toEqual([502, "That machine did not answer."]);
    // The hub's own media still list, whatever the peer said.
    const media = await fetch(`${hub.url}/api/media`);
    expect([media.status, ((await media.json()) as { src: string }[]).map((item) => item.src)]).toEqual([200, ["/files/mine/shot.png"]]);
  } finally {
    hub.stop();
    rogue.stop(true);
    secret.stop(true);
  }
});

test("two machines never share an id, whatever their addresses look like", () => {
  const none = new Set<string>();
  expect(findRemotes([], 4747, none, { PROGRESS_PEERS: "http://100.64.0.1:4747,http://100.64.0.2:4747,http://box.one.ts.net:4747,http://box.two.ts.net:4747,http://box.one.ts.net:4800" }).map((peer) => peer.id)).toEqual(["100-64-0-1", "100-64-0-2", "box", "box-2", "box-3"]);
});

test("what a peer sends is checked before the hub relies on it, and its addresses are made safe by field, not by spelling", async () => {
  let state: unknown = {};
  const body = `<p><img src='/files/w/one.png'><img src="/files/w/two.png"><a href="/files/w/doc.pdf">doc</a> /files/ in words stays</p>`;
  const work = { id: "w", title: "W", project: null, machine: null, settled: false, lastChangeAt: "2026-11-10T09:00:00.000Z", preview: "", summary: "/files/ in a summary stays", goal: "", needsCount: 0, workingAgents: 0, agents: 0, pullRequests: { total: 0, merged: 0 }, shipped: 0, threadLink: "javascript:alert(1)", links: [{ label: "App", url: "http://localhost:3000", href: "http://localhost:3000", up: true }, { label: "Bad", url: "javascript:alert(1)", href: "javascript:alert(1)", up: null }] };
  const good = { works: [work], needs: [], plan: [], feed: [], latestMedia: null, sources: [], health: { ok: true } };
  const peer = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      const path = new URL(req.url).pathname;
      if (path === "/api/state") return Response.json(state);
      if (path === "/api/work/w") return Response.json({ summary: work, body: { goal: body, summary: body, sections: [] }, agents: [], pullRequests: [], feed: [], notes: [] });
      if (path === "/api/work/empty") return Response.json({});
      if (path === "/api/media") return Response.json([null]);
      return new Response("Not found", { status: 404 });
    },
  });
  const at = { id: "p", label: "P", url: `http://127.0.0.1:${peer.port}` };
  const settle = async (store: RemoteStore, done: () => boolean) => {
    store.refresh(new Date(Date.now() + 120_000));
    for (let tries = 0; tries < 200 && !done(); tries++) await Bun.sleep(10);
  };
  try {
    // Answers that are JSON but not a state: an empty object, and a stalled agent with no stall. Neither is kept.
    for (const wrong of [{}, { ...good, needs: [{ source: "stall", work: null, stall: null }, { source: "stall", work: null, stall: null }] }]) {
      state = wrong;
      const store = new RemoteStore(at);
      await settle(store, () => store.version > 0);
      expect(store.state()).toBeNull();
    }

    state = good;
    const store = new RemoteStore(at);
    await settle(store, () => store.state() !== null);
    const [seen] = store.state()?.works ?? [];
    // A link the browser would run is dropped, plain words that look like a path stay, and the thread link is emptied.
    expect(seen?.links.map((link) => link.label)).toEqual(["App"]);
    expect([seen?.threadLink, seen?.summary]).toEqual(["", "/files/ in a summary stays"]);

    const detail = await store.detail("p~w" as WorkId);
    const html = detail?.body.goal ?? "";
    // Written with single quotes, which a text replace on `"/files/` missed.
    expect(html).toContain(`src="/files/p~w/one.png"`);
    expect(html).toContain(`src="/files/p~w/two.png"`);
    expect(html).toContain(`href="/files/p~w/doc.pdf"`);
    expect(html).toContain("/files/ in words stays");
    expect(await store.detail("p~empty" as WorkId)).toBeNull();
    expect(await store.media()).toEqual([]);
  } finally {
    peer.stop(true);
  }
});
