// Makes a credential for one machine to send to a central hub this machine deployed. The credential names the
// machine's id, and the hub reads who is sending from it, so each machine can write only its own works.
//
//   bun run credential -- --account <account id> --name <the machine's name> [--stage prod]
//
// It is written to a file readable by this user only, in the deployment's folder. Carry that file to the machine,
// and there: progress link <address> < <the file>.
import { mkdirSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { makeCredential } from "../src/central/login.ts";
import { deployed, keysOf, option } from "./place.ts";

const args = process.argv.slice(2);
const name = (option(args, "name") ?? hostname()).trim();
const { folder, url } = deployed(args);
// The machine's name and a few random letters, so two machines with one name never share an id.
const base = (name.split(".")[0] ?? "").toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 30) || "machine";
const machine = `${base}-${crypto.getRandomValues(new Uint32Array(1))[0]!.toString(36).slice(0, 4).padStart(4, "0")}`;
const machines = join(folder, "machines");
mkdirSync(machines, { recursive: true });
const file = join(machines, machine);
writeFileSync(file, `${await makeCredential(keysOf(folder).machineKey, machine)}\n`, { flag: "wx" });
console.log(`A credential for ${machine} is in ${file}.
On that machine: progress link ${url ?? "<the hub's address>"} < ${machine}`);
