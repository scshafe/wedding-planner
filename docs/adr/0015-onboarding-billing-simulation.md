# ADR 0015 — Onboarding + billing simulation: the operator tier and the lifecycle driver

- **Status:** accepted
- **Date:** 2026-06-26
- **Decider:** the building agent (an agent-owned engineering decision per
  [[agents-own-buildout-decisions]] and `.claude/plans/2026-06-26-phase-15-onboarding-billing-sim.md`)
- **Scope:** Phase 15 — give the tenant lifecycle a **driver** and the tenant a **real birth**. A simulated,
  operator-gated provisioning + billing layer that creates a tenant (lands it in `onboarding`) and drives
  `onboarding → active → suspended → active` through modeled billing events. Adds a third trust tier (a
  platform **`Operator`**), a `billing_event` contract + an append-only `BillingLedger` + a `price_book`,
  and an `OnboardingService`, exposed through an operator-gated `/admin` surface folded into the SAME
  `ProductApi.handle` pipeline. Offline-first (no real money/provisioning; injected clock/ids). Proven by an
  adversarial onboarding keystone.
- **Builds on** ADR 0012 (inter-tenant isolation), ADR 0013 (the request edge + intra-tenant auth), and
  ADR 0014 (the themed web UI). It does not weaken any; it reuses the one safety model — sole-mint,
  WeakSet-branded subjects; fail-closed liveness; no anonymous existence oracle — not a parallel one.

## Context

After Phases 12–14 the product surface was complete as a themed, multi-tenant JSON+HTML app — but a tenant
was still **born as a test fixture**: `TenantStore.create()` was called directly in seeds/tests,
`lifecycle_status` was flipped by hand, and `plan_tier` was an inert label. The `onboarding`/`suspended`
states the resolver already **fails closed on** had **no driver**, and `session_store.ts` literally
deferred the matter ("Real credential verification is a Phase-15 onboarding concern"). The product arc
(12 domain core → 13 HTTP/auth → 14 web UI → **15 onboarding/billing** → 16 Docker) needs the rung where the
white-label tenant gets a self-serve birth and the lifecycle states get exercised by a real flow.

The load-bearing risk: provisioning is a **new pre-auth-reachable surface**, and a naive design re-opens the
exact oracle the surface is built to avoid.

## Decision

### Provisioning is OPERATOR-gated, not anonymous self-serve (the no-oracle crux)

The decisive, re-verified fact about the existing API: it **already discloses active-tenant existence**
(unauthenticated `GET /t/:slug/weddings` is `401` for an active tenant vs `404` for unknown) while keeping
**absent ≡ suspended ≡ onboarding byte-identical** (`404`). The protected secret is *absent-vs-not-usable*.

A naive **anonymous self-serve signup** would break that mask: a synchronous "slug taken / available" reply
is a tenant-existence oracle for **every** lifecycle state — it newly discloses suspended/onboarding
existence the `404` mask hides. An async claim-ticket does not fix it (it only adds a round-trip; the ticket
holder still learns occupancy, so enumeration survives). The **only structural fix is to put provisioning
behind a credential.**

So a third trust tier — a simulated **platform `Operator`** (the white-label vendor / the agent-run platform
itself, tenant-LESS, above any single tenant) — provisions and bills tenants. This gives the tenant a real
birth flow and the lifecycle a driver, **preserves the absent≡suspended≡onboarding mask by construction**
(anonymous users have no provisioning access, so no new enumeration oracle is introduced), and mirrors how
white-label SaaS actually provisions. **Anonymous public self-serve signup is an explicit deferral**, with
its tradeoff recorded: it inherently discloses bounded slug-occupancy and needs rate-limits/abuse-control —
that is going-live hardening, human-reserved. We built the secure core; we did not fake the public form.

### Three trust tiers, three separate token namespaces

The Operator is the third sole-mint, WeakSet-branded, `#`-private-store subject, peer of `Principal`:

| tier | subject | sole mint | scope | presented on |
| --- | --- | --- | --- | --- |
| inter-tenant | `TenantContext` | `TenantContextResolver` | one tenant | (route slug) |
| intra-tenant | `Principal` | `SessionStore` | one wedding-set in a tenant | `Bearer` on `/t/:slug/...` |
| **platform** | **`Operator`** | **`OperatorCredentialStore`** | the whole platform | `Bearer` on `/admin/...` |

The operator store is a **separate token namespace**: a tenant session token is simply absent there (→ the
constant `401`), and an operator token is absent in the session store (→ `401`). `resolve` is a bare
`#`-private `Map.get` with **no prefix/shape gate** — a foreign token fails via the same opaque absent-key
path as a session token (no cross-namespace shape/timing oracle). `Operator` carries the same unforgeability
construction as `Principal` (compile-time phantom brand + a module-private `WeakSet` identity witness +
`Object.freeze`; brand + mint never exported from the barrel). The operator token is **constructor-injected**
(an offline-simulation seam — never a module constant, never a real secret), never echoed, the store
non-enumerating.

### `/admin` folded into the one pipeline; operator-auth as the literal first statement

The `/admin` routes live in the SAME `ProductApi.handle` pipeline (one edge, never a second), in an `/admin`
branch disjoint from `/t/:slug` (admin is tenant-less and never mints a `TenantContext`).
`this.#authenticateOperator(req)` is the **literal first statement** of that branch — before any
method/sub-route/`:id`/body check — and the only operations preceding it (`splitPath`, `bearerToken`'s
regex, `Map.get`) cannot throw. So an unauthenticated `/admin/...` probe is a **byte-identical `401` for any
method and path shape**: route shape is not a pre-auth oracle. Handler purity is structural: the admin
handlers get a narrow `{ onboarding }` bag; `#operators` lives only in the pipeline (like `#sessionStore`).

Routes: `POST /admin/tenants` (provision → `201 { tenant }`), `POST /admin/tenants/:id/{activate,suspend,
reactivate}` (→ `200 { tenant }`), `GET /admin/tenants/:id/billing` (→ `200 { events, balance_cents }`).

### The lifecycle driver: a legal-transition guard, lifecycle + ledger atomically-on-success

`OnboardingService` is the canonical (and only) lifecycle driver. `TenantStore.setLifecycleStatus` validates
only the **target** enum, not the **edge**, so an unguarded double-`activate` (or suspend-an-onboarding)
would record a spurious, irreversible billing event and corrupt the balance fold. Each method therefore
reads the **current** `lifecycle_status` and throws `PRODUCT.ILLEGAL_LIFECYCLE_TRANSITION` **before recording
anything**; only a legal edge both flips the status and records its event(s) — lifecycle and ledger move
together, atomically-on-success (single-threaded, no `await` between the read-check and the write). `provision`
runs `tenants.create` (the only legitimately-throwing step) FIRST, so a `DUPLICATE_SLUG` leaves no orphan
event. **No session is minted at provision** — the resolver fails closed for an onboarding tenant, so a
context cannot be minted for it (and a bootstrap token would be useless: the login edge also resolves the
context first and `404`s while onboarding); the first planner simply logs in via the existing
`/t/:slug/sessions` edge once active (login stays the sole session mint).

### Billing: one contract, the ledger IS the account, money is integer cents

`billing_event` is the 16th canonical schema. It enforces `amount_cents` **per-kind via `if/then/else`**
(required iff `kind ∈ {charge, payment}`; forbidden on markers `provisioned`/`suspended`/`reactivated`), so
the fold can never sum a non-financial marker. There is **no separate account aggregate**: `plan_tier` lives
on the `Tenant`, and the account balance is a **fold** — `balanceCents = Σ(charge) − Σ(payment)` over the
financial kinds only, **positive = money owed**. `price_book` is a total `Record<PlanTier, amount_cents>`
(fictional, integer cents). The `BillingLedger` is `#`-private per-tenant append-only (no enumeration leak),
`eventsFor` filters strictly by `tenant_id`.

### Trusted-operator disclosure is intentional, not a leak

A `DUPLICATE_SLUG` is an honest `409` to the operator (NOT masked to `404` — the absent-vs-suspended mask is
an **anonymous**-edge property; the platform operator legitimately sees tenant state), as is an illegal
transition (`409`). An operator can enumerate tenants and read any tenant's billing — by design. The mask
protects **anonymous probers**, not the operator.

## Consequences

- The `onboarding`/`suspended` lifecycle states the resolver fails closed on now have a real driver; the
  tenant has a real birth instead of a test fixture; `plan_tier` drives a modeled charge.
- The anonymous disclosure boundary is **unchanged and re-proven** by the onboarding keystone (onboarding ≡
  suspended ≡ absent, byte-identical `404` on both the list and login edges; only active discloses existence).
- Three trust tiers now stack without crossing; the `/admin` surface is reachable only with an operator
  credential and is route-shape-opaque pre-auth.
- **Deferred (recorded, not faked):** anonymous public self-serve signup (the enumeration-oracle tradeoff
  above — going-live hardening); the operator web console (HTML — the first mutation UI, needs the
  CSRF/forms surface Phase 14 deferred); recurring/scheduled charges, dunning, proration, real currency/tax;
  operator RBAC / multiple-operator audit. Real secrets/payments/comms stay human-reserved (exception #4).

## Alternatives considered

- **Anonymous self-serve signup (rejected for now).** The natural "self-serve birth", but a synchronous slug
  reply is an enumeration oracle and the async variant doesn't close it; only a credential gate does. Kept as
  a documented going-live deferral rather than shipped with a hidden oracle.
- **A second `/admin` handler/edge (rejected).** Folding into the one `api.handle` pipeline keeps a single
  edge the web layer can later render and keeps the precedence discipline in one place.
- **A materialized billing account aggregate (rejected).** `plan_tier` already lives on the tenant; a fold
  over the ledger is the single source of truth and cannot drift from a duplicated balance field.
- **Reusing `SessionStore` for operators (rejected).** An operator is tenant-less and a peer of `Principal`,
  not a tenant session; a separate namespace is what makes "the tiers never cross" structural.
