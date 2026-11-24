import type { SessionRef } from "../core/types.ts";
import type { AgentSource } from "../sources/source.ts";
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
  };
}
