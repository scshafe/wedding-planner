# ADR 0016 — The deployable Docker image: the imperative shell over the offline product surface

- **Status:** accepted
- **Date:** 2026-06-26
- **Decider:** the building agent (an agent-owned engineering decision per
  [[agents-own-buildout-decisions]] and `.claude/plans/2026-06-26-phase-16-deployable-docker-image.md`)
- **Scope:** Phase 16 — the final rung of the human-set product arc (12 domain core → 13 HTTP/auth →
  14 web UI → 15 onboarding/billing → **16 image**). Package the offline product surface (Phases 12–15) as a
  locally-runnable, demoable, **launch-ready** Docker image: a composition root that wires every store +
  `ProductApi` + `createProductWebUiServer`, seeds an operator credential + a demo tenant, plus a `Dockerfile`,
  a `/healthz` healthcheck, and a documented run recipe. Offline-first; injected operator credential.
- **Builds on** ADR 0012 (inter-tenant isolation), 0013 (request edge + intra-tenant auth), 0014 (themed web
  UI), 0015 (operator tier + lifecycle driver). It weakens none and adds **no parallel safety model**: the
  packaging layer is a thin shell over the already-proven `ProductWebUi.handle` → `ProductApi.handle` pipeline.

## Context

After Phase 15 the product surface was a complete, themed, multi-tenant JSON+HTML app driven by an operator
tier — but it had no way to **run as a deliverable**. There was no composition root (every test wired the ~11
collaborators by hand), no entrypoint that calls `.listen()`, and `build` is `tsc --noEmit` (the repo emits
**no JavaScript**). The human-set goal is "an image a human can deploy"; producing that image is in-scope,
while *running it for real* (registry push, hosting, DNS, secrets, real tenants/payments/comms) is the
human-reserved crossing (operations exception #4).

Two facts shaped every decision:

1. **The determinism rail.** Nothing in the system reads an ambient clock or RNG — the only `Clock`/
   `IdGenerator` impls in `@wedding-planner/shared` are `ManualClock`/`SequentialIdGenerator`, so eval/grader/
   loop runs replay byte-for-byte. A long-lived deployed process, however, needs wall time and non-colliding
   ids. These pull in opposite directions.
2. **The operator credential.** Phase 15 made the operator token constructor-injected, never a module
   constant. An image must not turn that into a baked-in secret.

## Decision

**1. The composition root is the imperative shell; ambient reality enters at exactly ONE place.**
`composeProductSurface(config)` (`product/src/runtime/compose.ts`) wires the whole graph from **injected**
primitives — `{ clock, ids, operatorToken, seedDemo?, demoSlug? }` — and performs no ambient reads, generates
no token, and logs nothing. The deployable entrypoint `app/server.ts` is the one impure shell: it reads
`process.env`, constructs the wall clock + id source, generates/validates the operator token, opens the
socket, and handles signals. Everything below `compose` stays injected, deterministic, and testable — so the
same wiring unit-tests with the deterministic doubles and only `main` ever touches the real world.

**2. The edge-only impure primitives live where the replay core cannot reach them.** `SystemClock`
(`new Date().toISOString()`) and `RandomIdGenerator` (`${prefix}_${crypto.randomUUID()}`) live under
`product/src/runtime/` and are exported from **neither** the `shared` nor the `product` barrel. The
determinism rail is then preserved **by reachability, not by comment**: the eval/grader/loop packages import
`@wedding-planner/shared` and never `@wedding-planner/product`, so a wall clock placed in `product` is
*physically unreachable* from the code whose replayability it would threaten. `app/server.ts` imports them by
relative path — so no test or core file can grab a wall clock by autocomplete.

**3. The operator credential is injected, never baked — and fail-closed.** The Dockerfile has **no**
`ARG`/`ENV WP_OPERATOR_TOKEN` (a build `ARG` would bake into a layer and show in `docker history`). The token
policy lives in a pure, unit-tested `app/server_config.ts`:
- env-provided `WP_OPERATOR_TOKEN` is enforced to a **≥16-char floor** (the store only rejects empty); below
  it, boot **fails closed** (non-zero exit, before any socket opens);
- unset **and** `WP_SEED_DEMO` (the offline-demo default) ⇒ generate a fresh `crypto.randomUUID()` token and
  log it **once**, clearly labelled ephemeral/regenerated-each-boot;
- unset **and not** `WP_SEED_DEMO` (a "real" build) ⇒ **fail closed** — never silently auto-mint an admin
  credential into a production log. The boot log is an allow-list (host, port, demo slug + URL, token
  *provenance*); it never echoes an env-provided token and never logs a `tenant_id`/`operator_id`/balance.

**4. The demo seed traverses the real lifecycle driver.** When `seedDemo`, `compose` provisions **and
activates** the demo tenant through the Phase-15 `OnboardingService` (provision → activate), not a direct
`TenantStore.create`. So the demo tenant passes the legal-transition guard and records real billing events,
and is indistinguishable at the edge from any operator-provisioned tenant (an ACTIVE tenant disclosing
existence is the *designed* behavior; absent ≡ suspended ≡ onboarding stay the byte-identical masked 404). The
demo wedding is seeded via `WeddingRepository.create` on a resolver-minted context obtained *after*
activation; **no session is minted** in `compose`, so no session token is baked into boot state — the first
planner logs in via the public `/t/:slug/login` edge once the image is up.

**5. Runtime = `tsx`; the image is multi-stage and slim.** The repo emits no JS and uses `@wedding-planner/*`
tsconfig path aliases everywhere; `tsx` resolves them and runs the workspace TS directly. `tsx` is therefore a
runtime **dependency** (not dev), so the builder runs `npm ci --omit=dev` and the runtime image ships **no**
vitest/eslint/typescript and no test code. The runtime stage copies only the entrypoint, the `shared` +
`product` sources, the production `node_modules`, and **every workspace's `schemas/`** — because the
`SchemaRegistry` constructor **eagerly** loads all 16 JSON Schema contracts from disk on first validation (the
demo seed), with `REPO_ROOT` anchored from `shared/src/repo_root.ts` via `import.meta.url` (cwd-independent)
and verified against the root `package.json` name. The image runs as the unprivileged `node` user; `CMD` execs
`tsx` as PID 1 (graceful SIGTERM/SIGINT); `HEALTHCHECK` hits the tenant-less `/healthz` **only** (a tenant
route would make container health disclose demo-tenant lifecycle state).

## Alternatives considered

- **A wall clock in `shared` (one `SystemClock` for everyone).** Rejected: it would put an ambient-time source
  one import away from the eval/grader/loop core, eroding the determinism rail that makes runs attributable.
  Reachability isolation is a stronger guarantee than a "do not use in the core" comment.
- **Emit JS (`tsc` + a path-alias rewrite) and run `node` directly.** Deferred: the path-alias rewrite is
  extra build tooling and fragility for no offline-demo benefit. Recorded as a going-live optimization (a
  slim, JS-only runtime), not a Phase-16 requirement. `npm ci` pins the lockfile's exact `tsx`, so the `tsx`
  runtime (incl. its SIGTERM forwarding) is reproducible.
- **Fail-closed when the operator token is unset, always.** Rejected for the demo default: it would make the
  one-command `docker run` demo impossible. Instead the generate-and-log behavior is **bound to the demo
  switch**, and a non-demo build fails closed — the safe default is explicit, not a footgun.
- **Refactor the `SchemaRegistry` to lazy-per-key loading** (so the image needs only `product`'s schemas).
  Rejected for Phase 16: it touches the shared core (broader blast radius, its own review). Shipping the four
  extra `schemas/` dirs (benign contract JSON) is the low-risk choice; the refactor is a future option.

## Consequences

- The product arc is **complete**: the offline surface is now a real, locally-runnable, launch-ready artifact
  (`./scripts/docker_build.sh` → `docker run -p 8080:8080 …` → a themed demo tenant at `/t/demo`).
- The determinism rail is **untouched** for the core and all 585 tests; the phase is purely additive (new
  files under `product/src/runtime/`, `app/`, plus `Dockerfile`/`.dockerignore`/`scripts`/`docs`), with only
  three edits — `package.json` (tsx→deps, `serve`), `tsconfig.json` (`include += app`), `product/src/index.ts`
  (compose export) — and is cleanly revertible.
- **Verified on the running container** (built + run locally, never pushed): themed `/t/demo` 200, masked
  `/t/ghost` 404, 401 on unauth `/admin`, `/healthz` 200; runs as uid 1000; no `.git`/`.claude`/`ops`/handoff
  in any layer; no `operator_token` in `docker history`; dev toolchain absent; `HEALTHCHECK` reaches
  `healthy`; `docker stop` → exit 0.
- **The line held.** Building and running the image locally is in-scope; the image is **never** pushed or
  deployed. Going live remains the human crossing.

## Verification

`npm run build && npm test && npm run lint` green (585 tests). Built-code re-review by the architect and doddy
personas (general-purpose agents carrying the lens — the named specialists are not provisioned here): **both
APPROVE**, nothing exploitable; the only folds were two cosmetic P2s (exclude `**/README.md` from the image
tree; document the tsx-PID-1 signal coupling). Memory: [[deployable-image-composition-root]].
