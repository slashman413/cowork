# Cowork Launch Broadcast Package

**Target Channels:** Reddit (r/LocalLLaMA), Discord (LocalAI / MCP / Agent communities), X / Twitter  
**Repository:** https://github.com/slashman413/cowork  
**Current Baseline Metrics:** 3 Stars, 1 Fork, 0 Watchers  

---

## 1. Reddit r/LocalLLaMA Launch Package

### Recommended Flair
`Resource / Guide` or `Discussion` / `Project`

### Post Title
> We built Cowork: an open-source, local-first multi-agent orchestration framework with native MCP tool calling and multi-model dispatch

### Post Body (Markdown)

```markdown
Hey r/LocalLLaMA,

Over the past few months, we've been running complex multi-agent workflows locally across mixed setups (local Ollama/vLLM/llama.cpp models alongside frontier API providers). Most existing frameworks either treat agents as isolated chat loops or lock you into cloud-hosted platforms with heavy vendor lock-in.

We built **[Cowork](https://github.com/slashman413/cowork)** to solve this: an open-source, local-first orchestration runtime designed to run multi-agent fleets with deterministic task lifecycles, full MCP (Model Context Protocol) integration, and zero fluff.

### What it does:
- 🛠 **Native MCP Server & Client:** Serves local MCP endpoints (`localhost:6868/mcp`) while seamlessly attaching existing MCP tool servers into agent context.
- 🤝 **Multi-Agent Collaboration:** Goal decomposition, peer communication, subagent hierarchies, and shared blackboard messaging boards.
- ⚡ **Heterogeneous Routing:** Mix local models (e.g. Qwen 2.5 / Llama 3 via local engines) for high-frequency subtasks and frontier models for reasoning/orchestration.
- 📦 **Artifact Isolation:** Deterministic task store where every task execution produces structured artifacts, logs, outputs, and status verification.
- 💻 **100% Local / Self-Hosted:** Run your tasks locally without forced cloud telemetry.

### Quick Start (Verified One-Shot Bootstrap):

Prerequisites: Node.js >= 20 and npm.

```bash
git clone https://github.com/slashman413/cowork.git
cd cowork

# 1) Build and start background systemd user service (default, auto-resolves paths):
deploy/install-server.sh

# 2) Wire the Cowork MCP connection into your agent clients (Claude Code, Hermes, Antigravity):
deploy/install-skill.sh
```

Then navigate to **http://localhost:6868** to view the dark dashboard and real-time task inbox.

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

### Repo & Docs:
👉 **GitHub:** https://github.com/slashman413/cowork

We'd love your thoughts, feedback, and feature requests. What pain points do you hit most when orchestrating local agent fleets with MCP?
```

---

## 2. Discord Communities Launch Package
*(For servers like LocalLLaMA Discord, Latent Space, Anthropic/MCP Discord, Open Interpreter, CrewAI/AutoGPT Discord)*

### Message Copy:
```text
Hey everyone! 👋 We just open-sourced **Cowork** — a local-first multi-agent collaboration framework with full Model Context Protocol (MCP) support.

If you're running fleets of local LLMs (Ollama/vLLM/llama.cpp) mixed with cloud models and need structured task dispatch, artifact isolation, and MCP tool orchestration without SaaS lock-in, check it out:

🔗 GitHub: https://github.com/slashman413/cowork

Key highlights:
• Dual MCP architecture (acts as both MCP server and client host)
• Automated one-shot service bootstrap (`deploy/install-server.sh` / `--foreground`)
• Modular subagent dispatch & shared message boards
• Built for local-first developer ergonomics

Drop by the repo and let us know what you think or what integrations you'd like to see!
```

---

## 3. X / Twitter Announcement Thread

### Tweet 1 (Hook + Link):
> Meet Cowork: an open-source, local-first multi-agent collaboration runtime with native Model Context Protocol (MCP) support. 🤖⚡
>
> Run autonomous agent swarms across local & frontier models with deterministic task lifecycles and tool calling.
>
> 🔗 https://github.com/slashman413/cowork
>
> 🧵👇

### Tweet 2 (Core Architecture):
> Why Cowork?
>
> 1️⃣ Dual MCP Support: Host MCP servers while consuming community tools natively
> 2️⃣ Hybrid Fleet: Route routine sub-tasks to local LLMs (Qwen/Llama) and complex tasks to frontier models
> 3️⃣ Fast One-Shot Setup: `deploy/install-server.sh` boots in seconds via systemd or `--foreground`
> 4️⃣ Sandboxed Artifacts: Clean, structured outputs and task tracking

### Tweet 3 (Call to Action):
> Everything is 100% open source under TypeScript.
>
> Check out the repo, star if you find it useful, and open an issue with your setup:
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
   - Moderation / Engagement: Stay active for the first 2 hours to answer technical questions regarding local inference engines (Ollama/vLLM), hardware requirements, and MCP tool routing.

2. **Discord Communities**:
   - Post in designated `#showcase` or `#tools` channels in LocalLLaMA, Anthropic MCP, and Open Interpreter Discord servers.
   - Use the text from Section 2.

3. **X / Twitter**:
   - Post the 3-tweet thread from Section 3.
   - Tag relevant topics: `#LocalLLaMA #OpenSource #AI #MCP`.
