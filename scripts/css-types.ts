/**
 * Writes the types of each view's style module, so a class a view names that the module doesn't have is a
 * type error. Run it after changing a module's classes; a test fails while any are out of date.
 */
import { Glob } from "bun";
import { join } from "node:path";

const web = join(import.meta.dir, "../src/web");

/** The classes a module gives its view: every class its selectors name, apart from the shared ones it marks `:global()`. */
export function localClasses(css: string): string[] {
  const selectors = css
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\{[^{}]*\}/g, "{}")
    .replace(/:global\([^()]*\)/g, "");
  return [...new Set([...selectors.matchAll(/\.(-?[a-zA-Z_][\w-]*)/g)].map((match) => match[1] ?? ""))].sort();
}

export function typesOf(css: string): string {
  const names = localClasses(css);
  return `// Written by scripts/css-types.ts from the module beside it. Run \`bun run css-types\` after changing its classes.\ndeclare const classes: {\n${names.map((name) => `  readonly ${/^[a-zA-Z_$][\w$]*$/.test(name) ? name : JSON.stringify(name)}: string;\n`).join("")}};\nexport default classes;\n`;
}

/** Each module with the types it should have and the types it has. */
export async function modules(): Promise<{ file: string; want: string; have: string | null }[]> {
  const found = [];
  for await (const file of new Glob("**/*.module.css").scan(web)) {
    const types = Bun.file(join(web, file.replace(/\.css$/, ".d.css.ts")));
    found.push({ file, want: typesOf(await Bun.file(join(web, file)).text()), have: (await types.exists()) ? await types.text() : null });
  }
  return found.sort((a, b) => a.file.localeCompare(b.file));
}

if (import.meta.main) {
  const stale = (await modules()).filter(({ want, have }) => want !== have);
  for (const { file, want } of stale) await Bun.write(join(web, file.replace(/\.css$/, ".d.css.ts")), want);
  console.log(stale.length ? `Wrote the types of ${stale.map(({ file }) => file).join(", ")}.` : "Every module's types are up to date.");
}
