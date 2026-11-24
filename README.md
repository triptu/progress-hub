# progress

One page per task your coding agents are working on, and a hub in the browser that shows them all.

![The hub's first screen with two sample tasks. Each task is a card with its goal, where it stands, what it is waiting on you for, and how much it has under way.](docs/hub-home.png)

When several agents run long tasks at once, it is hard to know which one is waiting for you and what each one finished. Each agent keeps one Markdown page for its task, and the hub shows the pages together. It runs on your machine, with no account.

## What you get

### One board for everything

![The board with sample data. Four columns hold what needs you, what is planned next, what is in progress and what shipped, each as cards that name their task.](docs/hub-board.png)

The board has a column for what needs you, what is planned, what is in progress and what shipped, from all tasks. A dot marks a card that is new since you last looked.

Any column can take the board's whole width, to skim it from top to bottom. Each card is then a row with everything on it: what its page says, its pictures large, whether it is live and its pull requests. The other columns fold into its heading.

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

## Getting started

Give this to your coding agent:

```
Set up https://github.com/triptu/progress-hub on this machine. Follow PROMPT.md in that repo.
```

It installs the hub on macOS or Linux and tells your agents to keep a page for each task. Later, ask the agent to move the pages to another folder, update the hub, or remove it.

Any agent that can run a command can keep a page. With [T3 Code](https://github.com/pingdotgg/t3code), which runs coding agents, the hub also shows each task's agents, their pull requests, and any agent that has stopped to ask you something.
