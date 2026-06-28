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
- **Project to a tenant-SAFE shape — drop internal identity, keep only tenant-side facts.** A raw `BillingEvent`
  carries `event_id` (internal id), `tenant_id` (the caller's own — redundant), `kind`, `amount_cents?`,
  `occurred_at`. The projection keeps **only `kind`, `amount_cents?` (iff financial), `occurred_at`** and DROPS
  `event_id` + `tenant_id`. Same figures already in the summary fold (what the tenant was charged/paid + when) —
  never provider COGS / platform margin / internal ids (those stay internal to `price_book.ts` /
  `messaging_service.ts`, exactly as the summary already guarantees). A key-set test pins the projected shape so a
  future raw field can't silently ride along.
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
- **Reconciles with the summary by construction (drift-guarded by a test).** The activity entries and the summary
  buckets both fold the SAME `#byTenant` events, so Σ(payment activity amounts) === `summary.payments_cents`,
  Σ(charge) === `subscription_charges_cents`, Σ(usage_charge) === `messaging_spend_cents`, and the
  usage_charge entry count === `messages_sent`. A test pins this reconciliation so the itemized log can never
  silently disagree with the aggregate the planner also sees.
- **Tolerant web read (never throws).** `#billingPage` does ONE `api.handle()` read (the only-data-path invariant);
  a new `readBillingActivity(body)` reads the `activity` array tolerantly → `[]` if absent/malformed (mirrors
  `readBilling` returning `undefined`). The activity card renders an empty-state note when the list is empty.
- **All values through the `html` template.** Kinds map to fixed human labels (a frozen lookup, not raw enum
  reflection), amounts via `dollars`, `occurred_at` as escaped text. No untrusted free text enters the activity
  (every field is server-recorded), so there is no new XSS surface — but everything is escaped regardless.

## Steps

- [ ] **Step 0 — Adversarial design review.** Route through a `general-purpose` agent carrying the doddy
  (security/no-oracle) + rigorous-architect (design) lens (the named specialists are not provisioned here). Confirm:
  the projection discloses nothing beyond the already-visible aggregate (it itemizes the same fold); dropping
  `event_id`/`tenant_id` leaves no internal-id surface; `eventsFor(context.tenant_id)` is the same no-cross-tenant
  partition the summary uses; the planner-only gate already covers the read so no couple-reachable change; the
  newest-first reorder is over trusted append order only; the summary-reconciliation test is the right drift guard.
  Fold any P1/P2 findings before ticking.

- [ ] **Step 1 — `buildBillingActivity` + `BillingActivityEntry` (billing domain).**
  - New `product/src/billing/billing_activity.ts`: `BillingActivityEntry = { kind: BillingEventKind; amount_cents?: number; occurred_at: string }` and a pure
    `buildBillingActivity(events: readonly BillingEvent[]): BillingActivityEntry[]` that maps each event to
    `{ kind, ...(financial ? { amount_cents } : {}), occurred_at }` and returns the list **newest-first**
    (reverse of record order). No I/O, no clock — a deterministic function of its input (mirrors `describeStrategy`).
    Header documents the tenant-safe projection (drops `event_id`/`tenant_id`) + the newest-first order.
  - Tests (`product/tests/billing/billing_activity.test.ts`): maps a financial event to `{kind,amount_cents,occurred_at}`
    and a marker to `{kind,occurred_at}` (NO `amount_cents` key — assert the key is absent, not falsy); drops
    `event_id`/`tenant_id` (key-set pin); empty input → `[]`; preserves all events; **newest-first** order; a mixed
    ledger (provision/charge/usage/payment) reconciles with `summarize` (Σ per-kind amounts + usage count).
  - Verify: `npm run build && npm test && npm run lint`. Commit.

- [ ] **Step 2 — Wire `activity` into `GET /t/:slug/billing`.**
  - Widen `BillingHandlerDeps.ledger` to `Pick<BillingLedger, 'summarize' | 'settleBalance' | 'eventsFor'>`
    (still no raw `record` — the read surface can't write). `compose.ts` needs no change (the wired `ledger` is the
    full `BillingLedger`).
  - `dispatchBilling` GET branch: `const activity = buildBillingActivity(deps.ledger.eventsFor(context.tenant_id))`
    and return `{ status: 200, body: { billing, activity } }`. POST (settle) unchanged. Auth-first/method order
    unchanged.
  - Tests (`product/tests/http/billing_api.test.ts` — extend): planner GET returns `activity` newest-first; an
    unprovisioned/zero-event tenant → `activity: []`; the activity reconciles with the returned `billing` summary
    (Σ payments etc.); a body-smuggled `tenant_id` does NOT change the activity (own tenant only); a second tenant's
    events never appear (cross-tenant isolation); couple GET → 403 byte-identical (no `activity` leaked); after a
    Phase-31 settle POST, the follow-up GET's activity includes the new `payment` entry.
  - Verify; commit.

- [ ] **Step 3 — The themed Activity card on `?view=billing`.**
  - `renderBilling(theme, slug, summary, activity, csrfToken)` (new `activity` param): add an **"Activity"** card
    after the balance card — a list of entries, each a fixed human label per `kind` (`provisioned`→"Account
    created", `suspended`→"Account suspended", `reactivated`→"Account reactivated", `charge`→"Subscription charge",
    `usage_charge`→"Messaging usage", `payment`→"Payment"), the `dollars(amount_cents)` when financial, and the
    `occurred_at` as escaped text. Empty list → a "No activity yet." note. The label lookup is a frozen const, not
    raw enum reflection. Everything through the `html` template.
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
- **Partial / arbitrary-amount payments** — still deferred from Phase 31 (re-introduces client money input).
