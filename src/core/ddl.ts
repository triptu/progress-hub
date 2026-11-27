/**
 * What a migration does to a database, read from its SQL: the tables it adds, changes and drops, with their columns,
 * indexes, constraints, triggers, policies and data changes, and the other objects it touches. It is a reader of the
 * statements migrations are made of, for Postgres and SQLite, not a SQL parser: a statement it doesn't know is listed
 * as written. Pure, so the hub reads a change again whenever this file improves.
 */

/** What happened to a table, a row or an object. `replaced` is a table dropped and made again; `kept` a column a rebuilt table still has. */
export type Mark = "added" | "dropped" | "changed" | "renamed" | "replaced" | "kept";

/** What a row of a table's diff is about. */
export type RowKind = "column" | "index" | "constraint" | "trigger" | "policy" | "security" | "data" | "other";

/** One line of a table's diff: a column added with its type, an index dropped, a backfill. */
export interface Row {
  readonly mark: Mark;
  readonly kind: RowKind;
  /** The column's, index's or constraint's name. Empty for a row with none, such as a data change. */
  readonly name: string;
  /** The column's type, the index's columns, the constraint's definition, a statement in short. */
  readonly detail: string;
  /** What stands beside it in a word or two: "not null", "concurrently", "default now()", "conditional". */
  readonly tags: readonly string[];
  /** The name it had before, for a column renamed. */
  readonly from?: string;
}

/** A table and everything the migration does to it. */
export interface TableDiff {
  readonly name: string;
  readonly mark: Mark;
  /** The name it had before, for a table renamed. */
  readonly from?: string;
  /** Built again under a new name, copied over and renamed back, as SQLite migrations change a column. Its columns are its whole new shape. */
  readonly rebuilt?: true;
  /** A virtual table's module, such as fts5. */
  readonly module?: string;
  /** Made or dropped inside a DO block, only where it was missing or there. */
  readonly conditional?: true;
  readonly rows: readonly Row[];
}

/** A function, view, type or other object, or a statement the reader doesn't know, listed as written. */
export interface ObjectDiff {
  readonly mark: Mark;
  /** What it is, as the SQL says it: "function", "materialized view", "statement", "DO block". */
  readonly kind: string;
  readonly name: string;
  readonly detail: string;
  readonly tags: readonly string[];
}

export interface Diff {
  readonly tables: readonly TableDiff[];
  readonly objects: readonly ObjectDiff[];
}

// ---------------------------------------------------------------- The one scan

/** A piece of SQL: code, a quoted string or name kept as written, or a comment. */
interface Chunk {
  readonly kind: "code" | "quoted" | "comment";
  readonly text: string;
}

/**
 * SQL cut into code, quoted pieces and comments. Every other reader here works on its code only, so a `;`, a comma or a
 * bracket inside '…', "…", `…`, E'…' or a $tag$…$tag$ body never counts, and no space inside one ever changes.
 */
function chunks(sql: string): Chunk[] {
  const out: Chunk[] = [];
  let code = "";
  const push = (kind: Chunk["kind"], text: string) => {
    if (code) out.push({ kind: "code", text: code });
    code = "";
    out.push({ kind, text });
  };
  let i = 0;
  while (i < sql.length) {
    const c = sql[i]!;
    const next = sql[i + 1];
    if (c === "-" && next === "-") {
      const end = sql.indexOf("\n", i);
      const stop = end === -1 ? sql.length : end;
      push("comment", sql.slice(i, stop));
      i = stop;
    } else if (c === "/" && next === "*") {
      let depth = 1;
      let j = i + 2;
      while (j < sql.length && depth > 0) {
        if (sql.startsWith("/*", j)) (depth++, (j += 2));
        else if (sql.startsWith("*/", j)) (depth--, (j += 2));
        else j++;
      }
      push("comment", sql.slice(i, j));
      i = j;
    } else if (c === "'" || c === '"' || c === "`") {
      // E'…' takes a backslash escape. Everywhere a doubled quote is the quote itself.
      const escapes = c === "'" && /(?:^|[^\w$])[eE]$/.test(code);
      let j = i + 1;
      for (; j < sql.length; j++) {
        if (escapes && sql[j] === "\\") j++;
        else if (sql[j] === c && sql[j + 1] === c) j++;
        else if (sql[j] === c) break;
      }
      push("quoted", sql.slice(i, j + 1));
      i = j + 1;
    } else if (c === "$" && !/[\w$]$/.test(code) && /^\$(?:[A-Za-z_]\w*)?\$/.test(sql.slice(i, i + 64))) {
      const tag = /^\$(?:[A-Za-z_]\w*)?\$/.exec(sql.slice(i, i + 64))![0];
      const end = sql.indexOf(tag, i + tag.length);
      const stop = end === -1 ? sql.length : end + tag.length;
      push("quoted", sql.slice(i, stop));
      i = stop;
    } else {
      code += c;
      i++;
    }
  }
  if (code) out.push({ kind: "code", text: code });
  return out;
}

/**
 * The statements in a file's SQL, each on one line with its comments gone and the spaces of its code made single.
 * A `;` inside a quoted piece, a trigger's BEGIN … END body or a CASE … END doesn't end a statement.
 */
export function statements(sql: string): string[] {
  const out: string[] = [];
  let current = "";
  let space = false;
  let word = "";
  let blocks = 0;
  const add = (text: string) => {
    // No space is kept just inside brackets: "( kind IN" reads as "(kind IN".
    if (space && current !== "" && !current.endsWith("(") && text !== ")") current += " ";
    space = false;
    current += text;
  };
  // BEGIN opens a block only in a statement that has a body of statements: a trigger, a function, a procedure.
  const hasBody = () => /^CREATE (?:OR REPLACE )?(?:TEMP |TEMPORARY )?(?:TRIGGER|FUNCTION|PROCEDURE)\b/i.test(current);
  const endWord = () => {
    const w = word.toUpperCase();
    if (w === "CASE" || (w === "BEGIN" && hasBody())) blocks++;
    else if (w === "END") blocks = Math.max(0, blocks - 1);
    word = "";
  };
  for (const chunk of chunks(sql)) {
    if (chunk.kind !== "code") {
      endWord();
      if (chunk.kind === "comment") space = true;
      else add(chunk.text);
      continue;
    }
    for (const c of chunk.text) {
      if (/\w/.test(c)) {
        word += c;
        add(c);
        continue;
      }
      endWord();
      if (/\s/.test(c)) space = true;
      else if (c === ";" && blocks === 0) {
        if (current.trim() !== "") out.push(current.trim());
        current = "";
        space = false;
      } else add(c);
    }
  }
  endWord();
  if (current.trim() !== "") out.push(current.trim());
  return out;
}

/** Text split at a character that stands outside brackets and quoted pieces: a list at its commas, a definition at its spaces. */
function splitTop(text: string, at = ","): string[] {
  const parts: string[] = [];
  let part = "";
  let depth = 0;
  for (const chunk of chunks(text)) {
    if (chunk.kind !== "code") {
      part += chunk.text;
      continue;
    }
    for (const c of chunk.text) {
      if (c === "(") depth++;
      else if (c === ")") depth--;
      if (depth === 0 && (at === " " ? /\s/.test(c) : c === at)) {
        parts.push(part.trim());
        part = "";
      } else part += c;
    }
  }
  parts.push(part.trim());
  return parts.filter((p) => p !== "");
}

/** The text inside the brackets that open where `text` starts, and what follows them. */
function enclosed(text: string): { readonly inside: string; readonly after: string } | null {
  if (!text.startsWith("(")) return null;
  let depth = 0;
  let at = 0;
  for (const chunk of chunks(text)) {
    if (chunk.kind === "code") {
      for (let i = 0; i < chunk.text.length; i++) {
        if (chunk.text[i] === "(") depth++;
        else if (chunk.text[i] === ")" && --depth === 0) return { inside: text.slice(1, at + i), after: text.slice(at + i + 1).trim() };
      }
    }
    at += chunk.text.length;
  }
  return null;
}

// ---------------------------------------------------------------- Names

/** A name, quoted or not, perhaps with its schema: users, "Users", public.users, `users`. */
const NAME = String.raw`(?:"(?:[^"]|"")+"|\x60[^\x60]+\x60|[\w$]+)(?:\s*\.\s*(?:"(?:[^"]|"")+"|\x60[^\x60]+\x60|[\w$]+))*`;

/** A name as a person reads it: without its quotes, and without the schema every table is in by default. */
export function nameOf(written: string): string {
  const parts = [...written.matchAll(/"((?:[^"]|"")+)"|`([^`]+)`|([\w$]+)/g)].map((m) => m[1]?.replace(/""/g, '"') ?? m[2] ?? m[3] ?? "");
  if (parts.length > 1 && /^(public|main)$/i.test(parts[0]!)) parts.shift();
  return parts.join(".");
}

/** A list of names as a person reads them: (user_id, created_at DESC). */
const columnsText = (inside: string) => `(${splitTop(inside).map((part) => part.replace(new RegExp(`^${NAME}`), nameOf)).join(", ")})`;

/** Words cut to a length a row holds. */
export function short(text: string, most = 120): string {
  return text.length <= most ? text : `${text.slice(0, most - 1).trimEnd()}…`;
}

// ---------------------------------------------------------------- Columns and constraints

/** The words after which a column definition stops saying its type. */
const COLUMN_WORD = /^(?:NOT|NULL|DEFAULT|PRIMARY|REFERENCES|UNIQUE|CHECK|CONSTRAINT|GENERATED|COLLATE|AUTOINCREMENT|ON|UNINDEXED)$/i;

/** A column as written in CREATE TABLE or ADD COLUMN: its name, its type and what is said about it. */
function columnOf(definition: string): { readonly name: string; readonly type: string; readonly tags: string[] } {
  const [name = "", ...words] = splitTop(definition, " ");
  const cut = words.findIndex((w) => COLUMN_WORD.test(w));
  const typeWords = cut === -1 ? words : words.slice(0, cut);
  const rest = cut === -1 ? [] : words.slice(cut);
  const said = rest.join(" ");
  const tags: string[] = [];
  if (/\bPRIMARY KEY\b/i.test(said)) tags.push("primary key");
  if (/\bNOT NULL\b/i.test(said)) tags.push("not null");
  if (/\bUNIQUE\b/i.test(said)) tags.push("unique");
  const fallback = rest.findIndex((w) => /^DEFAULT$/i.test(w));
  if (fallback !== -1) {
    const end = rest.findIndex((w, i) => i > fallback && COLUMN_WORD.test(w));
    tags.push(`default ${short(rest.slice(fallback + 1, end === -1 ? undefined : end).join(" "), 40)}`);
  }
  const references = new RegExp(`\\bREFERENCES (${NAME}) ?(\\([^)]*\\))?`, "i").exec(said);
  if (references) tags.push(`→ ${nameOf(references[1]!)}${references[2] ? columnsText(references[2].slice(1, -1)) : ""}`);
  const deleting = /\bON DELETE (CASCADE|SET NULL|SET DEFAULT|RESTRICT)/i.exec(said);
  if (deleting) tags.push(`on delete ${deleting[1]!.toLowerCase()}`);
  if (/\bGENERATED\b/i.test(said)) tags.push(/\bIDENTITY\b/i.test(said) ? "identity" : "generated");
  if (/\bAUTOINCREMENT\b/i.test(said)) tags.push("autoincrement");
  if (/\bCHECK\b/i.test(said)) tags.push("check");
  if (/\bUNINDEXED\b/i.test(said)) tags.push("unindexed");
  return { name: nameOf(name), type: typeWords.join(" ").toLowerCase(), tags };
}

/** A table constraint as written in CREATE TABLE or ADD CONSTRAINT: its name, if it has one, and what it holds. */
function constraintOf(written: string): { readonly name: string; readonly detail: string; readonly tags: string[] } {
  const named = new RegExp(`^CONSTRAINT (${NAME}) (.*)$`, "is").exec(written);
  const body = named?.[2] ?? written;
  const name = named ? nameOf(named[1]!) : "";
  const tags = /\bNOT VALID\b/i.test(body) ? ["not valid"] : [];
  const foreign = new RegExp(`^FOREIGN KEY ?\\(([^)]*)\\) ?REFERENCES (${NAME}) ?(\\([^)]*\\))?(.*)$`, "is").exec(body);
  if (foreign) {
    const deleting = /\bON DELETE (CASCADE|SET NULL|SET DEFAULT|RESTRICT)/i.exec(foreign[4]!);
    if (deleting) tags.push(`on delete ${deleting[1]!.toLowerCase()}`);
    return { name, detail: `foreign key ${columnsText(foreign[1]!)} → ${nameOf(foreign[2]!)}${foreign[3] ? columnsText(foreign[3].slice(1, -1)) : ""}`, tags };
  }
  const keyed = /^(PRIMARY KEY|UNIQUE) ?\(([^)]*)\)/i.exec(body);
  if (keyed) return { name, detail: `${keyed[1]!.toLowerCase()} ${columnsText(keyed[2]!)}`, tags };
  return { name, detail: short(body.replace(/ NOT VALID\b/i, ""), 100), tags };
}

const isConstraint = (part: string) => /^(?:CONSTRAINT|PRIMARY KEY|UNIQUE|FOREIGN KEY|CHECK|EXCLUDE)\b/i.test(part);

// ---------------------------------------------------------------- The diff

interface TableDraft {
  name: string;
  mark: Mark;
  from?: string;
  rebuilt?: true;
  module?: string;
  conditional?: true;
  rows: Row[];
}

/** Builds the diff one statement at a time, so a later statement can fold into an earlier one, such as a column added and then made not null. */
class Builder {
  private readonly tables = new Map<string, TableDraft>();
  private readonly objects: ObjectDiff[] = [];
  /** Inside a DO block: what is read there happens only where its check passes. */
  conditional = false;

  private tagged<T extends { readonly tags: readonly string[] }>(item: T): T {
    return this.conditional ? { ...item, tags: [...item.tags, "conditional"] } : item;
  }

  table(name: string): TableDraft {
    let table = this.tables.get(name.toLowerCase());
    if (!table) {
      table = { name, mark: "changed", rows: [] };
      this.tables.set(name.toLowerCase(), table);
    }
    return table;
  }

  /** A table made here. One dropped earlier in the same migration is replaced. */
  create(name: string, module?: string): TableDraft {
    const table = this.table(name);
    table.mark = table.mark === "dropped" ? "replaced" : "added";
    table.rows = [];
    if (module) table.module = module;
    if (this.conditional) table.conditional = true;
    return table;
  }

  drop(name: string): void {
    const table = this.table(name);
    table.mark = "dropped";
    table.rows = [];
    if (this.conditional) table.conditional = true;
  }

  rename(from: string, to: string): void {
    // A table keeps its schema when renamed: ALTER TABLE audit.events RENAME TO history is audit.history.
    const schema = from.includes(".") && !to.includes(".") ? from.slice(0, from.lastIndexOf(".") + 1) : "";
    const name = schema + to;
    const old = this.tables.get(from.toLowerCase());
    const replaced = this.tables.get(name.toLowerCase());
    this.tables.delete(from.toLowerCase());
    // SQLite changes a column by building a new table, copying the rows over, dropping the old one and renaming the new one to its name.
    if (old?.mark === "added" && replaced?.mark === "dropped") {
      const rows = old.rows.map((row) => (row.kind === "column" ? { ...row, mark: "kept" as Mark } : row)).filter((row) => row.kind !== "data");
      this.tables.set(name.toLowerCase(), { name, mark: "changed", rebuilt: true, rows });
      return;
    }
    this.tables.set(name.toLowerCase(), old?.mark === "added" ? { ...old, name } : { name, mark: "renamed", from: old?.from ?? from, rows: old?.rows ?? [] });
  }

  row(table: string, row: Row): void {
    const draft = this.table(table);
    // A column added, backfilled and made not null in one migration reads as the column added not null.
    if (row.kind === "column" && row.mark === "changed") {
      const index = draft.rows.findIndex((r) => r.kind === "column" && r.mark === "added" && r.name.toLowerCase() === row.name.toLowerCase());
      const added = draft.rows[index];
      if (added) {
        draft.rows[index] = { ...added, detail: row.detail.startsWith("→ ") ? row.detail.slice(2) : added.detail, tags: withChange(added.tags, row.tags) };
        return;
      }
    }
    draft.rows.push(this.tagged(row));
  }

  object(diff: ObjectDiff): void {
    this.objects.push(this.tagged(diff));
  }

  /** The table an index of this name was made on here, which a drop then finds. */
  indexTable(name: string): string | null {
    for (const table of this.tables.values()) if (table.rows.some((row) => row.kind === "index" && row.name.toLowerCase() === name.toLowerCase())) return table.name;
    return null;
  }

  /** The diff, what was dropped first, then what is new, then what changed; inside a table, its dropped rows first. */
  done(): Diff {
    const tables = [...this.tables.values()].map((table): TableDiff => ({ ...table, rows: [...table.rows].sort((a, b) => ORDER[a.mark] - ORDER[b.mark]) }));
    return { tables: tables.sort((a, b) => ORDER[a.mark] - ORDER[b.mark]), objects: [...this.objects].sort((a, b) => ORDER[a.mark] - ORDER[b.mark]) };
  }
}

/** Where each mark stands in a list: what is gone first, since it can't be undone. A row keeps its place among its own mark. */
const ORDER: Record<Mark, number> = { dropped: 0, added: 1, replaced: 1, changed: 2, renamed: 2, kept: 2 };

/** A column's tags after a change to it: "not null" is added, "drop not null" takes it away, a new default replaces the old. */
function withChange(tags: readonly string[], change: readonly string[]): string[] {
  let out = [...tags];
  for (const tag of change) {
    const dropped = /^drop (.*)$/.exec(tag)?.[1];
    if (dropped) out = out.filter((t) => !t.startsWith(dropped));
    else if (tag.startsWith("default ")) out = [...out.filter((t) => !t.startsWith("default ")), tag];
    else if (!out.includes(tag)) out.push(tag);
  }
  return out;
}

/** The diff a migration's SQL makes, in the order its statements come. */
export function diffOf(sql: string): Diff {
  const builder = new Builder();
  for (const statement of statements(sql)) read(statement, builder);
  return builder.done();
}

/** Whether a file is SQL the reader reads. Any other file, such as a schema in code, is kept and shown as written. */
export const isSql = (path: string) => /\.sql$/i.test(path);

/** The diff several files make, read one after the other as a single migration. */
export function diffOfFiles(files: readonly { readonly path: string; readonly sql: string }[]): Diff {
  return diffOf(files.filter((file) => isSql(file.path)).map((file) => file.sql).join(";\n"));
}

/** Statements that set up a session or a transaction, and change no object. */
const SETUP = /^(?:BEGIN|COMMIT|END|ROLLBACK|START TRANSACTION|SAVEPOINT|RELEASE|SET|RESET|PRAGMA|SELECT (?:pg_catalog\.)?set_config)\b/i;

/** The objects the one reader of CREATE, ALTER and DROP knows, longest first. */
const KINDS = "MATERIALIZED VIEW|EVENT TRIGGER|VIEW|FUNCTION|PROCEDURE|AGGREGATE|TYPE|DOMAIN|EXTENSION|SCHEMA|SEQUENCE|INDEX|TRIGGER|ROLE|PUBLICATION|SUBSCRIPTION|COLLATION|STATISTICS|RULE";

function read(s: string, out: Builder): void {
  if (SETUP.test(s)) return;
  let m: RegExpExecArray | null;

  if (/^DO\b/i.test(s)) return doBlock(s, out);

  if ((m = new RegExp(`^CREATE (?:(?:GLOBAL|LOCAL) )?(?:TEMP |TEMPORARY |UNLOGGED )?TABLE (?:IF NOT EXISTS )?(${NAME}) ?(.*)$`, "is").exec(s))) {
    const table = out.create(nameOf(m[1]!));
    for (const part of splitTop(enclosed(m[2]!)?.inside ?? "")) {
      if (isConstraint(part)) table.rows.push({ mark: "added", kind: "constraint", ...constraintOf(part) });
      else {
        const column = columnOf(part);
        table.rows.push({ mark: "added", kind: "column", name: column.name, detail: column.type, tags: column.tags });
      }
    }
    return;
  }

  // A SQLite virtual table, such as a full-text index: its columns, without the module's options.
  if ((m = new RegExp(`^CREATE VIRTUAL TABLE (?:IF NOT EXISTS )?(${NAME}) USING (\\w+) ?(.*)$`, "is").exec(s))) {
    const table = out.create(nameOf(m[1]!), m[2]!.toLowerCase());
    for (const part of splitTop(enclosed(m[3]!)?.inside ?? "")) {
      if (part.includes("=")) continue;
      const column = columnOf(part);
      table.rows.push({ mark: "added", kind: "column", name: column.name, detail: column.type, tags: column.tags });
    }
    return;
  }

  if ((m = new RegExp(`^ALTER TABLE (?:IF EXISTS )?(?:ONLY )?(${NAME}) (.*)$`, "is").exec(s))) {
    const table = nameOf(m[1]!);
    for (const action of splitTop(m[2]!)) alterTable(table, action, out);
    return;
  }

  if ((m = /^DROP TABLE (?:IF EXISTS )?(.*?)(?: CASCADE| RESTRICT)?$/is.exec(s))) {
    for (const name of splitTop(m[1]!)) out.drop(nameOf(name));
    return;
  }

  if ((m = new RegExp(`^CREATE (UNIQUE )?INDEX (CONCURRENTLY )?(?:IF NOT EXISTS )?(?:(${NAME}) )?ON (?:ONLY )?(${NAME}) ?(?:USING (\\w+) ?)?(.*)$`, "is").exec(s))) {
    const [, unique, concurrently, name, table, method, rest] = m;
    const columns = enclosed(rest!);
    const after = columns?.after ?? rest!;
    const where = /\bWHERE (.*)$/is.exec(after)?.[1];
    const include = /\bINCLUDE ?\(([^)]*)\)/i.exec(after)?.[1];
    const tags = [unique ? "unique" : "", concurrently ? "concurrently" : "", method && !/^btree$/i.test(method) ? method.toLowerCase() : "", include ? `include ${columnsText(include)}` : "", where ? `where ${short(where, 80)}` : ""].filter(Boolean);
    out.row(nameOf(table!), { mark: "added", kind: "index", name: name ? nameOf(name) : "", detail: columns ? columnsText(columns.inside) : "", tags });
    return;
  }

  if ((m = new RegExp(`^CREATE (?:OR REPLACE )?(?:CONSTRAINT )?(?:TEMP |TEMPORARY )?TRIGGER (?:IF NOT EXISTS )?(${NAME}) (BEFORE|AFTER|INSTEAD OF) (.*?) ON (${NAME})(.*)$`, "is").exec(s))) {
    const [, name, when, events, table, rest] = m;
    const runs = /\bEXECUTE (?:FUNCTION|PROCEDURE) ([\w.$"]+)/i.exec(rest!)?.[1];
    out.row(nameOf(table!), { mark: "added", kind: "trigger", name: nameOf(name!), detail: `${when!.toLowerCase()} ${events!.toLowerCase()}${runs ? ` → ${nameOf(runs)}()` : ""}`, tags: [] });
    return;
  }

  if ((m = new RegExp(`^DROP TRIGGER (?:IF EXISTS )?(${NAME}) ON (${NAME})`, "is").exec(s))) {
    out.row(nameOf(m[2]!), { mark: "dropped", kind: "trigger", name: nameOf(m[1]!), detail: "", tags: [] });
    return;
  }

  if ((m = new RegExp(`^(CREATE|ALTER|DROP) POLICY (?:IF EXISTS )?(${NAME}) ON (${NAME}) ?(.*)$`, "is").exec(s))) {
    const [, verb, name, table, rest] = m;
    const command = /\bFOR (ALL|SELECT|INSERT|UPDATE|DELETE)\b/i.exec(rest!)?.[1];
    const roles = /\bTO (.*?)(?= USING\b| WITH CHECK\b|$)/i.exec(rest!)?.[1];
    const detail = [command ? `for ${command.toLowerCase()}` : "", roles ? `to ${roles}` : ""].filter(Boolean).join(" ");
    out.row(nameOf(table!), { mark: MARK_OF[verb!.toUpperCase()]!, kind: "policy", name: nameOf(name!), detail, tags: [] });
    return;
  }

  // Data: what a backfill or a seed does, in short as written.
  if ((m = new RegExp(`^(?:WITH .*?\\) ?)?(?:INSERT (?:OR \\w+ )?INTO|UPDATE(?: ONLY)?|DELETE FROM(?: ONLY)?|TRUNCATE(?: TABLE)?(?: ONLY)?) (${NAME})`, "is").exec(s))) {
    // Under its table's head, a statement says what it does without saying the table again.
    out.row(nameOf(m[1]!), { mark: "changed", kind: "data", name: "", detail: short(tidy(s.replace(new RegExp(`^(?:INSERT (?:OR \\w+ )?INTO|UPDATE(?: ONLY)?|DELETE FROM(?: ONLY)?|TRUNCATE(?: TABLE)?(?: ONLY)?) ${NAME} ?`, "i"), (head) => (/^(?:DELETE|TRUNCATE)/i.test(head) ? head.split(" ")[0]! + " " : ""))), 140), tags: [] });
    return;
  }

  // Every other object, made, changed or dropped: a function, a view, a type, an extension.
  if ((m = new RegExp(`^(CREATE|ALTER|DROP) (OR REPLACE )?(?:TEMP |TEMPORARY )?(${KINDS}) (?:CONCURRENTLY )?(?:IF (?:NOT )?EXISTS )?(${NAME})(.*)$`, "is").exec(s))) {
    const verb = m[1]!.toUpperCase();
    const [, , replaces, written, name, rest] = m;
    const kind = written!.toLowerCase();
    if (verb === "DROP") {
      for (const part of splitTop(`${name}${rest}`.replace(/ (?:CASCADE|RESTRICT)$/i, ""))) {
        const dropped = nameOf(part.replace(/ ?\(.*$/s, ""));
        const table = kind === "index" ? out.indexTable(dropped) : null;
        if (table) out.row(table, { mark: "dropped", kind: "index", name: dropped, detail: "", tags: [] });
        else out.object({ mark: "dropped", kind, name: dropped, detail: "", tags: [] });
      }
      return;
    }
    // What follows the name, up to a body: a function's arguments and what it returns, a type's values, what an ALTER does.
    const said = tidy(beforeBody(rest!));
    const language = /\blanguage '?(\w+)'?/i.exec(said)?.[1];
    out.object({ mark: replaces ? "replaced" : MARK_OF[verb]!, kind, name: nameOf(name!), detail: short(said.replace(/ ?\blanguage '?\w+'?/i, ""), 120), tags: [replaces ? "or replace" : "", language?.toLowerCase() ?? ""].filter(Boolean) });
    return;
  }

  out.object({ mark: "changed", kind: "statement", name: "", detail: short(s, 140), tags: [] });
}

const MARK_OF: Readonly<Record<string, Mark>> = { CREATE: "added", ALTER: "changed", DROP: "dropped" };

/** What a statement says before its body: the code up to the first $tag$ string, without the AS that opens it. */
function beforeBody(text: string): string {
  let out = "";
  for (const chunk of chunks(text)) {
    if (chunk.kind === "quoted" && chunk.text.startsWith("$")) break;
    out += chunk.text;
  }
  return out.replace(/ AS ?$/i, "").trim();
}

/**
 * A statement in short as a row says it: its keywords lower case, IF NOT EXISTS gone, and RETURNS as an arrow. Names
 * and quoted strings stay as written.
 */
function tidy(text: string): string {
  return chunks(text)
    .map((chunk) => (chunk.kind === "code" ? chunk.text.replace(/\b[A-Z][A-Z_]+\b/g, (word) => word.toLowerCase()) : chunk.text))
    .join("")
    .replace(/\bif not exists /gi, "")
    .replace(/\breturns (setof )?/gi, "→ $1")
    .trim();
}

/**
 * A DO block. One that only guards plain statements, such as adding a column where it is missing, is read as those
 * statements, each marked conditional. One that builds its SQL as it runs, with EXECUTE, can't be read, so it is a row of its own.
 */
function doBlock(s: string, out: Builder): void {
  const body = /\$((?:[A-Za-z_]\w*)?)\$(.*)\$\1\$/s.exec(s)?.[2] ?? "";
  // Each statement of the body, without the IF … THEN, BEGIN and END around it.
  const inner = statements(body)
    .map((statement) => {
      let rest = statement;
      for (let before = ""; before !== rest; ) {
        before = rest;
        rest = rest.replace(/^(?:DECLARE\b.*?\bBEGIN|BEGIN|ELSE|END(?: IF| LOOP)?|EXCEPTION|LOOP)\b ?/i, "").replace(/^(?:IF|ELSIF|WHEN)\b.*?\bTHEN\b ?/is, "");
      }
      return rest;
    })
    .filter((statement) => /^(?:CREATE|ALTER|DROP|INSERT|UPDATE|DELETE|TRUNCATE|COMMENT|GRANT|REVOKE)\b/i.test(statement));
  if (/\bEXECUTE\b/i.test(body) || inner.length === 0) {
    out.object({ mark: "changed", kind: "DO block", name: "", detail: short(body.replace(/\s+/g, " ").trim(), 140), tags: [] });
    return;
  }
  out.conditional = true;
  for (const statement of inner) read(statement, out);
  out.conditional = false;
}

function alterTable(table: string, action: string, out: Builder): void {
  let m: RegExpExecArray | null;
  if ((m = /^ADD (?:COLUMN )?(?:IF NOT EXISTS )?(.*)$/is.exec(action)) && !isConstraint(m[1]!)) {
    const column = columnOf(m[1]!);
    return out.row(table, { mark: "added", kind: "column", name: column.name, detail: column.type, tags: column.tags });
  }
  if ((m = /^ADD (.*)$/is.exec(action))) return out.row(table, { mark: "added", kind: "constraint", ...constraintOf(m[1]!) });
  if ((m = new RegExp(`^DROP CONSTRAINT (?:IF EXISTS )?(${NAME})`, "is").exec(action))) return out.row(table, { mark: "dropped", kind: "constraint", name: nameOf(m[1]!), detail: "", tags: [] });
  if ((m = new RegExp(`^DROP (?:COLUMN )?(?:IF EXISTS )?(${NAME})`, "is").exec(action))) return out.row(table, { mark: "dropped", kind: "column", name: nameOf(m[1]!), detail: "", tags: [] });
  if ((m = new RegExp(`^VALIDATE CONSTRAINT (${NAME})`, "is").exec(action))) return out.row(table, { mark: "changed", kind: "constraint", name: nameOf(m[1]!), detail: "validate", tags: [] });
  if ((m = new RegExp(`^RENAME TO (${NAME})`, "is").exec(action))) return out.rename(table, nameOf(m[1]!));
  if ((m = new RegExp(`^RENAME CONSTRAINT (${NAME}) TO (${NAME})`, "is").exec(action))) return out.row(table, { mark: "renamed", kind: "constraint", name: nameOf(m[2]!), detail: "", tags: [], from: nameOf(m[1]!) });
  if ((m = new RegExp(`^RENAME (?:COLUMN )?(${NAME}) TO (${NAME})`, "is").exec(action))) return out.row(table, { mark: "renamed", kind: "column", name: nameOf(m[2]!), detail: "", tags: [], from: nameOf(m[1]!) });
  if ((m = new RegExp(`^ALTER (?:COLUMN )?(${NAME}) (.*)$`, "is").exec(action))) {
    const column = nameOf(m[1]!);
    const change = m[2]!;
    const type = /^(?:SET DATA )?TYPE (.*?)(?: (?:USING|COLLATE)\b.*)?$/is.exec(change)?.[1];
    const fallback = /^SET DEFAULT (.*)$/is.exec(change)?.[1];
    const tags = type ? [] : fallback !== undefined ? [`default ${short(fallback, 40)}`] : [/^(?:SET|DROP) NOT NULL$|^DROP DEFAULT$/i.test(change) ? change.toLowerCase().replace(/^set /, "") : short(change, 60)];
    return out.row(table, { mark: "changed", kind: "column", name: column, detail: type ? `→ ${type.toLowerCase()}` : "", tags });
  }
  if (/ROW LEVEL SECURITY$/i.test(action)) return out.row(table, { mark: "changed", kind: "security", name: "", detail: action.toLowerCase(), tags: [] });
  out.row(table, { mark: "changed", kind: "other", name: "", detail: short(action, 100), tags: [] });
}

// ---------------------------------------------------------------- In a line

/** One part of a diff's headline, and the tone it is shown in: what was dropped is the one thing that can't be undone. */
export interface HeadlinePart {
  readonly tone: "dropped" | "added" | "changed";
  readonly text: string;
}

/** The rows said as a change of their own, whatever their mark. */
const ROW_CHANGE: Partial<Record<RowKind, string>> = { data: "data change", security: "security change", other: "table change" };

const plural = (n: number, word: string) => `${n} ${n === 1 ? word : /(?:x|ch|sh|s)$/.test(word) ? `${word}es` : /[^aeiou]y$/.test(word) ? `${word.slice(0, -1)}ies` : `${word}s`}`;

/**
 * What a diff does, counted, what was dropped first: "1 table dropped", "1 new table", "2 columns added", "1 data
 * change". The card's line under why, and what `progress change` says it read. Empty when the diff is.
 */
export function headline(diff: Diff): HeadlinePart[] {
  const counts = new Map<string, { tone: HeadlinePart["tone"]; n: number; order: number }>();
  const count = (tone: HeadlinePart["tone"], key: string) => {
    const known = counts.get(key);
    counts.set(key, { tone, n: (known?.n ?? 0) + 1, order: known?.order ?? counts.size });
  };
  const tone = (mark: Mark): HeadlinePart["tone"] => (mark === "dropped" ? "dropped" : mark === "added" ? "added" : "changed");
  for (const table of diff.tables) {
    if (table.mark === "dropped") count("dropped", "table|dropped");
    else if (table.mark === "added") count("added", "new table");
    // A table dropped and made again lost its rows, so it is said with what was dropped.
    else if (table.mark === "replaced") count("dropped", "table|replaced");
    else if (table.rebuilt) count("changed", "table|rebuilt");
    else if (table.mark === "renamed") count("changed", "table|renamed");
    for (const row of table.rows) {
      // A new table's columns and constraints are the table itself. Its indexes, triggers and policies are said apart.
      if (row.mark === "kept" || ((table.mark === "added" || table.mark === "replaced") && (row.kind === "column" || row.kind === "constraint"))) continue;
      const change = ROW_CHANGE[row.kind];
      if (change) count(row.kind === "data" ? "changed" : tone(row.mark), `${change}|`);
      else count(tone(row.mark), `${row.kind}|${row.mark === "renamed" ? "changed" : row.mark}`);
    }
  }
  for (const object of diff.objects) count(tone(object.mark), object.kind === "statement" || object.kind === "DO block" ? `${object.kind}|` : `${object.kind}|${object.mark}`);
  const TONES = { dropped: 0, added: 1, changed: 2 };
  return [...counts]
    .sort(([, a], [, b]) => TONES[a.tone] - TONES[b.tone] || a.order - b.order)
    .map(([key, { tone, n }]) => {
      const [word = key, mark = ""] = key.split("|");
      return { tone, text: `${plural(n, word)}${mark ? ` ${mark}` : ""}` };
    });
}
