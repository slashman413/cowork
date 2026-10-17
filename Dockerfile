# Cowork hub: MCP server + dashboard + task inbox. Brains join from their own machines
# with deploy/remote-brain-client.mjs, so the image ships no agent CLIs and starts with
# local orchestration off. State (config, inbox, artifacts, goals …) lives in /data.
#
#   docker run -p 6868:6868 -v cowork-data:/data ghcr.io/slashman413/cowork
#
# The base is pinned by digest so a tag rebuilds the same image; bump NODE_IMAGE deliberately.
ARG NODE_IMAGE=node:22-bookworm-slim@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392
FROM ${NODE_IMAGE} AS build
WORKDIR /app/server
COPY server/package.json server/package-lock.json ./
RUN npm ci
COPY server/tsconfig.json ./
COPY server/src ./src
RUN npm run build && npm prune --omit=dev

FROM ${NODE_IMAGE}
ARG VERSION=dev
LABEL org.opencontainers.image.source="https://github.com/slashman413/cowork" \
      org.opencontainers.image.description="Cowork: one MCP task inbox shared by Claude Code, Codex, Gemini CLI and local LLMs" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.version="${VERSION}" \
      io.modelcontextprotocol.server.name="io.github.slashman413/cowork"
WORKDIR /app
COPY --from=build /app/server/node_modules ./server/node_modules
COPY --from=build /app/server/dist ./server/dist
COPY server/package.json ./server/
COPY server/public ./server/public
COPY agency-agents ./agency-agents
COPY workflows ./workflows
COPY config.json PROTOCOL.md CONVENTIONS.md JOIN-AS-A-BRAIN.md LICENSE ./
# Container template: runtime dirs under /data, no Obsidian vault, no local dispatcher.
# It is seeded to $COWORK_CONFIG on first start, after which /data/config.json is yours;
# the bundled workflows are copied to /data/workflows the same way (runs go beside them).
RUN node -e '\
  const fs = require("fs"); const c = JSON.parse(fs.readFileSync("config.json", "utf8")); \
  for (const k of ["inbox", "status", "decisions", "artifacts", "inputs", "goals", "workflows"]) c.paths[k] = "/data/" + (k === "status" ? ".status" : k); \
  c.obsidian.enabled = false; c.orchestration.enabled = false; \
  fs.writeFileSync("config.json", JSON.stringify(c, null, 2) + "\n");' \
  && chmod -R a+rX /app && mkdir -p /data && chown node:node /data
ENV NODE_ENV=production COWORK_CONFIG=/data/config.json COWORK_PORTAL=/data/portal.json \
    COWORK_LAYOUT=/data/layout.json COWORK_HOST=0.0.0.0 COWORK_PORT=6868
USER node
VOLUME /data
EXPOSE 6868
WORKDIR /app/server
CMD ["sh", "-c", "[ -d /data/workflows ] || cp -r /app/workflows /data/workflows; exec node dist/index.js"]
