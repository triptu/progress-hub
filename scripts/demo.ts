// The hub on the sample pages, as it looks after a week of use: `bun run demo`.
//
// A hub dates only what it sees arrive on a page. So the sample pages are played into a copy a step at a
// time, each step set a while before now, and the hub is then started on that copy with no harness read.
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { Todo, WorkId } from "../src/core/types.ts";
import { DiskStore } from "../src/stores/disk/index.ts";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
/** How long before now each step of a page was written. The first is the page before anything on it shipped. */
const AGO = [6 * 24 * HOUR, 4 * 24 * HOUR, 2 * 24 * HOUR, 26 * HOUR, 5 * HOUR, 12 * MINUTE];
const LAST = AGO.length - 1;

/**
 * A page as it stood at a step. What it lists under Shipped and each thing it asks under Needs you arrive
 * over the steps: a page keeps its newest shipped line on top, so the lowest came first.
 */
function pageAt(text: string, step: number): string {
  const lines = text.split("\n");
  // Each item's first line, by the section it is in. An item runs to the next item or heading.
  const starts: { line: number; section: "shipped" | "needs" }[] = [];
  let section: "shipped" | "needs" | null = null;
  lines.forEach((line, index) => {
    if (line.startsWith("## ")) section = /^## shipped/i.test(line) ? "shipped" : /^## needs you/i.test(line) ? "needs" : null;
    else if ((section === "shipped" && line.startsWith("- ")) || (section === "needs" && line.startsWith("### "))) starts.push({ line: index, section });
  });
  const hidden = new Set<number>();
  for (const kind of ["shipped", "needs"] as const) {
    const items = starts.filter((start) => start.section === kind);
    items.forEach((item, index) => {
      const arrives = kind === "shipped" ? LAST - Math.floor((index * LAST) / items.length) : 1 + Math.floor((index * LAST) / items.length);
      if (arrives <= step) return;
      const next = starts.find((start) => start.line > item.line)?.line ?? lines.length;
      const end = lines.findIndex((line, at) => at > item.line && at < next && line.startsWith("## "));
      for (let at = item.line; at < (end === -1 ? next : end); at++) hidden.add(at);
    });
  }
  return lines.filter((_, index) => !hidden.has(index)).join("\n");
}

const now = Date.now();
const home = mkdtempSync(join(tmpdir(), "progress-demo-"));
process.on("exit", () => rmSync(home, { recursive: true, force: true }));
// The pages and what they show, without the history or the marks a hub run on the samples themselves left there.
cpSync(join(import.meta.dir, "..", "test", "pages"), home, { recursive: true, filter: (from) => !/^\.(?!sessions$)/.test(basename(from)) });
const works = readdirSync(home).filter((name) => !name.startsWith("."));
const pages = works.map((work) => ({ file: join(home, work, "progress.md"), text: readFileSync(join(home, work, "progress.md"), "utf8") }));
// No harness and no GitHub: the sample pull requests are not real ones.
const store = new DiskStore(home, [], async () => null);
AGO.forEach((ago, step) => {
  for (const page of pages) {
    writeFileSync(page.file, pageAt(page.text, step));
    utimesSync(page.file, new Date(now - ago), new Date(now - ago));
  }
  store.refresh();
});

const todo = (text: string, ago: number, more: Partial<Todo> = {}): Todo => ({ id: crypto.randomUUID(), text, description: "", work: null, project: null, addedAt: new Date(now - ago).toISOString() as Todo["addedAt"], doneAt: null, ...more });
const todos = [
  todo("Tell the team the sync tests now run in random order on PRs", 3 * HOUR, { work: "sync-reliability" as WorkId }),
  todo("Delete the old index bucket once the rebuild has run everywhere", 26 * HOUR, { work: "search-speed" as WorkId, description: "Wait a week after the release, then check nothing still reads it.\nhttps://example.com/buckets/kestrel-index-v1" }),
  todo("Renew the Apple developer membership", 2 * 24 * HOUR),
  todo("Ask design for the empty-state illustration", 3 * 24 * HOUR, { project: "kestrel" }),
  todo("Book the device farm for the March release", 5 * 24 * HOUR, { doneAt: new Date(now - 20 * HOUR).toISOString() as Todo["doneAt"] }),
];
writeFileSync(join(home, ".todos.json"), JSON.stringify(todos.filter((item) => item.work === null || works.includes(item.work)), null, 1));

const hub = Bun.spawn(["bun", join(import.meta.dir, "..", "src", "main.ts"), "serve"], {
  env: { ...process.env, PROGRESS_HOME: home, PROGRESS_T3_DB: "off", PROGRESS_PEERS: "", PROGRESS_PORT: process.env.PROGRESS_PORT ?? "4748" },
  stdio: ["inherit", "inherit", "inherit"],
});
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => hub.kill());
process.exit(await hub.exited);
