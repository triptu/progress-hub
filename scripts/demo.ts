// The hub on the sample pages, as it looks after a week of use: `bun run demo`.
//
// A hub dates only what it sees arrive on a page. So a copy of the sample pages is given the history a hub
// would have written had their Shipped lines and their asks arrived a few at a time over the last days, and
// the hub is started on that copy with no harness read.
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { pageEvents, writeJournal } from "../src/core/journal.ts";
import { parsePage } from "../src/core/parse.ts";
import type { JournalEvent, Todo, WorkId } from "../src/core/types.ts";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
/** How long before now each step of a page was written. The first is the page before anything on it shipped. */
const AGO = [6 * 24 * HOUR, 4 * 24 * HOUR, 2 * 24 * HOUR, 26 * HOUR, 5 * HOUR, 12 * MINUTE];
const LAST = AGO.length - 1;

const now = Date.now();
const home = mkdtempSync(join(tmpdir(), "progress-demo-"));
process.on("exit", () => rmSync(home, { recursive: true, force: true }));
// The pages and what they show, without the history a hub run on the samples themselves left there.
cpSync(join(import.meta.dir, "..", "test", "pages"), home, { recursive: true, filter: (from) => !/^\.(?!sessions$)/.test(basename(from)) });
for (const work of readdirSync(home)) {
  const file = join(home, work, "progress.md");
  const page = parsePage(readFileSync(file, "utf8"), join(home, work));
  const events: JournalEvent[] = [];
  AGO.forEach((ago, step) => {
    // The page as it stood at this step. A page keeps its newest shipped line on top, so the lowest came first.
    const sections = page.sections.map((section) => ({
      ...section,
      items: section.items.filter((_, index) => {
        const share = Math.floor((index * LAST) / section.items.length);
        return section.kind === "shipped" ? LAST - share <= step : section.kind === "needs" ? 1 + share <= step : true;
      }),
    }));
    events.push(...pageEvents(events, { ...page, sections }, new Date(now - ago)));
  });
  writeFileSync(join(home, work, ".history.jsonl"), writeJournal(events));
  // The page was last written at the last step.
  utimesSync(file, new Date(now - AGO[LAST]!), new Date(now - AGO[LAST]!));
}

const todo = (text: string, ago: number, more: Partial<Todo> = {}): Todo => ({ id: crypto.randomUUID(), text, description: "", work: null, project: null, addedAt: new Date(now - ago).toISOString() as Todo["addedAt"], doneAt: null, ...more });
const todos = [
  todo("Tell the team the sync tests now run in random order on PRs", 3 * HOUR, { work: "sync-reliability" as WorkId }),
  todo("Delete the old index bucket once the rebuild has run everywhere", 26 * HOUR, { work: "search-speed" as WorkId, description: "Wait a week after the release, then check nothing still reads it.\nhttps://example.com/buckets/kestrel-index-v1" }),
  todo("Renew the Apple developer membership", 2 * 24 * HOUR),
  todo("Ask design for the empty-state illustration", 3 * 24 * HOUR, { project: "kestrel" }),
  todo("Book the device farm for the March release", 5 * 24 * HOUR, { doneAt: new Date(now - 20 * HOUR).toISOString() as Todo["doneAt"] }),
];
writeFileSync(join(home, ".todos.json"), JSON.stringify(todos, null, 1));

const hub = Bun.spawn(["bun", join(import.meta.dir, "..", "src", "main.ts"), "serve"], {
  env: { ...process.env, PROGRESS_HOME: home, PROGRESS_T3_DB: "off", PROGRESS_PEERS: "", PROGRESS_PORT: process.env.PROGRESS_PORT ?? "4748" },
  stdio: ["inherit", "inherit", "inherit"],
});
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => hub.kill());
process.exit(await hub.exited);
