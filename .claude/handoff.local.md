# Handoff

## Where things stand — Phase 20 (per-message money in the North Star) is COMPLETE ✅
`.claude/plans/2026-06-26-phase-20-messaging-money-north-star.md` is **complete — Step 0 design reviews + Steps
1–5 ticked**, on branch **`build/phase-3-generalize-search`** (the open review artifact for `main`; Phases 3–20
build on it; the loop's merge-keeper advances `main` when green). Working tree clean.
`npm run build && npm test && npm run lint` all green (**726 tests**, up from 695 at the start of this run).

This phase closed the **LAST unbuilt half of the guest-messaging channel's two human-set constraints**
([[guest-messaging-channel-is-a-roadmap-goal]], constraint 1's SCORING half): per-message cost is now a
**North-Star `money_cost` denominator term**, so the tier-1 `rsvp_reminder_cadence`/`reminder_spacing`/
`reminder_batching` knobs trade **real money**. ADR 0020, memory [[messaging-money-north-star]].

## What changed this phase — a 9th integrity effect kind + the money_cost term
- **`shared/src/domain/message_cost.ts`** — `MESSAGE_COST_CENTS` (per-`Channel`, tier-free, vendor-agnostic
  carrier cost; below every retail price). The firewall-clean inward cost basis (eval can't import product).
- **`eval-harness/src/simulator/domain_facts.ts`** — `honestMessagesSent = feltTouches(resolved?needed:delivered,
  batching)` (the actual digest sends; the SHARED fact, identical `>0` guard both stages). Stage A emits
  `guest.messaging.metered {guest_id, channel, message_count}`; Stage B records the trusted spend (its OWN
  `resolved`, never a claim).
- **`integrity_gate.ts`** — `detectMessagingSpendDivergences` (9th effect kind `messaging_spend`): keyed by
  guest_id; channel-validity guard BEFORE the cost table; field-diffs channel + message_count
  (`skipWhenClaimAbsent:false`); suppression via `allMessagingSpends()`; NO duplicate-as-forge arm (summed cost).
- **`telemetry`** `messaging_money_total_cents` metric (Σ count × cost; unknown channel → MAX cost) +
  **`metric_normalization.ts`** `money_cost = clamp01(budgetShare + messagingShare)` (SUM, not max) +
  **`scoring_constants.ts`** `worst_messaging_cents = 18`.
- Re-pinned the `metamorphic_oracle` 2-D matrix (ALL structural assertions unchanged) + anchor-floor guard;
  new `loop-orchestrator/tests/loop/messaging_money_forge_keystone.test.ts`.

## The load-bearing insights (carry forward) — see [[messaging-money-north-star]] for the full set
- **First North-Star term load-bearing via the TIER-1 search itself** (not tier-2): `feltTouches` IS the
  sends count, so cadence/spacing/batching move it directly. So it **DELIBERATELY enters the search corpus** —
  the opposite of Phases 7–10's keystone-only byte-identity.
- **Calibration breaks when the anchor is TOO SMALL, not too large** (counter-intuitive). The optimum (3,1,1) is
  resolution-driven and survives; only the metamorphic cube numerics re-pinned. Fragile cell (s=1,b=0) c0↔2,
  exact crossover ~5.17¢; `worst_messaging_cents=18` = 3.48× headroom; guard pins it ≥ 12.
- **Bill/score from OUR trusted count** — the trusted send count derives from Stage B's OWN `resolved`, so a
  joint resolution+count forge can't net a free win. money_cost is LOWER-better → the gate defends BOTH channel
  and count + suppression.
- **Tripwire:** a future channel-choosing genome knob makes `channel` genome-dependent and reopens the
  channel field-diff reasoning (today channel is an immutable per-guest scenario fact).

## Next action — your call. Pick the next high-value lever (ranked)
- **★ CONTINUE THE GUEST-MESSAGING CHANNEL — planner-facing guest-management CRUD + the first browser-form
  CSRF.** Today guests are seeded in compose (Phase 19); a planner needs an authenticated surface to
  register/list/remove guests. This folds naturally with the long-deferred **HTML create/update forms + CSRF**
  (the first planner *mutation* trust surface — the browser-form anti-forgery that Phase 19 deliberately
  distinguished from the webhook shared secret). Makes the channel operable by a real planner, not just seeded.
  **Both human-set channel constraints are now DONE** (no-lock-in + pricing/scoring), so the channel's remaining
  work is product-surface operability, not new safety machinery — a good, well-scoped rung.
- **★ A richer wedding-facts model** (ceremony time / venue / parking / dress code) so the Phase-19 responder
  answers real logistics, not just `event_date`. The `GuestQaResponder` seam + `projectGuestVisibleFacts` are
  built for it; this is where `'refused'` (surprise-classified facts) finally gets emitted. High demo value.
- **Unify `product/price_book.ts` onto the shared cost basis** (retail = COGS × margin over `MESSAGE_COST_CENTS`)
  — a clean follow-up this phase deliberately deferred; smaller, tidies the two-cents-tables seam.
- **Period-batched usage billing / `deliveryStatus` consumption** — smaller billing/observability rungs (ADR 0019
  "Deferred"). Lower priority.

## Standing rails (unchanged — do not weaken)
Offline-first (no real money/booking/comms; no prod/credentials — don't simulate them). **A real messaging
provider sending real texts is the human crossing (guest-comms tier-2 / exception #4) — build up to the line,
never across it or simulate having.** Don't modify `ops/` or `CLAUDE.md` (human-reserved). Push only to this
repo's `origin`. The named specialist sub-agents (doddy/wolf/testineer/rigorous-architect) are **not
provisioned** here — route adversarial reviews through `general-purpose` agents carrying the persona lens (this
run did, at design AND on the built code — all APPROVE, every must-fix applied). **CI/exit-code lesson:** never
pipe `npm run build` to tail/grep when gating with `&&` (the pipe masks the non-zero exit); run build standalone,
check `$?`. `npm run build` runs from REPO ROOT. **Eval-harness/telemetry import ONLY `@wedding-planner/shared`,
never `product`** (the firewall, by reachability). A new reconciled metric ⇒ mirror the trusted-reconciliation
pattern (shared fact + Stage A claim + Stage B trusted record + an integrity-gate detector).
