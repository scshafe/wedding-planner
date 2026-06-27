# ADR 0020 — Per-message money into the North Star: the comms strategy trades real money

- **Status:** accepted
- **Date:** 2026-06-26
- **Decider:** the building agent (an agent-owned engineering decision per
  [[agents-own-buildout-decisions]] and `.claude/plans/2026-06-26-phase-20-messaging-money-north-star.md`)
- **Scope:** Phase 20 — the **scoring half of the guest-messaging channel's pricing constraint**
  ([[guest-messaging-channel-is-a-roadmap-goal]], constraint 1). Phases 18–19 built the metered, margin-priced
  PRODUCT side (the meter bills the tenant per accepted send). This rung builds the **inward** side: per-message
  cost is now a **North-Star `money_cost` denominator term**, so the EXISTING tier-1 `rsvp_reminder_cadence` /
  `reminder_spacing` / `reminder_batching` knobs trade **real money**, not only guest attention. It closes the
  **last unbuilt half of the channel's two human-set constraints** (constraint 2, no-lock-in, was done; the
  product-pricing half of constraint 1 was done; only this scoring half remained).
- **Builds on** the trusted-reconciliation arc (ADRs 0006–0010: sentiment → qa → category → couple-cost →
  vision) — a **9th integrity effect kind** in the same firewall, **no parallel safety model**. Distinct from
  ADR 0018's product-side meter (retail price, tenant billing): this is the inward objective's cost basis.

## Context

The four self-improvement domains scored everything EXCEPT money the comms strategy spends: cadence/spacing/
batching traded resolution against guest *attention* (sentiment), but a message cost nothing in the objective.
The human-set pricing constraint requires that messaging be metered AND that per-message cost be a North-Star
denominator term so the AI's comms cadence trades real money. Phase 18 priced messaging for the product
(tenant billing); this rung prices it for the objective.

Three adversarial reviews (architect + doddy + wolf lenses, via `general-purpose` agents — the named
specialists are not provisioned) ran on the DESIGN and again on the BUILT code; all reached **APPROVE** (design:
APPROVE-WITH-CHANGES, every must-fix folded in; built: clean APPROVE). 726 tests green (was 695).

## Decisions

1. **The load-bearing connection is the tier-1 search itself — no tier-2 needed (the clean break from Phases
   7–10).** `feltTouches(remindersSent, batching)` (the digest operator already computed for sentiment) IS the
   actual-sends count. Cadence raises `delivered` → more sends; spacing caps reach via `spacingCapacity`;
   batching CONSOLIDATES digests → fewer sends (the batching money upside). So all three knobs the offline
   search already sweeps move the cost directly. Phases 7–10 were load-bearing ONLY via the tier-2
   `autonomy_threshold` (their effects were keystone-only, search corpus byte-identical); this is the FIRST
   North-Star term moved by tier-1, so it **deliberately ENTERS the search corpus** — the opposite of the
   byte-identity discipline, and exactly the point (the search must reflect message cost).

2. **The per-message cost basis lives in `@wedding-planner/shared`, VENDOR-AGNOSTIC.** `MESSAGE_COST_CENTS`
   (per-`Channel` integer cents, tier-free: email 1 / sms 2 / whatsapp 1 / phone 5 / postal 60) is the inward
   carrier-cost basis the eval/loop reads. The firewall forbids `eval → product`, so it CANNOT import
   `product/src/billing/price_book.ts`; and constraint 2 (no vendor lock-in) forbids depending on any one
   adapter's `costReport` — so it is the DOMAIN's modeled carrier cost, distinct from both the product retail
   table and the simulated adapter COGS, held STRICTLY BELOW every retail price (a `product`-side cross-table
   test pins `MESSAGE_PRICE_CENTS[channel][tier] > MESSAGE_COST_CENTS[channel]`, keeping the deferred
   price-book/shared unification safe). Swapping providers never moves the objective.

3. **A 9th integrity effect kind `messaging_spend` — the trusted-reconciliation pattern, the couple-cost
   (summed-cost) family.** Stage A emits a per-guest CLAIM `guest.messaging.metered { guest_id, channel,
   message_count }` iff `honestMessagesSent > 0`; Stage B records the trusted spend by its OWN computation iff
   `> 0` (the IDENTICAL shared-fact guard, so no honest-run divergence and no suppression blind spot). The
   metric `messaging_money_total_cents = Σ message_count × MESSAGE_COST_CENTS[channel]` feeds `money_cost`.
   `money_cost` is LOWER-better, so the incentive is to UNDER-report — the detector defends both the priced
   quantity (`message_count`) and the price basis (`channel`), each field-diffed `skipWhenClaimAbsent:false`,
   with a channel-validity guard BEFORE the cost table is indexed, and SUPPRESSION caught by enumerating
   `allMessagingSpends()` (the highest-yield attack on a summed cost). Like couple_cost, a duplicate ADDS cost
   (self-harm) → NO duplicate-as-forge arm. The trusted count derives from Stage B's OWN `resolved`, never the
   claim, so a joint resolution+count forge cannot net a free win (the rsvp gate catches the resolution lie,
   this catches the count lie).

4. **`money_cost` combines two additive money flows as a SUM of normalized shares.** `money_cost =
   clamp01(budgetOverspendShare + messagingShare)` — NOT `max` (a `max` makes them substitutes and would
   inert-ify the messaging gradient on any over-budget scenario). Null only when BOTH are absent (so a
   no-messaging corpus keeps `money_cost` null and byte-identical). On the search corpus `budget_variance` is
   null, so messaging is the SOLE money driver and `couple_cost` is 100% money there (effort_cost = 0).

5. **Calibrated to preserve the search landscape, not to chase a moved optimum.** `worst_messaging_cents = 18`
   (human-set anchor; the loop can never tune it). wolf's analysis: the cube optimum (3,1,1) is driven by a
   discrete resolution jump that dominates the marginal send cost, so the optimum LOCATION and ALL structural
   properties survive — only the metamorphic cube's numeric values re-pinned. The fragile cell is (spacing 1,
   batching 0) cadence 0↔2; below the **exact crossover ~5.17¢** the non-separability vector
   `argmaxCadenceAt(s=1,·)` flips `[2,3,1,1] → [2,3,0,0]`. 18 is **3.48× the floor** (8.7% ratio-shrink at the
   optimum — real but secondary); an anchor-floor guard test pins `worst_messaging_cents ≥ 12` and re-asserts
   the fragile cell so a future downward edit fails loudly. The corpus stays **email-only**; channel
   cost-variation is defended by the gate's channel field-diff, not the landscape (heterogeneous-channel corpus
   deferred).

## Consequences

- The offline search now trades real money: sending one more reminder costs the objective real cents, batching
  saves money, and the comms strategy weighs cost against the resolution it buys. The convergence keystone
  still ratchets to (3,1,1); published-champion / strategy-guidance tests are untouched (optimum preserved).
- The firewall is unweakened and extended: a shaved count, downgraded channel, or suppressed claim is a veto
  (proven by `messaging_money_forge_keystone.test.ts` — each `forgeWouldWinAbsentGate` + `onlyIntegrityFailed`
  + rejected). No new oracle, no veto-gate-input change (it backs a GRADER input, the denominator).
- **Tripwire (carry forward):** `channel` is a per-guest scenario fact (`preferred_channel`) read identically
  by both stages, so the channel field-diff never false-positives. A FUTURE messaging-strategy genome knob
  (channel choice) makes channel genome-dependent and reopens this reasoning.

## Deferred (recorded)

Unify `price_book` onto the shared cost basis; a messaging-strategy genome knob (channel/send-policy the search
optimizes against cost); a heterogeneous-channel keystone corpus; per-couple `worst_messaging_cents`; and the
SUM-combiner clamp behavior when a large-overspend budget scenario enters the SEARCH corpus (wolf — not a defect
today; the thing to watch). See the plan's "Recorded deferrals".

## Alternatives considered

- **`max` combiner for money_cost** — rejected (MF3): vendor overspend and messaging spend are additive
  dollars; `max` would kill the messaging gradient whenever a scenario also overspends budget.
- **Carry `cents` in the claim** instead of channel + count — rejected: it would let a claim assert a
  cheaper-than-table price; carrying channel + count keeps `MESSAGE_COST_CENTS` the single inward basis the
  metric (not the claim) owns, which is what makes the channel-validity guard load-bearing.
- **Keep messaging cost keystone-only** (preserve search-corpus byte-identity, like Phases 7–10) — rejected: the
  constraint requires the SEARCH knobs to trade money, so the term MUST enter the search corpus.
- **Calibrate to MOVE the optimum** — rejected: the resolution-driven optimum is correct; a money term large
  enough to overturn it would be mis-calibrated, not load-bearing.
