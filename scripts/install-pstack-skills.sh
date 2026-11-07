#!/usr/bin/env bash
set -euo pipefail

# install-pstack-skills.sh — expose every vendored pstack skill to every agent runtime.
#
#   ~/.claude/skills/<name>  -> symlink to vendor/pstack/skills/<name>  (Claude agents, G8: all skills)
#   ~/.agents/skills/<name>  <- rsync --delete copy of the vendored skill (shared install)
#   ~/.hermes/skills/<name>  -> symlink to ../../.agents/skills/<name>  (Hermes agents)
#
# Usage:
#   scripts/install-pstack-skills.sh           install / refresh (idempotent)
#   scripts/install-pstack-skills.sh --check   exit 1 if any install is missing or differs from vendor/ (CI-usable)
#
# A pre-existing non-symlink ~/.claude/skills/<name> that is not a pstack copy is
# moved to ~/.claude/skills-parked/<name>.bak-<date>, never deleted.
# Override install roots with CLAUDE_SKILLS_DIR / AGENTS_SKILLS_DIR / HERMES_SKILLS_DIR.

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="${REPO_ROOT}/vendor/pstack/skills"
CLAUDE_DIR="${CLAUDE_SKILLS_DIR:-$HOME/.claude/skills}"
AGENTS_DIR="${AGENTS_SKILLS_DIR:-$HOME/.agents/skills}"
HERMES_DIR="${HERMES_SKILLS_DIR:-$HOME/.hermes/skills}"
MODE="${1:-install}"

check() {
  local bad=0 n dest
  for d in "${SRC}"/*/; do
    n="$(basename "$d")"
    for dest in "$CLAUDE_DIR" "$AGENTS_DIR" "$HERMES_DIR"; do
      [ -d "$(dirname "$dest")" ] || continue
      if [ ! -e "$dest/$n" ]; then echo "MISSING $dest/$n"; bad=1
      elif ! diff -rq "$d" "$dest/$n" >/dev/null 2>&1; then echo "DIFF $dest/$n"; bad=1
      fi
    done
  done
  [ "$bad" = 0 ] && echo "pstack skills: all $(ls -d "${SRC}"/*/ | wc -l) installed and identical to vendor/ ($(cat "${REPO_ROOT}/vendor/pstack/PIN" 2>/dev/null || echo unpinned))"
  return "$bad"
}

if [ "$MODE" = "--check" ]; then check; exit $?; fi

stamp="$(date +%Y%m%d)"
mkdir -p "$CLAUDE_DIR" "$AGENTS_DIR"
for d in "${SRC}"/*/; do
  n="$(basename "$d")"
  # shared install copy
  rsync -a --delete "$d" "$AGENTS_DIR/$n/"
  # Claude: symlink straight at the vendored copy
  if [ -e "$CLAUDE_DIR/$n" ] && [ ! -L "$CLAUDE_DIR/$n" ]; then
    mkdir -p "$(dirname "$CLAUDE_DIR")/skills-parked"
    mv "$CLAUDE_DIR/$n" "$(dirname "$CLAUDE_DIR")/skills-parked/$n.bak-$stamp"
  fi
  ln -sfn "${SRC}/$n" "$CLAUDE_DIR/$n"
  # Hermes: link to the shared copy
  if [ -d "$HERMES_DIR" ]; then
    if [ -e "$HERMES_DIR/$n" ] && [ ! -L "$HERMES_DIR/$n" ]; then
      rsync -a --delete "$d" "$HERMES_DIR/$n/"
    else
      ln -sfn "../../.agents/skills/$n" "$HERMES_DIR/$n"
    fi
  fi
done
check
