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
const KINDS: readonly MediaKind[] = ["image", "video", "page", "file"];

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
