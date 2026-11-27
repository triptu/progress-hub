# progress

One Markdown page per task that agents work on, and a hub in the browser that shows all of them. It is one Bun program, `progress`: the commands agents run, and the hub's server with the React app it serves. In the code and the commands a task is called a work.

## Where things are written down

- **What it is, for people:** `README.md`. It is the product page: what the hub does, with pictures, and one prompt to get started. Setup steps and code facts do not go there.
- **Setting it up on a machine:** `PROMPT.md`, which a person's agent follows, and `setup.sh`.
- **The page format:** `FORMAT.md`. Agents depend on it, and `progress format` prints it, so it ships inside the program.
- **How it works, as a picture:** `docs/how-it-works.html`, with flows to walk through.
- **The commands:** `progress --help`, from `src/main.ts`.
- **The launch site:** `site/`, one static page at https://progress-hub.tushar.ai. See "The site" below.

## How the code is shaped

- **`src/core/`** reads a page into sections and items (`parse.ts`), works out what changed between two reads of it (`journal.ts`), and holds the types. `names.ts` is the name a work has in an address: its own, without its machine, so a link reads as the work and opens on the central hub whichever machine holds it.
- **`src/sources/`** is how agents are read. `AgentSource` in `source.ts` is the one interface: which session a command runs in, what the harness knows about a list of sessions, and the link that opens one. T3 Code is the one adapter (`src/t3/`), found on a machine T3 has run on. Another harness is one adapter file and a line in `index.ts`. A work lists its sessions as `<harness>:<id>` in `.sessions`, so one work can have agents from several harnesses. The page format knows nothing about any of them.
- **`src/stores/`** is where works are kept. `WorkStore` in `store.ts` is the one interface: the store's state, one work's page, its media, and a file. `DiskStore` (`disk/`) is the default, a folder on this machine. On the central hub each machine that sends to it is a store. A store answers with finished state: pages already rendered, with what needs the user, the plan and the feed worked out. The user's viewed marks and todos are two files the hub keeps in the progress home (`marks.ts`, `todos.ts`).
- **`src/server/serve.ts`** serves the app and the stores' answers. It builds this machine's `DiskStore` and holds it in `Stores` (`store.ts`), which on the central hub joins every machine's store. Everything it serves goes through that. Its reads (the state, one work, the media and a file) are one function in `routes.ts`, which takes a `Request` and gives a `Response`, so another server answers them the same way.
- **`src/web/`** is the app. Each view's styles are in a CSS Module beside it, and three rules keep two views from clashing:
  - A class is a name owned by one view.
  - A value is an attribute: a phase, a weight, a size or a status is `data-phase`, `data-weight` and so on, and a state the element already says for assistive tools is read from there (`aria-current`, `aria-pressed`).
  - A name is shared only when `src/web/css/` styles it. A module names a shared class as `:global(.btn)`, tied to one of its own classes.

  `test/css.test.ts` holds these rules. Run `bun run css-types` after a module's classes change.
- **`src/central/`** is the central hub: one Cloudflare Worker (`worker.ts`) behind a Google sign-in (`login.ts`), and one Durable Object (`hub.ts`) that keeps what machines send and answers the reads with the same `Stores` and `routes.ts`. What a machine sends is a hello or its whole state, with a format number, and every limit on it is named in `protocol.ts`. `received.ts` checks a state before the hub keeps it, and names its works and addresses with the machine they came from. The hub knows what it holds: a state names its pages by hash and its files by digest, and the hub answers with what it lacks. A page an older hub kept without its readings shows them from the work's next reading or page edit. A machine's credential names its id (`login.ts`). A browser may change two things there, from the hub's own page: the marks (`POST /api/marks`) and the todos (`POST /api/todos`). The todos are the user's, so the Durable Object keeps the one list and changes it with the same `applyTodoChange` (`src/core/todos.ts`) a machine's `TodoStore` uses. A todo a machine sends with its state is taken into that list once: the hub remembers, per machine, the ids it took that the machine still sends, and names them in its answer, and the machine removes them from its own file, so that file holds only what the central hub has not taken yet. A machine's own marks file stays the one place its marks are kept: a mark changed on the central hub is an order for that machine, kept by the hub and shown over the marks the machine last sent, handed over in the answer to its next send, applied with `MarkStore.change`, and dropped once a state the hub shows says the machine applied it. If the user changes the same mark the other way on the machine's own hub before the machine has taken the order, the order still arrives and wins. A linked machine's `progress serve` sends with `send.ts`. Its own pages go on to the same page on the central hub while that hub takes its sends (`?local` keeps them), since the central hub is where a linked machine is read. `cloud/` deploys it with Alchemy and has its own `package.json`, so nobody else installs it; a deployment's keys live outside the checkout (`cloud/place.ts`) and Alchemy's state in the Cloudflare account. On `main` the repository's workflow deploys it (`.github/workflows/progress.yml`, with the keys and the token in the repository's secrets). The tests run the Worker's code with Cloudflare's parts kept in memory (`test/central.test.ts`).
- **Other machines.** Each machine runs its own hub, which shows that machine's works. The central hub shows every linked machine's works in one place.

## Commands

```bash
bun install
bun run dev      # the hub on your own pages, reloading as you edit
bun run demo     # the hub on the sample pages in test/pages, as it looks after a week of use
bun run check    # types
bun test
bun run build    # the one program, in dist/
```

## The site

`site/index.html` is the whole page: its styles, icons and script are inline, and `fonts/`, `img/`, the video and its posters sit beside it. A Vercel project with `site/` as its root serves it, and each push to main that changes `site/` deploys it (`site/vercel.json` skips the rest). Serve it locally with `python3 -m http.server 4792 -d site`.

- Its words say only what main does. Its pictures come from `bun run demo`, at 2×, with a light and a dark one for each.
- A replaced picture or video gets a new file name (`-v2`), or caches keep showing the old one.
- When the video changes, its posters (`poster-*.jpg`), the share image (`share-*.jpg`) and the README's poster (`docs/video-poster*.jpg`) are taken from the new video in the same change.
- Before merging, look at it at phone width and on a desktop, in light and dark, and check that nothing shifts on load or hover. A site change merges once those checks pass, without waiting for review.

## Rules

- Nothing about one person's machine goes in this folder: no names, paths or hosts. `setup.sh` works for anyone.
- Tests go through what a person or an agent uses: a command, a page on disk, the hub's answers. A new test fails without the change it covers.
- README pictures come from `bun run demo`, never from real pages, and are retaken when a screen changes.
- Writing, in docs and in the app: plain words, short sentences, one fact each.

AGENTS.md is a symlink to this file. Edit CLAUDE.md only.
