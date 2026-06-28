# Planner-facing billing & usage view (Phase 30)

**What:** the tenant's **planner** can now see their OWN account — plan + monthly price, message usage (count +
spend), subscription fees, payments, and the owed balance — over JSON `GET /t/:slug/billing` + a themed
`?view=billing` browser page. Until now billing was **operator-only** (`/admin/.../billing`); the customer who
pays could never see the metered-pricing reality. This closes the meter→bill→**customer** loop (pricing is a
first-class, human-set factor — see [[guest-messaging-channel-is-a-roadmap-goal]]). ADR 0030. 891 tests.

## The load-bearing decisions (carry forward)

- **A render-time projection, NOT a new contract — manifest stays 20.** `BillingSummary` is assembled
  per-request from two trusted inputs and never persisted, exactly like `StrategyGuidance` ([[engine-surface-strategy-seam]]).
  The price-book join (`monthlyPriceCents`) lives in `billing_summary.ts` (`buildBillingSummary`, pure); the
  event fold lives on `BillingLedger.summarize` (the ledger owns its events). Don't reach for a schema for a
  read projection.
- **ONE price source, ONE balance definition.** `monthly_price_cents = monthlyPriceCents(plan_tier)` — the
  SAME function `OnboardingService` uses to bill the monthly `charge`, so the displayed price can't drift from
  the billed price. `BillingLedger.summarize` is in **lockstep** with the canonical `balanceCents` /
  `FINANCIAL_KINDS`: a drift-guard test pins `subscription + messaging_spend − payments === balanceCents(tenant)`
  against the **untouched canonical** fold. `messaging_spend_cents` is `Σ usage_charge` STRAIGHT from the ledger
  (what was billed), never a `messagePriceCents` recomputation.
- **Planner-only is a CAPABILITY denial (403), not a masked 404.** Billing is the whole tenant account, not a
  per-wedding resource — a couple asking probes no specific resource, so it's a capability they lack entirely.
  `GuestAuthorizer.authorizeBillingView` RETURNS `'forbidden'` (authorizers never throw for an authz outcome;
  only `assertMintedPrincipal` throws); the handler renders `forbidden()`. The capability check is the **FIRST**
  statement of `dispatchBilling`, **before** the method branch → a couple gets a byte-identical 403 for ANY
  method (no method oracle); a planner POST → 405. Homed on **`GuestAuthorizer`** (the de-facto management-
  capability authorizer — already owns `authorizeRegister` + the `manageScope` reused by escalations), NOT the
  wedding-resource authorizer.
- **Trusted, tenant-scoped by construction — no new oracle.** Folded from the caller's OWN ledger keyed by
  `context.tenant_id` (the minted, trusted partition key — a body-smuggled `tenant_id` is **inert**, pinned by a
  test); `plan_tier` read via `findById(context.tenant_id)`. No cross-tenant/cross-wedding dimension → nothing
  to mask (the ledger partition + minted context ARE the isolation). `#authenticate` runs before
  authorize/method → route shape is not a pre-auth oracle (byte-identical 401 for any method, like `strategy`).
- **Exposes ONLY tenant-side figures.** The tenant-facing monthly price + the amounts actually billed — NEVER
  the provider COGS, per-message price table, or platform margin (those stay internal to `price_book.ts` /
  `messaging_service.ts`). A key-set test pins the `BillingSummary` shape.
- **OPTIONAL subresource (`billing?`), compose always wires it.** Matches the `escalations`/`messaging`/
  `championStrategy` convention (and avoids churn across 17 hand-built `ProductApi` fixtures). The "future
  compose forgets to wire it" risk is caught by a **compose e2e** that fails if `GET /t/demo/billing` 404s — NOT
  by the type system. Deliberate divergence from `guests: required`, documented in ADR 0030.
- **The browser page is a status-themed delegation** (`#billingPage`, mirrors `#strategy`): ONE
  `api.handle('GET /t/:slug/billing')`, themed by status (200 page / couple 403 Forbidden / 401 login / masked
  404). No CSRF (read-only, no body); every value is a number or the `plan_tier` enum → no new XSS surface.

## Deferred (named in the plan / ADR)
- A planner-facing **activity log** (raw events / invoice history) — events stay operator-only; this rung is a
  SUMMARY.
- A **simulated payment** action from the tenant surface (pay down the owed balance) — a mutation needing its
  own no-oracle pass.
- **Per-period** windowing (this-month vs lifetime) — the summary is lifetime-to-date.
- Couple visibility of any billing — deliberately none (a couple has no billing capability).
