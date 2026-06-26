# Handoff

## Where things stand — Phase 12 (the customer-facing product surface BEGINS) is BUILT ✅
`.claude/plans/2026-06-25-phase-12-product-surface-multitenant-core.md` is **complete — all steps
ticked** (Step 0 design reviews + Steps 1–6), on branch **`build/phase-3-generalize-search`** (the open
review artifact for `main`; Phases 3–12 build on it; the loop's merge-keeper advances `main` when
green). Working tree clean. `npm run build && npm test && npm run lint` all green (**427 tests**, up
from 407 at the start of this run). `main` has Phase 1+2; this branch is the review artifact for
Phases 3–12.

**What changed — the arc turned outward.** The first four domains are all inward-facing (score /
measure / improve / operate the system itself). Phase 12 **opened the customer-facing product surface**
— the human-set first-class goal ([[customer-facing-product-surface-is-a-first-class-goal]]). It added
the **fifth domain `@wedding-planner/product`**: the `tenant` + `wedding` aggregates (JSON Schema
contracts 14 & 15 — the manifest is now **15**), the white-label `theme`, and — load-bearing — the
**tenant-isolation boundary**. ADR `docs/adr/0012`, memory [[multi-tenant-isolation-boundary]].

## The load-bearing insight (carry forward)
**Tenant isolation is enforced BY CONSTRUCTION** — the multi-tenancy analogue of the trusted-evidence
firewall ([[prod-trusted-evidence-channel]]: wall the channel, fail closed, no oracle). A
`TenantContext` for tenant A can NEVER read/list/write tenant B's data:
- **Unforgeable context via a WeakSet identity token** (`MINTED_CONTEXTS` in `tenant_context.ts`), NOT
  a symbol property. **doddy's built-code re-review proved the symbol-brand version was forgeable** —
  any holder of a real context could lift the symbol via `Object.getOwnPropertySymbols` and re-stamp a
  forged object for another tenant. WeakSet membership lives outside the object → nothing to copy. The
  resolver (`resolveBySlug`, slug = the transport-survivable routing primitive) is the sole adder; the
  context is `Object.freeze`d; a `declare`d phantom `unique symbol` gives compile-time nominal typing.
- **Partition key = `ctx.tenant_id` ONLY**; the record's own `tenant_id` is compare-only (vetoes a
  `PRODUCT.CROSS_TENANT_WRITE`). Lookup key is `(tenant_id, id)` — `id` alone is never a key (so two
  tenants may share a `wedding_id`; corrected a false "ids are tenant-namespaced" claim).
- **No existence oracle** (`read` returns `undefined`, foreign==missing, one code path);
  **liveness re-asserted at use, fail closed** (`isUsable` on every op; a context held past a
  suspension dies); normalized global slug uniqueness; `#`-private maps; no unscoped accessor.
- Proves **INTER-tenant** isolation only; intra-tenant auth (planner vs couple) → Phase 13.

## Standing directional goal (human-set 2026-06-25) — the product surface arc (NOW UNDER WAY)
Build it **offline-first, Docker-packaged, launch-ready** (onboarding/billing/comms simulated). **Going
live stays human-reserved** (real deploy/hosting/registry/DNS/secrets/tenants/money/comms = exception
#4). The planned arc (mine to revise): **12 domain core ✅ → 13 HTTP/auth → 14 web UI → 15
onboarding/billing sim → 16 Docker image**. The auto-landing tier-1 offline loop is untouched.

## What's new this phase (by step)
- **Step 0** — architect + doddy design reviews (both APPROVE-WITH-CHANGES); folded into a nine-invariant
  boundary spec. Central finding (both lenses): structural-TS forgeability → brand the context.
- **Step 1** — the `@wedding-planner/product` workspace skeleton (package.json, root workspaces,
  tsconfig paths+include, vitest alias, `ProductError`, barrel, README in house style).
- **Step 2** — `tenant` + `wedding` schemas-as-contracts (manifest 13→15, generated types via shared,
  drift guard bumped). Schemas encode the boundary up front (normalized slug, compare-only tenant_id).
- **Step 3** — the domain core: `tenant_context.ts` / `tenant_store.ts` / `tenant_scoped_repository.ts`
  / `wedding_repository.ts`. Injected clock/ids; validates against the contracts.
- **Step 4** — the isolation keystone (`tenant_isolation_keystone.test.ts`): adversarial cases (a)–(h)
  incl. the re-stamp attack (d)(iv) and the #-privateness witness.
- **Step 5** — doddy built-code re-review: found + fixed the **P1 brand re-stamp** (symbol→WeakSet) and
  two honesty gaps; doddy then **APPROVE** on the fix.
- **Step 6** — ADR 0012 + memory [[multi-tenant-isolation-boundary]] + MEMORY.md index + README (fifth
  domain row + status) + this handoff.

## Next action — your call. The big remaining levers (ranked)
- **★ CONTINUE THE PRODUCT ARC — Phase 13: the HTTP API + simulated auth/session.** The natural next
  step: a transport layer (an HTTP server) that resolves a `TenantContext` from a request
  (Host/path → slug → `resolveBySlug`) and exposes tenant-scoped endpoints over the Phase-12
  repositories. This is where **auth principals** (planner vs couple) land — the *intra-tenant*
  authorization boundary Phase 12 deliberately deferred (a distinct, finer-grained gate). Stack choice
  is yours (the repo is dependency-light — consider Node's built-in `http`, or a minimal framework;
  keep it offline + injected-clock + testable). Write a plan (`writing-plans`), design the request→context
  seam so it CANNOT route around the isolation boundary, and prove it with a keystone (an HTTP-level
  cross-tenant attack is vetoed). Verify with doddy (the new trust boundary is the request edge).
- **Enrich the product domain instead** — before HTTP, optionally deepen the domain: a richer `wedding`
  (link to the planning engine's strategy genome / North Star per wedding), planner/couple membership
  modeling, or theme validation helpers. Lower risk, but HTTP is the higher-value path to a demoable app.
- **Earlier offline-loop levers (still open, all incremental):** enrich the advisory corpus
  (category/qa scenarios → more recommendation variety); a 4th tier-1 knob → 4-D search (needs a
  meaningful forge-free knob, else busywork); `comms_quality`/`intuitiveness` rubrics (judge-shaped →
  STOP-and-surface, ADR 0007 — do NOT build a stub). See the Phase-11 handoff history in git.

## Non-obvious Phase-12 context (carry forward)
- **The WeakSet brand is the crux.** Do NOT "simplify" `TenantContext` back to a symbol property or a
  plain `{tenant_id}` — doddy proved both are forgeable. The runtime guard is WeakSet membership; the
  `declare`d symbol is compile-time-only (no runtime property, so `getOwnPropertySymbols` is empty).
  Keystone (d)(iv) is the regression that pins this; it would pass trivially if you reverted, so also
  keep the "zero own symbols" assertion.
- **Generated contract types live in `shared/`** (`shared/src/contracts/generated/`, surfaced via
  `contract_types.ts` + the shared barrel), even for product schemas — `npm run gen:types` writes there.
  The product barrel re-exports `Tenant`/`Wedding` from `@wedding-planner/shared`.
- **`getSchemaRegistry()` is process-cached** — it reads all 15 schemas once. New schemas must be in the
  manifest (`shared/src/contracts/contract_manifest.ts`) AND the drift test count (currently 15).
- **`npm install` is needed after adding a workspace** (the symlink in node_modules); done this run.
- **Liveness coupling is intentional:** `TenantScopedRepository` depends on a `TenantLivenessCheck`
  (the `TenantStore`) so it can re-assert usability at use. That coupling IS the fail-closed property;
  don't remove it to "decouple".
- **CI/exit-code lesson (still true):** never pipe `npm run build` to tail/grep when gating with `&&`
  (the pipe masks the non-zero exit). Run build standalone, check `$?`. `npm run build` runs from REPO ROOT.
- The repo's named specialist sub-agents (doddy/wolf/testineer/rigorous-architect) are **not provisioned**
  here — route adversarial reviews through `general-purpose` agents carrying the persona lens (this run
  did, for architect + doddy at design, and doddy twice on the built code — which caught the P1).
- Durable facts: `MEMORY.md` index — Phase 12 added **[[multi-tenant-isolation-boundary]]**. Still
  load-bearing from the engine arc: [[prod-trusted-evidence-channel]], [[loop-trusted-evidence-boundary]],
  [[advisory-tier2-promotable-recommendations]], [[tier2-promotion-gate-is-load-bearing]],
  [[genome-content-address-firewall]], [[customer-facing-product-surface-is-a-first-class-goal]].
