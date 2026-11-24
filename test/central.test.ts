import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HubState, Instant, NeedEntry, PlanEntry, PullRequest, SessionRef, WorkDetail } from "../src/core/types.ts";
import { CentralHub, type HubContext, type Kv } from "../src/central/hub.ts";
import { base64url, GOOGLE_CERTS_URL, makeCredential, makeOrder, makeSession, ORDER_SEC } from "../src/central/login.ts";
import { FORMAT, MACHINES_PATH, MOST_FILE_BYTES, MOST_FILES, MOST_MACHINE_BYTES, MOST_MACHINES, MOST_MARK_KEY_CHARS, MOST_MARK_KEYS, MOST_MARKS_BYTES, MOST_ORDERS, MOST_PAGES, MOST_ROW_BYTES, MOST_SEND_BYTES, MOST_SEND_ZIPPED, type Answer, type Forgotten, type HeldMachine, type StateSend } from "../src/central/protocol.ts";
import { linkTo, readLink, Sender } from "../src/central/send.ts";
import { handle, type Env } from "../src/central/worker.ts";
import { serve } from "../src/server/serve.ts";
import { MarkStore } from "../src/stores/marks.ts";
import { planCards } from "../src/web/lib/board.ts";
import { needKey } from "../src/web/lib/needs.ts";
import type { StoreState } from "../src/stores/store.ts";

// ---------------------------------------------------------------- The Worker, with Cloudflare's parts kept in memory

function memoryHub(): { ctx: HubContext; kv: Map<string, string>; heard: string[] } {
  const kv = new Map<string, string>();
  // What the pages that listen were told.
  const heard: string[] = [];
  const store: Kv = {
    get: (key) => kv.get(key),
    put: (key, value) => void kv.set(key, value),
    delete: (key) => kv.delete(key),
    list: ({ prefix, limit }) =>
      [...kv.entries()]
        .filter(([key]) => key.startsWith(prefix))
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .slice(0, limit),
  };
  return {
    kv,
    heard,
    ctx: {
      storage: {
        kv: store,
        // All or nothing, as the Durable Object's own is.
        transactionSync(run) {
          const before = new Map(kv);
          try {
            return run();
          } catch (error) {
            kv.clear();
            for (const [key, value] of before) kv.set(key, value);
            throw error;
          }
        },
        setAlarm: () => undefined,
      },
      getWebSockets: () => [{ send: (message) => void heard.push(message) }],
      acceptWebSocket: () => undefined,
    },
  };
}

const MACHINE_KEY = "machine-key-0123456789-abcdefghijklmnopqrstu";

/** A central hub: its Worker's environment, with the Durable Object, the bucket and the limiter kept in memory. */
function makeCentral() {
  const memory = memoryHub();
  const bucket = new Map<string, Uint8Array<ArrayBuffer>>();
  const calls = { put: 0, head: 0, list: 0, refused: 0, failUploads: false, allowSignIns: Infinity, signIns: 0, headWaits: null as Promise<void> | null, putWaits: null as Promise<void> | null };
  const files: Env["FILES"] = {
    get: async (key) => (bucket.has(key) ? { body: new Response(bucket.get(key)).body! } : null),
    head: async (key) => {
      calls.head++;
      await calls.headWaits;
      return bucket.has(key) ? {} : null;
    },
    list: async ({ prefix, cursor }) => {
      calls.list++;
      const keys = [...bucket.keys()].filter((key) => key.startsWith(prefix)).sort();
      const from = Number(cursor ?? 0);
      const objects = keys.slice(from, from + 1000).map((key) => ({ key }));
      return from + 1000 < keys.length ? { objects, truncated: true, cursor: String(from + 1000) } : { objects, truncated: false };
    },
    delete: async (keys) => {
      for (const key of keys) bucket.delete(key);
    },
    async put(key, body, { sha256 }) {
      calls.put++;
      await calls.putWaits;
      if (calls.failUploads) {
        calls.refused++;
        throw new Error("Cut short.");
      }
      const bytes = new Uint8Array(await new Response(body).arrayBuffer());
      if (new Bun.CryptoHasher("sha256").update(bytes).digest("hex") !== sha256) throw new Error("Checksum mismatch.");
      bucket.set(key, bytes);
    },
  };
  const hub = new CentralHub(memory.ctx, files);
  const env: Env = {
    HUB: { idFromName: () => "hub", get: () => ({ fetch: (request: Request) => hub.fetch(request) }) },
    FILES: files,
    ASSETS: { fetch: async () => new Response("<!doctype html><title>The app</title><div id=root></div>", { headers: { "Content-Type": "text/html", ETag: '"app"' } }) },
    MACHINE_KEY,
    SESSION_KEY: "session-key-0123456789-abcdefghijklmnopqrstu",
    GOOGLE_CLIENT_ID: "test-client.apps.googleusercontent.com",
    ALLOWED_EMAILS: "Owner@Gmail.com, team@example.com, someone@elsewhere.example",
    SIGN_IN_LIMIT: { limit: async () => ({ success: ++calls.signIns <= calls.allowSignIns }) },
  };
  return { env, kv: memory.kv, heard: memory.heard, bucket, calls };
}

const main = makeCentral();
const { env } = main;
const central = Bun.serve({ port: 0, fetch: (request) => handle(request, env) });
const at = central.url.origin;

// Google, as far as the hub asks it anything: its signing keys. The tokens are signed here with a key of our own.
const google = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
const jwk = { ...(await crypto.subtle.exportKey("jwk", google.publicKey)), kid: "test-key", alg: "RS256", use: "sig" };
const realFetch = globalThis.fetch;
globalThis.fetch = Object.assign((input: RequestInfo | URL, init?: RequestInit) => (String(input) === GOOGLE_CERTS_URL ? Promise.resolve(Response.json({ keys: [jwk] })) : realFetch(input, init)), realFetch);

async function idToken(claims: Record<string, unknown>): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const head = base64url(new TextEncoder().encode(JSON.stringify({ alg: "RS256", kid: "test-key", typ: "JWT" })));
  const body = base64url(new TextEncoder().encode(JSON.stringify({ iss: "https://accounts.google.com", aud: env.GOOGLE_CLIENT_ID, sub: "1", email: "owner@gmail.com", email_verified: true, iat: now, exp: now + 3600, ...claims })));
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", google.privateKey, new TextEncoder().encode(`${head}.${body}`));
  return `${head}.${body}.${base64url(signature)}`;
}

const nonce = async () => ((await (await fetch(`${at}/auth/nonce`, { method: "POST", headers: { Origin: at } })).json()) as { nonce: string }).nonce;
const signIn = (credential: string, origin = at) => fetch(`${at}/auth/google`, { method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify({ credential }) });
let cookie = "";
const get = (path: string, headers: Record<string, string> = { Cookie: cookie }) => fetch(at + path, { headers });

// ---------------------------------------------------------------- A machine, with a hub that sends to the central one

const root = mkdtempSync(join(tmpdir(), "progress-central-"));
const home = join(root, "home");
mkdirSync(join(home, "alpha", "images"), { recursive: true });
mkdirSync(join(home, "notes"), { recursive: true });
writeFileSync(join(home, "alpha", "images", "a b.png"), "png bytes");
writeFileSync(join(home, "alpha", "mock.html"), "<p>mock</p>");
// Named only in the page's words and in a todo: never a file the page shows.
writeFileSync(join(home, "alpha", "secret.txt"), "only mentioned");
// Shown by the page, but its real path is outside the work's folder.
writeFileSync(join(home, "notes", "private.png"), "private bytes");
symlinkSync(join(home, "notes", "private.png"), join(home, "alpha", "leak.png"));
writeFileSync(
  join(home, "alpha", "progress.md"),
  "---\ntitle: Alpha\n---\n\nWhere it stands. The notes are at /files/alpha/secret.txt and `/files/alpha/secret.txt`.\n\n## Needs you\n\n### Pick one\n\n![Option A](mock.html)\n![Shot](images/a%20b.png)\n![Leak](leak.png)\n\n## Next\n\n- The second part.\n\n## Shipped\n\n- The first part.\n",
);
const old = new Date(Date.now() - 60_000);
utimesSync(join(home, "alpha", "progress.md"), old, old);
writeFileSync(join(home, ".marks.json"), JSON.stringify({ viewed: ["alpha/shipped/the-first-part", "https://github.com/acme/app/pull/7", "elsewhere~beta/x"], dismissed: ["alpha:needs/pick-one", "stall:t3:someone-elses"] }));
writeFileSync(join(home, ".todos.json"), JSON.stringify([{ id: "t1", text: "Read /files/alpha/secret.txt", description: "", work: "alpha", project: null, addedAt: "2026-11-20T10:00:00Z", doneAt: null }]));
const linkPath = join(root, "central");

let machine: ReturnType<typeof serve>;
let id = "";

beforeAll(async () => {
  const link = await linkTo(at, await makeCredential(MACHINE_KEY, "alpha-box-1234"), linkPath);
  id = link.machine;
  machine = serve({ home, port: 0, sources: [], central: link });
});

afterAll(() => {
  machine?.stop();
  central.stop();
  globalThis.fetch = realFetch;
});

async function until<T>(read: () => Promise<T | null>, ms = 8000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const value = await read();
    if (value !== null) return value;
    if (Date.now() > end) throw new Error("Timed out.");
    await Bun.sleep(100);
  }
}

const shown = async () => (await (await get("/api/state")).json()) as HubState;

/** A machine's send, as the sender makes it, gzipped, with that machine's credential. */
const sendAs = async (machineId: string, body: unknown, to: (request: Request) => Promise<Response> = (request) => fetch(request)) => {
  const zipped = Bun.gzipSync(JSON.stringify(body));
  return to(new Request(`${at}/api/machine`, { method: "POST", headers: { Authorization: `Bearer ${await makeCredential(MACHINE_KEY, machineId)}`, "Content-Length": String(zipped.length) }, body: zipped }));
};

/** This test machine's own state and pages, as its hub answers them, to send under another machine's credential. */
async function ownSend(at: number, change: (state: StoreState) => StoreState = (state) => state): Promise<StateSend & { bodies: Record<string, string> }> {
  const state = change((await (await fetch(`${machine.url}/api/state?own=1`)).json()) as StoreState);
  const pages: Record<string, string> = {};
  const bodies: Record<string, string> = {};
  for (const work of state.works) {
    const text = await (await fetch(`${machine.url}/api/work/${encodeURIComponent(work.id)}`)).text();
    bodies[work.id] = text;
    pages[work.id] = new Bun.CryptoHasher("sha256").update(text).digest("hex");
  }
  return { format: FORMAT, kind: "state", label: "other", at, state: { store: state, media: [], marks: { viewed: [], dismissed: [] }, todos: [] }, pages, bodies, files: [] };
}

const EMPTY: StoreState = { works: [], needs: [], plan: [], shipped: [], feed: [], latestMedia: null, sources: [], health: { ok: true } };
const emptySend = (at: number): StateSend => ({ format: FORMAT, kind: "state", label: "empty", at, state: { store: EMPTY, media: [], marks: { viewed: [], dismissed: [] }, todos: [] }, pages: {}, files: [] });

// ---------------------------------------------------------------- The closed door

test("signed out, every route gives the sign-in page or 401, and nothing of any page", async () => {
  const page = await get("/", {});
  expect(page.status).toBe(401);
  const html = await page.text();
  expect(html).toContain("Sign in to see your work.");
  expect(html).toContain(env.GOOGLE_CLIENT_ID);
  expect(html).not.toContain("The app");
  expect(page.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
  expect((await get("/w/alpha/board", {})).status).toBe(401);
  for (const path of ["/api/state", "/api/media", "/api/work/x~alpha", "/files/x~alpha/images/a.png", "/api/events", "/index-abc.js"]) {
    const response = await get(path, {});
    expect([path, response.status]).toEqual([path, 401]);
    expect(await response.text()).not.toContain("Alpha");
  }
});

test("a forged, expired or unallowed session cookie is no session", async () => {
  const now = Math.floor(Date.now() / 1000);
  const forged = `__Host-progress=${(await makeSession("another-key-0123456789-abcdefghijklmnopq", "owner@gmail.com", now)).toString()}`;
  const expired = `__Host-progress=${await makeSession(env.SESSION_KEY, "owner@gmail.com", now - 31 * 24 * 3600)}`;
  const stranger = `__Host-progress=${await makeSession(env.SESSION_KEY, "stranger@gmail.com", now)}`;
  const tampered = `__Host-progress=${(await makeSession(env.SESSION_KEY, "owner@gmail.com", now)).replace(/^[^.]+/, base64url(new TextEncoder().encode("team@example.com")))}`;
  for (const value of [forged, expired, stranger, tampered, "__Host-progress=garbage"]) {
    expect((await get("/api/state", { Cookie: value })).status).toBe(401);
    expect((await get("/", { Cookie: value })).status).toBe(401);
  }
});

test("the machine routes take only a credential this hub's key made, and a credential opens nothing else", async () => {
  const hello = Bun.gzipSync(JSON.stringify({ format: FORMAT, kind: "hello" }));
  const send = (headers: Record<string, string>) => fetch(`${at}/api/machine`, { method: "POST", headers, body: hello }).then((r) => r.status);
  const credential = await makeCredential(MACHINE_KEY, "box-1234");
  expect(await send({})).toBe(401);
  expect(await send({ Authorization: "Bearer wrong" })).toBe(401);
  expect(await send({ Authorization: `Bearer ${await makeCredential("another-key-0123456789-abcdefghijklmnopqrstu", "box-1234")}` })).toBe(401);
  // The signature is for one id: put another id in front of it and it is no credential.
  expect(await send({ Authorization: `Bearer ${credential.replace("box-1234", id)}` })).toBe(401);
  expect(await send({ Cookie: cookie })).toBe(401);
  expect(await send({ Authorization: `Bearer ${credential}` })).toBe(200);
  const upload = (headers: Record<string, string>) => fetch(`${at}/api/machine/files/${"0".repeat(64)}`, { method: "PUT", headers, body: "x" }).then((r) => r.status);
  expect(await upload({})).toBe(401);
  expect(await upload({ Authorization: "Bearer wrong" })).toBe(401);
  expect((await get("/api/state", { Authorization: `Bearer ${credential}` })).status).toBe(401);
});

// ---------------------------------------------------------------- Signing in

test("signing in with Google: only a fresh token for this client, with a nonce this hub made, for an allowed address Google owns", async () => {
  expect((await signIn(await idToken({ nonce: await nonce() }), "https://elsewhere.example")).status).toBe(403);
  expect((await signIn(await idToken({ nonce: await nonce(), aud: "another.apps.googleusercontent.com" }))).status).toBe(401);
  expect((await signIn(await idToken({ nonce: await nonce(), iss: "https://evil.example" }))).status).toBe(401);
  expect((await signIn(await idToken({ nonce: await nonce(), exp: Math.floor(Date.now() / 1000) - 3600 }))).status).toBe(401);
  expect((await signIn(await idToken({ nonce: await nonce(), email_verified: false }))).status).toBe(401);
  expect((await signIn(await idToken({}))).status).toBe(401);
  expect((await signIn(await idToken({ nonce: "pn_made-up.9999999999.signature" }))).status).toBe(401);
  const forged = (await idToken({ nonce: await nonce(), email: "team@example.com", hd: "example.com" })).replace(/\.[^.]+$/, `.${base64url(new Uint8Array(256))}`);
  expect((await signIn(forged)).status).toBe(401);
  expect((await signIn(await idToken({ nonce: await nonce(), email: "stranger@gmail.com" }))).status).toBe(403);
  // An allowed address Google is not the authority for: it may have changed hands since the account verified it.
  expect((await signIn(await idToken({ nonce: await nonce(), email: "someone@elsewhere.example" }))).status).toBe(403);
  expect((await signIn(await idToken({ nonce: await nonce(), email: "team@example.com" }))).status).toBe(403);
  expect((await signIn(await idToken({ nonce: await nonce(), email: "team@example.com", hd: "other.example" }))).status).toBe(403);
  expect((await signIn(await idToken({ nonce: await nonce(), email: "team@example.com", hd: "example.com" }))).status).toBe(204);

  const token = await idToken({ nonce: await nonce(), email: "OWNER@gmail.com" });
  const answer = await signIn(token);
  expect(answer.status).toBe(204);
  const set = answer.headers.get("set-cookie") ?? "";
  expect(set).toMatch(/^__Host-progress=[^;]+; Path=\/; Max-Age=\d+; HttpOnly; Secure; SameSite=Lax$/);
  cookie = set.split(";")[0] ?? "";
  // A token signs in once, and so does a nonce.
  expect((await signIn(token)).status).toBe(401);
  expect((await get("/api/state")).status).toBe(200);
});

test("the sign-in routes read a small body, and are counted per address before anything is checked or kept", async () => {
  const big = await fetch(`${at}/auth/google`, { method: "POST", headers: { Origin: at, "Content-Type": "application/json" }, body: JSON.stringify({ credential: "x".repeat(9000) }) });
  expect(big.status).toBe(401);
  const { env: limited, kv, calls } = makeCentral();
  calls.allowSignIns = 0;
  const post = (path: string, body?: string) => handle(new Request(`https://hub.example${path}`, { method: "POST", headers: { Origin: "https://hub.example", Host: "hub.example" }, ...(body ? { body } : {}) }), limited);
  expect((await post("/auth/nonce")).status).toBe(429);
  const refused = await post("/auth/google", JSON.stringify({ credential: await idToken({ nonce: "n" }) }));
  expect(refused.status).toBe(429);
  expect(refused.headers.get("retry-after")).toBe("60");
  // Nothing was spent or kept for a refused try.
  expect(kv.size).toBe(0);
});

test("signing out clears the cookie and goes back to the sign-in page", async () => {
  const out = await fetch(`${at}/auth/signout`, { method: "POST", headers: { Cookie: cookie, Origin: at }, redirect: "manual" });
  expect(out.status).toBe(303);
  expect(out.headers.get("location")).toBe("/");
  expect(out.headers.get("set-cookie")).toBe("__Host-progress=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax");
  expect((await fetch(`${at}/auth/signout`, { method: "POST", headers: { Cookie: cookie, Origin: "https://elsewhere.example" } })).status).toBe(403);
});

test("signed in, the app is served and no other site may frame it, and the hub takes no change but to the marks", async () => {
  const page = await get("/w/alpha/board");
  expect(page.status).toBe(200);
  expect(await page.text()).toContain("The app");
  expect(page.headers.get("content-security-policy")).toBe("frame-ancestors 'none'");
  expect(page.headers.get("x-frame-options")).toBe("DENY");
  const post = (path: string, body: unknown) => fetch(at + path, { method: "POST", headers: { Cookie: cookie, Origin: at, "Content-Type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.status);
  expect(await post("/api/todos", { op: "add", text: "x" })).toBe(405);
  expect(await post("/api/open", { work: "a", url: "b" })).toBe(405);
  expect(await post("/api/state", {})).toBe(405);
  // The state says so, and the app offers the controls for marks and none for todos.
  expect((await shown()).todosReadOnly).toBe(true);
});

// ---------------------------------------------------------------- What a machine sends

test("a linked machine's hub sends its state, pages and files, and the central hub shows them as that machine's", async () => {
  expect(readLink(linkPath)?.machine).toBe(id);
  expect((statSync(linkPath).mode & 0o777).toString(8)).toBe("600");
  const state = await until(async () => {
    const answer = await shown();
    return answer.works.some((work) => work.id === `${id}~alpha`) ? answer : null;
  });
  expect(state.todosReadOnly).toBe(true);
  expect(state.signedIn).toBe(true);
  expect(state.works.map((work) => work.id as string)).toContain(`${id}~alpha`);
  expect(state.stores.find((store) => store.id === id)?.health.ok).toBe(true);
  // Marks and todos come with the machine's work. A mark on another machine's work is that machine's to send, and
  // a mark on a pull request or a stalled thread is about this machine's own.
  expect(state.marks).toEqual({ viewed: [`${id}~alpha/shipped/the-first-part`, `${id}~https://github.com/acme/app/pull/7`], dismissed: [`${id}~alpha:needs/pick-one`, `stall:${id}~t3:someone-elses`] });
  expect(state.todos.map((todo) => todo.work)).toEqual([`${id}~alpha`] as never[]);
  const need = state.needs.find((entry) => entry.work === `${id}~alpha`);
  expect(need?.source === "page" && need.html).toContain(`src="/files/${id}~alpha/mock.html"`);

  const detail = (await (await get(`/api/work/${encodeURIComponent(`${id}~alpha`)}`)).json()) as WorkDetail;
  expect(detail.summary.title).toBe("Alpha");
  expect((await get("/api/work/alpha")).status).toBe(404);

  // Files come with the headers the machine's own hub gives them, but for how long they are kept.
  const picture = await get(`/files/${id}~alpha/images/a%20b.png?v=1`);
  expect(await picture.text()).toBe("png bytes");
  const local = await fetch(`${machine.url}/files/alpha/images/a%20b.png?v=1`);
  for (const header of ["content-type", "x-content-type-options"]) expect([header, picture.headers.get(header)]).toEqual([header, local.headers.get(header)]);
  const mock = await get(`/files/${id}~alpha/mock.html`);
  expect(await mock.text()).toBe("<p>mock</p>");
  // Only what the machine's pages show is served.
  expect((await get(`/files/${id}~alpha/progress.md`)).status).toBe(404);
  expect((await get(`/files/${id}~alpha/images/a b.png`)).status).toBe(200);
});

test("the sender publishes no file that is only mentioned in text, nor one whose real path leaves its work's folder", async () => {
  await until(async () => ((await shown()).works.some((work) => work.id === `${id}~alpha`) ? true : null));
  expect((await get(`/files/${id}~alpha/secret.txt`)).status).toBe(404);
  expect((await get(`/files/${id}~alpha/leak.png`)).status).toBe(404);
  const stored = new Set([...main.bucket.values()].map((bytes) => new TextDecoder().decode(bytes)));
  expect(stored.has("only mentioned")).toBe(false);
  expect(stored.has("private bytes")).toBe(false);
  expect(stored.has("png bytes")).toBe(true);
});

test("an HTML page a machine published may show itself and nothing else, and only the hub may frame it", async () => {
  await until(async () => ((await shown()).works.some((work) => work.id === `${id}~alpha`) ? true : null));
  const csp = (await get(`/files/${id}~alpha/mock.html`)).headers.get("content-security-policy") ?? "";
  expect(csp).toStartWith("sandbox allow-scripts;");
  expect(csp).toContain("default-src 'none'");
  expect(csp).toContain("frame-ancestors 'self'");
  expect(csp).not.toMatch(/https?:|\*/);
  const picture = (await get(`/files/${id}~alpha/images/a%20b.png`)).headers.get("content-security-policy") ?? "";
  expect(picture).toStartWith("sandbox;");
  expect(picture).toContain("frame-ancestors 'self'");
});

test("every signed-in answer says no cache may keep it, and a file is kept only to be asked for again", async () => {
  await until(async () => ((await shown()).works.some((work) => work.id === `${id}~alpha`) ? true : null));
  for (const path of ["/", "/w/alpha/board", "/api/state", "/api/media", `/api/work/${encodeURIComponent(`${id}~alpha`)}`, "/api/work/nothing", `/files/${id}~alpha/nothing.png`, "/api/nothing"]) {
    const response = await get(path);
    // The app's own page has an ETag too, and is still kept nowhere.
    expect([path, response.headers.get("cache-control"), response.headers.get("vary")]).toEqual([path, "private, no-store", "Cookie"]);
    await response.body?.cancel();
  }
  for (const [path, headers] of [["/api/state", {}], ["/", {}], [`/files/${id}~alpha/mock.html`, {}], ["/api/marks", { Cookie: cookie }]] as const) {
    const response = await fetch(at + path, { method: path === "/api/marks" ? "POST" : "GET", headers });
    // A change to marks from no page of the hub's own is refused.
    expect([path, response.status, response.headers.get("cache-control"), response.headers.get("vary")]).toEqual([path, path === "/api/marks" ? 403 : 401, "private, no-store", "Cookie"]);
  }
  const file = await get(`/files/${id}~alpha/images/a%20b.png?v=9`);
  expect(file.headers.get("cache-control")).toBe("private, no-cache");
  expect(file.headers.get("vary")).toBe("Cookie");
  const tag = file.headers.get("etag") ?? "";
  expect(tag).toMatch(/^"[0-9a-f]{64}"$/);
  // A copy the browser kept is good again only with a session.
  expect((await get(`/files/${id}~alpha/images/a%20b.png`, { Cookie: cookie, "If-None-Match": tag })).status).toBe(304);
  const stranger = await get(`/files/${id}~alpha/images/a%20b.png`, { "If-None-Match": tag });
  expect(stranger.status).toBe(401);
  expect(await stranger.text()).not.toContain("png");
});

test("an answer that fails on the way is a plain error no cache keeps", async () => {
  const { env: hubEnv } = makeCentral();
  const broken: Env = { ...hubEnv, ASSETS: { fetch: () => Promise.reject(new Error("The build is gone.")) } };
  const answer = await handle(new Request("https://hub.example/index.html", { headers: { Cookie: await sessionFor(hubEnv) } }), broken);
  expect([answer.status, answer.headers.get("cache-control"), await answer.text()]).toEqual([500, "private, no-store", "The hub could not answer. Try again."]);
});

test("a send whose files could not all be uploaded leaves the last complete state showing", async () => {
  const before = await until(async () => (await shown()).works.find((work) => work.id === `${id}~alpha`) ?? null);
  main.calls.failUploads = true;
  writeFileSync(join(home, "alpha", "images", "new.png"), "new bytes");
  writeFileSync(join(home, "alpha", "progress.md"), readFileSync(join(home, "alpha", "progress.md"), "utf8").replace("Where it stands.", "Where it stands now.\n\n![New](images/new.png)"));
  await until(async () => (main.calls.refused > 0 ? true : null), 20_000);
  const during = (await shown()).works.find((work) => work.id === `${id}~alpha`);
  expect(during?.preview).toBe(before.preview);
  main.calls.failUploads = false;
  const after = await until(async () => {
    const work = (await shown()).works.find((entry) => entry.id === `${id}~alpha`);
    return work && work.preview !== before.preview ? work : null;
  }, 40_000);
  expect(after.preview).toStartWith("Where it stands now.");
  expect(await (await get(`/files/${id}~alpha/images/new.png`)).text()).toBe("new bytes");
}, 60_000);

test("after a restart, a machine whose state the hub holds sends once", async () => {
  await until(async () => ((await shown()).works.some((work) => work.id === `${id}~alpha`) ? true : null));
  const posts: string[] = [];
  const counting = (async (input: RequestInfo | URL, init?: RequestInit) => {
    posts.push(`${init?.method ?? "GET"} ${new URL(String(input)).pathname}`);
    return fetch(input, init);
  }) as typeof fetch;
  const sender = new Sender({ link: readLink(linkPath)!, own: machine.own, extras: () => ({ marks: { viewed: [], dismissed: [] }, todos: [] }), changes: () => "restarted", fetch: counting, log: () => undefined });
  expect(await sender.run()).toBe(true);
  expect(posts).toEqual(["POST /api/machine"]);
});

test("a linked hub's state says whether its sends reach the central hub, since when they don't, and why", async () => {
  const said = async () => ((await (await fetch(`${machine.url}/api/state`)).json()) as HubState).machine;
  expect(await said()).toEqual({ label: expect.any(String), central: { url: at, health: { ok: true } } });

  let up = false;
  const flaky = ((input: RequestInfo | URL, init?: RequestInit) => (up ? fetch(input, init) : Promise.reject(new Error("The hub is unplugged.")))) as typeof fetch;
  const sender = new Sender({ link: readLink(linkPath)!, own: machine.own, extras: () => ({ marks: { viewed: [], dismissed: [] }, todos: [] }), changes: () => "flaky", fetch: flaky, log: () => undefined });
  expect(sender.status()).toEqual({ url: at, health: { ok: true } });
  expect(await sender.run()).toBe(false);
  const down = sender.status().health;
  // Whatever the runtime said of a hub it could not reach, the reason is in plain words.
  expect(down).toEqual({ ok: false, since: expect.any(String), reason: "It did not answer." });
  // Still down for the same reason: it says the same, so no page is told again.
  expect(await sender.run()).toBe(false);
  expect(sender.status().health).toEqual(down);
  up = true;
  expect(await sender.run()).toBe(true);
  expect(sender.status().health).toEqual({ ok: true });
});

// ---------------------------------------------------------------- What one machine can make the hub do

test("one machine's credential writes only that machine: its works, files and name", async () => {
  const before = await until(async () => {
    const state = await shown();
    return state.works.some((work) => work.id === `${id}~alpha`) ? state : null;
  });
  const label = before.works.find((work) => work.id === `${id}~alpha`)?.machine;
  const other = await sendAs("other-5678", await ownSend(Date.now()));
  expect(other.status).toBe(200);
  const after = await shown();
  expect(after.works.map((work) => work.id as string)).toContain("other-5678~alpha");
  // Its own works are untouched, and so is its name.
  expect(after.works.find((work) => work.id === `${id}~alpha`)).toEqual(before.works.find((work) => work.id === `${id}~alpha`)!);
  expect(after.works.find((work) => work.id === `${id}~alpha`)?.machine).toBe(label!);
  // An upload has no machine in its address: it goes under the machine the credential names, and only for a file that machine's send named.
  const bytes = "planted";
  const digest = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
  const planted = await fetch(`${at}/api/machine/files/${digest}`, { method: "PUT", headers: { Authorization: `Bearer ${await makeCredential(MACHINE_KEY, "other-5678")}` }, body: bytes });
  expect(planted.status).toBe(403);
  expect([...main.bucket.keys()].some((key) => key.endsWith(digest))).toBe(false);
});

test("an upload is taken only for a file a pending send of that machine named, at the size it named, once", async () => {
  const { env: hubEnv, bucket } = makeCentral();
  const call = (request: Request) => handle(request, hubEnv);
  const bytes = "named bytes";
  const digest = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
  const upload = async (machineId: string, body: string) =>
    (await call(new Request(`https://hub.example/api/machine/files/${digest}`, { method: "PUT", headers: { Authorization: `Bearer ${await makeCredential(MACHINE_KEY, machineId)}`, "Content-Length": String(body.length) }, body }))).status;
  expect(await upload("box-1", bytes)).toBe(403);
  // A send naming the file, in a work its state lists.
  const send = emptySend(Date.now());
  const work = (await ownSend(1)).state.store.works[0]!;
  const named = { ...send, state: { ...send.state, store: { ...EMPTY, works: [work] } }, pages: { [work.id]: "0".repeat(64) }, files: [{ path: `${work.id}/x.txt`, digest, size: bytes.length, type: "text/plain" }] };
  const answer = await sendAs("box-1", named, call);
  expect(((await answer.json()) as { missing: { files: string[] } }).missing.files).toEqual([digest]);
  expect(await upload("box-2", bytes)).toBe(403);
  expect(await upload("box-1", `${bytes}!`)).toBe(403);
  expect(await upload("box-1", bytes)).toBe(204);
  expect(await upload("box-1", bytes)).toBe(403);
  expect([...bucket.keys()]).toEqual([`files/box-1/${digest}`]);
});

test("an upload that fails uses none of the machine's room", async () => {
  const { env: hubEnv, calls } = makeCentral();
  const call = (request: Request) => handle(request, hubEnv);
  const work = (await ownSend(1)).state.store.works[0]!;
  const digest = "a".repeat(64);
  const send = emptySend(0);
  calls.failUploads = true;
  // More failed uploads of the largest file than the machine's room holds.
  for (let tries = 0; tries <= MOST_MACHINE_BYTES / MOST_FILE_BYTES; tries++) {
    const named = { ...send, at: Date.now() + tries, state: { ...send.state, store: { ...EMPTY, works: [work] } }, pages: { [work.id]: "0".repeat(64) }, files: [{ path: `${work.id}/big.bin`, digest, size: MOST_FILE_BYTES, type: "application/octet-stream" }] };
    expect(((await (await sendAs("box-1", named, call)).json()) as { missing: { files: string[] } }).missing.files).toEqual([digest]);
    const upload = await call(new Request(`https://hub.example/api/machine/files/${digest}`, { method: "PUT", headers: { Authorization: `Bearer ${await makeCredential(MACHINE_KEY, "box-1")}`, "Content-Length": String(MOST_FILE_BYTES) }, body: "cut short" }));
    expect([tries, upload.status]).toEqual([tries, 400]);
  }
});

test("a send that arrives late can't give back the right to upload a file it named", async () => {
  const { env: hubEnv, calls } = makeCentral();
  const call = (request: Request) => handle(request, hubEnv);
  const bytes = "old bytes";
  const digest = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
  const newer = await ownSend(Date.now());
  const work = newer.state.store.works[0]!.id;
  const older = { ...newer, at: newer.at - 1000, files: [{ path: `${work}/old.txt`, digest, size: bytes.length, type: "text/plain" }] };
  // The older send waits on the bucket while the newer one is shown.
  let go = () => {};
  calls.headWaits = new Promise((resolve) => (go = resolve));
  const late = sendAs("box-1", older, call);
  while (calls.head === 0) await Bun.sleep(1);
  calls.headWaits = null;
  expect((await sendAs("box-1", newer, call)).status).toBe(200);
  go();
  expect((await late).status).toBe(409);
  const upload = async (body: string) =>
    (await call(new Request(`https://hub.example/api/machine/files/${new Bun.CryptoHasher("sha256").update(body).digest("hex")}`, { method: "PUT", headers: { Authorization: `Bearer ${await makeCredential(MACHINE_KEY, "box-1")}`, "Content-Length": String(body.length) }, body }))).status;
  expect(await upload(bytes)).toBe(403);
  // Nor take it from a newer send still waiting for its files.
  const fresh = "new bytes";
  const waiting = { ...newer, at: newer.at + 2000, files: [{ path: `${work}/new.txt`, digest: new Bun.CryptoHasher("sha256").update(fresh).digest("hex"), size: fresh.length, type: "text/plain" }] };
  expect((await sendAs("box-1", waiting, call)).status).toBe(200);
  expect((await sendAs("box-1", { ...older, at: newer.at + 1000 }, call)).status).toBe(409);
  expect(await upload(bytes)).toBe(403);
  expect(await upload(fresh)).toBe(204);
});

test("a late send, one that stops half-way, and one that is refused change nothing shown", async () => {
  const { env: hubEnv } = makeCentral();
  const call = (request: Request) => handle(request, hubEnv);
  const now = Date.now();
  const first = await ownSend(now);
  expect((await sendAs("box-1", first, call)).status).toBe(200);
  const read = async () => (await (await call(new Request("https://hub.example/api/state", { headers: { Cookie: await sessionFor(hubEnv) } }))).json()) as HubState;
  const before = await read();
  expect(before.works.map((work) => work.machine)).toEqual(["other"]);
  // Late: read before the state shown.
  const late = await sendAs("box-1", { ...(await ownSend(now - 1000)), label: "late" }, call);
  expect(late.status).toBe(409);
  // Half-way: a page the hub lacks, never sent.
  const half = { ...(await ownSend(now + 1000)), label: "half" };
  const work = half.state.store.works[0]!.id;
  const halfway = await sendAs("box-1", { ...half, bodies: {}, pages: { [work]: "f".repeat(64) } }, call);
  expect(((await halfway.json()) as { missing: { pages: string[] } }).missing.pages).toEqual([work]);
  // Refused: a state the app could not draw.
  const broken = await sendAs("box-1", { ...(await ownSend(now + 2000)), label: "broken", state: { ...first.state, store: { ...first.state.store, plan: [{ work, workTitle: "x", project: null, state: "next" }] } } }, call);
  expect(broken.status).toBe(400);
  const after = await read();
  expect(after.works).toEqual(before.works);
  expect(after.stores.map((store) => store.label)).toEqual(["other"]);
});

test("a plan entry missing a field the board reads is refused whole, and the machine's last state stays", async () => {
  const { env: hubEnv } = makeCentral();
  const call = (request: Request) => handle(request, hubEnv);
  const good = await ownSend(Date.now());
  expect((await sendAs("box-1", good, call)).status).toBe(200);
  const read = async () => (await (await call(new Request("https://hub.example/api/state", { headers: { Cookie: await sessionFor(hubEnv) } }))).json()) as HubState;
  const before = await read();
  expect(before.plan.length).toBeGreaterThan(0);
  const plan = good.state.store.plan.map((entry, at) => (at === 0 && entry.item ? { ...entry, item: { ...entry.item, prs: undefined } } : entry));
  const answer = await sendAs("box-1", { ...good, at: Date.now() + 1, state: { ...good.state, store: { ...good.state.store, plan } } }, call);
  expect(answer.status).toBe(400);
  expect(await read()).toEqual(before);
  // And a page whose agents lack a field.
  const work = good.state.store.works[0]!.id;
  const page = JSON.parse(good.bodies[work]!) as WorkDetail;
  const broken = JSON.stringify({ ...page, agents: [{ title: "no thread" }] });
  const pages = { ...good.pages, [work]: new Bun.CryptoHasher("sha256").update(broken).digest("hex") };
  expect((await sendAs("box-1", { ...good, at: Date.now() + 2, pages, bodies: { [work]: broken } }, call)).status).toBe(400);
  expect(await read()).toEqual(before);
});

test("an event with a field its kind does not have is refused, and the machine's last state stays", async () => {
  const { env: hubEnv } = makeCentral();
  const call = (request: Request) => handle(request, hubEnv);
  const good = await ownSend(Date.now());
  expect((await sendAs("box-1", good, call)).status).toBe(200);
  const read = async () => (await (await call(new Request("https://hub.example/api/state", { headers: { Cookie: await sessionFor(hubEnv) } }))).json()) as HubState;
  const before = await read();
  const entry = good.state.store.feed[0]!;
  const done = { ...entry, event: { kind: "done", at: entry.at, item: null } };
  const answer = await sendAs("box-1", { ...good, at: Date.now() + 1, state: { ...good.state, store: { ...good.state.store, feed: [done, ...good.state.store.feed] } } }, call);
  expect(answer.status).toBe(400);
  expect(await read()).toEqual(before);
});

test("one machine's marks hide nothing of another's, even on a stalled thread or a pull request both name", async () => {
  const { env: hubEnv } = makeCentral();
  const call = (request: Request) => handle(request, hubEnv);
  const since = "2026-11-24T00:00:00.000Z" as Instant;
  const stall: NeedEntry = { source: "stall", work: null, workTitle: null, project: null, agentTitle: "Asks", stall: { thread: "t3:victim" as SessionRef, ask: "question", text: null, since }, threadLink: null };
  const pr: PullRequest = { url: "https://github.com/acme/app/pull/9", repo: "acme/app", number: 9, title: "Merged", state: "merged", openedAt: since, mergedAt: since };
  const base = await ownSend(Date.now());
  const work = base.state.store.works[0]!;
  const merged: PlanEntry = { work: work.id, workTitle: work.title, project: null, state: "shipped", item: null, pr };
  const sent = (marks: { viewed: string[]; dismissed: string[] }) => ({ ...base, at: Date.now(), state: { ...base.state, marks, store: { ...base.state.store, needs: [stall], shipped: [merged] } } });
  // The other machine copies the thread and the pull request into its own state, and marks them.
  expect((await sendAs("other-1", sent({ viewed: [pr.url], dismissed: ["stall:t3:victim"] }), call)).status).toBe(200);
  expect((await sendAs("victim-1", sent({ viewed: [], dismissed: [] }), call)).status).toBe(200);
  const state = (await (await call(new Request("https://hub.example/api/state", { headers: { Cookie: await sessionFor(hubEnv) } }))).json()) as HubState;
  const dismissed = new Set(state.marks.dismissed);
  const viewed = new Set(state.marks.viewed);
  const machineOf = (key: string) => key.slice(0, key.indexOf("~"));
  expect(state.needs.filter((need) => !dismissed.has(needKey(need))).map((need) => machineOf(needKey(need).slice("stall:".length)))).toEqual(["victim-1"]);
  expect(planCards(state.shipped).flatMap((card) => (card.viewKey !== null && !viewed.has(card.viewKey) ? [machineOf(card.work ?? "")] : []))).toEqual(["victim-1"]);
});

test("a page within the limit as sent is refused when it would pass it as stored", async () => {
  const { env: hubEnv, kv } = makeCentral();
  const call = (request: Request) => handle(request, hubEnv);
  const good = await ownSend(Date.now());
  const work = good.state.store.works[0]!.id;
  // Each file's address gets the machine's id, and its attribute quotes, as the page is made this hub's own.
  const page = JSON.stringify({ ...(JSON.parse(good.bodies[work]!) as WorkDetail), body: { goal: "", summary: "<img src=/files/w/x>".repeat(160_000), sections: [] } });
  expect(page.length).toBeLessThan(MOST_ROW_BYTES);
  const answer = await sendAs("m".repeat(40), { ...good, pages: { ...good.pages, [work]: new Bun.CryptoHasher("sha256").update(page).digest("hex") }, bodies: { [work]: page } }, call);
  expect(answer.status).toBe(413);
  expect([...kv.keys()].filter((key) => key.startsWith("page:"))).toEqual([]);
});

test("a send over each limit is refused before the work it bounds", async () => {
  const { env: hubEnv, calls } = makeCentral();
  const call = (request: Request) => handle(request, hubEnv);
  const credential = `Bearer ${await makeCredential(MACHINE_KEY, "box-1")}`;
  const raw = (body: Uint8Array<ArrayBuffer>) => call(new Request("https://hub.example/api/machine", { method: "POST", headers: { Authorization: credential, "Content-Length": String(body.length) }, body }));
  // Too large as it arrives: refused from its length, before a byte is unpacked (this one is not even gzip).
  const zipped = await raw(new Uint8Array(MOST_SEND_ZIPPED + 1));
  expect(zipped.status).toBe(413);
  // Too large unpacked: stopped as it is unpacked.
  const unpacked = await raw(Bun.gzipSync(new Uint8Array(MOST_SEND_BYTES + 1).fill(32)));
  expect(unpacked.status).toBe(413);
  // Too many pages or files, or a file too large: refused before the state is read or the bucket asked.
  const many = Object.fromEntries(Array.from({ length: MOST_PAGES + 1 }, (_, at) => [`w${at}`, "0".repeat(64)]));
  expect((await sendAs("box-1", { ...emptySend(Date.now()), pages: many }, call)).status).toBe(400);
  const file = (at: number, size = 1) => ({ path: `w/f${at}`, digest: at.toString(16).padStart(64, "0"), size, type: "text/plain" });
  expect((await sendAs("box-1", { ...emptySend(Date.now()), files: Array.from({ length: MOST_FILES + 1 }, (_, at) => file(at)) }, call)).status).toBe(400);
  expect((await sendAs("box-1", { ...emptySend(Date.now()), files: [file(1, MOST_FILE_BYTES + 1)] }, call)).status).toBe(400);
  expect(calls.head + calls.list).toBe(0);
  // An upload too large is refused from its length: no send could name it.
  const big = await call(new Request(`https://hub.example/api/machine/files/${"0".repeat(64)}`, { method: "PUT", headers: { Authorization: credential, "Content-Length": String(MOST_FILE_BYTES + 1) }, body: "x" }));
  expect(big.status).toBe(403);
  // Too many machines.
  for (let at = 0; at < MOST_MACHINES; at++) expect((await sendAs(`box-${at}`, emptySend(Date.now()), call)).status).toBe(200);
  const extra = await sendAs("one-too-many", emptySend(Date.now()), call);
  expect(extra.status).toBe(403);
  expect(calls.put).toBe(0);
});

test("many unknown files are found with a few listings of the bucket, not one request each", async () => {
  const { env: hubEnv, calls, bucket } = makeCentral();
  const call = (request: Request) => handle(request, hubEnv);
  const good = await ownSend(Date.now());
  const work = good.state.store.works[0]!.id;
  const files = Array.from({ length: 1500 }, (_, at) => ({ path: `${work}/f${at}.txt`, digest: at.toString(16).padStart(64, "0"), size: 1, type: "text/plain" }));
  for (const file of files.slice(0, 1400)) bucket.set(`files/box-1/${file.digest}`, new Uint8Array(1));
  const answer = await sendAs("box-1", { ...good, files }, call);
  expect(((await answer.json()) as { missing: { files: string[] } }).missing.files.length).toBe(100);
  expect(calls.head).toBe(0);
  expect(calls.list).toBe(2);
});

// ---------------------------------------------------------------- Removing a machine

const digestOf = (bytes: string) => new Bun.CryptoHasher("sha256").update(bytes).digest("hex");

test("a deploy command given a stage that is a path stops, and touches no other deployment", () => {
  const config = join(root, "config");
  const [mine, other] = ["a".repeat(32), "b".repeat(32)];
  const theirs = join(config, "progress", "deploys", other, "progress-central-prod");
  mkdirSync(join(theirs, "machines"), { recursive: true });
  writeFileSync(join(theirs, "deployment.json"), JSON.stringify({ url: at }));
  writeFileSync(join(theirs, "keys.json"), JSON.stringify({ sessionKey: "s".repeat(43), machineKey: MACHINE_KEY }));
  writeFileSync(join(theirs, "machines", "box-1"), "kept");
  const run = Bun.spawnSync(["bun", join(import.meta.dir, "..", "cloud", "forget.ts"), "--account", mine, "--stage", `x/../../${other}/progress-central-prod`, "--machine", "box-1"], { env: { ...process.env, XDG_CONFIG_HOME: config } });
  expect(run.exitCode).toBe(1);
  expect(run.stderr.toString()).toContain("A stage is a short lowercase name");
  expect(readFileSync(join(theirs, "machines", "box-1"), "utf8")).toBe("kept");
});

test("a deploy is refused a zone with no domain, and a domain or zone that is not a host name", () => {
  const deploy = (...args: string[]) => Bun.spawnSync(["bun", join(import.meta.dir, "..", "cloud", "deploy.ts"), "--account", "a".repeat(32), ...args], { env: { ...process.env, XDG_CONFIG_HOME: join(root, "config") } });
  const alone = deploy("--zone", "example.org");
  expect([alone.exitCode, alone.stderr.toString()]).toEqual([1, expect.stringContaining("--zone goes with --domain")]);
  const path = deploy("--domain", "progress.example.com/*", "--zone", "example.org");
  expect([path.exitCode, path.stderr.toString()]).toEqual([1, expect.stringContaining("are host names")]);
});

/** The deployer's request, signed with the machine key as `cloud/` signs it. */
const order = async (method: string, path: string, key = MACHINE_KEY, nowSec = Math.floor(Date.now() / 1000)) =>
  new Request(`https://hub.example${path}`, { method, headers: { Authorization: `Bearer ${await makeOrder(key, method, path, nowSec)}` } });

const uploadAs = async (machineId: string, bytes: string, call: (request: Request) => Promise<Response>) =>
  call(new Request(`https://hub.example/api/machine/files/${digestOf(bytes)}`, { method: "PUT", headers: { Authorization: `Bearer ${await makeCredential(MACHINE_KEY, machineId)}`, "Content-Length": String(bytes.length) }, body: bytes }));

/** A hub that shows two machines, each with a work and a file of its own. */
async function twoMachines() {
  const central = makeCentral();
  const call = (request: Request) => handle(request, central.env);
  const base = await ownSend(Date.now());
  const work = base.state.store.works[0]!.id;
  for (const machineId of ["box-1", "box-2"]) {
    const bytes = `bytes of ${machineId}`;
    const send = { ...base, label: machineId, files: [{ path: `${work}/x.txt`, digest: digestOf(bytes), size: bytes.length, type: "text/plain" }] };
    expect(((await (await sendAs(machineId, send, call)).json()) as { missing: { files: string[] } }).missing.files).toEqual([digestOf(bytes)]);
    expect((await uploadAs(machineId, bytes, call)).status).toBe(204);
    expect((await sendAs(machineId, { ...send, at: send.at + 1 }, call)).status).toBe(200);
  }
  const session = await sessionFor(central.env);
  const read = (path: string) => call(new Request(`https://hub.example${path}`, { headers: { Cookie: session } }));
  return { ...central, call, base, work, read };
}

test("the deployer lists the machines and removes one: its works, page and files are gone, and the other's are untouched", async () => {
  const { call, work, read, kv, bucket, heard } = await twoMachines();
  const list = (await (await call(await order("GET", MACHINES_PATH))).json()) as HeldMachine[];
  expect(list.map(({ id, label, works }) => ({ id, label, works }))).toEqual([
    { id: "box-1", label: "box-1", works: 1 },
    { id: "box-2", label: "box-2", works: 1 },
  ]);
  expect(list.every((machine) => machine.heard > 0)).toBe(true);
  const page = `/api/work/${encodeURIComponent(`box-2~${work}`)}`;
  const box2 = async () => {
    const state = (await (await read("/api/state")).json()) as HubState;
    return { works: state.works.filter((entry) => entry.id.startsWith("box-2~")), store: state.stores.find((store) => store.id === "box-2"), page: await (await read(page)).text(), file: await (await read(`/files/box-2~${work}/x.txt`)).text() };
  };
  const before = await box2();
  expect(before.file).toBe("bytes of box-2");
  heard.length = 0;

  const answer = await call(await order("DELETE", `${MACHINES_PATH}/box-1`));
  expect([answer.status, await answer.json()]).toEqual([200, { files: 1, done: true } satisfies Forgotten]);
  expect(heard).toEqual(["changed"]);
  const state = (await (await read("/api/state")).json()) as HubState;
  expect(state.works.map((entry) => entry.id as string)).toEqual([`box-2~${work}`]);
  expect(state.stores.map((store) => store.id)).toEqual(["box-2"]);
  expect((await read(`/api/work/${encodeURIComponent(`box-1~${work}`)}`)).status).toBe(404);
  expect((await read(`/files/box-1~${work}/x.txt`)).status).toBe(404);
  // Nothing of it is kept but that it was removed.
  expect([...kv.keys()].filter((key) => key.includes("box-1"))).toEqual(["forgotten:box-1"]);
  expect([...bucket.keys()]).toEqual([`files/box-2/${digestOf("bytes of box-2")}`]);
  expect(await box2()).toEqual(before);
  expect(((await (await call(await order("GET", MACHINES_PATH))).json()) as HeldMachine[]).map((machine) => machine.id)).toEqual(["box-2"]);
});

test("a removed machine's credential is refused from then on, as any bad credential is", async () => {
  const { call, base, work } = await twoMachines();
  expect((await call(await order("DELETE", `${MACHINES_PATH}/box-1`))).status).toBe(200);
  const hello = await sendAs("box-1", { format: FORMAT, kind: "hello" }, call);
  expect([hello.status, await hello.text()]).toEqual([401, "A machine sends the credential it was linked with."]);
  const bytes = "after";
  const send = { ...base, at: Date.now() + 10, files: [{ path: `${work}/y.txt`, digest: digestOf(bytes), size: bytes.length, type: "text/plain" }] };
  expect((await sendAs("box-1", send, call)).status).toBe(401);
  expect((await uploadAs("box-1", bytes, call)).status).toBe(401);
  // Removing it again changes nothing, and the other machine still sends.
  expect(await (await call(await order("DELETE", `${MACHINES_PATH}/box-1`))).json()).toEqual({ files: 0, done: true });
  expect((await sendAs("box-2", { format: FORMAT, kind: "hello" }, call)).status).toBe(200);
});

test("a send or an upload on its way when its machine is removed brings nothing back", async () => {
  const { call, base, work, kv, bucket, calls } = await twoMachines();
  // A send waits on the bucket while the machine is removed.
  const bytes = "late bytes";
  const send = { ...base, at: Date.now() + 10, files: [{ path: `${work}/late.txt`, digest: digestOf(bytes), size: bytes.length, type: "text/plain" }] };
  let sendGoes = () => {};
  calls.headWaits = new Promise((resolve) => (sendGoes = resolve));
  const heads = calls.head;
  const late = sendAs("box-1", send, call);
  while (calls.head === heads) await Bun.sleep(1);
  calls.headWaits = null;
  // An upload let in before the removal lands in the bucket after it.
  expect((await sendAs("box-2", { ...send, label: "box-2" }, call)).status).toBe(200);
  let uploadGoes = () => {};
  calls.putWaits = new Promise((resolve) => (uploadGoes = resolve));
  const puts = calls.put;
  const upload = uploadAs("box-2", bytes, call);
  while (calls.put === puts) await Bun.sleep(1);

  expect((await call(await order("DELETE", `${MACHINES_PATH}/box-1`))).status).toBe(200);
  expect((await call(await order("DELETE", `${MACHINES_PATH}/box-2`))).status).toBe(200);
  sendGoes();
  uploadGoes();
  expect((await late).status).toBe(401);
  expect((await upload).status).toBe(401);
  expect([...kv.keys()].sort()).toEqual(["forgotten:box-1", "forgotten:box-2"]);
  expect([...bucket.keys()]).toEqual([]);
});

test("only an order signed with the machine key, for this very request and still good, lists or removes a machine", async () => {
  const { call, read } = await twoMachines();
  const nowSec = Math.floor(Date.now() / 1000);
  const remove = `${MACHINES_PATH}/box-1`;
  const tries = [
    // A browser's session, even the owner's.
    new Request(`https://hub.example${remove}`, { method: "DELETE", headers: { Cookie: await sessionFor(makeCentral().env), Origin: "https://hub.example" } }),
    new Request(`https://hub.example${MACHINES_PATH}`, { headers: { Cookie: await sessionFor(makeCentral().env) } }),
    // Signed with another key, expired, or signed for another request.
    await order("DELETE", remove, "another-key-0123456789-abcdefghijklmnopqrstu"),
    await order("DELETE", remove, MACHINE_KEY, nowSec - ORDER_SEC - 1),
    await order("DELETE", remove, MACHINE_KEY, nowSec + 3600),
    new Request(`https://hub.example${remove}`, { method: "DELETE", headers: (await order("DELETE", `${MACHINES_PATH}/box-2`)).headers }),
    new Request(`https://hub.example${remove}`, { method: "DELETE", headers: (await order("GET", MACHINES_PATH)).headers }),
    // A machine's credential is no order, its own machine's either.
    new Request(`https://hub.example${remove}`, { method: "DELETE", headers: { Authorization: `Bearer ${await makeCredential(MACHINE_KEY, "box-1")}` } }),
  ];
  for (const [at, request] of tries.entries()) expect([at, (await call(request)).status]).toEqual([at, 401]);
  expect(((await (await read("/api/state")).json()) as HubState).stores.map((store) => store.id)).toEqual(["box-1", "box-2"]);
  // And an order is no machine's credential.
  const asCredential = (await order("DELETE", remove)).headers.get("authorization")!;
  const hello = Bun.gzipSync(JSON.stringify({ format: FORMAT, kind: "hello" }));
  expect((await call(new Request("https://hub.example/api/machine", { method: "POST", headers: { Authorization: asCredential, "Content-Length": String(hello.length) }, body: hello }))).status).toBe(401);
  // An order for a path that names no machine finds nothing.
  expect((await call(await order("DELETE", `${MACHINES_PATH}/Box*`))).status).toBe(404);
});

// ---------------------------------------------------------------- Marks changed on the central hub

/** The orders the hub keeps for a machine. */
const ordersOf = (kv: Map<string, string>, machineId: string) => (JSON.parse(kv.get(`orders:${machineId}`) ?? '{"orders":[]}') as { orders: { kind: string; key: string; on: boolean }[] }).orders;

/** A change to marks, as the hub's own page sends it to a central hub of these tests. */
const markOn = async (call: (request: Request) => Promise<Response>, hubEnv: Env, body: unknown, headers?: Record<string, string>) =>
  call(new Request("https://hub.example/api/marks", { method: "POST", headers: headers ?? { Cookie: await sessionFor(hubEnv), Origin: "https://hub.example", Host: "hub.example", "Content-Type": "application/json" }, body: typeof body === "string" ? body : JSON.stringify(body) }));

const ownFile = () => JSON.parse(readFileSync(join(home, ".marks.json"), "utf8")) as { viewed: string[]; dismissed: string[] };
const ownState = async () => (await (await fetch(`${machine.url}/api/state`)).json()) as HubState;
let pokes = 0;
/** A change to one of the machine's pages, so its hub sends within seconds rather than at its next hello. */
const poke = () => writeFileSync(join(home, "alpha", "progress.md"), `${readFileSync(join(home, "alpha", "progress.md"), "utf8")}\n<!-- ${++pokes} -->\n`);

/** Marks on the main hub of these tests, which the linked machine sends to. */
const markMain = (body: unknown) => fetch(`${at}/api/marks`, { method: "POST", headers: { Cookie: cookie, Origin: at, "Content-Type": "application/json" }, body: JSON.stringify(body) });

/**
 * How long a linked machine may take to hand an order on: it sends a change within ten seconds, and one send that
 * fails is tried again thirty seconds later.
 */
const TAKEN_MS = 60_000;

test("a mark made on the central hub shows there at once, reaches the machine's own hub and its marks file, and is then no longer an order", async () => {
  await until(async () => ((await shown()).works.some((work) => work.id === `${id}~alpha`) ? true : null));
  const key = `${id}~alpha/next/the-second-part`;
  expect(ownFile().viewed).not.toContain("alpha/next/the-second-part");
  main.heard.length = 0;
  expect((await markMain({ kind: "viewed", keys: [key], on: true })).status).toBe(204);
  expect((await shown()).marks.viewed).toContain(key);
  expect(main.heard).toContain("changed");
  expect(ordersOf(main.kv, id)).toEqual([expect.objectContaining({ kind: "viewed", key, on: true })]);
  poke();
  await until(async () => ((await ownState()).marks.viewed.includes("alpha/next/the-second-part") ? true : null), TAKEN_MS);
  expect(ownFile().viewed).toContain("alpha/next/the-second-part");
  await until(async () => (ordersOf(main.kv, id).length === 0 ? true : null), TAKEN_MS);
  // Now the machine's own marks say it.
  expect((await shown()).marks.viewed).toContain(key);
}, 2 * TAKEN_MS + 10_000);

test("unmarking on the central hub reaches the machine's marks file the same way", async () => {
  const key = `${id}~alpha/shipped/the-first-part`;
  expect(ownFile().viewed).toContain("alpha/shipped/the-first-part");
  expect((await markMain({ kind: "viewed", keys: [key], on: false })).status).toBe(204);
  expect((await shown()).marks.viewed).not.toContain(key);
  poke();
  await until(async () => (!ownFile().viewed.includes("alpha/shipped/the-first-part") ? true : null), TAKEN_MS);
  expect((await ownState()).marks.viewed).not.toContain("alpha/shipped/the-first-part");
  await until(async () => (ordersOf(main.kv, id).length === 0 ? true : null), TAKEN_MS);
  expect((await shown()).marks.viewed).not.toContain(key);
}, 2 * TAKEN_MS + 10_000);

test("a mark made while the machine is not sending stays shown, and is handed over when it sends again", async () => {
  const { env: hubEnv, kv } = makeCentral();
  const call = (request: Request) => handle(request, hubEnv);
  // The machine's requests, straight to the Worker, with the length a real one carries.
  const viaHub = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const body = init?.body ? new Uint8Array(await new Response(init.body).arrayBuffer()) : null;
    return call(new Request(input, { ...init, body, headers: { ...Object.fromEntries(new Headers(init?.headers)), "Content-Length": String(body?.length ?? 0) } }));
  }) as typeof fetch;
  const link = { url: "https://hub.example", credential: await makeCredential(MACHINE_KEY, "box-1"), machine: "box-1" };
  const file = join(mkdtempSync(join(tmpdir(), "progress-marks-")), ".marks.json");
  const marks = new MarkStore(file);
  let changes = 0;
  const sender = () =>
    new Sender({ link, own: machine.own, extras: () => ({ marks: marks.get(), todos: [] }), apply: (order) => void (marks.change(order.kind, [order.key], order.on) && changes++), changes: () => String(changes), fetch: viaHub, log: () => undefined });
  const asleep = sender();
  expect(await asleep.run()).toBe(true);
  const read = async () => (await (await call(new Request("https://hub.example/api/state", { headers: { Cookie: await sessionFor(hubEnv) } }))).json()) as HubState;
  expect((await read()).stores.map((store) => store.id)).toEqual(["box-1"]);

  expect((await markOn(call, hubEnv, { kind: "dismissed", keys: ["box-1~alpha:needs/later"], on: true })).status).toBe(204);
  expect((await read()).marks.dismissed).toEqual(["box-1~alpha:needs/later"]);
  // A machine of an earlier build says nothing of orders: the order stays, and stays shown.
  // A state is taken only when it is later than the one shown, to the millisecond, so each waits for the clock to move.
  const later = () => Bun.sleep(3);
  expect((await sendAs("box-1", { format: FORMAT, kind: "hello" }, call)).status).toBe(200);
  await later();
  expect((await sendAs("box-1", { ...(await ownSend(Date.now())), label: "box-1" }, call)).status).toBe(200);
  expect((await read()).marks.dismissed).toEqual(["box-1~alpha:needs/later"]);

  // The machine sends again: its hello's answer hands the order over, with the key as the machine keeps it, and its file holds it.
  expect(await asleep.run()).toBe(true);
  expect(marks.get().dismissed).toEqual(["alpha:needs/later"]);
  expect(JSON.parse(readFileSync(file, "utf8")).dismissed).toEqual(["alpha:needs/later"]);
  // Until a state that holds it is shown, the order stays.
  expect(ordersOf(kv, "box-1").length).toBe(1);
  // A machine that restarts is handed it again, and applying it twice changes nothing. Its next send is a state
  // that says it applied the order, and the order goes.
  const restarted = sender();
  const before = changes;
  await later();
  expect(await restarted.run()).toBe(true);
  expect(ordersOf(kv, "box-1").length).toBe(1);
  await later();
  expect(await restarted.run()).toBe(true);
  expect(changes).toBe(before);
  expect(ordersOf(kv, "box-1")).toEqual([]);
  expect((await read()).marks.dismissed).toEqual(["box-1~alpha:needs/later"]);
  // Nothing is handed over again.
  const hello = (await (await sendAs("box-1", { format: FORMAT, kind: "hello" }, call)).json()) as Answer;
  expect(hello.marks).toBeUndefined();
});

test("a signed-out request, one from another origin, a machine's credential and a deployer's order make no mark", async () => {
  await until(async () => ((await shown()).works.some((work) => work.id === `${id}~alpha`) ? true : null));
  const body = JSON.stringify({ kind: "dismissed", keys: [`${id}~alpha:needs/sneaky`], on: true });
  const before = await shown();
  const ordersBefore = main.kv.get(`orders:${id}`);
  const tries: [string, Record<string, string>, number][] = [
    ["signed out", { Origin: at }, 401],
    ["another origin", { Cookie: cookie, Origin: "https://elsewhere.example" }, 403],
    ["no origin", { Cookie: cookie }, 403],
    // The same host over another scheme is another origin.
    ["this host, another scheme", { Cookie: cookie, Origin: at.replace("http://", "https://") }, 403],
    ["a machine's credential", { Authorization: `Bearer ${await makeCredential(MACHINE_KEY, id)}`, Origin: at }, 401],
    ["a deployer's order", { Authorization: `Bearer ${await makeOrder(MACHINE_KEY, "POST", "/api/marks", Math.floor(Date.now() / 1000))}`, Origin: at }, 401],
  ];
  for (const [who, headers, status] of tries) expect([who, (await fetch(`${at}/api/marks`, { method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body })).status]).toEqual([who, status]);
  expect(main.kv.get(`orders:${id}`)).toBe(ordersBefore);
  expect((await shown()).marks).toEqual(before.marks);
});

test("a key for a machine the hub does not hold, a key of another shape, too many keys and a body over the cap change nothing", async () => {
  const { env: hubEnv, kv } = makeCentral();
  const call = (request: Request) => handle(request, hubEnv);
  expect((await sendAs("box-1", { ...(await ownSend(Date.now())), label: "box-1" }, call)).status).toBe(200);
  const read = async () => (await (await call(new Request("https://hub.example/api/state", { headers: { Cookie: await sessionFor(hubEnv) } }))).json()) as HubState;
  const before = await read();
  const stored = new Map(kv);
  const refused: [unknown, number][] = [
    [{ kind: "viewed", keys: ["nobody~alpha/x"], on: true }, 400],
    // One bad key refuses the keys beside it.
    [{ kind: "viewed", keys: ["box-1~alpha/x", "nobody~alpha/x"], on: true }, 400],
    [{ kind: "viewed", keys: ["box-1-alpha/x"], on: true }, 400],
    [{ kind: "viewed", keys: ["box-1~alpha"], on: true }, 400],
    [{ kind: "dismissed", keys: ["box-1~alpha/x"], on: true }, 400],
    [{ kind: "dismissed", keys: ["box-1~stall:t3:x"], on: true }, 400],
    [{ kind: "dismissed", keys: ["stall:box-1"], on: true }, 400],
    [{ kind: "viewed", keys: ["~alpha/x"], on: true }, 400],
    // About nothing that machine has: a work it does not have, another machine's work under its name, a thread of its that is not stalled.
    [{ kind: "viewed", keys: ["box-1~nonexistent/shipped/x"], on: true }, 400],
    [{ kind: "viewed", keys: ["box-1~box-2~alpha/shipped/x"], on: true }, 400],
    [{ kind: "dismissed", keys: ["stall:box-1~t3:not-stalled"], on: true }, 400],
    // A thread of another machine's, named through this one, marked or unmarked.
    [{ kind: "dismissed", keys: ["stall:box-1~box-2~t3:victim"], on: false }, 400],
    [{ kind: "dismissed", keys: ["stall:box-1~box-2~t3:victim"], on: true }, 400],
    [{ kind: "viewed", keys: [`box-1~alpha/${"x".repeat(MOST_MARK_KEY_CHARS)}`], on: true }, 400],
    [{ kind: "viewed", keys: [""], on: true }, 400],
    [{ kind: "viewed", keys: [7], on: true }, 400],
    [{ kind: "starred", keys: ["box-1~alpha/x"], on: true }, 400],
    [{ kind: "viewed", keys: ["box-1~alpha/x"], on: "yes" }, 400],
    [{ kind: "viewed", keys: "box-1~alpha/x", on: true }, 400],
    ["not json", 400],
    [{ kind: "viewed", keys: Array.from({ length: MOST_MARK_KEYS + 1 }, (_, at) => `box-1~alpha/x${at}`), on: true }, 400],
    [{ kind: "viewed", keys: Array.from({ length: Math.ceil(MOST_MARKS_BYTES / 1000) }, (_, at) => `box-1~alpha/${String(at).padEnd(1000, "x")}`), on: true }, 413],
  ];
  for (const [at, [body, status]] of refused.entries()) expect([at, (await markOn(call, hubEnv, body)).status]).toEqual([at, status]);
  expect(new Map(kv)).toEqual(stored);
  expect(await read()).toEqual(before);
});

test("a machine leaves out an order that is not about its own work, whatever hub sent it, and still says it took it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "progress-owned-"));
  mkdirSync(join(dir, "home", "alpha"), { recursive: true });
  writeFileSync(join(dir, "home", "alpha", "progress.md"), "---\ntitle: Alpha\n---\n\nA task.\n\n## Shipped\n\n- Finished.\n");
  // A hub that hands over four orders: one for this machine's work, one for a peer's work it shows, one for no work, one for a peer's stalled thread.
  const sends: { applied?: number }[] = [];
  const orders = [
    { n: 5, kind: "viewed", key: "alpha/shipped/finished", on: true },
    { n: 6, kind: "viewed", key: "elsewhere~beta/shipped/secret", on: true },
    { n: 7, kind: "viewed", key: "nonexistent/shipped/invented", on: true },
    { n: 8, kind: "dismissed", key: "stall:elsewhere~t3:victim", on: true },
  ];
  const fake = Bun.serve({
    port: 0,
    async fetch(request) {
      sends.push(JSON.parse(new TextDecoder().decode(Bun.gunzipSync(new Uint8Array(await request.arrayBuffer())))) as { applied?: number });
      return Response.json({ format: FORMAT, marks: sends.length === 1 ? orders : [] });
    },
  });
  const linked = serve({ home: join(dir, "home"), port: 0, sources: [], central: { url: fake.url.origin, credential: await makeCredential(MACHINE_KEY, "box-9"), machine: "box-9" } });
  try {
    await until(async () => (sends.some((sent) => sent.applied === 8) ? true : null), 20_000);
    expect(JSON.parse(readFileSync(join(dir, "home", ".marks.json"), "utf8")) as { viewed: string[]; dismissed: string[] }).toEqual({ viewed: ["alpha/shipped/finished"], dismissed: [] });
  } finally {
    linked.stop();
    fake.stop();
  }
}, 30_000);

test("after the hub's storage is emptied, a new order is numbered above what the machine has applied, so it is not taken for an old one", async () => {
  const { env: hubEnv, kv } = makeCentral();
  const call = (request: Request) => handle(request, hubEnv);
  const state = async (applied: number, at: number) => sendAs("box-1", { ...(await ownSend(at)), label: "box-1", applied }, call);
  const now = Date.now();
  expect((await state(0, now)).status).toBe(200);
  expect((await markOn(call, hubEnv, { kind: "viewed", keys: ["box-1~alpha/shipped/one"], on: true })).status).toBe(204);
  const first = (JSON.parse(kv.get("orders:box-1")!) as { last: number }).last;
  // The machine applied it and others after it. Then the hub's storage is emptied, and the machine's next state fills it again.
  const applied = first + 60_000;
  kv.clear();
  expect((await state(applied, now + 1)).status).toBe(200);
  expect((await markOn(call, hubEnv, { kind: "viewed", keys: ["box-1~alpha/shipped/two"], on: true })).status).toBe(204);
  const handed = ((await (await sendAs("box-1", { format: FORMAT, kind: "hello", applied }, call)).json()) as Answer).marks ?? [];
  expect(handed.map((order) => [order.key, order.n > applied])).toEqual([["alpha/shipped/two", true]]);
  // A number a machine made up can't run the numbers out: the next one is no further ahead than a clock may be.
  expect((await sendAs("box-1", { format: FORMAT, kind: "hello", applied: Number.MAX_SAFE_INTEGER }, call)).status).toBe(200);
  expect((await markOn(call, hubEnv, { kind: "viewed", keys: ["box-1~alpha/shipped/three"], on: true })).status).toBe(204);
  expect((JSON.parse(kv.get("orders:box-1")!) as { last: number }).last).toBeLessThan(Date.now() + 60 * 60_000);
});

test("past the orders a machine may have waiting, a new key is refused, saying the machine has been away too long", async () => {
  const { env: hubEnv, kv } = makeCentral();
  const call = (request: Request) => handle(request, hubEnv);
  expect((await sendAs("box-1", { ...(await ownSend(Date.now())), label: "box-1" }, call)).status).toBe(200);
  const keys = Array.from({ length: MOST_ORDERS }, (_, at) => `box-1~alpha/x${at}`);
  expect((await markOn(call, hubEnv, { kind: "viewed", keys, on: true })).status).toBe(204);
  // A later order for a key replaces the one before it, so what is kept is bounded by the keys.
  expect((await markOn(call, hubEnv, { kind: "viewed", keys: keys.slice(0, 10), on: false })).status).toBe(204);
  expect(ordersOf(kv, "box-1").length).toBe(MOST_ORDERS);
  const stored = kv.get("orders:box-1");
  const refused = await markOn(call, hubEnv, { kind: "viewed", keys: ["box-1~alpha/one-more"], on: true });
  expect(refused.status).toBe(409);
  expect(await refused.text()).toContain("box-1 has been away too long");
  expect(kv.get("orders:box-1")).toBe(stored);
});

test("one machine's order is never handed to another, and never changes what another machine's works show", async () => {
  const { call, work, read, kv, env: hubEnv } = await twoMachines();
  const marksOf = async (machineId: string) => {
    const { marks } = (await (await read("/api/state")).json()) as HubState;
    return [...marks.viewed, ...marks.dismissed].filter((key) => key.startsWith(`${machineId}~`) || key.startsWith(`stall:${machineId}~`));
  };
  const box2 = await marksOf("box-2");
  // A thread of box-1's is stalled: an ask is marked done only for a thread its machine says is stalled.
  const stall: NeedEntry = { source: "stall", work: null, workTitle: null, project: null, agentTitle: "Asks", stall: { thread: "t3:victim" as SessionRef, ask: "question", text: null, since: "2026-11-24T00:00:00.000Z" as Instant }, threadLink: null };
  const stalled = await ownSend(Date.now() + 1000);
  expect((await sendAs("box-1", { ...stalled, label: "box-1", files: [{ path: `${work}/x.txt`, digest: digestOf("bytes of box-1"), size: 14, type: "text/plain" }], state: { ...stalled.state, store: { ...stalled.state.store, needs: [stall] } } }, call)).status).toBe(200);
  expect((await markOn(call, hubEnv, { kind: "viewed", keys: [`box-1~${work}/shipped/x`, "box-1~https://github.com/acme/app/pull/9"], on: true })).status).toBe(204);
  expect((await markOn(call, hubEnv, { kind: "dismissed", keys: ["stall:box-1~t3:victim"], on: true })).status).toBe(204);
  expect(await marksOf("box-1")).toEqual([`box-1~${work}/shipped/x`, "box-1~https://github.com/acme/app/pull/9", "stall:box-1~t3:victim"]);
  expect(await marksOf("box-2")).toEqual(box2);
  const helloOf = async (machineId: string, applied = 0) => (await (await sendAs(machineId, { format: FORMAT, kind: "hello", applied }, call)).json()) as Answer;
  expect((await helloOf("box-2")).marks).toBeUndefined();
  expect((await helloOf("box-1")).marks?.map(({ kind, key, on }) => ({ kind, key, on }))).toEqual([
    { kind: "viewed", key: `${work}/shipped/x`, on: true },
    { kind: "viewed", key: "https://github.com/acme/app/pull/9", on: true },
    { kind: "dismissed", key: "stall:t3:victim", on: true },
  ]);
  // Another machine's state, however much it says it applied, lets go of none of them.
  const base = await ownSend(Date.now() + 5000);
  expect((await sendAs("box-2", { ...base, label: "box-2", applied: Number.MAX_SAFE_INTEGER, files: [{ path: `${work}/x.txt`, digest: digestOf("bytes of box-2"), size: 14, type: "text/plain" }] }, call)).status).toBe(200);
  expect(ordersOf(kv, "box-1").length).toBe(3);
  expect(await marksOf("box-2")).toEqual(box2);
});

test("a removed machine's orders are gone, and no new one can be made for it", async () => {
  const { call, work, kv, env: hubEnv } = await twoMachines();
  expect((await markOn(call, hubEnv, { kind: "viewed", keys: [`box-1~${work}/shipped/x`], on: true })).status).toBe(204);
  expect(ordersOf(kv, "box-1").length).toBe(1);
  expect((await call(await order("DELETE", `${MACHINES_PATH}/box-1`))).status).toBe(200);
  expect(kv.has("orders:box-1")).toBe(false);
  expect((await markOn(call, hubEnv, { kind: "viewed", keys: [`box-1~${work}/shipped/y`], on: true })).status).toBe(400);
  expect(kv.has("orders:box-1")).toBe(false);
});

// ---------------------------------------------------------------- The local hub keeps running

test("a broken link file leaves the local hub starting, and says once what is wrong", async () => {
  const dir = mkdtempSync(join(tmpdir(), "progress-link-"));
  mkdirSync(join(dir, "home"));
  writeFileSync(join(dir, "truncated"), '{"url": "https://hub.example", "cred');
  for (const link of [dir, join(dir, "truncated")]) {
    const port = 40000 + Math.floor(Math.random() * 20000);
    const child = Bun.spawn(["bun", join(import.meta.dir, "..", "src", "main.ts"), "serve"], {
      env: { ...process.env, PROGRESS_HOME: join(dir, "home"), PROGRESS_CENTRAL: link, PROGRESS_PORT: String(port), PROGRESS_T3_DB: "off", PROGRESS_PEERS: "" },
      stdout: "pipe",
      stderr: "pipe",
    });
    try {
      const answer = await until(() => fetch(`http://127.0.0.1:${port}/api/state`).then((r) => (r.ok ? r : null)).catch(() => null), 15_000);
      expect(answer.status).toBe(200);
    } finally {
      child.kill();
    }
    const said = await new Response(child.stdout).text();
    expect(said.match(/sending to no central hub/g)?.length).toBe(1);
    expect(said).toContain("Progress hub on");
  }
}, 40_000);

/** A session for the owner on a hub of these tests. */
async function sessionFor(hubEnv: Env): Promise<string> {
  return `__Host-progress=${await makeSession(hubEnv.SESSION_KEY, "owner@gmail.com", Math.floor(Date.now() / 1000))}`;
}
