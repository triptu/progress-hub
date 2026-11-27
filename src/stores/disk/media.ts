import { readdirSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, normalize, relative, sep } from "node:path";
import { instant } from "../../core/journal.ts";
import { localPath, type MediaRef } from "../../core/parse.ts";
import { MOST_FOLDER_FILES, type FolderFile, type Media, type WorkId } from "../../core/types.ts";
import { fileUrl } from "./render.ts";

/**
 * The media a page shows that exist inside the work's folder, once each, timed by the file itself.
 * A missing file, a URL, a dotfile or anything whose real path leaves the folder is left out. A link that
 * names a folder there is one item with the files in it; a folder with none is left out too.
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
      if (!real.startsWith(realDir + sep)) continue;
      const src = fileUrl(work, inside.split(sep).join("/"));
      if (ref.kind === "folder" && stat.isDirectory()) {
        const files = folderFiles(work, inside, real, realDir);
        const newest = files.map((file) => file.at).sort().at(-1);
        if (newest) found.set(inside, { work, kind: "folder", src, caption: ref.caption, at: newest, files });
      } else if (ref.kind !== "folder" && stat.isFile()) found.set(inside, { work, kind: ref.kind, src, caption: ref.caption, at: instant(stat.mtime) });
    } catch {
      continue;
    }
  }
  return [...found.values()];
}

/**
 * The files in a folder and the folders under it, by name as a person sorts them, with their paths inside it.
 * Dotfiles and anything whose real path leaves the work's folder are left out, and the list stops at `MOST_FOLDER_FILES`.
 */
function folderFiles(work: WorkId, inside: string, real: string, realDir: string): FolderFile[] {
  const files: FolderFile[] = [];
  const walk = (dir: string, prefix: string) => {
    const names = readdirSync(dir).filter((name) => !name.startsWith(".")).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    for (const name of names) {
      if (files.length >= MOST_FOLDER_FILES) return;
      try {
        const path = realpathSync(join(dir, name));
        if (!path.startsWith(realDir + sep)) continue;
        const stat = statSync(path);
        const rel = prefix + name;
        if (stat.isDirectory()) walk(path, `${rel}/`);
        else if (stat.isFile()) files.push({ name: rel, src: fileUrl(work, `${inside.split(sep).join("/")}/${rel}`), at: instant(stat.mtime) });
      } catch {
        continue;
      }
    }
  };
  walk(real, "");
  return files;
}

/** Newest first; files saved in the same moment keep the page's order. */
export function newestFirst(media: readonly Media[]): Media[] {
  return media.map((m, index) => ({ m, index })).sort((a, b) => (a.m.at < b.m.at ? 1 : a.m.at > b.m.at ? -1 : a.index - b.index)).map(({ m }) => m);
}
