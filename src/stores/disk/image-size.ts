import { closeSync, openSync, readSync, statSync } from "node:fs";

interface Size {
  readonly width: number;
  readonly height: number;
}

const seen = new Map<string, { readonly stamp: string; readonly size: Size | null }>();

/**
 * The pixel size of a PNG, JPEG, GIF or WebP file, read from its first bytes. Null for anything else, or a file
 * that can't be read. The page reserves an image's room from this, so nothing moves when the image arrives.
 */
export function imageSize(path: string): Size | null {
  let stamp: string;
  try {
    const stat = statSync(path);
    stamp = `${stat.mtimeMs}:${stat.size}`;
  } catch {
    return null;
  }
  const known = seen.get(path);
  if (known?.stamp === stamp) return known.size;
  const size = read(path);
  seen.set(path, { stamp, size });
  return size;
}

function read(path: string): Size | null {
  const bytes = Buffer.alloc(256 * 1024);
  let length: number;
  try {
    const file = openSync(path, "r");
    try {
      length = readSync(file, bytes, 0, bytes.length, 0);
    } finally {
      closeSync(file);
    }
  } catch {
    return null;
  }
  const size = png(bytes, length) ?? gif(bytes, length) ?? webp(bytes, length) ?? jpeg(bytes, length);
  return size && size.width > 0 && size.height > 0 ? size : null;
}

function png(b: Buffer, n: number): Size | null {
  if (n < 24 || b.readUInt32BE(0) !== 0x89504e47 || b.toString("latin1", 12, 16) !== "IHDR") return null;
  return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
}

function gif(b: Buffer, n: number): Size | null {
  if (n < 10 || b.toString("latin1", 0, 3) !== "GIF") return null;
  return { width: b.readUInt16LE(6), height: b.readUInt16LE(8) };
}

function webp(b: Buffer, n: number): Size | null {
  if (n < 30 || b.toString("latin1", 0, 4) !== "RIFF" || b.toString("latin1", 8, 12) !== "WEBP") return null;
  const kind = b.toString("latin1", 12, 16);
  if (kind === "VP8X") return { width: 1 + b.readUIntLE(24, 3), height: 1 + b.readUIntLE(27, 3) };
  if (kind === "VP8 ") return { width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff };
  if (kind === "VP8L") {
    const bits = b.readUInt32LE(21);
    return { width: 1 + (bits & 0x3fff), height: 1 + ((bits >> 14) & 0x3fff) };
  }
  return null;
}

/** A JPEG says its size in the first start-of-frame segment, after segments of any length. */
function jpeg(b: Buffer, n: number): Size | null {
  if (n < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null;
  let at = 2;
  while (at + 9 < n) {
    if (b[at] !== 0xff) return null;
    const marker = b[at + 1] ?? 0;
    const frame = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (frame) return { width: b.readUInt16BE(at + 7), height: b.readUInt16BE(at + 5) };
    at += 2 + b.readUInt16BE(at + 2);
  }
  return null;
}
