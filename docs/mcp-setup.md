# MCP Client Setup Recipes

Connect **Claude Code**, **Cursor**, **Cline**, **Windsurf**, and any other MCP-compatible client to a **Cowork MCP** hub in under a minute.

Cowork speaks standard **MCP over Streamable HTTP** at `http://<host>:6868/mcp` (default port `6868`). Every client below supports either:

1. **Direct Streamable HTTP** (recommended — fastest startup, zero proxy process), or
2. **`npx -y mcp-remote` stdio bridge** (for older client versions or strict stdio-only setups).

---

## Step 1: Start the Cowork MCP Hub

Pick **Node.js (local)** or **Docker (containerized hub)**:

### Option A — Node.js (local host, no API key required on `127.0.0.1`)

```bash
# Fast path (installs deps, builds, starts systemd user service)
git clone https://github.com/slashman413/cowork && cd cowork
deploy/install-server.sh

# Or run directly with Node.js (>= 20) in the foreground
cd server && npm ci && npm run build && npm start
```

- **MCP Endpoint:** `http://localhost:6868/mcp`
- **Dashboard:** `http://localhost:6868`
- **Auth:** None required when bound to loopback (`127.0.0.1`, the default in `config.json`).

### Option B — Docker (single command, hub-only container)

```bash
export COWORK_API_KEY="replace-with-strong-random-token"

docker run -d --name cowork-mcp \
  -p 6868:6868 \
  -e COWORK_API_KEY="$COWORK_API_KEY" \
  -v cowork-data:/data \
  ghcr.io/slashman413/cowork:1.0.2
```

Building locally from source instead of pulling from GHCR:

```bash
docker build -t cowork-server:local .
docker run -d --name cowork-mcp \
  -p 6868:6868 \
  -e COWORK_API_KEY="$COWORK_API_KEY" \
  -v cowork-data:/data \
  cowork-server:local
```

- **MCP Endpoint:** `http://localhost:6868/mcp`
- **Auth:** Because the container binds `0.0.0.0`, `/mcp` and `/api` require `Authorization: Bearer <COWORK_API_KEY>` (or `X-API-Key: <key>`). If you omit `-e COWORK_API_KEY`, Cowork generates a key into `/data/api-key` and prints it once in `docker logs cowork-mcp`.
- **Dashboard login:** Open `http://localhost:6868/?apiKey=<COWORK_API_KEY>` once to set the session cookie.
- **Custom / PaaS ports:** Set `-e COWORK_PORT=7000` (or standard `-e PORT=8081`, used by Smithery and PaaS hosts; `COWORK_PORT` takes precedence over `PORT`).

Verify the hub is healthy before wiring clients:

```bash
# Local Node.js (loopback, no auth)
curl -sf http://localhost:6868/api/status

# Docker / non-loopback hub (with API key)
curl -sf -H "Authorization: Bearer $COWORK_API_KEY" http://localhost:6868/api/status
```

---

## Step 2: Wire Your MCP Client

### Client Config Paths at a Glance

| Client | Config File Path | Transport Key |
|--------|------------------|---------------|
| **Claude Code** | `~/.claude.json` (user) or `.mcp.json` (project) | `url` + `transport: "streamable-http"` (or `claude mcp add`) |
| **Cursor** | `~/.cursor/mcp.json` (global) or `.cursor/mcp.json` (project) | `url` |
| **Cline** | `cline_mcp_settings.json` (VS Code `globalStorage/saoudrizwan.claude-dev/settings/`) | `url` + `type: "streamableHttp"` |
| **Windsurf** | `~/.codeium/windsurf/mcp_config.json` | `serverUrl` (`url` on older builds) |

---

## 1. Claude Code

### One-command CLI setup (recommended)

**Against a local Node.js hub (no API key):**

```bash
claude mcp add --transport http cowork http://localhost:6868/mcp
```

**Against a Docker or remote hub (with Bearer auth):**

```bash
claude mcp add --transport http cowork http://localhost:6868/mcp \
  --header "Authorization: Bearer $COWORK_API_KEY"
```

**Install the Cowork skill + MCP config in one step (from the repo root):**

```bash
deploy/install-skill.sh --client claude --url http://localhost:6868 --key "$COWORK_API_KEY"
```

Verify the connection:

```bash
claude mcp list
```

### Config snippet (`~/.claude.json` or project `.mcp.json`)

**Local Node.js hub (Streamable HTTP):**

```json
{
  "mcpServers": {
    "cowork": {
      "url": "http://localhost:6868/mcp",
      "transport": "streamable-http"
    }
  }
}
```

**Docker / remote hub (Streamable HTTP with API key):**

```json
{
  "mcpServers": {
    "cowork": {
      "url": "http://localhost:6868/mcp",
      "transport": "streamable-http",
      "headers": {
        "Authorization": "Bearer YOUR_COWORK_API_KEY"
      }
    }
  }
}
```

**`npx` stdio bridge fallback (`mcp-remote`):**

```json
{
  "mcpServers": {
    "cowork": {
      "command": "npx",
      "args": [
        "-y",
        "mcp-remote",
        "http://localhost:6868/mcp",
        "--header",
        "Authorization:Bearer YOUR_COWORK_API_KEY"
      ]
    }
  }
}
```

---

## 2. Cursor

Add one of the blocks below to **`~/.cursor/mcp.json`** (all projects) or **`.cursor/mcp.json`** (workspace root), then reload MCP servers in **Cursor Settings → Tools & MCP**.

### Local Node.js hub (Streamable HTTP)

```json
{
  "mcpServers": {
    "cowork": {
      "url": "http://localhost:6868/mcp"
    }
  }
}
```

### Docker / remote hub (Streamable HTTP with API key)

Cursor supports `${env:VAR_NAME}` interpolation so secrets stay out of project files:

```json
{
  "mcpServers": {
    "cowork": {
      "url": "http://localhost:6868/mcp",
      "headers": {
        "Authorization": "Bearer ${env:COWORK_API_KEY}"
      }
    }
  }
}
```

### `npx` stdio bridge (`mcp-remote`)

Use this if you are on an older Cursor build without native Streamable HTTP or prefer a stdio-managed process:

```json
{
  "mcpServers": {
    "cowork": {
      "command": "npx",
      "args": [
        "-y",
        "mcp-remote",
        "http://localhost:6868/mcp",
        "--header",
        "Authorization:Bearer ${COWORK_API_KEY}"
      ],
      "env": {
        "COWORK_API_KEY": "YOUR_COWORK_API_KEY"
      }
    }
  }
}
```

---

## 3. Cline (VS Code Extension)

Open **Cline → MCP Servers → Remote Servers / Configure MCP Servers**, or edit `cline_mcp_settings.json` directly:

- **macOS:** `~/Library/Application Support/Code/User/globalStorage/saoudrizwan.claude-dev/settings/cline_mcp_settings.json`
- **Linux:** `~/.config/Code/User/globalStorage/saoudrizwan.claude-dev/settings/cline_mcp_settings.json`
- **Windows:** `%APPDATA%\Code\User\globalStorage\saoudrizwan.claude-dev\settings\cline_mcp_settings.json`

### Local Node.js hub (Streamable HTTP)

```json
{
  "mcpServers": {
    "cowork": {
      "url": "http://localhost:6868/mcp",
      "type": "streamableHttp",
      "disabled": false,
      "autoApprove": []
    }
  }
}
```

### Docker / remote hub (Streamable HTTP with API key)

```json
{
  "mcpServers": {
    "cowork": {
      "url": "http://localhost:6868/mcp",
      "type": "streamableHttp",
      "headers": {
        "Authorization": "Bearer YOUR_COWORK_API_KEY"
      },
      "disabled": false,
      "autoApprove": []
    }
  }
}
```

### `npx` stdio bridge (`mcp-remote`)

```json
{
  "mcpServers": {
    "cowork": {
      "command": "npx",
      "args": [
        "-y",
        "mcp-remote",
        "http://localhost:6868/mcp",
        "--header",
        "Authorization:Bearer YOUR_COWORK_API_KEY"
      ],
      "disabled": false,
      "autoApprove": []
    }
  }
}
```

---

## 4. Windsurf (Cascade)

Open **Windsurf Settings → Cascade → MCP Servers → View raw config**, or edit **`~/.codeium/windsurf/mcp_config.json`** directly.

### Local Node.js hub (Streamable HTTP)

```json
{
  "mcpServers": {
    "cowork": {
      "serverUrl": "http://localhost:6868/mcp"
    }
  }
}
```

> **Note:** Recent Windsurf builds use `"serverUrl"` for Streamable HTTP endpoints. If your version rejects `"serverUrl"`, replace it with `"url"`.

### Docker / remote hub (Streamable HTTP with API key)

```json
{
  "mcpServers": {
    "cowork": {
      "serverUrl": "http://localhost:6868/mcp",
      "headers": {
        "Authorization": "Bearer ${env:COWORK_API_KEY}"
      }
    }
  }
}
```

### `npx` stdio bridge (`mcp-remote`)

```json
{
  "mcpServers": {
    "cowork": {
      "command": "npx",
      "args": [
        "-y",
        "mcp-remote",
        "http://localhost:6868/mcp",
        "--header",
        "Authorization:Bearer ${COWORK_API_KEY}"
      ],
      "env": {
        "COWORK_API_KEY": "YOUR_COWORK_API_KEY"
      }
    }
  }
}
```

---

## Smithery Container Deployment

Cowork ships a root [`smithery.yaml`](../smithery.yaml) paired with [`Dockerfile`](../Dockerfile) (`runtime: "container"`, `startCommand.type: "http"`):

- **Entrypoint:** `WORKDIR /app/server` → `CMD ["node", "dist/index.js"]`
- **Endpoint:** Streamable HTTP MCP at `/mcp`
- **Port binding:** Binds `0.0.0.0` and checks `COWORK_PORT` first, then standard `PORT` (injected by Smithery and PaaS runtimes), falling back to `6868`.
- **Auth:** Pass `COWORK_API_KEY` for deterministic Bearer auth; if omitted, Cowork generates a key into `/data/api-key` on first boot.
- **Reverse-proxy host allowlist:** Set `COWORK_ALLOWED_HOSTS` (comma-separated hostnames) when terminating TLS or routing through a custom domain.

---

## Verification & Troubleshooting

### Interactive MCP Inspector

```bash
npx @modelcontextprotocol/inspector http://localhost:6868/mcp
```

### Direct JSON-RPC Smoke Test

```bash
curl -s -X POST http://localhost:6868/mcp \
  -H "Authorization: Bearer $COWORK_API_KEY" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
```

Omit the `Authorization` header when talking to a local loopback (`127.0.0.1`) Node.js server with no API key configured.

### Common Errors & Exact Fixes

| Symptom | Cause | Fix |
|---------|-------|-----|
| `HTTP 401 {"error":"unauthorized"}` | Server is bound to `0.0.0.0` (e.g. Docker) and requires a Bearer token | Pass `-H "Authorization: Bearer <key>"` in client `headers`. Find the auto-generated key with `docker logs cowork-mcp` or `docker exec cowork-mcp cat /data/api-key`. |
| `HTTP 421 {"error":"host not allowed"}` | Request `Host` header is not in the DNS-rebinding allowlist | Add your hostname to `COWORK_ALLOWED_HOSTS` (comma-separated) and restart the server. |
| `HTTP 406 Not Acceptable` on `curl` | Streamable HTTP requires `Accept: application/json, text/event-stream` | Include `-H "Accept: application/json, text/event-stream"` in manual HTTP probes. |
| Self-signed HTTPS cert rejected by `npx mcp-remote` or Node clients | Hub uses a self-signed TLS cert | Copy `~/.cowork/tls/cert.pem` to the client machine and set `NODE_EXTRA_CA_CERTS=/path/to/cert.pem` (or switch to a Tailscale Let's Encrypt cert via `deploy/update-tailscale-cert.sh`). |
| Tools don't show up after editing JSON | Client caches MCP server config on startup | Fully reload or restart Cursor / Cline / Windsurf, or run `claude mcp list` to verify connection state. |
