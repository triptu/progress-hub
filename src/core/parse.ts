import { existsSync } from "node:fs";
import { isAbsolute, join, normalize, relative } from "node:path";
import { LONG_TITLE, openingDate, plain, splitItem, trimLines, underWay } from "./text.ts";
import type { Item, Page, Section, SectionKind, TryLink } from "./types.ts";

export const SECTION_LABEL: Readonly<Record<SectionKind, string>> = { needs: "Needs you", doing: "In progress", next: "Next", decisions: "Decisions", shipped: "Shipped" };

/** Each known section's names, as whole words at the start of a heading: "Shipped today" is Shipped, "Needs your eyes later" is not Needs you. */
const KNOWN: readonly { readonly kind: SectionKind; readonly name: RegExp }[] = [
  { kind: "needs", name: /^needs you\b/i },
  { kind: "doing", name: /^(in progress|in review|in flight|doing|working on)\b/i },
  { kind: "next", name: /^(next|up next|to ?do|planned)\b/i },
  { kind: "decisions", name: /^decision(s|\s+log)?\b/i },
  { kind: "shipped", name: /^shipped\b/i },
];

const NEAR_MISSES: readonly { readonly kind: SectionKind; readonly name: RegExp }[] = [
  { kind: "needs", name: /^(need you|needs from you|needs your|blocked on you|waiting on you|waiting for you|for you)\b/i },
  { kind: "doing", name: /^(wip|ongoing|underway|current(ly)?|now)\b/i },
  { kind: "next", name: /^(upcoming|later|backlog|plan|queue|remaining)\b/i },
  { kind: "decisions", name: /^(decided|choices)\b/i },
  { kind: "shipped", name: /^(ship|shipping|landed|merged)\b/i },
];

/** All an empty Needs you may say. Anything else, even "No access to staging", is shown, so a blocker is never missed. */
const NOTHING = /^(nothing|none|no blockers|n\/a|nothing needs you|nothing is waiting)( (right now|for now|yet|so far|today|currently|at the moment))?$/;

/** "Nothing right now." with more after it, which is an ask however it opens. */
function startsWithNothing(title: string): boolean {
  const first = /^.*?[.!](?=\s)/.exec(title)?.[0];
  return first !== undefined && saysNothing(first);
}

function saysNothing(markdown: string): boolean {
  const text = plain(markdown.replace(/^\s*([-*+]|\d+[.)])\s+/, "")).toLowerCase();
  return NOTHING.test(text.replace(/[.!]+$/, ""));
}

interface Block {
  readonly level: number;
  readonly heading: string;
  /** Where the block starts among the lines it was split from: its heading, or its first line. */
  readonly at: number;
  readonly lines: readonly string[];
}

/** Lines of the page, counted from 0, `end` excluded. A line ends at \n, \r\n or a lone \r. */
export interface Span {
  readonly start: number;
  readonly end: number;
}

export interface LocatedItem {
  readonly item: Item;
  readonly kind: SectionKind;
  /** The item's lines, with the blank lines after it up to the next item. */
  readonly span: Span;
  /** `###`, or the bullet it starts with (`-`, `1.`, `!`…). Null for an ask written as prose. */
  readonly marker: string | null;
}

export interface LocatedSection {
  readonly kind: SectionKind | null;
  /** From the heading to the line before the next `#` or `##` heading. */
  readonly span: Span;
  readonly items: readonly LocatedItem[];
  /** In Needs you, the "Nothing right now." that says no item is open. */
  readonly nothing: Span | null;
}

/** A page, and the lines each part of it came from. Every section is here, Goal too. */
export interface LocatedPage {
  readonly page: Page;
  readonly summary: Span;
  /** A summary paragraph that starts "Goal:", which is the goal and not the summary. */
  readonly goalInSummary: Span | null;
  readonly sections: readonly LocatedSection[];
}

/** Reads a progress.md. Never throws. `folder` is the work's folder, used to check links. */
export function parsePage(source: string, folder: string | null = null): Page {
  return locatePage(source, folder).page;
}

/** Reads a progress.md as `parsePage` does, and says which lines each part came from. */
export function locatePage(source: string, folder: string | null = null): LocatedPage {
  const notes: string[] = [];
  // A byte order mark is not text of the page.
  const normal = source.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  const { fields, body } = frontMatter(normal, notes);
  const head = normal.slice(0, normal.length - body.length);
  // The line the body starts on. Front matter with no line after it leaves an empty body past the last line.
  const offset = (head.match(/\n/g)?.length ?? 0) + (head !== "" && !head.endsWith("\n") ? 1 : 0);
  const bodyLines = body.split("\n");
  const blocks = splitAt(bodyLines, (line) => {
    const match = /^(#{1,2})\s+(.*?)\s*#*\s*$/.exec(line);
    return match?.[1] && match[2] !== undefined ? { level: match[1].length, heading: match[2] } : null;
  });

  const ends = (n: number) => offset + (blocks.parts[n]?.at ?? bodyLines.length);
  let summaryLines: readonly string[] = blocks.intro;
  let summarySpan: Span = { start: offset, end: ends(0) };
  let titleHeading: string | null = null;
  const first = blocks.parts[0];
  if (first && first.level === 1 && kindOf(first.heading) === null && summaryLines.every((line) => line.trim() === "")) {
    titleHeading = plain(first.heading);
    summaryLines = first.lines;
    summarySpan = { start: offset + first.at + 1, end: ends(1) };
    blocks.parts.shift();
  }

  const occurrences = new Map<string, number>();
  const seenKinds = new Set<SectionKind>();
  const located = blocks.parts.map((block, n) => section(block, { start: offset + block.at, end: ends(n + 1) }, occurrences, seenKinds, notes));
  const sections = located.map((each) => each.section);
  const deeper = body.split("\n").flatMap((line) => /^#{3,6}\s+(.*)$/.exec(line)?.[1] ?? []);
  for (const known of KNOWN) {
    if (!seenKinds.has(known.kind) && deeper.some((heading) => kindOf(heading) === known.kind)) {
      const label = SECTION_LABEL[known.kind];
      notes.push(`A "${label}" heading sits below level 2, so the hub does not read it. Write it as "## ${label}".`);
    }
  }


  // The goal is its own section, or a paragraph of the summary that starts "Goal:", which is how agents wrote it unasked.
  const goalAt = sections.findIndex((s) => s.kind === null && GOAL_HEADING.test(headingName(s.heading)));
  // The summary's paragraphs are its runs of lines that are not blank.
  const runs: Span[] = [];
  summaryLines.forEach((line, n) => {
    const at = summarySpan.start + n;
    if (line.trim() === "") return;
    const last = runs.at(-1);
    if (last && last.end === at) runs[runs.length - 1] = { start: last.start, end: at + 1 };
    else runs.push({ start: at, end: at + 1 });
  });
  const paragraphs = runs.map((run) => summaryLines.slice(run.start - summarySpan.start, run.end - summarySpan.start).join("\n"));
  const inSummary = goalAt === -1 ? paragraphs.findIndex((paragraph) => GOAL_LEAD.test(paragraph)) : -1;
  const goal = goalAt !== -1 ? (sections[goalAt]?.markdown ?? "") : inSummary !== -1 ? (paragraphs[inSummary] ?? "").replace(GOAL_LEAD, "").trim() : "";
  if (goal === "") notes.push('The page has no goal. Add a "## Goal" section that says, in a line or two, what this work is for.');

  const tryLinks = [...(fields.try ? [{ label: "", url: fields.try }] : []), ...sections.filter((s) => TRY_HEADING.test(headingName(s.heading))).flatMap((s) => linksIn(s.markdown))];
  // An app with no server is opened from where it was built, so a try link may point outside the work's folder.
  if (folder !== null) notes.push(...linkNotes(body, folder, new Set(tryLinks.map((link) => link.url))));

  const page: Page = {
    title: fields.title ?? titleHeading ?? (folder === null ? "Untitled" : folderName(folder)),
    project: fields.project,
    done: fields.done,
    links: tryLinks.filter((link, index) => tryLinks.findIndex((other) => other.url === link.url) === index),
    summary: paragraphs.filter((_, index) => index !== inSummary).join("\n\n").trim(),
    goal,
    sections: sections.filter((_, index) => index !== goalAt),
    notes,
  };
  return { page, summary: summarySpan, goalInSummary: runs[inSummary] ?? null, sections: located.map((each) => each.located) };
}

/** The section that says where to open what is being built. "Running" is what older pages call it. */
const TRY_HEADING = /^(try it|try|preview|live|running|dev server)\b/i;

/** What a try link may be: a web address, a `file://` address, a path from the root or the home folder, or an HTML file beside the page. */
const TRY_TARGET = /^(https?:\/\/|file:\/\/|\/|~\/)|\.html?([?#].*)?$/i;

/**
 * The places a piece of Markdown links, each with the link's words when they are more than the address.
 * Pull requests and commits are not places to try something.
 */
function linksIn(markdown: string): TryLink[] {
  const links: { label: string; url: string }[] = [];
  let open: { label: string; url: string } | null = null;
  new HTMLRewriter()
    .on("a[href]", {
      element(el) {
        const url = decodeEntities(el.getAttribute("href") ?? "");
        if (!TRY_TARGET.test(url) || /^https?:\/\/github\.com\//i.test(url)) return;
        const link = { label: "", url };
        links.push(link);
        open = link;
        el.onEndTag(() => {
          const words = link.label.replace(/\s+/g, " ").trim();
          link.label = words === url || words === url.replace(/^https?:\/\//i, "") ? "" : words;
          open = null;
        });
      },
      text(chunk) {
        if (open) open.label += decodeEntities(chunk.text);
      },
    })
    .transform(Bun.markdown.html(markdown, { autolinks: true }));
  // An address written bare or as code is not a link to Markdown, least of all "localhost", which has no dot. It is one here.
  for (const match of markdown.matchAll(/(?:https?|file):\/\/[^\s<>()\[\]`"']+/gi)) {
    const url = match[0].replace(/[.,;:!?]+$/, "");
    if (!/^https?:\/\/github\.com\//i.test(url) && !links.some((link) => link.url === url)) links.push({ label: "", url });
  }
  // In the order the page lists them.
  const at = (link: TryLink) => (markdown.indexOf(link.url) + 1 || Number.MAX_SAFE_INTEGER);
  return links.sort((x, y) => at(x) - at(y));
}

const GOAL_HEADING = /^goals?\b/i;
export const GOAL_LEAD = /^\s*\**goals?\**\s*:\**\s*/i;

function folderName(folder: string): string {
  return folder.replace(/\/+$/, "").split("/").at(-1) ?? folder;
}

function headingName(heading: string): string {
  return plain(heading).replace(/\s*\(\d+\)\s*$/, "");
}

export function kindOf(heading: string): SectionKind | null {
  const name = headingName(heading);
  return KNOWN.find((k) => k.name.test(name))?.kind ?? null;
}

/** A list section's run of lines: an item, or the text above the first one. */
interface Entry {
  readonly lines: readonly string[];
  readonly span: Span;
  /** An ask written as prose, which has no marker to keep when it is edited. */
  readonly prose?: true;
}

function section(
  block: Block,
  span: Span,
  occurrences: Map<string, number>,
  seenKinds: Set<SectionKind>,
  notes: string[],
): { section: Section; located: LocatedSection } {
  const name = headingName(block.heading);
  const kind = kindOf(block.heading);
  if (kind === null) {
    const near = block.level === 2 || block.level === 1 ? NEAR_MISSES.find((n) => n.name.test(name)) : undefined;
    if (near) notes.push(`The heading "${block.heading}" looks like "${SECTION_LABEL[near.kind]}". Rename it to "## ${SECTION_LABEL[near.kind]}" so the hub reads it.`);
    return { section: { heading: block.heading, kind: null, markdown: block.lines.join("\n").trim(), items: [] }, located: { kind: null, span, items: [], nothing: null } };
  }
  if (seenKinds.has(kind)) notes.push(`"${SECTION_LABEL[kind]}" appears more than once. The hub reads both, but keep one.`);
  seenKinds.add(kind);

  const { intro, items: parts } = splitItems(block.lines);
  // The lines under the heading start on the line after it.
  const line = (n: number | undefined) => span.start + 1 + (n ?? block.lines.length);
  const introEntry: Entry = { lines: intro, span: { start: line(0), end: line(parts[0]?.at) } };
  const items = parts.map((part, n): Entry => ({ lines: part.lines, span: { start: line(part.at), end: line(parts[n + 1]?.at) } }));
  let nothing: Span | null = null;
  let lines: readonly Entry[] = items;
  let markdown = intro.join("\n").trim();
  if (kind === "needs") {
    // A ticked box is settled. It stays on the page as written, after the introduction, but is not an item.
    const ticked = lines.filter(isTicked);
    lines = lines.filter((entry) => !isTicked(entry));
    const only = lines.length === 1 && markdown === "" ? lines[0] : undefined;
    if (only && saysNothing(only.lines.join("\n"))) {
      markdown = trimLines(only.lines).join("\n");
      nothing = only.span;
      lines = [];
    } else if (lines.length === 0 && markdown !== "" && !saysNothing(markdown) && !markdown.endsWith(":")) {
      // With no open items, prose is the blocker. Prose ending in a colon only introduces the list under it.
      lines = [{ ...introEntry, prose: true }];
      markdown = "";
    } else if (lines.length === 0 && saysNothing(markdown)) {
      nothing = introEntry.span;
    }
    if (ticked.length > 0) markdown = [markdown, ticked.map((entry) => trimLines(entry.lines).join("\n")).join("\n")].filter((part) => part !== "").join("\n\n");
  }
  if (kind === "doing" || kind === "next") {
    // A ticked box is done: it is no longer in progress or planned. It stays on the page as written.
    const ticked = lines.filter(isTicked);
    lines = lines.filter((entry) => !isTicked(entry));
    if (ticked.length > 0) markdown = [markdown, ticked.map((entry) => trimLines(entry.lines).join("\n")).join("\n")].filter((part) => part !== "").join("\n\n");
  }
  const located = lines.map((entry): LocatedItem => ({
    item: item(kind, entry.lines, occurrences),
    kind,
    span: entry.span,
    marker: entry.prose ? null : (/^(###|[-*+!]|\d+[.)])\s/.exec(entry.lines[0] ?? "")?.[1] ?? null),
  }));
  const parsed = located.map((entry) => entry.item);
  if (kind === "needs" && parsed.length === 1 && startsWithNothing(parsed[0]?.title ?? "")) {
    notes.push(`Needs you says nothing is needed and then says more, so the hub shows it as an ask. Leave only "Nothing right now.", or write what is needed as an item.`);
  }
  // An item's first line is its name: a card's words on the board, and what tells the hub it is the same item after an edit.
  const long = kind === "decisions" ? [] : parsed.filter((entry) => entry.title.length > LONG_TITLE);
  if (long.length > 0) {
    notes.push(`${SECTION_LABEL[kind]}: ${long.length === 1 ? "an item's first line runs" : `${long.length} items' first lines run`} past ${LONG_TITLE} characters. The first line is the item's name on the board: say what it is in a sentence, and put the rest on the lines under it.`);
  }
  // The commands refuse these lines. A page edited by hand can still hold them, so the check names the first of each.
  const dated = parsed.filter((entry) => openingDate(entry.title) !== null);
  const [firstDated] = dated;
  if (firstDated) {
    const which = dated.length === 1 ? `"${clip(firstDated.title)}" opens with a date` : `${dated.length} items' first lines open with a date; the first is "${clip(firstDated.title)}"`;
    notes.push(`${SECTION_LABEL[kind]}: ${which}. The hub records when each line appeared, so take the date off the line.`);
  }
  const stale = kind === "shipped" ? parsed.filter((entry) => underWay(entry.title) !== null) : [];
  const [firstStale] = stale;
  if (firstStale) {
    const which = `"${clip(firstStale.title)}", which says "${underWay(firstStale.title)}"`;
    const what = stale.length === 1 ? `${which}, was written while it was under way` : `${stale.length} items still say they are under way; the first is ${which}`;
    notes.push(`Shipped: ${what}. Give ${stale.length === 1 ? "it" : "each"} the words that are true now, with what is still open under it: progress reword "<line>" "<what is now true>" --under "<what is still open>".`);
  }
  if (kind === "shipped") {
    for (const entry of parsed) {
      const bare = /(?<![\w/[])#(\d+)\b/.exec(withoutCode(entry.markdown).replace(/\[[^\]]*\]\([^)]*\)/g, ""));
      if (bare) notes.push(`Shipped: "${entry.title}" names #${bare[1]} with no link. Write the full pull request URL so the hub can show its title and state.`);
    }
  }
  return { section: { heading: block.heading, kind, markdown, items: parsed }, located: { kind, span, items: located, nothing } };
}

/** A first line, cut short enough to name in a note, without the full stop it ends with: the note's own follows it. */
const clip = (title: string) => (title.length > 60 ? `${title.slice(0, 59)}…` : title.replace(/\.$/, ""));

function isTicked(entry: Entry): boolean {
  return /^[-*+]\s+\[[xX]\]\s/.test(entry.lines[0] ?? "");
}

/** `###` blocks, or with none, top-level bullets. A line that swaps its bullet for the important mark, `! text`, is a bullet too. */
function splitItems(lines: readonly string[]): { intro: readonly string[]; items: readonly Block[] } {
  const byHeading = splitAt(lines, (line) => (/^###\s+\S/.test(line) ? true : null));
  if (byHeading.parts.length > 0) return { intro: byHeading.intro, items: byHeading.parts };
  const byBullet = splitAt(lines, (line) => (/^([-*+!]|\d+[.)])\s+\S/.test(line) ? true : null));
  return { intro: byBullet.intro, items: byBullet.parts };
}

function item(kind: SectionKind, lines: readonly string[], occurrences: Map<string, number>): Item {
  const markdown = trimLines(lines).join("\n");
  const title = plain(splitItem(markdown).title) || "(untitled)";
  const key = `${kind}/${title}`;
  const n = (occurrences.get(key) ?? 0) + 1;
  occurrences.set(key, n);
  return { id: n === 1 ? key : `${key}/${n}`, title, markdown };
}

/**
 * Splits lines at the ones `match` accepts, skipping fenced code. Each part starts with its matching line,
 * which a `{level, heading}` result consumes and a `true` result keeps.
 */
function splitAt<T extends { level: number; heading: string } | true>(
  lines: readonly string[],
  match: (line: string) => T | null,
): { intro: string[]; parts: Block[] } {
  const intro: string[] = [];
  const parts: { level: number; heading: string; at: number; lines: string[] }[] = [];
  let fence: string | null = null;
  for (const [at, line] of lines.entries()) {
    const fenceMark = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (fenceMark !== undefined && (fence === null || fenceMark.startsWith(fence))) {
      fence = fence === null ? fenceMark : null;
    }
    const hit = fence === null && fenceMark === undefined ? match(line) : null;
    if (hit === true) parts.push({ level: 0, heading: "", at, lines: [line] });
    else if (hit !== null) parts.push({ level: hit.level, heading: hit.heading, at, lines: [] });
    else (parts.at(-1)?.lines ?? intro).push(line);
  }
  return { intro, parts };
}

interface Fields {
  title: string | null;
  project: string | null;
  done: boolean;
  try: string | null;
}

/** A small, lenient reader for the few keys the hub uses. Titles often hold colons, which strict YAML rejects. */
function frontMatter(source: string, notes: string[]): { fields: Fields; body: string } {
  const fields: Fields = { title: null, project: null, done: false, try: null };
  const match = /^---\n([\s\S]*?)\n---[ \t]*(?:\n|$)/.exec(source);
  if (!match) {
    if (source.startsWith("---\n")) notes.push("The front matter has no closing `---` line, so the hub read it as text.");
    return { fields, body: source };
  }
  for (const line of (match[1] ?? "").split("\n")) {
    const kv = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line);
    if (!kv?.[1]) continue;
    const key = kv[1].toLowerCase();
    const value = unquote(kv[2] ?? "");
    if (key === "title" && value !== "") fields.title = value;
    else if (key === "project" && value !== "") fields.project = value;
    else if (key === "try" && TRY_TARGET.test(value)) fields.try = value;
    else if (key === "status") {
      fields.done = value.toLowerCase() === "done";
    }
  }
  return { fields, body: source.slice(match[0].length) };
}

function unquote(value: string): string {
  const v = value.trim();
  return /^(["']).*\1$/.test(v) ? v.slice(1, -1) : v;
}

export function withoutCode(markdown: string): string {
  return markdown.replace(/```[\s\S]*?```/g, "").replace(/`[^`]*`/g, "");
}

/** Every href and src in the page, as Bun's Markdown renderer sees them. */
export function linkTargets(markdown: string): string[] {
  const targets: string[] = [];
  const collect = (attr: string) => ({
    element(el: HTMLRewriterTypes.Element) {
      const value = el.getAttribute(attr);
      if (value) targets.push(value);
    },
  });
  new HTMLRewriter()
    .on("a[href]", collect("href"))
    .on("img[src]", collect("src"))
    .on("video[src]", collect("src"))
    .on("source[src]", collect("src"))
    .on("iframe[src]", collect("src"))
    .transform(Bun.markdown.html(markdown));
  return targets;
}

/** An image, video or page a page shows, as written: the target and its alt text. */
export interface MediaRef {
  readonly kind: "image" | "video" | "page" | "file";
  readonly target: string;
  readonly caption: string;
}

const IMAGE_FILE = /\.(png|jpe?g|gif|webp|avif|svg)$/i;
const VIDEO_FILE = /\.(mp4|m4v|mov|webm|ogv)$/i;
const PAGE_FILE = /\.html?$/i;
/** Documents a page may link as something it made: reports, data, archives. Source files are not among them. */
const DOC_FILE = /\.(pdf|md|txt|csv|tsv|json|ya?ml|log|zip|diff|patch|xlsx?|docx?|pptx?)$/i;

/** What an image link to this target shows, from the file's extension. */
export function mediaKind(target: string): MediaRef["kind"] | null {
  const file = target.replace(/[?#].*$/, "");
  return VIDEO_FILE.test(file) ? "video" : PAGE_FILE.test(file) ? "page" : IMAGE_FILE.test(file) ? "image" : null;
}

/**
 * What a page shows, in order: Markdown image syntax (an image, or a video or HTML file in its place),
 * and the `img` and `video` tags of raw HTML it holds. A link to a file is an
 * artifact the page points at: an HTML page, a video, an image or a document, captioned by the link's words.
 */
export function mediaRefs(markdown: string): MediaRef[] {
  const refs: { kind: MediaRef["kind"]; target: string; caption: string }[] = [];
  // The link being read, whose words become its caption.
  let linked: { caption: string } | null = null;
  new HTMLRewriter()
    .on("img[src]", {
      element(el) {
        const target = decodeEntities(el.getAttribute("src") ?? "");
        const caption = decodeEntities(el.getAttribute("alt") ?? "").trim();
        const found = mediaKind(target);
        if (found) refs.push({ kind: found, target, caption });
      },
    })
    .on("a[href]", {
      element(el) {
        const target = decodeEntities(el.getAttribute("href") ?? "");
        const file = target.replace(/[?#].*$/, "");
        const found = mediaKind(target) ?? (DOC_FILE.test(file) ? "file" : null);
        if (!found) return;
        const ref = { kind: found, target, caption: "" };
        refs.push(ref);
        linked = ref;
        el.onEndTag(() => {
          ref.caption = ref.caption.replace(/\s+/g, " ").trim();
          linked = null;
        });
      },
      text(chunk) {
        if (linked) linked.caption += decodeEntities(chunk.text);
      },
    })
    .on("video[src], video source[src]", {
      element(el) {
        refs.push({ kind: "video", target: decodeEntities(el.getAttribute("src") ?? ""), caption: decodeEntities(el.getAttribute("title") ?? "").trim() });
      },
    })
    .transform(Bun.markdown.html(markdown));
  return refs;
}

/** A relative link target as a path inside the work's folder, or null for a URL or an anchor. */
export function localPath(target: string): string | null {
  if (/^[a-z][a-z0-9+.-]*:/i.test(target) && !/^file:/i.test(target)) return null;
  if (target.startsWith("#") || target.startsWith("?")) return null;
  const path = target.replace(/^file:\/\//i, "").replace(/[?#].*$/, "");
  try {
    return decodeURIComponent(path);
  } catch {
    return path;
  }
}

function linkNotes(markdown: string, folder: string, allowed: ReadonlySet<string>): string[] {
  const notes: string[] = [];
  for (const target of new Set(linkTargets(markdown))) {
    const path = localPath(target);
    if (path === null || path === "" || allowed.has(target)) continue;
    if (isAbsolute(path) || path.startsWith("~")) {
      notes.push(`The link "${target}" points outside the work's folder. Copy the file into the folder and link it relatively, because scratch gets deleted.`);
      continue;
    }
    const inside = relative(folder, normalize(join(folder, path)));
    if (inside.startsWith("..")) notes.push(`The link "${target}" leaves the work's folder. Keep what the page links to inside the folder.`);
    else if (!existsSync(join(folder, inside))) notes.push(`The link "${target}" points at a file that does not exist.`);
  }
  return notes;
}

function decodeEntities(s: string): string {
  const named: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
  return s.replace(/&(#x?[0-9a-f]+|\w+);/gi, (whole, code: string) => {
    if (code.startsWith("#x") || code.startsWith("#X")) return String.fromCodePoint(Number.parseInt(code.slice(2), 16));
    if (code.startsWith("#")) return String.fromCodePoint(Number.parseInt(code.slice(1), 10));
    return named[code.toLowerCase()] ?? whole;
  });
}
