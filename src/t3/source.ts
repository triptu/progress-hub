import { Database } from "bun:sqlite";
import type { SessionRef } from "../core/types.ts";
import type { AgentSource, Machine } from "../sources/source.ts";
import { readEnvironmentId, readT3, threadLink, type T3Files } from "./read.ts";

/** T3 Code as an agent source. Everything the hub knows about T3 goes through here and `read.ts`. */
export function t3Source(files: T3Files): AgentSource {
  // The machine's id in T3 never changes, so it is read once, when a link is first asked for.
  let environment: { readonly id: string | null } | null = null;
  return {
    id: "t3",
    label: "T3",
    // T3 sets this in every agent thread it starts.
    detect: (env) => env.T3CODE_THREAD_ID?.trim() || null,
    read: (sessions) => readT3(sessions as SessionRef[], files),
    link: (session) => threadLink((environment ??= { id: readEnvironmentId(files) }).id, session as SessionRef),
    machines: () => linkedMachines(files),
  };
}

/** The machines T3 is linked to, from its own record of them. A link that can't be read is no link. */
function linkedMachines(files: T3Files): Machine[] {
  let db: Database | null = null;
  try {
    db = new Database(files.db, { readonly: true });
    const rows = db.query("SELECT environment_id, label, urls_json FROM peer_environment_links").all() as { environment_id: unknown; label: unknown; urls_json: unknown }[];
    return rows.flatMap((row) => {
      const urls: unknown = typeof row.urls_json === "string" ? JSON.parse(row.urls_json) : null;
      const first = Array.isArray(urls) ? urls.find((url): url is string => typeof url === "string" && URL.canParse(url)) : undefined;
      if (typeof row.environment_id !== "string" || first === undefined) return [];
      return [{ label: typeof row.label === "string" && row.label !== "" ? row.label : new URL(first).hostname, host: new URL(first).hostname }];
    });
  } catch {
    return [];
  } finally {
    db?.close();
  }
}
