# ADR 0032 — Planner billing activity log

- **Status:** accepted
- **Date:** 2026-06-28
- **Decider:** the building agent (an agent-owned engineering decision per
  [[agents-own-buildout-decisions]] and `.claude/plans/2026-06-28-phase-32-planner-billing-activity-log.md`)
- **Scope:** Phase 32 — give the planner an **itemized** view of their billing. Phase 30 (ADR 0030) showed the
  aggregate account (plan, usage count + spend, owed balance); Phase 31 (ADR 0031) let them pay it down. This rung
  surfaces the individual **financial line items** behind those totals — every charge and payment, newest-first —
  as a read-only `activity` list on the existing `GET /t/:slug/billing` JSON read and a themed card on
  `?view=billing`. The customer-facing analogue of the operator's raw `billingView.events`, scoped to the
  planner's OWN tenant.
- **Builds on** the billing ledger ([[onboarding-billing-operator-tier]], ADR 0015), the read view
  ([[planner-billing-view]], ADR 0030), the pay mutation ([[simulated-balance-payment]], ADR 0031), and the
  no-oracle pipeline ([[http-edge-and-intra-tenant-auth]]). It is a pure render-time projection (like
  `BillingSummary` / `StrategyGuidance`) — **no new contract** (manifest stays 20).

## Context

After Phases 30–31 the planner sees their owed balance as a single aggregate and can settle it, but never "what
was I charged and paid, and when". Now that payments are planner-initiated, an itemized "here's every charge and
payment on your account" ledger is the obvious transparency rung — the top-ranked "recommended next" lever in the
Phase-31 handoff. Bounded, read-only, no new mutation, reuses the existing `eventsFor` fold.

An adversarial **design** review ran first (a `general-purpose` agent carrying the doddy + rigorous-architect
lens — the named specialists are not provisioned here): verdict **APPROVE-WITH-FIXES, no exploit**. Its one
genuine finding (P1-1) reshaped the design — see Decision 1. A **built-code** review of the committed read path
followed. 934 tests green (was 914 at phase start; +6 projection, +9 JSON API, +5 web/pages).

## Decisions

### 1. FINANCIAL kinds ONLY — the itemized decomposition of the balance, no new lifecycle disclosure

The design review caught the one genuine new disclosure: a raw `BillingEvent` carries `kind` for EVERY event,
including the lifecycle markers `provisioned` / `suspended` / `reactivated`. The aggregate summary already hides
markers (its fold sums only the financial kinds), so a naïve "project every event" would surface
`suspended` / `reactivated` — i.e. **delinquency history** — to the customer for the first time, operator-tier
state crossing the boundary by omission.

The fix: `buildBillingActivity` filters to the FINANCIAL kinds (`charge` / `usage_charge` / `payment`) and drops
the markers. This is not just a disclosure choice — it makes the activity a **strict decomposition** of the same
numbers the summary aggregates ("here's what you were charged and paid, itemized"), which makes the
summary-reconciliation invariant (Decision 4) exact and total. The filter reuses the SAME `FINANCIAL_KINDS` set
the balance fold keys off (now exported from `billing_ledger.ts`), so a future financial kind flows into the
balance, the summary, AND the activity together — never just one. Whether to surface delinquency history to the
customer is left as a deliberate, human-reserved product decision (it stays operator-tier in `billingView.events`).

### 2. A tenant-SAFE shape, built by EXPLICIT pick (no spread-rest)

Each `BillingActivityEntry` is `{ kind, amount_cents, occurred_at }` — every entry is financial, so `amount_cents`
is always present. It is constructed by explicitly naming those three fields, **never** by spreading the raw
`BillingEvent` and deleting keys. The `BillingEvent` type permits `additionalProperties`, so a spread-rest could
forward a future stray key (or the internal `event_id`, or the redundant `tenant_id`) straight to the customer.
The explicit pick makes "drops `event_id` and `tenant_id`" a structural guarantee, not a function of the current
event shape. A key-set test pins the projected shape (exactly the three keys). Never exposes provider COGS /
margin / internal ids — the same guarantee the summary already makes.

### 3. Scoped by the minted `context.tenant_id` — no new oracle

The handler reads `deps.ledger.eventsFor(context.tenant_id)` — the SAME partition key the summary uses;
`eventsFor` filters STRICTLY by tenant_id (no cross-tenant leak). A body-smuggled `tenant_id` is inert (the GET
reads no body; the key is the minted context). Nothing new is disclosed beyond the already-visible aggregate: the
activity is the per-event detail of the SAME owed balance the planner already sees — it just itemizes it. The
whole `GET /t/:slug/billing` is already gated by `authorizeBillingView` as the FIRST statement of
`dispatchBilling`, before the method branch — a couple is `forbidden` → 403 byte-identical for any method, and the
activity is never computed (a test pins this against a future hoist of `eventsFor` above the gate). Read-only ⇒ no
CSRF surface.

### 4. Newest-first by trusted append order; reconciles EXACTLY with the summary

The list is NEWEST-FIRST — a copy of the trusted record (append) order, reversed (`[...events].reverse()`), NOT a
sort by `occurred_at`, so a non-monotonic / equal-timestamp injected clock creates no reorder ambiguity. Order is
a pure function of the trusted append order, never an untrusted field. Because both the activity entries and the
summary buckets fold the SAME financial events, the reconciliation is total — Σ(payment entries) ===
`payments_cents`, Σ(charge) === `subscription_charges_cents`, Σ(usage_charge) === `messaging_spend_cents`, the
usage_charge count === `messages_sent`, and Σ(debits) − Σ(payments) === `balance_cents`. A test pins this so the
itemized log can never silently disagree with the aggregate (the "one money model, not three" hazard the ledger
already warns about).

### 5. Render & web-read robustness — never a 500 oracle

`renderBilling` gains an `activity` parameter and renders an Activity card: each entry shows a fixed human label
per kind (a FROZEN `ACTIVITY_LABELS` lookup with an **escaped raw-`kind` fallback** for an unexpected key — never
raw enum reflection, never a throw), the amount via `dollars`, and `occurred_at` as escaped text; an empty list
renders a "No activity yet." note. Every value flows through the `html` escaping template (defense-in-depth — all
fields are server-recorded, so there is no new untrusted-text surface, but they are escaped regardless). The web
UI reads the activity via a tolerant `readBillingActivity` (→ `[]` on absent/malformed), so a malformed body never
throws on the 200 path (no 500 oracle). The web UI's ONLY data path remains `api.handle()`.

## Consequences

- The planner sees a transparent, itemized "every charge and payment" ledger on `?view=billing`, closing the
  read→pay→**see-the-receipt** loop. Demoable end-to-end: a metered guest reply appears as a "Messaging usage"
  line; paying it down adds a "Payment" line at the top.
- One new billing-domain module (`billing_activity.ts`, `@canonical`), exported beside `buildBillingSummary`;
  `pages.ts` stays render-only, `product_api.ts` wiring-only. `FINANCIAL_KINDS` + `FinancialBillingEventKind` are
  now exported from `billing_ledger.ts` (one financial-kind source for the balance, the summary, and the activity).
- No new schema, no new route, no new mutation, no CSRF surface. Manifest stays 20.

## Deferred (named)

- **Per-period statements / invoices** — the activity is a flat lifetime-to-date list, not grouped into billing
  windows (needs a period model the ledger doesn't carry).
- **Pagination / filtering** — the full (demo-scale) history is rendered; revisit if a tenant accrues enough
  events to need a cursor.
- **Lifecycle markers in the activity** — deliberately filtered out (financial-only); surfacing delinquency
  history to the customer is a human product call.
- **Exposing `event_id`** — dropped (internal identity); re-introduce a tenant-safe opaque ref if a future
  "download my statement" / per-entry deep-link needs a stable key.
- **Activity for the couple** — none; billing is a planner-only capability.
- **Partial / arbitrary-amount payments** — still deferred from Phase 31.
