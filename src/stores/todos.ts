import { randomUUID } from "node:crypto";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { instant } from "../core/journal.ts";
import type { Todo, TodoChange, WorkId } from "../core/types.ts";

/** A change as it was sent, or null when it is anything else. */
export function readTodoChange(body: unknown): TodoChange | null {
  if (typeof body !== "object" || body === null) return null;
  const { op, text, description, work, project, id, on } = body as Record<string, unknown>;
  const name = (value: unknown) => (typeof value === "string" && value.trim() !== "" ? value.trim() : null);
  // A todo is its words, and may have more under them. The description may be left out, as the command line does.
  const said = typeof text === "string" && text.trim() !== "" && (description === undefined || typeof description === "string") ? { text: text.trim(), description: (description ?? "").trim(), work: name(work) as WorkId | null, project: name(project) } : null;
  if (op === "add" && said) return { op, ...said };
  if (op === "edit" && said && typeof id === "string") return { op, id, ...said };
  if (op === "done" && typeof id === "string" && typeof on === "boolean") return { op, id, on };
  if (op === "remove" && typeof id === "string") return { op, id };
  const back = op === "restore" ? readTodo((body as Record<string, unknown>).todo) : null;
  if (back) return { op: "restore", todo: back };
  return null;
}

/** A todo as the file holds it, or null when it is anything else. One written before todos had descriptions has none. */
const readTodo = (value: unknown): Todo | null => {
  if (typeof value !== "object" || value === null) return null;
  const todo = value as Record<string, unknown>;
  const text = (field: unknown) => typeof field === "string";
  const whole = text(todo.id) && text(todo.text) && text(todo.addedAt) && (todo.work === null || text(todo.work)) && (todo.project === null || text(todo.project)) && (todo.doneAt === null || text(todo.doneAt));
  if (!whole) return null;
  const { id, addedAt, work, project, doneAt } = todo as unknown as Todo;
  return { id, text: todo.text as string, description: text(todo.description) ? (todo.description as string) : "", work, project, addedAt, doneAt };
};

/**
 * The user's todos, kept in one file in the progress home so every browser shows the same list.
 * Like the marks, it is the hub's own file: no page is edited, and an agent adds a todo by asking the hub.
 */
export class TodoStore {
  private list: readonly Todo[] = [];

  private readonly file: string;

  constructor(file: string) {
    this.file = file;
    try {
      const stored: unknown = JSON.parse(readFileSync(file, "utf8"));
      if (Array.isArray(stored)) this.list = stored.flatMap((todo) => readTodo(todo) ?? []);
    } catch {
      // No file yet, or one this code didn't write. The list is empty.
    }
  }

  /** Newest first. */
  get(): readonly Todo[] {
    return this.list;
  }

  /**
   * Makes the change and says whether anything changed. The file is replaced whole, and the list in
   * memory changes only once the file holds it: a write that fails throws and leaves both as they were.
   */
  change(change: TodoChange, now = new Date()): boolean {
    const next = this.after(change, now);
    if (next === this.list) return false;
    const draft = `${this.file}.next`;
    writeFileSync(draft, `${JSON.stringify(next, null, 1)}\n`);
    renameSync(draft, this.file);
    this.list = next;
    return true;
  }

  private after(change: TodoChange, now: Date): readonly Todo[] {
    if (change.op === "add") {
      // No two are added at the same instant, so when each was added is the list's whole order.
      const last = this.list.reduce((latest, todo) => Math.max(latest, Date.parse(todo.addedAt)), 0);
      const addedAt = instant(new Date(Math.max(now.getTime(), last + 1)));
      return [{ id: randomUUID(), text: change.text, description: change.description, work: change.work, project: change.project, addedAt, doneAt: null }, ...this.list];
    }
    if (change.op === "restore") {
      // Back where it was: the list is newest first by when each was added.
      if (this.list.some((todo) => todo.id === change.todo.id)) return this.list;
      return [...this.list, change.todo].sort((a, b) => (a.addedAt < b.addedAt ? 1 : -1));
    }
    const known = this.list.find((todo) => todo.id === change.id);
    if (!known) return this.list;
    if (change.op === "edit") {
      const { text, description, work, project } = change;
      if (known.text === text && known.description === description && known.work === work && known.project === project) return this.list;
      return this.list.map((todo) => (todo === known ? { ...todo, text, description, work, project } : todo));
    }
    if (change.op === "remove") return this.list.filter((todo) => todo !== known);
    if ((known.doneAt !== null) === change.on) return this.list;
    return this.list.map((todo) => (todo === known ? { ...todo, doneAt: change.on ? instant(now) : null } : todo));
  }
}
