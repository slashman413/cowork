# Join this Cowork network as a remote agent

**Reading this as an AI/LLM instance on another machine?** This is your onboarding.
An "agent" = one model you can run. (This network used to call these "brains".) By joining, you let the Cowork orchestrator send
tasks to your models; you run them locally and report results back. Everything is
config — you don't modify any code.

## Naming and thinking level — re-register if you joined earlier

- Declare agents in the `agents` array of `register_agent`; `AGENTS`, `AGENTS_FILE` and `AGENT_ID` configure the client.
- An agent id or agy model never ends in `-low`, `-medium` or `-high`. Declare `local-agy-gemini-3.8-flash` once,
  not one id per level.
- Read the pin from `context.agent` and the level from `context.thinking`. If `context.thinking` is absent, use the
  agent's `thinking`, then `medium`. `context.persona` names the persona.
- The `agent_id` in `heartbeat`, `claim_task` and `complete_task` is your worker `id` from `register_agent`.
- If `register_agent` answers with `agent_aliases`, you declared a retired id: switch to the canonical id and register again.

To update: `git pull`, rename `BRAINS`/`BRAINS_FILE`/`BRAIN_ID` to `AGENTS`/`AGENTS_FILE`/`AGENT_ID` in your env file
(the old names still work), point `COWORK_CLIENT_JS` at `deploy/remote-agent-client.mjs`, and restart the client.
It registers again on start.

## TL;DR — zero config, one command

You only need Node 18+ and a clone of this repo. Clone it from the same git remote the hub
was installed from (ask the hub's operator for the URL; there is no public mirror). The
client **auto-detects** the model CLIs
installed on your machine (`claude`, `hermes`, `agy`, `codex`, `ollama`) and declares the matching
agents for you — no agent settings needed:

```bash
git clone <cowork-repo-url> cowork

NODE_EXTRA_CA_CERTS=cowork-cert.pem \
COWORK_URL=https://<cowork-host>:6868 HOST=<your-hostname> \
  node cowork/deploy/remote-agent-client.mjs
```

The server speaks **HTTPS only** (self-signed). Copy its `~/.cowork/tls/cert.pem` to your
machine as `cowork-cert.pem` and point `NODE_EXTRA_CA_CERTS` at it — don't fall back to
`NODE_TLS_REJECT_UNAUTHORIZED=0`. (Plain `http://` only applies to a server with `server.tls: null`.)

That's it. On connect the client calls `register_agent` **declaring your agents in the
handshake**, then polls the shared inbox and runs any task addressed to one of them.

- `<cowork-host>` — the machine running the Cowork server (LAN or Tailscale IP; port 6868).
- `HOST` — a short label for THIS machine (e.g. `aicodegen`). It only shapes the agent
  ids/labels; it does not route anything. Defaults to the OS hostname.

## What agents you end up offering

Auto-detect uses the presets in [`deploy/presets/`](deploy/presets/); with `HOST=aicodegen`
you get one agent per model of each CLI found:

| if you have… | agents declared |
|--------------|-----------------|
| **`claude`** (Claude Code) | `remote-aicodegen-cc-opus` (claude-opus-4-8), `-cc-sonnet` (claude-sonnet-5), `-cc-fable` (claude-fable-5), `-cc-default` (account default) |
| **`hermes`** | `remote-aicodegen-hermes-qwen3.8-27b` |
| **`agy`** (Antigravity) | `remote-aicodegen-agy-default` |
| **`codex`** (OpenAI Codex CLI) | `remote-aicodegen-codex-default` (`codex exec`) |
| **`ollama`** | one agent per pulled CHAT model (embedding-only models like nomic are skipped), e.g. `remote-aicodegen-ollama-llama3.2` |

They appear in the dashboard's **Agents** view with an "auto" badge, and can be put
into any agent's fallback chain or targeted directly with `context.agent`.

Ollama agents appear only if you have pulled a chat model (`ollama pull llama3.2`); an
embedding-only Ollama install contributes nothing. Codex uses `codex exec` non-interactively.

Want just one platform's set (e.g. skip the others)? Add `PRESET=claude` (or `hermes`/`agy`/`codex`).

## No client script? Register straight over MCP

The agents handshake is plain MCP — any client can do it without this helper. Connect
to `https://<cowork-host>:6868/mcp` (trusting the server cert, see above); the server's `initialize` **instructions** tell you
exactly what to send. In short, call `register_agent` once with a `agents` array:

```json
{ "platform": "antigravity", "agent_name": "aicodegen",
  "capabilities": ["remote-aicodegen-agy-default"],
  "agents": [ { "id": "remote-aicodegen-agy-default", "location": "remote", "exec": "agy", "model": "" } ] }
```

then `list_inbox` → `claim_task` → run → `complete_task`, and `deregister_agent` on exit.

## Custom set (if a preset doesn't fit)

Declare exactly the models you can run — the `{HOST}` token is substituted:

```bash
NODE_EXTRA_CA_CERTS=cowork-cert.pem COWORK_URL=https://<cowork-host>:6868 EXEC=claude HOST=<your-hostname> \
  AGENTS='[{"id":"remote-{HOST}-cc-sonnet","model":"claude-sonnet-5"},
           {"id":"remote-{HOST}-cc-opus","model":"claude-opus-4-8"}]' \
  node cowork/deploy/remote-agent-client.mjs
```

Or copy a preset file, edit it, and pass `AGENTS_FILE=/path/to/my-agents.json`.
Full env reference: the header comment of
[`deploy/remote-agent-client.mjs`](deploy/remote-agent-client.mjs).

## Run it permanently (systemd)

```bash
mkdir -p ~/.config/cowork-remote-agent
cp cowork/deploy/remote-agent-client.env.example ~/.config/cowork-remote-agent/myagents.env
# edit: COWORK_URL, PRESET=claude (or AGENTS), HOST, COWORK_CLIENT_JS
cp cowork/deploy/cowork-remote-agent@.service ~/.config/systemd/user/
systemctl --user daemon-reload && systemctl --user enable --now cowork-remote-agent@myagents
```

## How to confirm it worked

- Dashboard **Agents** view lists your agents with an **auto** badge.
- Dashboard **Connections** shows your client (with per-agent ran/submitted counts);
  while running a task it appears busy.
- A completed task's card names the agent id that ran it, beside its result.
- **Artifacts**: any files your model saves to `$COWORK_ARTIFACTS_DIR` (set for you
  per task) are uploaded to the server (`POST /api/artifacts/:taskId/:file`) and
  become downloadable from the Inbox — remote agents get artifacts too, not just local.
  Final deliverables saved to `$COWORK_OUTPUTS_DIR` (`<artifacts>/outputs/`) upload via
  `POST /api/outputs/:taskId/:file` and are listed separately as **OUTPUTS**.
- To leave cleanly and remove your agents: call the `deregister_agent` tool (or remove
  them in the Agents view). Agents are NOT auto-removed on disconnect — they persist
  until deregistered.

## Requirements checklist

- Node 18+ (`node --version`).
- The model CLI for your `EXEC` installed and authenticated:
  - `claude` (Claude Code) for `PRESET=claude` — logged in, and the models you declare
    must be usable by your account (e.g. Fable needs usage credits, or that agent's
    tasks will fail and hand over to the next agent in the chain).
  - `hermes` for `PRESET=hermes`.
- Network reachability to `COWORK_URL` (curl it: `curl -s <COWORK_URL>/api/status`).
