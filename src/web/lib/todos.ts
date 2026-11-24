import type { Todo, TodoChange, WorkId, WorkSummary } from "../../core/types.ts";
import { saidUnsaved } from "./marks.ts";
import { matches } from "./needs.ts";
import { refreshHub } from "./store.ts";

/**
 * Asks the hub, which keeps the list, to change it, and resolves to whether it did.
 * The screen follows once the hub's state says so. A change the hub did not take is said for a few seconds.
 */
export function changeTodos(change: TodoChange): Promise<boolean> {
  return fetch("/api/todos", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(change) })
    .then((response) => (response.ok ? refreshHub().then(() => true) : false))
    .catch(() => false)
    .then((saved) => {
      saidUnsaved(!saved);
      return saved;
    });
}

/** What a todo is about, as the list names it: its work while that work has a page, else its project. */
export function linkOf(todo: Todo, works: readonly WorkSummary[]): { readonly work: WorkSummary | null; readonly project: string | null } {
  const work = todo.work === null ? null : (works.find((known) => known.id === todo.work) ?? null);
  return { work, project: work?.project ?? todo.project };
}

/** The todos a screen lists: one work's on its tab, everything on Home, narrowed by the search. */
export function todosFor(todos: readonly Todo[], works: readonly WorkSummary[], scope: WorkId | null, query: string): readonly Todo[] {
  return todos.filter((todo) => {
    if (scope !== null && todo.work !== scope) return false;
    const { work, project } = linkOf(todo, works);
    return matches(query, todo.text, todo.description, work?.title ?? "", project);
  });
}
