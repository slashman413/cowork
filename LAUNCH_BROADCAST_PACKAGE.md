# Cowork Launch Broadcast Package

**Target Channels:** Reddit (r/LocalLLaMA), Discord (LocalAI / MCP / Agent communities), X / Twitter  
**Repository:** https://github.com/slashman413/cowork  
**Current Baseline Metrics:** 3 Stars, 1 Fork, 0 Watchers  

---

## 1. Reddit r/LocalLLaMA Launch Package

### Recommended Flair
`Resource / Guide` or `Project` / `Discussion`

### Post Title
```text
We built Cowork: an open-source, local-first multi-agent orchestration framework with native MCP tool calling and multi-model dispatch
```

### Post Body (Markdown)

```markdown
Hey r/LocalLLaMA,

Over the past few months, we've been running complex multi-agent workflows locally across mixed setups (local models via Ollama and local CLI runners alongside frontier API providers). Most existing agent frameworks either treat agents as isolated chat loops or lock you into cloud-hosted platforms with heavy vendor lock-in and database bloat.

We built **[Cowork](https://github.com/slashman413/cowork)** to solve this: an open-source, local-first orchestration runtime designed to run multi-agent fleets with deterministic task lifecycles, full MCP (Model Context Protocol) integration, and zero external database requirements.

### What it does:
- 🛠 **Native MCP Server & Client:** Serves local Streamable HTTP MCP endpoints (`http://localhost:6868/mcp`) and stdio MCP, allowing any MCP-compatible agent or client to register, claim, and coordinate tasks.
- 🔀 **Automated Fallback Chains:** Automatically cascades tasks across fallback chains (e.g. Claude Code → Hermes → local Ollama) if an agent hits rate limits, quota exhaustion, or timeouts.
- ⚡ **Heterogeneous Routing:** Mix local models (e.g. Qwen 2.5 / Llama 3 via Ollama or local runners) for high-frequency subtasks and frontier models for reasoning/orchestration.
- 📦 **Artifact Isolation:** Deterministic task store where every task execution produces structured artifacts, logs, outputs, and status verification directly on disk (`artifacts/<task-id>/outputs/`).
- 📊 **Single-Pane-of-Glass Dark Dashboard:** Real-time host telemetry (CPU, GPU, RAM, thermals), active worker fleet status, streaming progress logs, and deliverable downloads on `http://localhost:6868`.
- 💻 **100% Local / Self-Hosted:** Plain JSON/Markdown file storage on disk. No Postgres, Mongo, or Redis required.

### Quick Start (Verified One-Shot Bootstrap):

Prerequisites: Linux / macOS, Node.js >= 20 and npm.

```bash
git clone https://github.com/slashman413/cowork.git
cd cowork

# 1) Build dependencies and launch the background MCP server + dark dashboard (systemd user service):
deploy/install-server.sh

# 2) Wire the Cowork MCP connection into your agent clients (Claude Code, Hermes, Antigravity):
deploy/install-skill.sh
```

Then navigate to **http://localhost:6868** in your browser to view the live dashboard and real-time task queue.

#### CLI Execution Options:
`deploy/install-server.sh` provides flexible runtime control depending on your environment:

| Command | Behavior |
|---|---|
| `deploy/install-server.sh` | Build dependencies & install + start systemd user service (`cowork-mcp.service`) |
| `deploy/install-server.sh --foreground` (or `--fg`) | Build dependencies and run directly in the current terminal (interactive, Ctrl-C to stop) |
| `deploy/install-server.sh --build-only` | Initialize submodules, install npm dependencies, compile TypeScript; exit without starting |
| `deploy/install-server.sh --no-build` | Skip npm install and TypeScript build; immediately launch via chosen mode |
| `deploy/install-server.sh --help` | Display usage instructions and available flags |

#### Running via Docker (Hub-Only Container):
If you prefer running a containerized hub without local agent CLIs:
```bash
docker run -d -p 6868:6868 -v cowork-data:/data ghcr.io/slashman413/cowork:1.0.1
```

### Repo & Code:
👉 **GitHub:** https://github.com/slashman413/cowork

We built this to solve our own headaches orchestrating local and cloud agents without SaaS lock-in. Everything is 100% MIT open source.

We'd love your feedback, architecture critique, and suggestions: what local model runners, CLI tools, or MCP servers would you like to see supported out of the box?
```

---

## 2. Discord Communities Launch Package
*(For servers like LocalLLaMA Discord, Latent Space, Anthropic/MCP Discord, Open Interpreter, Nous Research)*

### Message Copy:
```text
Hey everyone! 👋 We just open-sourced **Cowork** — a local-first multi-agent orchestration runtime with native Model Context Protocol (MCP) support.

If you're running fleets of local LLMs (Ollama / local runners) mixed with cloud models and need structured task dispatch, artifact isolation, and automatic fallback chains (e.g. Claude -> Hermes -> Ollama) without database bloat or SaaS lock-in, check it out:

🔗 GitHub: https://github.com/slashman413/cowork

Key highlights:
• Streamable HTTP MCP server & stdio support (`http://localhost:6868/mcp`)
• Automated one-shot service bootstrap (`deploy/install-server.sh` or Docker `ghcr.io/slashman413/cowork:1.0.1`)
• Zero external database — plain JSON & Markdown file store on disk
• Dark dashboard with live hardware telemetry (CPU/GPU/RAM/temp) and task inspector

Drop by the repo and let us know what you think or what model runners you'd like to connect!
```

---

## 3. X / Twitter Announcement Thread

### Tweet 1 (Hook + Link):
> Meet Cowork: an open-source, local-first multi-agent collaboration runtime with native Model Context Protocol (MCP) support. 🤖⚡
>
> Run autonomous agent swarms across local & frontier models with deterministic task lifecycles, artifact isolation, and zero database bloat.
>
> 🔗 https://github.com/slashman413/cowork
>
> 🧵👇

### Tweet 2 (Core Architecture):
> Why Cowork?
>
> 1️⃣ Dual MCP Support: Host Streamable HTTP MCP endpoints while integrating community tools natively
> 2️⃣ Hybrid Fleet: Route routine sub-tasks to local models (Ollama/Hermes) and complex tasks to frontier models
> 3️⃣ Fast One-Shot Setup: `deploy/install-server.sh` boots in seconds via systemd or `--foreground`
> 4️⃣ Sandboxed Artifacts: Clean, structured outputs and file tracking per task

### Tweet 3 (Call to Action):
> Everything is 100% MIT open source under TypeScript.
>
> Check out the repo, explore the architecture, and open an issue with your setup:
> https://github.com/slashman413/cowork

---

## 4. Operator Action Instructions

To execute this broadcast package, follow these step-by-step procedures:

1. **Reddit (r/LocalLLaMA)**:
   - Navigate to https://www.reddit.com/r/LocalLLaMA/submit
   - Select Post Type: **Post** (Markdown Editor)
   - Title: `We built Cowork: an open-source, local-first multi-agent orchestration framework with native MCP tool calling and multi-model dispatch`
   - Flair: Select `Resource / Guide` or `Project`
   - Body: Copy and paste the Markdown body in Section 1 above
   - Timing: Optimal posting window is Tuesday - Thursday between 13:00 - 16:00 UTC (09:00 - 12:00 EST)
   - Moderation / Engagement: Stay active for the first 2 hours to answer technical questions regarding local inference engines (Ollama/Hermes), hardware requirements, and MCP tool routing.

2. **Discord Communities**:
   - Post in designated `#showcase` or `#tools` channels in LocalLLaMA, Anthropic MCP, and Open Interpreter Discord servers.
   - Use the text from Section 2.

3. **X / Twitter**:
   - Post the 3-tweet thread from Section 3.
   - Tag relevant topics: `#LocalLLaMA #OpenSource #AI #MCP`.
