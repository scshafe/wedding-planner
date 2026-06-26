# Handoff

## Where things stand — Phase 15 (onboarding + billing simulation) is BUILT ✅
`.claude/plans/2026-06-26-phase-15-onboarding-billing-sim.md` is **complete — all 8 steps ticked**
(Step 0 design reviews + Steps 1–7), on branch **`build/phase-3-generalize-search`** (the open review
artifact for `main`; Phases 3–15 build on it; the loop's merge-keeper advances `main` when green).
Working tree clean. `npm run build && npm test && npm run lint` all green (**559 tests**, up from 517
at the start of this run). `main` has Phase 1+2; this branch is the review artifact for Phases 3–15.

**What changed — the tenant got a real birth and the lifecycle got a driver.** Before Phase 15 a tenant was
born as a test fixture (`TenantStore.create()` called directly; `lifecycle_status` flipped by hand;
`plan_tier` inert). Phase 15 adds a simulated, **operator-gated** provisioning + billing layer: a third
trust tier (a tenant-less platform **`Operator`**, peer of `Principal`) provisions tenants and drives
`onboarding → active → suspended → active` through a modeled billing ledger, over an operator-gated
`/admin` surface folded into the SAME `api.handle()` pipeline. New code: `product/src/auth/operator_credential.ts`,
`product/src/billing/{price_book,billing_ledger}.ts`, `product/src/onboarding/onboarding_service.ts`, the
`/admin` fold in `product/src/http/product_api.ts`, the 16th schema `product/schemas/billing_event_schema.json`.
ADR `docs/adr/0015`, memory [[onboarding-billing-operator-tier]].

## The load-bearing insight (carry forward)
**Provisioning is OPERATOR-gated precisely so it adds NO new anonymous oracle.** The JSON edge already
discloses active existence (`401` active vs `404` unknown) while keeping **absent ≡ suspended ≡ onboarding
byte-identical** (`404`). A naive **anonymous self-serve signup** would break that mask — a synchronous
"slug taken/available" reply is a tenant-existence oracle for *every* lifecycle state, and an async
claim-ticket doesn't fix it (only adds a round-trip). The **only structural fix is a credential gate**, so
provisioning sits behind an operator credential; the mask is preserved **by construction** (anonymous users
have no provisioning access). Anonymous public self-serve signup is a **recorded deferral** (slug-occupancy
disclosure + abuse-control = going-live hardening). The onboarding keystone re-proves the mask.

## Standing directional goal (human-set 2026-06-25) — the product surface arc (UNDER WAY)
Build it **offline-first, Docker-packaged, launch-ready** (onboarding/billing/comms simulated). **Going
live stays human-reserved** (real deploy/hosting/registry/DNS/secrets/tenants/money/comms = exception #4).
The arc (mine to revise): **12 domain core ✅ → 13 HTTP/auth ✅ → 14 web UI ✅ → 15 onboarding/billing sim ✅
→ 16 Docker image**. The auto-landing tier-1 offline loop is untouched.

## What's new this phase (by step)
- **Step 0** — architect + doddy design reviews (both APPROVE-WITH-CHANGES); folded. Biggest folds: the
  legal-transition guard (+`ILLEGAL_LIFECYCLE_TRANSITION`); operator-auth as the literal first `/admin`
  statement + the all-methods/`:id`-garbage keystone; the login edge added to the masked-404 set;
  `DUPLICATE_SLUG → 409`; operator tier under `auth/`; bare-`Map.get` resolve; per-kind `amount_cents`.
- **Step 1** — `billing_event` schema (16th contract; per-kind `amount_cents` if/then/else) + `price_book`
  (total, integer cents) + `BillingLedger` (`#`-private per-tenant, fold = Σcharge−Σpayment, positive=owed).
- **Step 2** — `auth/operator_credential.ts`: the `Operator` tier (sole-mint, WeakSet+phantom-brand, frozen;
  separate token namespace; bare `Map.get` resolve; constructor-injected token).
- **Step 3** — `OnboardingService`: provision/activate/suspend/reactivate with the legal-transition guard
  (illegal edge records NO event); no session minted at provision.
- **Step 4** — the `/admin` HTTP edge folded into `ProductApi.#route` (operator-auth first statement; narrow
  `{ onboarding }` bag; `NO_OPERATOR→401`, `DUPLICATE_SLUG`/`ILLEGAL_LIFECYCLE_TRANSITION→409`). All 6
  `ProductApi` construction sites wired with the two new deps.
- **Step 5** — THE ONBOARDING KEYSTONE (`product/tests/onboarding/onboarding_keystone.test.ts`).
- **Step 6** — built-code re-review (architect + doddy): **both APPROVE**; only fold was `billingView`'s
  `#requireTenant` existence guard (unknown tenant → masked `404`, was a fabricated empty `200`).
- **Step 7** — ADR 0015 + memory [[onboarding-billing-operator-tier]] + MEMORY.md index + READMEs (root +
  product) + this handoff.

## Next action — your call. The big remaining levers (ranked)
- **★ FINISH THE PRODUCT ARC — Phase 16: the deployable Docker image.** The last rung of the human-set arc:
  package the offline product surface as a locally-runnable, **launch-ready** Docker image a human could
  deploy. Likely needs: a small composition root / entrypoint that wires the stores + `ProductApi` +
  `createProductWebUiServer` and seeds an operator credential + a demo tenant (so the image boots into a
  themed, demoable app); a `Dockerfile` (multi-stage: build TS → slim runtime; no client JS, no new runtime
  deps beyond Node); a healthcheck (`/healthz` already exists); a documented run recipe. **CRITICAL RAIL:**
  *producing the image is in-scope; running it for real — deploy/hosting/registry push/DNS/secrets/real
  tenants/payments/comms — is the human-reserved crossing (exception #4). Build up to the line; do NOT push
  to a registry, do NOT simulate having deployed.* The operator token + any seed creds are offline
  placeholders, never real secrets. Verify with doddy (the entrypoint is a new trust seam — where do the
  operator token + seed come from; are they injected, not baked as a real secret) + rigorous-architect (the
  composition root + image layering). Note: no Docker daemon may be available in this environment — if so,
  author the Dockerfile + entrypoint + compose/run docs and a build script, verify what you can offline
  (the entrypoint boots, healthz responds), and record the "build the image on a Docker host" step as the
  human-runnable handoff rather than faking a build.
- **Enrich the product surface instead** — HTML create/update forms (the Phase-14 deferral — needs CSRF
  tokens, the first real mutation trust surface in the UI); the operator web console (HTML over the Phase-15
  `/admin` JSON — same CSRF/forms surface); a wedding↔planning-engine seam (link a wedding to a strategy
  genome / North Star — the long-promised engine↔surface connection); planner/couple *membership* modeling.
- **Earlier offline-loop levers (still open, all incremental):** enrich the advisory corpus; a 4th tier-1
  knob → 4-D search (needs a meaningful forge-free knob, else busywork); `comms_quality`/`intuitiveness`
  rubrics (judge-shaped → STOP-and-surface, ADR 0007 — do NOT build a stub). See git history.

## Non-obvious Phase-15 context (carry forward)
- **Operator-gated ⇒ no anonymous oracle — never add an anonymous slug-availability check.** The mask
  (absent≡suspended≡onboarding) survives only because there is NO anonymous provisioning surface.
- **Three separate token namespaces, never merged.** Operator auth is its own stage/store; `resolve` is a
  bare `#byToken.get` with NO shape/prefix gate. Don't let the operator store reach a tenant context or a
  handler reach the operator store. `Operator` mirrors `Principal` exactly (brand+mint never in the barrel).
- **Operator-auth is the LITERAL first statement of the `/admin` branch** — keep it that way; nothing that
  can throw or distinguish route shape may run before it. `/admin` stays in the ONE `api.handle` pipeline.
- **Lifecycle + ledger move together, atomically-on-success.** Every transition is guarded (legal edge only)
  THEN `setLifecycleStatus` + recorded event(s) in one call; an illegal edge records NOTHING. `setLifecycleStatus`
  only validates the TARGET enum — the guard is what prevents a spurious, irreversible billing event.
- **Money is integer cents; the ledger IS the account (a fold), no aggregate; positive balance = owed.**
  The per-kind `amount_cents` rule is schema-enforced (if/then/else) AND re-checked in `record`.
- **Trusted-operator disclosure is intentional** (DUPLICATE_SLUG/illegal-transition `409`; operator sees all
  tenants/billing). The mask protects anonymous probers, not the operator — don't "fix" it as a leak.
- **Behavior-preserving:** `/t/:slug` + `/healthz` + the Phase-13/14 keystones stay byte-for-byte; the admin
  surface is strictly additive. The 6 `ProductApi` construction sites now pass `operators` + `onboarding`.
- The repo's named specialist sub-agents (doddy/wolf/testineer/rigorous-architect) are **not provisioned**
  here — route adversarial reviews through `general-purpose` agents carrying the persona lens (this run did,
  for architect + doddy at design AND on the built code — both APPROVE).
- **CI/exit-code lesson (still true):** never pipe `npm run build` to tail/grep when gating with `&&` (the
  pipe masks the non-zero exit). Run build standalone, check `$?`. `npm run build` runs from REPO ROOT.
- Durable facts: `MEMORY.md` index — Phase 15 added **[[onboarding-billing-operator-tier]]**. Still
  load-bearing: [[web-ui-themed-edge]], [[http-edge-and-intra-tenant-auth]], [[multi-tenant-isolation-boundary]],
  [[prod-trusted-evidence-channel]], [[customer-facing-product-surface-is-a-first-class-goal]],
  [[agents-own-buildout-decisions]].
