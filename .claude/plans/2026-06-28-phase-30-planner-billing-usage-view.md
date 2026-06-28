# Phase 30 — Planner-facing billing & usage summary

## Why (the lever)
Pricing is a **first-class, human-set** factor (`guest-messaging-channel-is-a-roadmap-goal`: meter per-message
usage, price with margin). The platform already meters (`usage_charge`, Phase 18/20) and bills (the
`BillingLedger`), but the **customer never sees it** — `billingView` is **operator-only** (`/admin/...`). For a
launch-ready white-label product, the tenant (planner) must see their own account: **plan + monthly price, message
usage (count + spend), and balance owed**. This surfaces the metered-pricing concern to the customer and closes the
loop between the Phase-18/20 meter and the person paying. Read-only, no new oracle surface, no new schema.

## Scope (one rung)
A new **PROTECTED, planner-only** read `GET /t/:slug/billing` returning a computed `BillingSummary`, plus a themed
`?view=billing` browser page that delegates through it. Couple → 403 (capability they lack). No mutation, no new
contract (render-time projection, like `StrategyGuidance`/Phase 17 — **manifest stays 20**).

## Design (the load-bearing decisions)
- **Trusted, tenant-scoped by construction.** The summary is folded from the tenant's OWN ledger keyed by
  `context.tenant_id` (the minted, trusted context — NEVER a body/URL field) and the tenant's TRUSTED `plan_tier`
  read by `findById(context.tenant_id)`. No cross-tenant/cross-wedding dimension exists, so there is no probe to
  mask — the ledger partition + the minted context ARE the isolation (same story as the operator path, but locked
  to the caller's own tenant instead of an operator-supplied id).
- **Planner-only = a capability denial (403), not a masked 404.** Billing is tenant-global, not a per-wedding
  resource, so a couple asking is not probing existence → `forbidden` (403), consistent with
  `WeddingAuthorizer.authorizeCreate`. The capability check is the **FIRST** statement of the billing dispatch
  (before the method check), so a couple gets a byte-identical 403 for **any** method (no method oracle); a planner
  POST → 405.
- **Auth before route-shape (no pre-auth oracle).** `#authenticate` runs before the method/authorize checks, so an
  unauthenticated prober gets a byte-identical 401 for any method — exactly like the `strategy` route.
- **Monthly price comes from the SAME source that bills it.** `monthly_price_cents = monthlyPriceCents(plan_tier)`
  — the identical price-book function `OnboardingService` uses to size the `charge`, so the displayed price can
  never drift from what is actually charged (no second price table).
- **Balance has ONE definition.** The summary's `balance_cents` flows from the canonical `BillingLedger.balanceCents`
  fold; the aggregate breakdown (`subscription_charges_cents + messaging_spend_cents − payments_cents`) is pinned
  EQUAL to it by a test (drift guard), so the breakdown can never silently disagree with the owed balance.
- **No untrusted input on the surface.** GET-only (no body to smuggle); every summary field is a number or the
  `plan_tier` enum (no guest/free-text), so there is no new XSS/round-trip surface (still rendered through the
  `html` template for uniformity).
- **Optional subresource (convention).** `billing?` on `ProductApiDeps` (mounted when wired; absent ⇒ unmounted-
  subresource 404), mirroring `escalations`/`messaging`/`championStrategy` — `composeProductSurface` always wires
  it, so hand-built test fixtures that omit it are unaffected.

## Steps

- [x] **Step 0 — Adversarial design review.** Routed through a `general-purpose` agent (doddy + architect lens).
  Verdict **APPROVE-WITH-FIXES, no exploit** — no new existence/lifecycle oracle, no trust-boundary widening, no
  cross-tenant/guest leak. Folded fixes:
  - **F1 (must):** `authorizeBillingView` RETURNS `AccessDecision` (`'allow'|'forbidden'`) — authorizers never
    throw for an authz outcome; the handler renders `forbidden()`. Homed on **`GuestAuthorizer`** (the de-facto
    intra-tenant management-capability authorizer — it already owns `authorizeRegister` + `manageScope`, the latter
    reused by escalations), NOT `WeddingAuthorizer` (billing is account-scoped, not wedding-scoped). So billing
    `deps.authorizer` is the `GuestAuthorizer`.
  - **F2/F3 (must/should):** the event fold lives in `BillingLedger.summarize`, in lockstep with `balanceCents`
    / `FINANCIAL_KINDS` (note added). `summarize` derives `balance_cents` from its own per-kind buckets; the
    drift-guard test pins `subscription + messaging_spend − payments === ledger.balanceCents(tenant)` where the
    RHS is the **untouched canonical** fold (catches a future `summarize` divergence). Only the price-book join
    (`monthlyPriceCents`) lives in `billing_summary.ts`.
  - **F4 (should):** `billing?` stays OPTIONAL — deliberately matching the `escalations`/`messaging`/
    `championStrategy` "compose-always-wires-it" subresource convention (and avoiding churn across 17 ProductApi
    fixtures). The "future compose forgets to wire it" risk F4 raised is caught by the Step-3 compose e2e (which
    fails if `?view=billing` 404s on the demo tenant), not by the type system. Documented in the ADR.
  - **F5/F6 (verify):** add a body-smuggled-`tenant_id`-is-inert test (first planner route over the ledger);
    `BillingSummary` carries NO per-message price / provider COGS / margin — only tenant-side ledger aggregates +
    the tenant-facing `monthly_price_cents`. `messaging_spend_cents` is `Σ usage_charge amounts` straight from the
    ledger (what was actually billed), never a `messagePriceCents` recomputation.

- [x] **Step 1 — The pure summary projection (billing domain).**
  - `BillingLedger.summarize(tenant_id): LedgerSummary` — a single pass over the tenant's events:
    `messages_sent` (count of `usage_charge`), `messaging_spend_cents` (Σ `usage_charge`),
    `subscription_charges_cents` (Σ `charge`), `payments_cents` (Σ `payment`), and `balance_cents` (from the
    canonical `balanceCents`). Markers contribute nothing. Empty tenant → all zeros.
  - New `product/src/billing/billing_summary.ts`: `BillingSummary` interface (`plan_tier`, `monthly_price_cents`,
    spread of `LedgerSummary`) + pure `buildBillingSummary(plan_tier, ledger: LedgerSummary): BillingSummary`
    composing `monthlyPriceCents(plan_tier)` with the fold (mirrors `strategy_guidance.ts` as a render-time
    projection). Export both from the barrel as needed.
  - Tests (`product/tests/billing/`): `summarize` fold (empty→zeros; mixed kinds→correct counts/sums; markers
    excluded; `subscription+messaging−payments === balanceCents` drift guard); `buildBillingSummary` composes the
    trusted price (== `monthlyPriceCents`).
  - Verify: `npm run build && npm test && npm run lint`. Commit.

- [x] **Step 2 — The JSON route + authorizer capability.**
  - `WeddingAuthorizer.authorizeBillingView(principal): AccessDecision` — planner `allow`, couple `forbidden`
    (asserts the minted brand; mirrors `authorizeCreate`).
  - `BillingHandlerDeps { ledger: Pick<BillingLedger,'summarize'>; tenants: Pick<TenantStore,'findById'>;
    authorizer: WeddingAuthorizer }`; `billing?` on `ProductApiDeps`; `#billing` field; route guard
    `this.#billing !== undefined && segments.length === 3 && segments[2] === 'billing'`:
    `#authenticate` → `dispatchBilling`.
  - `dispatchBilling`: authorize-FIRST (couple→403 any method) → method GET-only (else 405) →
    `findById(context.tenant_id)` (defensive `undefined`→masked 404, unreachable) →
    `buildBillingSummary(tenant.plan_tier, ledger.summarize(context.tenant_id))` → `{ status:200, body:{ billing } }`.
  - Wire in `compose.ts`: `billing: { ledger: billing, tenants, authorizer }`.
  - Tests (`product/tests/http/`): planner GET→200 summary (fields correct, reflects only this tenant's ledger);
    couple GET→403; couple POST→403 (byte-identical to GET, no method oracle); planner POST→405; unauthenticated→401
    (byte-identical for any method); unmounted (no `billing` dep)→404; a second tenant's summary is independent.
  - Verify; commit.

- [x] **Step 3 — The themed `?view=billing` browser page.**
  - `renderBilling(theme, slug, summary)` in `pages.ts`: plan tier + monthly price (cents→dollars), messages sent,
    messaging spend, subscription charges, payments, **balance owed** — all via the `html` template. Add a
    "Billing & usage →" link to `renderConsole`'s nav line.
  - `#billingPage(req, slug)` in `product_web_ui.ts`: delegate `bearerGet('/t/:slug/billing')`; 200→`renderBilling`
    (theme resolved like `#strategy`; `theme===undefined`→GENERIC_404); else→`#renderNonData` (403→themed Forbidden,
    401→themed login, else masked 404). `readBilling(body)` reader helper. Route `?view=billing` in `#tenantRoot`.
  - Tests (`product/tests/web/`): `renderBilling` shows the values + dollar formatting; `?view=billing` planner→200
    page, couple→403 Forbidden, unknown/suspended→masked 404, unauthenticated→themed login.
  - **Compose e2e** (`product/tests/runtime/` or `web/`): the demo tenant's planner reads `?view=billing` and sees a
    summary reflecting its provision/activate `charge`; after a metered guest reply (Phase 28 path), `messages_sent`
    and `messaging_spend_cents` increase and `balance_cents` rises — the meter→bill→customer loop, demoable.
  - Verify; commit.

- [x] **Step 4 — ADR 0030 + memory + handoff.** Write `docs/adr/0030-*.md` (the decisions above), a
  `.claude/memory/planner-billing-view.md` (+ index in `MEMORY.md`), update `.claude/handoff.local.md` with where
  things stand and the next lever. Verify; commit.

## Out of scope (deferred, name them)
- A planner-facing **activity log** (raw events / invoice history) — this rung is a SUMMARY; events stay
  operator-only.
- A **simulated payment** action from the tenant surface (pay-down the owed balance) — needs a mutation + its own
  no-oracle pass.
- **Per-period** windowing (this month vs lifetime) — the summary is lifetime-to-date; a billing-period model is a
  later rung.
- Couple **visibility** of any billing — deliberately planner-only (a couple has no billing capability).
