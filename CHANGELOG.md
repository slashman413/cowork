# Changelog

All notable changes to **Cowork MCP** (`slashman413/cowork`) are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- `CHANGELOG.md` documenting the `v1.0.0`, `v1.0.1`, and `v1.0.2` release history.
- `smithery.yaml` container MCP manifest for Smithery registry deployment.
- Animated terminal walkthrough GIF (`assets/demo.gif`) in `README.md` illustrating the MCP inbox and fallback chain lifecycle.
- `SECURITY.md`, `.github/dependabot.yml`, and SHA-pinned GitHub Actions workflows.
- Configurable integrations directory via `paths.integrations` (#59).
- Lean-run MCP tool deny-list (`claudeMcp.deny`) and `verification-before-completion` dispatch targeting (#61).
- Size-fit popup viewer for `.html` artifacts in the Web Dashboard (#62).

### Changed
- Added explicit Anthropic disambiguation and standardized the **Cowork MCP** display title across `README.md` and `server.json`.
- Updated core server dependencies (`express`, `drizzle-orm`, `@modelcontextprotocol/sdk`, `@hono/node-server`, `uuid`, `glob`, `pg`, `typescript`) and GitHub Actions via Dependabot.

### Fixed
- Cleared stale Antigravity rate-limit holds and matched neon/hydrogen quota windows (#60).
- Prevented integration install advice from failing as `"task disappeared"` when connected to a foreign server (#57).
- Treated HTTP `502`/`503`/`504` portal service probe responses as offline.

---

## [1.0.2] - 2026-11-15

### Breaking Changes
- Renamed `brains` to `agents` across configuration, REST/MCP APIs, and documentation, with `thinking` separated into an explicit parameter (`scripts/migrate-agent-naming.mjs` automatically migrates existing hubs on startup).
- Renamed roster entries to `personas` and moved persona packs into the `integrations` subsystem.

### Added
- **Resilient Orchestration & Quality Gates:**
  - Agent-level rate-limit circuit breaker and manual pending-task reassignment off rate-limited agents.
  - Structured `STATUS` / `EVIDENCE` completion footer contract, `rulings-not-stalls` policy, and `acceptance` / `verify` / `timebox` / `scope` task briefs.
  - Long-job `progress.md` resume ledger and automatic git worktree isolation for code tasks.
  - Priority-scoped two-stage cross-family LLM verifier, shadow mode, and Hallmark `sloplint` artifact checks.
  - Work-role routing (`role` → tier + `thinking`), per-task method cards, brief sharpener, multi-family review panel, arena workflow primitive, and `eval-prompt-change` A/B replay harness.
  - Lean `claude -p` local dispatch profile (~12k fewer prompt tokens per task) and optional per-agent/role `--effort`.
- **Integrations & Security Auditing:**
  - Automated repository integration CLI (`npm run integrate`), static skill security auditor (`npm run audit-skills`), and AI install advisor with collapsible UI cards and live progress dialogs.
- **Dashboard, Goals & Recipes:**
  - Rebuilt Goals page with list/detail split, markdown report/minutes viewer, usage tracking, and UI replies for blocked goals.
  - Reusable **Recipes** saved from successful runs with isolated artifact copying.
  - Dedicated `OUTPUTS` section separating final deliverables from intermediate working artifacts.
  - SSE single-card patching, gzip/brotli response compression, Overview Disk tile, and 3-day auto-purge for completed scheduled runs.
  - Form-based Configuration page and redesigned Calendar view.
- **Documentation & Community Readiness:**
  - Revamped `README.md` with CI/release badges, 30-second quickstart, Mermaid architecture diagram, comparison matrix, and `.github/ISSUE_TEMPLATE/config.yml`.

### Fixed
- **CI & Container Publishing:** Updated release workflow, `Dockerfile`, `server.json` (`1.0.2`), and docs namespace to `slashman413/cowork`, switched GHCR auth to `GITHUB_TOKEN`, and restored standard GitHub Actions expression syntax.
- **Security & Networking:** Added Host-header allowlist against DNS rebinding, multiplexed dual HTTP/HTTPS listener with trusted Tailscale TLS support, and decoupled live `~/.cowork/config.json` (including `apiKey`) from git mirroring.
- **Dispatcher & Stability:** Capped prompt and `inputFiles` sizes to prevent `spawn E2BIG` errors, killed full agent process trees when deleting a running task, fixed Zod 4 `z.record` explicit key schema in MCP handlers, and capped per-task artifact listing to prevent UI freezes on large artifact trees.
- Cleared dependency advisories across `glob`, `@hono/node-server`, `hono`, `zod`, and `@modelcontextprotocol/sdk`.

---

## [1.0.1] - 2026-10-18

### Security
- **Require API key on non-loopback hosts:** Binding `0.0.0.0` (including the `v1.0.0` container image) no longer serves `/api` or `/mcp` unauthenticated when `COWORK_API_KEY` is unset.
- On non-loopback hosts without an explicit key, Cowork generates a random key on first start, writes it with mode `0600` to `api-key` beside the config file, and prints it once to stdout.
- Added explicit opt-out via `server.allowUnauthenticated` or `COWORK_ALLOW_NO_AUTH=1`.
- Implemented constant-time API key comparison and dashboard cookie login via `/?apiKey=<key>` (`SameSite`, `HttpOnly`).

### Changed
- Updated `server.json` to `1.0.1` marking `COWORK_API_KEY` as required.
- Pinned `mcp-publisher` to `v1.8.1` in `.github/workflows/release.yml`.

---

## [1.0.0] - 2026-10-18

### Added
- **MIT Open-Source Release:** Licensed Cowork under the MIT License (`LICENSE`).
- **Container Image & Official MCP Registry Publishing:**
  - Digest-pinned `node:22-bookworm-slim` hub-only `Dockerfile` (`COWORK_HOST=0.0.0.0`, persistent state in `/data`, orchestration disabled by default for remote-agent hub deployments).
  - Automated multi-arch (`linux/amd64`, `linux/arm64`) release workflow pushing `ghcr.io/slashman413/cowork` and publishing `server.json` to `registry.modelcontextprotocol.io` via GitHub OIDC.
- **Local-First Multi-Agent Task Queue & MCP Hub:**
  - Filesystem-backed task store (`inbox/`, `.status/`, `artifacts/`, `inputs/`, `decisions/`, `goals/`) with atomic writes and zero external database requirements.
  - Native Streamable HTTP MCP server (`/mcp`) and REST API (`/api`) for Claude Code, Codex, Gemini CLI / Antigravity, Hermes, DeepSeek Harness (`dsh`), and remote agent clients (`JOIN-AS-AN-AGENT.md`).
  - Real-time Web Dashboard featuring Overview drill-down metrics, Task Inbox with live `progress.log` streaming, Calendar for recurring schedules, Goals tracking, Portal service launcher, and shared Obsidian Vault viewer.
  - Human-in-the-loop `wait-input` task state with orchestrator auto-answer support (ADR-009), default-on rate-limit auto-rerun, real-time usage probing, and one-command server bootstrap (`./deploy/install-server.sh`).

[Unreleased]: https://github.com/slashman413/cowork/compare/v1.0.2...HEAD
[1.0.2]: https://github.com/slashman413/cowork/compare/v1.0.1...v1.0.2
[1.0.1]: https://github.com/slashman413/cowork/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/slashman413/cowork/releases/tag/v1.0.0
