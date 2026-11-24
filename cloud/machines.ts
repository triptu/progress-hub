// Lists the machines a central hub this machine deployed holds: each one's id, its name, when it last sent, and
// how many works it shows. Removing one takes its id.
//
//   bun run machines -- --account <account id> [--stage prod]
import { MACHINES_PATH, type HeldMachine } from "../src/central/protocol.ts";
import { deployed, order } from "./place.ts";

const machines = (await (await order(deployed(process.argv.slice(2)), "GET", MACHINES_PATH)).json()) as HeldMachine[];
if (machines.length === 0) console.log("The hub holds no machine.");
const width = Math.max(0, ...machines.map(({ id }) => id.length));
for (const { id, label, heard, works } of machines) {
  // A machine never shown sent a state whose files never all arrived.
  const shown = label === null ? "never shown" : `${label}, ${works} work${works === 1 ? "" : "s"}`;
  console.log(`${id.padEnd(width)}  ${heard > 0 ? `last sent ${new Date(heard).toISOString()}` : "never sent"}  ${shown}`);
}
