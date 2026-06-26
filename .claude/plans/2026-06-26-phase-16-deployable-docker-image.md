# Phase 16 — The deployable Docker image (the launch-ready offline product surface)

**Status:** in progress
**Branch:** `build/phase-3-generalize-search` (the open review artifact for `main`; Phases 3–15 build on it)
**Predecessor:** Phase 15 (onboarding/billing sim) — complete, 559 tests green.

## Goal

Finish the human-set product arc (12 core → 13 HTTP/auth → 14 web UI → 15 onboarding/billing → **16 image**).
Package the offline product surface (Phases 12–15) as a **locally-runnable, demoable, launch-ready Docker
image** a human could deploy: a small composition root that wires the stores + `ProductApi` +
`createProductWebUiServer`, seeds an operator credential + a demo tenant (so the image boots into a themed,
demoable app), a `Dockerfile`, a `/healthz` healthcheck (already exists), and a documented run recipe.

## The hard rail (CLAUDE.md operations exception #4 — do NOT cross or simulate crossing)

**Producing the image is in-scope. Running it for real is human-reserved.** I MAY build the image locally and
run the container locally to verify (offline, no external effects). I may NOT: push to any registry, deploy to
real hosting, configure DNS/secrets, or onboard real tenants/payments/comms. The operator token + the seed
demo tenant are **offline placeholders, never real secrets, never baked into the image**.

## The crux design decisions (to be ratified by the Step-0 reviews)

1. **The composition root is the imperative shell; ambient reality enters at exactly ONE place.** The repo's
   determinism rail ("nothing reads an ambient clock"; the only `Clock`/`IdGenerator` impls are the
   `Manual`/`Sequential` test doubles) is preserved for the **core and all 559 tests** — they are unchanged.
   The entrypoint is the one impure place where the wall clock, identity, env config, and the socket enter.
   New **edge-only** `SystemClock` (wall time) + `RandomIdGenerator` (`crypto.randomUUID`) live under
   `product/src/runtime/`, are **NOT exported from `shared`'s barrel** (so the eval/loop replay core can never
   import them), and are documented edge-only. `composeProductSurface(config)` takes the clock/ids as config,
   so it stays unit-testable with `ManualClock`/`SequentialIdGenerator` — determinism in test, wall time only
   in `main`.

2. **The operator credential is injected, never baked (doddy trust seam).** The operator token comes from
   `WP_OPERATOR_TOKEN`. If unset, `main` generates a **random ephemeral** token at boot and logs it to stdout
   (clearly labelled an offline-demo token, regenerated every boot) — so the image ships **no credential** and
   there is **no real secret**. The seed demo tenant is an obvious placeholder slug. `compose` never logs the
   token unless it was the one that generated it.

3. **Runtime = `tsx` (already a devDependency).** `build` is `tsc --noEmit` (no JS emitted) and the repo uses
   `@wedding-planner/*` tsconfig path aliases everywhere; `tsx` resolves them and runs the workspace TS
   directly (verified). The image runs `tsx app/server.ts` from the repo root. A `tsc`-emit slim runtime is a
   recorded going-live optimization, not a Phase-16 requirement.

## Step 0 — Design review OUTCOME (both APPROVE-WITH-CHANGES; folded below)

**rigorous-architect: APPROVE-WITH-CHANGES.** The imperative-shell boundary is correct; the determinism rail
is preserved by *reachability* (the eval/loop core imports `@wedding-planner/shared`, never `product`, so an
impure impl under `product/src/runtime/` is physically unreachable from the replay core — stronger than a
comment). Folds: **(A1)** seed the demo wedding via `WeddingRepository.create(context, …)` where `context =
resolver.resolveBySlug(demoSlug)` AFTER activation — NEVER mint a session inside `compose` (would bake a
session token into boot state); make the OnboardingService seed mandatory. **(A2)** the operator token is
generated in `app/server.ts` via `crypto.randomUUID()` and passed into `compose` as `config.operatorToken`;
`compose` never generates or logs it. **(A3)** declare + export named types `ComposeProductSurfaceConfig` and
`ComposedSurface` (no anonymous inline shapes); `demo` is `undefined` when `seedDemo` is false. **(A4)** the
edge `SystemClock`/`RandomIdGenerator` are exported from NEITHER barrel; `app/server.ts` imports them by
relative path. **(A5)** healthcheck = a curl-less Node `fetch` one-liner (`node:22-slim` has no curl); pin the
node major deliberately (dev host is v26, image is LTS 22) and use no v26-only API. **(A6)** copy package
manifests before `npm ci` for layer caching.

**doddy: APPROVE-WITH-CHANGES.** The token seam (injected, never baked) is correctly conceived and the
disclosure mask is structurally preserved (the entrypoint is a thin shell over the already-proven
`ProductWebUi.handle` → `ProductApi.handle` pipeline — nothing new makes an existence decision). Blocking
folds: **(D0-1)** `.dockerignore` must be an explicit, complete exclusion list (`.git`, `.claude`, `ops`,
`docs`, `coverage`, `dist`, `**/node_modules`, `*.local.md`, `*.log`, `.env*`, `**/tests`, `**/*.test.ts`,
`.DS_Store`) AND the built image must be *proven* clean (`docker run … find` shows no `.git`/`.claude`/`ops`/
handoff). **(D0-2)** resolve the dev-dep contradiction: move `tsx` to `dependencies` and `npm ci --omit=dev`,
so the running image ships NO test/lint/build toolchain and no `*.test.ts`. Should-fix: **(D1-1)** bind the
generate-and-log token to the demo switch — `WP_SEED_DEMO=true` ⇒ auto-generate + log (offline demo);
`WP_SEED_DEMO=false` ⇒ **fail closed** (non-zero exit) if `WP_OPERATOR_TOKEN` is unset (never silently
auto-mint an admin credential into prod logs). **(D1-2)** enforce a length floor (≥16 chars) on a *provided*
token in `app/server.ts`, fail-closed below it (the store only rejects empty). **(D1-3)** boot-log allow-list:
port, host, demo slug + URL, and `operatorToken: env-provided` OR the generated value (only when generated) —
NEVER echo a human-provided token; never log any `tenant_id`/`operator_id`/balance. **(D1-4)** verify non-root
(`docker run … id` ≠ 0). **(D2-1)** Dockerfile must contain NO `ARG`/`ENV WP_OPERATOR_TOKEN` (a build ARG
bakes into a layer); prove via `docker history … | grep -i operator_token` empty. **(D2-2)** `HEALTHCHECK`
hits `/healthz` ONLY (never a tenant route — that would make container health disclose demo-tenant lifecycle).
**(D2-3)** record the seed-via-OnboardingService rationale in the ADR.

**Self-discovered fold (S1) — the schema registry is EAGER + filesystem-backed.** `getSchemaRegistry()` (first
hit = the demo seed's `TenantStore.create`) constructs a `SchemaRegistry` that **eagerly reads all 16
`*/schemas/*.json` across all six workspaces** via `resolveFromRepoRoot`, and `REPO_ROOT` is verified by
reading `<root>/package.json` (name must be `wedding-planner`), resolved from `shared/src/repo_root.ts` two
dirs up via `import.meta.url` (cwd-independent, robust under tsx). Therefore the runtime image MUST contain:
the root `package.json`/`package-lock.json`/`tsconfig*.json`, `shared/` (src + schemas) at the right depth,
`product/` (src + schemas), `app/`, the runtime `node_modules` (incl. `tsx`, `ajv`, `ajv-formats`, `js-yaml`,
`glob`), **and the four other workspaces' `schemas/` dirs only** (`telemetry/schemas`, `eval-harness/schemas`,
`loop-orchestrator/schemas`, `agent-operations/schemas` — benign JSON contracts, NOT their `src`/`tests`).
Refactoring the registry to lazy-per-key is a core change (broader blast radius, its own review) — out of
scope; ship the four schema dirs and document it.

## Steps

- [x] **Step 0 — Design reviews (architect + doddy personas); folds recorded above.** ✅

- [ ] **Step 1 — Edge-only runtime primitives.** `product/src/runtime/system_clock.ts` (`SystemClock implements
  Clock`, `now()` = `new Date().toISOString()`) + `product/src/runtime/random_id_generator.ts`
  (`RandomIdGenerator implements IdGenerator`, `next(prefix)` = `${prefix}_${crypto.randomUUID()}`). Both
  documented edge-only with the determinism rationale. Tests: `SystemClock.now()` is a valid ISO 8601 UTC
  string and non-decreasing across two calls; `RandomIdGenerator` ids carry the prefix and are unique across
  many calls. **(A4)** exported from NEITHER `shared`'s nor `product`'s public barrel — `app/server.ts` imports
  them by relative path, so no test/core file can grab a wall clock by autocomplete.

- [ ] **Step 2 — The composition root.** `product/src/runtime/compose.ts`:
  `composeProductSurface(config: ComposeProductSurfaceConfig): ComposedSurface`. **(A3)** declare + export both
  named types: `ComposeProductSurfaceConfig { clock: Clock; ids: IdGenerator; operatorToken: string;
  seedDemo?: boolean; demoSlug?: string }` and `ComposedSurface { ui; api; themes; operatorToken; demo?: {
  slug; tenantId; weddingId } }`. Builds `TenantStore`, `SessionStore`,
  `OperatorCredentialStore(ids, [operatorToken])`, `BillingLedger`, `OnboardingService`, `WeddingRepository`,
  `WeddingAuthorizer`, `TenantContextResolver`, `ProductApi`, `ThemeResolver`, `ProductWebUi`. When `seedDemo`
  (default true): **(A1)** provision + activate the demo tenant via the `OnboardingService` (the real lifecycle
  driver — NEVER direct `TenantStore.create`), then seed one demo wedding via `WeddingRepository.create(ctx,
  …)` where `ctx = resolver.resolveBySlug(demoSlug)` AFTER activation — NO session minted in `compose`. When
  `seedDemo` is false, `demo` is `undefined` (don't fabricate a handle). **(A2)** `compose` NEVER generates or
  logs the operator token — it receives it via `config.operatorToken`. Exported from the product barrel.
  Unit-test with `ManualClock`/`SequentialIdGenerator`.

- [ ] **Step 3 — The entrypoint.** `app/server.ts` (new top-level `app/`; add `app` to tsconfig `include`).
  Reads env: `PORT` (default 8080), `HOST` (default `0.0.0.0`), `WP_SEED_DEMO` (default true), `WP_DEMO_SLUG`
  (default `demo`), `WP_OPERATOR_TOKEN`. **Token policy (D1-1/D1-2/A2):** if `WP_OPERATOR_TOKEN` is set, enforce
  a **≥16-char floor** (fail closed, non-zero exit, below it); if unset AND `seedDemo` ⇒ generate
  `crypto.randomUUID()` and log it once (offline-demo label); if unset AND NOT `seedDemo` ⇒ **fail closed**
  (refuse to boot, exit non-zero, "set WP_OPERATOR_TOKEN"). Build `SystemClock` + `RandomIdGenerator`, call
  `composeProductSurface`, `createProductWebUiServer(ui).listen(port, host)`. Graceful shutdown on
  `SIGTERM`/`SIGINT` (close server, exit 0). **(D1-3) boot-log allow-list:** port, host, demo slug + URL, and
  `operatorToken: env-provided` OR the generated value (only when generated) — never echo a provided token,
  never log a `tenant_id`/`operator_id`/balance. **(D0-2)** add `npm run serve` = `tsx app/server.ts`; move
  `tsx` to `dependencies`.

- [ ] **Step 4 — Wiring + boot tests.** (a) `compose` unit test (Step 2) proves the wiring + the mask (active
  demo discloses 401/themed-200; unprovisioned slug → byte-identical generic 404). (b) Integration test over
  `ui.handle()`: `/healthz` → 200; `GET /t/demo` → 200 themed (brand name in HTML); unprovisioned slug →
  generic 404; `POST /admin/tenants` without operator token → 401, with it → 201. (c) Bind
  `createProductWebUiServer` on port 0 and HTTP-GET `/healthz` → 200 (socket path; mirrors `node_server.test`).
  (d) **(D1-3)** an entrypoint-helper test: given an env-provided token, the boot-log builder does NOT contain
  the token value; given none + seedDemo, the generated token appears exactly once; token <16 chars ⇒ the
  validator throws/exits. Keep all tests deterministic (`ManualClock`).

- [ ] **Step 5 — The image.** **Multi-stage `Dockerfile`:** builder (`node:22-slim`, `COPY` package manifests
  first then `npm ci --omit=dev` with `tsx` now a dependency — ships NO vitest/eslint/typescript) → runtime
  (`node:22-slim`, non-root `USER`, copy from builder only: `node_modules`, root `package*.json`,
  `tsconfig*.json`, `shared/`, `product/`, `app/`, and the four extra `*/schemas/` dirs per **(S1)**; `ENV
  PORT=8080`; `HEALTHCHECK` = curl-less Node `fetch('http://127.0.0.1:'+PORT+'/healthz')` one-liner per
  **(A5)/(D2-2)**; `CMD ["npx","tsx","app/server.ts"]`). **(D2-1)** NO `ARG`/`ENV WP_OPERATOR_TOKEN` anywhere.
  **(D0-1)** complete `.dockerignore`. `scripts/docker_build.sh` (build + a commented, never-executed
  `docker run` recipe; never `docker push`). **Docker is available** → actually `docker build`, then verify
  on the running container: `docker run … id` is non-root **(D1-4)**; `find / -name '*.local.md' -o -path
  '*/.git' -o -path '*/.claude' -o -path '*/ops'` is empty **(D0-1)**; `docker history --no-trunc | grep -i
  operator_token` is empty **(D2-1)**; `GET /healthz` → 200 and `GET /t/demo` → themed 200; then stop the
  container. **Never `docker push`.** If the build is genuinely too heavy/slow, author everything, verify the
  entrypoint boots via `tsx` (healthz + demo) outside Docker, and record "build the image on a Docker host" as
  the human-runnable handoff step — do NOT fake a build.

- [ ] **Step 6 — Built-code re-review (architect + doddy on the actual code); fold findings.**

- [ ] **Step 7 — ADR 0016 + memory `[[deployable-image-composition-root]]` + MEMORY.md index + READMEs (root +
  product) + handoff update.** Record: the imperative-shell boundary, the edge-only clock/ids and why they're
  out of `shared`, the injected-not-baked operator token, the `tsx` runtime choice + the tsc-emit deferral,
  and the human-reserved "build/deploy for real" crossing.

## Verification gate (every step)

`npm run build && npm test && npm run lint` all green before ticking a box or committing. Build standalone
(never piped — the pipe masks the non-zero exit), check `$?`. Commit per verified step on the `build/*` branch.
```
