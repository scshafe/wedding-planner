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

The operator subject + store live under **`auth/`** (next to `principal.ts`/`session_store.ts` — `auth/` is
the home of *unforgeable subjects + their sole mints*; `Operator` is a peer of `Principal`, NOT an
onboarding concept — fold of architect P1-5). The operator store is a **separate token namespace** from
`SessionStore`: a tenant session token is simply **absent** in the operator store (→ `401`), and an operator
token is absent in the session store (→ `401`). No cross-namespace confusion — the stores never share a map.
`OperatorCredentialStore.resolve(token)` is a **bare `#byToken.get(token)`** — NO prefix/shape gate (a shape
check would be a cross-namespace shape/timing oracle; it must fail via the *same* opaque absent-key path as
`SessionStore.resolve` — fold of doddy P0-3). `Operator` carries the same unforgeability construction as
`Principal` (compile-time phantom brand + a module-private `WeakSet` identity token + `Object.freeze`; brand
+ mint never exported from the barrel). The operator token is **constructor-injected** (an offline-simulation
seam, never a module constant — fold of architect P2-8 / doddy P1-3), never echoed in any response/error
`context`, and the store is `#`-private/non-enumerating.

### Billing model (one new schema)

- `billing_event_schema.json` (registered in the contract manifest; the drift-guard test enforces it):
  an append-only ledger event `{ event_id, tenant_id, kind, amount_cents?, occurred_at }`.
  `kind ∈ { provisioned, charge, payment, suspended, reactivated }` — the tenant's **billing audit trail**
  (the `/admin/billing` view). **Money is integer cents** (`amount_cents: integer ≥ 0`) — never a float.
  `occurred_at` from the injected clock, `event_id` from the injected id generator (no ambient time/RNG).
  The schema **enforces `amount_cents` per-kind via `if/then/else`** (required iff `kind ∈ {charge,payment}`;
  forbidden otherwise) so the fold can never accidentally sum a non-financial marker (fold of architect P1-6).
- No separate "billing account" aggregate — `plan_tier` already lives on `Tenant`, and the **account is the
  fold**: `balanceCents = Σ(charge) − Σ(payment)` over a tenant's events, computed by **explicitly filtering
  to financial kinds** (never "sum every amount_cents"). **Convention (documented on `balanceCents` + the
  `balance_cents` response field): positive = money OWED** (a debit balance) — fold of architect P1-7.
- `price_book.ts` — a **total** `Record<PlanTier, amount_cents>` (exhaustive; modeled, documented-fictional:
  solo/studio/agency). Deterministic; no I/O. A `plan_tier` is validated by `tenants.create`'s schema check
  **before** any price lookup, so an unknown tier is a clean `400`, never an unmapped-key path (fold of doddy P1-1).
- `BillingLedger` — `#`-private per-tenant append-only event list (no enumeration leak), injected clock/ids.
  `record(...)`, `eventsFor(tenant_id)` (strict per-tenant filter — fold of doddy P2-1), `balanceCents(tenant_id)`.

### Onboarding service (the orchestrator, with a transition guard)

`OnboardingService` holds `{ tenants: TenantStore, sessions: SessionStore, billing: BillingLedger, prices }`
and is the canonical lifecycle driver. **It enforces a legal-transition guard** (fold of architect P0-1 /
doddy P1-2): each method reads the current `lifecycle_status` (`tenants.findById`) and throws
`PRODUCT.ILLEGAL_LIFECYCLE_TRANSITION` **before recording anything** if the edge is illegal — so no spurious
billing event can ever land (`setLifecycleStatus` only validates the *target* enum, not the *transition*; an
unguarded double-`activate` would corrupt the irreversible fold). The legal edges:

- `provision(input) → { tenant, bootstrap }` — `tenants.create(...)` (lifecycle = **onboarding**; this is the
  ONLY legitimately-throwing step and runs FIRST, so a `DUPLICATE_SLUG` leaves NO partial state — no orphan
  session/event, fold of architect P1-4) + mint the **first planner** session (`sessions.login(context,
  { role:'planner' })` against a freshly-resolved context) + `billing.record(provisioned)`. Returns the
  tenant's public view + the planner's bootstrap token. **∅ → onboarding.**
- `activate(tenant_id)` — guard `onboarding → active`; `billing.record(charge)` + `record(payment)` +
  `tenants.setLifecycleStatus(id,'active')`. **onboarding → active.**
- `suspend(tenant_id)` — guard `active → suspended`; `record(suspended)` + `setLifecycleStatus(id,'suspended')`.
  The modeled delinquency path. A context minted while active stops working the instant this lands (liveness
  re-checked at every repo op — Phase 12). **active → suspended.**
- `reactivate(tenant_id)` — guard `suspended → active`; `record(charge)` + `record(payment)` +
  `record(reactivated)` + `setLifecycleStatus(id,'active')`. **suspended → active.**

Every *successful* transition funnels through the **existing** `setLifecycleStatus` (the single mutation
point) and records its event(s) in the **same** call; an illegal transition records nothing — so lifecycle
and ledger move together, atomically-on-success.

### HTTP edge — operator-gated `/admin/...` (one pipeline, new auth stage)

Folded into `ProductApi.#route`, OUTSIDE `/t/:slug` (admin never touches a tenant context):

- `POST   /admin/tenants`                  → provision → `201 { tenant, bootstrap_token }`
- `POST   /admin/tenants/:id/activate`     → `200 { tenant }`
- `POST   /admin/tenants/:id/suspend`      → `200 { tenant }`
- `POST   /admin/tenants/:id/reactivate`   → `200 { tenant }`
- `GET    /admin/tenants/:id/billing`      → `200 { events, balance_cents }`

Auth: `const operator = this.#authenticateOperator(req)` is the **literal first statement** inside the
`/admin` block (fold of both reviewers' P0) — it resolves the Bearer token via `OperatorCredentialStore`;
absent/unknown → constant `401`. **Every** subsequent failure inside `/admin` (bad method, unknown
sub-route, missing/garbage `:id`, malformed body) is reachable **only after** auth passes, and maps to the
masked `404` / `400` — never a `405`/`404`/`400` reachable pre-auth. So anonymous probing of `/admin/...`
with ANY method returns a byte-identical `401`, and admin **route shape is not a pre-auth oracle**. A
non-`admin`/`t`/`healthz` top-level path still falls to the existing `routeNotFound()` (masked `404`) with
**no operator-auth attempted** — `/admin`-prefix existence is itself not signalled. Handler purity is
structural exactly as today: the admin handlers get a NARROW deps bag `{ onboarding }`, never the operator
store (which lives ONLY in the pipeline, like `sessionStore`). Error codes stay code-free constants:
`PRODUCT.NO_OPERATOR` → the existing `401`; unknown admin sub-route / unknown tenant id → the existing masked
`404`; `PRODUCT.ILLEGAL_LIFECYCLE_TRANSITION` → `409`; and **`PRODUCT.DUPLICATE_SLUG` → `409`** (the operator
is trusted, so a slug collision is honestly reported to them — NOT masked to `404`, NOT a latent `500`; fold
of architect P0-3).

### What Phase 15 does NOT build (recorded deferrals, not faked)

- **Anonymous public self-serve signup** — the enumeration-oracle tradeoff above; going-live hardening.
- **The operator web console (HTML)** — the operator surface is JSON-only this phase. An HTML admin console
  is the first *mutation* UI and needs the CSRF/forms surface Phase 14 deferred; defer together.
- **Recurring/scheduled charges, dunning, proration, real currency/tax** — the ledger models discrete
  operator-driven events; a billing *scheduler* is out of scope (and `comms`/invoicing is going-live).
- **Operator RBAC / multiple operators / audit of operator actions** — one operator tier, flat, this phase.

## Steps

- [x] **Step 0 — Design review (architect + doddy personas), fold findings.** Both APPROVE-WITH-CHANGES;
  all P0/P1 folded into this plan above. Biggest folds: the **legal-transition guard** (`setLifecycleStatus`
  only checks the target enum, not the edge — an unguarded double-`activate` corrupts the irreversible fold)
  + `PRODUCT.ILLEGAL_LIFECYCLE_TRANSITION`; **`#authenticateOperator` as the literal first statement** of the
  `/admin` block (so no method/route-shape `405`/`404`/`400` is reachable pre-auth) + the all-methods/`:id`-
  garbage keystone assertion; the **login edge** added to the masked-404 set (a provisioned-onboarding tenant
  must stay byte-identical on `POST /t/:slug/sessions`, not just `GET /weddings`); **`DUPLICATE_SLUG → 409`**
  (the operator is trusted) mapped explicitly (no fall-through `500`); operator tier moved under **`auth/`**;
  `OperatorCredentialStore.resolve` = **bare `Map.get`** (no shape gate); billing `amount_cents` **per-kind
  schema-enforced** + fold filters financial kinds + balance-sign convention documented; price-book a **total**
  map validated after `tenants.create`; operator token **constructor-injected**, never echoed. Steps 1+2 merged.
- [ ] **Step 1 — Billing contract + price book + `BillingLedger`** (merged per architect P2-10). Add
  `product/schemas/billing_event_schema.json` (the `if/then/else` per-kind `amount_cents` rule); register it
  in `contract_manifest.ts` (+ `ContractKey`, `CONTRACT_COUNT` follows); regen/extend generated types; the
  drift-guard + manifest tests stay green. Add `billing/price_book.ts` (total `Record<PlanTier, amount_cents>`)
  and `billing/billing_ledger.ts` (`#`-private per-tenant append-only, injected clock/ids,
  `record/eventsFor/balanceCents` — balance = Σcharge−Σpayment over *financial* kinds, positive=owed). Unit
  tests: price-book totality, ordering, the fold, the per-kind amount rule, no-enumeration-leak, strict
  per-tenant `eventsFor`. `npm run build && npm test && npm run lint`.
- [ ] **Step 2 — The operator trust tier.** `auth/operator_credential.ts` (under `auth/`, peer of
  `principal.ts` — architect P1-5): `Operator` (phantom brand + module-private `WeakSet` + `Object.freeze`),
  `OperatorCredentialStore` (sole mint, `#`-private token map, `resolve(token)` = **bare `Map.get`, no shape
  gate**), constructor-injected operator token (offline simulation, documented). Brand + mint NOT exported
  from the barrel. Tests: unforgeability (re-stamp attack fails) mirroring `principal`/`tenant_context`,
  no-token-leak via `JSON.stringify`, resolve fails closed for absent/foreign token. Green.
- [ ] **Step 3 — `OnboardingService`.** provision/activate/suspend/reactivate over TenantStore + SessionStore
  + BillingLedger, **with the legal-transition guard** (read current `lifecycle_status`; illegal →
  `PRODUCT.ILLEGAL_LIFECYCLE_TRANSITION` before any record). Unit tests: full happy lifecycle + the ledger
  after each step; **every illegal transition rejected and records NO event** (double-activate, suspend-an-
  onboarding, reactivate-an-active, activate-after-suspend); `provision` on a duplicate slug leaves no orphan
  state; the bootstrap planner token actually authenticates on `/t/:slug/weddings` once active. Green.
- [ ] **Step 4 — The `/admin` HTTP edge.** Fold the operator-auth stage + the admin route table into
  `ProductApi.#route` with `#authenticateOperator` as the **literal first statement** of the `/admin` block;
  narrow `{ onboarding }` handler bag (operator store stays in the pipeline); `errorToResponse` gains
  `ILLEGAL_LIFECYCLE_TRANSITION`/`DUPLICATE_SLUG → 409` and `NO_OPERATOR → 401`; wire `operators` +
  `onboarding` into `ProductApiDeps` + the node adapter. Behavior-preserving for `/t/:slug` + `/healthz`
  (existing `product_api`/keystone tests untouched). Green.
- [ ] **Step 5 — THE ONBOARDING KEYSTONE.** `product/tests/onboarding/onboarding_keystone.test.ts`:
  (1) operator boundary — anonymous + a *tenant-session* token → `/admin/*` byte-identical `401` across
  **GET/POST/PUT/DELETE** and across a `:id`-shaped garbage path (`/admin/tenants/x/activate`), proving
  method-mismatch + unknown-sub-route are unreachable pre-auth; an unknown top-level path (`/nonsense`) stays
  byte-identical `404` (no perturbation); (2) mask preserved — a provisioned-but-onboarding tenant is
  byte-identical `404` on **both** `GET /t/:slug/weddings` AND `POST /t/:slug/sessions` (the login edge must
  not become an onboarding oracle now that a real bootstrap session exists behind it — doddy P0-2), identical
  to absent/suspended; (3) the lifecycle drive end-to-end — provision (edge `404`) → activate (edge now
  `401`/usable) → suspend (`404`) → reactivate (`401`), asserted **through `api.handle()`**; (4)
  cross-namespace — operator token rejected (constant `401`) on `/t/:slug/weddings`, session token rejected
  (constant `401`) on `/admin`; (5) billing fold correctness across the lifecycle + operator querying tenant
  A's billing never returns tenant B's events; (6) `DUPLICATE_SLUG → 409` to the operator. Green.
- [ ] **Step 6 — Built-code re-review (architect + doddy personas), fold.** Re-vet the *built* edge for an
  exploitable oracle/forge (operator-auth precedence, token-namespace bleed, the masked-404 set incl. the
  login edge, the transition guard, the ledger's no-leak). Apply findings; re-run green.
- [ ] **Step 7 — ADR 0015 + memory + barrel + READMEs + handoff.** ADR `docs/adr/0015-onboarding-billing-
  simulation.md` (incl. doddy P2-2: the operator's legitimate cross-tenant visibility is by-design, not a
  leak — the mask protects *anonymous* probers, not the operator); memory
  `.claude/memory/onboarding-billing-operator-tier.md` + index it in `MEMORY.md`; barrel exports for the new
  public types (NOT the brands/mints); update root + product READMEs; rewrite `.claude/handoff.local.md`
  (Phase 15 done; next lever = Phase 16 Docker image). Green; commit.

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
- **Lifecycle and ledger move together, atomically-on-success.** A transition is guarded (legal edge only)
  THEN `setLifecycleStatus` + recorded event(s) in one call; an illegal edge records NOTHING. The resolver's
  fail-closed predicate is unchanged (`USABLE_LIFECYCLE_STATUSES = ['active']`).
- **Money is integer cents; no ambient time/RNG.** Injected clock/ids everywhere; the ledger never floats.
- **Behavior-preserving for the JSON/HTML edge.** `/t/:slug` + `/healthz` + the Phase-13/14 keystones stay
  byte-for-byte. The admin surface is strictly additive.
</content>
</invoke>
