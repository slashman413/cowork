#!/usr/bin/env bash
# redeploy.sh — make the CURRENTLY COMMITTED source actually go live.
#
# WHY THIS EXISTS: the server runs from `server/dist/` (compiled output), and
# `dist/` is .gitignored. The systemd unit's ExecStart is `node dist/index.js`,
# so a plain `systemctl --user restart cowork-mcp` re-launches the SAME stale
# build — pushing to `main` changes nothing until someone rebuilds. This has
# repeatedly made shipped fixes look "not working" on the live host (e.g. the
# codex --skip-git-repo-check fix and the brain rate-limit meters). Run this
# after pulling to close that gap in one step:
#
#   git pull && deploy/redeploy.sh
#
# It rebuilds (tsc) and restarts the service. Safe to run repeatedly; if the
# build fails it stops BEFORE restarting, so the running server is never
# replaced by a broken build.
#
# Usage:
#   deploy/redeploy.sh              # npm run build, then restart systemd user service
#   deploy/redeploy.sh --no-restart # rebuild only (e.g. foreground/manual launch)
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SERVER="$REPO/server"
SERVICE="${COWORK_SERVICE:-cowork-mcp}"
RESTART=1
[ "${1:-}" = "--no-restart" ] && RESTART=0

command -v npm >/dev/null 2>&1 || { echo "ERROR: npm not found on PATH (need Node >= 20)"; exit 1; }

echo "Building $SERVER (tsc)…"
( cd "$SERVER" && npm run build )
echo "Build OK → $SERVER/dist"

if [ "$RESTART" = "0" ]; then
  echo "Skipping restart (--no-restart). Relaunch your foreground process to pick up the new build."
  exit 0
fi

if command -v systemctl >/dev/null 2>&1 && systemctl --user status "$SERVICE" >/dev/null 2>&1; then
  # Self-kill trap: cowork-mcp has KillMode=control-group and runs local-brain
  # tasks as its own children, so if THIS process is running inside the service's
  # control group (e.g. a goal/task doing the deploy), restarting it would SIGKILL
  # us mid-restart — the fix builds but never goes live. Detect that and hand off
  # to the detached, wait-for-idle path instead of committing suicide.
  MAIN_PID="$(systemctl --user show -p MainPID --value "$SERVICE" 2>/dev/null || echo 0)"
  MY_CG="$(cat /proc/self/cgroup 2>/dev/null || true)"
  if [ -n "$MAIN_PID" ] && [ "$MAIN_PID" != "0" ] && printf '%s' "$MY_CG" | grep -q "${SERVICE}.service"; then
    echo "Detected: this process runs INSIDE ${SERVICE}'s control group."
    echo "A direct restart would kill it (and this deploy) — handing off to the"
    echo "detached, wait-for-idle redeploy so the restart survives and no task dies:"
    echo
    echo "  systemd-run --user --collect --unit=cowork-server-redeploy \\"
    echo "    $REPO/deploy/redeploy-server-when-idle.sh --no-build"
    systemd-run --user --collect --unit=cowork-server-redeploy \
      "$REPO/deploy/redeploy-server-when-idle.sh" --no-build
    echo "Scheduled — cowork-mcp will restart onto the fresh build once it goes idle."
    exit 0
  fi
  echo "Restarting systemd user service: $SERVICE"
  systemctl --user restart "$SERVICE"
  sleep 2
  systemctl --user --no-pager --lines=5 status "$SERVICE" || true
  echo "Redeploy complete — live server now runs the committed source."
else
  echo "systemd user service '$SERVICE' not found."
  echo "Rebuild is done; restart your server process manually to go live"
  echo "(or set COWORK_SERVICE=<name> if the unit has a different name)."
fi
