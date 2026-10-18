#!/usr/bin/env bash
# restart-brain-when-idle.sh — restart a remote-brain client WITHOUT killing its
# in-flight tasks.
#
# WHY THIS EXISTS: the client is a long-lived node process — it loads
# remote-brain-client.mjs ONCE at startup, so a `git pull` changes nothing until
# the process restarts (this is exactly how the rate-limit self-report shipped
# on 2026-08-06 but remote claude brains kept showing no meters: the clients
# were still running the pre-feature code). But the systemd unit's default
# KillMode is control-group: restarting it mid-task kills the model CLI children
# and orphans their tasks. This script waits until the client has NO children
# (idle), then restarts the unit.
#
# Run it detached so it survives your own session (e.g. from a task that the
# client itself is running):
#
#   systemd-run --user --collect --unit=cowork-brain-refresh \
#     ~/workspace/github/slashman413/cowork/deploy/restart-brain-when-idle.sh claude
#
# Usage: restart-brain-when-idle.sh [<instance>] [<poll-seconds>]
#   <instance>      systemd template instance (default: claude → cowork-remote-brain@claude)
#   <poll-seconds>  how often to re-check for idleness (default: 15)
# COWORK_BRAIN_UNIT_PREFIX picks the template (default cowork-remote-brain; the
# hub host's own clients run as cowork-local-brain@<name>).
set -euo pipefail

INSTANCE="${1:-claude}"
POLL="${2:-15}"
UNIT="${COWORK_BRAIN_UNIT_PREFIX:-cowork-remote-brain}@${INSTANCE}"

MAIN_PID="$(systemctl --user show -p MainPID --value "$UNIT")"
if [ -z "$MAIN_PID" ] || [ "$MAIN_PID" = "0" ]; then
  echo "ERROR: $UNIT is not running (no MainPID)"; exit 1
fi

echo "Waiting for $UNIT (pid $MAIN_PID) to go idle (no child processes)…"
# The client only ever spawns children to run tasks (claude/agy/codex/… CLIs),
# so "no children" == idle. `pgrep -P` exits 1 when there are none.
while pgrep -P "$MAIN_PID" >/dev/null 2>&1; do sleep "$POLL"; done

echo "Idle — restarting $UNIT"
systemctl --user restart "$UNIT"
sleep 2
systemctl --user --no-pager --lines=3 status "$UNIT" || true
echo "Done — the client now runs the current checkout of remote-brain-client.mjs."
