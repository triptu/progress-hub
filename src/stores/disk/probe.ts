/**
 * Whether something is listening at an address on this machine. A page lists where its app runs; a dev
 * server that has stopped leaves a dead link, and the hub says so. Only this machine's own addresses are
 * tried, by opening a connection and closing it, so nothing is requested and no server logs a visit.
 */
const AGE_MS = 10_000;
const PATIENCE_MS = 1_000;

/** The hosts a local address may be written with, and the addresses each stands for. */
const LOCAL: Readonly<Record<string, readonly string[]>> = { localhost: ["127.0.0.1", "::1"], "127.0.0.1": ["127.0.0.1"], "0.0.0.0": ["127.0.0.1"], "[::1]": ["::1"] };

function listening(hostname: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const giveUp = setTimeout(() => resolve(false), PATIENCE_MS);
    const done = (up: boolean) => {
      clearTimeout(giveUp);
      resolve(up);
    };
    Bun.connect({
      hostname,
      port,
      socket: {
        open(socket) {
          socket.end();
          done(true);
        },
        data() {},
        error() {
          done(false);
        },
        connectError() {
          done(false);
        },
      },
    }).catch(() => done(false));
  });
}

export class Probes {
  private readonly known = new Map<string, { up: boolean | null; at: number; busy: boolean }>();
  private readonly onChange: () => void;

  constructor(onChange: () => void) {
    this.onChange = onChange;
  }

  /** True or false for an address on this machine once it has been tried. Null for any other address, and until the first try ends. */
  up(url: string): boolean | null {
    return this.known.get(url)?.up ?? null;
  }

  /** Tries each local address that has not been tried lately, and forgets the ones no page lists any more. */
  refresh(urls: readonly string[], now = Date.now()): void {
    for (const url of this.known.keys()) if (!urls.includes(url)) this.known.delete(url);
    for (const url of urls) {
      const target = localTarget(url);
      if (!target) continue;
      const entry = this.known.get(url) ?? { up: null, at: 0, busy: false };
      this.known.set(url, entry);
      if (entry.busy || now - entry.at < AGE_MS) continue;
      entry.busy = true;
      void Promise.all(target.hosts.map((host) => listening(host, target.port))).then((answers) => {
        const up = answers.some(Boolean);
        const changed = entry.up !== up;
        entry.up = up;
        entry.at = Date.now();
        entry.busy = false;
        if (changed && this.known.get(url) === entry) this.onChange();
      });
    }
  }
}

function localTarget(url: string): { hosts: readonly string[]; port: number } | null {
  if (!URL.canParse(url)) return null;
  const { hostname, port, protocol } = new URL(url);
  const hosts = LOCAL[hostname.toLowerCase()] ?? (hostname.toLowerCase().endsWith(".localhost") ? LOCAL.localhost : undefined);
  if (!hosts) return null;
  return { hosts, port: port === "" ? (protocol === "https:" ? 443 : 80) : Number(port) };
}
