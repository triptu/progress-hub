# Progress page format

Each piece of work keeps one folder in the progress home, with one Markdown file in it. `setup.sh` chooses the home on each machine (`~/progress` unless you set `PROGRESS_HOME`), and `progress new` prints the page's path. The hub draws that file as the work's page and builds the shared views (the board, the feed) from it.

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
  Measured on CI, ten runs each.

  Live: in desktop 4.18.
- https://github.com/acme/kestrel/pull/415 The admin page lists failed jobs.

  Not live: the admin deploy is run by hand. Say go and I will run it.
- https://github.com/acme/kestrel/commit/daa36b6 The lint config is one file.

## In progress

- https://github.com/acme/kestrel/pull/418 Moving the desktop app to the new index.
  Two of nine tests still fail on Windows.

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
4. **Five sections**, found by their name as whole words at the start of a `#` or `##` heading, in any letter case: `Needs you`, `In progress` (or `In review`, `Doing`), `Next` (or `Up next`, `To do`, `Planned`), `Decisions` (or `Decision log`) and `Shipped`. So `Shipped today` is Shipped, and `Needs your eyes later` is a freeform section. Next, In progress and Shipped are the three states of the work, each a lane of its board beside Needs you: move a line from one to the next as the work moves.
5. **Items** in those sections. Each `###` block is one item. With no `###` blocks, each top-level bullet is one item. Text above the first item is an introduction and is not an item. In Needs you, In progress and Next, a ticked box (`- [x]`) is done and is not an item.

   **An item's first line is its name.** The board shows it as the item's card, so write it as one sentence that says what the item is, in under about 100 characters, and put everything else on the lines under it: numbers, limits, pictures. What it waits on and where it stands ("in review", "waiting on the deploy") go under the line too, never in it: the line is the item's name, and it outlives its state. When the item moves on, change what is under it as well: a line under it that says "in review" goes to Shipped as it is. Nor does a line open with a date: the hub records when each line appeared. The hub also knows an item by that line. A line reworded a little stays the same item, but one that says something else is a new item, which the user sees as something new. Change the lines under it instead, and keep the first line as it is.
6. **Needs you with no open items.** Its prose counts as one item, even beside ticked boxes, so a blocker written as a paragraph is not missed. Prose that ends in a colon introduces the list under it and is not an item. When nothing needs the user, leave the section empty or write "Nothing right now." and nothing after it: with more after it, it is shown as an ask.

7. **Important items.** An item whose title starts with `!` and a space is one the user should not miss: `- ! Sync no longer loses edits.` or `### ! Pick a region`. The hub stars it on its card and in the feed, and the feed's Important switch keeps only these and what needs the user. The mark is not part of the title, and a line that swaps its bullet for the mark (`! text`) is read the same. Use it for the few things worth a skim; when every line has it, none stands out.

An item is known by its title. A title reworded in one save, keeping most of its words and not naming other links, numbers like `#123` or commits in their place, is the same item: it keeps its time and what the user marked on it. Any other change to the title makes a new item with a new time. `progress reword` is the way to change one further: a line it rewords is the same item, however little of it stays.

**Needs you** is for what only the user can do. Name the item for the thing to do, and under it give the exact step and a direct link to where it is done, so they never have to ask how. Remove an item the moment it is settled, and write the outcome under Decisions. The user can also mark an item done in the hub, which takes it off their lists and leaves the page as it is: `progress check` then names it, and you take it off the page.

Add new Decisions and Shipped entries at the top.

A Shipped line with a pull request or commit link is shown with its title and state. Write the full link, not a bare `#number`.

**Live.** Shipped means the work is done and merged. Whether the user can try it yet is a separate fact, and they should never have to ask. Under a Shipped item, on a line of its own, write `Live:` and where it is, once it is where they would use it: deployed, released, installed, or simply on main where that is all there is to it. While it has merged and is not there yet, write `Not live:` and what it waits on. When going live takes a step you can run, such as a deploy, run it. When only the user can take the step, it is also a Needs you item. Change `Not live:` to `Live:` when it gets there: the hub shows the mark on the item's card and records when it went live. Leave both out for work with nothing to try, such as a refactor.

Keep **Next** complete: everything the user asked for that is not started yet belongs there, in the order you will take it, so they can check that nothing they said was dropped. Keep **In progress** to what is being worked on now.

**Try it.** When the user can open what the work is building, say where under a `## Try it` section, as Markdown links: `[Web app](http://localhost:5173)`, a preview deploy's address, or for an app with no server its HTML file, `[Demo](/path/to/dist/index.html)`. The hub shows each as a button on the work and on Home, says whether a server on this machine answers, and opens a file for the user. Keep the section current: change the port when it changes, and take a link out when its server is stopped for good. A `try:` line in the front matter works for one link.

**Artifacts.** Link what the work made from the page: an HTML page, a video, a PDF or another document, as a normal link to a file in the work's folder, such as `[How it works](how-it-works.html)`. A link to a folder there, such as `[Queries](queries/)`, shows the files in it. The hub lists them beside the page under Artifacts and on Media, named by the link's words.

## What the hub adds, so don't write it

- **Times.** When each item first appeared, when its text changed, when it went live, when it left the page. Never type a clock time.
- **What is new.** The hub sees every change to the page and shows the user what changed since they last looked. So change what has changed, and leave the rest of the page as it is.
- **Agents.** Every agent the work's sessions started, with model, account, branch, worktree and status, read from the harness the agents run in. Write a `## Running` section only for what it can't see, such as a remote machine. A dev server's link goes under `## Try it`.
- **Pull requests.** Every pull request linked to the work's sessions, with title, state and merge time, read from the harness. Each shows once. One that merged is on the card of the Shipped line that names it, or has a Shipped card of its own. One still open or in draft is on the card of the In progress line that names it, or has an In progress card of its own.
- **The feed.** Built from the changes the hub sees in the file.

## Who writes

The thread that owns the work writes the page. Subagents report to that thread and don't edit the page. A second thread that joins the work (a scheduled sweep, a follow-up session) runs `progress join` first.

## Outcomes

When the goal names something you can count (faster, cheaper, fewer failures, more people kept), record the number. The hub shows a work's numbers on its Outcomes tab, and its north star on its card on Home. Readings go in `outcomes.jsonl` beside the page, one per line, written by `progress measure`. They are not page changes: they add nothing to the feed and do not move the work up Home.

```
progress measure "Failed tool calls" 3.51% --where prod --star --lower --target 2% \
  --how "Production traces: failed ÷ all tool calls, full UTC days" \
  --n "300,248 tool calls" --window "full UTC day" --source queries/failures.sql
progress measure "Calendar bad arguments" 0.19% --from 3.08% --where prod --lower \
  --change https://github.com/acme/app/pull/32
progress measure "Desktop active in 14 days" 244 --of 1114 --by client=web --where prod
```

1. **Measure before the first change.** Record where the number stands, with `--star`, before you change anything. One outcome is the star: the one number this work moves. A later `--star` on another outcome moves it.
2. **Say where.** Every value has `--where`: `prod`, `ci`, `local`, or `guess` for a number nobody measured. The hub never joins or compares numbers from two places, and never puts a guess in a headline.
3. **Make it checkable.** Give a prod number its `--window` and its `--source`, the saved query or script that gives it again, and `--n`, how many were counted, with what they are once: `--n "300,248 tool calls"`. A `--source` holds for the readings after it until a new `--how`, so give it once. Times and the session are stamped for you.
4. **The definition sticks.** The first reading fixes the unit. `--lower` or `--higher`, `--target` and `--how` hold until a line changes them. A reading in another unit is refused. A new `--how` starts a new definition, and the readings before it stay in its list but leave its chart.
5. **Tie a number to its change.** `--change` names the pull request, commit or idea a reading is about, with `--from` for the value before. The hub works out better or worse from the numbers and the direction. You add only `--unclear`, when the difference is inside the noise, and `--dropped`, when the change was not kept.
6. **Split, don't rename.** `--by client=web` records one segment. Each value of a label gets its own line on the chart. `--by day=part` marks a reading of part of a window, which is shown beside the line and never joined to full days. `--of` gives the whole, so 244 of 1,114 shows as counts and a rate. The first reading fixes whether an outcome is a rate, and a rate's `--target` and `--from` are in percent.
7. **Say what is due.** `--due 2026-12-09` with no value records a reading expected later, such as a cohort that has not matured. `progress check` names it once it is late.
8. **Record what you look after.** Besides the star, record what you are responsible for moving or keeping safe: inputs, guardrails, costs. `--group "Guardrails"` puts an outcome under a heading of that name. An outcome with no group is listed under Also measured. Keep one star.

`progress check` prints the star and its latest reading, and names what is missing: a star with no `--how`, a prod reading with no window or source, a shipped pull request measured only locally, and a reading past its due date. A table of numbers on the page is still fine for anything else, such as a grid a team already keeps.

## Key changes

Some changes are ones every later change depends on, such as a new table, and they are easy to miss among many pull requests. The hub's Key changes tab shows them across every work, newest first, each with why and its pull request. Today that is database changes.

When a pull request you open adds a migration or changes a database schema, record it with its migration files, from your checkout:

```
progress change db db/migrations/20261124_routine_waits.sql --pr https://github.com/acme/app/pull/412 \
  --why "Each routine waits this long for an offline computer before it gives up"
```

1. **Run it when the pull request is opened,** and again when its migrations change. A second run for the same pull request replaces the first.
2. **Give the migrations as written.** The hub keeps the SQL and reads from it what changed: tables, columns, indexes, constraints, triggers, policies, data changes and other objects. The command says what it read, so you see at once if it was read as meant. A file that is not SQL is kept and shown as written.
3. **Say why in one line,** in words the user would use, not the migration's name. `--db "<name>"` says which database, when the project has more than one.

Changes go in `changes.jsonl` beside the page, one per line. Like readings, they are not page changes.

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
                           From a thread on another page it changes nothing, unless --move
                           takes the thread off that page: a thread keeps one page.
progress path              the page this thread belongs to. Works from a subagent too.
progress check [<work>]    what the hub reads from the page, anything to fix on it, and any ask
                           the user marked done in the hub.
progress todo "<text>"     add to the user's own todos in the hub. Linked to this thread's work.
progress measure "<outcome>" <value> --where prod|ci|local|guess
                           record a reading of a number this work moves. See Outcomes.
progress change db <migration file>... --pr <link> --why "<one line>"
                           record a pull request's database change. See Key changes.
```

## Editing the page

Commands make the common edits safely. Each changes only the lines it is about and writes the file in one step, or changes nothing and says why. Name a line by words that stand together in its first line, in any case, or by a link or `#number` it holds, given whole; `pull/57` names it as `#57` does. A name that matches no line, or more than one, changes nothing. Text given to a command is one line. `progress --help` has the details.

```
progress summary "<text>"                     replace the summary.
progress add <section> "<line>"               add an item: needs, doing, next, decisions or shipped.
progress move "<line>" <section>              move an item, such as from doing to shipped.
progress reword "<line>" "<new first line>"   change an item's first line, where it is.
progress live "<line>" "<where>"              say a Shipped item is live, or --not-live "<what it waits on>".
progress remove "<line>"                      take an item off, such as a settled ask.
```

`add`, `move` and `reword` take `--under "<line>"`, once for each line to write under the item, after any it has, and `--pr <url>`, which puts the pull request at the start of the line unless it links it already. `move --as "<new first line>"` rewords the item on its way. A line that says it is in review or waiting on something goes to Shipped only with new words: `progress move "<line>" shipped --as "<what is now true>" --pr <url>`.

Editing the file by hand is still fine, for anything these don't cover: the goal, a freeform section, changing the lines under an item, an ask written as prose. So is making several changes at once: use your edit tool, never a script and never a rewrite of the whole file, then run `progress check`. It prints what the hub read, and anything a command would have refused, such as a first line that opens with a date. Change a line's words with `progress reword` even then.

## Todos

The user keeps a list of things to do later in the hub, at the foot of Home. It is theirs: no page holds it, and an agent never ticks or removes one. When they ask to be reminded of something ("remind me to rotate the key once this lands"), run `progress todo "<text>"` with the words they would want to read later. The todo is linked to this thread's work, and the hub shows when that work has settled. This is not for what blocks the work now, which goes under `## Needs you`.
