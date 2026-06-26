---
name: deployable-image-composition-root
description: Phase 16 — the offline product surface packaged as a launch-ready Docker image; the imperative-shell composition root, edge-only clock/ids kept unreachable from the determinism core, injected-not-baked operator token, and the eager-schema-registry COPY set
metadata:
  type: project
---

Phase 16 (the final rung of the product arc: 12 core → 13 HTTP/auth → 14 web UI → 15 onboarding/billing →
**16 image**) packages the offline product surface as a **locally-runnable, launch-ready Docker image**.
Building + running it locally is in-scope; pushing to a registry / deploying for real is the human-reserved
crossing (operations exception #4) — the image is **never pushed**.

**THE CRUX — the composition root is the imperative shell; ambient reality enters at exactly ONE place.**
`composeProductSurface(config)` (`product/src/runtime/compose.ts`) wires the whole ~11-collaborator graph from
**injected** primitives `{ clock, ids, operatorToken, seedDemo?, demoSlug? }` — it reads no env, generates no
token, logs nothing. The entrypoint `app/server.ts` is the one impure shell (reads `process.env`, builds the
wall clock + id source, generates/validates the token, opens the socket, handles signals). So the same wiring
unit-tests with the deterministic doubles and only `main` touches the real world.

**The determinism rail is preserved BY REACHABILITY, not by comment.** The edge-only `SystemClock`
(`new Date().toISOString()`) + `RandomIdGenerator` (`${prefix}_${crypto.randomUUID()}`) live under
`product/src/runtime/` and are exported from **NEITHER** the `shared` nor the `product` barrel. The eval/
grader/loop core imports `@wedding-planner/shared` and never `@wedding-planner/product`, so a wall clock placed
in `product` is *physically unreachable* from the code whose replayability it would threaten. `app/server.ts`
imports them by relative path → no test/core file can grab a wall clock by autocomplete. Do NOT add a
`SystemClock`/`RandomIdGenerator` to `shared`'s barrel (it would erode the rail [[north-star-objective]]
attribution depends on).

**The operator credential is INJECTED, never baked — fail-closed.** Dockerfile has NO `ARG`/`ENV
WP_OPERATOR_TOKEN` (a build ARG bakes into a layer / `docker history`). Policy lives in pure, tested
`app/server_config.ts`: env-provided token enforced to a **≥16-char floor** (the store only rejects empty) →
below it FAIL CLOSED; unset + `WP_SEED_DEMO` (demo default) ⇒ generate a UUID + log it ONCE; unset + NOT
`WP_SEED_DEMO` ⇒ FAIL CLOSED (never silently auto-mint an admin credential into a prod log). The boot log is an
allow-list (host/port/demo-slug/token-*provenance*) — it never echoes an env-provided token and never logs a
`tenant_id`/`operator_id`/balance. This is the going-live hardening seam from [[onboarding-billing-operator-tier]].

**The demo seed traverses the REAL lifecycle driver.** `compose` provisions **and activates** the demo tenant
through the Phase-15 `OnboardingService` (provision → activate), NOT a direct `TenantStore.create` — so it
passes the legal-transition guard, records real billing events, and is edge-indistinguishable from any
operator-provisioned tenant (the [[web-ui-themed-edge]] mask holds: absent ≡ suspended ≡ onboarding =
byte-identical 404; only active discloses). The demo wedding is seeded via `WeddingRepository.create` on a
context resolved AFTER activation; **NO session is minted in compose** (nothing baked into boot state).

**Runtime = `tsx`; the image is multi-stage + slim.** `build` is `tsc --noEmit` (NO JS emitted) and the repo
uses `@wedding-planner/*` tsconfig path aliases everywhere → `tsx` resolves them and runs the workspace TS
directly. So `tsx` is a runtime **dependency** (moved out of devDeps) and the builder runs `npm ci --omit=dev`
→ the runtime image ships NO vitest/eslint/typescript and no test code. `CMD` execs `tsx` as PID 1 (graceful
SIGTERM, reproducible via the lockfile-pinned tsx); non-root `node` user; `HEALTHCHECK` hits the tenant-less
`/healthz` ONLY (a tenant route would disclose demo-tenant lifecycle).

**Non-obvious COPY constraint — the `SchemaRegistry` is EAGER + filesystem-backed.** Its constructor (first hit
= the demo seed's `TenantStore.create` → `getSchemaRegistry()`) eagerly reads **all 16 `*/schemas/*.json`
across all six workspaces** via `resolveFromRepoRoot`; `REPO_ROOT` is anchored from `shared/src/repo_root.ts`
two dirs up via `import.meta.url` (cwd-independent under tsx) and verified against the root `package.json`
name. So the runtime image MUST contain the root `package.json`/`tsconfig*.json`, `shared/`+`product/` at the
right depth, `app/`, the prod `node_modules`, **and the four other workspaces' `schemas/` dirs** (benign
contract JSON, NOT their src/tests). Lazy-per-key loading would shrink this but is a core change (deferred).

`.dockerignore` keeps `.git`/`.claude`/`ops`/`**/tests`/`*.local.md`/`README.md` out of the context entirely.
Verified on the running container (built + run locally, never pushed): themed `/t/demo` 200, masked `/t/ghost`
404, 401 unauth `/admin`, `/healthz` 200; uid 1000; no `.git`/`.claude`/`ops`/handoff in any layer; no
`operator_token` in `docker history`; dev toolchain absent; `HEALTHCHECK` healthy; `docker stop` → exit 0.
ADR 0016. Architect + doddy re-review: both APPROVE. Run recipe: `docs/RUNNING_THE_IMAGE.md`.
