# server-health.sh — sourced by the redeploy scripts. Needs SERVICE and REPO set.
#
# WHY THIS EXISTS: on 2026-11-06 a restart went out with server/node_modules
# broken. Every start died on ERR_MODULE_NOT_FOUND, the unit crash-looped, and the
# script still printed "Redeploy complete". The server stayed down for 47 minutes.

NODE_BIN="${COWORK_NODE:-$(command -v node || echo "$HOME/.local/bin/node")}"

# Refuse to take down a working server for one that cannot load its dependencies.
preflight_or_die() {
  if ! ( cd "$REPO/server" && "$NODE_BIN" --input-type=module -e "await import('express')" ) >/dev/null 2>&1; then
    echo "ERROR: server cannot load its dependencies (check $REPO/server/node_modules)."
    echo "NOT restarting $SERVICE; the running server is left as it is."
    exit 1
  fi
}

# Any HTTP answer counts as up; a crash-looping unit never answers. localhost and
# plain HTTP are the local listener.
wait_healthy_or_die() {
  local url="${COWORK_HEALTH_URL:-http://localhost:6868/}" i
  for i in $(seq 1 30); do
    if curl -s -o /dev/null -m 2 "$url"; then
      echo "$SERVICE answers at $url."
      return 0
    fi
    sleep 1
  done
  systemctl --user --no-pager --lines=10 status "$SERVICE" || true
  echo "ERROR: $SERVICE did not answer at $url within 30s after the restart. Redeploy FAILED."
  exit 1
}
