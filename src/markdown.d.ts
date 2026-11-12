/** A Markdown file brought in as its text, as `import page from "./page.md" with { type: "text" }`. */
declare module "*.md" {
  const text: string;
  export default text;
}
