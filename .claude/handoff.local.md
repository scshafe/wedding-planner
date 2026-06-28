# Handoff

## Where things stand — Phase 32 (planner billing activity log) is COMPLETE ✅
`.claude/plans/2026-06-28-phase-32-planner-billing-activity-log.md` is **complete — Step 0 design review + Steps
1–4 ticked**, on branch **`build/phase-32-planner-billing-activity-log`** (off `build/phase-31-simulated-balance-payment`,
the open review-artifact stack toward `main`; the loop's merge-keeper advances `main` when green). Working tree
clean. `npm run build && npm test && npm run lint` all green (**934 tests**, up from 914 at the start of this run).

This rung makes the Phase-30/31 billing surface **itemized**: the planner now sees every **financial line item**
behind their account totals — each `charge` / `usage_charge` / `payment`, newest-first — as a read-only `activity`
list on `GET /t/:slug/billing` and a themed **Activity** card on `?view=billing`. The customer-facing analogue of
the operator's raw `billingView.events`, scoped to the planner's OWN tenant. Closes the
meter→bill→pay→**see-the-receipt** loop, demoable (a metered guest reply shows as a "Messaging usage" line; paying
it down adds a "Payment" line at the top). Offline-first, no new schema (render-time projection, manifest stays 20).
doddy+architect design review APPROVE-WITH-FIXES (the one genuine finding reshaped the design — see below), and a
SECOND **built-code** review APPROVE (no constructible exploit, all 6 properties verified at file:line). ADR 0032,
memory [[planner-billing-activity-log]].

## What changed this phase
- **`billing_activity.ts`** (new, `@canonical billing_activity`) — `BillingActivityEntry = { kind, amount_cents,
  occurred_at }` + pure `buildBillingActivity(events)`: filters to FINANCIAL kinds, EXPLICIT-pick each entry (never
  spread-rest), returns NEWEST-FIRST (`[...events].reverse()`). Exported from `product/src/index.ts` beside
  `buildBillingSummary`.
- **`billing_ledger.ts`** — `FINANCIAL_KINDS` (was module-private) and `FinancialBillingEventKind` now EXPORTED, so
  the activity filter and the balance fold reference ONE financial-kind source (a new financial kind flows into
  balance + summary + activity together).
- **`product_api.ts`** — `BillingHandlerDeps.ledger` widened via the `Pick` to add `'eventsFor'` (still no `record`
  — read-only); `dispatchBilling` GET now returns `{ billing, activity }`. POST (settle) unchanged; auth-first/method
  order unchanged.
- **`pages.ts`** — `renderBilling(theme, slug, summary, activity, csrfToken)` (new `activity` param) renders an
  Activity card after the balance: each line a frozen `ACTIVITY_LABELS` label (escaped raw-`kind` fallback, never
  throws) + `dollars(amount_cents)` + escaped `occurred_at`; empty → "No activity yet."
- **`product_web_ui.ts`** — `readBillingActivity` (tolerant → `[]` on absent/malformed, no 500 oracle) + passed to
  `renderBilling`.
- **Tests** — `billing_activity.test.ts` +6 (key-set pin, markers dropped, newest-first, empty, no-mutate, EXACT
  `summarize` reconciliation); `billing_api.test.ts` +9 (newest-first/key-set, financial-only across a suspend
  cycle, `[]` empty, exact summary reconciliation, own-tenant-only, smuggled tenant_id inert, couple-403-no-leak,
  settle adds a payment line); `pages.test.ts` +3 (list/empty/hostile-escape); `billing_web.test.ts` +3 (empty card,
  meter→bill→pay itemized newest-first, couple sees no card).

## The load-bearing insight (carry forward) — see [[planner-billing-activity-log]] for the full set
- **The activity is the itemized DECOMPOSITION of the balance — FINANCIAL kinds ONLY.** The design review's one
  genuine finding (P1-1): the aggregate summary already hides lifecycle markers, so projecting EVERY event would
  newly disclose `suspended`/`reactivated` — **delinquency history** — to the customer (operator-tier state crossing
  by omission). Filtering to `charge`/`usage_charge`/`payment` both avoids that NEW disclosure AND makes the list a
  strict decomposition of the same numbers the summary aggregates → the summary-reconciliation invariant is exact and
  total. Surfacing delinquency history to the customer is a deliberate human product call (stays operator-tier).
- **A tenant-safe projection is built by EXPLICIT pick, never spread-rest** — `BillingEvent` permits
  `additionalProperties`, so a `{ event_id, tenant_id, ...rest }` style omit could forward a future stray key (or an
  internal id) to the customer. Naming the three kept fields makes "drops event_id/tenant_id" STRUCTURAL.
- **Reuse the EXPORTED `FINANCIAL_KINDS` set** so the activity filter, the balance fold, and the summary share one
  financial-kind source (extends the Phase-18 lockstep: schema enum + allOf + FINANCIAL_KINDS + balanceCents).
- **No new oracle on a read extension:** same minted-`context.tenant_id` partition (`eventsFor`), same planner-only
  gate already FIRST (couple 403, activity never computed — pinned against a future hoist). The activity discloses
  nothing beyond the already-visible aggregate; newest-first is `reverse()` of trusted append order, not a sort.

## Next action — your call. Pick the next high-value lever (ranked)
- **Multi-turn reply thread** — the still-open inbox extension: a per-escalation message log so an operator can send
  follow-ups after the first reply (and a guest reply lands in the thread), decoupling reply from auto-resolve.
  `escalation_resolution.reply_text` becomes the legacy "first reply". Medium-large; the guest-reply-into-thread
  piece needs conversation correlation the provider-agnostic port doesn't carry (a real design sub-problem).
  **Recommended next** — the billing surface is now well-developed (read → pay → itemized history); the inbox is the
  other half of the guest loop and has the most-cited open thread.
- **A couple-REGISTER design rung** — resolve the deferred Phase-24 oracle (per-wedding `recipient_ref` namespacing
  OR masked-conflict semantics). The most-cited open product-authz deferral. Medium; needs a real design pass on the
  tenant-global-key collision.
- **Unify `product/price_book.ts` onto the shared cost basis** (retail = COGS × margin over `MESSAGE_COST_CENTS`) —
  the clean Phase-20 follow-up; tidies the two-cents-tables seam. Smaller.
- **Per-period billing windows / statements** — the deferred extension of THIS phase: group the activity into
  billing periods / invoices (needs a period model the ledger doesn't carry yet). Medium; defer until a product
  reason (the flat lifetime list covers the demo).
- **Partial / arbitrary-amount payments** — the deferred Phase-31 extension: a planner pays a chosen amount
  (`0 < amount ≤ balance`). Re-introduces client-supplied money input → needs its own bounds/no-fraud pass. Defer
  until there's a product reason (full-settle covers the demo loop).
- **Return-to-the-engine threads** — the self-improvement loop (advisory tier-2 recs, live publish pipeline) has open
  deferrals if you want to swing back from the product surface.

## Standing rails (unchanged — do not weaken)
Offline-first (no real money/booking/comms; no prod/credentials — don't simulate them). **A real messaging provider
sending real texts is the human crossing (guest-comms tier-2 / exception #4) — build up to the line, never across it
or simulate having.** Don't modify `ops/` or `CLAUDE.md` (human-reserved). Push only to this repo's `origin`. The
named specialist sub-agents (doddy/wolf/testineer/rigorous-architect) are **not provisioned** here — route
adversarial reviews through `general-purpose` agents carrying the persona lens (this run did, at BOTH design AND
built-code — APPROVE, no exploit). **CI/exit-code lesson:** never pipe `npm run build`/`npm run lint` to tail/grep
when gating with `&&` (the pipe masks the non-zero exit; `$?` after a pipe is the LAST stage's — use
`${PIPESTATUS[0]}`); run them standalone and check the exit. `npm run build` runs from REPO ROOT. **Eval-harness/
telemetry import ONLY `@wedding-planner/shared`, never `product`** (the firewall, by reachability). **Schema change ⇒
`npm run gen:types`**; a NEW schema file additionally bumps the manifest count test (+ title prose) + the gen-script
header — **Phases 30, 31 & 32 added NO schema** (render-time projections / an existing `payment` kind), so the
manifest stays 20. **The guest responder's security boundary is `projectGuestVisibleFacts`'s allow-list.** **Web-form
mutations are CSRF-gated at the web layer ONLY** (the JSON API is Bearer-only / not CSRF-reachable). **The web UI's
ONLY data path is `api.handle()`.** **Guest/manage/billing scope comes from the MINTED principal/context, never the
request body.** **A capability the role lacks entirely (couple→register, couple→billing-account incl. pay) is a 403
checked FIRST, before the method/body branch — not a masked 404; ONE shared gate for read+mutation keeps the
no-method-oracle structural.** **A money mutation derives its amount from trusted state and reads NOTHING from the
body (no `parseObjectBody`); the balance floor is the double-submit guard.** **A customer-facing projection of a
trusted record (billing summary/activity) is FINANCIAL-only + EXPLICIT-pick — it must not newly disclose
operator-tier state (lifecycle markers) the aggregate hid, and must drop internal ids structurally (no spread-rest).**
**A coupled validation/price/balance constant MUST be drift-guarded by a test** (Phase 32 activity↔summary
reconciliation; Phase 30 `summarize` vs canonical `balanceCents`; Phase 29 `REPLY_TEXT_MAX_LENGTH`; Phase 28
`channel`).
