// What the hub at an address answers, asked three ways: signed out, as the deployer, and as someone allowed in.
// A deploy asks before it uploads anything, so it never replaces a hub's keys with others, and again after, so a
// deploy that left the hub open or unreadable fails.
import { COOKIE, makeOrder, makeSession } from "../src/central/login.ts";
import { MACHINES_PATH } from "../src/central/protocol.ts";
import type { Keys } from "./place.ts";

const CLOSED = ["/", "/api/state", "/api/media", "/files/x/y.png"];

/**
 * What is wrong with the hub at `url`, each in a sentence, or none when it is closed to someone signed out, takes
 * an order signed with the machine key, and answers a session signed with the session key. Null when no hub
 * answers there at all, as before a first deploy.
 */
export async function faults(url: string, keys: Keys, email: string): Promise<string[] | null> {
  const ask = (path: string, headers: Record<string, string> = {}) => fetch(url + path, { headers, redirect: "manual", signal: AbortSignal.timeout(30_000) }).catch(() => null);
  const signedOut = await ask("/api/state");
  if (signedOut?.status !== 401) return null;
  const found: string[] = [];
  for (const path of CLOSED) {
    const status = (await ask(path))?.status;
    if (status !== 401) found.push(`Signed out, ${path} answered ${status ?? "nothing"}, not 401.`);
  }
  const now = Math.floor(Date.now() / 1000);
  const listed = await ask(MACHINES_PATH, { Authorization: `Bearer ${await makeOrder(keys.machineKey, "GET", MACHINES_PATH, now)}` });
  if (listed?.status !== 200) found.push("It does not take the machine key: every linked machine's credential was made with another.");
  const read = await ask("/api/state", { Cookie: `${COOKIE}=${await makeSession(keys.sessionKey, email, now)}` });
  const state = read?.status === 200 ? ((await read.json().catch(() => null)) as { works?: unknown } | null) : null;
  if (!Array.isArray(state?.works)) found.push("It does not take the session key, or does not answer someone signed in.");
  return found;
}
