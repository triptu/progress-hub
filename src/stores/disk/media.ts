import { realpathSync, statSync } from "node:fs";
import { isAbsolute, join, normalize, relative, sep } from "node:path";
import { instant } from "../../core/journal.ts";
import { localPath, type MediaRef } from "../../core/parse.ts";
import type { Media, WorkId } from "../../core/types.ts";
import { fileUrl } from "./render.ts";

/**
 * The media a page shows that exist inside the work's folder, once each, timed by the file itself.
 * A missing file, a URL, a dotfile or anything whose real path leaves the folder is left out.
 */
export function findMedia(work: WorkId, dir: string, refs: readonly MediaRef[]): Media[] {
  let realDir: string;
  try {
    realDir = realpathSync(dir);
  } catch {
    return [];
  }
  const found = new Map<string, Media>();
  for (const ref of refs) {
    const path = localPath(ref.target);
    if (path === null || path === "" || isAbsolute(path) || path.startsWith("~")) continue;
    const inside = relative(dir, normalize(join(dir, path)));
    if (inside === "" || inside.startsWith("..") || inside.split(sep).some((part) => part.startsWith("."))) continue;
    const known = found.get(inside);
    if (known) {
      if (!known.caption && ref.caption) found.set(inside, { ...known, caption: ref.caption });
      continue;
    }
    try {
      const real = realpathSync(join(dir, inside));
      const stat = statSync(real);
      if (!real.startsWith(realDir + sep) || !stat.isFile()) continue;
      found.set(inside, { work, kind: ref.kind, src: fileUrl(work, inside.split(sep).join("/")), caption: ref.caption, at: instant(stat.mtime) });
    } catch {
      continue;
    }
  }
  return [...found.values()];
}

/** Newest first; files saved in the same moment keep the page's order. */
export function newestFirst(media: readonly Media[]): Media[] {
  return media.map((m, index) => ({ m, index })).sort((a, b) => (a.m.at < b.m.at ? 1 : a.m.at > b.m.at ? -1 : a.index - b.index)).map(({ m }) => m);
}
