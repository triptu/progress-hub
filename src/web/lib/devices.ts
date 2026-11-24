import type { Health, HubState, Instant } from "../../core/types.ts";

/**
 * What the Devices screen lists, worked out from the hub's state: the machines whose work the hub shows, and
 * what the hub itself depends on. The bar's button says the worst of them, so nothing else on a screen has to.
 */

/** `quiet` is a machine that is asleep or off, which is no fault. `fault` is something a hub should be able to do and can't. */
export type Status = "ok" | "quiet" | "fault";

/** Since when something could not be read, and what the hub was told. */
type Broken = Extract<Health, { ok: false }>;

export interface Machine {
  /** Null for the machine the hub runs on. */
  readonly id: string | null;
  readonly name: string;
  /** True when another machine has the same name, so the screen tells them apart by their ids. */
  readonly twin: boolean;
  /** Whether it answers, and since when it has not. */
  readonly health: Health;
  /** A harness its own hub can't read, while the machine answers. */
  readonly unread: { readonly name: string; readonly broken: Broken } | null;
  readonly works: number;
  readonly lastChangeAt: Instant | null;
}

/** Something the hub reads or sends to: the browser's own line to the hub, the pages, a harness, a central hub. */
export interface Check {
  readonly kind: "browser" | "pages" | "source" | "central";
  readonly key: string;
  readonly name: string;
  /** What it is, in a few words: where the pages are, the address sent to. Empty when there is nothing to add. */
  readonly about: string;
  readonly ok: boolean;
  /** Null for the browser, which knows only that the hub does not answer. */
  readonly broken: Broken | null;
}

/** Each kind of check in words: its state while it works, when it doesn't, and the sentence that says so anywhere else. */
export const CHECK_SAYS: Record<Check["kind"], { readonly ok: string; readonly fault: string; readonly trouble: (name: string) => string }> = {
  browser: { ok: "Connected", fault: "Not connected", trouble: () => "Can't reach the hub." },
  pages: { ok: "OK", fault: "Can't be read", trouble: () => "Can't read the progress pages." },
  source: { ok: "OK", fault: "Can't be read", trouble: (name) => `Can't read ${name}.` },
  central: { ok: "Sending", fault: "Not sending", trouble: () => "Can't send to the central hub." },
};
export const MACHINE_SAYS: Record<Status, string> = { ok: "Online", quiet: "Offline", fault: "Can't read agents" };

export const statusOf = (machine: Machine): Status => (!machine.health.ok ? "quiet" : machine.unread ? "fault" : "ok");

export interface Devices {
  readonly machines: readonly Machine[];
  /** What is at fault first. */
  readonly checks: readonly Check[];
  readonly worst: Status;
  /** What can't be reached, in a sentence or two, or empty when all is well. */
  readonly trouble: string;
}

/** Another machine's works and harnesses carry its id, as `<id>~<name>`. */
const from = (id: string, stores: HubState["stores"]) => stores.find((store) => id.startsWith(`${store.id}~`))?.id ?? null;

export function devicesOf(hub: HubState | null, reachable: boolean): Devices {
  const stores = hub?.stores ?? [];
  const count = new Map<string | null, { works: number; lastChangeAt: Instant | null }>();
  // The works are newest first, so the first of a machine's is its last change.
  for (const work of hub?.works ?? []) {
    const id = from(work.id, stores);
    const held = count.get(id);
    count.set(id, { works: (held?.works ?? 0) + 1, lastChangeAt: held?.lastChangeAt ?? work.lastChangeAt });
  }
  const names = [...(hub?.machine ? [hub.machine.label] : []), ...stores.map((store) => store.label)];
  const sources = hub?.sources ?? [];
  const machine = (id: string | null, name: string, health: Health): Machine => {
    // A harness another machine's hub reads is that machine's, and is said on its row.
    const unread = id === null ? undefined : sources.find((source) => from(source.id, stores) === id && !source.health.ok);
    return { id, name, twin: names.filter((other) => other === name).length > 1, health, unread: unread && !unread.health.ok ? { name: unread.label, broken: unread.health } : null, ...(count.get(id) ?? { works: 0, lastChangeAt: null }) };
  };
  const machines = [...(hub?.machine ? [machine(null, hub.machine.label, { ok: true })] : []), ...stores.map((store) => machine(store.id, store.label, store.health))];

  const check = (kind: Check["kind"], key: string, name: string, health: Health, about: string): Check => ({ kind, key, name, about, ok: health.ok, broken: health.ok ? null : health });
  const central = hub?.machine?.central;
  const listed: Check[] = [
    { kind: "browser", key: "browser", name: "This browser", about: reachable ? "Updates live" : "", ok: reachable, broken: null },
    // A central hub keeps no pages of its own.
    ...(hub?.machine ? [check("pages", "pages", "Progress pages", hub.home, `On ${hub.machine.label}`)] : []),
    ...sources.filter((source) => from(source.id, stores) === null).map((source) => check("source", `source ${source.id}`, source.label, source.health, "Agent sessions")),
    ...(central ? [check("central", "central", "Central hub", central.health, URL.canParse(central.url) ? new URL(central.url).host : central.url)] : []),
  ];
  const checks = [...listed.filter((one) => !one.ok), ...listed.filter((one) => one.ok)];

  const faults = [...checks.filter((one) => !one.ok).map((one) => CHECK_SAYS[one.kind].trouble(one.name)), ...machines.flatMap((one) => (statusOf(one) === "fault" && one.unread ? [CHECK_SAYS.source.trouble(one.unread.name)] : []))];
  const quiet = offline([...new Set(machines.filter((one) => statusOf(one) === "quiet").map((one) => one.name))]);
  return {
    machines,
    checks,
    worst: faults.length > 0 ? "fault" : quiet ? "quiet" : "ok",
    // A browser that can't reach the hub knows nothing newer about the rest.
    trouble: reachable ? [...faults, quiet].filter(Boolean).join(" ") : "Can't reach the hub. Showing the last update.",
  };
}

/** "A is offline.", "A and B are offline.", "A, B and C are offline.", or nothing for none. */
function offline(names: readonly string[]): string {
  if (names.length === 0) return "";
  return names.length === 1 ? `${names[0]} is offline.` : `${names.slice(0, -1).join(", ")} and ${names.at(-1)} are offline.`;
}
