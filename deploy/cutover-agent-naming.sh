#!/usr/bin/env bash
# cutover-agent-naming.sh — take this host from the old naming to the agent naming,
# without killing in-flight tasks. Run once, from outside cowork-mcp's cgroup:
#
#   systemd-run --user --collect --unit=cowork-agent-cutover deploy/cutover-agent-naming.sh
#
# It waits for the server and its clients to go idle, stops them, backs up and migrates
# persisted state, moves the local client configs + unit to cowork-local-agent@, and
# starts everything so each client re-registers under the new contract.
# The checkout only moves once everything is idle, so the old server never serves the new
# dashboard. Set COWORK_TARGET to the commit to fast-forward main to (run the script from
# a worktree of that commit, with COWORK_REPO pointing at the main checkout).
# On any failure before the new server is healthy, the checkout, build and state are
# restored and the old unit names are started again.
set -euo pipefail

REPO="${COWORK_REPO:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
TARGET="${COWORK_TARGET:-}"
SERVICE="${COWORK_SERVICE:-cowork-mcp}"
POLL="${1:-15}"
OLD_NAME="cowork-local-brain"
NEW_NAME="cowork-local-agent"
UNIT_DIR="$HOME/.config/systemd/user"
OLD_CFG="$HOME/.config/$OLD_NAME"
NEW_CFG="$HOME/.config/$NEW_NAME"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
BACKUP="$HOME/.cowork/backups/agent-naming-$STAMP.tar.gz"
BACKUP_DIST="$HOME/.cowork/backups/dist-pre-agent-naming-$STAMP"
OLD_HEAD="$(git -C "$REPO" rev-parse HEAD)"
. "$REPO/deploy/server-health.sh"

log() { echo "[cutover $(date -u +%H:%M:%S)] $*"; }

# Fast-forward the checkout, keeping uncommitted work on tracked files.
move_checkout() {
  local to="$1" stashed=0
  if ! git -C "$REPO" diff --quiet; then
    git -C "$REPO" stash push -q -m "agent-cutover: uncommitted work" && stashed=1
  fi
  git -C "$REPO" "${@:2}" "$to"
  if [ "$stashed" = 1 ] && ! git -C "$REPO" stash pop -q; then
    log "WARN: uncommitted work conflicted with the move. It is kept in git stash: reset the conflicted files and re-apply it by hand."
    git -C "$REPO" checkout -q HEAD -- . || true
  fi
}

if [ -n "$TARGET" ]; then
  git -C "$REPO" merge-base --is-ancestor "$OLD_HEAD" "$TARGET" \
    || { log "ERROR: main moved to $OLD_HEAD, which $TARGET does not contain. Nothing was changed: rebase and run again."; exit 1; }
fi

log "Waiting for $SERVICE to go idle (no task children)…"
while true; do
  MAIN_PID="$(systemctl --user show -p MainPID --value "$SERVICE")"
  { [ -n "$MAIN_PID" ] && [ "$MAIN_PID" != "0" ] && pgrep -P "$MAIN_PID" >/dev/null 2>&1; } || break
  sleep "$POLL"
done

mapfile -t INSTANCES < <(systemctl --user list-units --plain --no-legend "$OLD_NAME@*.service" | awk '{print $1}' | sed -E "s/^$OLD_NAME@(.*)\.service$/\1/")
log "Client instances: ${INSTANCES[*]:-none}"
for i in "${INSTANCES[@]}"; do
  PID="$(systemctl --user show -p MainPID --value "$OLD_NAME@$i")"
  while [ -n "$PID" ] && [ "$PID" != "0" ] && pgrep -P "$PID" >/dev/null 2>&1; do sleep "$POLL"; done
done

log "Backing up state to $BACKUP"
mkdir -p "$(dirname "$BACKUP")"
tar -czf "$BACKUP" --ignore-failed-read -C / \
  "${HOME#/}/.cowork/config.json" "${HOME#/}/.config/$OLD_NAME" "${UNIT_DIR#/}/$OLD_NAME@.service" \
  "${REPO#/}/inbox" "${REPO#/}/goals" "${REPO#/}/recipes" "${REPO#/}/.status" "${REPO#/}/decisions" \
  "${HOME#/}/.hermes/cowork-routing-rules.md" "${HOME#/}/.cowork/portal.json" "${HOME#/}/.codex/skills/cowork-local-brain"

rollback() {
  log "FAILED — restoring the backup and the old unit names"
  systemctl --user stop "$SERVICE" || true
  tar -xzf "$BACKUP" -C /
  if [ "$(git -C "$REPO" rev-parse HEAD)" != "$OLD_HEAD" ]; then move_checkout "$OLD_HEAD" reset -q --hard; fi
  if [ -d "$BACKUP_DIST" ]; then rm -rf "$REPO/server/dist"; cp -a "$BACKUP_DIST" "$REPO/server/dist"; fi
  for i in "${INSTANCES[@]}"; do systemctl --user disable --now "$NEW_NAME@$i" 2>/dev/null || true; systemctl --user enable --now "$OLD_NAME@$i" || true; done
  systemctl --user start "$SERVICE" || true
  log "Rolled back to $OLD_HEAD."
  exit 1
}
trap rollback ERR

log "Stopping clients and server"
for i in "${INSTANCES[@]}"; do systemctl --user disable --now "$OLD_NAME@$i"; done
systemctl --user stop "$SERVICE"

if [ -n "$TARGET" ]; then
  # Re-check: a commit may have landed while we waited for idle.
  git -C "$REPO" merge-base --is-ancestor "$(git -C "$REPO" rev-parse HEAD)" "$TARGET"
  log "Moving the checkout to $TARGET and building"
  cp -a "$REPO/server/dist" "$BACKUP_DIST"
  move_checkout "$TARGET" merge -q --ff-only
  ( cd "$REPO/server" && "$NODE_BIN" node_modules/typescript/bin/tsc ) || log "WARN: tsc reported errors; continuing only if the build below is complete"
fi
[ -s "$REPO/server/dist/legacy-wire.js" ] || { log "ERROR: server/dist has no legacy-wire.js"; false; }

log "Migrating persisted state"
node "$REPO/scripts/migrate-agent-naming.mjs" --repo "$REPO" --config "$HOME/.cowork/config.json"

log "Moving client configs to $NEW_CFG"
mkdir -p "$NEW_CFG"
python3 - "$OLD_CFG" "$NEW_CFG" "$REPO" <<'PY'
import glob, json, os, re, sys
old, new, repo = sys.argv[1:]
for f in glob.glob(os.path.join(old, '*.env')):
    out = []
    for line in open(f):
        m = re.match(r'^BRAINS=(.*)$', line.rstrip('\n'))
        if m:
            seen, agents = set(), []
            for a in json.loads(m[1]):
                a['id'] = re.sub(r'-(low|medium|high)$', '', a['id'])
                if a['id'] in seen: continue
                seen.add(a['id'])
                if a.get('exec') == 'agy' or a['id'].startswith('local-agy-'):
                    a['model'] = re.sub(r'-(low|medium|high)$', '', a.get('model', ''))
                agents.append(a)
            line = 'AGENTS=' + json.dumps(agents, separators=(',', ':')) + '\n'
        line = line.replace('remote-brain-client.mjs', 'remote-agent-client.mjs')
        line = re.sub(r'^BRAIN_', 'AGENT_', line)
        out.append(line)
    dst = os.path.join(new, os.path.basename(f))
    with open(dst, 'w') as w: w.writelines(out)
    os.chmod(dst, 0o600)
PY
sed -e "s/$OLD_NAME/$NEW_NAME/g" -e 's/remote-brain/remote-agent/g' -e 's/-brain /-agent /g' -e 's/ brain/ agent/g' \
  "$UNIT_DIR/$OLD_NAME@.service" > "$UNIT_DIR/$NEW_NAME@.service"
systemctl --user daemon-reload

# Local notes and installed copies of the client skills.
python3 - "$HOME" <<'PY'
import os, re, shutil, sys
home = sys.argv[1]
def rewrite(p):
    if not os.path.isfile(p): return
    t = open(p).read()
    n = re.sub(r'\b((?:local|remote)-[A-Za-z0-9.-]*?)-(?:low|medium|high)\b', r'\1', t)
    n = n.replace('cowork-local-brain', 'cowork-local-agent').replace('remote-brain', 'remote-agent').replace('JOIN-AS-A-BRAIN', 'JOIN-AS-AN-AGENT')
    n = n.replace('A brain', 'An agent').replace('a brain', 'an agent').replace('brains', 'agents').replace('Brains', 'Agents').replace('BRAINS', 'AGENTS')
    n = re.sub(r'(?<![a-z])brain', 'agent', n); n = n.replace('Brain', 'Agent').replace('BRAIN', 'AGENT')
    if n != t: open(p, 'w').write(n)
rewrite(f'{home}/.hermes/cowork-routing-rules.md')
rewrite(f'{home}/.cowork/portal.json')
old, new = f'{home}/.codex/skills/cowork-local-brain', f'{home}/.codex/skills/cowork-local-agent'
if os.path.isdir(old) and not os.path.exists(new): shutil.move(old, new)
rewrite(f'{new}/SKILL.md')
PY
for c in claude hermes agy; do "$REPO/deploy/install-skill.sh" --client "$c" --skill-only || log "WARN: skill install for $c failed"; done
[ -d "$HOME/.codex/skills/cowork" ] && cp "$REPO/deploy/skills/codex-cowork.SKILL.md" "$HOME/.codex/skills/cowork/SKILL.md"

preflight_or_die
log "Starting $SERVICE"
systemctl --user start "$SERVICE"
wait_healthy_or_die
trap - ERR

log "Starting clients — each re-registers under the new contract"
for i in "${INSTANCES[@]}"; do systemctl --user enable --now "$NEW_NAME@$i"; done
log "Cutover complete. Backup: $BACKUP"
