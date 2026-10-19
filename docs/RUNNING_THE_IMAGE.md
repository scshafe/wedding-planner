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
# Demo default — seeds an active 'demo' tenant; an ephemeral operator token is generated and logged once.
# State is in memory: stopping the container loses it.
docker run --rm -p 8080:8080 wedding-planner-product:local

# Durable: keep the data in a SQLite file on a mounted directory (writable by uid 1000). The demo tenant is
# seeded into the empty database on the first boot only; later boots keep everything.
mkdir -p ./wp-data && docker run --rm -p 8080:8080 -v "$PWD/wp-data:/data" \
  -e WP_DATABASE_PATH=/data/wedding-planner.sqlite wedding-planner-product:local

# Inject a stable operator credential (>= 16 chars) instead of the generated one:
docker run --rm -p 8080:8080 -e WP_OPERATOR_TOKEN=your-operator-token-xxxx wedding-planner-product:local

# A non-demo build (no seeded tenant) REQUIRES injected tokens and a database path, else it fails closed at boot:
docker run --rm -p 8080:8080 -v "$PWD/wp-data:/data" -e WP_SEED_DEMO=false \
  -e WP_OPERATOR_TOKEN=your-operator-token-xxxx -e WP_PROVIDER_WEBHOOK_TOKEN=your-webhook-token-xxxx \
  -e WP_DATABASE_PATH=/data/wedding-planner.sqlite wedding-planner-product:local
```

Then visit:

- `http://localhost:8080/` — the generic landing page
- `http://localhost:8080/t/demo` — the themed demo tenant console (log in as a planner or couple)
- `http://localhost:8080/healthz` — liveness and the build (`{"status":"ok","commit":"…"}`)

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
| `WP_PROVIDER_WEBHOOK_TOKEN` | *(unset)* | The inbound-messaging webhook credential, under the same policy as the operator token. |
| `WP_DATABASE_PATH`  | *(unset)*   | The SQLite database file (issue #8). Created and migrated at boot (an existing database gets a `.pre-vN.sqlite` snapshot beside it first); a database migrated by a newer build with a change this build cannot read is refused. Unset is allowed only under the demo default (in-memory, reset on restart); a non-demo build without it **fails closed**. |
| `WP_REQUIRE_DATABASE` | `false`   | When true, boot fails closed without `WP_DATABASE_PATH` even in demo mode (the deployed stack sets it). |
| `WP_BUILD_COMMIT`   | *(build arg)* | The commit `/healthz` reports. `scripts/docker_build.sh` bakes the full sha in with `--build-arg`. |
| `WP_IMAGE_REF`      | *(unset)*   | An image reference (`name:<short sha>`); its tag is reported as the commit when `WP_BUILD_COMMIT` is absent. The deployed stack sets it to the pinned image. |
| `WP_PUBLIC_URL`     | *(unset)*   | The site's public origin (e.g. `https://planner.example`, no path or trailing slash) used in links inside emails (password reset, account setup). Unset ⇒ site-relative links. Never derived from a request's Host header. |

## Data and backups

With `WP_DATABASE_PATH` set, the whole state is the one SQLite file. It runs in rollback-journal mode, so
between writes the file alone is a complete database: copy it (with the app stopped, or between requests) to
back it up, and put it back with the app stopped to restore. In the deployed stack the file lives in
`state/app/`, which is in `deploy/stack/stack.toml` `[backup] paths`.

## What stays human-reserved

This image is a **launch-ready artifact**, not a launch. Onboarding, billing, and comms are offline
simulations (no real money/messages). The operator token and the demo seed are offline placeholders. Pushing
to a registry, deploying to real hosting, wiring DNS/secrets, or onboarding real tenants/payments/comms is the
human crossing — build up to that line, never across it.

## Logs and errors

The server writes one JSON line per request to stdout: `{ts, method, route, status, duration_ms, tenant}`, where
`route` is the route pattern (`/t/:slug/weddings/:id`). No path ids, query strings, headers, cookies or bodies are
ever logged. Server errors (500s) are listed for the operator at `/admin/errors`, by failure code and code location,
never by message.
