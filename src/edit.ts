/**
 * The page commands' edits. Each finds what it changes by the lines the parser says it came from, replaces only
 * those lines, and parses the result to check it says what was meant. A check that fails throws an EditError and
 * nothing is written.
 */
import { GOAL_LEAD, kindOf, type LocatedItem, type LocatedPage, linkTargets, locatePage, SECTION_LABEL, type Span, withoutCode } from "./core/parse.ts";
import { LONG_TITLE, liveLine, liveMark, plain, splitItem, withoutLiveMark } from "./core/text.ts";
import type { Item, Page, SectionKind } from "./core/types.ts";

/** The same command, ready to run again, with `line` as the item's first line and `under` as lines under it before any given. */
export interface Retry {
  readonly line: string;
  readonly under: readonly string[];
}

export class EditError extends Error {
  readonly retry: Retry | null;
  constructor(message: string, retry: Retry | null = null) {
    super(message);
    this.retry = retry;
  }
}

export interface Edit {
  readonly text: string;
  /** What changed, naming the line it matched. */
  readonly said: string;
  /** The item a reword gave a new name, as the page now reads it, with the id it had: the hub knows items by their names. */
  readonly renamed?: { readonly from: string; readonly section: SectionKind; readonly item: Item };
}

/** `Live: <where>` once the user can use it, `Not live: <what it waits on>` while they can't. */
export interface Live {
  readonly on: boolean;
  readonly note: string;
}

/** The section an agent names: "shipped", "in progress", "needs", "decisions"… */
export function sectionNamed(name: string): SectionKind | null {
  const words = name.trim().toLowerCase().replace(/[-_]+/g, " ");
  return kindOf(words) ?? (words === "needs" ? "needs" : null);
}

/**
 * The page as lines that keep their own line endings. Lines an edit puts in end the way the page's first line
 * does, and every other line is written back as it was read.
 */
class Lines {
  private readonly lines: { text: string; eol: string }[] = [];
  private readonly eol: string;
  /** Whether the last line ends in a line break. */
  private readonly ends: boolean;
  /** A byte order mark the page starts with, kept in front of whatever its first line becomes. */
  private readonly bom: string;

  constructor(page: string) {
    this.bom = page.startsWith("\uFEFF") ? "\uFEFF" : "";
    const parts = page.slice(this.bom.length).split(/(\r\n|\r|\n)/);
    for (let i = 0; i < parts.length; i += 2) this.lines.push({ text: parts[i] ?? "", eol: parts[i + 1] ?? "" });
    // After a last line break the parser sees one more, empty line. It is not a line of the file.
    if (this.lines.length > 1 && this.lines.at(-1)?.text === "") this.lines.pop();
    this.ends = this.lines.at(-1)?.eol !== "";
    this.eol = this.lines.find((line) => line.eol !== "")?.eol ?? "\n";
  }

  get length(): number {
    return this.lines.length;
  }

  at(n: number): string | undefined {
    return this.lines[n]?.text;
  }

  blank(n: number): boolean {
    return (this.at(n) ?? "").trim() === "";
  }

  /** The end of a span without the blank lines it closes with. */
  trimmed(span: Span): number {
    let end = Math.min(span.end, this.length);
    while (end > span.start + 1 && this.blank(end - 1)) end--;
    return end;
  }

  splice(start: number, end: number, texts: readonly string[]): void {
    const from = Math.min(start, this.length);
    this.lines.splice(from, Math.max(0, Math.min(end, this.length) - from), ...texts.map((text) => ({ text, eol: this.eol })));
    for (const line of this.lines.slice(0, -1)) if (line.eol === "") line.eol = this.eol;
    const last = this.lines.at(-1);
    if (last) last.eol = this.ends ? last.eol || this.eol : "";
  }

  text(): string {
    return this.bom + this.lines.map((line) => line.text + line.eol).join("");
  }
}

/** An item as an edit writes it: its first line without the marker, whether it is marked important, and the lines under it, dedented. */
interface Draft {
  readonly title: string;
  readonly important: boolean;
  readonly body: readonly string[];
}

const liveText = (live: Live) => `${live.on ? "Live" : "Not live"}: ${live.note}`;
const short = (title: string) => (title.length > 90 ? `${title.slice(0, 89)}…` : title);
const sameLive = (a: { on: boolean; note: string } | null, b: Live | null) => (a === null ? b === null : b !== null && a.on === b.on && a.note === b.note);

/** Text given to a command is one line, and starts no section or item. */
function oneLine(text: string, what: string): string {
  if (/[\r\n]/.test(text)) throw new EditError(`${what} has a line break. Give it as one line. To write more under an item, add --under "<line>" for each line.`);
  const line = text.trim();
  const start = /^(#{1,6}|[-*+]|\d{1,9}[.)])(?:\s|$)/.exec(line)?.[1];
  if (start) throw new EditError(`${what} starts with ${start}, which would start a section or an item. Drop the ${start}.`);
  return line;
}

const MONTH = "(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\\.?";
/** A line that opens with a date: "Nov 24", "24 Nov", "2026-11-24". */
const DATED = new RegExp(`^(?:${MONTH}\\s+\\d{1,2}(?:st|nd|rd|th)?\\b|\\d{1,2}(?:st|nd|rd|th)?\\s+${MONTH}(?!\\p{L})|\\d{4}-\\d{1,2}-\\d{1,2}\\b)`, "iu");

/**
 * A first line given to a command: one line, without its bullet, that opens with no date and, outside Decisions,
 * is short enough to be a card's name. A long one is refused with the command that splits it at its first sentence.
 */
function firstLine(words: string, kind: SectionKind): string {
  const line = oneLine(words.trim().replace(/^[-*+]\s+/, ""), "The line");
  if (line === "") throw new EditError("Give the item's first line: it is the item's name on the board.");
  const date = DATED.exec(plain(line).replace(/^[^\p{L}\p{N}]+/u, ""))?.[0];
  if (date) {
    throw new EditError(`The line opens with a date, "${date}". The hub records when each line appeared, so a line never says when it was written.`);
  }
  if (kind !== "decisions" && line.length > LONG_TITLE) {
    const why = `The line is ${line.length} characters. It is the item's name on the board, so keep it to ${LONG_TITLE}: say what it is in a sentence, and put the rest on the lines under it, with --under "<line>".`;
    const split = /^(.+?[.!?])\s+(\S.*)$/.exec(line);
    if (split?.[1] && split[2] && split[1].length <= LONG_TITLE) throw new EditError(`${why} Split at its first sentence, that is:`, { line: split[1], under: [split[2]] });
    throw new EditError(why);
  }
  return line;
}

/** Words that say a thing is still under way. Whole phrases, in any case. */
const UNDER_WAY = ["in review", "waiting on", "waits on", "is building"];

/**
 * Refuses to carry a line to Shipped as it is when it says the work is still under way, naming the words and the
 * command that gives it new ones. A line was written while the work was going on, and its words go stale when it
 * lands. Words given at the move are chosen then, so they are taken as they are.
 */
function shippable(title: string): void {
  const words = wordsOf(plain(title));
  const phrase = UNDER_WAY.find((each) => hasRun(words, each.split(" ")));
  if (phrase === undefined) return;
  throw new EditError(
    `"${short(plain(title))}" says "${phrase}", which was true while it was under way. Give it the words that are true now in the same move, and put what is still open under it with --under "<line>":`,
    { line: "<what is now true>", under: [] },
  );
}

/** Lines given to go under an item, each one line that starts no section and says nothing about being live. */
function underLines(lines: readonly string[]): string[] {
  return lines.map((text) => {
    if (/[\r\n]/.test(text)) throw new EditError("A line given with --under has a line break. Give each line with a --under of its own.");
    const line = text.trim();
    if (/^#{1,6}(?:\s|$)/.test(line)) throw new EditError(`A line given with --under starts with ${line.split(/\s/)[0]}, which would start a section or an item. Drop it.`);
    if (liveLine(line)) throw new EditError('Say whether a Shipped item is live with --live or --not-live on add and move, or with progress live "<line>" "<where>", not with --under.');
    return line;
  });
}

/** Lines under an item, each a paragraph of its own, after what is there already. */
const withUnder = (body: readonly string[], under: readonly string[]): string[] => [...body, ...under.flatMap((line, n) => (n > 0 || body.length > 0 ? ["", line] : [line]))];

/** A first line with a pull request at its start, unless it links it already. */
const withPr = (title: string, pr: string | null) => {
  const link = pr === null ? null : oneLine(pr, "--pr");
  return link && !targetsOf(title).has(link) ? `${link} ${title}` : title;
};

/** New words for a first line, after the links the old one starts with, such as its pull request. Words that open with a link bring their own, and replace them. */
function withLead(was: string, words: string): string {
  if (/^[a-z][a-z0-9+.-]*:\/\/\S/i.test(words)) return words;
  const held = targetsOf(words);
  const lead = (/^(?:[a-z][a-z0-9+.-]*:\/\/\S+\s+)+/i.exec(was)?.[0] ?? "").split(/\s+/).filter((link) => link !== "" && ![...targetsOf(link)].some((target) => held.has(target)));
  return [...lead, words].join(" ");
}

/** Refuses a name that another line of the section has: the hub tells items apart by it. */
function untaken(page: LocatedPage, kind: SectionKind, name: string, except: LocatedItem | null): void {
  if (page.sections.some((section) => section.kind === kind && section.items.some((entry) => entry !== except && entry.item.title === name))) {
    throw new EditError(`${SECTION_LABEL[kind]} already has "${short(name)}". To write more under it: progress reword "<its words>" --under "<line>".`);
  }
}

/** A Shipped item's lines under its title, with the line that says whether it is live set to `live`. */
function withLive(body: readonly string[], live: Live | null): readonly string[] {
  if (!live) return body;
  oneLine(live.note, "What you say about it being live");
  const found = liveLine(body.join("\n"));
  if (found) return body.map((line, at) => (at === found.at ? liveText(live) : line));
  return body.length === 0 ? [liveText(live)] : [...body, "", liveText(live)];
}

function render(draft: Draft, marker: string): string[] {
  const head = `${draft.important ? "! " : ""}${draft.title}`;
  if (marker === "###") return [`### ${head}`, ...(draft.body.length > 0 ? ["", ...draft.body] : [])];
  const pad = " ".repeat(marker.length + 1);
  return [`${marker} ${head}`, ...draft.body.map((line) => (line.trim() === "" ? "" : pad + line))];
}

const WORD = /[\p{L}\p{N}]+/gu;
const wordsOf = (text: string) => (text.toLowerCase().match(WORD) ?? []) as string[];

/**
 * The addresses an item links, written as links or bare. A bare address counts only where it ends, at a space,
 * a closing bracket or the end, so one cut short by a parenthesis is not taken for a whole address.
 */
function targetsOf(markdown: string): Set<string> {
  const bare = withoutCode(markdown).match(/[a-z][a-z0-9+.-]*:\/\/[^\s<>()[\]`"']+(?=[\s)\]>]|$)/gi) ?? [];
  return new Set([...linkTargets(markdown), ...bare.map((url) => url.replace(/[.,;:!?]+$/, ""))]);
}

/** The pull request and issue numbers an item names: by its links, or as `#123`. */
function numbersOf(markdown: string): Set<string> {
  const numbers = [...targetsOf(markdown)].flatMap((url) => /\/(?:pull|issues)\/(\d+)(?:[/?#]|$)/.exec(url)?.[1] ?? []);
  for (const match of markdown.matchAll(/(?<![\w/&])#(\d+)\b/g)) if (match[1]) numbers.push(match[1]);
  return new Set(numbers);
}

/** Whether `words` stand together, in order, among `line`'s words. */
function hasRun(line: readonly string[], words: readonly string[]): boolean {
  for (let i = 0; i + words.length <= line.length; i++) if (words.every((word, n) => line[i + n] === word)) return true;
  return false;
}

/** A name with no spaces that holds a `/`, or a `:` with more after it, is a link or a path, and names the item that links exactly it. */
const IS_LINK = /^\S*(\/|:\S)\S*$/;

/**
 * The one item a name picks out of every item the hub reads on the page. A name is words that stand together
 * in the item's first line, in any case; or a link, path or `#123`, equal to one the item holds. A name that
 * fits no item, or more than one, picks none.
 */
function find(page: LocatedPage, query: string): LocatedItem {
  if (/[\r\n]/.test(query)) throw new EditError("The name has a line break. Name the item by words of its first line, given as one line.");
  const name = query.trim();
  const items = page.sections.flatMap((section) => section.items);
  let hits: LocatedItem[];
  // `#57` and `pull/57` name pull request 57. A whole link names only the line that links exactly it.
  const number = /^(?:#|pull\/)(\d+)$/.exec(name)?.[1];
  if (number !== undefined) hits = items.filter((entry) => numbersOf(entry.item.markdown).has(number));
  else if (IS_LINK.test(name)) hits = items.filter((entry) => targetsOf(entry.item.markdown).has(name));
  else {
    const words = wordsOf(plain(name));
    if (words.length === 0) throw new EditError("Name the item: a few words of its first line, or the pull request it links.");
    hits = items.filter((entry) => hasRun(wordsOf(entry.item.title), words));
  }
  if (hits.length === 0) {
    throw new EditError(`No item matches "${name}". progress check lists the items. Name one by words that stand together in its first line, or by the pull request link it holds.`);
  }
  if (hits.length > 1) {
    const listed = hits.slice(0, 6).map((entry) => `  - ${SECTION_LABEL[entry.kind]}: ${short(entry.item.title)}`);
    if (hits.length > 6) listed.push(`  and ${hits.length - 6} more`);
    throw new EditError(`"${name}" matches ${hits.length} items:\n${listed.join("\n")}\nName the one you mean with more of its words, or by its pull request link.`);
  }
  const hit = hits[0] as LocatedItem;
  if (hit.marker === null) throw new EditError(`"${short(hit.item.title)}" is an ask written as prose under Needs you, so the command can't tell where it ends. Edit the file by hand, then run progress check.`);
  return hit;
}

/** Takes an item's lines off the page. Blank lines after it go too when a blank line sets it apart above, so the lines around it close up. */
function cut(page: Lines, entry: LocatedItem): void {
  const { start } = entry.span;
  page.splice(start, start === 0 || page.blank(start - 1) ? entry.span.end : page.trimmed(entry.span), []);
}

/**
 * Puts an item in the first section of a kind, in the section's own style: Decisions and Shipped at the top,
 * the rest at the end. With no such section, one is made at the end of the page. In Needs you, a "Nothing right
 * now." goes. Says what it made or took away.
 */
function put(text: string, kind: SectionKind, draft: Draft): { text: string; made: boolean; cleared: boolean } {
  const page = new Lines(text);
  let located = locatePage(text);
  let section = located.sections.find((each) => each.kind === kind);
  const made = section === undefined;
  if (!section) {
    page.splice(page.length, page.length, [...(page.length > 0 && !page.blank(page.length - 1) ? [""] : []), `## ${SECTION_LABEL[kind]}`]);
    located = locatePage(page.text());
    section = located.sections.find((each) => each.kind === kind);
  }
  const nothing = section?.nothing;
  if (nothing) {
    const start = Array.from({ length: nothing.end - nothing.start }, (_, n) => nothing.start + n).find((n) => !page.blank(n)) ?? nothing.start;
    const end = page.trimmed({ start, end: nothing.end });
    page.splice(start, page.blank(start - 1) && page.blank(end) ? end + 1 : end, []);
    located = locatePage(page.text());
    section = located.sections.find((each) => each.kind === kind);
  }
  if (!section) throw new EditError(`The page has no ${SECTION_LABEL[kind]} section the command can find. Add it by hand, then run the command again.`);
  const { items } = section;
  const first = items[0];
  const last = items.at(-1);
  const style = first?.marker ?? (kind === "needs" ? "###" : "-");
  const marker = style === "!" ? "-" : style;
  if (!first || !last) {
    let at = section.span.start + 1;
    for (let n = at; n < Math.min(section.span.end, page.length); n++) if (!page.blank(n)) at = n + 1;
    page.splice(at, at, ["", ...render(draft, marker), ...(at < page.length && !page.blank(at) ? [""] : [])]);
  } else {
    const loose = marker === "###" || items.slice(0, -1).some((entry) => page.trimmed(entry.span) < entry.span.end);
    if (kind === "decisions" || kind === "shipped") {
      page.splice(first.span.start, first.span.start, [...render(draft, marker), ...(loose ? [""] : [])]);
    } else {
      const numbered = /^(\d+)([.)])$/.exec(last.marker ?? "");
      const at = page.trimmed(last.span);
      page.splice(at, at, [...(loose ? [""] : []), ...render(draft, numbered ? `${Number(numbered[1]) + 1}${numbered[2]}` : marker)]);
    }
  }
  return { text: page.text(), made, cleared: nothing !== null && nothing !== undefined };
}

/** What an edit means to leave on the page, beside every item it does not touch. */
type Want =
  | { readonly gone: LocatedItem }
  | { readonly gone?: LocatedItem; readonly arrives: SectionKind; readonly title: string; readonly body: string; readonly live: Live | null; readonly made: boolean; readonly cleared: boolean }
  | { readonly marked: LocatedItem; readonly live: Live }
  | { readonly summary: string };

const listed = (page: Page) => page.sections.flatMap((section) => section.items.map((item) => ({ kind: section.kind as SectionKind, item })));
/** The lines under an item's title, without its live line. Trimmed either way, as `withoutLiveMark` trims when it finds one. */
const bodyOf = (item: Item) => withoutLiveMark(splitItem(item.markdown).body).trim();

/** Parses the new page and checks it says what was meant and nothing else changed. Returns the text, or throws. */
function checked(before: LocatedPage, text: string, want: Want): string {
  const after = locatePage(text).page;
  const was = listed(before.page);
  const now = new Map(listed(after).map((entry) => [entry.item.id, entry]));
  const target = "gone" in want ? want.gone?.item.id : "marked" in want ? want.marked.item.id : undefined;
  const refuse = (why: string) => {
    throw new EditError(`${why} So nothing was written. Edit the file by hand, then run progress check.`);
  };

  for (const { kind, item } of was) {
    if (item.id === target) continue;
    const kept = now.get(item.id);
    if (kept && kept.kind === kind && kept.item.markdown === item.markdown) continue;
    if (was.some((other) => other.item !== item && other.kind === kind && other.item.title === item.title)) {
      refuse(`Two lines under ${SECTION_LABEL[kind]} share the name "${short(item.title)}", and this edit would give one's place in the hub, with what the user marked on it, to the other.`);
    }
    refuse(`This edit would also change "${short(item.title)}" under ${SECTION_LABEL[kind]}, which it is not about.`);
  }
  const ids = new Set(was.map((entry) => entry.item.id));
  // A line reworded to the same name, with more under it, arrives where it was, with its id.
  const arrived = [...now.values()].filter((entry) => !ids.has(entry.item.id) || (entry.item.id === target && "arrives" in want));
  if (target !== undefined && "gone" in want && !("arrives" in want) && now.has(target)) refuse(`"${short(want.gone?.item.title ?? "")}" would still be on the page.`);

  if ("arrives" in want) {
    const [entry, ...more] = arrived;
    const ok = entry && more.length === 0 && entry.kind === want.arrives && entry.item.title === want.title && bodyOf(entry.item) === want.body && sameLive(liveMark(entry.item.markdown), want.live);
    if (!ok) refuse(`The page would not read as "${short(want.title)}" under ${SECTION_LABEL[want.arrives]} with what was under it.`);
  } else if (arrived.length > 0) {
    refuse(`The page would read a new item, "${short(arrived[0]?.item.title ?? "")}".`);
  }
  if ("marked" in want) {
    const entry = now.get(want.marked.item.id);
    if (!sameLive(liveMark(entry?.item.markdown ?? ""), want.live)) refuse(`The hub would not read "${liveText(want.live)}" on "${short(want.marked.item.title)}": the line would land where it is not read, such as inside a code block.`);
    if (!entry || bodyOf(entry.item) !== bodyOf(want.marked.item)) refuse(`This edit would change more of "${short(want.marked.item.title)}" than the line that says whether it is live.`);
  }

  const made = "arrives" in want && want.made ? want.arrives : null;
  const cleared = "arrives" in want && want.cleared;
  const frame = (page: Page, isAfter: boolean) =>
    JSON.stringify({
      title: page.title,
      project: page.project,
      done: page.done,
      goal: page.goal,
      links: page.links,
      summary: "summary" in want ? null : page.summary,
      sections: (isAfter && made ? page.sections.slice(0, -1) : page.sections).map((section) => ({
        heading: section.heading,
        kind: section.kind,
        markdown: cleared && section.kind === "needs" ? null : section.markdown,
      })),
    });
  if (frame(before.page, false) !== frame(after, true)) refuse("This edit would change more of the page than it is about.");
  if ("summary" in want && after.summary !== want.summary) refuse("The hub would not read the summary as it was given.");
  return text;
}

/** What a command that writes a line can be given besides it: its pull request, and lines to go under it. */
export interface LineOptions {
  readonly pr?: string | null;
  readonly under?: readonly string[];
}

/** Adds an item to a section. */
export function addItem(text: string, kind: SectionKind, words: string, live: Live | null = null, options: LineOptions = {}): Edit {
  if (live && kind !== "shipped") throw new EditError("--live and --not-live are for Shipped items.");
  // A line given with its bullet is the line without it.
  const line = firstLine(words, kind);
  const under = underLines(options.under ?? []);
  const before = locatePage(text);
  const given = splitItem(`- ${line}`);
  const title = withPr(given.title, options.pr ?? null);
  const name = plain(title) || "(untitled)";
  untaken(before, kind, name, null);
  const body = withLive(withUnder([], under), live);
  const out = put(text, kind, { title, important: given.important, body });
  checked(before, out.text, { arrives: kind, title: name, body: withoutLiveMark(body.join("\n")).trim(), live, made: out.made, cleared: out.cleared });
  return { text: out.text, said: `Added "${short(name)}" to ${SECTION_LABEL[kind]}.${out.made ? ` The page had no ${SECTION_LABEL[kind]} section, so one was added at its end.` : ""}` };
}

/**
 * Moves an item, with the lines under it, to another section. `as` gives it a new first line on the way, and
 * `under` more lines under it. To Shipped it can say whether it is live.
 */
export function moveItem(text: string, query: string, kind: SectionKind, options: LineOptions & { readonly live?: Live | null; readonly as?: string | null } = {}): Edit {
  const { live = null } = options;
  if (live && kind !== "shipped") throw new EditError("--live and --not-live are for a move to Shipped.");
  const line = options.as == null ? null : firstLine(options.as, kind);
  const under = underLines(options.under ?? []);
  const before = locatePage(text);
  const entry = find(before, query);
  if (entry.kind === kind) throw new EditError(`"${short(entry.item.title)}" is already under ${SECTION_LABEL[kind]}. To change its words, progress reword "<its words>" "<its new first line>".`);
  const was = splitItem(entry.item.markdown);
  const given = line === null ? null : splitItem(`- ${line}`);
  const title = withPr(given === null ? was.title : withLead(was.title, given.title), options.pr ?? null);
  // Only a line carried over as it was: words given with --as are chosen now, and may say what they like.
  if (kind === "shipped" && line === null) shippable(title);
  const name = plain(title) || "(untitled)";
  untaken(before, kind, name, null);
  const draft = { title, important: was.important || given?.important === true, body: withLive(withUnder(was.body === "" ? [] : was.body.split("\n"), under), live) };
  const page = new Lines(text);
  cut(page, entry);
  const out = put(page.text(), kind, draft);
  checked(before, out.text, { gone: entry, arrives: kind, title: name, body: withoutLiveMark(draft.body.join("\n")).trim(), live: live ?? liveMark(entry.item.markdown), made: out.made, cleared: out.cleared });
  const as = line === null ? "" : `, now "${short(name)}"`;
  return { text: out.text, said: `Moved "${short(entry.item.title)}" from ${SECTION_LABEL[entry.kind]} to ${SECTION_LABEL[kind]}${as}.` };
}

/** Gives an item a new first line where it is, and more lines under it. Its section, its place and what is under it stay. */
export function rewordItem(text: string, query: string, words: string | null, options: LineOptions = {}): Edit {
  const before = locatePage(text);
  const entry = find(before, query);
  const under = underLines(options.under ?? []);
  const was = splitItem(entry.item.markdown);
  // With no new words the line stays, and the command only writes under it or puts its pull request in front.
  const given = words === null ? { title: was.title, important: false } : splitItem(`- ${firstLine(words, entry.kind)}`);
  const title = withPr(words === null ? was.title : withLead(was.title, given.title), options.pr ?? null);
  const name = plain(title) || "(untitled)";
  untaken(before, entry.kind, name, entry);
  const page = new Lines(text);
  const { start } = entry.span;
  // The marker, and a box an ask is ticked with, stay as they are written.
  const head = /^(?:###\s+|[-*+]\s+(?:\[[ xX]\]\s+)?|\d+[.)]\s+)?/.exec(page.at(start) ?? "")?.[0] ?? "";
  page.splice(start, start + 1, [`${head}${was.important || given.important ? "! " : ""}${title}`]);
  append(page, entry, under);
  const out = page.text();
  if (out === text) return { text, said: `"${short(entry.item.title)}" already reads so.` };
  const body = withoutLiveMark(withUnder(was.body === "" ? [] : [was.body], under).join("\n")).trim();
  checked(before, out, { gone: entry, arrives: entry.kind, title: name, body, live: liveMark(entry.item.markdown), made: false, cleared: false });
  const said = name === entry.item.title ? `Added ${under.length === 1 ? "a line" : `${under.length} lines`} under "${short(name)}"` : `Reworded "${short(entry.item.title)}" as "${short(name)}"`;
  const item = listed(locatePage(out).page).find((now) => now.kind === entry.kind && now.item.title === name)?.item;
  const renamed = item && item.id !== entry.item.id ? { from: entry.item.id, section: entry.kind, item } : undefined;
  return { text: out, said: `${said} in ${SECTION_LABEL[entry.kind]}.`, ...(renamed ? { renamed } : {}) };
}

/** Puts lines at the end of an item, set apart by a blank line from what is above them, indented as the item's own lines are. */
function append(page: Lines, entry: LocatedItem, lines: readonly string[]): void {
  if (lines.length === 0) return;
  const { start } = entry.span;
  const end = page.trimmed(entry.span);
  const rest = Array.from({ length: end - start - 1 }, (_, n) => page.at(start + 1 + n) ?? "");
  const indents = rest.filter((line) => line.trim() !== "").map((line) => line.length - line.trimStart().length);
  const indent = entry.marker === "###" ? "" : " ".repeat(indents.length > 0 ? Math.min(...indents) : (entry.marker?.length ?? 1) + 1);
  const added = withUnder([], lines).map((line) => (line === "" ? "" : indent + line));
  page.splice(end, end, [...(rest.length > 0 || entry.marker === "###" ? [""] : []), ...added]);
}

/** Writes or rewrites the line under a Shipped item that says whether it is live. */
export function setLive(text: string, query: string, live: Live): Edit {
  const note = oneLine(live.note, "What you say about it being live");
  const wanted = { on: live.on, note };
  const before = locatePage(text);
  const entry = find(before, query);
  if (entry.kind !== "shipped") throw new EditError(`"${short(entry.item.title)}" is under ${SECTION_LABEL[entry.kind]}. Only a Shipped item says whether it is live: move it to Shipped first.`);
  const page = new Lines(text);
  const { start } = entry.span;
  const found = liveLine(splitItem(entry.item.markdown).body);
  if (found) {
    // The body the parser reads starts at the first line under the title that is not blank.
    const rest = Array.from({ length: page.trimmed(entry.span) - start - 1 }, (_, n) => page.at(start + 1 + n) ?? "");
    const at = start + 1 + rest.findIndex((line) => line.trim() !== "") + found.at;
    const indent = /^\s*/.exec(page.at(at) ?? "")?.[0] ?? "";
    page.splice(at, at + 1, [indent + liveText(wanted)]);
  } else append(page, entry, [liveText(wanted)]);
  const out = page.text();
  if (out === text) return { text, said: `"${short(entry.item.title)}" already says ${liveText(wanted)}` };
  checked(before, out, { marked: entry, live: wanted });
  return { text: out, said: `Shipped "${short(entry.item.title)}" now says ${liveText(wanted)}` };
}

/** Takes an item off the page, such as an ask that is settled. */
export function removeItem(text: string, query: string): Edit {
  const before = locatePage(text);
  const entry = find(before, query);
  const page = new Lines(text);
  cut(page, entry);
  const out = checked(before, page.text(), { gone: entry });
  const after = entry.kind === "needs" ? ' If it was settled, write the outcome: progress add decisions "<what was decided>".' : "";
  return { text: out, said: `Removed "${short(entry.item.title)}" from ${SECTION_LABEL[entry.kind]}.${after}` };
}

/** Replaces the summary: the text between the front matter and the first heading. A "Goal:" paragraph there stays. */
export function setSummary(text: string, summary: string): Edit {
  const wanted = oneLine(summary, "The summary");
  if (wanted === "") throw new EditError('Say where the work stands: progress summary "<one or two sentences>".');
  if (GOAL_LEAD.test(wanted)) throw new EditError('The goal goes in the "## Goal" section, not the summary.');
  const before = locatePage(text);
  const page = new Lines(text);
  const { start, end } = before.summary;
  const goal = before.goalInSummary;
  const last = Math.min(end, page.length);
  const after = last < page.length ? [""] : [];
  const lead = [...(start > 0 ? [""] : []), wanted];
  // The goal's own lines stay as they are, line endings and all: only the lines around them are replaced.
  if (goal) {
    page.splice(goal.end, last, after);
    page.splice(start, goal.start, [...lead, ""]);
  } else page.splice(start, last, [...lead, ...after]);
  const out = checked(before, page.text(), { summary: wanted });
  return { text: out, said: "Replaced the summary." };
}
