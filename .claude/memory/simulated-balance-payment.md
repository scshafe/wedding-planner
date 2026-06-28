# Simulated balance payment from the tenant surface (Phase 31)

**What:** the planner can now **pay down their owed balance** from their own billing page — the first MUTATION on
the billing surface. JSON `POST /t/:slug/billing` settles the balance (records a `payment`) + a CSRF-gated **Pay**
form on the existing `?view=billing` page. Makes Phase 30's read-only view interactive; closes the
meter→bill→customer→**pay** loop end-to-end (a metered guest reply raises the balance, the planner clicks Pay, the
page shows `$0.00 owed`). Offline-first (no real money — recorded as the existing `payment` kind; manifest stays
20). ADR 0031. 914 tests. Builds on [[planner-billing-view]] (the read) + [[planner-guest-management-and-csrf]]
(the CSRF seam). Pricing is a first-class human-set factor — [[guest-messaging-channel-is-a-roadmap-goal]].

## The load-bearing decisions (carry forward)

- **The settled amount comes from the TRUSTED balance, NEVER the body — un-smugglable by construction.**
  `BillingLedger.settleBalance(tenant_id)` reads `balanceCents` internally and records a `payment` for EXACTLY
  that, atomically. The handler passes only `context.tenant_id`; the POST branch of `dispatchBilling` **never
  calls `parseObjectBody`**, so a body `amount_cents` is structurally inert. There is no path to over/under-pay or
  to mint a negative/credit balance (`balanceCents` is structurally ≥ 0: `charge` is always paired with an equal
  `payment` at activate/reactivate, `usage_charge` is a pure debit, and the only standalone `payment` writer is
  `settleBalance`, floored at `> 0`). **A money mutation that must be un-gameable derives its amount from trusted
  state, not client input — and proves it by reading nothing from the body.**
- **Pay is idempotent via the balance floor — the double-submit guard, no idempotency key.** `settleBalance`
  records only when `balance > 0`; a repeat call sees 0 and no-ops (`{paid:false}`). The read-then-record is **one
  synchronous critical section** (no `await`/yield between `balanceCents` and `record`) — the floor depends on
  that, noted in the method header so a future async split can't re-open a double-pay. Sound because the offline
  sim is single-threaded.
- **ONE planner-only capability gate, checked BEFORE the method branch — reused for read AND settle.** Reuse
  `GuestAuthorizer.authorizeBillingView` (planner allow / couple forbidden) as the FIRST statement of
  `dispatchBilling` for BOTH GET and POST. A couple gets a byte-identical 403 for any method; **one shared gate
  makes the no-method-oracle STRUCTURAL** (read/pay can't diverge into a couple-visible distinguisher — a couple is
  stopped before the method branch regardless of verb). A separate `authorizePayBalance` is deferred (a no-op
  behind this gate until a read-only billing role exists). Name kept `…View` to avoid churning Phase 30; doc
  updated in code to say it gates the mutation too.
- **The settlement `payment` is a legitimate NON-lifecycle ledger writer.** `OnboardingService` owns only the
  lifecycle-coupled `charge`/`payment` pairs; `MessagingService` already writes `usage_charge` directly (the
  meter), so a standalone settlement `payment` follows that precedent. The ledger owns its events; `payment` stays
  in lockstep with `FINANCIAL_KINDS`/`balanceCents`/schema `allOf` (records an existing credit kind — no schema or
  fold change). The "canonical lifecycle recorder" invariant is about lifecycle *transitions* only.
- **CSRF at exactly one layer; the JSON pay route is not CSRF-reachable.** `#billingPay` verifies `_csrf` BEFORE
  the cookie→Bearer translation (forged ⇒ masked 403, no `api.handle`, no mutation). The JSON `POST /t/:slug/billing`
  is Bearer-only (a cross-site form carries no `Authorization` → 401), so it's structurally not CSRF-reachable. The
  4-seg `/t/:slug/billing/pay` web route is distinct from the 3-seg JSON route (no collision; the JSON POST falls
  through to the pipeline). Slug masked to GENERIC_404 before any cookie/CSRF read. `#billingPage` now issues the
  per-session CSRF token (like `#guestsPage`); `renderBilling` shows the Pay form ONLY when owed (else a settled
  note), carries only the `_csrf` field and **no amount input**, all values through the `html` template.

## Deferred (named in the plan / ADR)
- **Partial / arbitrary-amount payments** — this rung settles the FULL owed balance only (the keystone). A partial
  amount re-introduces client money input → needs its own bounds/no-fraud pass (`0 < amount ≤ balance`).
- A planner-facing **payment history / activity log** (still operator-only).
- **Per-period** windows / invoices; **auto-pay**; couple visibility or payment of billing (deliberately none).
