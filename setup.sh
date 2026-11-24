#!/usr/bin/env bash
# Install the hub: choose where pages are kept, build `progress` and put it in ~/.local/bin, and on macOS
# run the hub as a login service. --test uses a separate binary, label and port.
set -eu
ok() { printf '  ok   %s\n' "$1"; }
todo() { printf '  todo %s\n' "$1"; }
port=${PROGRESS_PORT:-4747}
name=progress
label=progress.hub
case "${1:-}" in
  --test) port=${PROGRESS_PORT:-47480}; name=progress-test; label=progress.hub-test;;
  '') ;;
  *) todo "unknown setup option: $1"; exit 1;;
esac
# Setup chooses the progress home once and records it. The progress command reads it from this file.
homefile="${XDG_CONFIG_HOME:-$HOME/.config}/progress/home"
progress_home=${PROGRESS_HOME:-$(cat "$homefile" 2>/dev/null || true)}
[ -n "$progress_home" ] || progress_home=$HOME/progress
# Never create a missing volume's mount point: only the home folder itself.
if [ ! -d "$progress_home" ] && ! mkdir "$progress_home" 2>/dev/null; then
  todo "could not create the progress home at $progress_home; mount its volume or set PROGRESS_HOME, then re-run"; exit 0
fi
progress_home=$(cd "$progress_home" && pwd)
mkdir -p "$(dirname "$homefile")"
printf '%s\n' "$progress_home" > "$homefile"
ok "progress home: $progress_home"
root=$(cd "$(dirname "$0")" && pwd)
case "$port" in ''|*[!0-9]*) todo "PROGRESS_PORT must be a port number"; exit 1;; esac
if [ "$port" -lt 1 ] || [ "$port" -gt 65535 ]; then todo "PROGRESS_PORT must be between 1 and 65535"; exit 1; fi
if ! command -v bun >/dev/null; then todo "install Bun (https://bun.sh), then re-run for the progress hub"; exit 0; fi
if ! (cd "$root" && bun install --frozen-lockfile && bun run build); then
  todo "progress build failed; re-run after fixing it"; exit 1
fi
bin="$HOME/.local/bin"
mkdir -p "$bin"
# Rename a fresh file so a running binary is never overwritten in place.
install -m 755 "$root/dist/progress" "$bin/$name.new"
mv -f "$bin/$name.new" "$bin/$name"
case ":$PATH:" in *":$bin:"*) ok "$bin is on the agent PATH";; *) todo "add $bin to the PATH used to start agents";; esac
if [ "$(uname -s)" != Darwin ]; then
  todo "the login service needs macOS; here, start the hub yourself with: PROGRESS_PORT=$port $name serve"; exit 0
fi
mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Logs"
agent_path=$(launchctl getenv PATH || true)
case "$agent_path" in '') ;; *) case ":$agent_path:" in *":$bin:"*) ;; *) todo "launchd PATH omits $bin; add it to the PATH used to start agents";; esac;; esac
# launchd's PATH has no Homebrew, and a hub that can't run gh shows no pull request titles. Give it the folder gh is in.
hub_path=/usr/bin:/bin:/usr/sbin:/sbin
if found=$(command -v gh); then
  dir=$(dirname "$found")
  case ":$hub_path:" in *":$dir:"*) ;; *) hub_path="$dir:$hub_path";; esac
else todo "install gh, so the hub can show pull request titles"; fi
# The hub answers only to the names it is reached by, so a website can't read it through DNS rebinding:
# this machine, and any names given in PROGRESS_HOSTS.
hosts=${PROGRESS_HOSTS:-}
plist="$HOME/Library/LaunchAgents/$label.plist"
log="$HOME/Library/Logs/$name.log"
# Escape paths before putting them in XML.
xml() { printf '%s' "$1" | sed 's/\&/\&amp;/g; s/</\&lt;/g; s/>/\&gt;/g; s/"/\&quot;/g; s/'"'"'/\&apos;/g'; }
cat > "$plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>$label</string>
<key>ProgramArguments</key><array><string>$(xml "$bin/$name")</string><string>serve</string></array>
<key>WorkingDirectory</key><string>$(xml "$HOME")</string>
<key>EnvironmentVariables</key><dict>
<key>HOME</key><string>$(xml "$HOME")</string>
<key>PATH</key><string>$(xml "$hub_path")</string>
<key>PROGRESS_HOME</key><string>$(xml "$progress_home")</string>
<key>PROGRESS_PORT</key><string>$port</string>
<key>PROGRESS_HOSTS</key><string>$(xml "$hosts")</string>
</dict>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
<key>StandardOutPath</key><string>$(xml "$log")</string>
<key>StandardErrorPath</key><string>$(xml "$log")</string>
</dict></plist>
PLIST
uid=$(id -u)
launchctl bootout "gui/$uid/$label" 2>/dev/null || true
# bootout can return before launchd finishes removing the old job.
started=false
for _ in 1 2 3 4 5; do
  if launchctl bootstrap "gui/$uid" "$plist" 2>/dev/null; then started=true; break; fi
  sleep 1
done
if [ "$started" != true ]; then todo "could not start $label; read $log"; exit 1; fi
# Ready when the process launchd runs for this job is the one answering on the port, not something else holding it.
ready=false
pid=""
holder=""
for _ in 1 2 3 4 5 6 7 8; do
  pid=$(launchctl print "gui/$uid/$label" 2>/dev/null | sed -n 's/^[[:space:]]*pid = \([0-9][0-9]*\)$/\1/p')
  holder=$(lsof -nP -iTCP:"$port" -sTCP:LISTEN -t 2>/dev/null | head -n 1)
  if [ -n "$pid" ] && [ "$pid" = "$holder" ] && curl -fsS "http://127.0.0.1:$port/api/state" >/dev/null 2>&1; then ready=true; break; fi
  sleep 1
done
if [ "$ready" = true ]; then ok "$label is running; log at $log"
elif [ -n "$holder" ] && [ "$holder" != "$pid" ]; then
  todo "port $port is held by $(ps -o comm= -p "$holder") (pid $holder), so $label can't start; stop it or set PROGRESS_PORT, then re-run"; exit 1
else todo "$label did not start; read $log"; exit 1; fi
ok "local: http://127.0.0.1:$port"
