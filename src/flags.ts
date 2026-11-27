/** A command used wrongly. It is printed as it is, with no stack, and the command exits 1. */
export class UsageError extends Error {}

/**
 * The words and flags of a command. A flag takes the word after it, or what follows `=`, and a flag given again
 * adds another value. A switch takes no value, and is there with an empty one.
 */
export function flagsOf(args: readonly string[], known: readonly string[], switches: readonly string[] = []): { words: string[]; flags: Map<string, string[]> } {
  const words: string[] = [];
  const flags = new Map<string, string[]>();
  const add = (name: string, value: string) => flags.set(name, [...(flags.get(name) ?? []), value]);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? "";
    // A shell that keeps a variable whole hands over "--work <work>" as one argument. A known flag is read from it; any other line of text may start with two dashes.
    const whole = /^--([a-z-]+)\s+(.+)$/s.exec(arg);
    const name = whole?.[1] && known.includes(whole[1]) ? whole : /^--([a-z-]+)(?:=(.*))?$/s.exec(arg);
    if (!name?.[1]) {
      words.push(arg);
      continue;
    }
    if (switches.includes(name[1])) {
      if (name[2] !== undefined) throw new UsageError(`--${name[1]} takes no value.`);
      add(name[1], "");
      continue;
    }
    if (!known.includes(name[1])) throw new UsageError(`progress has no --${name[1]} here. It takes ${[...known, ...switches].map((flag) => `--${flag}`).join(", ")}.`);
    const value = name[2] ?? args[++i];
    if (value === undefined || value.trim() === "") throw new UsageError(`--${name[1]} needs a value after it.`);
    add(name[1], value);
  }
  return { words, flags };
}

/** A flag's value. Given twice, the last one counts. */
export const one = (flags: ReadonlyMap<string, readonly string[]>, name: string) => flags.get(name)?.at(-1);
