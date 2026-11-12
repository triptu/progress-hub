# Set up progress on this machine

You are setting up the progress hub for the person who gave you this file. Do each step yourself. Ask them only where a step says to.

1. **Git and Bun.** Install whichever is missing. Bun is at https://bun.sh. A fresh Bun is in `~/.bun/bin`, which this shell has not read yet, so add it to `PATH` before the next steps.
2. **Get the code.** If this repo is not on the machine yet, clone https://github.com/triptu/progress-hub into a folder that lasts, such as `~/code/progress-hub`, not a temporary one. Setup builds from the clone, and an update is a pull and setup again.
3. **Run `bash setup.sh`** in the clone. It builds `progress` and puts it in `~/.local/bin`. It prints an `ok` line for what is ready and a `todo` line for each thing left to do.
   - Do every `todo` you can. The usual one is putting `~/.local/bin` on the `PATH` the person's agents start with, in their shell profile.
   - Tell the person about a `todo` only they can do, such as signing in to `gh` or connecting Tailscale. Both are optional: `gh` adds pull request titles, and Tailscale on a Mac opens the hub from their phone.
   - Pages are kept in `~/progress`. If the person wants another folder, run `PROGRESS_HOME=/that/folder bash setup.sh` instead.
   - On macOS setup starts the hub as a login service. On Linux nothing starts it. Run `progress serve` the way that machine keeps a program running (a systemd user unit, for one), or tell the person to start it. Check that the address it prints answers.
4. **Tell their agents.** Add the two lines below to the instruction file each of their agents reads on every task, such as `~/.claude/CLAUDE.md` or `~/.codex/AGENTS.md`. Ask which agents they use if you can't tell.

   ```
   For any task I will come back to, run `progress new "<title>"` when you start, and keep the page it
   prints current as you work. Run `progress format` once to read the page format.
   ```
5. **Make the first page.** Run `progress new "Set up progress"` for this session. It prints the page's path and its link in the hub. Run `progress format`, fill the page in as it says, and run `progress check <that path>` to see what the hub reads from it. The hub shows a changed page within a few seconds.
6. **Report.** Give the person the link `progress new` printed, the folder their pages are in, the instruction files you changed, and any `todo` left for them.

## Later

- **Update.** Pull in the clone, then run `bash setup.sh` again. On Linux, restart `progress serve` after it.
- **Move the pages.** Move the folder, then run `PROGRESS_HOME=/new/folder bash setup.sh`.
- **Remove.** On macOS, run `launchctl bootout gui/$(id -u)/progress.hub` and delete `~/Library/LaunchAgents/progress.hub.plist` and `~/Library/Logs/progress.log`. On Linux, stop `progress serve` and undo whatever you set up to keep it running. Delete `~/.local/bin/progress` and `~/.config/progress`, and take the two lines out of the instruction files and the `PATH` line out of the shell profile if you added one. If setup made a Tailscale forward, `tailscale serve status` shows it, and it is yours to turn off. Leave the pages folder unless the person says to delete their pages.
