import { credentialMachine } from "./protocol.ts";

/**
 * Signing in to the central hub with Google. The browser gets an ID token from Google for a nonce this hub
 * signed a moment before. The hub checks the token itself (signature, audience, issuer, expiry, a verified
 * address and the nonce), checks the address against the allowed list, and sets a signed session cookie.
 */

const encoder = new TextEncoder();

export const GOOGLE_CERTS_URL = "https://www.googleapis.com/oauth2/v3/certs";
const ISSUERS = new Set(["accounts.google.com", "https://accounts.google.com"]);
/** Clock difference tolerated between Google and Cloudflare. */
const SKEW_SEC = 60;
const NONCE_SEC = 10 * 60;
export const SESSION_SEC = 30 * 24 * 60 * 60;
/** `__Host-` makes the browser keep it to this host, over HTTPS, for every path. */
export const COOKIE = "__Host-progress";

// ---------------------------------------------------------------- Bytes

export const base64url = (bytes: ArrayBuffer | Uint8Array): string => {
  let binary = "";
  for (const byte of bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

/** The bytes of unpadded base64url in its one canonical spelling, or undefined. Anything compared as text relies on that. */
export const fromBase64url = (text: string): Uint8Array<ArrayBuffer> | undefined => {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) return undefined;
  const plain = text.replace(/-/g, "+").replace(/_/g, "/");
  let bytes: Uint8Array<ArrayBuffer>;
  try {
    bytes = Uint8Array.from(atob(plain + "=".repeat((4 - (plain.length % 4)) % 4)), (c) => c.charCodeAt(0));
  } catch {
    return undefined;
  }
  return base64url(bytes) === text ? bytes : undefined;
};

const random = (): string => base64url(crypto.getRandomValues(new Uint8Array(32)));

export const sha256Hex = async (text: string): Promise<string> => [...new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(text)))].map((b) => b.toString(16).padStart(2, "0")).join("");

const hmacKey = (secret: string) => crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
const sign = async (secret: string, message: string) => base64url(await crypto.subtle.sign("HMAC", await hmacKey(secret), encoder.encode(message)));
const verify = async (secret: string, message: string, signature: string) => {
  const bytes = fromBase64url(signature);
  return bytes !== undefined && crypto.subtle.verify("HMAC", await hmacKey(secret), bytes, encoder.encode(message));
};

// ---------------------------------------------------------------- Nonce

/** `pn_<random>.<expiry>.<signature>`. Nothing is stored until a token that carries it is spent. */
export async function makeNonce(key: string, nowSec: number): Promise<{ nonce: string; expiresAt: number }> {
  const part = `pn_${random()}`;
  const exp = nowSec + NONCE_SEC;
  return { nonce: `${part}.${exp}.${await sign(key, `nonce\n${part}\n${exp}`)}`, expiresAt: exp * 1000 };
}

/** The nonce's random part when this hub signed it and it has not expired, else null. Whether it was spent is the caller's to ask. */
export async function checkNonce(key: string, nonce: string, nowSec: number): Promise<string | null> {
  const [part = "", exp = "", sig = "", ...rest] = nonce.split(".");
  if (rest.length > 0 || !/^pn_[A-Za-z0-9_-]{43}$/.test(part) || !/^[1-9]\d{0,11}$/.test(exp) || !/^[A-Za-z0-9_-]{43}$/.test(sig)) return null;
  if (!(await verify(key, `nonce\n${part}\n${exp}`, sig))) return null;
  return Number(exp) > nowSec ? part : null;
}

// ---------------------------------------------------------------- Session

/** `<address>.<expiry>.<signature>`, the address in base64url. */
export async function makeSession(key: string, email: string, nowSec: number): Promise<string> {
  const who = base64url(encoder.encode(email));
  const exp = nowSec + SESSION_SEC;
  return `${who}.${exp}.${await sign(key, `session\n${who}\n${exp}`)}`;
}

/** The address a session cookie was signed for, while it has not expired. Null for anything else. */
export async function readSession(key: string, cookieHeader: string | null, nowSec: number): Promise<string | null> {
  const value = (cookieHeader ?? "")
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${COOKIE}=`))
    ?.slice(COOKIE.length + 1);
  const [who = "", exp = "", sig = "", ...rest] = (value ?? "").split(".");
  if (rest.length > 0 || !/^[1-9]\d{0,11}$/.test(exp) || !/^[A-Za-z0-9_-]{43}$/.test(sig)) return null;
  const bytes = fromBase64url(who);
  if (bytes === undefined || bytes.length === 0 || !(await verify(key, `session\n${who}\n${exp}`, sig))) return null;
  return Number(exp) > nowSec ? new TextDecoder().decode(bytes) : null;
}

export const sessionCookie = (value: string) => `${COOKIE}=${value}; Path=/; Max-Age=${SESSION_SEC}; HttpOnly; Secure; SameSite=Lax`;
/** What signing out sets: the cookie, gone. */
export const NO_SESSION = `${COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;

/**
 * Whether Google is the authority for this address, so a token that carries it proves who owns it: a Gmail address,
 * or a Workspace address whose token names its domain as the hosted domain (`hd`). Any other address a Google
 * account lists may have changed hands since it was verified.
 */
export function googleOwns(email: string, hostedDomain: string | null): boolean {
  const domain = email.slice(email.lastIndexOf("@") + 1).toLowerCase();
  return domain === "gmail.com" || (hostedDomain !== null && hostedDomain.toLowerCase() === domain);
}

/** Whether this address may open the hub: one of the comma-separated `allowed`, whatever the case. A session is made only for one Google owns. */
export const allowed = (allowedList: string, email: string): boolean =>
  allowedList
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry !== "")
    .includes(email.toLowerCase());

// ---------------------------------------------------------------- A machine's credential

/**
 * `pm_<machine id>.<signature>`: made on the machine that deploys, with a key only it and the hub hold, once for
 * each machine linked. The hub reads the machine's id from it, so a machine can write only its own works.
 */
export async function makeCredential(key: string, machine: string): Promise<string> {
  return `pm_${machine}.${await sign(key, `machine\n${machine}`)}`;
}

/** The machine id a credential was made for, or null when this hub's key did not make it. */
export async function readCredential(key: string, credential: string): Promise<string | null> {
  const machine = credentialMachine(credential);
  return machine !== null && (await verify(key, `machine\n${machine}`, credential.slice(`pm_${machine}.`.length))) ? machine : null;
}

// ---------------------------------------------------------------- The deployer's request

/** How long a deployer's request is good for. One signed for longer is refused, so none outlives a few minutes. */
export const ORDER_SEC = 5 * 60;

/**
 * `po_<expiry>.<signature>`: one request from whoever holds the machine key, the deployer, for one method and
 * path. Its own prefix and first line, so it is never a machine's credential, and a credential is never one.
 */
export async function makeOrder(key: string, method: string, path: string, nowSec: number): Promise<string> {
  const exp = nowSec + ORDER_SEC;
  return `po_${exp}.${await sign(key, `order\n${method} ${path}\n${exp}`)}`;
}

/** Whether this hub's key signed this order for this method and path, and it is still good. */
export async function checkOrder(key: string, order: string, method: string, path: string, nowSec: number): Promise<boolean> {
  const [, exp = "", sig = ""] = /^po_([1-9]\d{0,11})\.([A-Za-z0-9_-]{43})$/.exec(order) ?? [];
  if (exp === "" || Number(exp) <= nowSec || Number(exp) > nowSec + ORDER_SEC + SKEW_SEC) return false;
  return verify(key, `order\n${method} ${path}\n${exp}`, sig);
}

// ---------------------------------------------------------------- Google's ID token

export type TokenCheck =
  | { readonly ok: true; readonly email: string; readonly hostedDomain: string | null; readonly nonce: string; readonly expiresAt: number; readonly hash: string }
  | { readonly ok: false; readonly reason: string };

/**
 * The whole check, given a way to find Google's key by its id: the RS256 signature first, then issuer, audience,
 * lifetime, a verified address and a nonce. Claims are read only from a token whose signature holds.
 */
export async function checkIdToken(token: string, options: { readonly audience: string; readonly nowSec: number; readonly key: (kid: string) => Promise<CryptoKey | undefined> }): Promise<TokenCheck> {
  const parts = token.split(".");
  if (parts.length !== 3) return { ok: false, reason: "malformed" };
  const [headerPart = "", claimsPart = "", signaturePart = ""] = parts;
  const header = json(headerPart);
  const signature = fromBase64url(signaturePart);
  if (header?.alg !== "RS256" || typeof header.kid !== "string" || signature === undefined) return { ok: false, reason: "malformed" };
  const key = await options.key(header.kid);
  if (key === undefined) return { ok: false, reason: "unknown key" };
  if (!(await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, signature, encoder.encode(`${headerPart}.${claimsPart}`)))) return { ok: false, reason: "bad signature" };
  const c = json(claimsPart);
  if (c === null) return { ok: false, reason: "malformed" };
  if (typeof c.iss !== "string" || !ISSUERS.has(c.iss)) return { ok: false, reason: "wrong issuer" };
  if (c.aud !== options.audience) return { ok: false, reason: "wrong audience" };
  if (typeof c.exp !== "number" || c.exp + SKEW_SEC <= options.nowSec) return { ok: false, reason: "expired" };
  if (typeof c.iat !== "number" || c.iat - SKEW_SEC > options.nowSec) return { ok: false, reason: "issued in the future" };
  if (typeof c.email !== "string" || (c.email_verified !== true && c.email_verified !== "true")) return { ok: false, reason: "address not verified" };
  if (typeof c.nonce !== "string") return { ok: false, reason: "no nonce" };
  return { ok: true, email: c.email, hostedDomain: typeof c.hd === "string" ? c.hd : null, nonce: c.nonce, expiresAt: (c.exp + SKEW_SEC) * 1000, hash: await sha256Hex(`${headerPart}.${claimsPart}.${base64url(signature)}`) };
}

function json(part: string): Record<string, unknown> | null {
  const bytes = fromBase64url(part);
  if (bytes === undefined) return null;
  try {
    const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
    return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Google's signing keys, kept per isolate for as long as Google says. A key id not in a fresh set refetches at most once a minute. */
let keys: { readonly byId: ReadonlyMap<string, CryptoKey>; readonly fetchedAt: number; readonly expiresAt: number } | null = null;

export async function googleKey(kid: string, nowMs: number): Promise<CryptoKey | undefined> {
  const stale = keys === null || keys.expiresAt <= nowMs;
  const unknown = keys !== null && !keys.byId.has(kid) && nowMs - keys.fetchedAt >= 60_000;
  if (stale || unknown) {
    const response = await fetch(GOOGLE_CERTS_URL, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new Error(`Google's signing keys answered ${response.status}`);
    const body = (await response.json()) as { keys?: unknown };
    const byId = new Map<string, CryptoKey>();
    for (const jwk of Array.isArray(body.keys) ? body.keys.slice(0, 20) : []) {
      const { kid: id, kty, n, e } = (jwk ?? {}) as Record<string, unknown>;
      if (typeof id !== "string" || kty !== "RSA" || typeof n !== "string" || typeof e !== "string") continue;
      byId.set(id, await crypto.subtle.importKey("jwk", { kty: "RSA", n, e, alg: "RS256", ext: true }, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]));
    }
    const maxAge = Number(/max-age=(\d+)/i.exec(response.headers.get("cache-control") ?? "")?.[1] ?? 3600);
    keys = { byId, fetchedAt: nowMs, expiresAt: nowMs + Math.min(86_400, Math.max(60, maxAge)) * 1000 };
  }
  return keys?.byId.get(kid);
}
