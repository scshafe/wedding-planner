# Phase 31 — Simulated balance payment from the tenant surface

## Why (the lever)
Phase 30 made the planner's billing page **read-only**: they can SEE the owed balance (the metered guest replies
that accrued `usage_charge`), but they can't do anything about it. The natural, most product-complete follow-up —
named as the top deferral in both the Phase-30 ADR/memory and the handoff — is to make the page **interactive**:
let a planner **pay down the owed balance** from their own billing surface. A metered guest reply now raises the
customer-visible balance (Phase 30); this rung lets the customer **settle** it, closing the
**meter → bill → customer → pay** loop end-to-end and demoable. It is the first **mutation** on the billing
surface, so it gets its own no-oracle / no-fraud pass. Offline-first (no real money — a simulated settlement
recorded as a `payment` event); no new schema (`payment` is an existing billing kind → manifest stays 20).

## Scope (one rung)
A new **PROTECTED, planner-only** mutation `POST /t/:slug/billing` that settles the tenant's owed balance (records
a `payment` for **exactly the trusted owed amount**), plus a CSRF-gated **Pay** form on the existing themed
`?view=billing` page. The GET summary is unchanged. Couple → 403 (the capability they lack). No new contract.

## Design (the load-bearing decisions)

- **The amount comes from the TRUSTED balance, NEVER the body — atomic, by construction.** A new
  `BillingLedger.settleBalance(tenant_id): { paid, amount_cents, balance_cents }` computes the owed balance
  internally (the canonical `balanceCents`) and records a `payment` of EXACTLY that, in one step. The handler
  passes only `context.tenant_id` — there is **no amount parameter to smuggle**, so a body `amount_cents` is
  structurally inert (no over-pay, no under-pay, no negative/credit balance). This is the no-fraud keystone: the
  settlement amount is derived from trusted state, not client input.
- **Pay is naturally idempotent via the balance floor.** `settleBalance` records a payment ONLY when
  `balance > 0`; when `balance <= 0` it records nothing and returns `{ paid: false }`. So a double-submit is a
  no-op (the second call sees a zero balance) — the balance floor IS the double-submit guard (the offline sim is
  single-threaded, so no race). No cross-request idempotency key needed (unlike the reply path's `reply:${id}`),
  and a planner can never drive their balance negative.
- **ONE planner-only capability gate, checked BEFORE the method branch.** Reuse `GuestAuthorizer.authorizeBillingView`
  as the billing-ACCOUNT capability (planner `allow` / couple `forbidden`) for BOTH read and pay: it is the FIRST
  statement of `dispatchBilling`, so a couple gets a **byte-identical 403 for ANY method** (GET or POST) — no
  method oracle, exactly as Phase 30 established. A single shared gate is not just DRY: it makes the
  no-method-oracle property **structural** — a couple is stopped before the method branch regardless of verb, so
  read and pay cannot diverge into a couple-reachable distinguisher. (A separate `authorizePayBalance` would be a
  functional no-op behind the view gate; deferred until a read-only billing role actually exists.)
- **Auth before route-shape (no pre-auth oracle).** `#authenticate` already runs before the dispatch, so an
  unauthenticated prober gets a byte-identical 401 for any method — unchanged from Phase 30.
- **The settlement payment is a legitimate non-lifecycle ledger writer.** `OnboardingService` owns only the
  LIFECYCLE-coupled charge/payment pairs; the ledger already has a second writer — `MessagingService` records
  `usage_charge` directly (the meter). A standalone settlement `payment` follows that precedent: the ledger owns
  its events, `settleBalance` is a ledger operation over its own fold, and `payment` stays in lockstep with
  `FINANCIAL_KINDS` / `balanceCents` (no schema or fold change — `payment` already credits the balance).
- **CSRF at exactly one layer (the web form handler).** The mutation is a browser form, so it is CSRF-gated like
  every other browser mutation (Phase 21/27/28): `#billingPay` verifies the per-session `_csrf` token BEFORE the
  cookie→Bearer translation; a forged token → masked 403, no mutation. The JSON `POST /t/:slug/billing` is
  Bearer-only and not CSRF-reachable. The slug is normalized to a masked 404 BEFORE any cookie/CSRF read (the CSRF
  outcome is never a tenant-existence oracle).
- **No new untrusted free-text / XSS surface.** The body carries nothing the handler reads (the amount is
  ignored); the response is `{ paid: boolean }`. The Pay form is server-rendered through the `html` template like
  every other form. Manifest stays 20.

## Steps

- [ ] **Step 0 — Adversarial design review.** Route through a `general-purpose` agent carrying the doddy
  (security/trust-boundary) + rigorous-architect (design) lens (the named specialists are not provisioned here).
  Focus: (a) is the amount-from-trusted-balance construction genuinely un-smugglable; (b) double-submit / negative
  balance safety; (c) the single-gate no-method-oracle claim; (d) the non-lifecycle ledger-writer concern; (e) the
  CSRF/no-oracle parity with prior mutations. Fold any must-fix findings into the steps below before building.

- [ ] **Step 1 — `settleBalance` on the ledger (billing domain).**
  - `BillingLedger.settleBalance(tenant_id): { paid: boolean; amount_cents: number; balance_cents: number }` —
    read `balanceCents(tenant_id)`; if `> 0`, `record({ tenant_id, kind: 'payment', amount_cents: balance })` and
    return `{ paid: true, amount_cents: balance, balance_cents: 0 }`; else return
    `{ paid: false, amount_cents: 0, balance_cents: balance }` recording nothing. Header note: the amount is
    sourced from the trusted fold (never a caller input) and the balance floor makes a repeat call a no-op.
  - Tests (`product/tests/billing/billing.test.ts`): pays exactly the owed balance and zeroes it; records a
    `payment` kind of that amount; no-op when balance is already 0 (no event appended — assert `eventsFor` length
    unchanged); idempotent double-call (second → `{ paid: false }`, balance stays 0, no extra event); a tenant with
    only `usage_charge` owed settles to 0; the recorded payment amount === the pre-call `balanceCents`.
  - Verify: `npm run build && npm test && npm run lint`. Commit.

- [ ] **Step 2 — The JSON `POST /t/:slug/billing` route.**
  - Widen `BillingHandlerDeps.ledger` to `Pick<BillingLedger, 'summarize' | 'settleBalance'>` (still no raw
    `record` — the pay surface can only settle its own balance).
  - `dispatchBilling`: keep `authorizeBillingView` as the FIRST statement (couple → 403 any method); then
    `if (req.method === 'GET')` → the existing summary; `if (req.method === 'POST')` →
    `handleBillingPay` (`deps.ledger.settleBalance(context.tenant_id)` → `{ status: 200, body: { paid } }`); else
    405. The POST handler reads NOTHING from the body (no `parseObjectBody`) — there is no amount/field to read, so
    a smuggled body is inert by construction.
  - `compose.ts` needs no change (the `billing.ledger` is the full `BillingLedger`, so `settleBalance` is already
    in scope through the widened `Pick`).
  - Tests (`product/tests/http/billing_api.test.ts` — extend): planner POST with an owed balance → 200
    `{ paid: true }` and a subsequent GET shows `balance_cents: 0`; planner POST again → `{ paid: false }` (no
    second payment); planner POST with **zero balance** → `{ paid: false }`; a **body-smuggled `amount_cents`**
    (huge / negative) is ignored — balance settles to exactly its trusted value, never beyond (no negative
    balance); couple POST → 403 **byte-identical** to couple GET (no method oracle); planner PUT/DELETE → 405;
    unauthenticated POST → 401 (byte-identical to GET); cross-tenant token → 401; unmounted (no `billing` dep)
    POST → 404.
  - Verify; commit.

- [ ] **Step 3 — The CSRF-gated Pay form on `?view=billing`.**
  - `renderBilling(theme, slug, summary, csrfToken)` (new param): when `summary.balance_cents > 0`, render a
    **Pay** form posting to `/t/:slug/billing/pay` with the hidden `_csrf` field (via `csrfField`) and a clear
    "Pay the $X.XX owed (simulated)" button; when `<= 0`, render a "Settled — nothing owed" note instead (no
    form). Every value through the `html` template.
  - `#billingPage` (web UI): issue the per-session CSRF token on the 200 path (like `#guestsPage`/`#escalationsPage`
    — a 200 means the session resolved, so its CSRF token must exist; absent ⇒ ERROR_500) and pass it to
    `renderBilling`. Couple → still themed Forbidden (no token, no form).
  - `#billingPay(req, slug)` (web UI, mirrors `#escalationResolve`): verify the `_csrf` token (forged ⇒ masked 403,
    no mutation) BEFORE the cookie→Bearer translation; forward `POST /t/:slug/billing` (empty/`{}` body — the JSON
    handler reads nothing); always PRG-redirect to `/t/:slug?view=billing` (the follow-up GET masks
    unknown-tenant / couple-403 outcomes and re-renders the settled balance).
  - Route `/t/:slug/billing/pay` (4-seg, POST) in `#route`, with `slug === undefined ⇒ GENERIC_404` before any
    cookie/CSRF read — DISTINCT from the 3-seg JSON `/t/:slug/billing` route so they never collide (mirrors the
    `escalations/resolve` routing).
  - Tests: `pages.test.ts` — `renderBilling` shows the Pay form + CSRF field + dollar amount when owed, the settled
    note when not. `billing_web.test.ts` (extend): forged CSRF → 403, NO payment recorded (balance unchanged);
    valid Pay → 303 redirect + balance settled on the follow-up read; couple → no Pay form (themed Forbidden);
    a **full e2e** — provision/activate the demo tenant, send a metered guest reply (Phase 28 path) so a balance
    is owed, the planner clicks Pay, and the billing page then shows `$0.00 owed` (the meter→bill→customer→pay
    loop, demoable end-to-end).
  - Verify; commit.

- [ ] **Step 4 — ADR 0031 + memory + handoff.** Write `docs/adr/0031-simulated-balance-payment.md` (the decisions
  above), add `.claude/memory/simulated-balance-payment.md` (+ index line in `MEMORY.md`, linking
  `[[planner-billing-view]]`), and update `.claude/handoff.local.md` (where things stand + the next ranked lever).
  Verify; commit.

## Out of scope (deferred, name them)
- **Partial / arbitrary-amount payments** — this rung settles the FULL owed balance only (the amount-from-trusted-
  balance keystone). A partial-payment amount would re-introduce client-supplied money input and needs its own
  bounds/no-fraud pass (`0 < amount <= balance`); defer until there's a product reason.
- A planner-facing **activity log / payment history** — still operator-only; this rung records a payment but the
  summary stays an aggregate (no per-event list for the planner yet).
- **Per-period** billing windows / invoices — the balance is lifetime-to-date.
- **Auto-pay / scheduled settlement** — out of scope; this is a manual, planner-initiated action.
- Couple **visibility or payment** of any billing — deliberately none (a couple has no billing capability).
