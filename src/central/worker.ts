import { CentralHub, fileKey, MACHINE_HEADER, NOT_LINKED, type Bucket, type HubContext } from "./hub.ts";
import { allowed, checkIdToken, checkNonce, checkOrder, googleKey, googleOwns, makeNonce, makeSession, NO_SESSION, readCredential, readSession, sessionCookie, sha256Hex } from "./login.ts";
import { DIGEST, MACHINE_ID, MACHINES_PATH, MOST_MARKS_BYTES, MOST_SEND_ZIPPED, readCapped, readMarkChange, SEND_PATH, UPLOAD_PATH } from "./protocol.ts";

/**
 * The central hub's Worker. Every route needs a session but the sign-in itself, and the machine routes need a
 * machine's credential instead, and the deployer's routes an order signed with the machine key. Without a session a browser gets the sign-in page and nothing else, and an API or
 * a file gets 401. Signed in, the app is served from the build, and the reads go to the one Durable Object. The one
 * write a session may make is a change to marks, from the hub's own page, which the Durable Object keeps as an order
 * for the machine whose works it is about.
 * No answer is kept by a cache: a browser may keep a file only to ask again with it.
 */
export interface Env {
  readonly HUB: { idFromName(name: string): unknown; get(id: unknown): { fetch(request: Request): Promise<Response> } };
  readonly FILES: Bucket & { put(key: string, body: ReadableStream | ArrayBuffer | null, options: { sha256: string }): Promise<unknown> };
  readonly ASSETS: { fetch(request: Request): Promise<Response> };
  /** Makes and checks the machines' credentials. Only the machine that deploys holds it too. */
  readonly MACHINE_KEY: string;
  /** Signs nonces and session cookies. */
  readonly SESSION_KEY: string;
  /** The Google OAuth client the sign-in page asks Google for a token for. */
  readonly GOOGLE_CLIENT_ID: string;
  /** The addresses that may sign in, comma separated. */
  readonly ALLOWED_EMAILS: string;
  /** Counts the sign-in routes' requests from each address, before anything is checked or kept. */
  readonly SIGN_IN_LIMIT: { limit(options: { key: string }): Promise<{ success: boolean }> };
}

/** The most a sign-in request may carry: a Google ID token is about 1.2 KB. */
const MOST_SIGN_IN_BYTES = 8 * 1024;

/** The parts of a page's headers the app and the sign-in page share: no site may frame them. */
const PAGE_HEADERS = { "X-Frame-Options": "DENY", "Referrer-Policy": "same-origin", "X-Content-Type-Options": "nosniff" };

/**
 * A file a machine published, opened in a frame or on its own. An HTML page runs its own script and shows what it
 * carries inline, and loads nothing from anywhere; any other file runs nothing. Only the hub's own pages may frame them.
 * Its script can still go to another site and take the page's own text there. The owner's own agents wrote it, on
 * the owner's machines, where it can already do that, so the central hub adds nothing to it.
 */
const HTML_POLICY = "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; media-src data: blob:; font-src data:; form-action 'none'; frame-ancestors 'self'";
const FILE_POLICY = "sandbox; default-src 'none'; img-src data:; style-src 'unsafe-inline'; form-action 'none'; frame-ancestors 'self'";

export function hubOf(env: Env) {
  return env.HUB.get(env.HUB.idFromName("hub"));
}

export async function handle(request: Request, env: Env): Promise<Response> {
  const path = new URL(request.url).pathname;
  const response = await route(request, env).catch((error: unknown) => {
    console.log(`progress: ${path} failed: ${error instanceof Error ? error.name : "an error"}`);
    return text("The hub could not answer. Try again.", 500);
  });
  // Every answer here depends on who asks. A published file keeps its ETag, so the browser may keep it and ask again
  // with it. Nothing else may be kept, the app's own page and scripts included.
  const sealed = new Response(response.body, response);
  const file = path.startsWith("/files/") && sealed.headers.has("etag") && (sealed.status === 200 || sealed.status === 304);
  sealed.headers.set("Cache-Control", file ? "private, no-cache" : "private, no-store");
  sealed.headers.set("Vary", "Cookie");
  return sealed;
}

async function route(request: Request, env: Env): Promise<Response> {
  const path = new URL(request.url).pathname;
  const nowMs = Date.now();

  if (path === SEND_PATH || path.startsWith(UPLOAD_PATH)) return machineRoute(request, env, path);
  if (path === MACHINES_PATH || path.startsWith(`${MACHINES_PATH}/`)) return deployerRoute(request, env, path, nowMs);
  if (path === "/auth/nonce" && request.method === "POST") {
    if (!fromOwnOrigin(request)) return text("Forbidden", 403);
    // Its own count: asking for a nonce doesn't use up the sign-in that follows.
    if (!(await env.SIGN_IN_LIMIT.limit({ key: `nonce:${clientOf(request)}` })).success) return tooMany();
    return Response.json(await makeNonce(env.SESSION_KEY, Math.floor(nowMs / 1000)));
  }
  if (path === "/auth/google" && request.method === "POST") return signIn(request, env, nowMs);
  if (path === "/auth/signout" && request.method === "POST") {
    if (!fromOwnOrigin(request)) return text("Forbidden", 403);
    return new Response(null, { status: 303, headers: { Location: "/", "Set-Cookie": NO_SESSION } });
  }

  const email = await readSession(env.SESSION_KEY, request.headers.get("cookie"), Math.floor(nowMs / 1000));
  if (email === null || !allowed(env.ALLOWED_EMAILS, email)) {
    if (path.startsWith("/api/") || path.startsWith("/files/") || request.method !== "GET") return text("Sign in first.", 401);
    return signInPage(env);
  }

  if (path.startsWith("/api/") || path.startsWith("/files/")) {
    if (path === "/api/marks" && request.method === "POST") return changeMarks(request, env);
    if (request.method !== "GET" && request.method !== "HEAD") return text("This hub takes no change but to the marks.", 405);
    if (path === "/api/events") return events(env);
    const headers = new Headers(request.headers);
    headers.delete(MACHINE_HEADER);
    const answer = await hubOf(env).fetch(new Request(request.url, { method: request.method, headers }));
    if (!path.startsWith("/files/")) return answer;
    const file = new Response(answer.body, answer);
    file.headers.set("Content-Security-Policy", /\.html?$/i.test(path) ? HTML_POLICY : FILE_POLICY);
    return file;
  }
  if (path.startsWith("/auth/")) return text("Not found", 404);
  const asset = await env.ASSETS.fetch(request);
  const response = new Response(asset.body, asset);
  for (const [name, value] of Object.entries(PAGE_HEADERS)) response.headers.set(name, value);
  response.headers.set("Content-Security-Policy", "frame-ancestors 'none'");
  return response;
}

/**
 * Whether a request comes from this hub's own page: its `Origin` is this hub's, scheme and all. A page another
 * site serves, and a page the hub serves from `/files/` in a sandbox, send another origin or none.
 */
const fromOwnOrigin = (request: Request) => request.headers.get("origin") === new URL(request.url).origin;

/** A change to marks from the hub's own page, read whole before the Durable Object is asked anything. */
async function changeMarks(request: Request, env: Env): Promise<Response> {
  if (!fromOwnOrigin(request)) return text("Forbidden", 403);
  const raw = request.body ? await readCapped(request.body, MOST_MARKS_BYTES) : "";
  if (raw === null) return text(`A change to marks is at most ${MOST_MARKS_BYTES} bytes.`, 413);
  let body: unknown = null;
  try {
    body = JSON.parse(raw);
  } catch {
    // Read as nothing, which is refused below.
  }
  const change = readMarkChange(body);
  if (typeof change === "string") return text(change, 400);
  return hubOf(env).fetch(new Request("https://hub/_/marks", { method: "POST", body: JSON.stringify(change) }));
}

// ---------------------------------------------------------------- Machines

const bearer = (request: Request) => /^Bearer (\S+)$/.exec(request.headers.get("authorization") ?? "")?.[1] ?? "";

async function machineRoute(request: Request, env: Env, path: string): Promise<Response> {
  // Who sends is the machine the credential was made for, never what the request says.
  const machine = env.MACHINE_KEY.length >= 32 ? await readCredential(env.MACHINE_KEY, bearer(request)) : null;
  if (machine === null) return text(NOT_LINKED, 401);
  const length = Number(request.headers.get("content-length") ?? NaN);
  const hub = hubOf(env);
  if (path === SEND_PATH) {
    if (request.method !== "POST") return text("Not found", 404);
    if (!Number.isInteger(length) || length < 0) return text("Send the request's length.", 411);
    if (length > MOST_SEND_ZIPPED) return text(`A send is at most ${MOST_SEND_ZIPPED} bytes gzipped.`, 413);
    return hub.fetch(new Request("https://hub/_/send", { method: "POST", headers: { [MACHINE_HEADER]: machine }, body: request.body }));
  }
  // An upload: `/api/machine/files/<digest>`, of a file the machine's last send named, the bytes checked against the digest as they are kept.
  const digest = path.slice(UPLOAD_PATH.length);
  if (request.method !== "PUT" || !DIGEST.test(digest)) return text("Not found", 404);
  if (!Number.isInteger(length) || length < 0) return text("Send the file's length.", 411);
  const admitted = await hub.fetch(new Request("https://hub/_/admit", { method: "POST", headers: { [MACHINE_HEADER]: machine }, body: JSON.stringify({ digest, size: length }) }));
  if (!admitted.ok) return text(await admitted.text(), admitted.status);
  // An upload that fails uses none of the machine's room. One the bucket kept though its answer was lost counts.
  const key = fileKey(machine, digest);
  const kept = await env.FILES.put(key, request.body, { sha256: digest }).then(
    () => true,
    async () => (await env.FILES.head(key).catch(() => null)) !== null,
  );
  if (!kept) return text("The bytes are not the ones the digest names.", 400);
  const stored = await hub.fetch(new Request("https://hub/_/stored", { method: "POST", headers: { [MACHINE_HEADER]: machine }, body: JSON.stringify({ digest, size: length }) }));
  return stored.ok ? new Response(null, { status: 204 }) : text(await stored.text(), stored.status);
}

/** The deployer's routes: list the machines the hub holds, and remove one. Only an order for this very request opens them. */
async function deployerRoute(request: Request, env: Env, path: string, nowMs: number): Promise<Response> {
  const signed = env.MACHINE_KEY.length >= 32 && (await checkOrder(env.MACHINE_KEY, bearer(request), request.method, path, Math.floor(nowMs / 1000)));
  if (!signed) return text("Only the machine that deployed the hub may do this, with an order it signed in the last few minutes.", 401);
  if (request.method === "GET" && path === MACHINES_PATH) return hubOf(env).fetch(new Request("https://hub/_/machines"));
  const machine = path.slice(MACHINES_PATH.length + 1);
  if (request.method === "DELETE" && MACHINE_ID.test(machine)) return hubOf(env).fetch(new Request("https://hub/_/forget", { method: "POST", headers: { [MACHINE_HEADER]: machine } }));
  return text("Not found", 404);
}

// ---------------------------------------------------------------- Signing in

async function signIn(request: Request, env: Env, nowMs: number): Promise<Response> {
  if (!fromOwnOrigin(request)) return text("Forbidden", 403);
  if (!(await env.SIGN_IN_LIMIT.limit({ key: clientOf(request) })).success) return tooMany();
  const refused = (reason: string) => {
    console.log(`progress: sign-in refused: ${reason}`);
    return Response.json({ error: "Google's answer could not be used. Try again." }, { status: 401 });
  };
  const raw = request.body ? await readCapped(request.body, MOST_SIGN_IN_BYTES) : "";
  if (raw === null) return refused("a body too large");
  let credential: unknown;
  try {
    credential = (JSON.parse(raw) as { credential?: unknown } | null)?.credential;
  } catch {
    return refused("no credential");
  }
  if (typeof credential !== "string") return refused("no credential");
  const nowSec = Math.floor(nowMs / 1000);
  const token = await checkIdToken(credential, { audience: env.GOOGLE_CLIENT_ID, nowSec, key: (kid) => googleKey(kid, nowMs) });
  if (!token.ok) return refused(token.reason);
  const nonce = await checkNonce(env.SESSION_KEY, token.nonce, nowSec);
  if (nonce === null) return refused("a nonce this hub did not sign, or one that expired");
  // The nonce and the token are spent together, before the address is looked at, so each is tried once.
  const keys = [
    { key: `n:${await sha256Hex(nonce)}`, until: nowMs + 11 * 60_000 },
    { key: `t:${token.hash}`, until: token.expiresAt },
  ];
  const spent = await hubOf(env).fetch(new Request("https://hub/_/spend", { method: "POST", body: JSON.stringify({ keys }) }));
  if (!((await spent.json()) as { fresh: boolean }).fresh) return refused("used before");
  if (!allowed(env.ALLOWED_EMAILS, token.email) || !googleOwns(token.email, token.hostedDomain)) return Response.json({ error: "That Google account may not open this hub." }, { status: 403 });
  return new Response(null, { status: 204, headers: { "Set-Cookie": sessionCookie(await makeSession(env.SESSION_KEY, token.email, nowSec)) } });
}

/** The address a request came from, as Cloudflare saw it. */
const clientOf = (request: Request) => request.headers.get("cf-connecting-ip") ?? "unknown";

const tooMany = () => Response.json({ error: "Too many tries from here. Wait a minute." }, { status: 429, headers: { "Retry-After": "60" } });

function text(body: string, status: number): Response {
  return new Response(body, { status, headers: { "Content-Type": "text/plain;charset=utf-8" } });
}

/** The one page anyone reaches without a session: a line, and Google's button. */
function signInPage(env: Env): Response {
  const nonce = crypto.randomUUID().replaceAll("-", "");
  const csp = [
    "default-src 'none'",
    `script-src 'nonce-${nonce}' https://accounts.google.com/gsi/client`,
    `style-src 'nonce-${nonce}' https://accounts.google.com/gsi/style`,
    "connect-src 'self' https://accounts.google.com/gsi/",
    "frame-src https://accounts.google.com/gsi/",
    "img-src https://*.googleusercontent.com data:",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join("; ");
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>Progress</title>
<style nonce="${nonce}">
:root { --bg: #f7f6f3; --ink: #1d1c1a; --muted: #6b6862; --line: #e3e0d9; }
@media (prefers-color-scheme: dark) { :root { --bg: #141412; --ink: #ecebe7; --muted: #9a978f; --line: #2c2b28; } }
* { box-sizing: border-box; }
body { margin: 0; min-height: 100dvh; display: grid; place-items: center; background: var(--bg); color: var(--ink); font: 16px/1.5 ui-sans-serif, system-ui, -apple-system, sans-serif; padding: 16px; }
main { width: 100%; max-width: 360px; display: grid; gap: 16px; justify-items: center; text-align: center; }
h1 { margin: 0; font-size: 20px; font-weight: 600; }
p { margin: 0; color: var(--muted); }
#button { min-height: 44px; }
#note { min-height: 24px; }
</style>
</head>
<body>
<main>
<h1>Progress</h1>
<p>Sign in to see your work.</p>
<div id="button"></div>
<p id="note" role="status"></p>
</main>
<script nonce="${nonce}" src="https://accounts.google.com/gsi/client" async></script>
<script nonce="${nonce}">
const note = document.getElementById("note");
async function arm() {
  const answer = await fetch("/auth/nonce", { method: "POST" });
  if (!answer.ok) { note.textContent = "The hub did not answer. Reload to try again."; return; }
  const { nonce, expiresAt } = await answer.json();
  google.accounts.id.initialize({ client_id: ${JSON.stringify(env.GOOGLE_CLIENT_ID)}, nonce, callback: signIn, auto_select: false, use_fedcm_for_button: true });
  const button = document.getElementById("button");
  button.replaceChildren();
  google.accounts.id.renderButton(button, { type: "standard", theme: matchMedia("(prefers-color-scheme: dark)").matches ? "filled_black" : "outline", size: "large", text: "signin_with", shape: "pill" });
  setTimeout(arm, Math.max(30000, expiresAt - Date.now() - 60000));
}
async function signIn({ credential }) {
  note.textContent = "Signing in…";
  const answer = await fetch("/auth/google", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ credential }) });
  if (answer.ok) { location.reload(); return; }
  note.textContent = (await answer.json().catch(() => null))?.error ?? "That did not work. Try again.";
  arm();
}
addEventListener("load", () => { if (window.google) arm(); else note.textContent = "Google's sign-in did not load. Reload to try again."; });
</script>
</body>
</html>`;
  return new Response(html, { status: 401, headers: { ...PAGE_HEADERS, "Content-Type": "text/html;charset=utf-8", "Content-Security-Policy": csp } });
}

// ---------------------------------------------------------------- What a page listens to

/**
 * The page listens with an EventSource. The Durable Object holds a socket it can sleep through, and this passes
 * each of its messages on as "changed".
 */
async function events(env: Env): Promise<Response> {
  const answer = await hubOf(env).fetch(new Request("https://hub/api/events", { headers: { Upgrade: "websocket" } }));
  const socket = (answer as Response & { webSocket?: WebSocket & { accept(): void } }).webSocket;
  if (!socket) return text("No stream", 502);
  socket.accept();
  const encoder = new TextEncoder();
  let alive: ReturnType<typeof setInterval> | undefined;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(": open\n\n"));
      socket.addEventListener("message", () => controller.enqueue(encoder.encode("data: changed\n\n")));
      socket.addEventListener("close", () => {
        if (alive !== undefined) clearInterval(alive);
        try {
          controller.close();
        } catch {
          // The page closed it first.
        }
      });
      alive = setInterval(() => controller.enqueue(encoder.encode(": keep-alive\n\n")), 20_000);
    },
    cancel() {
      if (alive !== undefined) clearInterval(alive);
      socket.close();
    },
  });
  return new Response(stream, { headers: { "Content-Type": "text/event-stream" } });
}

export { CentralHub, type HubContext };
