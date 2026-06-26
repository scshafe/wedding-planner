# Phase 15 — Onboarding + billing simulation (the lifecycle driver, offline)

## Why this, why now

The product arc is **12 domain core ✅ → 13 HTTP/auth ✅ → 14 web UI ✅ → 15 onboarding/billing sim →
16 Docker image**. Phases 12–14 built the multi-tenant domain, the two stacked unforgeable boundaries
(inter-tenant `TenantContext`, intra-tenant `Principal`), a pure JSON edge, and a themed HTML console.
But a tenant is still **born as a test fixture**: `TenantStore.create()` is called directly in seeds/tests,
`lifecycle_status` is flipped by hand, and `plan_tier` is an inert label. The `onboarding`/`suspended`
states the resolver already **fails closed on** ([[web-ui-themed-edge]], [[multi-tenant-isolation-boundary]])
have **no driver**. `session_store.ts` literally defers the matter: *"Real credential verification is a
Phase-15 onboarding concern."*

Phase 15 gives the lifecycle a **driver** and the tenant a **real birth**: a simulated provisioning +
billing layer that creates a tenant (the full birth — tenant + its first planner + a billing account),
and drives `onboarding → active → suspended → active` through modeled billing events. All **offline** —
no real money, no real provisioning (CLAUDE.md rail; going-live = operations exception #4).

## The crux: a new trust tier, gated so it adds NO new oracle

Provisioning is a **new pre-auth surface**, and the handoff flags it: *"guard it the same no-oracle way."*
The decisive design fact, re-verified against `product_api.ts` + the Phase-13/14 disclosure analysis:

- The JSON edge **already discloses active-tenant existence** (`GET /t/:slug/weddings` → `401` active vs
  `404` unknown) while keeping **absent ≡ suspended ≡ onboarding byte-identical** (`404`). The protected
  secret is *absent-vs-not-usable*.
- A naive **anonymous self-serve signup** would **break that mask**: a synchronous "slug taken / available"
  reply is a tenant-existence oracle for **every** lifecycle state (it newly discloses suspended/onboarding
  existence, which the `404` mask hides). An async claim-ticket doesn't fix it — it only adds a round-trip;
  the holder of the ticket still learns occupancy, so enumeration survives. The *only* structural fix is to
  put provisioning **behind a credential**.

**Decision (mine, owned): provisioning is OPERATOR-gated, not anonymous self-serve.** A third trust tier —
a simulated **platform operator** (the white-label vendor / the agent-run platform itself) — provisions and
bills tenants. This:

- gives the tenant a **real birth flow** (replacing direct fixture creation) and the lifecycle a **driver**;
- preserves the absent≡suspended≡onboarding mask **by construction** — anonymous users have **no**
  provisioning access, so no new enumeration oracle is introduced;
- mirrors how white-label SaaS actually provisions (the platform owner/operator stands up tenants), and is
  true to this repo ("entirely agent-managed" — provisioning is an operational act above any one tenant).

**Anonymous public self-serve signup is an explicit DEFERRAL**, recorded with its tradeoff: it inherently
discloses bounded slug-occupancy and needs rate-limits/abuse-control (and an accepted disclosure budget) —
that is going-live hardening, human-reserved. We build the secure core now; we do not fake the public form.

## The design — a third trust tier + a billing ledger, additive over the JSON edge

New modules `product/src/billing/` and `product/src/onboarding/`. The Phase-12/13/14 code is **behavior-
preserving**: `TenantStore.create()` / `setLifecycleStatus` stay (the OnboardingService is an ADDITIVE
caller of them, not a replacement), so the existing 517 tests do not churn. The admin surface is folded
into the **same** `ProductApi.handle` pipeline (one edge), with its own auth stage — never a second edge.

### Trust tiers (now three, each a sole-mint, WeakSet-branded, `#`-private-store subject)

| tier | subject | sole mint | scope | presented as |
| --- | --- | --- | --- | --- |
| inter-tenant | `TenantContext` | `TenantContextResolver` | one tenant | (derived from route slug) |
| intra-tenant | `Principal` (planner/couple) | `SessionStore` | one wedding-set within a tenant | `Authorization: Bearer` on `/t/:slug/...` |
| **platform (new)** | **`Operator`** | **`OperatorCredentialStore`** | the whole platform (tenant-less) | `Authorization: Bearer` on `/admin/...` |

The operator store is a **separate token namespace** from `SessionStore`: a tenant session token is simply
**absent** in the operator store (→ `401`), and an operator token is absent in the session store (→ `401`).
No cross-namespace confusion — the stores never share a map. `Operator` carries the same unforgeability
construction as `Principal` (compile-time phantom brand + a module-private `WeakSet` identity token +
`Object.freeze`; brand + mint never exported from the barrel).

### Billing model (one new schema)

- `billing_event_schema.json` (registered in the contract manifest; the drift-guard test enforces it):
  an append-only ledger event `{ event_id, tenant_id, kind, amount_cents?, occurred_at, plan_tier? }`.
  `kind ∈ { provisioned, activated, charge, payment, suspended, reactivated }`. **Money is integer cents**
  (`amount_cents: integer ≥ 0`) — never a float. `occurred_at` from the injected clock, `event_id` from the
  injected id generator (no ambient time/RNG).
- No separate "billing account" aggregate — `plan_tier` already lives on `Tenant`, and the **account is the
  fold**: balance = Σ(charge) − Σ(payment) over a tenant's events. Avoids a duplicated source of truth.
- `price_book.ts` — pure `plan_tier → amount_cents` (modeled, documented-fictional: solo/studio/agency).
  Deterministic; no I/O.
- `BillingLedger` — `#`-private per-tenant append-only event list (no enumeration leak), injected clock/ids.
  `record(...)`, `eventsFor(tenant_id)`, `balanceCents(tenant_id)`.

### Onboarding service (the orchestrator)

`OnboardingService` holds `{ tenants: TenantStore, sessions: SessionStore, billing: BillingLedger, prices }`
and is the canonical lifecycle driver:

- `provision(input) → { tenant, bootstrap }` — `tenants.create(...)` (lifecycle = **onboarding**) + mint the
  **first planner** session (`sessions.login(context, { role:'planner' })` against a freshly-resolved
  context) + `billing.record(provisioned)`. Returns the tenant's public view + the planner's bootstrap token.
- `activate(tenant_id)` — simulate first payment: `billing.record(payment)` + `record(activated)` +
  `tenants.setLifecycleStatus(id,'active')`. **onboarding → active.**
- `suspend(tenant_id)` — `record(suspended)` + `setLifecycleStatus(id,'suspended')`. **active → suspended**
  (the modeled delinquency path). A context minted while active stops working the instant this lands
  (liveness is re-checked at every repo op — Phase 12).
- `reactivate(tenant_id)` — `record(payment)` + `record(reactivated)` + `setLifecycleStatus(id,'active')`.
  **suspended → active.**

Every transition funnels through the **existing** `setLifecycleStatus` (the single mutation point) and
records a billing event in the **same** call, so lifecycle and ledger cannot drift.

### HTTP edge — operator-gated `/admin/...` (one pipeline, new auth stage)

Folded into `ProductApi.#route`, OUTSIDE `/t/:slug` (admin never touches a tenant context):

- `POST   /admin/tenants`                  → provision → `201 { tenant, bootstrap_token }`
- `POST   /admin/tenants/:id/activate`     → `200 { tenant }`
- `POST   /admin/tenants/:id/suspend`      → `200 { tenant }`
- `POST   /admin/tenants/:id/reactivate`   → `200 { tenant }`
- `GET    /admin/tenants/:id/billing`      → `200 { events, balance_cents }`

Auth: a new `#authenticateOperator(req)` stage resolves the Bearer token via `OperatorCredentialStore`;
absent/unknown → constant `401`. **It runs BEFORE any `/admin` route-shape/method distinction** (the same
precedence the tenant pipeline pins): anonymous probing of `/admin/anything` returns a byte-identical `401`,
so admin **route shape is not a pre-auth oracle**. Handler purity is structural exactly as today: the admin
handlers get a NARROW deps bag `{ onboarding }`, never the operator store (which lives ONLY in the
pipeline, like `sessionStore`). Error codes stay code-free constants (`PRODUCT.NO_OPERATOR` → the existing
`401`; unknown admin sub-route under a valid operator → the existing masked `404`).

### What Phase 15 does NOT build (recorded deferrals, not faked)

- **Anonymous public self-serve signup** — the enumeration-oracle tradeoff above; going-live hardening.
- **The operator web console (HTML)** — the operator surface is JSON-only this phase. An HTML admin console
  is the first *mutation* UI and needs the CSRF/forms surface Phase 14 deferred; defer together.
- **Recurring/scheduled charges, dunning, proration, real currency/tax** — the ledger models discrete
  operator-driven events; a billing *scheduler* is out of scope (and `comms`/invoicing is going-live).
- **Operator RBAC / multiple operators / audit of operator actions** — one operator tier, flat, this phase.

## Steps

- [ ] **Step 0 — Design review (architect + doddy personas), fold findings.** Route through
  `general-purpose` agents carrying each lens (the named specialists are unprovisioned here — handoff).
  Vet: (a) the operator-tier separation + mask-preservation argument (operator-gated ⇒ no anonymous
  oracle); (b) admin-route precedence (operator-auth before route-shape ⇒ no pre-auth oracle); (c) the
  cross-namespace token story (session vs operator); (d) money-as-integer-cents + the ledger-as-account
  fold; (e) the anonymous-self-serve deferral is honest, not a hidden hole. Fold before coding.
- [ ] **Step 1 — Billing contract + price book.** Add `product/schemas/billing_event_schema.json`; register
  it in `contract_manifest.ts` (+ `ContractKey`, `CONTRACT_COUNT` follows); regen/extend generated types;
  the drift-guard + manifest tests stay green. Add `billing/price_book.ts` (pure `plan_tier → amount_cents`)
  with unit tests. `npm run build && npm test && npm run lint`.
- [ ] **Step 2 — `BillingLedger`.** `#`-private per-tenant append-only store, injected clock/ids,
  `record/eventsFor/balanceCents`, schema-validated events, money-as-cents. Unit tests (ordering, fold,
  no-enumeration-leak). Green.
- [ ] **Step 3 — The operator trust tier.** `onboarding/operator_credential.ts`: `Operator` (phantom brand +
  module-private `WeakSet` + `Object.freeze`), `OperatorCredentialStore` (sole mint, `#`-private token map,
  `resolve(token)`), seeded with a configured operator token (offline simulation, documented). Brand + mint
  NOT exported from the barrel. Unforgeability tests mirroring `principal`/`tenant_context`. Green.
- [ ] **Step 4 — `OnboardingService`.** provision/activate/suspend/reactivate over TenantStore + SessionStore
  + BillingLedger; every transition funnels `setLifecycleStatus` + records an event. Unit tests: full
  lifecycle, the ledger after each step, the bootstrap planner token actually authenticates. Green.
- [ ] **Step 5 — The `/admin` HTTP edge.** Fold the operator-auth stage + the admin route table into
  `ProductApi.#route` (precedence: operator-auth before route-shape); narrow `{ onboarding }` handler bag;
  code-free constant responses; wire `operators` + `onboarding` into `ProductApiDeps` and the node adapter.
  Behavior-preserving for `/t/:slug` + `/healthz` (existing `product_api` tests untouched). Green.
- [ ] **Step 6 — THE ONBOARDING KEYSTONE.** `product/tests/onboarding/onboarding_keystone.test.ts`:
  (1) operator boundary — anonymous + a *tenant-session* token → `/admin/*` byte-identical `401`, route
  shape not disclosed pre-auth; (2) mask preserved — provisioning gives anonymous probers no new
  absent-vs-suspended-vs-onboarding signal (the four `404` cases stay byte-identical across a provisioned-but-
  not-activated tenant); (3) the lifecycle drive end-to-end — provision (request edge `404`) → activate
  (edge now `401`/usable) → suspend (`404`) → reactivate (`401`), asserted **through `api.handle()`**;
  (4) cross-namespace — operator token rejected on `/t/:slug/weddings`, session token rejected on `/admin`;
  (5) billing fold correctness across the lifecycle. Green.
- [ ] **Step 7 — Built-code re-review (architect + doddy personas), fold.** Re-vet the *built* edge for an
  exploitable oracle/forge (operator-auth precedence, token-namespace bleed, the masked-404 set, the
  ledger's no-leak). Apply findings; re-run green.
- [ ] **Step 8 — ADR 0015 + memory + barrel + READMEs + handoff.** ADR `docs/adr/0015-onboarding-billing-
  simulation.md`; memory `.claude/memory/onboarding-billing-operator-tier.md` + index it in `MEMORY.md`;
  barrel exports for the new public types (NOT the brands/mints); update root + product READMEs; rewrite
  `.claude/handoff.local.md` (Phase 15 done; next lever = Phase 16 Docker image). Green; commit.

## Verification gate (every step)
`npm run build && npm test && npm run lint` all green before ticking a box or committing (build standalone,
check `$?` — never pipe it; it runs from repo root). Commit per verified step on `build/phase-3-generalize-search`.

## The load-bearing invariants to preserve (carry into the work)
- **Operator-gated ⇒ no anonymous oracle.** The mask (absent≡suspended≡onboarding) survives only because
  there is NO anonymous provisioning surface. Never add an anonymous slug-availability check.
- **Three separate token namespaces, never merged.** Operator auth is its own stage/store; a tenant session
  is absent there and vice versa. Don't let the operator store reach a tenant context, or a handler reach
  the operator store.
- **Operator-auth before admin route-shape.** Same precedence as the tenant pipeline — no pre-auth oracle.
- **Lifecycle and ledger move together.** Every transition is `setLifecycleStatus` + a recorded event in one
  call; the resolver's fail-closed predicate is unchanged (`USABLE_LIFECYCLE_STATUSES = ['active']`).
- **Money is integer cents; no ambient time/RNG.** Injected clock/ids everywhere; the ledger never floats.
- **Behavior-preserving for the JSON/HTML edge.** `/t/:slug` + `/healthz` + the Phase-13/14 keystones stay
  byte-for-byte. The admin surface is strictly additive.
</content>
</invoke>
