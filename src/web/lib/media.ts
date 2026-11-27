import { mediaKind } from "../../core/kinds.ts";
import type { Media, WorkSummary } from "../../core/types.ts";
import { matches } from "./needs.ts";
import { dayOf } from "./time.ts";

/** A media file with the work it belongs to, as the media screen shows it. */
export interface MediaItem extends Media {
  readonly workTitle: string;
  readonly project: string | null;
  /** The caption, else the file's name. */
  readonly label: string;
}

export type MediaKind = Media["kind"];

/** The kinds of media, in the order their filters stand. */
const KINDS: readonly MediaKind[] = ["image", "video", "page", "file", "folder"];

/**
 * The kinds a list holds, and the list narrowed to the chosen ones. A choice counts only for a kind
 * the list holds, so one made on Home never empties a work that has none of that kind.
 */
export function byKind(items: readonly MediaItem[], chosen: ReadonlySet<MediaKind>): { readonly kinds: readonly MediaKind[]; readonly items: readonly MediaItem[] } {
  const kinds = KINDS.filter((kind) => items.some((item) => item.kind === kind));
  const narrowTo = kinds.filter((kind) => chosen.has(kind));
  return { kinds, items: narrowTo.length ? items.filter((item) => narrowTo.includes(item.kind)) : items };
}

export interface MediaDay {
  readonly key: string;
  readonly label: string;
  readonly items: readonly MediaItem[];
}

/** Where a picture loads from: its address with the file's time on it, which the browser keeps until the file changes. */
export function pictureSrc(item: Media): string {
  return `${item.src}?v=${Date.parse(item.at)}`;
}

/**
 * How the hub shows a document: Markdown rendered, a table file as a table, JSON laid out, and any other file as
 * text. Null for a file known not to be text, such as a PDF, a spreadsheet or an archive, which opens in a tab of its own.
 */
export type DocumentFormat = "markdown" | "table" | "json" | "text";

export function documentFormat(src: string): DocumentFormat | null {
  const ext = /\.([a-z0-9]+)$/i.exec(src.replace(/[?#].*$/, ""))?.[1]?.toLowerCase() ?? "";
  if (ext === "md" || ext === "markdown") return "markdown";
  if (ext === "csv" || ext === "tsv") return "table";
  if (ext === "json") return "json";
  return BINARY.has(ext) ? null : "text";
}

const BINARY = new Set(["pdf", "zip", "gz", "tgz", "tar", "7z", "rar", "xls", "xlsx", "doc", "docx", "ppt", "pptx", "key", "numbers", "pages", "exe", "dmg", "pkg", "msi", "app", "bin", "wasm", "db", "sqlite", "parquet", "mp3", "wav", "m4a", "ogg", "flac", "woff", "woff2", "ttf", "otf", "ico", "heic", "psd", "fig", "sketch"]);

/** A folder's files as media of their own, each named by its path in the folder, so the viewer can show them. */
export function folderItems(folder: MediaItem): readonly MediaItem[] {
  return (folder.files ?? []).map((file) => ({ work: folder.work, kind: mediaKind(file.name) ?? "file", src: file.src, caption: "", at: file.at, workTitle: folder.workTitle, project: folder.project, label: file.name }));
}

/** Whether one of the media opens large in the hub. A document does when the hub can show it. */
export const opensInHub = (item: Media) => item.kind !== "file" || documentFormat(item.src) !== null;

export function fileName(src: string): string {
  const last = src.split("/").at(-1) ?? src;
  try {
    return decodeURIComponent(last);
  } catch {
    return last;
  }
}

/** Joins each media file to its work, keeps those the search matches, and keeps the server's newest-first order. */
export function mediaItems(media: readonly Media[], works: readonly WorkSummary[], query: string): readonly MediaItem[] {
  const byId = new Map(works.map((work) => [work.id, work]));
  const items: MediaItem[] = [];
  for (const m of media) {
    const work = byId.get(m.work);
    if (!work) continue;
    const item = { ...m, workTitle: work.title, project: work.project, label: m.caption || fileName(m.src) };
    if (matches(query, item.label, item.workTitle, item.project)) items.push(item);
  }
  return items;
}

export function mediaDays(items: readonly MediaItem[], now: number): readonly MediaDay[] {
  const days: { key: string; label: string; items: MediaItem[] }[] = [];
  for (const item of items) {
    const day = dayOf(item.at, now);
    const last = days.at(-1);
    if (last?.key === day.key) last.items.push(item);
    else days.push({ ...day, items: [item] });
  }
  return days;
}
