# Set up progress on this machine

You are setting up the progress hub for the person who gave you this file. Do each step yourself. Ask them only where a step says to.

1. **Get the code.** If this repo is not on the machine yet, clone https://github.com/triptu/progress-hub into a folder that lasts, such as `~/code/progress-hub`, not a temporary one. Setup builds from the clone, and an update is a pull and setup again.
2. **Bun.** If `bun` is not installed, install it from https://bun.sh.
3. **Run `bash setup.sh`** in the clone. It builds `progress`, puts it in `~/.local/bin`, and prints a line for each thing it did (`ok`) and each thing left to do (`todo`).
   - Do every `todo` you can. The usual one is putting `~/.local/bin` on the `PATH` the person's agents start with, in their shell profile.
   - Tell the person about a `todo` only they can do, such as signing in to `gh` or connecting Tailscale. Both are optional: `gh` adds pull request titles, and Tailscale on a Mac opens the hub from their phone.
   - Pages are kept in `~/progress`. If the person wants another folder, run `PROGRESS_HOME=/that/folder bash setup.sh` instead.
   - On macOS setup starts the hub as a login service. On Linux nothing starts it. Run `progress serve` the way that machine keeps a program running (a systemd user unit, for one), or tell the person to start it.
4. **Tell their agents.** Add the two lines below to the instruction file each of their agents reads on every task, such as `~/.claude/CLAUDE.md` or `~/.codex/AGENTS.md`. Ask which agents they use if you can't tell.

   ```
   For any task I will come back to, run `progress new "<title>"` when you start, and keep the page it
   prints current as you work. Run `progress format` once to read the page format.
   ```
5. **Make the first page.** Run `progress new "Set up progress"` for this session. Run `progress format`, fill the page in as it says, and run `progress check set-up-progress` to see what the hub read.
6. **Report.** Give the person the link `progress new` printed, the folder their pages are in, the instruction files you changed, and any `todo` left for them.

## Later

- **Update.** Pull in the clone, then run `bash setup.sh` again.
- **Move the pages.** Move the folder, then run `PROGRESS_HOME=/new/folder bash setup.sh`.
- **Remove.** On macOS, run `launchctl bootout gui/$(id -u)/progress.hub` and delete `~/Library/LaunchAgents/progress.hub.plist`. Delete `~/.local/bin/progress` and `~/.config/progress`, and take the two lines out of the instruction files. If setup made a Tailscale forward, `tailscale serve status` shows it. Leave the pages folder unless the person says to delete their pages.
