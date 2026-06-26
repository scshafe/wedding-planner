# Handoff

## Where things stand — Phase 13 (the HTTP request edge + the intra-tenant auth boundary) is BUILT ✅
`.claude/plans/2026-06-25-phase-13-http-api-auth-session.md` is **complete — all 8 steps ticked**
(Step 0 design reviews + Steps 1–7), on branch **`build/phase-3-generalize-search`** (the open review
artifact for `main`; Phases 3–13 build on it; the loop's merge-keeper advances `main` when green).
Working tree clean. `npm run build && npm test && npm run lint` all green (**465 tests**, up from 427
at the start of this run). `main` has Phase 1+2; this branch is the review artifact for Phases 3–13.

**What changed — the product surface got a request edge.** Phase 12 opened the customer-facing product
surface with the multi-tenant domain core + the **inter-tenant** isolation boundary
([[multi-tenant-isolation-boundary]]). Phase 13 added the **transport edge** (a pure HTTP handler + a
thin Node `http` adapter over a 5-stage pipeline) and the **simulated auth/session** layer, which
stacks the **intra-tenant** authorization boundary (planner vs couple) that Phase 12 deferred. ADR
`docs/adr/0013`, memory [[http-edge-and-intra-tenant-auth]].

## The load-bearing insight (carry forward)
**Two stacked boundaries; the edge can route around NEITHER, by construction.** Inter-tenant = the
Phase-12 `TenantContext`. Intra-tenant (NEW) = a `Principal` (planner sees the whole tenant; couple is
bound to ONE wedding). The crux mirrors Phase 12's no-existence-oracle one layer up:
- **One 5-stage pipeline** (`product/src/http/product_api.ts`): parse → resolve tenant (slug from the
  route → `resolveBySlug` = the SOLE per-request context mint) → authenticate (Bearer → `sessionStore.resolve`)
  → **bind** (`principal.tenant_id === context.tenant_id`, else 401 — the cross-tenant replay veto) →
  authorize+dispatch.
- **Handler purity is STRUCTURAL, not prose** (architect P1-A): the `ProductApi` instance is the only
  holder of `resolver`/`sessionStore`; dispatch handlers are module-level fns taking only `(ctx,
  principal, req)` + a narrow `{weddings, authorizer}` bag → they physically cannot mint a foreign-tenant
  context (a `TenantContext` is resolver-only-minted).
- **`Principal` is sole-minted by `SessionStore` + WeakSet-branded** (same mechanism + doddy reason as
  the context). Token is an opaque server handle, not a client claim; principal `tenant_id` from the
  RESOLVED context, never a slug echo.
- **No intra-tenant existence oracle** — a couple addressing a NON-owned wedding is a **byte-identical
  404** to a missing one; ownership decided STRUCTURALLY from `principal.wedding_id` BEFORE any repo
  lookup (foreign-exists / own-absent / missing / unknown-route all → one frozen `RESP_NOT_FOUND`). A
  capability the role lacks (couple create) → 403. `errorToResponse` emits code-free constant bodies.
- **Login is a labeled SIMULATION, oracle-free** (doddy P0): requires only a usable tenant; does NOT
  verify a credential and does NOT confirm the couple's `wedding_id`. Body smuggling
  (tenant_id/wedding_id/__proto__) closed.

## Standing directional goal (human-set 2026-06-25) — the product surface arc (UNDER WAY)
Build it **offline-first, Docker-packaged, launch-ready** (onboarding/billing/comms simulated). **Going
live stays human-reserved** (real deploy/hosting/registry/DNS/secrets/tenants/money/comms = exception
#4). The planned arc (mine to revise): **12 domain core ✅ → 13 HTTP/auth ✅ → 14 web UI → 15
onboarding/billing sim → 16 Docker image**. The auto-landing tier-1 offline loop is untouched.

## What's new this phase (by step)
- **Step 0** — architect + doddy design reviews (both APPROVE-WITH-CHANGES); folded. Biggest changes:
  dropped the couple-login wedding-existence precondition (the loudest oracle); couple ownership decided
  structurally before any repo lookup; structural handler purity; code-free constant 404/401/500.
- **Step 1** — the auth core: `Principal` (WeakSet-branded, `assertMintedPrincipal`) + `SessionStore`
  (sole mint, opaque token, #-private map). +7 PRODUCT.* request-edge codes.
- **Step 2** — `WeddingAuthorizer`: pure, brand-checked; couple ownership structural-before-repo; the
  mask-not-found / forbidden distinction; couple list = zero-or-one from the principal.
- **Step 3** — the pure handler: 5-stage pipeline, route table, `errorToResponse`, body hardening.
- **Step 4** — the thin Node `http` adapter (`createProductApiServer`) + an ephemeral-port integration test.
- **Step 5** — the HTTP keystone (`product/tests/http/product_api_keystone.test.ts`): 12 adversarial
  cases (a)–(j) incl. cross-tenant replay, the all-directions byte-identical 404, body smuggling, the
  unauth-wrong-method, and the login-non-oracle.
- **Step 6** — doddy built-code re-review: **APPROVE, nothing exploitable** (no P0/P1/P2). Pinned the
  one residual (status cast safe only because schema validation runs downstream).
- **Step 7** — ADR 0013 + memory [[http-edge-and-intra-tenant-auth]] + MEMORY.md index + README (root +
  product) + this handoff.

## Next action — your call. The big remaining levers (ranked)
- **★ CONTINUE THE PRODUCT ARC — Phase 14: the web UI (planner console + couple view), themed per
  tenant.** The natural next step: a real (offline) browser-facing surface over the Phase-13 JSON API,
  themed from the tenant's white-label `theme` (brand_name + colors + logo_ref). This is the first phase
  that makes the product *demoable to a human*. Stack choice is yours — keep it offline + dependency-light
  + testable. Options: server-rendered HTML from the existing Node adapter (no build step, simplest,
  keeps zero new deps), or a small SPA (heavier; a build step + deps). **Recommendation: start
  server-rendered** (a `/t/:slug/...` HTML surface reusing the pipeline + a couple/planner view gated by
  the SAME `Principal`), so the UI inherits both boundaries with no new trust surface; add interactivity
  later. Write a plan (`writing-plans`); the load-bearing concern is that the UI introduces NO new way to
  route around the two boundaries (it must go through `ProductApi`, never the repos directly), and that
  theming can't inject script (XSS — escape `theme` fields; doddy lens on the render). Verify with doddy.
- **Enrich the product domain/API instead** — before UI: a wedding↔planning-engine seam (link a wedding
  to a strategy genome / North Star per wedding — the long-promised connection of the engine to the
  surface), planner/couple *membership* modeling (multiple planners/couples per tenant; today a couple
  is a self-asserted login), or a field-level couple write policy (the Phase-13 deferral). Lower-risk,
  but UI is the higher-value path to a demoable app.
- **Earlier offline-loop levers (still open, all incremental):** enrich the advisory corpus; a 4th
  tier-1 knob → 4-D search (needs a meaningful forge-free knob, else busywork); `comms_quality`/`intuitiveness`
  rubrics (judge-shaped → STOP-and-surface, ADR 0007 — do NOT build a stub). See git history.

## Non-obvious Phase-13 context (carry forward)
- **Do NOT add a JSON Schema for the session/principal** — it is transient simulated auth state, not a
  persisted aggregate (the manifest stays at 15). The `tenant`/`wedding` aggregates keep their contracts.
- **The `errorToResponse` catch is on `WeddingPlannerError`, not `ProductError`** — deliberately broader,
  so the shared `CONTRACT.VALIDATION_FAILED` from a bad create/update body maps to 400 (not the 500
  default). If you add a new throw path, decide its status in `errorToResponse` or it falls to 500.
- **Keep the no-oracle invariants if you touch the handler:** (1) couple ownership decided structurally
  BEFORE any repo lookup; (2) the masked 404, the 401, and the 500 are each ONE frozen constant (code-free
  body); (3) auth+bind run BEFORE any 405/route-shape check; (4) for PUT, authorize→mask runs BEFORE body
  parse; (5) identity from the route + ownership from the context, applied LAST. The keystone pins all of
  these; reverting any would regress an oracle the keystone catches.
- **Handler purity is the narrow deps bag.** Don't hand the dispatch handlers the `resolver`/`sessionStore`
  to "simplify" — that bag being narrow is what makes "no handler mints a foreign context" structural.
- **The status cast (`as Wedding['status']`) is safe only because schema validation runs downstream** —
  keep validation after the cast on any refactor (commented at both sites).
- **The Node adapter is the ONLY socket-touching code** — all policy lives in the pure handler, which is
  why the keystone needs no socket. A 1MB body cap → 413 is the only DoS guard (timeouts deferred to going-live).
- The repo's named specialist sub-agents (doddy/wolf/testineer/rigorous-architect) are **not provisioned**
  here — route adversarial reviews through `general-purpose` agents carrying the persona lens (this run
  did, for architect + doddy at design, and doddy on the built code — APPROVE, nothing exploitable).
- **CI/exit-code lesson (still true):** never pipe `npm run build` to tail/grep when gating with `&&`
  (the pipe masks the non-zero exit). Run build standalone, check `$?`. `npm run build` runs from REPO ROOT.
- Durable facts: `MEMORY.md` index — Phase 13 added **[[http-edge-and-intra-tenant-auth]]**. Still
  load-bearing: [[multi-tenant-isolation-boundary]], [[prod-trusted-evidence-channel]],
  [[customer-facing-product-surface-is-a-first-class-goal]], [[agents-own-buildout-decisions]].
