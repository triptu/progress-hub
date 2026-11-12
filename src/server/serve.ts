import { join } from "node:path";
import type { HubState, MarkKind, WorkId } from "../core/types.ts";
import type { AgentSource } from "../sources/source.ts";
import { DiskStore } from "../stores/disk/index.ts";
import { MARK_KINDS, MarkStore } from "../stores/marks.ts";
import { Stores, type OtherStore } from "../stores/store.ts";
import { readTodoChange, TodoStore } from "../stores/todos.ts";
import app from "../web/index.html";

const POLL_MS = 2000;

export interface Running {
  readonly url: string;
  /** This machine's own store. */
  readonly own: DiskStore;
  stop(): void;
}

/**
 * Starts the hub on 127.0.0.1. Asks the stores what changed every 2 s, and tells each open page when anything
 * did, so it fetches what it shows. The works come from the progress home at `home` on this machine's disk,
 * and from `others`. What the user marks and their todos are kept in two files in `home`.
 * Answers only requests addressed to this machine: loopback, or one of `hosts` (its tailnet names), on the hub's port.
 * Anything else may be another site reaching the hub through DNS rebinding.
 */
export function serve(options: {
  home: string;
  port: number;
  sources?: readonly AgentSource[];
  hosts?: readonly string[];
  open?: (path: string) => void;
  others?: readonly OtherStore[];
}): Running {
  const own = new DiskStore(options.home, options.sources);
  const stores = new Stores(own, options.others);
  // What the user keeps apart from any work. Like a work's journal, these are the hub's own files in the home.
  const marks = new MarkStore(join(options.home, ".marks.json"));
  const todos = new TodoStore(join(options.home, ".todos.json"));
  /** Goes up with each change the user makes. */
  let userChanges = 0;
  const state = (): HubState => ({ ...stores.state(), marks: marks.get(), todos: todos.get() });
  const names = new Set(["127.0.0.1", "localhost", ...(options.hosts ?? [])].map((name) => name.toLowerCase()));
  const local = <R extends Request>(handler: (req: R, srv: Bun.Server<undefined>) => Response | Promise<Response>) => (req: R, srv: Bun.Server<undefined>) => {
    const host = (req.headers.get("host") ?? "").toLowerCase();
    const suffix = `:${srv.port}`;
    const ours = host.endsWith(suffix) && names.has(host.slice(0, -suffix.length));
    return ours ? handler(req, srv) : new Response("Forbidden", { status: 403 });
  };
  stores.refresh();

  const clients = new Set<ReadableStreamDefaultController<string>>();
  const version = () => `${stores.version}/${userChanges}`;
  let sent = version();
  const send = (message: string) => {
    for (const client of clients) {
      try {
        client.enqueue(message);
      } catch {
        clients.delete(client);
      }
    }
  };
  const push = () => {
    if (version() === sent) return;
    sent = version();
    send("data: changed\n\n");
  };
  const timer = setInterval(() => {
    try {
      stores.refresh();
      push();
    } catch (error) {
      console.error(`progress: ${error instanceof Error ? error.message : String(error)}`);
    }
  }, POLL_MS);
  const keepAlive = setInterval(() => send(": keep-alive\n\n"), 20000);

  // The app's script has to run before the browser paints: after a reload it draws the screen the tab was
  // showing, and a paint before that is a blank frame. `blocking="render"` says so, and Bun's bundler drops
  // the attribute from the page it builds, so the page is served with it put back.
  let built: Promise<string> | null = null;
  const page = async (): Promise<Response> => {
    built ??= fetch(`http://127.0.0.1:${server.port}/app.html`)
      .then((response) => response.text())
      .catch((error: unknown) => {
        built = null;
        throw error;
      });
    const html = (await built).replace('<script type="module"', '<script type="module" blocking="render"');
    return new Response(html, { headers: { "Content-Type": "text/html;charset=utf-8", "Cache-Control": "no-cache" } });
  };

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: options.port,
    development: false,
    routes: {
      // The bundled page, as Bun built it. Registering it is also what serves its script and styles.
      "/app.html": app,
      "/": page,
      "/needs": page,
      "/todos": page,
      "/in-progress": page,
      "/next": page,
      "/shipped": page,
      "/activity": page,
      "/media": page,
      "/w/:work": page,
      "/w/:work/:tab": page,
      // `own` is this machine's store alone, which is what another hub asks for, so two hubs that read each other never loop.
      "/api/state": local((req) => Response.json(new URL(req.url).searchParams.has("own") ? stores.own.state() : state())),
      "/api/media": local(async (req) => Response.json(await (new URL(req.url).searchParams.has("own") ? stores.own.media() : stores.media()))),
      // A file a work shows. An address with the file's time on it names one version, which the browser may keep.
      "/files/*": local((req) => {
        const url = new URL(req.url);
        return stores.file(url.pathname.slice("/files/".length), url.searchParams.has("v"));
      }),
      // The hub's two writes, marks and todos. Only its own page may make them: another site's form can post here, but not with this origin.
      "/api/marks": {
        POST: local(async (req) => {
          if (!fromOwnPage(req)) return new Response("Forbidden", { status: 403 });
          const change = readMarkChange(await req.json().catch(() => null));
          if (!change) return new Response("Bad request", { status: 400 });
          if (marks.change(change.kind, change.keys, change.on)) userChanges++;
          push();
          return new Response(null, { status: 204 });
        }),
      },
      "/api/todos": {
        POST: local(async (req) => {
          if (!fromOwnPage(req)) return new Response("Forbidden", { status: 403 });
          const change = readTodoChange(await req.json().catch(() => null));
          if (!change) return new Response("Bad request", { status: 400 });
          if (todos.change(change)) userChanges++;
          push();
          return new Response(null, { status: 204 });
        }),
      },
      "/api/open": {
        // Opens a client-only app's HTML file in the browser of the machine the hub runs on. Asked for only from that machine,
        // from the hub's own page, and only for a file a work's page lists under Try it.
        POST: local(async (req) => {
          if (!fromOwnPage(req) || !/^(127\.0\.0\.1|localhost):/.test((req.headers.get("host") ?? "").toLowerCase())) return new Response("Forbidden", { status: 403 });
          const body: unknown = await req.json().catch(() => null);
          const { work, url } = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;
          const path = typeof work === "string" && typeof url === "string" ? own.fileToOpen(work as WorkId, url) : null;
          if (path === null) return new Response("Not found", { status: 404 });
          (options.open ?? openInBrowser)(path);
          return new Response(null, { status: 204 });
        }),
      },
      "/api/work/:work": local(async (req) => {
        const detail = await stores.detail(req.params.work as WorkId);
        return detail ? Response.json(detail) : Response.json({ error: `No work called ${req.params.work}.` }, { status: 404 });
      }),
      "/api/events": local((req, srv) => {
        srv.timeout(req, 0);
        let self: ReadableStreamDefaultController<string> | null = null;
        const stream = new ReadableStream<string>({
          start(controller) {
            self = controller;
            clients.add(controller);
            // Bun sends the headers with the first chunk, and the page fetches on open.
            controller.enqueue(": open\n\n");
          },
          cancel() {
            if (self) clients.delete(self);
          },
        });
        return new Response(stream, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" } });
      }),
    },
    fetch: local(() => new Response("Not found", { status: 404 })),
  });

  return {
    url: `http://127.0.0.1:${server.port}`,
    own,
    stop() {
      clearInterval(timer);
      clearInterval(keepAlive);
      for (const client of clients) client.close();
      server.stop(true);
    },
  };
}

/** A request the hub's own page made: its origin is the address the request came to. */
function fromOwnPage(req: Request): boolean {
  const origin = req.headers.get("origin");
  return origin !== null && URL.canParse(origin) && new URL(origin).host.toLowerCase() === (req.headers.get("host") ?? "").toLowerCase();
}

function openInBrowser(path: string): void {
  Bun.spawn([process.platform === "darwin" ? "open" : "xdg-open", path], { stdout: "ignore", stderr: "ignore" });
}

/** `{ kind, keys, on }` as the page sends it, or null when it is anything else. */
function readMarkChange(body: unknown): { kind: MarkKind; keys: readonly string[]; on: boolean } | null {
  if (typeof body !== "object" || body === null) return null;
  const { kind, keys, on } = body as Record<string, unknown>;
  const known = MARK_KINDS.find((name) => name === kind);
  return known && Array.isArray(keys) && keys.every((key) => typeof key === "string") && typeof on === "boolean" ? { kind: known, keys, on } : null;
}
