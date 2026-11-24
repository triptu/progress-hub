import { expect, test } from "bun:test";
import type { Health, HubState, Instant, WorkId, WorkSummary } from "../src/core/types.ts";
import { devicesOf, statusOf } from "../src/web/lib/devices.ts";

const OK: Health = { ok: true };
const down = (since: string, reason = "It may be asleep or offline."): Health => ({ ok: false, since: since as Instant, reason });
const work = (id: string, lastChangeAt: string) => ({ id: id as WorkId, lastChangeAt: lastChangeAt as Instant }) as WorkSummary;
const hub = (part: Partial<HubState>): HubState => ({ works: [], needs: [], plan: [], shipped: [], feed: [], latestMedia: null, home: OK, stores: [], sources: [], marks: { viewed: [], dismissed: [] }, todos: [], ...part });

test("each machine is listed with its own works, the hub's machine first, and a machine that is off is quiet, not a fault", () => {
  const listed = devicesOf(
    hub({
      machine: { label: "Laptop", central: null },
      stores: [
        { id: "mini", label: "Mini", health: OK },
        { id: "studio", label: "Studio", health: down("2026-11-20T10:00:00Z") },
      ],
      works: [work("mini~a", "2026-11-24T09:00:00Z"), work("b", "2026-11-24T08:00:00Z"), work("mini~c", "2026-11-23T08:00:00Z"), work("studio~d", "2026-11-20T08:00:00Z")],
    }),
    true,
  );
  expect(listed.machines.map((machine) => [machine.name, statusOf(machine), machine.works, machine.lastChangeAt])).toEqual([
    ["Laptop", "ok", 1, "2026-11-24T08:00:00Z"],
    ["Mini", "ok", 2, "2026-11-24T09:00:00Z"],
    ["Studio", "quiet", 1, "2026-11-20T08:00:00Z"],
  ]);
  expect(listed.machines[2]?.health).toMatchObject({ ok: false, since: "2026-11-20T10:00:00Z" });
  expect([listed.worst, listed.trouble]).toEqual(["quiet", "Studio is offline."]);
});

test("a hub that keeps no works of its own lists only the machines that sent to it, and two with one name are told apart", () => {
  const listed = devicesOf(hub({ stores: [{ id: "mac-ab12", label: "Mac", health: down("2026-11-20T10:00:00Z") }, { id: "mac-cd34", label: "Mac", health: down("2026-11-21T10:00:00Z") }] }), true);
  expect(listed.machines.map((machine) => [machine.id, machine.twin])).toEqual([["mac-ab12", true], ["mac-cd34", true]]);
  expect(listed.checks.map((check) => check.key)).toEqual(["browser"]);
  // One name is said once, however many machines have it.
  expect(listed.trouble).toBe("Mac is offline.");
});

test("what the hub itself can't do is a fault, and outranks a machine that is off", () => {
  const broken = hub({
    machine: { label: "Laptop", central: { url: "https://hub.example", health: down("2026-11-24T09:00:00Z", "It answered 503.") } },
    stores: [{ id: "mini", label: "Mini", health: down("2026-11-20T10:00:00Z") }],
    sources: [{ id: "t3", label: "T3", health: OK }],
  });
  const all = devicesOf(broken, true);
  // What is at fault is listed first, and still says where it sends.
  expect(all.checks.map((check) => [check.key, check.ok, check.about])).toEqual([["central", false, "hub.example"], ["browser", true, "Updates live"], ["pages", true, "On Laptop"], ["source t3", true, "Agent sessions"]]);
  expect(all.checks[0]?.broken).toMatchObject({ reason: "It answered 503." });
  expect([all.worst, all.trouble]).toEqual(["fault", "Can't send to the central hub. Mini is offline."]);
  // A browser that can't reach the hub says only that: the rest is as it last heard.
  expect(devicesOf(broken, false).trouble).toBe("Can't reach the hub. Showing the last update.");
  expect(devicesOf(hub({ machine: { label: "Laptop", central: null }, home: down("2026-11-24T09:00:00Z"), sources: [{ id: "t3", label: "T3", health: down("2026-11-24T09:00:00Z") }] }), true).trouble).toBe("Can't read the progress pages. Can't read T3.");

  const fine = devicesOf(hub({ machine: { label: "Laptop", central: { url: "https://hub.example", health: OK } }, sources: [{ id: "t3", label: "T3", health: OK }] }), true);
  expect([fine.worst, fine.trouble]).toEqual(["ok", ""]);
});

test("a harness another machine's hub can't read is said on that machine, not as this hub's", () => {
  const listed = devicesOf(hub({ machine: { label: "Laptop", central: null }, stores: [{ id: "mini", label: "Mini", health: OK }], sources: [{ id: "t3", label: "T3", health: OK }, { id: "mini~t3", label: "T3 on Mini", health: down("2026-11-24T09:00:00Z", "Locked.") }] }), true);
  expect(listed.checks.map((check) => check.key)).toEqual(["browser", "pages", "source t3"]);
  expect(listed.machines[1]).toMatchObject({ name: "Mini", unread: { name: "T3 on Mini", broken: { reason: "Locked." } } });
  expect(statusOf(listed.machines[1]!)).toBe("fault");
  expect([listed.worst, listed.trouble]).toEqual(["fault", "Can't read T3 on Mini."]);
});
