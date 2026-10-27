#!/usr/bin/env bash
# install-skill.sh — install the Cowork coordination skill into an AI agent client
# and (for Claude Code) wire the MCP server connection, so any agent on this box can
# register, dispatch, claim, and report through the hub.
#
# What it does, per client:
#   1. Copies the canonical skill  deploy/skills/<client>-cowork.SKILL.md
#      → the client's live skill dir (see table below).
#   2. Wires the MCP server entry so the client actually exposes the cowork tools:
#        - Claude Code: merged into ~/.claude.json automatically (JSON-safe, non-destructive).
#        - Hermes / Antigravity: prints the exact snippet to paste (config path varies).
#
#   Client | live skill path                          | MCP config
#   -------+------------------------------------------+---------------------------
#   claude | ~/.claude/skills/cowork/SKILL.md          | ~/.claude.json  (auto)
#   hermes | ~/.hermes/skills/cowork/SKILL.md          | snippet printed
#   agy    | ~/.gemini/config/skills/cowork/SKILL.md   | snippet printed
#
# Usage:
#   deploy/install-skill.sh                         # auto-detect installed clients
#   deploy/install-skill.sh --client claude         # one client
#   deploy/install-skill.sh --client all            # every known client
#   deploy/install-skill.sh --url http://box:6868   # non-default server URL
#   deploy/install-skill.sh --key <hub api key>     # send "Authorization: Bearer <key>" (default: $COWORK_API_KEY)
#   deploy/install-skill.sh --skill-only            # copy skill, don't touch MCP config
#   deploy/install-skill.sh --mcp-only              # wire MCP config, don't copy skill
#
# Idempotent: re-running just refreshes the skill file and leaves other MCP servers alone.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SKILLS_DIR="$REPO/deploy/skills"

CLIENT=""            # empty => auto-detect
URL="https://localhost:6868"
KEY="${COWORK_API_KEY:-}"
DO_SKILL=1
DO_MCP=1

while [ $# -gt 0 ]; do
  case "$1" in
    --client)     CLIENT="${2:-}"; shift 2 ;;
    --url)        URL="${2:-}"; shift 2 ;;
    --key)        KEY="${2:-}"; shift 2 ;;
    --skill-only) DO_MCP=0; shift ;;
    --mcp-only)   DO_SKILL=0; shift ;;
    -h|--help)    sed -n '2,30p' "$0"; exit 0 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

URL="${URL%/}"           # trim trailing slash
MCP_URL="$URL/mcp"

# client → live skill path (relative to $HOME)
skill_path() {
  case "$1" in
    claude) echo "$HOME/.claude/skills/cowork/SKILL.md" ;;
    hermes) echo "$HOME/.hermes/skills/cowork/SKILL.md" ;;
    agy)    echo "$HOME/.gemini/config/skills/cowork/SKILL.md" ;;
  esac
}
# client → canonical source skill in the repo
skill_src() { echo "$SKILLS_DIR/$1-cowork.SKILL.md"; }

# Is a client present on this machine? (dotfile dir OR CLI on PATH)
detect() {
  case "$1" in
    claude) [ -d "$HOME/.claude" ] || command -v claude >/dev/null 2>&1 ;;
    hermes) [ -d "$HOME/.hermes" ] || command -v hermes >/dev/null 2>&1 ;;
    agy)    [ -d "$HOME/.gemini" ] || command -v agy >/dev/null 2>&1 || command -v gemini >/dev/null 2>&1 ;;
  esac
}

install_skill() {
  local c="$1" src dst
  src="$(skill_src "$c")"; dst="$(skill_path "$c")"
  if [ ! -f "$src" ]; then echo "  ! no canonical skill for '$c' ($src) — skipping"; return; fi
  mkdir -p "$(dirname "$dst")"
  cp "$src" "$dst"
  echo "  ✓ skill → $dst"
}

# Merge { mcpServers.cowork } into ~/.claude.json without clobbering the rest.
wire_claude_mcp() {
  local cfg="$HOME/.claude.json"
  node -e '
    const fs = require("fs");
    const [cfg, url, key] = [process.argv[1], process.argv[2], process.argv[3]];
    let j = {};
    try { j = JSON.parse(fs.readFileSync(cfg, "utf8")); } catch {}
    j.mcpServers = j.mcpServers || {};
    j.mcpServers.cowork = { url, transport: "streamable-http",
      ...(key ? { headers: { Authorization: "Bearer " + key } } : {}) };
    fs.writeFileSync(cfg, JSON.stringify(j, null, 2) + "\n", { mode: 0o600 });
  ' "$cfg" "$MCP_URL" "$KEY"
  echo "  ✓ MCP  → $cfg  (mcpServers.cowork = $MCP_URL${KEY:+, with API key header})"
}

wire_mcp() {
  local c="$1"
  case "$c" in
    claude)
      if command -v node >/dev/null 2>&1; then wire_claude_mcp
      else echo "  ! node not found — add manually to ~/.claude.json: mcpServers.cowork.url = $MCP_URL"; fi ;;
    hermes)
      echo "  → add to ~/.hermes/config.yaml mcp_servers:  cowork: { transport: http, url: $MCP_URL${KEY:+, headers: { Authorization: \"Bearer <key>\" \}} }" ;;
    agy)
      echo "  → add to your Antigravity MCP config:  \"mcpServers\": { \"cowork\": { \"url\": \"$MCP_URL\"${KEY:+, \"headers\": { \"Authorization\": \"Bearer <key>\" \}} } }" ;;
  esac
}

# Resolve target list.
ALL="claude hermes agy"
if [ -n "$CLIENT" ] && [ "$CLIENT" != "all" ]; then
  TARGETS="$CLIENT"
elif [ "$CLIENT" = "all" ]; then
  TARGETS="$ALL"
else
  TARGETS=""
  for c in $ALL; do detect "$c" && TARGETS="$TARGETS $c"; done
  TARGETS="$(echo "$TARGETS" | xargs || true)"
  if [ -z "$TARGETS" ]; then
    echo "No known agent clients detected (~/.claude, ~/.hermes, ~/.gemini)."
    echo "Pass one explicitly, e.g.:  $0 --client claude"
    exit 1
  fi
  echo "Detected clients: $TARGETS"
fi

echo "Cowork server URL: $URL"
for c in $TARGETS; do
  echo "[$c]"
  [ "$DO_SKILL" = 1 ] && install_skill "$c"
  [ "$DO_MCP"   = 1 ] && wire_mcp "$c"
done

echo
echo "Done. Restart the client if it was running so it picks up the skill + MCP server."
echo "Verify:  curl -sk ${KEY:+-H \"Authorization: Bearer \$COWORK_API_KEY\" }$URL/api/status   (server must be up — see deploy/install-server.sh)"
