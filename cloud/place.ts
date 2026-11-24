// Where a deployment's keys and Alchemy's state are kept: one folder for each Cloudflare account and hub, readable
// by this user only, outside the checkout. Nothing in it is ever written in the repo.
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { makeOrder } from "../src/central/login.ts";

// Every file and folder this process or Alchemy makes is this user's alone from the moment it exists.
process.umask(0o077);

export const STACK = "progress-central";

/**
 * `~/.config/progress/deploys/<account id>/<stack>-<stage>`. Both names are checked here, so nothing that is given
 * one can be pointed at another deployment's folder.
 */
export function deployFolder(account: string, stage: string): string {
  if (!/^[0-9a-f]{32}$/.test(account)) fail("Name the Cloudflare account by its id: --account <32 hex characters>. It is on the account's home page in the dashboard.");
  if (!/^[a-z0-9]{1,20}$/.test(stage)) fail("A stage is a short lowercase name, such as prod.");
  return join(process.env.XDG_CONFIG_HOME?.trim() || join(homedir(), ".config"), "progress", "deploys", account, `${STACK}-${stage}`);
}

/** Makes the folder, and makes it owner only when an earlier run made it otherwise. */
export function makeFolder(folder: string): void {
  mkdirSync(folder, { recursive: true });
  chmodSync(folder, 0o700);
}

/** A file in the folder, made once with `make` and kept for every later run. */
export function keep(folder: string, name: string, make: () => string): string {
  const path = join(folder, name);
  if (!existsSync(path)) writeFileSync(path, make(), { flag: "wx" });
  return readFileSync(path, "utf8");
}

/** What the folder records about a deployment that succeeded: where it answers. */
export interface Deployment {
  readonly url: string | null;
}

/** The keys a deployment's Worker holds: one signs sessions, one makes machines' credentials. */
export interface Keys {
  readonly sessionKey: string;
  readonly machineKey: string;
}

const random = () => Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");

export const keysOf = (folder: string): Keys => JSON.parse(keep(folder, "keys.json", () => JSON.stringify({ sessionKey: random(), machineKey: random() }))) as Keys;

/** A deployment that succeeded, named by `--account` and `--stage`: its folder and where it answers. */
export interface Deployed {
  readonly folder: string;
  readonly url: string | null;
}

export function deployed(args: readonly string[]): Deployed {
  const account = (option(args, "account") ?? "").trim();
  const folder = deployFolder(account, (option(args, "stage") ?? "prod").trim());
  if (!existsSync(join(folder, "deployment.json"))) fail("Name the account the hub was deployed to: --account <its id>, and --stage when it is not prod. Deploy first.");
  const { url } = JSON.parse(readFileSync(join(folder, "deployment.json"), "utf8")) as Deployment;
  return { folder, url };
}

/** One request to the deployed hub, with an order its machine key signs for this request alone. Stops unless the hub took it. */
export async function order(deployment: Deployed, method: string, path: string): Promise<Response> {
  if (deployment.url === null) fail("The folder does not record the hub's address. Deploy again, and it does.");
  const signed = await makeOrder(keysOf(deployment.folder).machineKey, method, path, Math.floor(Date.now() / 1000));
  const answer = await fetch(deployment.url + path, { method, headers: { Authorization: `Bearer ${signed}` }, signal: AbortSignal.timeout(60_000) }).catch(() => null);
  if (answer?.ok) return answer;
  return fail(`The hub at ${deployment.url} did not do it: ${answer ? `${answer.status}, ${(await answer.text()).slice(0, 200)}` : "it did not answer"}.`);
}

export function option(args: readonly string[], name: string): string | undefined {
  const at = args.indexOf(`--${name}`);
  return at === -1 ? undefined : args[at + 1];
}

export function fail(message: string): never {
  console.error(message);
  process.exit(1);
  throw new Error(message);
}
