import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { localClasses, modules } from "../scripts/css-types.ts";

const web = join(import.meta.dir, "../src/web");
const read = (file: string) => readFileSync(join(web, file), "utf8");
const bare = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, "");

/** What every view shares: the files app.css imports, in its order. */
const shared = [...read("app.css").matchAll(/@import "\.\/(.+?)";/g)].map((line) => line[1] ?? "");
/** Each view's own styles, by the view's file. */
const views = ["App.tsx", ...readdirSync(join(web, "views")).filter((name) => name.endsWith(".tsx")).map((name) => `views/${name}`)];
const moduleOf = (view: string) => view.replace(/\.tsx$/, ".module.css");
const own = views.map(moduleOf).filter((file) => Bun.file(join(web, file)).size > 0);
const everyFile = [...shared, ...own];
const allCss = everyFile.map((file) => bare(read(file))).join("\n");

/** Each rule in some CSS as its selector and body, at-rules included, one level deep. */
function rules(css: string): { selector: string; body: string }[] {
  const found: { selector: string; body: string }[] = [];
  let depth = 0;
  let ruleStart = 0;
  let bodyStart = 0;
  for (let i = 0; i < css.length; i++) {
    if (css[i] === "{" && depth++ === 0) bodyStart = i + 1;
    if (css[i] === "}" && --depth === 0) {
      found.push({ selector: css.slice(ruleStart, bodyStart - 1).trim().replace(/\s+/g, " "), body: css.slice(bodyStart, i) });
      ruleStart = i + 1;
    }
  }
  return found;
}

/** Every plain rule of a file, with the ones inside its @media and @container blocks. */
function plainRules(css: string): { selector: string; body: string }[] {
  return rules(css).flatMap((rule) => (/^@(media|container)/.test(rule.selector) ? rules(rule.body) : rule.selector.startsWith("@") ? [] : [rule]));
}

/** A selector list as its selectors: cut at the commas that are not inside brackets. */
function selectorsOf(list: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < list.length; i++) {
    if (list[i] === "(") depth++;
    else if (list[i] === ")") depth--;
    else if (list[i] === "," && depth === 0) {
      parts.push(list.slice(start, i).trim());
      start = i + 1;
    }
  }
  return [...parts, list.slice(start).trim()];
}

function repeated(list: { selector: string }[]): string[] {
  const plain = list.map((rule) => rule.selector).filter((selector) => !selector.startsWith("@"));
  return [...new Set(plain.filter((selector, index) => plain.indexOf(selector) !== index))];
}

// Bun 1.4.4's CSS minifier dropped the first of two `.app` rules inside one @media block, which left the phone
// layout a sidebar's width wide. Until that is fixed upstream, a selector appears once per block.
test("no selector is written twice in one block of a style file", () => {
  const twice = everyFile.flatMap((file) => {
    const top = rules(bare(read(file)));
    const blocks = top.filter((rule) => rule.selector.startsWith("@media") || rule.selector.startsWith("@container"));
    return [...repeated(top).map((selector) => `${file}: ${selector}`), ...blocks.flatMap((block) => repeated(rules(block.body)).map((selector) => `${file}: ${block.selector} ${selector}`))];
  });
  expect(twice).toEqual([]);
});

// The hub has four type sizes, three weights and two text colours. A rule that sets its own size, weight or
// grey adds a kind of text nobody chose, which is how a screen ends up with two dozen.
test("the styles set type only through the roles in tokens.css", () => {
  const values = (property: string) => [...allCss.matchAll(new RegExp(`(?<![\\w-])${property}:\\s*([^;]+);`, "g"))].map((match) => (match[1] ?? "").trim());
  expect([...new Set(values("font"))].sort()).toEqual(["inherit", "var(--t-body)", "var(--t-code)", "var(--t-figure)", "var(--t-heading)", "var(--t-small)", "var(--t-title)"]);
  expect([...new Set(values("font-weight"))].sort()).toEqual(["400", "var(--medium)", "var(--strong)"]);
  // The brand's wordmark is mono. An input is 16px on a phone, or iOS zooms the page when it is tapped.
  expect(values("font-family")).toEqual(["var(--mono)"]);
  expect([...new Set(values("font-size"))]).toEqual(["16px"]);
});

// A class in a view's module is that view's alone: the bundler gives it a name no other file can write.
// A class the shared files style (`btn`, `avatar`) is a plain name, and a module that styled it bare would
// restyle it everywhere. So a module names a shared class only tied to one of its own.
test("every rule in a view's module names a class of that view", () => {
  for (const file of own) {
    const loose = plainRules(bare(read(file)))
      .flatMap((rule) => selectorsOf(rule.selector))
      .filter((selector) => !/\.[a-zA-Z_]/.test(selector.replace(/:global\([^()]*\)/g, "")));
    expect([file, loose]).toEqual([file, []]);
  }
});

test("each module's types are the ones its classes give", async () => {
  expect((await modules()).filter(({ want, have }) => want !== have).map(({ file }) => file)).toEqual([]);
});

// The types make a class a view names but its module lacks a type error. This is the other half:
// a class a module has that its view never names is dead weight that reads as if it mattered.
test("every class in a view's module is named by that view, and every shared class by some view", () => {
  const unused = own.flatMap((file) => {
    const view = read(file.replace(/\.module\.css$/, ".tsx"));
    return localClasses(read(file))
      .filter((name) => !new RegExp(`\\bs\\.${name}\\b`).test(view))
      .map((name) => `${file}: ${name}`);
  });
  // A shared class may be named by any view, by the page's first frame or by the HTML the hub renders from Markdown.
  const naming = [...views, "index.html", "../stores/disk/render.ts", ...readdirSync(join(web, "lib")).map((name) => `lib/${name}`)].map(read).join("\n");
  const sharedClasses = new Set([...shared.map((file) => bare(read(file))).join("\n").replace(/\{[^{}]*\}/g, "{}").matchAll(/\.(-?[a-zA-Z_][\w-]*)/g)].map((match) => match[1] ?? ""));
  const unnamed = [...sharedClasses].filter((name) => !new RegExp(`(?<![\\w-])${name}(?![\\w-])`).test(naming)).sort();
  expect({ unused, unnamed }).toEqual({ unused: [], unnamed: [] });
});
