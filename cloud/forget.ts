// Removes a machine from a central hub this machine deployed. The hub forgets its works, pages and files, pages that
// are open show it gone, and its credential is refused from then on. Its credential file here goes too.
// The machine is named by its exact id, as `bun run machines` lists it. Run again for a machine already removed,
// it deletes whatever of its files is still in the bucket, such as one that was arriving as it was removed.
//
//   bun run forget -- --account <account id> --machine <id> [--stage prod]
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { MACHINE_ID, MACHINES_PATH, type Forgotten } from "../src/central/protocol.ts";
import { deployed, fail, option, order } from "./place.ts";

const args = process.argv.slice(2);
const deployment = deployed(args);
const machine = (option(args, "machine") ?? "").trim();
if (!MACHINE_ID.test(machine)) fail("Name the machine by its exact id: --machine <id>. bun run machines lists them.");

const { files, done } = (await (await order(deployment, "DELETE", `${MACHINES_PATH}/${machine}`)).json()) as Forgotten;
const credential = join(deployment.folder, "machines", machine);
if (existsSync(credential)) rmSync(credential);
console.log(`Removed ${machine}. The hub shows nothing of it, and its credential is refused from now on.`);
console.log(done ? `The bucket holds none of its files now: ${files} went.` : `${files} of its files went from the bucket, which has more than one request deletes. Run this again to delete the rest.`);
