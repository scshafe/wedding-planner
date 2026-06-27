---
name: messaging-money-north-star
description: Phase 20 — per-message money is now a North-Star money_cost denominator term (a 9th integrity effect kind), so the tier-1 cadence/spacing/batching knobs trade real money; the FIRST North-Star term load-bearing via the tier-1 search itself (not tier-2), deliberately entering the search corpus
metadata:
  type: project
---

**Phase 20 closed the LAST unbuilt half of the guest-messaging channel's two human-set constraints**
([[guest-messaging-channel-is-a-roadmap-goal]], constraint 1's SCORING half). Phases 18–19 priced messaging
for the PRODUCT (the meter bills the tenant per send); this rung prices it for the INWARD objective:
per-message cost is now a North-Star `money_cost` denominator term, so the EXISTING tier-1 knobs
(`rsvp_reminder_cadence` / `reminder_spacing` / `reminder_batching`) trade REAL money. ADR 0020. 726 tests
(was 695). architect + doddy + wolf APPROVE on design AND built code.

**The load-bearing insight — and the clean break from Phases 7–10.** Unlike sentiment/qa/category/couple-cost/
vision (load-bearing ONLY via the tier-2 `autonomy_threshold`, so their effects were keystone-only and the
search corpus stayed byte-identical), messaging cost is moved DIRECTLY by the tier-1 search knobs:
`feltTouches(remindersSent, batching)` (the digest operator already computed for sentiment) IS the actual-sends
count. Cadence raises `delivered` → more sends; spacing caps reach via `spacingCapacity`; batching CONSOLIDATES
digests → FEWER sends (the batching money upside). So this is the FIRST North-Star term load-bearing via the
tier-1 search itself, and it **DELIBERATELY ENTERS the search corpus** — the opposite of the byte-identity
discipline, and exactly the point (the search must reflect message cost).

**The shape (mirrors the trusted-reconciliation pattern, the couple-cost SUMMED-cost family):**
- **Cost basis in `shared`, vendor-agnostic:** `shared/src/domain/message_cost.ts` `MESSAGE_COST_CENTS`
  (per-`Channel`, tier-free: email 1 / sms 2 / whatsapp 1 / phone 5 / postal 60). The firewall forbids
  `eval → product`, so it CANNOT import `price_book.ts`; constraint 2 (no lock-in) forbids depending on any
  adapter's `costReport`. So it is the DOMAIN's modeled carrier cost — held STRICTLY BELOW every retail price
  (a `product`-side cross-table test pins `MESSAGE_PRICE_CENTS[ch][tier] > MESSAGE_COST_CENTS[ch]`, SF7).
- **9th integrity effect kind `messaging_spend`:** shared fact `honestMessagesSent(needed, delivered, resolved,
  batching) = feltTouches(resolved?needed:delivered, batching)`; Stage A emits `guest.messaging.metered
  {guest_id, channel, message_count}` iff `>0`; Stage B records the trusted spend by its OWN computation iff
  `>0` (the IDENTICAL guard, doddy P0-1). Metric `messaging_money_total_cents = Σ count × cost(channel)` feeds
  `money_cost`.
- **money_cost is LOWER-better** (a denominator term) → the incentive is to UNDER-report. The detector defends
  the QUANTITY (`message_count`) AND the PRICE BASIS (`channel`), each field-diff `skipWhenClaimAbsent:false`,
  with a **channel-validity guard BEFORE the cost table is indexed** (MF4/P1-1) and SUPPRESSION via
  `allMessagingSpends()` enumeration (the highest-yield attack on a summed cost). Like couple-cost, a duplicate
  ADDS cost (self-harm) → **NO duplicate-as-forge arm**. The metric independently charges the MAX channel cost
  for an unknown channel (never silently 0).

**The load-bearing crux (carry forward):**
- **The trusted count derives from Stage B's OWN `resolved`, NEVER the claim** (doddy P0-2). A resolved
  multi-reminder guest sends FEWER messages (`needed`) than an unresolved one (`delivered`), so a joint
  resolution+count forge (claim resolved + shave count to match) is still caught: the rsvp gate catches the
  resolution lie, the messaging gate catches the count lie.
- **The emission/record guard `honestMessagesSent(...) > 0` is the IDENTICAL shared-fact expression on both
  stages** — a zero-send guest (immediate responder; or spacing-3 `delivered===0`) emits no claim AND records
  no trusted spend, so no suppression false-positive and no forge blind spot.

**money_cost combiner = SUM, not max** (architect MF3): `money_cost = clamp01(budgetOverspendShare +
messagingShare)` — vendor overspend and messaging spend are ADDITIVE dollars; `max` would inert-ify the
messaging gradient on any over-budget scenario. Null only when BOTH absent (byte-identity on no-money corpora).
On the search corpus budget_variance is null, so messaging is the SOLE money driver (couple_cost = 100% money,
effort=0). **Deferred watch (wolf):** when a large-overspend budget scenario enters the SEARCH corpus,
`clamp01` saturates at 1.0 and flattens the messaging gradient on that scenario — not a defect today.

**Calibration — the term breaks structure when TOO SMALL, not too large (the counter-intuitive bit):**
`worst_messaging_cents = 18` (human-set anchor; loop can never tune it — in `scoring_constants.ts`). The cube
optimum (3,1,1) is driven by a discrete resolution jump that dominates the marginal send cost, so the optimum
LOCATION and ALL structural properties survive any sane calibration — **only the metamorphic cube's numeric
values re-pinned**. The fragile cell is (spacing 1, batching 0) cadence 0↔2; below the **exact crossover
~5.17¢** (at the 1¢ email basis) the non-separability vector `argmaxCadenceAt(s=1,·)` flips `[2,3,1,1] →
[2,3,0,0]`. 18 = **3.48× the floor** (8.7% optimum ratio-shrink — real but secondary); the anchor-floor guard
pins `worst_messaging_cents ≥ 12` and re-asserts the fragile cell. Corpus stays **email-only**; channel
cost-variation is defended by the gate's channel field-diff, NOT the landscape.

**Tripwire:** `channel` is a per-guest scenario fact (`preferred_channel`) read identically by both stages, so
the channel field-diff never false-positives. A FUTURE messaging-strategy genome knob (channel choice) makes
channel genome-dependent and reopens this reasoning.

**Where the blast radius landed (smaller than first feared):** only the `metamorphic_oracle` 2-D matrix
re-pinned (the ANCHORED metric oracles — exact `rsvp_resolution_rate`/`guest_sentiment_score` — are UNTOUCHED
because money is a North-Star INPUT, not those metrics); `published_champion` + strategy-guidance/web/api tests
untouched (optimum preserved); the convergence keystone still reaches (3,1,1). Keystone:
`loop-orchestrator/tests/loop/messaging_money_forge_keystone.test.ts` (mirrors `couple_cost_forge_keystone`).

Related: [[guest-messaging-port-and-meter]] (Phase 18 product meter), [[guest-messaging-inbound-edge]] (Phase
19), [[couple-attention-cost-generalization]] (the summed-cost reconciliation template),
[[third-tier1-knob-batching-3d-search]] (the knobs that now trade money), [[north-star-objective]].
