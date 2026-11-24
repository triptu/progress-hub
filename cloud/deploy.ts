// Deploys the central hub to a Cloudflare account, named by its id, after checking that Alchemy is logged into
// that account. The first deploy of a hub to an account asks for a yes.
//
//   bun run deploy -- --account <account id> --allow you@gmail.com --google-client-id <id>.apps.googleusercontent.com [--domain progress.example.com [--zone example.org]] [--stage prod] [--profile default]
//
// --domain alone is for a domain whose DNS is on this Cloudflare account. With --zone it is for one whose DNS is
// elsewhere: the domain is first made a custom hostname (Cloudflare for SaaS) of that zone, which is on the account,
// and the hub answers it through a route on the zone.
//
// None of the options is written in the repo. The keys the deploy makes are kept in
// ~/.config/progress/deploys/<account id>/progress-central-<stage>/, readable by this user only, so a redeploy keeps
// them and another account or stage never shares them. What Alchemy deployed is kept in the Cloudflare account.
//
// With --workflow there is no profile and no folder: Cloudflare's token comes from $CLOUDFLARE_API_TOKEN, for the
// account in $CLOUDFLARE_ACCOUNT_ID, and the hub's two keys from $PROGRESS_SESSION_KEY and $PROGRESS_MACHINE_KEY.
// They are the keys of the hub that is already deployed, never new ones.
//
// Before anything is uploaded the hub that answers at the address is asked whether it takes these keys, and a
// deploy that would replace them stops. After, it is asked again, and whether it is closed to someone signed out.
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolveMx } from "node:dns/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { deployFolder, fail, keysOf, makeFolder, option, type Deployment, type Keys } from "./place.ts";
import { faults } from "./verify.ts";

const here = import.meta.dir;
const args = process.argv.slice(2);
const account: string = (option(args, "account") ?? "").trim();
const allow: string = (option(args, "allow") ?? "").trim();
const clientId: string = (option(args, "google-client-id") ?? "").trim();
const domain: string = (option(args, "domain") ?? "").trim().toLowerCase();
const zone: string = (option(args, "zone") ?? "").trim().toLowerCase();
const stage: string = (option(args, "stage") ?? "prod").trim();
const profile: string = (option(args, "profile") ?? process.env.ALCHEMY_PROFILE ?? "default").trim();
// Said by the repository's workflow, never taken from the environment alone: a shell that happens to have CI set deploys as a person does.
const ci = args.includes("--workflow");

const host = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/;
if ((domain !== "" && !host.test(domain)) || (zone !== "" && !host.test(zone))) fail("--domain and --zone are host names, such as progress.example.com.");
if (zone !== "" && domain === "") fail("--zone goes with --domain: the zone the domain is a custom hostname of.");
// Stops here unless the account and the stage are well-formed names.
deployFolder(account, stage);
if (!/^[\w-]+\.apps\.googleusercontent\.com$/.test(clientId)) fail("Give the Google OAuth web client's id: --google-client-id <id>.apps.googleusercontent.com.");

// Who may sign in: addresses Google is the authority for. Another address a Google account lists may have changed hands.
const emails = allow.split(",").map((entry) => entry.trim().toLowerCase()).filter((entry) => entry !== "");
if (emails.length === 0 || !emails.every((email) => /^[^\s,@]+@[^\s,@]+\.[^\s,@]+$/.test(email))) fail("Say who may sign in: --allow you@gmail.com, several separated by commas.");
for (const email of emails) {
  const at = email.slice(email.indexOf("@") + 1);
  if (at === "gmail.com") continue;
  const exchanges = await resolveMx(at).catch(() => []);
  if (!exchanges.some(({ exchange }) => /(^|\.)(google\.com|googlemail\.com)$/i.test(exchange))) {
    // A workflow's log is read by more people than the list of who may sign in.
    fail(`${ci ? "An address in --allow" : email} can't be allowed: it is not a Gmail address, and ${at}'s mail is not at Google Workspace, so Google is not the authority for it. A Google account can list such an address after it has changed hands.`);
  }
}

// The account, by its id: Cloudflare must answer for it with the token that will deploy. On a person's machine that
// is Alchemy's profile, which must be logged into this account. In a workflow it is the token in the environment.
let token: string | undefined;
if (ci) {
  if (process.env.CLOUDFLARE_ACCOUNT_ID !== account) fail("In a workflow, --account must be the account in $CLOUDFLARE_ACCOUNT_ID. Nothing was deployed.");
  token = process.env.CLOUDFLARE_API_TOKEN;
} else {
  const profileFile = join(homedir(), ".alchemy", "profiles", profile, "cloudflare.json");
  if (!existsSync(profileFile)) fail(`Alchemy has no profile "${profile}" with Cloudflare. Log in with: bunx alchemy profile edit --profile ${profile}`);
  Bun.spawnSync([join(here, "node_modules", ".bin", "alchemy"), "profile", "refresh", "--profile", profile, "--no-input"], { cwd: here, stdout: "ignore", stderr: "ignore" });
  const values = (JSON.parse(readFileSync(profileFile, "utf8")) as { values?: { accountId?: string; access?: string; apiToken?: string } }).values ?? {};
  if (values.accountId !== account) fail(`Alchemy's profile "${profile}" is logged into another Cloudflare account (${values.accountId ?? "none"}), not ${account}. Nothing was deployed.`);
  token = values.access ?? values.apiToken;
}
const looked = token ? await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}`, { headers: { Authorization: `Bearer ${token}` } }).catch(() => null) : null;
const found = looked?.ok ? ((await looked.json()) as { result?: { id?: string; name?: string } }).result : undefined;
if (!found || found.id !== account || !found.name) fail(`Cloudflare did not answer for the account ${account}${looked ? ` (${looked.status})` : ""}. Nothing was deployed.`);

// The hub's keys. A workflow is given the keys of the hub that is deployed: with new ones every session and every
// linked machine would be refused. A person's machine keeps them in the deployment's folder, whose path names the
// account, and `deployment.json` is written there only once a deploy succeeded.
let keys: Keys;
const folder = ci ? mkdtempSync(join(tmpdir(), "progress-deploy-")) : deployFolder(account, stage);
if (ci) {
  keys = { sessionKey: process.env.PROGRESS_SESSION_KEY ?? "", machineKey: process.env.PROGRESS_MACHINE_KEY ?? "" };
  if (keys.sessionKey.length < 32 || keys.machineKey.length < 32) fail("In a workflow, the deployed hub's keys come from $PROGRESS_SESSION_KEY and $PROGRESS_MACHINE_KEY. Nothing was deployed.");
  console.log(`Deploying the central progress hub, ${stage}, to the Cloudflare account ${account}.`);
} else {
  if (!existsSync(join(folder, "deployment.json"))) {
    const reply = prompt(`Deploy a new central progress hub, ${stage}, to the Cloudflare account "${found.name}" (${account}), with Alchemy profile "${profile}"? Type yes:`)?.trim().toLowerCase();
    if (reply !== "yes" && reply !== "y") fail("Nothing was deployed.");
  } else {
    console.log(`Deploying the central progress hub, ${stage}, to the Cloudflare account "${found.name}" (${account}).`);
  }
  makeFolder(folder);
  keys = keysOf(folder);
}

// The hub that is deployed must take these keys. With others, every session would end and every linked machine
// would be refused, so nothing is uploaded. Where no hub answers yet, this is its first deploy.
const known = domain ? `https://${domain}` : ci ? null : ((existsSync(join(folder, "deployment.json")) ? (JSON.parse(readFileSync(join(folder, "deployment.json"), "utf8")) as Deployment).url : null) ?? null);
const before = known ? await faults(known, keys, emails[0]!) : null;
if (before?.length) fail(`The hub at ${known} is not the one these keys are for. Nothing was deployed.\n${before.join("\n")}`);

// The app, built once. Its script runs before the first paint, as the local hub serves it.
const dist = join(here, "dist");
rmSync(dist, { recursive: true, force: true });
const build = Bun.spawnSync(["bun", "build", join(here, "..", "src", "web", "index.html"), "--outdir", dist, "--minify", "--public-path", "/"], { stdout: "inherit", stderr: "inherit" });
if (build.exitCode !== 0) fail("The app did not build.");
const page = join(dist, "index.html");
writeFileSync(page, readFileSync(page, "utf8").replace('<script type="module"', '<script type="module" blocking="render"'));

// Alchemy runs in the folder, so its bundles and logs are kept there and never in the checkout.
const deploy = Bun.spawn([join(here, "node_modules", ".bin", "alchemy"), "deploy", join(here, "alchemy.run.ts"), "--stage", stage, ...(ci ? [] : ["--profile", profile]), "--no-input", "--yes"], {
  cwd: folder,
  env: { ...process.env, PROGRESS_ALLOW: emails.join(","), PROGRESS_GOOGLE_CLIENT_ID: clientId, PROGRESS_DOMAIN: domain, PROGRESS_ZONE: zone, PROGRESS_MACHINE_KEY: keys.machineKey, PROGRESS_SESSION_KEY: keys.sessionKey },
  stdout: "pipe",
  stderr: "inherit",
});
let said = "";
for await (const chunk of deploy.stdout) {
  const text = new TextDecoder().decode(chunk);
  said += text;
  process.stdout.write(text);
}
if ((await deploy.exited) !== 0) fail("The deploy failed. It may have changed part of what is deployed: run it again once what stopped it is fixed.");
const url = domain ? `https://${domain}` : (/https:\/\/[\w.-]+\.workers\.dev/.exec(said)?.[0] ?? null);
// What was deployed is asked the same things. A route or a certificate can take a moment, so it is asked a few times.
let after: string[] | null = null;
for (let tries = 0; url && tries < 6; tries++) {
  after = await faults(url, keys, emails[0]!);
  if (after?.length === 0) break;
  await Bun.sleep(5000);
}
if (url && after?.length !== 0) fail(`It deployed, and the hub at ${url} is not right:\n${after ? after.join("\n") : "Nothing answers there as a hub."}`);
if (ci) {
  console.log(`\nThe central hub is at ${url ?? "the address above"}.`);
  process.exit(0);
}
writeFileSync(join(folder, "deployment.json"), JSON.stringify({ url } satisfies Deployment));
console.log(`
The central hub is at ${url ?? "the address above"}. Only ${emails.join(", ")} can sign in.
Google's client must list ${url ?? "that address"} under "Authorized JavaScript origins".
Its keys are in ${folder}.
Link a machine to it: make it a credential here with
  bun run credential -- --account ${account}${stage === "prod" ? "" : ` --stage ${stage}`} --name <the machine's name>
then, on that machine, progress link ${url ?? "<address>"} < <the file it names>`);
