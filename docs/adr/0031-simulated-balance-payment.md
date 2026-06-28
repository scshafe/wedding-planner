# ADR 0031 — Simulated balance payment from the tenant surface

- **Status:** accepted
- **Date:** 2026-06-28
- **Decider:** the building agent (an agent-owned engineering decision per
  [[agents-own-buildout-decisions]] and `.claude/plans/2026-06-28-phase-31-simulated-balance-payment.md`)
- **Scope:** Phase 31 — make the planner's billing page **interactive**. Phase 30 (ADR 0030) gave the planner a
  read-only view of their owed balance; this rung lets them **settle** it — a simulated payment recorded as a
  `payment` event — over JSON `POST /t/:slug/billing` and a CSRF-gated **Pay** form on the existing
  `?view=billing` page. It is the first **mutation** on the billing surface, so it gets its own no-oracle /
  no-fraud pass.
- **Builds on** the billing ledger ([[onboarding-billing-operator-tier]], ADR 0015), the read view
  ([[planner-billing-view]], ADR 0030), the browser-form CSRF seam ([[planner-guest-management-and-csrf]], ADR
  0021), and the no-oracle pipeline ([[http-edge-and-intra-tenant-auth]]). **Pricing is a first-class, human-set
  factor** ([[guest-messaging-channel-is-a-roadmap-goal]]); this closes the meter→bill→customer→**pay** loop.

## Context

After Phase 30 the planner can SEE that metered guest replies accrued a `usage_charge` and that they owe a
balance — but the page is read-only; they can do nothing about it. The natural, most product-complete follow-up
(the top deferral in the Phase-30 ADR and the handoff) is to let them pay the balance down from their own
surface. Offline-first: no real money moves — the settlement is recorded as the existing `payment` billing kind
(manifest stays 20).

Two adversarial reviews ran (a `general-purpose` agent carrying the doddy + rigorous-architect lens — the named
specialists are not provisioned here): the **DESIGN** review returned APPROVE-WITH-FIXES (no exploit; P1-A/P1-B
clarity fixes folded), and a **built-code** review of the committed money path returned **APPROVE, no
constructible exploit found**. 914 tests green (was 891 at phase start; +6 ledger, +10 JSON API, +7 web/e2e).

## Decisions

### 1. The settled amount comes from the TRUSTED balance, never the body — atomic by construction

`BillingLedger.settleBalance(tenant_id)` computes the owed balance internally (the canonical `balanceCents`) and
records a `payment` for **exactly** that, in one step. The handler passes only `context.tenant_id` — there is
**no amount parameter to smuggle**, and the POST branch of `dispatchBilling` **never calls `parseObjectBody`**, so
a body `amount_cents` is structurally inert. This is the no-fraud keystone: the settlement amount is derived from
trusted state, not client input. Because `balanceCents` is structurally `≥ 0` (the only debit kinds are `charge`
— always paired with an equal `payment` at activate/reactivate — and `usage_charge`; the only standalone
`payment` writer is this method, floored at `> 0`), a planner can never over-pay, under-pay, or mint a
negative/credit balance.

### 2. Pay is idempotent via the balance floor — no double-pay

`settleBalance` records a payment **only when `balance > 0`**; when `≤ 0` it records nothing and returns
`{ paid: false }`. So a second submit (a browser double-click, a JSON replay) sees a zero balance and is a no-op
— the **balance floor is the double-submit guard**, no cross-request idempotency key needed (unlike the reply
path's `reply:${id}`). The read-then-record is **one synchronous critical section** (no `await`/yield between
`balanceCents` and `record`); the offline sim is single-threaded, so this is sound, and the dependency is noted
in the method header so a future async split can't silently re-open a double-pay.

### 3. ONE planner-only capability gate, checked BEFORE the method branch

The mutation reuses `GuestAuthorizer.authorizeBillingView` (planner `allow` / couple `forbidden`) as the
**billing-account capability** gating BOTH the GET read and the POST settle. It is the FIRST statement of
`dispatchBilling`, so a couple gets a **byte-identical 403 for any method** — and a single shared gate makes the
no-method-oracle **structural**: read and pay can never diverge into a couple-visible distinguisher (a couple is
stopped before the method branch regardless of verb). A separate `authorizePayBalance` is deliberately deferred
— it would be a behavioral no-op behind this gate until a read-only billing role exists. The `View` name is kept
(renaming would churn Phase 30); the in-code doc states it now gates the mutation too.

### 4. The settlement payment is a legitimate non-lifecycle ledger writer

`OnboardingService` owns only the LIFECYCLE-coupled `charge`/`payment` pairs; the ledger already has a second,
non-lifecycle writer — `MessagingService` records `usage_charge` directly (the meter). A standalone settlement
`payment` follows that precedent: the ledger owns its events, `settleBalance` is a ledger operation over its own
fold, and `payment` stays in lockstep with `FINANCIAL_KINDS` / `balanceCents` / the schema's per-kind `allOf`
(it records an existing credit kind — no schema or fold change). The "canonical lifecycle recorder" invariant is
about lifecycle *transitions*, which this is not.

### 5. CSRF at exactly one layer; the JSON pay route is not CSRF-reachable

The mutation is a browser form, so it is CSRF-gated like every other browser mutation (Phase 21/27/28):
`#billingPay` verifies the per-session `_csrf` token (forged ⇒ masked 403, **no** `api.handle` call, no mutation)
**before** the cookie→Bearer translation. The JSON `POST /t/:slug/billing` is authenticated by the Bearer header
only, so a cross-site form post (which carries no `Authorization`) reaches it as a 401 — the JSON route is
structurally not CSRF-reachable and carries no token. The 4-seg web route `/t/:slug/billing/pay` is distinct from
the 3-seg JSON `/t/:slug/billing` (no collision; the JSON POST falls through to the pipeline unintercepted), and
the slug is masked to GENERIC_404 **before** any cookie/CSRF read (the CSRF outcome is never a tenant-existence
oracle). `#billingPage` now issues the per-session CSRF token on its 200 path (like `#guestsPage`), and
`renderBilling` shows the Pay form **only when a balance is owed** (else a "Settled — nothing owed" note); the
form carries only the `_csrf` field and **no amount input**, and every value flows through the `html` template
(no new XSS/free-text surface).

## Consequences

- The meter→bill→customer→**pay** loop is demoable end-to-end: a metered guest reply raises the customer-visible
  balance, the planner clicks Pay, and the page then shows `$0.00 owed` (the settled note, no form).
- `settleBalance` joins `summarize`/`balanceCents`/`FINANCIAL_KINDS` as code that **must stay in lockstep**; the
  synchronous-critical-section property is load-bearing for the double-submit guard.
- Deferred (named in the plan): **partial / arbitrary-amount payments** (this rung settles the FULL balance only
  — a partial amount re-introduces client money input and needs its own bounds/no-fraud pass); a planner-facing
  **payment history / activity log**; **per-period** windows; **auto-pay**; couple visibility/payment (none).

## Related

- Memory: [[simulated-balance-payment]], [[planner-billing-view]], [[onboarding-billing-operator-tier]],
  [[planner-guest-management-and-csrf]], [[guest-messaging-channel-is-a-roadmap-goal]].
- Code: `product/src/billing/billing_ledger.ts` (`settleBalance`), `product/src/http/product_api.ts`
  (`dispatchBilling` POST), `product/src/auth/guest_authorizer.ts` (`authorizeBillingView`),
  `product/src/web/product_web_ui.ts` (`#billingPay`, `#billingPage`, the `/billing/pay` route),
  `product/src/web/pages.ts` (`renderBilling`).
