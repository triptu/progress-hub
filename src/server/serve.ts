import { join } from "node:path";
import type { HubState, WorkId } from "../core/types.ts";
import type { AgentSource } from "../sources/source.ts";
import { fromOwnPage, read } from "./routes.ts";
import { machineLabel, Sender, type Link } from "../central/send.ts";
import { readMarkChange, type MarkOrder } from "../central/protocol.ts";
import { ownsMark } from "../core/marks.ts";
import { DiskStore } from "../stores/disk/index.ts";
import { MarkStore } from "../stores/marks.ts";
import { Stores } from "../stores/store.ts";
import { readTodoChange } from "../core/todos.ts";
import { TodoStore } from "../stores/todos.ts";
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
 * did, so it fetches what it shows. The works come from the progress home at `home` on this machine's disk.
 * What the user marks and their todos are kept in two files in `home`. A linked machine's todos file keeps only
 * what the central hub has not taken yet.
 * Answers only requests addressed to this machine: loopback, or one of `hosts` (the other names it is reached by), on the hub's port.
 * Anything else may be another site reaching the hub through DNS rebinding.
 */
export function serve(options: {
  home: string;
  port: number;
  sources?: readonly AgentSource[];
  hosts?: readonly string[];
  open?: (path: string) => void;
  /** A central hub this machine sends its state to, when it is linked to one. */
  central?: Link | null;
}): Running {
  const own = new DiskStore(options.home, options.sources);
  const stores = new Stores(own);
  // What the user keeps apart from any work. Like a work's journal, these are the hub's own files in the home.
  // A mark on an item an agent has since reworded is given on the item's id now. Another machine's works are not followed.
  const marks = new MarkStore(join(options.home, ".marks.json"), () => own.formerIds());
  const todos = new TodoStore(join(options.home, ".todos.json"));
  /** Goes up with each change the user makes. */
  let userChanges = 0;
  // A mark changed on the central hub comes back as an order, applied here as a click on this hub is. One that is
  // not about this machine's own work is left out, whatever hub sent it.
  const apply = (order: MarkOrder) => {
    if (!ownsMark(order.kind, order.key, new Set((own.state()?.works ?? []).map((work) => work.id as string)))) return;
    if (marks.change(order.kind, [order.key], order.on)) userChanges++;
  };
  // A todo the central hub has taken is the user's there, and goes from this machine's file.
  const release = (ids: readonly string[]) => {
    if (todos.release(ids)) userChanges++;
  };
  const sender = options.central ? new Sender({ link: options.central, own, extras: () => ({ marks: marks.get(), todos: todos.get() }), apply, release, changes: () => `${own.version}/${userChanges}` }) : null;
  const machine = machineLabel();
  const state = (): HubState => ({ ...stores.state(), machine: { label: machine, central: sender?.status() ?? null }, marks: marks.get(), todos: todos.get() });
  const names = new Set(["127.0.0.1", "localhost", ...(options.hosts ?? [])].map((name) => name.toLowerCase()));
  const local = <R extends Request>(handler: (req: R, srv: Bun.Server<undefined>) => Response | Promise<Response>) => (req: R, srv: Bun.Server<undefined>) => {
    const host = (req.headers.get("host") ?? "").toLowerCase();
    const suffix = `:${srv.port}`;
    const ours = host.endsWith(suffix) && names.has(host.slice(0, -suffix.length));
    return ours ? handler(req, srv) : new Response("Forbidden", { status: 403 });
  };
  const reads = local(async (req) => (await read(req, { stores, state })) ?? new Response("Not found", { status: 404 }));
  stores.refresh();

  const clients = new Set<ReadableStreamDefaultController<string>>();
  // A page also hears when the sends to the central hub stop going through, or start again.
  const version = () => `${stores.version}/${userChanges}/${JSON.stringify(sender?.status().health)}`;
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
      sender?.tick();
    } catch (error) {
      console.error(`progress: ${error instanceof Error ? error.message : String(error)}`);
    }
  }, POLL_MS);
  const keepAlive = setInterval(() => send(": keep-alive\n\n"), 20000);

  // The app's script has to run before the browser paints: after a reload it draws the screen the tab was
  // showing, and a paint before that is a blank frame. `blocking="render"` says so, and Bun's bundler drops
  // the attribute from the page it builds, so the page is served with it put back.
  let built: Promise<string> | null = null;
  const page = async (req: Request): Promise<Response> => {
    // A machine linked to a central hub is read there: that hub opens on every device and shows every machine's
    // work. A page asked for here is sent on to the same page there while that hub takes this machine's sends.
    // When it does not, or the address says `?local`, this machine's own page answers.
    const asked = new URL(req.url);
    const central = sender?.status();
    if (central?.health.ok && !asked.searchParams.has("local")) return Response.redirect(`${central.url}${asked.pathname}`, 302);
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
      "/board": page,
      "/activity": page,
      "/media": page,
      // The tabs of earlier builds, which the page sends on to where each went.
      "/needs": page,
      "/todos": page,
      "/in-progress": page,
      "/next": page,
      "/shipped": page,
      "/w/:work": page,
      "/w/:work/:tab": page,
      "/api/state": reads,
      "/api/media": reads,
      "/files/*": reads,
      // The hub's two writes, marks and todos. Only its own page may make them: another site's form can post here, but not with this origin.
      "/api/marks": {
        POST: local(async (req) => {
          if (!fromOwnPage(req)) return new Response("Forbidden", { status: 403 });
          const change = readMarkChange(await req.json().catch(() => null));
          if (typeof change === "string") return new Response(change, { status: 400 });
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
      "/api/work/:work": reads,
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

function openInBrowser(path: string): void {
  Bun.spawn([process.platform === "darwin" ? "open" : "xdg-open", path], { stdout: "ignore", stderr: "ignore" });
}
