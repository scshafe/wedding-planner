# syntax=docker/dockerfile:1
#
# The deployable, offline-first product surface (Phases 12–16). A multi-tenant, white-label wedding-planner
# web app that boots into a themed, demoable tenant. Onboarding / billing / comms are offline simulations.
#
# Producing this image is in-scope. RUNNING IT FOR REAL — registry push, real hosting, DNS, secrets, real
# tenants/payments/comms — is the human-reserved crossing (CLAUDE.md operations exception #4). Do not push
# this image to a registry or deploy it. Build it and run it locally to demo.
#
# The operator credential is NEVER baked in: there is no ARG/ENV WP_OPERATOR_TOKEN here. It is injected at
# runtime (`-e WP_OPERATOR_TOKEN=…`), or — under the demo default — generated fresh each boot and logged once.

# ---- Stage 1: builder — install ONLY the production dependency tree --------------------------------------
# `tsx` is a runtime dependency (the image runs TypeScript directly; the repo emits no JS), so `--omit=dev`
# still yields a runnable tree while leaving out vitest / eslint / typescript and all test code.
FROM node:22-slim AS builder
WORKDIR /app

# Copy the manifests FIRST for layer caching. `npm ci` in a workspaces repo needs every workspace's
# package.json present (it links them); the source for those workspaces is NOT needed to install.
COPY package.json package-lock.json ./
COPY shared/package.json ./shared/
COPY telemetry/package.json ./telemetry/
COPY eval-harness/package.json ./eval-harness/
COPY loop-orchestrator/package.json ./loop-orchestrator/
COPY agent-operations/package.json ./agent-operations/
COPY product/package.json ./product/

RUN npm ci --omit=dev

# ---- Stage 2: runtime — a slim image with only what the product surface needs to run ---------------------
FROM node:22-slim AS runtime
ENV NODE_ENV=production
ENV PORT=8080
WORKDIR /app

# The production dependency tree from the builder (no vitest / eslint / typescript).
COPY --from=builder /app/node_modules ./node_modules

# Root manifests + tsconfig. `tsx` resolves the @wedding-planner/* path aliases from tsconfig; repo_root.ts
# verifies the root package.json `name` is "wedding-planner" to anchor schema-file resolution.
COPY package.json package-lock.json tsconfig.json tsconfig.base.json ./

# The deployable entrypoint + the only two source workspaces it imports.
COPY app/ ./app/
COPY shared/ ./shared/
COPY product/ ./product/

# The SchemaRegistry eagerly loads all 16 JSON Schema contracts from disk (across every workspace) the first
# time validation runs (the demo seed). Ship just the schemas/ dirs of the other four workspaces — benign
# contract JSON, NOT their source or tests. (.dockerignore keeps node_modules / .git / .claude / ops / tests
# / *.local.md out of the context entirely; the COPYs above are the second belt.)
COPY telemetry/schemas/ ./telemetry/schemas/
COPY eval-harness/schemas/ ./eval-harness/schemas/
COPY loop-orchestrator/schemas/ ./loop-orchestrator/schemas/
COPY agent-operations/schemas/ ./agent-operations/schemas/

# Run unprivileged (the node image ships a uid-1000 `node` user). The app holds in-memory state only and
# never writes to the image filesystem, so read-only ownership is sufficient.
USER node

EXPOSE 8080

# Liveness against the tenant-less, unauthenticated /healthz ONLY — never a tenant route (that would make
# container health depend on, and thereby disclose, demo-tenant lifecycle state). node:22 ships global fetch.
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]

# Exec form so tsx is PID 1 and receives SIGTERM/SIGINT directly (the entrypoint shuts down gracefully).
CMD ["node_modules/.bin/tsx", "app/server.ts"]
