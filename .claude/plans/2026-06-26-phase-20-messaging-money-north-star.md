# Phase 20 — Per-message money into the North Star: the comms strategy trades real money

**Status:** Step 0 (design review) COMPLETE — architect + doddy + wolf all APPROVE-WITH-CHANGES; must-fixes folded below. Step 1 next.
**Branch:** `build/phase-3-generalize-search` (the open review artifact for `main`; Phases 3–19 build on it; this continues it)
**Predecessor:** Phase 19 (the guest inbound HTTP edge) — complete, 695 tests green.

## Goal

Close the **last unbuilt half of the guest-messaging channel's two human-set constraints**
([[guest-messaging-channel-is-a-roadmap-goal]], constraint 1's *scoring* half). Phases 18–19 built the
metered, margin-priced **product** side (the meter bills the tenant per accepted send). This rung builds the
**inward** side: make **per-message cost a North-Star denominator term** so the AI's comms strategy — the
EXISTING tier-1 `rsvp_reminder_cadence` / `reminder_spacing` / `reminder_batching` knobs — trades **real
money**, not only guest attention. After this, sending one more reminder costs the objective real cents, and
the offline search weighs that against the resolution it buys.

This mirrors the **trusted-reconciliation pattern of Phases 6–10** (sentiment → qa → category → couple-cost →
vision): a SHARED honest fact both simulator stages compute, a CLAIM Stage A emits, an independent TRUSTED
record Stage B authors, and an **integrity-gate reconciliation** (a **9th effect kind**) that vetoes a forge.

### Why this is the cleanest load-bearing rung in the project (and how it differs from 6–10)

- **It is load-bearing via the tier-1 search itself — no tier-2 needed.** Phases 7–10 were load-bearing ONLY
  through the tier-2 `autonomy_threshold` (their effects were keystone-only, so the search corpus stayed
  byte-identical). Here the cost is moved by the **tier-1 knobs the search already sweeps**:
  `feltTouches(remindersSent, batching)` is ALREADY the actual-sends count (the digest operator, `domain_facts.ts`).
  Higher **cadence** → more `delivered` → more sends; **spacing** caps reach (`spacingCapacity`) → fewer sends;
  **batching** consolidates digests → fewer sends. So all three knobs trade money directly.
- **It DELIBERATELY enters the search corpus** (the opposite of 6–10's byte-identity discipline) — that is the
  whole point: the search landscape must reflect message cost. This is the load-bearing difference and the main
  risk (below).

## The hard rails (unchanged — CLAUDE.md)

Offline-first, integer cents, no real money/comms. **The eval/loop core imports ONLY `@wedding-planner/shared`,
never `product`** (the trusted-evidence firewall, preserved by REACHABILITY — the graph stays acyclic). So the
inward per-message cost basis must live in **`shared`**, NOT be imported from `product/src/billing/price_book.ts`.
Injected clock/ids. One safety model (REUSE the integrity gate; never a parallel one). The loop may NEVER
auto-tune scoring weights/anchors (`scoring_constants.ts` is human-set defaults). Don't modify `ops/` or
`CLAUDE.md`. Push only to `origin`. **Schema change ⇒ `npm run gen:types`** + bump any manifest count/tests.
The named specialists (doddy/wolf/testineer/architect) are **not provisioned** — route adversarial reviews
through `general-purpose` agents carrying the persona lens. **Never pipe `npm run build` when gating with `&&`.**

## The design (ratified calls — confirm in Step 0)

### The cost basis lives in `shared` (the firewall)
- New **`shared/src/domain/message_cost.ts`** — `MESSAGE_COST_CENTS: Readonly<Record<Channel, number>>`
  (integer cents, channel-keyed, tier-free) + `messageCostCents(channel)`. This is the modeled marginal money
  one outbound message costs — the SAME family of fictional cents the product price book bills, but the
  **single inward cost basis** the eval simulator reads. Document the conceptual link to
  `product/src/billing/price_book.ts` (which stays its own tier×channel RETAIL table; **unifying the two onto
  this shared COGS basis is a recorded follow-up, not this phase** — keeps the firewall reasoning clean and the
  scope tight). Drift-guard test: exhaustive over `CHANNELS` (mirror `shared/tests/domain/channel.test.ts`).
- Calibration target (Step 3, wolf-verified): a **real but secondary** term — visible gradient pressure toward
  fewer messages, but NOT large enough to overturn the resolution-driven cube optimum (3,1,1) or its structural
  properties. Per-channel cents in the product price book's ballpark (email 3, sms 6, whatsapp 4, phone 15,
  postal 95) are the natural seed.

### The shared honest fact + the claim + the trusted record (mirrors Phases 6–10)
- **`domain_facts.ts`** — add `honestMessagesSent(needed, delivered, resolved, batching)` =
  `feltTouches(resolved ? needed : delivered, batching)` (the actual digest sends). SHARED, so both stages
  compute bit-identical counts. (Reuses the existing `feltTouches`; `remindersSent` is the same expression
  Stage A/B already compute for sentiment.)
- **Stage A** (`stage_a_planner.ts`) — per guest, after the reminder loop, if `honestMessagesSent > 0`, emit a
  CLAIM `guest.messaging.metered { guest_id, channel, message_count }` (channel = `guest.contact.preferred_channel`).
  Emit iff count > 0 (so a zero-send immediate responder emits nothing — the byte-identity guard, like vision's
  emission guard).
- **Stage B** (`stage_b_observer.ts`) — re-derive the IDENTICAL count by its OWN computation and
  `recorder.recordMessagingSpend({ guest_id, channel, message_count })` iff count > 0. Never reads Stage A.

### The 9th integrity effect kind — `messaging_spend`
- **`trusted_outcomes.ts` / `trusted_recorder.ts`** — `TrustedMessagingSpendRecord { guest_id, channel,
  message_count }` + `recordMessagingSpend` / `messagingSpend(guest_id)` / `allMessagingSpends()`, append-only
  per guest_id (dup → throw), `deepFreeze`.
- **`report_event_names.ts`** — `MESSAGING_METERED_REPORT_EVENT_NAMES = new Set([EVENT_NAMES.guest_messaging_metered])`.
- **`integrity_gate.ts`** — add `'messaging_spend'` to the `effect_kind` union; a `detectMessagingSpendDivergences`
  detector (mirror `detectVisionAlignmentDivergences`): per claim keyed by `guest_id`, **field-diff BOTH
  `channel` AND `message_count`** (channel defends the price basis — a forge that claims a cheaper channel than
  the guest's real one is caught; message_count defends the quantity — a shaved send count is caught), plus a
  duplicate-claim check and a suppression check (a dropped claim lowers the summed cost). Wire into
  `detectSelfReportDivergence`.
- **The forge it closes:** a candidate that sends the reminders honestly (keeps its resolution/sentiment) but
  **UNDER-REPORTS the send count** (or downgrades the channel) → lower `messaging_money_total_cents` → lower
  `money_cost` → higher ratio absent the gate; vetoed with it. This is a genuinely NEW forge surface — the
  existing `rsvp_resolution` reconciliation defends resolutions, never the send count.

### The metric + the scoring wiring
- **`telemetry`** — a new event `guest.messaging.metered` (event constant + `event_payloads` payload type/schema
  + catalog) and a metric `messaging_money_total_cents` = `Σ message_count × MESSAGE_COST_CENTS[channel]` over the
  claims. `lower_better` in `GUARD_DIRECTIONS`. (The metric imports the shared cost basis — telemetry → shared is
  allowed.)
- **`metric_normalization.ts` / `scoring_constants.ts`** — add `worst_messaging_cents = 50` to
  `NORMALIZATION_ANCHORS` (human-set; hard floor 18); fold the messaging term into `money_cost` ALONGSIDE
  `budget_variance_pct` as a **SUM of normalized shares**: `money_cost = clamp01(budgetOverspendShare +
  messagingShare)` (each share already in [0,1]; the two are additive money outflows, MF3). Net effect:
  `money_cost` becomes **non-null on the search corpus for the first time** (and is the SOLE money driver there —
  budget_variance is null on the keystone corpus, so couple_cost is 100% money).

## The main risk — the search landscape shifts (and how this plan contains it)

Adding `money_cost` to the search corpus changes every aggregate North-Star value the `metamorphic_oracle`
cube/matrix pins. The analysis (confirmed by hand): on the keystone corpus `couple_cost` is today driven by
`effort_cost = 0` alone, so the pinned matrix values ARE `planning_value`; the money term shrinks each ratio by
`1/(1 + 0.4286·M)` with `M` the genome's normalized messaging cost. The cube optimum (3,1,1) is driven by a
**discrete resolution jump** (cadence 3 resolves the multi-nudge guest at batching 1; +0.25 resolution_rate)
that dominates the marginal ~3¢ send difference — so the **optimum LOCATION and structure are preserved** for
any sane calibration. Containment:
- **Calibrate to preserve structure** (Step 3) — the surviving STRUCTURAL assertions in `metamorphic_oracle`
  (unique interior optimum, margin > 0.01, non-separability `[2,3,1,1]`, b=0 byte-identity-to-2-D) are the real
  oracle; if any breaks, the calibration is too aggressive → raise `worst_messaging_cents`. wolf verifies the
  new landscape is non-degenerate and the structure is genuine, not tuned-to-pass.
- **Re-pin ONLY the numeric `EXPECTED` matrix/cube** (drift pins), recomputed from the implementation.
- **Untouched** (verified, not assumed): the ANCHORED metric oracles (exact `rsvp_resolution_rate` /
  `guest_sentiment_score` — money is a North-Star input, not those metrics); `published_champion.test.ts` and the
  strategy guidance/web/api tests (optimum unchanged); the convergence keystone still ratchets to (3,1,1).

## The steps (each ends GREEN: `npm run build && npm test && npm run lint`; commit per step)

- [x] **Step 0 — Design review (architect + doddy + wolf lenses, on THIS plan).** All three APPROVE-WITH-CHANGES.
  Ratified calls + must-fixes (folded into the steps below):

  **NOTE — calibration rescaled at Step 1.** wolf calibrated against email = 3¢, but the shared cost basis is
  the vendor-agnostic carrier COGS (email = **1¢**, held below the 2¢ retail floor — SF7), so every cents figure
  and the anchor scale by ~⅓: **`worst_messaging_cents ≈ 18`** (floor ≈ 6), pinned exactly against the recomputed
  cube in Step 3. wolf's STRUCTURE conclusions are scale-invariant (`worst ≈ 3× corpus-max cents`; corpus-max is
  now ~6¢, was ~18¢). The fragile cell, the non-sep vector, and the ~9% optimum-shrink all carry over unchanged.

  **wolf (calibration — the load-bearing numbers, AT email = 3¢; rescale ÷3 for the 1¢ basis):**
  - **`worst_messaging_cents = 50`** (→ ~18 at 1¢). HARD FLOOR is **18** (→ ~6 at 1¢; crossover ≈ 17.2¢ → ~5.7¢):
    below it the non-separability
    vector `argmaxCadenceAt(s=1, b=*)` flips from `[2,3,1,1]` to `[2,3,0,0]` and the oracle breaks. 50 gives a
    ~9% ratio-shrink at the optimum (a real secondary gradient), keeps the optimum margin `0.0118 > 0.01`, and is
    "~3× corpus-max cents (18)". So the term breaks structure when TOO SMALL, not too large — the opposite of the
    plan's first instinct; calibrate UP to ≥18, not down.
  - **The fragile cell is (spacing 1, batching 0), cadence 0↔2.** All 16 (s,b) columns are flip-free at 50; only
    this one is near a tie. Keep the `[2,3,1,1]` non-sep vector **HARD-pinned** (never re-derived) and add an
    explicit **anchor-floor guard** (a test/comment pinning that the anchor must stay ≥ 18).
  - **Corpus stays email-only (3¢).** Channel cost-variation is defended by the gate's channel field-diff (the
    forge surface), NOT by the landscape this phase. Heterogeneous-channel corpus is a recorded deferral.
  - **couple_cost is 100% money on this corpus** (effort_cost = 0, stress null), so messaging is the SOLE money
    driver and the ratio-shrink % is undiluted — a reviewer must not assume effort dilutes it.
  - **Step-4 keystone monotonicity:** "messaging_money strictly rises with cadence" is **FALSE at the (s=1,b=1)
    optimum** (cents column `[0,9,9,12]` — the digest absorbs a send). Use the **(s=1,b=0)** cell `[0,9,15,18]`
    for strict monotonicity, PLUS an **equal-planning_value / lower-cost-scores-strictly-higher** relation (the
    knife-edge-free proof the term is load-bearing).

  **doddy (forge surface):**
  - **P0-1 suppression:** Stage B records for EVERY guest with `honestMessagesSent > 0`; the detector enumerates
    `recorder.allMessagingSpends()` and flags any trusted record with no claim as `suppressed_effect`. The
    emission predicate MUST be the **identical** `honestMessagesSent(...) > 0` shared-fact expression on BOTH
    stages (never an inlined `remindersSent>0` on one side). Test: a `delivered===0` guest (spacing 3 → capacity 0)
    emits/records nothing on both sides, no divergence.
  - **P0-2 joint forge:** the trusted `message_count` derives from **Stage B's OWN `guestReach.resolved`**, NEVER
    the claimed resolution or claimed count. Test: forge resolution=true on a multi-reminder guest + shave the
    count to match → still vetoed (rsvp forged_effect and/or messaging field_mismatch fires).
  - **P1-1:** both field-diffs (`channel`, `message_count`) use `skipWhenClaimAbsent: false`; the **metric** must
    not reward an unknown channel (assert membership / treat as max cost), defense-in-depth beyond the gate.
  - **P1-2:** messaging is the **couple_session SUMMED-cost family** → a duplicate ADDS cost (self-harm), so
    **NO duplicate-as-forge arm is needed**; if a one-claim-per-guest guard is kept, document it as hygiene, NOT
    cost-defense — do NOT copy the sentiment "re-weighting" rationale. (Recorder is append-only-per-guest_id anyway.)
  - **P1-3:** a claim for a 0-send guest → `forged_effect` (Stage B has no record); add the test (validates the
    forged arm).
  - **P1-4:** `worst_messaging_cents` lives in `scoring_constants.ts` (human-set `NORMALIZATION_ANCHORS`); the
    loop can never tune it (inherits the existing rail).
  - **P2:** channel is read directly from `guest.contact.preferred_channel` on BOTH stages (no genome/claim
    derivation) — note as a tripwire that a future channel-choosing knob makes channel genome-dependent and
    reopens this reasoning. Verify no existing event-COUNT/name-set assertion silently absorbs the new event.

  **architect:**
  - **MF1:** record the worst-case optimum-margin erosion numerically (wolf: `0.0118 > 0.01` at anchor 50) as a
    comment in `metamorphic_oracle.test.ts`, not just prose.
  - **MF2:** Step 3 must explicitly re-verify the **2-D** non-sep pins `argmaxCadence(m,1)===2` and
    `argmaxCadence(m,2)<2` survive (the money term pushes toward lower cadence — the opposite-direction risk).
  - **MF3 (combiner — COMMITTED):** `money_cost = clamp01(budgetOverspendShare + messagingShare)` — a **SUM** of
    the two normalized [0,1] shares, then clamp (vendor overspend and messaging spend are ADDITIVE dollars; `max`
    would make them substitutes and kill the messaging gradient on any budget-overspending scenario). Add a guard
    test at the `deriveNorthStarInputs` level pinning behavior when BOTH are present (synthetic — no corpus
    scenario has both today).
  - **MF4:** an absent / non-`CHANNELS` `channel` on a claim is a `forged_effect`, checked BEFORE the trusted
    lookup and BEFORE the metric indexes the cost table.
  - **SF6:** the claim carries `channel + message_count` (NOT cents) so `MESSAGE_COST_CENTS` remains the single
    inward basis a claim can't forge a cheaper-than-table price around — add the one-sentence rationale.
  - **SF7:** add a **cross-table consistency test NOW** (in `product` tests, which may import both):
    `MESSAGE_PRICE_CENTS[channel][tier] > MESSAGE_COST_CENTS[channel]` for every channel/tier — makes the
    deferred price_book/shared unification safe (the margin invariant can't silently invert).

- [x] **Step 1 — The shared per-message cost basis.** (DONE — 700 tests green. `shared/src/domain/message_cost.ts`
  = vendor-agnostic carrier COGS {email:1,sms:2,whatsapp:1,phone:5,postal:60}, all strictly below retail;
  drift-guard + SF7 cross-table margin test added.) `shared/src/domain/message_cost.ts`
  (`MESSAGE_COST_CENTS` = {email:1, sms:2, whatsapp:1, phone:5, postal:60} — the vendor-agnostic carrier COGS,
  strictly below every retail price;
  `messageCostCents(channel)` total over `CHANNELS`, throws on a stale cast) + barrel export + drift-guard test
  (exhaustive over `CHANNELS`). **Plus the SF7 cross-table consistency test in `product` tests**:
  `MESSAGE_PRICE_CENTS[channel][tier] > MESSAGE_COST_CENTS[channel]` for every channel × tier (product may import
  both; this keeps the deferred unification safe). No other behavior change. GREEN.

- [x] **Step 2 — The 9th effect kind: claim + trusted record + integrity reconciliation (NO scoring yet).**
  (DONE — 712 tests green. `guest.messaging.metered` event constant; `honestMessagesSent` shared fact (identical
  guard both stages); Stage A emit + Stage B record (iff count>0); `TrustedMessagingSpendRecord` + recorder;
  `MESSAGING_METERED_REPORT_EVENT_NAMES`; `detectMessagingSpendDivergences` (channel-validity guard, both fields
  `skipWhenClaimAbsent:false`, suppression enumeration, no duplicate arm) wired in. North Star UNCHANGED — the
  metamorphic cube stays byte-identical. integrity_messaging.test.ts: every arm + an honest-run sweep over the
  whole cube (incl. zero-send + spacing-3 delivered-0 guests) + the joint resolution+count forge.)
  The `guest.messaging.metered` event — **EVENT_NAME constant ONLY** (no schema $def / no `gen:types` / no
  manifest bump: the envelope `event_name` is pattern-constrained not enum'd, and reconciled events
  sentiment/category/vision likewise read payloads dynamically with no $def — this mirrors them exactly);
  `honestMessagesSent` shared fact; Stage A emit; Stage B record; `trusted_outcomes` /
  `trusted_recorder`; `report_event_names`; `integrity_gate` detector + union member + wiring. Tests
  (`integrity_messaging.test.ts`): honest run → no divergence; forged (claim with no trusted record);
  field_mismatch on `message_count`; field_mismatch on `channel`; suppressed (trusted, no claim); duplicate.
  **North Star is UNCHANGED this step** (no messaging metric feeds `deriveNorthStarInputs` yet) → the
  `metamorphic_oracle` cube/matrix stay byte-identical and green. Verify no event-count assertions break. GREEN.

- [ ] **Step 3 — The metric + the money_cost denominator term (the landscape shift).** `messaging_money_total_cents`
  metric (telemetry, reads the shared cost basis; **unknown channel → max cost, not 0** per doddy P1-1) + catalog +
  `GUARD_DIRECTIONS` (`lower_better`); **`worst_messaging_cents ≈ 18`** in `NORMALIZATION_ANCHORS` (human-set;
  hard floor ~6 at the 1¢ basis — add an anchor-floor guard test/comment; pin the exact value against the
  recomputed cube). Combiner: **`money_cost = clamp01(budgetShare +
  messagingShare)`** (SUM, MF3) + a synthetic `deriveNorthStarInputs` guard test with both present. **Re-pin** the
  `metamorphic_oracle` 2-D matrix + 3-D cube numeric `EXPECTED` (recompute from the impl); keep the `[2,3,1,1]`
  non-sep vector + `argmaxCadence(m,1)===2` / `argmaxCadence(m,2)<2` (MF2) HARD-pinned (do not re-derive); confirm
  every STRUCTURAL assertion still passes (unique optimum, margin `0.0118>0.01`, non-sep, b=0 identity) and add the
  MF1 margin-erosion comment. Update `scoring_model.md`'s `money` row to name messaging cost. GREEN.

- [ ] **Step 4 — The loop keystones (the tradeoff is live; the forge loses).** In `loop-orchestrator/tests/loop/`:
  (a) a **genome keystone** proving the money term is LIVE and creates a real tradeoff — `messaging_money_total_cents`
  strictly rises with cadence at the **(s=1, b=0)** cell (`[0,9,15,18]`; NOT at the b=1 optimum where it's
  `[0,9,9,12]` — flat 1→2), PLUS an **equal-planning_value / lower-cost-scores-strictly-higher** relation (the
  knife-edge-free load-bearing proof); confirm the convergence keystone still reaches (3,1,1).
  (b) an **integrity forge keystone** (`forgeWouldWinAbsentGate` / `onlyIntegrityFailed` local helpers, mirroring
  the existing keystones): a send-count-shaving (or channel-downgrading) candidate would beat the champion on the
  North Star ABSENT the gate, and is vetoed WITH it. GREEN.

- [ ] **Step 5 — ADR + memory + handoff + final built-code review.** Final architect+doddy+wolf review on the
  BUILT code; apply findings. **ADR 0020.** **Memory** `messaging-money-north-star.md` (+ index in MEMORY.md):
  the load-bearing-via-tier-1 distinction, the deliberate search-corpus entry, the channel+count forge surface,
  the calibration rationale, the deferred product/shared cost unification. Update `.claude/handoff.local.md`.

## Recorded deferrals (carry into the memory)
- **Unify `product/src/billing/price_book.ts` onto the shared cost basis** (retail = COGS × margin over the
  shared `MESSAGE_COST_CENTS`) — a clean follow-up; this phase keeps them conceptually linked but separate.
- **A messaging-strategy genome knob** (channel choice / send-policy as a tier-1 knob the search optimizes
  against cost) — the cost term makes such a knob meaningful later; not added here. **Tripwire:** such a knob
  makes `channel` genome-dependent, reopening the channel-field-diff reasoning (today channel is an immutable
  per-guest scenario fact both stages read identically).
- **A heterogeneous-channel keystone corpus** (sms/phone guests) — defer; this phase keeps email-only and
  defends channel cost-variation via the integrity gate's channel field-diff, not the landscape.
- **Per-couple `worst_messaging_cents`** (scenario-relative messaging budget) — Phase-1-style global anchor for
  now, like the other `NORMALIZATION_ANCHORS`.
- **Planner-facing guest CRUD + browser-form CSRF**, **richer wedding-facts model** — carried from Phase 19.
