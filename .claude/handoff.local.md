# Handoff

## Where things stand — Phase 16 (the deployable Docker image) is BUILT ✅ — THE PRODUCT ARC IS COMPLETE
`.claude/plans/2026-06-26-phase-16-deployable-docker-image.md` is **complete — all 8 steps ticked** (Step 0
design reviews + Steps 1–7), on branch **`build/phase-3-generalize-search`** (the open review artifact for
`main`; Phases 3–16 build on it; the loop's merge-keeper advances `main` when green). Working tree clean.
`npm run build && npm test && npm run lint` all green (**585 tests**, up from 559 at the start of this run).
`main` has Phase 1+2; this branch is the review artifact for Phases 3–16.

**The human-set product arc is now COMPLETE: 12 domain core ✅ → 13 HTTP/auth ✅ → 14 web UI ✅ → 15
onboarding/billing sim ✅ → 16 deployable Docker image ✅.** The offline product surface is a real,
locally-runnable, launch-ready artifact: `./scripts/docker_build.sh` builds it; `docker run -p 8080:8080
wedding-planner-product:local` boots a themed demo tenant at `/t/demo`. The image was **built and run locally
to verify** (Docker daemon was available); **it is NEVER pushed — going live is human-reserved (exception #4).**

## What changed this phase — the imperative shell over the offline surface
Before Phase 16 the surface had no composition root and no entrypoint (every test wired the ~11 collaborators
by hand) and `build` is `tsc --noEmit` (no JS emitted). Phase 16 adds: the **edge-only** `SystemClock` +
`RandomIdGenerator` (`product/src/runtime/{system_clock,random_id_generator}.ts`), the composition root
`composeProductSurface` (`product/src/runtime/compose.ts`, exported from the product barrel), the deployable
entrypoint `app/server.ts` + the pure policy/log layer `app/server_config.ts`, the `Dockerfile` +
`.dockerignore` + `scripts/docker_build.sh` + `docs/RUNNING_THE_IMAGE.md`. ADR `docs/adr/0016`, memory
[[deployable-image-composition-root]]. (`package.json`: tsx→deps + `serve` script; `tsconfig.json`: `app`
added to include; `product/src/index.ts`: compose export.)

## The load-bearing insights (carry forward)
- **The composition root is the imperative shell; ambient reality enters at exactly ONE place.** `compose`
  takes `{ clock, ids, operatorToken, seedDemo?, demoSlug? }` as config — reads no env, generates no token,
  logs nothing. `app/server.ts` is the one impure shell (env, wall clock, token gen, socket, signals). Same
  wiring tests with the deterministic doubles; only `main` touches the real world.
- **The determinism rail is preserved BY REACHABILITY, not by comment.** `SystemClock`/`RandomIdGenerator`
  live under `product/src/runtime/` and are exported from **NEITHER** barrel. The eval/loop replay core
  imports `@wedding-planner/shared` and never `@wedding-planner/product`, so a wall clock placed in `product`
  is physically unreachable from it. **Do NOT add a wall clock / random id to `shared`'s barrel** — it would
  put an ambient-time source one import away from the grader/loop core and erode replayability.
- **The operator credential is INJECTED, never baked — fail-closed.** No `ARG`/`ENV WP_OPERATOR_TOKEN` in the
  Dockerfile (a build ARG bakes into a layer). Policy in pure `app/server_config.ts`: env token ≥16-char floor
  else FAIL CLOSED; unset + `WP_SEED_DEMO` ⇒ generate a UUID + log ONCE; unset + non-demo ⇒ FAIL CLOSED (never
  auto-mint an admin credential into a prod log). Boot log is an allow-list — never echoes a provided token or
  a `tenant_id`/`operator_id`/balance.
- **The demo seed traverses the REAL lifecycle driver** (provision → activate via `OnboardingService`, not a
  direct `store.create`), so it's edge-indistinguishable from any active tenant (the Phase-14/15 mask holds);
  **no session is minted in compose** (nothing baked into boot state).
- **Non-obvious image constraint: the `SchemaRegistry` is EAGER + filesystem-backed.** Its constructor (first
  hit = the demo seed's `TenantStore.create`) reads ALL 16 `*/schemas/*.json` across all six workspaces;
  `REPO_ROOT` is anchored from `shared/src/repo_root.ts` via `import.meta.url` and verified against the root
  `package.json` name. So the image MUST ship every workspace's `schemas/` dir (the four non-product ones ship
  schemas only, not src). Lazy-per-key loading would shrink this but is a **core change** (deferred).
- **Runtime = `tsx`** (the repo emits no JS; tsx resolves the `@wedding-planner/*` path aliases). tsx is a
  runtime **dependency** so `npm ci --omit=dev` ships no test/lint toolchain. `CMD` execs tsx as PID 1
  (graceful SIGTERM, reproducible via the lockfile-pinned tsx); non-root `node` user; `HEALTHCHECK` /healthz only.

## Verification done this phase (real, not faked)
Built the image with the live Docker daemon and verified on the running container: themed `/t/demo` 200,
masked `/t/ghost` 404, 401 on unauth `/admin`, `/healthz` 200; runs as uid 1000; no `.git`/`.claude`/`ops`/
handoff in any layer; no `operator_token` in `docker history`; dev toolchain absent (tsx present); HEALTHCHECK
reaches `healthy`; `docker stop` → exit 0. Architect + doddy built-code re-review: **both APPROVE**, nothing
exploitable (only two cosmetic P2s folded: exclude `README.md` from the image; document the tsx-PID-1 coupling).

## Next action — your call. The product arc is done; pick the next high-value lever (ranked)
- **★ Enrich the product surface (the surface is now deployable but still thin).** The biggest open levers:
  (a) **HTML create/update forms** — the Phase-14 deferral; needs CSRF tokens (the first real mutation trust
  surface in the UI). (b) **The operator web console** — HTML over the Phase-15 `/admin` JSON (same CSRF/forms
  surface; today `/admin` is JSON-only). (c) **A wedding ↔ planning-engine seam** — link a wedding to a
  strategy genome / North Star (the long-promised engine↔surface connection — the surface and the
  self-improvement engine have never actually touched). (d) planner/couple **membership** modeling (today a
  session is minted by a credential-free login that doesn't verify the wedding).
- **A tsc-emit slim runtime** (recorded Phase-16 deferral) — emit JS + resolve path aliases so the image runs
  `node` directly (smaller, no tsx). Lower value; only matters near going-live.
- **Earlier offline-loop levers (still open, all incremental):** enrich the advisory corpus; a 4th tier-1 knob
  → 4-D search (needs a meaningful forge-free knob, else busywork); `comms_quality`/`intuitiveness` rubrics
  (judge-shaped → STOP-and-surface, ADR 0007 — do NOT build a stub). See git history.

## Standing rails (unchanged — do not weaken)
Offline-first (no real money/booking/comms; no prod/credentials — don't simulate them). **Building the image
is in-scope; running it for real — registry push, hosting, DNS, secrets, real tenants/payments/comms — is the
human crossing (exception #4). Build up to the line; never cross it or simulate having crossed it.** Don't
modify `ops/` or `CLAUDE.md` (human-reserved). Push only to this repo's `origin`. The named specialist
sub-agents (doddy/wolf/testineer/rigorous-architect) are **not provisioned** here — route adversarial reviews
through `general-purpose` agents carrying the persona lens (this run did, at design AND on the built code —
both APPROVE). **CI/exit-code lesson (still true):** never pipe `npm run build` to tail/grep when gating with
`&&` (the pipe masks the non-zero exit); run build standalone, check `$?`. `npm run build` runs from REPO ROOT.
