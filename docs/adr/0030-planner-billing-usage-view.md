# ADR 0030 — Planner-facing billing & usage summary

- **Status:** accepted
- **Date:** 2026-06-28
- **Decider:** the building agent (an agent-owned engineering decision per
  [[agents-own-buildout-decisions]] and `.claude/plans/2026-06-28-phase-30-planner-billing-usage-view.md`)
- **Scope:** Phase 30 — surface the metered-pricing reality to the **customer**. The platform already meters
  per-message usage (Phase 18/20) and bills it into the `BillingLedger`, but the tenant could never *see* it:
  `billingView` is **operator-only** (`/admin/.../billing`). Give the planner a read-only view of their OWN
  account — plan + monthly price, message usage (count + spend), subscription fees, payments, and the owed
  balance — over JSON `GET /t/:slug/billing` and a themed `?view=billing` browser page.
- **Builds on** the billing ledger ([[onboarding-billing-operator-tier]], ADR 0015), the price book + meter
  ([[guest-messaging-port-and-meter]] / [[messaging-money-north-star]], ADR 0018/0020), the engine↔surface
  read pattern ([[engine-surface-strategy-seam]], ADR 0017), and the no-oracle pipeline ([[http-edge-and-intra-tenant-auth]]).
  **Pricing is a first-class, human-set factor** ([[guest-messaging-channel-is-a-roadmap-goal]]); this closes
  the meter→bill→**customer** loop.

## Context

The four billing event kinds were all written and read on the *operator* side: provisioning records a
`charge`+`payment`, every metered send accrues a `usage_charge`, and the operator audits it via
`billingView(tenant_id)`. The person paying — the tenant's planner — had no window into any of it. For a
launch-ready, metered-messaging product, the customer must see their usage and balance; that is the missing
product surface, and it is a clean, well-bounded read.

One adversarial review ran on the DESIGN (a `general-purpose` agent carrying the doddy + rigorous-architect
lens — the named specialists are not provisioned here): **APPROVE-WITH-FIXES, no constructible exploit found**.
All fixes folded in before building. 891 tests green (was 873 at phase start; +6 billing fold/projection,
+9 JSON API, +6 web page/e2e, +1 compose reachability — minus a fragile render assertion dropped).

## Decisions

### 1. A render-time projection, not a new contract (manifest unchanged)

`BillingSummary` is a pure view assembled per-request from two trusted inputs, exactly like `StrategyGuidance`
(Phase 17) — it is never persisted, so it needs **no JSON Schema** and the manifest stays at 20. The
projection joins (a) the tenant's TRUSTED `plan_tier`, priced by `monthlyPriceCents`, and (b) the tenant's own
`LedgerSummary` (a per-kind fold of its ledger events). `buildBillingSummary` lives in `billing_summary.ts`
(the price-book join) and is pure; the event fold lives on `BillingLedger.summarize` (the ledger owns its
events). This split keeps the price-book knowledge out of the ledger and the event knowledge out of the
projection.

### 2. The monthly price has ONE source; the balance has ONE definition

`monthly_price_cents = monthlyPriceCents(plan_tier)` — the **identical** price-book function `OnboardingService`
uses to size the monthly `charge`. So the price the customer sees can never drift from the price they are
billed (no second table). The summary's aggregate breakdown
(`subscription_charges_cents + messaging_spend_cents − payments_cents`) is **drift-guarded by a test** pinned
EQUAL to the canonical `BillingLedger.balanceCents` fold — the breakdown can never silently disagree with the
owed balance. `messaging_spend_cents` is `Σ usage_charge amounts` **straight from the ledger** (what was
actually billed), never a `messagePriceCents` recomputation.

### 3. Planner-only = a capability denial (403), not a masked 404

Billing is the **tenant account** (the whole tenant), not a per-wedding resource — so a couple asking for it is
not probing the existence of any specific resource. It is therefore a capability a couple lacks **entirely**:
`GuestAuthorizer.authorizeBillingView` returns `forbidden` → **403**, exactly like `authorizeRegister`. The
authorizer **returns a decision, never throws** (house style; only `assertMintedPrincipal` throws). The
capability check is the **FIRST** statement of `dispatchBilling`, before the method branch, so a couple gets a
byte-identical 403 for **any** method (no method oracle); a planner POST → 405. `authorizeBillingView` is homed
on `GuestAuthorizer` — the de-facto intra-tenant **management-capability** authorizer (it already owns
`authorizeRegister` + the `manageScope` reused by the escalation inbox) — not on the wedding-resource authorizer.

### 4. Trusted, tenant-scoped by construction — no new oracle

The summary is folded from the caller's OWN ledger keyed by `context.tenant_id` (the **minted, trusted**
partition key, never a body/URL field — a smuggled `tenant_id` is inert, pinned by a test), and the trusted
`plan_tier` is read via `findById(context.tenant_id)`. There is no cross-tenant or cross-wedding dimension, so
there is nothing to mask — the ledger partition + the minted context ARE the isolation (the same story as the
operator path, locked to the caller's own tenant). `#authenticate` runs before the authorize/method checks, so
route shape is not a pre-auth oracle (byte-identical 401 for any method, like `strategy`). The summary exposes
ONLY tenant-side figures: the tenant-facing monthly price and the amounts actually billed — **never** the
provider COGS, per-message price table, or platform margin (those stay internal to `price_book.ts` /
`messaging_service.ts`); a key-set test pins this.

### 5. Optional subresource — compose always wires it; an e2e pins reachability

`billing?` is **optional** on `ProductApiDeps`, matching the `escalations` / `messaging` / `championStrategy`
"compose-always-wires-it" subresource convention (and avoiding churn across 17 hand-built `ProductApi`
fixtures). The reviewer's F4 concern — "a future compose forgets to wire it and the planner's billing silently
404s" — is caught by a **compose e2e** that fails if `GET /t/demo/billing` 404s, not by the type system. This
is a deliberate divergence from the `guests: required` choice, documented here.

### 6. The browser page is a status-themed delegation (no independent decision)

`#billingPage` does ONE `api.handle('GET /t/:slug/billing')` and themes strictly by status (200 → the summary
page; couple 403 → themed Forbidden; 401 → themed login; else → masked 404), mirroring `#strategy`. It makes no
independent existence/authz decision and needs no CSRF token (read-only, no body). Every value is a number or
the `plan_tier` enum (no untrusted/guest free-text), rendered through the `html` SafeHtml template — no new
XSS/round-trip surface. The console links to it.

## Consequences

- The meter→bill→customer loop is demoable end-to-end: a metered guest reply now raises a **customer-visible**
  message count, messaging spend, and owed balance.
- `BillingLedger.summarize` joins `balanceCents`/`FINANCIAL_KINDS` as a money definition that **must stay in
  lockstep** (noted in code); a future financial kind must be added to all of them.
- Deferred (named in the plan): a planner-facing **activity log** (raw events / invoice history — events stay
  operator-only); a **simulated payment** action from the tenant surface (a mutation needing its own no-oracle
  pass); **per-period** windowing (the summary is lifetime-to-date); couple visibility (deliberately none).

## Related

- Memory: [[planner-billing-view]], [[onboarding-billing-operator-tier]], [[messaging-money-north-star]],
  [[guest-messaging-channel-is-a-roadmap-goal]], [[engine-surface-strategy-seam]].
- Code: `product/src/billing/billing_ledger.ts` (`summarize`), `product/src/billing/billing_summary.ts`,
  `product/src/auth/guest_authorizer.ts` (`authorizeBillingView`), `product/src/http/product_api.ts`
  (`dispatchBilling`), `product/src/web/pages.ts` (`renderBilling`), `product/src/web/product_web_ui.ts`
  (`#billingPage`), `product/src/runtime/compose.ts` (the wire).
