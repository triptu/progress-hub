import { ArrowCounterClockwiseIcon, CaretDownIcon, CaretRightIcon, CheckCircleIcon, CheckIcon, CircleIcon, LinkSimpleIcon, PencilSimpleIcon, PlusIcon, TextAlignLeftIcon, TrashIcon, XIcon } from "@phosphor-icons/react";
import { Fragment, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import type { FocusEvent, KeyboardEvent, MouseEvent } from "react";
import type { Todo, TodoChange, WorkId, WorkSummary } from "../../core/types.ts";
import { routeHref, TODOS_ANCHOR } from "../lib/route.ts";
import { changeTodos, linkOf } from "../lib/todos.ts";
import { exact } from "../lib/time.ts";
import { Avatar, Link } from "./parts.tsx";
import s from "./Todos.module.css";

interface TodosProps {
  /** The todos this screen lists, newest first. */
  readonly todos: readonly Todo[];
  /** Every work, for the names of what a todo is about and for the choice when adding one. */
  readonly works: readonly WorkSummary[];
  /** The open work. A todo added there is about it, and no row says which work it is from. */
  readonly scope: WorkId | null;
  readonly query: string;
}

/**
 * The user's own list of things to do later, which closes a Home screen. One line to add to it, a row each
 * with a circle to tick, and what is done folded away under the rest. A click on a row's words edits them in
 * place. A todo may have a description under its words, and may name the work or the project it is about.
 */
export function Todos(props: TodosProps) {
  const open = props.todos.filter((todo) => todo.doneAt === null);
  const done = props.todos.filter((todo) => todo.doneAt !== null).sort((a, b) => ((a.doneAt ?? "") < (b.doneAt ?? "") ? 1 : -1));
  // The todo last deleted, until something else is done to the list: it can be put back as it was.
  const [gone, setGone] = useState<Todo | null>(null);
  const change: Change = (asked) => {
    setGone(asked.op === "remove" ? (props.todos.find((todo) => todo.id === asked.id) ?? null) : null);
    return changeTodos(asked);
  };
  const row = (todo: Todo) => <Row key={todo.id} todo={todo} works={props.works} scoped={props.scope !== null} change={change} />;
  const query = props.query.trim();
  return (
    <section className={s.list} id={TODOS_ANCHOR} aria-labelledby="todos-title">
      <h2 className={`sec-title ${s.listTitle}`} id="todos-title">
        Todos
        {open.length ? <span className="n">{open.length}</span> : null}
      </h2>
      <Add key={props.scope ?? ""} works={props.works} scope={props.scope} change={change} />
      {gone ? (
        <p className={s.gone} role="status">
          <span>Deleted “{gone.text}”.</span>
          <button type="button" className="btn" onClick={() => void change({ op: "restore", todo: gone })}>
            <ArrowCounterClockwiseIcon aria-hidden />
            Undo
          </button>
        </p>
      ) : null}
      {open.length ? <ul className={s.todos}>{open.map(row)}</ul> : query && props.todos.length === 0 ? <p className={s.none}>Nothing matches “{query}”.</p> : null}
      {done.length ? (
        // A search opens the fold, so a match among the done ones is on screen.
        <details className="fold" open={query !== "" || undefined}>
          <summary>
            <CaretRightIcon weight="bold" aria-hidden />
            <span className="when-closed">Show {done.length} done</span>
            <span className="when-open">Hide {done.length} done</span>
          </summary>
          <ul className={s.todos}>{done.map(row)}</ul>
        </details>
      ) : null}
    </section>
  );
}

/** Asks the hub to change the list, and resolves to whether it did. */
type Change = (change: TodoChange) => Promise<boolean>;

/** What a todo is about, as one value: nothing, `w:<work>` or `p:<project>`. */
const NONE = "";
const aboutOf = (todo: Todo): string => (todo.work ? `w:${todo.work}` : todo.project ? `p:${todo.project}` : NONE);
const linkFrom = (about: string): { work: WorkId | null; project: string | null } => ({ work: about.startsWith("w:") ? (about.slice(2) as WorkId) : null, project: about.startsWith("p:") ? about.slice(2) : null });

interface Choice {
  readonly value: string;
  readonly label: string;
  /** The heading over this kind of choice. */
  readonly group: string | null;
  /** The project whose face the choice wears, or null for the choice of nothing. */
  readonly project: string | null;
  readonly fallback: string;
}

function choicesOf(works: readonly WorkSummary[]): readonly Choice[] {
  const ongoing = works.filter((work) => !work.settled);
  const projects = [...new Set(works.flatMap((work) => work.project ?? []))].sort();
  return [
    { value: NONE, label: "No link", group: null, project: null, fallback: "" },
    ...ongoing.map((work) => ({ value: `w:${work.id}`, label: work.title, group: "Work", project: work.project, fallback: work.id })),
    ...projects.map((project) => ({ value: `p:${project}`, label: project, group: "Project", project, fallback: project })),
  ];
}

/**
 * The menu of what a todo can be about. It opens from its button, or from the words being typed: an `@` or
 * a `/` that starts a word opens it on what follows, so a todo and its link are typed in one go.
 * Whatever opened it keeps the focus. Arrows move through it, Enter chooses, and Escape closes it.
 */
function usePicker(choices: readonly Choice[], value: string, onPick: (value: string) => void) {
  const [from, setFrom] = useState<"button" | "words" | null>(null);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const id = useId();
  // Typing narrows the menu to what holds the letters. Nothing is not a match for any.
  const wanted = query.trim().toLowerCase();
  const shown = from === "words" ? choices.filter((choice) => choice.value !== NONE && choice.label.toLowerCase().includes(wanted)) : choices;
  const open = from !== null && shown.length > 0 ? from : null;
  const at = Math.min(active, Math.max(0, shown.length - 1));

  // The choice the arrows are on is kept in view in a long menu.
  useEffect(() => {
    if (open) document.getElementById(`${id}-${at}`)?.scrollIntoView({ block: "nearest" });
  }, [open, at, id]);

  const close = () => setFrom(null);
  const choose = (choice: Choice | undefined) => {
    if (choice) onPick(choice.value);
    close();
  };
  return {
    id,
    open,
    shown,
    at,
    value,
    setActive,
    choose,
    close,
    fromButton() {
      setActive(Math.max(0, choices.findIndex((choice) => choice.value === value)));
      setFrom("button");
    },
    fromWords(typed: string) {
      if (from !== "words" || typed !== query) setActive(0);
      setQuery(typed);
      setFrom("words");
    },
    /** Handles a key while the menu is open, and says whether it did. */
    key(event: KeyboardEvent): boolean {
      if (!open) return false;
      const move = (to: number) => setActive(Math.max(0, Math.min(shown.length - 1, to)));
      if (event.key === "ArrowDown") move(at + 1);
      else if (event.key === "ArrowUp") move(at - 1);
      else if (event.key === "Enter" || event.key === "Tab") choose(shown[at]);
      else if (event.key === "Escape") {
        // Other things also close on Escape. This closes only the menu.
        event.stopPropagation();
        close();
      } else return false;
      event.preventDefault();
      return true;
    },
  };
}
type Picker = ReturnType<typeof usePicker>;

/** The tallest the menu gets, and the gap it keeps from the edge of the screen. */
const TALLEST = 320;
const EDGE = 8;

function PickerMenu(props: { readonly picker: Picker }) {
  const { picker } = props;
  const menu = useRef<HTMLUListElement>(null);
  // It opens under what it belongs to, or over it when there is more room there, and is never taller than that room.
  useLayoutEffect(() => {
    const list = menu.current;
    const room = list?.closest(".screen")?.getBoundingClientRect();
    const anchor = list?.parentElement?.getBoundingClientRect();
    if (!list || !room || !anchor) return;
    // A phone's keyboard covers the foot of the window.
    const foot = Math.min(room.bottom, window.visualViewport ? window.visualViewport.offsetTop + window.visualViewport.height : room.bottom);
    const below = foot - anchor.bottom - EDGE;
    const above = anchor.top - room.top - EDGE;
    const up = list.scrollHeight > below && above > below;
    list.dataset.side = up ? "up" : "down";
    list.style.maxHeight = `${Math.min(TALLEST, up ? above : below)}px`;
  }, [picker.open, picker.shown.length]);
  if (!picker.open) return null;
  return (
    <ul ref={menu} id={picker.id} role="listbox" aria-label="Link to" className={s.aboutMenu} data-from={picker.open}>
      {picker.shown.map((choice, index) => (
        <Fragment key={choice.value}>
          {choice.group && choice.group !== picker.shown[index - 1]?.group ? (
            <li role="presentation" className={s.aboutGroup}>
              {choice.group}
            </li>
          ) : null}
          <li
            id={`${picker.id}-${index}`}
            role="option"
            aria-selected={choice.value === picker.value}
            className={`${s.aboutChoice}${index === picker.at ? ` ${s.aboutActive}` : ""}`}
            // Whatever opened the menu keeps the focus, so the keys go on working after a click.
            onPointerDown={(event) => event.preventDefault()}
            onPointerMove={() => picker.setActive(index)}
            onClick={() => picker.choose(choice)}
          >
            {choice.value === NONE ? <LinkSimpleIcon aria-hidden /> : <Avatar project={choice.project} fallback={choice.fallback} size="xs" />}
            <span className={s.aboutLabel}>{choice.label}</span>
            {choice.value === picker.value ? <CheckIcon weight="bold" className={s.aboutTick} aria-hidden /> : null}
          </li>
        </Fragment>
      ))}
    </ul>
  );
}

/** The button that links a todo to a work or a project and says which, with the menu under it. */
function AboutButton(props: { readonly picker: Picker; readonly choices: readonly Choice[] }) {
  const { picker } = props;
  const chosen = props.choices.find((choice) => choice.value !== NONE && choice.value === picker.value);
  const open = picker.open === "button";
  return (
    <span className={s.about}>
      <button
        type="button"
        className={`${s.aboutBtn}${open ? ` ${s.aboutOpen}` : ""}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? picker.id : undefined}
        aria-activedescendant={open ? `${picker.id}-${picker.at}` : undefined}
        aria-label={chosen ? `Linked to ${chosen.label}` : "Link to a work or a project"}
        title="Link to a work or a project. Typing @ or / in the words does it too."
        onClick={() => (open ? picker.close() : picker.fromButton())}
        onBlur={() => (open ? picker.close() : undefined)}
        onKeyDown={(event) => {
          if (picker.key(event)) return;
          if (!open && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
            event.preventDefault();
            picker.fromButton();
          }
        }}
      >
        {chosen ? <Avatar project={chosen.project} fallback={chosen.fallback} size="xs" /> : <LinkSimpleIcon aria-hidden />}
        <span className={s.aboutLabel}>{chosen?.label ?? "Link"}</span>
        <CaretDownIcon weight="bold" className={s.aboutCaret} aria-hidden />
      </button>
      {open ? <PickerMenu picker={picker} /> : null}
    </span>
  );
}

interface Draft {
  readonly text: string;
  readonly description: string;
  readonly about: string;
}

/** An `@` or `/` that starts the word the caret is in, with what is typed after it. */
const MENTION = /(^|\s)[@/]([^\s@/]*)$/;

/**
 * The fields of one todo, used to add one and to edit one: its words, a description under them, and what
 * it is about. Enter saves. Shift+Enter in the words goes to the description, where Enter is a new line
 * and Cmd or Ctrl with Enter saves.
 */
function Fields(props: {
  readonly start: Draft;
  /** Editing shows the description from the start and saves on leaving. Adding keeps it folded until asked for. */
  readonly editing: boolean;
  readonly choices: readonly Choice[] | null;
  /** Resolves to whether the hub took it. */
  readonly onSave: (draft: Draft) => Promise<boolean>;
  /** Ends an edit. `byKeys` says the user ended it here, by a key or a button, so the focus should stay with the row. */
  readonly onClose?: (byKeys: boolean) => void;
  readonly onRemove?: (event: MouseEvent<HTMLButtonElement>) => void;
}) {
  const [text, setText] = useState(props.start.text);
  const [description, setDescription] = useState(props.start.description);
  const [about, setAbout] = useState(props.start.about);
  const [more, setMore] = useState(props.editing);
  const box = useRef<HTMLDivElement>(null);
  const words = useRef<HTMLTextAreaElement>(null);
  const notes = useRef<HTMLTextAreaElement>(null);
  /** Takes what was typed to ask for a link out of the words: the `@word` that ends at the caret. */
  const unmention = (typed: string, caret: number) => {
    const before = typed.slice(0, caret).replace(MENTION, "$1");
    setText(before + typed.slice(caret).replace(/^\s+/, before.endsWith(" ") || before === "" ? "" : " "));
    requestAnimationFrame(() => words.current?.setSelectionRange(before.length, before.length));
  };
  const picker = usePicker(props.choices ?? [], about, (value) => {
    setAbout(value);
    if (picker.open === "words") unmention(text, words.current?.selectionStart ?? text.length);
  });
  // Whether a pointer is held down, and whether the todo is being deleted: both change what leaving the fields does.
  const pressed = useRef(false);
  const leaving = useRef(false);
  useEffect(() => {
    if (!props.editing) return;
    const press = (event: PointerEvent) => void (pressed.current = event.type === "pointerdown");
    const kinds = ["pointerdown", "pointerup", "pointercancel"] as const;
    for (const kind of kinds) window.addEventListener(kind, press, true);
    return () => kinds.forEach((kind) => window.removeEventListener(kind, press, true));
  }, [props.editing]);

  // Each field is as tall as what it holds, where the browser doesn't size it itself.
  useLayoutEffect(() => {
    if (CSS.supports("field-sizing", "content")) return;
    for (const area of [words.current, notes.current]) {
      if (!area) continue;
      area.style.height = "auto";
      area.style.height = `${area.scrollHeight}px`;
    }
  }, [text, description, more]);
  // Editing starts at the end of the words, ready to add to them.
  useEffect(() => {
    if (!props.editing || !words.current) return;
    words.current.focus();
    words.current.setSelectionRange(words.current.value.length, words.current.value.length);
  }, [props.editing]);

  /** Sends an edit that changed something. Words left empty stay as they were. */
  const store = () => {
    const draft = { text: text.trim(), description: description.trim(), about };
    const same = draft.text === props.start.text && draft.description === props.start.description && draft.about === props.start.about;
    if (draft.text !== "" && !same) void props.onSave(draft);
  };
  const save = () => {
    if (props.editing) {
      store();
      return props.onClose?.(true);
    }
    const draft = { text: text.trim(), description: description.trim(), about };
    if (draft.text === "") return;
    // The line clears at once. If the hub did not take the todo, what was typed comes back to be sent again.
    void props.onSave(draft).then((saved) => {
      if (saved) return;
      setText((now) => now || draft.text);
      setDescription((now) => now || draft.description);
    });
    setText("");
    setDescription("");
    setMore(false);
    // The next one starts about nothing, so it is never filed under the last one's work by mistake.
    setAbout(props.start.about);
    words.current?.focus();
  };

  return (
    <div
      ref={box}
      className={s.fields}
      // Leaving a todo that is being edited saves it, as leaving a cell of a sheet does.
      onBlur={(event: FocusEvent) => {
        if (!props.editing || leaving.current || box.current?.contains(event.relatedTarget as Node | null)) return;
        store();
        // Closing moves what is under the fields. A click that took the focus away has not landed yet, so the fields stay until it has.
        const close = () => props.onClose?.(false);
        // A tap's click comes in the same turn as the press that took the focus.
        if (!pressed.current) return void setTimeout(close);
        const landed = () => {
          window.removeEventListener("pointerup", landed, true);
          window.removeEventListener("pointercancel", landed, true);
          setTimeout(close);
        };
        window.addEventListener("pointerup", landed, true);
        window.addEventListener("pointercancel", landed, true);
      }}
      onKeyDown={(event) => {
        // An open menu takes the key first, and closes alone.
        if (event.key === "Escape" && props.editing) props.onClose?.(true);
      }}
    >
      <div className={s.fieldsLine}>
        <span className={s.words}>
          {/* The words wrap as they do in the list, so a long todo is all there while it is edited. Enter saves, so they stay one paragraph. */}
          <textarea
            ref={words}
            rows={1}
            value={text}
            placeholder={props.editing ? "What to do" : "Add a todo"}
            aria-label={props.editing ? "The todo" : "Add a todo"}
            enterKeyHint="done"
            role={picker.open === "words" ? "combobox" : undefined}
            aria-expanded={picker.open === "words" ? true : undefined}
            aria-controls={picker.open === "words" ? picker.id : undefined}
            aria-activedescendant={picker.open === "words" ? `${picker.id}-${picker.at}` : undefined}
            onChange={(event) => {
              const typed = event.target.value.replace(/\n+/g, " ");
              const caret = event.target.selectionStart ?? typed.length;
              setText(typed);
              const asked = props.choices ? MENTION.exec(typed.slice(0, caret)) : null;
              if (asked) return picker.fromWords(asked[2] ?? "");
              // A space after a word that names one thing links it, so a todo and its link are typed straight through.
              const [only, ...others] = picker.open === "words" && typed[caret - 1] === " " && MENTION.exec(typed.slice(0, caret - 1))?.[2] ? picker.shown : [];
              if (only && others.length === 0) {
                setAbout(only.value);
                unmention(typed.slice(0, caret - 1) + typed.slice(caret), caret - 1);
              }
              picker.close();
            }}
            onBlur={() => (picker.open === "words" ? picker.close() : undefined)}
            onKeyDown={(event) => {
              if (picker.open === "words" && picker.key(event)) return;
              if (event.key === "Enter" && event.shiftKey) {
                event.preventDefault();
                // The description is there and has the focus before the next key lands, however fast it is typed.
                flushSync(() => setMore(true));
                notes.current?.focus();
              } else if (event.key === "Enter") {
                event.preventDefault();
                save();
              }
            }}
          />
          {picker.open === "words" ? <PickerMenu picker={picker} /> : null}
        </span>
        {props.editing ? null : (
          // Lit while there is a description, shown or folded away: it is saved either way.
          <button
            type="button"
            className={`icon-btn ${s.moreBtn}`}
            aria-expanded={more}
            data-state={description.trim() ? "filled" : undefined}
            aria-label="Description"
            title={more ? "Hide the description" : description.trim() ? "Show the description" : "Add a description (Shift+Enter)"}
            onClick={() => setMore(!more)}
          >
            <TextAlignLeftIcon aria-hidden />
          </button>
        )}
        {/* On the line that adds, what it is about is beside the words. In a row it goes under them, so the words keep the width they have in the list. */}
        {props.choices && !props.editing ? <AboutButton picker={picker} choices={props.choices} /> : null}
      </div>
      {more ? (
        <>
          <textarea
            ref={notes}
            className={s.notes}
            value={description}
            placeholder="Description"
            aria-label="Description"
            rows={props.editing ? 1 : 2}
            onChange={(event) => setDescription(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                event.preventDefault();
                save();
              }
            }}
          />
          <div className={s.fieldsFoot}>
            {props.onRemove ? (
              <button
                type="button"
                className={`icon-btn ${s.removeBtn}`}
                aria-label="Delete"
                title="Delete this todo"
                onClick={(event) => {
                  // What was typed is not saved on the way out.
                  leaving.current = true;
                  props.onRemove?.(event);
                  leaving.current = false;
                }}
              >
                <TrashIcon aria-hidden />
              </button>
            ) : null}
            {props.choices && props.editing ? <AboutButton picker={picker} choices={props.choices} /> : null}
            <button type="button" className={`btn ${s.saveBtn}`} onClick={save}>
              {props.editing ? "Save" : "Add"}
            </button>
          </div>
        </>
      ) : null}
    </div>
  );
}

function Add(props: { readonly works: readonly WorkSummary[]; readonly scope: WorkId | null; readonly change: Change }) {
  // On a work's tab a new todo is about that work. On Home it is about what is picked, or nothing.
  const choices = props.scope === null ? choicesOf(props.works) : null;
  const linked = choices !== null && choices.length > 1;
  const line = useRef<HTMLDivElement>(null);
  // N starts a new todo from anywhere on the screen.
  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => {
      const typing = event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement;
      if (event.key !== "n" || typing || event.metaKey || event.ctrlKey || event.altKey) return;
      event.preventDefault();
      line.current?.querySelector("textarea")?.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  return (
    <div ref={line} className={s.todoAdd} title="Add a todo (N)">
      <PlusIcon aria-hidden />
      <Fields
        start={{ text: "", description: "", about: props.scope === null ? NONE : `w:${props.scope}` }}
        editing={false}
        choices={linked ? choices : null}
        onSave={(draft) => props.change({ op: "add", text: draft.text, description: draft.description, ...linkFrom(draft.about) })}
      />
    </div>
  );
}

/**
 * Makes a change that takes the row out of its list. The focus moves to the row after it, else the one
 * before, else the line todos are added on, so the keyboard carries on from where it was.
 */
function leave(event: MouseEvent<HTMLButtonElement>, change: () => void): void {
  const row = event.currentTarget.closest("li");
  const beside = row?.nextElementSibling ?? row?.previousElementSibling;
  (beside?.querySelector<HTMLElement>(`.${s.todoCheck}`) ?? document.querySelector<HTMLElement>(`.${s.todoAdd} textarea`))?.focus();
  change();
}

/** Words with the web addresses in them as links. */
function Linked(props: { readonly text: string }) {
  return (
    <>
      {props.text.split(/(https?:\/\/[^\s]+[^\s.,;:!?)\]'"])/g).map((part, index) =>
        index % 2 ? (
          <a key={index} href={part} target="_blank" rel="noopener noreferrer">
            {part}
          </a>
        ) : (
          part
        ),
      )}
    </>
  );
}

function Row(props: { readonly todo: Todo; readonly works: readonly WorkSummary[]; readonly scoped: boolean; readonly change: Change }) {
  const { todo, change } = props;
  const [editing, setEditing] = useState(false);
  const row = useRef<HTMLLIElement>(null);
  const done = todo.doneAt !== null;
  const { work, project } = linkOf(todo, props.works);
  const face = <Avatar project={project} fallback={work?.id ?? project ?? ""} size="xs" />;
  return (
    <li ref={row} className={`${s.todo}${done ? ` ${s.done}` : ""}`}>
      <button type="button" className={s.todoCheck} aria-pressed={done} aria-label="Done" title={done ? "Done. Click to put it back on the list." : "Mark as done"} onClick={(event) => leave(event, () => void change({ op: "done", id: todo.id, on: !done }))}>
        {done ? <CheckCircleIcon weight="fill" aria-hidden /> : <CircleIcon aria-hidden />}
      </button>
      {editing ? (
        <Fields
          start={{ text: todo.text, description: todo.description, about: aboutOf(todo) }}
          editing
          choices={choicesOf(props.works)}
          onSave={(draft) => change({ op: "edit", id: todo.id, text: draft.text, description: draft.description, ...linkFrom(draft.about) })}
          onClose={(byKeys) => {
            flushSync(() => setEditing(false));
            if (byKeys) row.current?.querySelector<HTMLElement>(`.${s.todoEdit}`)?.focus();
          }}
          onRemove={(event) => leave(event, () => void change({ op: "remove", id: todo.id }))}
        />
      ) : (
        <>
          {/* A click on the words edits them, as in any list of this kind. A link in them still opens, and words can still be selected to copy. */}
          <div className={done ? undefined : s.todoOpen} onClick={(event) => (done || (event.target as HTMLElement).closest("a") || !window.getSelection()?.isCollapsed ? undefined : setEditing(true))}>
            <p className={`prose-inline ${s.todoText}`} title={done && todo.doneAt ? `Done ${exact(todo.doneAt)}` : `Added ${exact(todo.addedAt)}`}>
              <Linked text={todo.text} />
            </p>
            {todo.description ? (
              <p className={`prose-inline ${s.todoNote}`}>
                <Linked text={todo.description} />
              </p>
            ) : null}
            {props.scoped ? null : work ? (
              <Link href={routeHref({ work: work.id, focus: TODOS_ANCHOR })} className="tl-from">
                {face}
                {/* A todo often waits for its work to finish, so the row says when it has. */}
                <span>{work.settled ? `${work.title} · settled` : work.title}</span>
              </Link>
            ) : project ? (
              <span className="tl-from">
                {face}
                <span>{project}</span>
              </span>
            ) : null}
          </div>
          {done ? (
            <button type="button" className={`icon-btn ${s.todoRemove}`} aria-label="Remove" title="Remove from the list for good" onClick={(event) => leave(event, () => void change({ op: "remove", id: todo.id }))}>
              <XIcon aria-hidden />
            </button>
          ) : (
            <button type="button" className={`icon-btn ${s.todoEdit}`} aria-label="Edit" title="Edit" onClick={() => setEditing(true)}>
              <PencilSimpleIcon aria-hidden />
            </button>
          )}
        </>
      )}
    </li>
  );
}
