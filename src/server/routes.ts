import type { HubState, WorkId } from "../core/types.ts";
import type { Stores } from "../stores/store.ts";

/** What the read routes answer from: every store, and the hub's whole state as the page gets it. */
export interface Readable {
  readonly stores: Stores;
  state(): HubState;
}

/**
 * The hub's reads: its state, one work's page, its media, and a file a work shows. Any server that holds `Stores`
 * answers them the same way through this. Null when the request is for none of them.
 */
export async function read(req: Request, hub: Readable): Promise<Response | null> {
  const url = new URL(req.url);
  const path = url.pathname;
  if (path === "/api/state") return Response.json(hub.state());
  if (path === "/api/media") return Response.json(await hub.stores.media());
  // A file a work shows. An address with the file's time on it names one version, which the browser may keep.
  if (path.startsWith("/files/")) return hub.stores.file(path.slice("/files/".length), url.searchParams.has("v"));
  const work = /^\/api\/work\/([^/]+)$/.exec(path)?.[1];
  if (work !== undefined) {
    const name = decoded(work);
    const detail = await hub.stores.named(name);
    return detail ? Response.json(detail) : Response.json({ error: `No work called ${name}.` }, { status: 404 });
  }
  return null;
}

function decoded(part: string): string {
  try {
    return decodeURIComponent(part);
  } catch {
    return part;
  }
}

/** A request the hub's own page made: its origin is the address the request came to. */
export function fromOwnPage(req: Request): boolean {
  const origin = req.headers.get("origin");
  return origin !== null && URL.canParse(origin) && new URL(origin).host.toLowerCase() === (req.headers.get("host") ?? "").toLowerCase();
}
