# progress-hub

A centralized progress page where all your agents can put in the work being shipped, in progress and planned, decisions being made, goals, artifacts being created, decisions which need you etc. so you can keep tabs on what your agents are up to from one interface.

<a href="https://progress-hub.tushar.ai/"><picture><source media="(prefers-color-scheme: light)" srcset="docs/trailer-poster-light.jpg"><img src="docs/trailer-poster.jpg" alt="The progress-hub trailer, 24 seconds"></picture></a>

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

Any column can take the board's whole width. Give it to Shipped to skim everything your agents finished, from top to bottom. Each card is then a row with everything on it: what its page says, its pictures large, whether it is live and its pull requests. The other columns fold into its heading.

![The Shipped column given the board's whole width, with sample data. Each card is one row as wide as the board, with its text and large screenshots, and the other three columns are named beside its heading.](docs/hub-board-wide.png)

### What shipped, and whether it is live

![A shipped card opened beside the board, with sample data. It shows the screenshots the agent took, and a line that says the change is live in a release.](docs/hub-card.png)

Open a card to read it in full with its pictures, and step to the next one with the arrow keys. A shipped card says whether you can try the change yet, and the hub ticks it as viewed once you have opened it.

### A task's page

![A task's page with sample data. It opens with what is new since the last visit, then the goal and the two questions waiting for an answer.](docs/hub-work.png)

A task's page opens with what changed since you last looked. Under that are its goal, what it needs from you, where it stands, and the rest of the page as the agent wrote it.

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


