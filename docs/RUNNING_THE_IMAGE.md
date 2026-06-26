# Running the deployable product-surface image

The product surface (Phases 12–16) packages as a locally-runnable, offline-first Docker image that boots into
a themed, demoable wedding-planner tenant. **Building and running it locally is in-scope. Going live —
registry push, real hosting, DNS, secrets, real tenants/payments/comms — is human-reserved (CLAUDE.md
operations exception #4). This image is never pushed or deployed by an agent.**

## Build

```bash
./scripts/docker_build.sh                      # tag: wedding-planner-product:local
# or
docker build -t wedding-planner-product:local .
```

The build is multi-stage: a builder runs `npm ci --omit=dev` (so the runtime image ships **no** vitest /
eslint / typescript and no test code — `tsx` is a runtime dependency), and a slim runtime stage copies only
the entrypoint, the `shared` + `product` sources, the production `node_modules`, and the JSON Schema
contracts (the registry loads all 16 at boot). It runs as the unprivileged `node` user.

## Run (locally, offline)

```bash
# Demo default — seeds an active 'demo' tenant; an ephemeral operator token is generated and logged once:
docker run --rm -p 8080:8080 wedding-planner-product:local

# Inject a stable operator credential (>= 16 chars) instead of the generated one:
docker run --rm -p 8080:8080 -e WP_OPERATOR_TOKEN=your-operator-token-xxxx wedding-planner-product:local

# A non-demo build (no seeded tenant) REQUIRES an injected token, else it fails closed at boot:
docker run --rm -p 8080:8080 -e WP_SEED_DEMO=false -e WP_OPERATOR_TOKEN=your-operator-token-xxxx \
  wedding-planner-product:local
```

Then visit:

- `http://localhost:8080/` — the generic landing page
- `http://localhost:8080/t/demo` — the themed demo tenant console (log in as a planner or couple)
- `http://localhost:8080/healthz` — liveness (`{"status":"ok"}`)

The `/admin` provisioning surface is operator-gated — present the operator token as
`Authorization: Bearer <token>` (the token printed at boot under the demo default, or the one you injected).

## Configuration (environment variables)

| Variable            | Default     | Meaning |
|---------------------|-------------|---------|
| `PORT`              | `8080`      | Listen port. |
| `HOST`              | `0.0.0.0`   | Bind address. |
| `WP_SEED_DEMO`      | `true`      | Seed + activate a demo tenant on boot (`false`/`0`/`no`/`off` to disable). |
| `WP_DEMO_SLUG`      | `demo`      | The demo tenant's routing slug. |
| `WP_OPERATOR_TOKEN` | *(unset)*   | The platform-operator `/admin` credential. **Injected, never baked.** Must be ≥ 16 chars. Unset is allowed only under the demo default (a fresh token is generated + logged each boot); a non-demo build with no token **fails closed**. |

## What stays human-reserved

This image is a **launch-ready artifact**, not a launch. Onboarding, billing, and comms are offline
simulations (no real money/messages). The operator token and the demo seed are offline placeholders. Pushing
to a registry, deploying to real hosting, wiring DNS/secrets, or onboarding real tenants/payments/comms is the
human crossing — build up to that line, never across it.
