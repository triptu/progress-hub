# progress

One page per task your coding agents are working on, and a hub in the browser that shows them all.

![The hub with two sample tasks: each task's goal and where it stands on the left, what needs you and what shipped today on the right.](docs/hub-home.png)

When several agents run long tasks at once, it is hard to know which one is waiting for you and what each one finished. Each agent keeps one Markdown page for its task, and the hub shows the pages together. It runs on your machine, with no account.

## What you get

### What needs you

![The Needs you tab with sample data: each question as a card, with the task it came from and how long it has waited.](docs/hub-needs.png)

Every question and blocker your agents have written down, from all tasks, with the one that has waited longest on top.

### What shipped

![A task's Shipped tab with sample data: lines grouped by day, each with its pull request, three of them ticked as viewed.](docs/hub-shipped.png)

What each task finished, by day, with a link to its pull request. Tick a line once you have looked at it, and the tab counts the ones you have not.

### A task's page

![A task's page with sample data: its goal, where it stands, and what shipped with pictures.](docs/hub-work.png)

The page as the agent wrote it, with its goal, where it stands, its decisions and its pictures. An outline follows the scroll, and a mark shows what is new since you last opened it.

### Media

![The Media tab with sample data: screenshots and a chart from one task, as a gallery.](docs/hub-media.png)

The screenshots, videos and pages your agents made, from every task, newest first.

### Todos

![The Todos tab with sample data: four todos, two linked to a task and one to a project.](docs/hub-todos.png)

Your own list of things to do later. Type `@` and a task's name to link a todo to it, and the todo says when that task is over.

### Light and dark

<p>
  <img src="docs/hub-home.png" width="49%" alt="The hub's first screen in the dark theme.">
  <img src="docs/hub-home-light.png" width="49%" alt="The same screen in the light theme.">
</p>

The hub follows your system's theme, and a button in the top bar switches it.

### On your phone

<p>
  <img src="docs/phone-home.png" width="30%" alt="The hub's first screen on a phone.">
  <img src="docs/phone-needs.png" width="30%" alt="The Needs you tab on a phone.">
  <img src="docs/phone-work.png" width="30%" alt="A task's page on a phone.">
</p>

On a Mac with Tailscale, setup makes the same hub open on your phone and your other machines.

## Getting started

Give this to your coding agent:

```
Set up https://github.com/triptu/progress-hub on this machine. Follow PROMPT.md in that repo.
```

It installs the hub on macOS or Linux and tells your agents to keep a page for each task. To keep the pages in another folder, update the hub or remove it, ask the agent.

Any agent that can run a command can keep a page. With T3 Code, the hub also shows each task's agents, their pull requests, and any agent that has stopped on a question.
