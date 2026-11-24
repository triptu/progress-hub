import { instant } from "./journal.ts";
import type { Todo, TodoChange, WorkId } from "./types.ts";

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

/** A todo as a file or a request holds it, or null when it is anything else. One written before todos had descriptions has none. */
export const readTodo = (value: unknown): Todo | null => {
  if (typeof value !== "object" || value === null) return null;
  const todo = value as Record<string, unknown>;
  const text = (field: unknown) => typeof field === "string";
  // The list is ordered by when each was added, so a time must be one.
  const time = (field: unknown) => typeof field === "string" && !Number.isNaN(Date.parse(field));
  const whole = text(todo.id) && text(todo.text) && time(todo.addedAt) && (todo.work === null || text(todo.work)) && (todo.project === null || text(todo.project)) && (todo.doneAt === null || time(todo.doneAt));
  if (!whole) return null;
  const { id, addedAt, work, project, doneAt } = todo as unknown as Todo;
  return { id, text: todo.text as string, description: text(todo.description) ? (todo.description as string) : "", work, project, addedAt, doneAt };
};

/**
 * The list, newest first, after the change. The same list when nothing changed. A machine's own hub and the
 * central hub both change their list with this, each keeping it in its own place.
 */
export function applyTodoChange(list: readonly Todo[], change: TodoChange, now: Date): readonly Todo[] {
  if (change.op === "add") {
    // No two are added at the same instant, so when each was added is the list's whole order.
    const last = list.reduce((latest, todo) => Math.max(latest, Date.parse(todo.addedAt)), 0);
    const addedAt = instant(new Date(Math.max(now.getTime(), last + 1)));
    return [{ id: crypto.randomUUID(), text: change.text, description: change.description, work: change.work, project: change.project, addedAt, doneAt: null }, ...list];
  }
  if (change.op === "restore") {
    // Back where it was: the list is newest first by when each was added.
    if (list.some((todo) => todo.id === change.todo.id)) return list;
    return [...list, change.todo].sort((a, b) => (a.addedAt < b.addedAt ? 1 : -1));
  }
  const known = list.find((todo) => todo.id === change.id);
  if (!known) return list;
  if (change.op === "edit") {
    const { text, description, work, project } = change;
    if (known.text === text && known.description === description && known.work === work && known.project === project) return list;
    return list.map((todo) => (todo === known ? { ...todo, text, description, work, project } : todo));
  }
  if (change.op === "remove") return list.filter((todo) => todo !== known);
  if ((known.doneAt !== null) === change.on) return list;
  return list.map((todo) => (todo === known ? { ...todo, doneAt: change.on ? instant(now) : null } : todo));
}
