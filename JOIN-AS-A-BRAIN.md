# Join this Cowork network as a remote brain

**Reading this as an AI/LLM instance on another machine?** This is your onboarding.
A "brain" = one model you can run. By joining, you let the Cowork orchestrator send
tasks to your models; you run them locally and report results back. Everything is
config — you don't modify any code.

## TL;DR — zero config, one command

You only need Node 18+ and this repo. The client **auto-detects** the model CLIs
installed on your machine (`claude`, `hermes`, `agy`) and declares the matching
brains for you — no brain settings needed:

```bash
git clone https://github.com/slashman413/cowork
NODE_EXTRA_CA_CERTS=cowork-cert.pem \
COWORK_URL=https://<cowork-host>:6868 HOST=<your-hostname> \
  node cowork/deploy/remote-brain-client.mjs
```

The server speaks **HTTPS only** (self-signed). Copy its `~/.cowork/tls/cert.pem` to your
machine as `cowork-cert.pem` and point `NODE_EXTRA_CA_CERTS` at it — don't fall back to
`NODE_TLS_REJECT_UNAUTHORIZED=0`. (Plain `http://` only applies to a server with `server.tls: null`.)

That's it. On connect the client calls `register_agent` **declaring your brains in the
handshake**, then polls the shared inbox and runs any task addressed to one of them.

- `<cowork-host>` — the machine running the Cowork server (LAN or Tailscale IP; port 6868).
- `HOST` — a short label for THIS machine (e.g. `aicodegen`). It only shapes the brain
  ids/labels; it does not route anything. Defaults to the OS hostname.

## What brains you end up offering

Auto-detect uses the presets in [`deploy/presets/`](deploy/presets/); with `HOST=aicodegen`
you get one brain per model of each CLI found:

| if you have… | brains declared |
|--------------|-----------------|
| **`claude`** (Claude Code) | `remote-aicodegen-cc-opus` (claude-opus-5-5), `-cc-sonnet` (claude-sonnet-5-5), `-cc-fable` (claude-fable-5-1), `-cc-default` (account default) |
| **`hermes`** | `remote-aicodegen-ha-qwen3-8-27b` |
| **`agy`** (Antigravity) | `remote-aicodegen-agy-default` |
| **`codex`** (OpenAI Codex CLI) | `remote-aicodegen-codex-default` (`codex exec`) |
| **`ollama`** | one brain per pulled CHAT model (embedding-only models like nomic are skipped), e.g. `remote-aicodegen-ollama-llama3.2` |

They appear in the dashboard's **Brains** view with an "auto" badge, and can be put
into any agent's fallback chain or targeted directly with `context.brain`.

Ollama brains appear only if you have pulled a chat model (`ollama pull llama3.2`); an
embedding-only Ollama install contributes nothing. Codex uses `codex exec` non-interactively.

Want just one platform's set (e.g. skip the others)? Add `PRESET=claude` (or `hermes`/`agy`).

## No client script? Register straight over MCP

The brains handshake is plain MCP — any client can do it without this helper. Connect
to `https://<cowork-host>:6868/mcp` (trusting the server cert, see above); the server's `initialize` **instructions** tell you
exactly what to send. In short, call `register_agent` once with a `brains` array:

```json
{ "platform": "antigravity", "agent_name": "aicodegen",
  "capabilities": ["remote-aicodegen-agy-default"],
  "brains": [ { "id": "remote-aicodegen-agy-default", "location": "remote", "exec": "agy", "model": "" } ] }
```

then `list_inbox` → `claim_task` → run → `complete_task`, and `deregister_agent` on exit.

## Custom set (if a preset doesn't fit)

Declare exactly the models you can run — the `{HOST}` token is substituted:

```bash
NODE_EXTRA_CA_CERTS=cowork-cert.pem COWORK_URL=https://<cowork-host>:6868 EXEC=claude HOST=<your-hostname> \
  BRAINS='[{"id":"remote-{HOST}-cc-sonnet","model":"claude-sonnet-5-5"},
           {"id":"remote-{HOST}-cc-opus","model":"claude-opus-5-5"}]' \
  node cowork/deploy/remote-brain-client.mjs
```

Or copy a preset file, edit it, and pass `BRAINS_FILE=/path/to/my-brains.json`.
Full env reference: the header comment of
[`deploy/remote-brain-client.mjs`](deploy/remote-brain-client.mjs).

## Run it permanently (systemd)

```bash
mkdir -p ~/.config/cowork-remote-brain
cp cowork/deploy/remote-brain-client.env.example ~/.config/cowork-remote-brain/mybrains.env
# edit: COWORK_URL, PRESET=claude (or BRAINS), HOST, COWORK_CLIENT_JS
cp cowork/deploy/cowork-remote-brain@.service ~/.config/systemd/user/
systemctl --user daemon-reload && systemctl --user enable --now cowork-remote-brain@mybrains
```

## How to confirm it worked

- Dashboard **Brains** view lists your brains with an **auto** badge.
- Dashboard **Connections** shows your client (with per-brain ran/submitted counts);
  while running a task it appears busy.
- A completed task's card names the brain id that ran it, beside its result.
- **Artifacts**: any files your model saves to `$COWORK_ARTIFACTS_DIR` (set for you
  per task) are uploaded to the server (`POST /api/artifacts/:taskId/:file`) and
  become downloadable from the Inbox — remote brains get artifacts too, not just local.
- To leave cleanly and remove your brains: call the `deregister_agent` tool (or remove
  them in the Brains view). Brains are NOT auto-removed on disconnect — they persist
  until deregistered.

## Requirements checklist

- Node 18+ (`node --version`).
- The model CLI for your `EXEC` installed and authenticated:
  - `claude` (Claude Code) for `PRESET=claude` — logged in, and the models you declare
    must be usable by your account (e.g. Fable needs usage credits, or that brain's
    tasks will fail and hand over to the next brain in the chain).
  - `hermes` for `PRESET=hermes`.
- Network reachability to `COWORK_URL` (curl it: `curl -s <COWORK_URL>/api/status`).
