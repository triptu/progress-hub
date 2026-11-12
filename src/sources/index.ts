import { t3Source } from "../t3/source.ts";
import { t3Files } from "../t3/read.ts";
import type { AgentSource } from "./source.ts";

/**
 * The harnesses this machine has, found without any setup. Supporting another one is an adapter that
 * implements `AgentSource`, and a line here.
 */
export function agentSources(env: Record<string, string | undefined> = process.env): AgentSource[] {
  const t3 = t3Files(undefined, env);
  return t3 === null ? [] : [t3Source(t3)];
}
