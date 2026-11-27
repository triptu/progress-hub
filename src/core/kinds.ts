import type { Media } from "./types.ts";

const IMAGE_FILE = /\.(png|jpe?g|gif|webp|avif|svg)$/i;
const VIDEO_FILE = /\.(mp4|m4v|mov|webm|ogv)$/i;
const PAGE_FILE = /\.html?$/i;

/** What a file shows as, from its extension: an image, a video or a page. Null for anything else. */
export function mediaKind(target: string): Extract<Media["kind"], "image" | "video" | "page"> | null {
  const file = target.replace(/[?#].*$/, "");
  return VIDEO_FILE.test(file) ? "video" : PAGE_FILE.test(file) ? "page" : IMAGE_FILE.test(file) ? "image" : null;
}
