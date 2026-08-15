#!/usr/bin/env bash
# redeploy-server-when-idle.sh — make the committed source go live on the
# cowork-mcp SERVER without killing the in-flight task that triggers the deploy.
#
# WHY THIS EXISTS (the trap that kept shipping "fixed but not live"):
#   The server runs from `server/dist/` and `dist/` is .gitignored, so pushing to
#   `main` changes nothing until the running node process is restarted. But the
#   `cowork-mcp` systemd unit has KillMode=control-group and it runs LOCAL-brain
#   tasks as its own child processes. A goal/task executing on a local brain is
#   therefore a child of the very service it needs to restart — so a plain
#   `systemctl --user restart cowork-mcp` SIGKILLs the task mid-deploy, the result
#   is never written, and the restart is aborted with it. That is exactly why the
#   `blocked`-goal resume fix (05f1636) sat committed-and-built but never live: the
#   task that would deploy it could not restart its own parent.
#
#   `restart-brain-when-idle.sh` solves the same problem for remote-brain CLIENTS;
#   this is its sibling for the SERVER itself.
#
# WHAT IT DOES:
#   1. (optional) rebuilds dist via redeploy.sh --no-restart, stopping before any
#      restart if the build fails — the live server is never replaced by a broken
#      build.
#   2. waits until cowork-mcp has NO task children (idle), so no running task is
#      killed, then restarts the unit.
#
# HOW TO RUN IT (detached, so it outlives the task doing the deploy):
#   systemd-run --user --collect --unit=cowork-server-redeploy \
#     ~/workspace/github/slashman413/cowork/deploy/redeploy-server-when-idle.sh
#
#   Launched with systemd-run it lives in its OWN transient scope — not in
#   cowork-mcp's control group — so restarting cowork-mcp does not kill it.
#
# Usage: redeploy-server-when-idle.sh [--no-build] [<poll-seconds>] [<max-wait-seconds>]
#   --no-build          skip the rebuild; just wait-for-idle then restart
#   <poll-seconds>      how often to re-check for idleness (default: 15)
#   <max-wait-seconds>  give up waiting for idle after this long and restart anyway
#                       (default: 0 = wait indefinitely; never kills a running task)
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SERVICE="${COWORK_SERVICE:-cowork-mcp}"

BUILD=1
[ "${1:-}" = "--no-build" ] && { BUILD=0; shift; }
POLL="${1:-15}"
MAX_WAIT="${2:-0}"

if [ "$BUILD" = "1" ]; then
  echo "Building committed source (redeploy.sh --no-restart)…"
  "$REPO/deploy/redeploy.sh" --no-restart
fi

MAIN_PID="$(systemctl --user show -p MainPID --value "$SERVICE")"
if [ -z "$MAIN_PID" ] || [ "$MAIN_PID" = "0" ]; then
  echo "ERROR: $SERVICE is not running (no MainPID)"; exit 1
fi

echo "Waiting for $SERVICE (pid $MAIN_PID) to go idle (no task children)…"
# The server spawns children only to run local-brain tasks (claude/codex/agy/…
# CLIs), so "no children" == no task in flight. `pgrep -P` exits 1 when none.
start="$(date +%s)"
while pgrep -P "$MAIN_PID" >/dev/null 2>&1; do
  if [ "$MAX_WAIT" != "0" ] && [ "$(( $(date +%s) - start ))" -ge "$MAX_WAIT" ]; then
    echo "WARN: still busy after ${MAX_WAIT}s — restarting anyway (may interrupt a running task)."
    break
  fi
  sleep "$POLL"
done

echo "Restarting $SERVICE"
systemctl --user restart "$SERVICE"
sleep 2
systemctl --user --no-pager --lines=5 status "$SERVICE" || true
echo "Redeploy complete — the live server now runs the committed source."
echo "Blocked goals can now be resumed (blocked → active); the drive loop auto-resumes them on backoff."
