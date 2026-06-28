# Handoff

## Where things stand — Phase 31 (simulated balance payment) is COMPLETE ✅
`.claude/plans/2026-06-28-phase-31-simulated-balance-payment.md` is **complete — Step 0 design review + Steps 1–4
ticked**, on branch **`build/phase-31-simulated-balance-payment`** (off `build/phase-3-generalize-search`, the open
review artifact for `main`; the loop's merge-keeper advances `main` when green). Working tree clean.
`npm run build && npm test && npm run lint` all green (**914 tests**, up from 891 at the start of this run).

This rung makes the Phase-30 billing page **interactive**: the planner can now **pay down their owed balance** from
`?view=billing` — the FIRST mutation on the billing surface. A metered guest reply raises the balance (Phase 30);
the planner clicks **Pay** and the page shows `$0.00 owed`. Closes the meter→bill→customer→**pay** loop end-to-end,
demoable. Offline-first (no real money — recorded as the existing `payment` kind; no new schema, manifest stays 20).
doddy+architect design review APPROVE-WITH-FIXES (no exploit; P1-A/P1-B folded); a SECOND built-code review of the
committed money path APPROVE (no constructible exploit). ADR 0031, memory [[simulated-balance-payment]].

## What changed this phase
- **`BillingLedger.settleBalance(tenant_id): { paid, amount_cents, balance_cents }`** — reads `balanceCents`
  internally and records a `payment` for EXACTLY the owed amount when `> 0`, else no-ops. The amount is from the
  TRUSTED fold, never a caller input. Read+record is ONE synchronous critical section (the balance floor is the
  double-submit guard). Non-lifecycle ledger writer (follows `MessagingService.usage_charge`'s precedent).
- **`product_api.ts`** — `BillingHandlerDeps.ledger` widened to `Pick<…,'summarize'|'settleBalance'>`;
  `dispatchBilling` now: authorize FIRST (`authorizeBillingView`, couple→403 any method) → `GET` summary / `POST`
  settle (`{ paid }`, body NEVER read — no `parseObjectBody`) / else 405.
- **`guest_authorizer.ts`** — `authorizeBillingView` doc updated: it is the billing-ACCOUNT capability gating BOTH
  read and settle (name kept to avoid Phase-30 churn; separate pay authorizer deferred until a read-only billing
  role exists).
- **`product_web_ui.ts`** — `#billingPay` (CSRF-verify → forward empty-body `POST /t/:slug/billing` → PRG redirect),
  the 4-seg `/t/:slug/billing/pay` route (slug masked before cookie/CSRF read), and `#billingPage` now issues the
  per-session CSRF token. **`pages.ts`** — `renderBilling(theme, slug, summary, csrfToken)`: Pay form when
  `balance_cents > 0` (only the `_csrf` field, NO amount input), else a "Settled — nothing owed" note.
- **Tests** — `billing.test.ts` +6 (`settleBalance`: pays exact balance / no-op at 0 / unknown tenant / idempotent
  double / partitioned); `billing_api.test.ts` +10, −1 reworked (planner pays→0 / second {paid:false} / zero-balance
  / **body-smuggled amount_cents inert** / settles own tenant only / couple 403 byte-identical / 401 / 405 PUT&DELETE
  / cross-tenant / unmounted 404); `pages.test.ts` +2 (Pay form+CSRF when owed / settled note when not); `billing_web.test.ts`
  +5 (full meter→bill→customer→pay e2e / forged CSRF 403 no-mutation / no-balance no-op / couple no-form / forged-slug 404).
- `compose.ts` needed NO change (the `billing.ledger` is the full `BillingLedger`, so `settleBalance` is in scope
  through the widened `Pick`).

## The load-bearing insight (carry forward) — see [[simulated-balance-payment]] for the full set
- **A money mutation that must be un-gameable derives its amount from TRUSTED STATE, not the body** — and proves it
  by reading nothing from the body (no `parseObjectBody`); `settleBalance` takes only `tenant_id`. Balance is
  structurally ≥ 0, so no over/under-pay, no negative/credit.
- **The balance floor (`record only when > 0`) IS the double-submit guard** — repeat = `{paid:false}` no-op, no
  idempotency key; depends on the read+record staying ONE synchronous section (noted in the header).
- **ONE shared planner-only gate for read + settle makes the no-method-oracle STRUCTURAL** (the two verbs can't
  diverge into a couple-visible distinguisher); capability checked FIRST, before the method branch.
- **CSRF at exactly one layer; the JSON mutation route is Bearer-only / not CSRF-reachable** (the missing-Bearer
  401 stops a cross-site form). 4-seg web route ≠ 3-seg JSON route (no collision; JSON POST falls through).

## Next action — your call. Pick the next high-value lever (ranked)
- **Planner billing ACTIVITY LOG** — the smaller, natural follow-up: surface the tenant's own event history
  (provision / charge / payment / usage / **the new settlement payment**) as a themed list — the customer-facing
  analogue of the operator's raw `billingView.events`, scoped to `context.tenant_id`. Now that payments are
  planner-initiated, a "here's what you were charged and paid" ledger is the obvious transparency rung. Bounded;
  reuses `eventsFor` scoped to the minted context. **Recommended next.**
- **Multi-turn reply thread** — the still-open inbox extension: a per-escalation message log so an operator can send
  follow-ups after the first reply (and a guest reply lands in the thread), decoupling reply from auto-resolve.
  `escalation_resolution.reply_text` becomes the legacy "first reply". Medium-large; the guest-reply-into-thread
  piece needs conversation correlation the provider-agnostic port doesn't carry (a real design sub-problem).
- **A couple-REGISTER design rung** — resolve the deferred Phase-24 oracle (per-wedding `recipient_ref` namespacing
  OR masked-conflict semantics). The most-cited open product-authz deferral. Medium; needs a real design pass on the
  tenant-global-key collision.
- **Unify `product/price_book.ts` onto the shared cost basis** (retail = COGS × margin over `MESSAGE_COST_CENTS`) —
  the clean Phase-20 follow-up; tidies the two-cents-tables seam. Smaller.
- **Partial / arbitrary-amount payments** — the deferred extension of THIS phase: a planner pays a chosen amount
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
header — **Phases 30 & 31 added NO schema** (render-time projection / an existing `payment` kind), so the manifest
stays 20. **The guest responder's security boundary is `projectGuestVisibleFacts`'s allow-list.** **Web-form
mutations are CSRF-gated at the web layer ONLY** (the JSON API is Bearer-only / not CSRF-reachable). **The web UI's
ONLY data path is `api.handle()`.** **Guest/manage/billing scope comes from the MINTED principal/context, never the
request body.** **A capability the role lacks entirely (couple→register, couple→billing-account incl. pay) is a 403
checked FIRST, before the method/body branch — not a masked 404; ONE shared gate for read+mutation keeps the
no-method-oracle structural.** **A money mutation derives its amount from trusted state and reads NOTHING from the
body (no `parseObjectBody`); the balance floor is the double-submit guard.** **A coupled validation/price/balance
constant MUST be drift-guarded by a test** (Phase 30 `summarize` vs canonical `balanceCents`; Phase 29
`REPLY_TEXT_MAX_LENGTH`; Phase 28 `channel`).
