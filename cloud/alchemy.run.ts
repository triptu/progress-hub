// The central hub on Cloudflare: one Worker with the app's build, one Durable Object, and one private bucket.
// Run it through `bun run deploy`, which checks the account, keeps the keys, and passes what is below in the
// environment. Alchemy keeps what it deployed in the Cloudflare account itself, so this machine and the repository's
// workflow deploy from one state.
import { join } from "node:path";
import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import { STACK } from "./place.ts";

const domain = process.env.PROGRESS_DOMAIN?.trim() || undefined;
// A domain whose DNS is kept elsewhere can't be the Worker's own. It reaches Cloudflare as a custom hostname of
// another zone on the account, and the Worker answers it through a route on that zone.
const zone = process.env.PROGRESS_ZONE?.trim() || undefined;

export default Alchemy.Stack(
  STACK,
  { providers: Cloudflare.providers(), state: Cloudflare.state() },
  Effect.gen(function* () {
    // Private: no public address. Files are served only by the Worker, to someone signed in.
    const files = yield* Cloudflare.R2.Bucket("files");
    const hub = yield* Cloudflare.Worker("hub", {
      main: join(import.meta.dir, "worker.ts"),
      compatibility: { date: "2026-10-01" },
      // The Worker runs first for every path, so the app's own files need a session too.
      assets: { directory: join(import.meta.dir, "dist"), runWorkerFirst: true, notFoundHandling: "single-page-application" },
      env: {
        HUB: Cloudflare.DurableObject("Hub"),
        FILES: files,
        MACHINE_KEY: Config.Redacted("PROGRESS_MACHINE_KEY"),
        SESSION_KEY: Config.Redacted("PROGRESS_SESSION_KEY"),
        GOOGLE_CLIENT_ID: Config.String("PROGRESS_GOOGLE_CLIENT_ID"),
        ALLOWED_EMAILS: Config.String("PROGRESS_ALLOW"),
        // Ten tries a minute from one address at each sign-in route, counted per Cloudflare location.
        SIGN_IN_LIMIT: Cloudflare.Workers.RateLimit("SIGN_IN_LIMIT", { namespaceId: 3001, simple: { limit: 10, period: 60 } }),
      },
      // No per-version preview addresses: each would be another host running whatever that version was.
      workersDev: { enabled: true, previewsEnabled: false },
      ...(domain && zone ? { routes: [{ pattern: `${domain}/*`, zoneName: zone }] } : domain ? { domain } : {}),
    });
    return { url: hub.url };
  }),
);
