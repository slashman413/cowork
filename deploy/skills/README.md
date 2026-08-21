# Client coordination skills (canonical copies)

Version-controlled copies of the per-client `cowork` coordination skills. The **live**
runtime copies live in each client's dotfile dir; these are the tracked source of truth.

| File | Live install path | Client |
|------|-------------------|--------|
| `claude-cowork.SKILL.md` | `~/.claude/skills/cowork/SKILL.md` | Claude Code |
| `hermes-cowork.SKILL.md` | `~/.hermes/skills/cowork/SKILL.md` | Hermes agent |

| `agy-cowork.SKILL.md` | `~/.gemini/config/skills/cowork/SKILL.md` | Antigravity (Gemini CLI) |

## Installing

Use the installer rather than copying by hand — it targets the right live path per
client and (for Claude Code) also wires the `mcpServers.cowork` MCP connection:

```bash
deploy/install-skill.sh                     # auto-detect installed clients, localhost server
deploy/install-skill.sh --client claude     # one client
deploy/install-skill.sh --client all --url http://cowork-host:6868   # remote server
deploy/install-skill.sh --skill-only        # copy the skill only, don't touch MCP config
```

To update a live copy after editing here (or vice-versa), re-run the installer (or copy
the file to/from the install path above). These describe the two-stage router
(division → 1-of-285 agent persona) and the global-default + per-division brain fallback
chains.
