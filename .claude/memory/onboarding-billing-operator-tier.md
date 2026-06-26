# Onboarding + billing simulation — the operator trust tier & lifecycle driver (Phase 15)

**What:** Phase 15 gave the tenant lifecycle a **driver** and the tenant a **real birth** (replacing direct
`TenantStore.create()` fixtures): a simulated, operator-gated provisioning + billing layer that creates a
tenant (lands it in `onboarding`) and drives `onboarding → active → suspended → active` through modeled
billing events. New code: `product/src/auth/operator_credential.ts`, `product/src/billing/{price_book,
billing_ledger}.ts`, `product/src/onboarding/onboarding_service.ts`, the `/admin` fold in
`product/src/http/product_api.ts`, the 16th schema `product/schemas/billing_event_schema.json`. ADR 0015.

## The load-bearing decision: provisioning is OPERATOR-gated, NOT anonymous self-serve

This is the crux and the reason the design is shaped this way. The JSON edge **already discloses active
existence** (`401` active vs `404` unknown) while keeping **absent ≡ suspended ≡ onboarding byte-identical**
(`404`) — the protected secret is *absent-vs-not-usable*. A naive **anonymous self-serve signup** would
break that mask: a synchronous "slug taken/available" reply is a tenant-existence oracle for **every**
lifecycle state (newly disclosing suspended/onboarding existence). An async claim-ticket does NOT fix it (it
only adds a round-trip; the ticket holder still learns occupancy). The **only structural fix is a credential
gate.** So a third trust tier — a tenant-less platform **`Operator`** — provisions/bills tenants behind an
operator credential, which preserves the mask **by construction** (anonymous users have no provisioning
access). **Anonymous public self-serve signup is a recorded deferral** (slug-occupancy disclosure +
abuse-control = going-live hardening). Do NOT add an anonymous slug-availability check — it re-opens the oracle.

## The invariants to preserve (don't regress these)

- **Three separate token namespaces, never merged.** `OperatorCredentialStore` is a SEPARATE token map from
  `SessionStore`; a tenant session token is absent there and an operator token is absent in the session
  store — both fail via a bare `#byToken.get()` → constant `401`. `resolve` has **NO prefix/shape gate** (a
  shape check would be a cross-namespace shape/timing oracle). The `Operator` mirrors `Principal`'s
  unforgeability exactly (phantom brand + module-private `WeakSet` witness + `Object.freeze`; brand + mint
  NEVER exported from the barrel). Operator token is **constructor-injected** (offline seam), never echoed.
- **Operator-auth is the LITERAL first statement of the `/admin` branch** in `ProductApi.#route` — before any
  method/sub-route/`:id`/body check, and only non-throwing ops precede it (`splitPath`, `bearerToken` regex,
  `Map.get`). So an unauthenticated `/admin/...` probe is a byte-identical `401` for ANY method+path: route
  shape is **not** a pre-auth oracle. Handlers get a narrow `{ onboarding }` bag; `#operators` stays in the
  pipeline (like `#sessionStore`). The `/admin` branch is folded into the SAME `api.handle` pipeline (one
  edge), disjoint from `/t/:slug` (admin is tenant-less, never mints a `TenantContext`).
- **Lifecycle + ledger move together, atomically-on-success.** `OnboardingService` reads the **current**
  `lifecycle_status` and throws `PRODUCT.ILLEGAL_LIFECYCLE_TRANSITION` (→ `409`) **before recording
  anything** on an illegal edge — `TenantStore.setLifecycleStatus` only validates the *target* enum, not the
  edge, so an unguarded double-`activate` would record a spurious, IRREVERSIBLE billing event and corrupt the
  fold. Legal edges: provision `∅→onboarding`, activate `onboarding→active`, suspend `active→suspended`,
  reactivate `suspended→active`. `provision` runs `tenants.create` (the only throwing step) FIRST, so a
  `DUPLICATE_SLUG` leaves no orphan event. **No session is minted at provision** (the resolver fails closed
  for onboarding, so no context can be minted; the first planner logs in via the existing `/t/:slug/sessions`
  edge once active — login stays the sole session mint). `billingView` guards existence via `#requireTenant`
  first (unknown tenant → `404`, consistent with the other actions — fixed a built-code review P1).
- **Billing: one contract, the ledger IS the account, money is integer cents.** `billing_event` enforces
  `amount_cents` **per-kind via `if/then/else`** (required iff `kind∈{charge,payment}`; forbidden on markers
  `provisioned`/`suspended`/`reactivated`). NO separate account aggregate — balance is a fold
  `Σcharge−Σpayment` over financial kinds only, **positive = owed**. `price_book` is a total
  `Record<PlanTier, amount_cents>` (fictional). `BillingLedger` is `#`-private per-tenant, `eventsFor` filters
  strictly by `tenant_id`. Never sum `amount_cents` blindly; never float.
- **Trusted-operator disclosure is intentional, not a leak.** `DUPLICATE_SLUG`/`ILLEGAL_LIFECYCLE_TRANSITION`
  are honest `409`s to the operator (NOT masked to `404`); an operator can enumerate tenants + read any
  tenant's billing. The mask protects **anonymous** probers, not the operator — don't "fix" this as if it were a leak.

## Proof + reviews

The onboarding keystone (`product/tests/onboarding/onboarding_keystone.test.ts`) pins: (1) onboarding ≡
suspended ≡ absent byte-identical `404` on BOTH the list and login edges, only active discloses existence;
(2) unauthenticated `/admin` probe byte-identical `401` across GET/POST/PUT/DELETE × every path shape;
unknown top-level path stays byte-identical `404`; (3) the three token namespaces never cross; (4) the
lifecycle drive end-to-end through `api.handle()`; (5) per-tenant billing fold. Design + built-code reviews
(architect + doddy personas via general-purpose agents — the named specialists are unprovisioned here): both
APPROVE; the only built-code fold was the `billingView` existence guard. Related: [[web-ui-themed-edge]],
[[http-edge-and-intra-tenant-auth]], [[multi-tenant-isolation-boundary]],
[[customer-facing-product-surface-is-a-first-class-goal]].
