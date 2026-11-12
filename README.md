# progress

One page per task your coding agents are working on, and a hub in the browser that shows them all.

![The hub with two sample tasks. Each task's goal and where it stands are on the left, with what needs you and what shipped today on the right.](docs/hub-home.png)

When several agents run long tasks at once, it is hard to know which one is waiting for you and what each one finished. Each agent keeps one Markdown page for its task, and the hub shows the pages together. It runs on your machine, with no account.

## What you get

### What needs you

![The Needs you tab with sample data. Each question is a card, with the task it came from and how long it has waited.](docs/hub-needs.png)

This tab lists every question and blocker your agents have written down, from all tasks, with the one that has waited longest on top.

### What shipped

![A task's Shipped tab with sample data. Lines are grouped by day, each with its pull request or commit, and three are ticked as viewed.](docs/hub-shipped.png)

This tab lists what each task finished, by day, with a link to its pull request. Tick a line once you have looked at it, and the Mark all button counts the ones you have not.

### A task's page

![A task's page with sample data. It shows the goal, where the task stands, and what shipped with pictures.](docs/hub-work.png)

The hub shows the page as the agent wrote it, with its goal, where it stands, its decisions and its pictures. An outline marks the section you are reading, and a dot shows what is new since you last opened it.

### Media

![The Media tab with sample data. Screenshots from one task are shown as a gallery.](docs/hub-media.png)

This tab shows the screenshots, videos and pages your agents made, from every task, newest first.

### Todos

![The Todos tab with sample data. A new todo is being typed, and the menu that links it to a task is open.](docs/hub-todos.png)

This is your own list of things to do later. Type `@` and a task's name to link a todo to it, and the todo says when that task is over.

### Light and dark

<p>
  <img src="docs/hub-home.png" width="49%" alt="The hub's first screen in the dark theme.">
  <img src="docs/hub-home-light.png" width="49%" alt="The same screen in the light theme.">
</p>

### On your phone

<p>
  <img src="docs/phone-home.png" width="30%" alt="The hub's first screen on a phone.">
  <img src="docs/phone-needs.png" width="30%" alt="The Needs you tab on a phone.">
  <img src="docs/phone-work.png" width="30%" alt="A task's page on a phone.">
</p>

On a Mac with Tailscale, setup makes the hub reachable from your phone and your other machines.

## Getting started

Give this to your coding agent:

```
Set up https://github.com/triptu/progress-hub on this machine. Follow PROMPT.md in that repo.
```

It installs the hub on macOS or Linux and tells your agents to keep a page for each task. Later, ask the agent to move the pages to another folder, update the hub, or remove it.

Any agent that can run a command can keep a page. With [T3 Code](https://github.com/pingdotgg/t3code), which runs coding agents, the hub also shows each task's agents, their pull requests, and any agent that has stopped to ask you something.
