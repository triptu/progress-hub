# progress

One Markdown page per task that agents work on, and a hub in the browser that shows all of them. It is one Bun program, `progress`: the commands agents run, and the hub's server with the React app it serves. In the code and the commands a task is called a work.

## Where things are written down

- **What it is, for people:** `README.md`. It is the product page: what the hub does, with pictures, and one prompt to get started. Setup steps and code facts do not go there.
- **Setting it up on a machine:** `PROMPT.md`, which a person's agent follows, and `setup.sh`.
- **The page format:** `FORMAT.md`. Agents depend on it, and `progress format` prints it, so it ships inside the program.
- **How it works, as a picture:** `docs/how-it-works.html`, with flows to walk through.
- **The commands:** `progress --help`, from `src/main.ts`.

## How the code is shaped

- **`src/core/`** reads a page into sections and items (`parse.ts`), works out what changed between two reads of it (`journal.ts`), and holds the types.
- **`src/sources/`** is how agents are read. `AgentSource` in `source.ts` is the one interface: which session a command runs in, what the harness knows about a list of sessions, and the link that opens one. T3 Code is the one adapter (`src/t3/`), found when the hub starts on a machine T3 has run on. Another harness is one adapter file and a line in `index.ts`. A work lists its sessions as `<harness>:<id>` in `.sessions`, so one work can have agents from several harnesses. The page format knows nothing about any of them.
- **`src/stores/`** is where works are kept. `WorkStore` in `store.ts` is the one interface: the store's state, one work's page, its media, and a file. `DiskStore` (`disk/`) is the default, a folder on this machine. Another machine's hub is a second store (`remote.ts`). A store answers with finished state: pages already rendered, with what needs the user, the plan and the feed worked out. Stores are put together in `src/main.ts`. The user's viewed marks and todos are two files the hub keeps in the progress home (`marks.ts`, `todos.ts`).
- **`src/server/serve.ts`** serves the app and the stores' answers. It knows only the store interface.
- **`src/web/`** is the app. Each view's styles are in a CSS Module beside it, and three rules keep two views from clashing:
  - A class is a name owned by one view.
  - A value is an attribute: a phase, a weight, a size or a status is `data-phase`, `data-weight` and so on, and a state the element already says for assistive tools is read from there (`aria-current`, `aria-pressed`).
  - A name is shared only when `src/web/css/` styles it. A module names a shared class as `:global(.btn)`, tied to one of its own classes.

  `test/css.test.ts` holds these rules. Run `bun run css-types` after a module's classes change.
- **Other machines.** Each machine runs its own hub. A hub also reads the hubs of the machines a harness is linked to, and of those named in `PROGRESS_PEERS`, and shows their works beside its own (`src/stores/remote.ts`).

## Commands

```bash
bun install
bun run dev      # the hub on your own pages, reloading as you edit
bun run demo     # the hub on the sample pages in test/pages, as it looks after a week of use
bun run check    # types
bun test
bun run build    # the one program, in dist/
```

## Rules

- Nothing about one person's machine goes in this folder: no names, paths or hosts. `setup.sh` works for anyone.
- Tests go through what a person or an agent uses: a command, a page on disk, the hub's answers. A new test fails without the change it covers.
- README pictures come from `bun run demo`, never from real pages, and are retaken when a screen changes.
- Writing, in docs and in the app: plain words, short sentences, one fact each.

AGENTS.md is a symlink to this file. Edit CLAUDE.md only.
