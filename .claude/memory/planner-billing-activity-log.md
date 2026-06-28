---
name: planner-billing-activity-log
description: Phase 32 — the planner's itemized billing activity log (financial-only line items behind the summary totals); a render-time projection, no schema
metadata:
  type: project
---

# Planner billing activity log (Phase 32)

Makes [[planner-billing-view]] **itemized**: the planner sees every **financial line item** behind their account
totals — each `charge` / `usage_charge` / `payment`, newest-first — as a read-only `activity` list on the existing
`GET /t/:slug/billing` JSON read and a themed **Activity** card on `?view=billing`. The customer-facing analogue of
the operator's raw `billingView.events`, scoped to the planner's OWN tenant. Closes the
meter→bill→pay→**see-the-receipt** loop (a metered guest reply shows as a "Messaging usage" line; paying adds a
"Payment" line at the top). ADR 0032. 934 tests (was 914).

## The load-bearing decisions (carry forward)

- **FINANCIAL kinds ONLY — the itemized DECOMPOSITION of the balance, not the full event log.** `buildBillingActivity`
  filters to `FINANCIAL_KINDS` (`charge`/`usage_charge`/`payment`) and DROPS the lifecycle markers
  (`provisioned`/`suspended`/`reactivated`). This was the design review's one genuine finding (P1-1): the aggregate
  summary already hides markers, so projecting EVERY event would surface `suspended`/`reactivated` — **delinquency
  history** — to the customer for the first time (operator-tier state crossing the boundary by omission). Filtering
  to financial both avoids that NEW disclosure AND makes the itemized list a strict decomposition of the same numbers
  the summary aggregates → the reconciliation invariant is exact and total. Surfacing delinquency history to the
  customer is left a deliberate human product call (stays operator-tier in `billingView.events`).
- **The filter reuses the EXPORTED `FINANCIAL_KINDS` set** (now exported from `billing_ledger.ts`, with
  `FinancialBillingEventKind = Extract<BillingEventKind, 'charge'|'usage_charge'|'payment'>`). One financial-kind
  source for the balance fold, the summary, AND the activity — a future financial kind flows into all three together,
  never just one (extends the Phase-18 lockstep: schema enum + allOf + FINANCIAL_KINDS + balanceCents).
- **A tenant-SAFE shape, built by EXPLICIT pick — never spread-rest.** `BillingActivityEntry = { kind, amount_cents,
  occurred_at }` (every entry is financial ⇒ amount always present). Built by naming those three fields, NEVER by
  spreading the raw `BillingEvent` and deleting keys — because `BillingEvent` permits `additionalProperties`, a
  spread-rest could forward a future stray key (or the internal `event_id` / redundant `tenant_id`) to the customer.
  The explicit pick makes "drops event_id/tenant_id" STRUCTURAL; a key-set test pins exactly the three keys.
- **No new oracle: scoped by the minted `context.tenant_id`** (`eventsFor`'s partition key — strict tenant filter,
  body-smuggled tenant_id inert; the GET reads no body). Same planner-only gate (`authorizeBillingView`) already
  FIRST in `dispatchBilling`, before the method branch → couple 403 byte-identical, activity never computed (pinned).
  The activity discloses nothing beyond the already-visible aggregate — it itemizes the SAME owed balance.
- **Newest-first is `[...events].reverse()` of the trusted APPEND order — NOT a sort by `occurred_at`** (a
  non-monotonic / equal-timestamp injected clock creates no reorder ambiguity). Order is a pure function of trusted
  append order, never an untrusted field.
- **Reconciles EXACTLY with the summary (drift-guarded):** Σ(payment entries)===`payments_cents`,
  Σ(charge)===`subscription_charges_cents`, Σ(usage_charge)===`messaging_spend_cents`, usage count===`messages_sent`,
  Σ(debits)−Σ(payments)===`balance_cents`. A test pins it — the itemized log can never silently disagree with the
  aggregate (the "one money model, not three" hazard).
- **Render/web robustness — no 500 oracle.** `renderBilling(theme, slug, summary, activity, csrfToken)` (new
  `activity` param). Label = a FROZEN `ACTIVITY_LABELS` lookup with an **escaped raw-`kind` fallback** (never raw enum
  reflection, never throws on an unexpected kind from the JSON read). Empty list → "No activity yet." note. The web
  UI reads `activity` tolerantly (`readBillingActivity` → `[]` on absent/malformed). Everything via the `html`
  escaping template. Web UI's ONLY data path stays `api.handle()`.

## Shape

- **`billing_activity.ts`** (`@canonical billing_activity`) — `BillingActivityEntry` + pure `buildBillingActivity`,
  exported from `product/src/index.ts` beside `buildBillingSummary`. Pure render-time projection, like
  `buildBillingSummary` / `describeStrategy`; NO schema (manifest stays 20).
- **`product_api.ts`** — `BillingHandlerDeps.ledger` widened via the `Pick` to add `'eventsFor'` (still no `record`
  — read-only); GET branch returns `{ billing, activity }`. POST (settle) unchanged.
- **`pages.ts`** — the Activity card; `ACTIVITY_LABELS` frozen const + `activityLabel` fallback.
- **`product_web_ui.ts`** — `readBillingActivity` (tolerant) + pass to `renderBilling`.

## Deferred
Per-period statements/invoices, pagination/filtering, lifecycle markers in the activity (financial-only), exposing
`event_id`, couple activity (none — planner-only), partial/arbitrary-amount payments (still from Phase 31).
