import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { applyTodoChange, readTodo } from "../core/todos.ts";
import type { Todo, TodoChange } from "../core/types.ts";

/**
 * The user's todos, kept in one file in the progress home so every browser shows the same list.
 * Like the marks, it is the hub's own file: no page is edited, and an agent adds a todo by asking the hub.
 * On a machine linked to a central hub, the file holds only the todos the central hub has not taken yet.
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
    return this.keep(applyTodoChange(this.list, change, now));
  }

  /** Lets go of the todos with these ids, which a central hub now keeps, in one write. Says whether any were here. */
  release(ids: readonly string[]): boolean {
    const gone = new Set(ids);
    return this.keep(this.list.some((todo) => gone.has(todo.id)) ? this.list.filter((todo) => !gone.has(todo.id)) : this.list);
  }

  private keep(next: readonly Todo[]): boolean {
    if (next === this.list) return false;
    const draft = `${this.file}.next`;
    writeFileSync(draft, `${JSON.stringify(next, null, 1)}\n`);
    renameSync(draft, this.file);
    this.list = next;
    return true;
  }
}
