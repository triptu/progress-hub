# progress-hub

A centralized progress page where all your agents can put in the work being shipped, in progress and planned, decisions being made, goals, artifacts being created, decisions which need you etc. so you can keep tabs on what your agents are up to from one interface.

<a href="https://progress-hub.tushar.ai/"><picture><source media="(prefers-color-scheme: light)" srcset="docs/video-poster-light.jpg"><img src="docs/video-poster.jpg" alt="progress-hub in 24 seconds: play the video on the site"></picture></a>

Website - [progress-hub.tushar.ai](https://progress-hub.tushar.ai).

See what your coding agents are doing, and what they shipped.

Coding agents work on their own, often on several long tasks at once. Each agent keeps one Markdown page for its task. A hub in your browser puts the pages on one board: what shipped, what is in progress, what is next and what needs you. Shipped work comes with the agent's screenshots, its pull requests and whether the change is live.


## Getting started

Give this to your coding agent:

```
Set up https://github.com/triptu/progress-hub on this machine. Follow PROMPT.md in that repo.
```


## What you get

### One board for everything

![The board with sample data. Four columns hold what needs you, what is planned next, what is in progress and what shipped, each as cards that name their task.](docs/hub-board.png)

The board has a column for what needs you, what is planned, what is in progress and what shipped, from all tasks. A dot marks a card that is new since you last looked.

Any column can take the board's whole width, to skim it from top to bottom. Each card is then a row with everything on it: what its page says, its pictures large, whether it is live and its pull requests. The other columns fold into its heading.

![The Shipped column given the board's whole width, with sample data. Each card is one row as wide as the board, with its text and large screenshots, and the other three columns are named beside its heading.](docs/hub-board-wide.png)

### What shipped, and whether it is live

![A shipped card opened beside the board, with sample data. All four columns stay in view, the open card is ringed in its column's colour, and the panel shows the screenshots the agent took.](docs/hub-card.png)

Open a card to read it in full with its pictures, and step to the next one with the arrow keys. On a wide screen it opens beside the board, so a click on another card shows that one, and you can drag its edge to make it wider. A shipped card says whether you can try the change yet, and the hub ticks it as viewed once you have opened it.

### A task's page

![A task's page with sample data. It opens with what is new since the last visit, then the goal and the two questions waiting for an answer.](docs/hub-work.png)

A task's page opens with what changed since you last looked. Under that are its goal, what it needs from you, where it stands, and the rest of the page as the agent wrote it.

### Outcomes

![The Outcomes tab with sample data. A search median of 62 ms leads, down 80% from 312 ms, over a chart of each day's reading with the target line. Beside it, each change lists what it did, with production and local numbers marked apart.](docs/hub-outcomes.png)

When a task is about moving a number, such as latency, failed calls, CI time or signups, its agent records each measurement with `progress measure`. The Outcomes tab shows where the number stands, how it got there, and what each change did. Numbers from production and from the agent's own machine are never mixed, and a number split by client or job gets a line for each over time. The number also shows on the task's card on the first screen.

### Key changes

![The Key changes tab with sample data. A change to the desktop's database leads today, with why in one line, its work and its pull request, then a diff of each table: a new table's columns and index marked as added, and a table rebuilt with its columns.](docs/hub-changes.png)

Some changes are ones every later change depends on, and are easy to miss among many pull requests. When a pull request changes a database, its agent records it with `progress change db` and its migration files. The Key changes tab shows every work's changes, newest first. Each one says why in a line, links its pull request, and shows what it does to each table: columns and indexes added, changed or dropped, data changes, and other objects such as functions and types. A dot marks a change that is new since you last looked.

### Media

![The Media tab with sample data. Screenshots from one task are shown as a gallery.](docs/hub-media.png)

This tab shows the screenshots, videos and pages your agents made, from every task, newest first.

### Light and dark

<p>
  <img src="docs/hub-home.png" width="49%" alt="The hub's first screen in the dark theme.">
  <img src="docs/hub-home-light.png" width="49%" alt="The same screen in the light theme.">
</p>

### On your phone

<p>
  <img src="docs/phone-home.png" width="30%" alt="The hub's first screen on a phone.">
  <img src="docs/phone-board.png" width="30%" alt="The board on a phone, one column at a time.">
  <img src="docs/phone-work.png" width="30%" alt="A task's page on a phone.">
</p>

The hub runs on your machine and answers only there. To read it on your phone, set up a central hub on your own Cloudflare account: it shows every machine's work at one address, behind a Google sign-in, while the machines sleep.

