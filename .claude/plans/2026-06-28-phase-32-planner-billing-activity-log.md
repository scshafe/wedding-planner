# Phase 32 — Planner billing activity log

## Why (the lever)
Phase 30 gave the planner an **aggregate** view of their account (plan, usage count + spend, owed balance) and
Phase 31 let them **pay** it down. But the page still answers "what do I owe *right now*", never "what was I
charged and paid, and *when*". Now that payments are **planner-initiated** (Phase 31), a transparent
"here's every charge and payment on your account" ledger is the obvious transparency rung — the customer-facing
analogue of the operator's raw `billingView.events`, scoped to the planner's OWN tenant. It is the top-ranked
"recommended next" lever in the Phase-31 handoff. Bounded, read-only, no new mutation, reuses the existing
`eventsFor` fold; no new schema (a render-time projection, like `BillingSummary` — manifest stays 20).

## Scope (one rung)
Extend the existing planner-only `GET /t/:slug/billing` read to return, alongside the `billing` summary, a
customer-facing **`activity`** list — the tenant's own billing events (provisioned / suspended / reactivated /
charge / usage_charge / payment, including the Phase-31 settlement payment) projected to a tenant-safe shape and
rendered as a themed read-only card on `?view=billing`. No new route, no mutation, no contract.

## Design (the load-bearing decisions)

- **A render-time PROJECTION, not a new contract.** Like `BillingSummary`/`StrategyGuidance`, the activity list is
  a pure view derived from the tenant's own ledger events — there is no persisted "activity" record, so no new
  schema (manifest stays 20). A new `billing_activity.ts` (`@canonical billing_activity`) holds
  `BillingActivityEntry` + a pure `buildBillingActivity(events)` mapper. One capability, one file (sibling to
  `billing_summary.ts`, which stays the AGGREGATE projection).
- **FINANCIAL kinds ONLY — the itemized decomposition of the balance, no new lifecycle disclosure.** The activity
  list filters to the FINANCIAL kinds (`charge` / `usage_charge` / `payment`) and DROPS the lifecycle markers
  (`provisioned` / `suspended` / `reactivated`). This is deliberate: the aggregate summary already hides markers
  (its fold sums only the financial kinds), so surfacing `suspended`/`reactivated` would be a NEW
  delinquency-history disclosure — operator/admin-tier state crossing to the customer surface for the first time
  (doddy P1-1). Filtering to financial keeps the activity a strict **decomposition of the same numbers the summary
  aggregates** ("here's what you were charged and paid, itemized"), which also makes the summary reconciliation
  (below) exact and total. The filter reuses the SAME `FINANCIAL_KINDS` set the balance fold uses (export it from
  `billing_ledger.ts`) — so a future financial kind flows into the activity, the balance, and the summary in
  lockstep, never just one.
- **Project to a tenant-SAFE shape — explicit-pick, drop internal identity.** A raw `BillingEvent` carries
  `event_id` (internal id), `tenant_id` (the caller's own — redundant), `kind`, `amount_cents?`, `occurred_at`. The
  projection keeps **only `kind`, `amount_cents`, `occurred_at`** (every entry is financial ⇒ `amount_cents` is
  always present), built by EXPLICITLY constructing the entry from named fields — NEVER by spreading the raw event
  and deleting keys (doddy P1-4: the `BillingEvent` type permits `additionalProperties`, so a spread-rest could
  forward a future stray key to the customer; an explicit pick makes "drops `event_id`/`tenant_id`" structural).
  Same figures already in the summary fold (what the tenant was charged/paid + when) — never provider COGS /
  platform margin / internal ids. A key-set test pins the projected shape so a future raw field can't ride along.
- **Scoped by the MINTED `context.tenant_id` alone — no new oracle.** The handler reads
  `deps.ledger.eventsFor(context.tenant_id)` — the SAME partition key the summary uses; `eventsFor` already filters
  STRICTLY by tenant_id (doddy P2-1, never cross-tenant). A body-smuggled `tenant_id` is inert (the key is the
  minted context, never a body/URL field). Nothing new is disclosed: the activity is the per-event detail of the
  SAME owed balance the planner already sees aggregated — it just itemizes it.
- **Same planner-only gate, already FIRST.** The whole `GET /t/:slug/billing` is gated by
  `authorizeBillingView` as the first statement of `dispatchBilling` (Phase 30/31). The activity rides that exact
  read — a couple is `forbidden` → 403 byte-identical for ANY method, unchanged. No new gate, no new method, so the
  no-method-oracle stays structural. Read-only ⇒ no CSRF surface.
- **Newest-first display order, derived from the trusted record order.** `eventsFor` returns events in record
  (chronological) order; the projection REVERSES to newest-first (the natural "recent activity" reading). The order
  is a pure function of the trusted append order — no client input, no re-sort by an untrusted field.
- **Reconciles EXACTLY with the summary (drift-guarded by a test, doddy P1-3).** Because both the activity entries
  and the summary buckets fold the SAME financial events, the reconciliation is total: Σ(payment entries) ===
  `summary.payments_cents`, Σ(charge) === `subscription_charges_cents`, Σ(usage_charge) ===
  `messaging_spend_cents`, the usage_charge entry count === `messages_sent`, and Σ(debit entries) − Σ(payment
  entries) === `balance_cents`. A test pins this so the itemized log can never silently disagree with the aggregate
  the planner also sees — the "one money model, not three" hazard the ledger already warns about.
- **Tolerant web read (never throws).** `#billingPage` does ONE `api.handle()` read (the only-data-path invariant);
  a new `readBillingActivity(body)` reads the `activity` array tolerantly → `[]` if absent/malformed (mirrors
  `readBilling` returning `undefined`). The activity card renders an empty-state note when the list is empty.
- **All values through the `html` template.** Kinds map to fixed human labels (a frozen lookup, not raw enum
  reflection), amounts via `dollars`, `occurred_at` as escaped text. No untrusted free text enters the activity
  (every field is server-recorded), so there is no new XSS surface — but everything is escaped regardless.

## Steps

- [x] **Step 0 — Adversarial design review.** Routed through a `general-purpose` agent carrying the doddy
  (security/no-oracle) + rigorous-architect (design) lens (the named specialists are not provisioned here). Verdict
  **APPROVE-WITH-FIXES, no exploit** — no new cross-tenant/wedding leak (`eventsFor` is partition-keyed by the
  minted `context.tenant_id`; the ledger has no wedding axis), no smuggling (GET reads no body), no method oracle
  (shared auth-first gate), no XSS (every field routes through the `html` escaping template), no reorder oracle
  (a `reverse()` of record order, NOT a timestamp sort). Folded fixes:
  - **P1-1 (the one genuine new disclosure):** keeping ALL kinds would surface lifecycle markers
    (`suspended`/`reactivated` = delinquency history) the summary deliberately hides. **FIX: filter the activity to
    FINANCIAL kinds only** — making it a strict itemized decomposition of the balance and resolving P1-3 in the
    same move. Markers stay operator-tier (where they already live in `billingView.events`).
  - **P1-2:** pin a test that a couple GET (now carrying `activity`) is byte-identical 403 and the activity is never
    computed before the gate (the gate is already the first statement; the test guards a future hoist).
  - **P1-3:** pin the EXACT itemized↔aggregate reconciliation test (now total, given the financial-only filter).
  - **P1-4:** build each entry by EXPLICIT pick from named fields, never spread-rest of the raw event (the
    `BillingEvent` type permits `additionalProperties`); key-set test asserts exactly `{kind,amount_cents,occurred_at}`.
  - **P2-2:** widen `BillingHandlerDeps.ledger` via the `Pick` (add `'eventsFor'`), not the whole `BillingLedger`.
  - **P2-3:** tolerant web reader (→ `[]` on absent/malformed, never a 500 oracle); frozen label lookup with an
    escaped raw-`kind` fallback for an unexpected key.
  - **P2-4:** `buildBillingActivity` lives in a billing-domain module (`billing_activity.ts`, `@canonical`),
    exported from `product/src/index.ts` beside `buildBillingSummary`; `pages.ts` stays render-only.

- [ ] **Step 1 — `buildBillingActivity` + `BillingActivityEntry` (billing domain).**
  - Export `FINANCIAL_KINDS` (and a `FinancialBillingEventKind = Extract<BillingEventKind, 'charge' | 'usage_charge' | 'payment'>`)
    from `billing_ledger.ts` so the activity filter and the balance fold reference ONE financial-kind source.
  - New `product/src/billing/billing_activity.ts` (`@canonical billing_activity`):
    `BillingActivityEntry = { kind: FinancialBillingEventKind; amount_cents: number; occurred_at: string }` and a pure
    `buildBillingActivity(events: readonly BillingEvent[]): BillingActivityEntry[]` = `[...events].reverse()`
    (copy-then-reverse — input is `readonly`), FILTERED to `FINANCIAL_KINDS` (a type-predicate narrows `kind`), each
    entry EXPLICITLY constructed `{ kind, amount_cents: amount ?? 0, occurred_at }` (named-field pick, never
    spread-rest). No I/O, no clock (mirrors `describeStrategy`/`buildBillingSummary`). Export from
    `product/src/index.ts`. Header documents financial-only (markers dropped — operator-tier), the explicit pick
    (drops `event_id`/`tenant_id`), and the newest-first order.
  - Tests (`product/tests/billing/billing_activity.test.ts`): maps a financial event to exactly
    `{kind,amount_cents,occurred_at}` (key-set pin — NO `event_id`/`tenant_id`); **DROPS markers** (a
    provisioned/suspended/reactivated event yields no entry); empty input → `[]`; **newest-first** order; a mixed
    ledger reconciles EXACTLY with `summarize` (Σ per-kind amounts, usage count, and Σdebits−Σpayments ===
    `balance_cents`).
  - Verify: `npm run build && npm test && npm run lint`. Commit.

- [ ] **Step 2 — Wire `activity` into `GET /t/:slug/billing`.**
  - Widen `BillingHandlerDeps.ledger` to `Pick<BillingLedger, 'summarize' | 'settleBalance' | 'eventsFor'>`
    (still no raw `record` — the read surface can't write). `compose.ts` needs no change (the wired `ledger` is the
    full `BillingLedger`).
  - `dispatchBilling` GET branch: `const activity = buildBillingActivity(deps.ledger.eventsFor(context.tenant_id))`
    and return `{ status: 200, body: { billing, activity } }`. POST (settle) unchanged. Auth-first/method order
    unchanged.
  - Tests (`product/tests/http/billing_api.test.ts` — extend): planner GET returns `activity` newest-first and
    financial-only (NO marker/lifecycle entries even after a suspend/reactivate cycle); an unprovisioned/zero-event
    tenant → `activity: []`; the activity reconciles with the returned `billing` summary (Σ payments etc.); a
    body-smuggled `tenant_id` does NOT change the activity (own tenant only); a second tenant's events never appear
    (cross-tenant isolation); **couple GET → 403 byte-identical, `activity` never leaked** (P1-2); after a Phase-31
    settle POST, the follow-up GET's activity includes the new `payment` entry.
  - Verify; commit.

- [ ] **Step 3 — The themed Activity card on `?view=billing`.**
  - `renderBilling(theme, slug, summary, activity, csrfToken)` (new `activity` param): add an **"Activity"** card
    after the balance card — a list of entries, each a fixed human label per `kind` (`charge`→"Subscription
    charge", `usage_charge`→"Messaging usage", `payment`→"Payment"), the `dollars(amount_cents)`, and the
    `occurred_at` as escaped text. Empty list → a "No activity yet." note. The label lookup is a FROZEN const with
    an escaped raw-`kind` fallback for an unexpected key (P2-3, never throws — no 500 oracle). Everything through
    the `html` template.
  - `#billingPage` (web UI): read the activity via a new tolerant `readBillingActivity(apiRes.body)` (→ `[]` if
    absent/malformed) and pass it to `renderBilling`. The 200/CSRF/theme invariant logic is unchanged.
  - Tests: `pages.test.ts` — `renderBilling` lists each entry with its label + amount + time when present, the
    empty-state note when none, and escapes a hostile `occurred_at`/label (defense-in-depth). `billing_web.test.ts`
    (extend): the billing page shows the activity card with the charge/usage/payment entries for an active tenant;
    after the Pay e2e (Phase 31 path) the page lists the new payment entry; a couple sees no activity (themed
    Forbidden). Keep the existing Pay-form/CSRF assertions green (the new `activity` param is additive).
  - Verify; commit.

- [ ] **Step 4 — ADR 0032 + memory + handoff.** Write `docs/adr/0032-planner-billing-activity-log.md` (the
  decisions above), add `.claude/memory/planner-billing-activity-log.md` (+ index line in `MEMORY.md`, linking
  `[[planner-billing-view]]` and `[[simulated-balance-payment]]`), and update `.claude/handoff.local.md` (where
  things stand + the next ranked lever). Verify; commit.

## Out of scope (deferred, name them)
- **Per-period statements / invoices** — the activity is a flat lifetime-to-date list, not grouped into billing
  windows. A per-period invoice view needs a period model the ledger doesn't carry yet.
- **Pagination / filtering** — the list is the full (small, demo-scale) event history; no cursor/filter UI. Revisit
  if a tenant accrues enough events to need it.
- **Activity for the couple** — deliberately none; billing is a planner-only capability (couple → 403), unchanged.
- **Exposing `event_id`** — dropped from the projection (internal identity). If a future "download my statement"
  or per-entry deep-link needs a stable key, re-introduce a tenant-safe opaque ref then.
- **Lifecycle markers in the activity** (`provisioned`/`suspended`/`reactivated`) — deliberately filtered OUT
  (financial-only): surfacing delinquency history (`suspended`/`reactivated`) to the customer is a new disclosure
  decision left to a human product call; they stay operator-tier in `billingView.events`.
- **Partial / arbitrary-amount payments** — still deferred from Phase 31 (re-introduces client money input).
