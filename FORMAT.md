# Progress page format

Each piece of work keeps one folder in the progress home, with one Markdown file in it. `setup.sh` chooses the home on each machine (`~/progress` unless you set `PROGRESS_HOME`), and `progress new` prints the page's path. The hub draws that file as the work's page and builds the shared views (Needs you, the feed) from it.

```
<progress home>/<work>/
  progress.md        the page
  images/, mocks/…   anything the page links to
  .sessions          the agent sessions that work on this, one per line as `<harness>:<id>`, written by `progress new` and `progress join`
```

The page is a normal Markdown document. Write it the way the work needs: any sections, tables, images, links. The hub reads five headings as lists and draws everything else as written.

## The file

```markdown
---
title: TypeScript tooling cleanup
project: kestrel
---

Where this stands, in one or two sentences. Rewrite it when the answer changes.

## Goal

- Type checks run only through `bun check`.
- One version of each dependency.

## Needs you

### Sign in Claude 2
Why only you can do this, the exact steps, and what waits on it.

### Keep Tailwind 3 in a named catalog until desktop moves?
What the choice is, the options, your pick and what would change it.
![Before and after, real app, commit 3fa2c1d](images/tailwind.png)

## Decisions

- Strictness target is the backend's flags minus `noPropertyAccessFromIndexSignature`. You chose this: "drop it from the backend too".
- Chose one PR per flag group, so each diff stays reviewable. Flip it if you want.

## Shipped

- ! https://github.com/acme/kestrel/pull/412 Package builds went from 3.4 s to 2.2 s.
- https://github.com/acme/kestrel/commit/daa36b6 The lint config is one file.
- The Mac app is reinstalled from main.

## In progress

- Moving the desktop app to the new index.

## Next

- Rebuild the index when the schema changes.
- Measure search on a 100,000 note vault.

## Ideas

Anything else is freeform: Ideas, a table of measurements, a gallery of screens.
```

## What the hub reads

1. **Front matter.** `title` (else the first `#` heading, else the folder name), `project` and `status: done` when the work is finished. All optional. Each value is the rest of its line, as written.
2. **The summary.** The text between the front matter and the first heading. When it changes, its first sentence goes to the feed as the work's status.
3. **The goal.** A `## Goal` section: what this work is for, zoomed out, in a line or two or a few bullets. The hub shows it at the top of the work's page, on its other tabs and on Home, so the user gets the context before the detail. It is the user's goal in plain words, not a task list, and it changes only when the aim does. A summary paragraph that starts with `Goal:` counts too. `progress check` says when a page has none.
4. **Five sections**, found by their name as whole words at the start of a `#` or `##` heading, in any letter case: `Needs you`, `In progress` (or `In review`, `Doing`), `Next` (or `Up next`, `To do`, `Planned`), `Decisions` (or `Decision log`) and `Shipped`. So `Shipped today` is Shipped, and `Needs your eyes later` is a freeform section. In progress, Next and Shipped are the three states of the work, each with its own tab: move a line from one to the next as the work moves.
5. **Items** in those sections. Each `###` block is one item. With no `###` blocks, each top-level bullet is one item. Text above the first item is an introduction and is not an item. In Needs you, In progress and Next, a ticked box (`- [x]`) is done and is not an item.
6. **Needs you with no open items.** Its prose counts as one item, even beside ticked boxes, so a blocker written as a paragraph is not missed. Prose that ends in a colon introduces the list under it and is not an item. When nothing needs the user, leave the section empty or write "Nothing right now.".

7. **Important items.** An item whose title starts with `!` and a space is one the user should not miss: `- ! Sync no longer loses edits.` or `### ! Pick a region`. The hub shows it larger and starred in the feed and on the page, and the feed's Important switch keeps only these and what needs the user. The mark is not part of the title, and a line that swaps its bullet for the mark (`! text`) is read the same. Use it for the few things worth a skim; when every line has it, none stands out.

An item is known by its title, so changing the title makes it a new item with a new time.

Remove a Needs you item the moment it is settled, and write the outcome under Decisions. Add new Decisions and Shipped entries at the top.

A Shipped line with a pull request or commit link is shown with its title and state. Write the full link, not a bare `#number`.

Keep **Next** complete: everything the user asked for that is not started yet belongs there, in the order you will take it, so they can check that nothing they said was dropped. Keep **In progress** to what is being worked on now.

**Try it.** When the user can open what the work is building, say where under a `## Try it` section, as Markdown links: `[Web app](http://localhost:5173)`, a preview deploy's address, or for an app with no server its HTML file, `[Demo](/path/to/dist/index.html)`. The hub shows each as a button on the work and on Home, says whether a server on this machine answers, and opens a file for the user. Keep the section current: change the port when it changes, and take a link out when its server is stopped for good. A `try:` line in the front matter works for one link.

**Artifacts.** Link what the work made from the page: an HTML page, a video, a PDF or another document, as a normal link to a file in the work's folder, such as `[How it works](how-it-works.html)`. The hub lists them beside the page under Artifacts and on Media, named by the link's words.

## What the hub adds, so don't write it

- **Times.** When each item first appeared, when it left the page, when the page last changed. Never type a clock time.
- **Agents.** Every agent the work's sessions started, with model, account, branch, worktree and status, read from the harness the agents run in. Write a `## Running` section only for what it can't see, such as a remote machine. A dev server's link goes under `## Try it`.
- **Pull requests.** Every pull request linked to the work's sessions, with title, state and merge time, read from the harness. Each shows once. One that merged is under the Shipped line that names it, or on its own at the end of Shipped. One still open or in draft is listed as in progress.
- **The feed.** Built from the changes the hub sees in the file.

## Who writes

The thread that owns the work writes the page. Subagents report to that thread and don't edit the page. A second thread that joins the work (a scheduled sweep, a follow-up session) runs `progress join` first.

## Markdown

GitHub-flavoured Markdown. Raw HTML works; scripts are removed.

- Links and images are relative to the work's folder. Keep what the page links to inside that folder: it is the one folder the hub serves for the work, and a file kept elsewhere may be cleaned up.
- `![caption](images/shot.png)` shows an image. The same syntax with a video file shows a player, and with an `.html` file it embeds that page in a frame, which is how a built option or a mock goes on the page.
- `<details>` folds long context away.

## Commands

```
progress new "<title>"     create the folder and file for this thread and print the path.
                           Run again from the same thread, it prints the same path.
progress join <work>       add this thread to work that already has a page, and print the path.
progress path              the page this thread belongs to. Works from a subagent too.
progress check [<work>]    what the hub reads from the page, and anything it could not read.
progress todo "<text>"     add to the user's own todos in the hub. Linked to this thread's work.
```

After that, edit the file with your normal tools.

## Todos

The user keeps a list of things to do later in the hub, under Todos. It is theirs: no page holds it, and an agent never ticks or removes one. When they ask to be reminded of something ("remind me to rotate the key once this lands"), run `progress todo "<text>"` with the words they would want to read later. The todo is linked to this thread's work, and the hub shows when that work has settled. This is not for what blocks the work now, which goes under `## Needs you`.
