# Security Policy

## Supported Versions

| Version | Supported |
| --- | --- |
| `1.0.x` (latest `main` / GHCR `:1.0.2`) | :white_check_mark: Yes |
| `< 1.0.0` | :x: No |

## Reporting a Vulnerability

**Please do not report security vulnerabilities through public GitHub issues, discussions, or pull requests.**

To report a potential security vulnerability privately:

1. **GitHub Private Vulnerability Reporting (Preferred):** Open a draft security advisory at [https://github.com/slashman413/cowork/security/advisories/new](https://github.com/slashman413/cowork/security/advisories/new).
2. **Include in your report:**
   - A clear description of the vulnerability and affected component/file path
   - Reproduction steps, proof-of-concept request/payload, or configuration details
   - Potential impact (e.g., authentication bypass, arbitrary command execution, credential exposure)
   - Any suggested remediation or mitigation

### Response Timeline

- **Acknowledgment:** Within 48 hours of receipt
- **Initial Triage & Severity Assessment:** Within 5 business days
- **Fix & Coordinated Disclosure:** Critical and high-severity issues are prioritized for immediate patching and a new release tag (`v1.0.x`) before public advisory disclosure.

## Deployment Security Notes

- **API Authentication:** Set `COWORK_API_KEY` in production/container deployments. If unset in the Docker image, a random bearer token is generated on first boot and written to `/data/api-key`.
- **Network Exposure:** Cowork binds locally by default (`http://localhost:6868`). When exposing the hub to remote workers over LAN or Tailscale, terminate TLS via Tailscale Serve or a reverse proxy and never expose an unauthenticated port to the public internet.
- **Credentials & Runtime State:** Never commit `.env`, `~/.cowork/`, or local OAuth tokens. Runtime state (`inbox/`, `artifacts/`, `goals/`) is gitignored by default.
