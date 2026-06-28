# Handoff

## Where things stand — Phase 30 (planner billing & usage view) is COMPLETE ✅
`.claude/plans/2026-06-28-phase-30-planner-billing-usage-view.md` is **complete — Step 0 design review + Steps
1–4 ticked**, on branch **`build/phase-3-generalize-search`** (the open review artifact for `main`; Phases 3–30
build on it; the loop's merge-keeper advances `main` when green). Working tree clean.
`npm run build && npm test && npm run lint` all green (**891 tests**, up from 867 at the start of this run).

This rung surfaces the **first-class, human-set pricing factor** to the **customer**: the tenant's planner can now
see their OWN account (plan + monthly price, message usage count + spend, subscription/payments, owed balance) via
JSON `GET /t/:slug/billing` + a themed `?view=billing` page. Until now billing was **operator-only**
(`/admin/.../billing`); the person paying could never see the metered-pricing reality. It closes the
meter→bill→**customer** loop (a metered guest reply now raises the customer-visible usage + balance, demoable
end-to-end). doddy+architect design review APPROVE-WITH-FIXES (no exploit); all fixes folded. ADR 0030, memory
[[planner-billing-view]].

## What changed this phase
- **`BillingLedger.summarize(tenant_id): LedgerSummary`** — a per-kind fold of the tenant's own events
  (messages_sent / messaging_spend / subscription / payments / balance), in LOCKSTEP with the canonical
  `balanceCents` + `FINANCIAL_KINDS`. New **`billing_summary.ts`**: `BillingSummary` + pure
  `buildBillingSummary(plan_tier, ledger)` layering `monthlyPriceCents` onto the fold (render-time projection, **no
  schema** — manifest stays 20). Both exported from the barrel.
- **`GuestAuthorizer.authorizeBillingView(principal): AccessDecision`** — planner `allow` / couple `forbidden`
  (RETURNS a decision, never throws). Homed on the management-capability authorizer (not WeddingAuthorizer).
- **`product_api.ts`** — `BillingHandlerDeps { ledger: Pick<…,'summarize'>; tenants: Pick<…,'findById'>;
  authorizer }`, OPTIONAL `billing?` on `ProductApiDeps`, `#billing` field, the `GET /t/:slug/billing` route, and
  `dispatchBilling` (authorize-FIRST 403 → method GET-only 405 → trusted `findById(context.tenant_id)` → build).
- **`compose.ts`** — wires `billing: { ledger: billing, tenants, authorizer: guestAuthorizer }` (always).
- **`pages.ts`** — `renderBilling` (plan/price/usage/balance + a reconciliation note, dollars via `dollars()`,
  all through the `html` template); console nav links to `?view=billing`. **`product_web_ui.ts`** — `#billingPage`
  (delegates the JSON read, themes by status, mirrors `#strategy`) + `readBilling` + the `?view=billing` route.
- **Tests** — `billing.test.ts` +6 (summarize fold / drift guard / partition / buildBillingSummary / key-set);
  `billing_api.test.ts` NEW +9 (planner 200 / tenant-scoped / couple 403 any method / smuggled-tenant_id inert /
  401 any method / 405 / masked 404 / cross-tenant 401 / unmounted 404); `pages.test.ts` +3 (renderBilling values
  + dollars + XSS); `billing_web.test.ts` NEW +6 (console link / zero-balance / meter→bill→customer e2e / couple
  403 Forbidden / unauth login / unknown-tenant 404); `compose.test.ts` +1 (billing IS wired — the F4 net).

## The load-bearing insight (carry forward) — see [[planner-billing-view]] for the full set
- **A render-time projection, NOT a contract** — manifest stays 20 (like `StrategyGuidance`).
- **ONE price source** (`monthlyPriceCents`, the billed fn) + **ONE balance definition** (drift test pins
  `subscription+messaging−payments === balanceCents`, the untouched canonical fold). `messaging_spend` = Σ
  usage_charge straight from the ledger.
- **Planner-only = a 403 CAPABILITY denial, not a masked 404** (billing is the tenant account, not a per-wedding
  resource); the authorizer RETURNS, the check is FIRST (before the method branch → no method oracle).
- **No new oracle:** folded from the caller's OWN ledger keyed by the minted `context.tenant_id` (smuggled
  tenant_id inert); auth before authorize/method. Exposes only tenant-side figures (no COGS/price-table/margin).
- **OPTIONAL `billing?`** (matches the subresource convention; the compose e2e is the "is-it-wired" safety net).

## Next action — your call. Pick the next high-value lever (ranked)
- **Simulated payment from the tenant surface** — the natural extension of THIS phase: let a planner "pay" the
  owed balance (records a `payment`, balance → settled), so the billing page becomes interactive not just
  read-only. A MUTATION → needs its own no-oracle pass (CSRF-gated web form, planner-only, idempotency, the
  amount from the trusted balance not the body). Medium; the most product-complete billing follow-up.
- **Multi-turn reply thread** — the still-open inbox extension: a per-escalation message log so an operator can
  send follow-ups after the first reply (and a guest reply lands in the thread), decoupling reply from
  auto-resolve. `escalation_resolution.reply_text` becomes the legacy "first reply". Medium-large; the biggest
  product step for the inbox, but the guest-reply-into-thread piece needs conversation correlation the
  provider-agnostic port doesn't carry (a real design sub-problem).
- **A planner billing ACTIVITY LOG** — the smaller follow-up to this phase: surface the tenant's own event
  history (provision/charge/payment/usage) as a themed list, the customer-facing analogue of the operator's raw
  `billingView.events`. Bounded; reuses `eventsFor` scoped to `context.tenant_id`.
- **A couple-REGISTER design rung** — resolve the deferred Phase-24 oracle (per-wedding `recipient_ref`
  namespacing OR masked-conflict semantics). The most-cited open product-authz deferral. Medium; needs a real
  design pass on the tenant-global-key collision.
- **Unify `product/price_book.ts` onto the shared cost basis** (retail = COGS × margin over `MESSAGE_COST_CENTS`)
  — the clean Phase-20 follow-up; tidies the two-cents-tables seam. Smaller.
- **Return-to-the-engine threads** — the self-improvement loop (advisory tier-2 recs, live publish pipeline) has
  open deferrals if you want to swing back from the product surface.

## Standing rails (unchanged — do not weaken)
Offline-first (no real money/booking/comms; no prod/credentials — don't simulate them). **A real messaging
provider sending real texts is the human crossing (guest-comms tier-2 / exception #4) — build up to the line,
never across it or simulate having.** Don't modify `ops/` or `CLAUDE.md` (human-reserved). Push only to this
repo's `origin`. The named specialist sub-agents (doddy/wolf/testineer/rigorous-architect) are **not provisioned**
here — route adversarial reviews through `general-purpose` agents carrying the persona lens (this run did, at
design — APPROVE-WITH-FIXES, no exploit). **CI/exit-code lesson:** never pipe `npm run build`/`npm run lint` to
tail/grep when gating with `&&` — the pipe masks the non-zero exit (and `$?` after a pipe is the LAST stage's, so
use `${PIPESTATUS[0]}`); run them standalone and check the exit. `npm run build` runs from REPO ROOT. **Eval-
harness/telemetry import ONLY `@wedding-planner/shared`, never `product`** (the firewall, by reachability).
**Schema change ⇒ `npm run gen:types`**; a NEW schema file additionally bumps the manifest count test (+ title
prose) + the gen-script header — **Phase 30 added NO schema** (a render-time projection), so the manifest stays
20. **The guest responder's security boundary is `projectGuestVisibleFacts`'s allow-list.** **Web-form mutations
are CSRF-gated at the web layer ONLY** (the JSON API is Bearer-only / not CSRF-reachable). **The web UI's ONLY
data path is `api.handle()`** (reader helpers parse the JSON body; no direct store dep). **Guest/manage/billing
scope comes from the MINTED principal/context, never the request body.** **A scoped mutation that must be
oracle-free returns ONE shared frozen miss constant on every miss branch.** **A capability the role lacks entirely
(couple→register, couple→billing) is a 403 checked FIRST, before the method/body branch — not a masked 404.** **A
coupled validation/price/balance constant MUST be drift-guarded by a test** (Phase 30 `summarize` vs canonical
`balanceCents`; Phase 29 `REPLY_TEXT_MAX_LENGTH`; Phase 28 `channel`). **A render-time projection needs NO schema
(manifest unchanged)** — `BillingSummary`/`StrategyGuidance`.
