# ADR 0010 — Trusted `vision_match` + the `quality` North-Star component (the capstone)

- **Status:** accepted
- **Date:** 2026-06-25
- **Decider:** the building agent (an agent-owned engineering decision per
  [[agents-own-buildout-decisions]] and `.claude/plans/2026-06-25-phase-10-vision-match-quality-capstone.md`)
- **Scope:** Phase 10 — the telemetry value surface (`category.vision.aligned`, `vision_match_rate`), the
  trusted recorder + record, the planner simulator (Stage A/B), the integrity gate (8th effect kind), and
  the metric→component layer (`quality`). Offline-first, deterministic, no production blast radius. North
  Star **weights untouched**; every honest genome's score on the existing (vision-free) search corpus is
  **byte-identical** — purely firewall hardening + the FIRST computed `quality` signal, like 4b/6/7/8/9.
- **Supersedes nothing.** Adds the `vision_consult` reason to the Phase-9 couple-session surface
  ([[couple-attention-cost-generalization]]) and a new orthogonal value effect kind; closes the `quality`
  deferral that every prior ADR (0005–0009) recorded as "the capstone."

## Context

`quality` (weight **0.40**, the largest `planning_value` numerator component) has been hard-`null` since
Phase 1. It rolls up rubric scores `vision_match`, `comms_quality`, `intuitiveness`. Two of the three are
genuinely judge-shaped (free-text comms tone, UX intuitiveness) — building them offline would mean a
fabricated stub or a real Claude judge, both barred (offline-first; ADR 0007 judge→STOP). **`vision_match`
is different**: it is the alignment of a booked category's *selection* against the couple's *ground-truth
vision preference* — a deterministic, persona-grounded quantity, exactly the shape of
`category_completeness_rate` / `qa_accuracy_rate`. It can be built honestly with **no judge**, and
`quality` computed as the mean of the *present* rubrics (just `vision_match` today — the existing
`meanOfPresent` renormalization). This computes `quality` for the first time without fabricating a judge.

Phase 9 built the exact degree of freedom this needs: the planner consulting the couple **at a reconciled
cost** to raise selection quality — the Goodhart guard `scoring_model.md` names (*"couple_active_minutes
↓ → guard: vision_match — don't win by deciding badly-but-fast"*), which is only meaningful once
consultation has a cost. Phase 10 rides that surface with a 4th reason `vision_consult`.

## The load-bearing insight (why `vision_match` is non-vacuous)

Same shape as 7/8/9 — load-bearing ONLY via the EXISTING tier-2 `autonomy_threshold`
(`canConsult === canEscalate`). A **vision-sensitive** booked category has a couple aesthetic preference:

- A **tier-2** genome CONSULTS the couple → selection ALIGNED → `honestVisionMatch = ALIGNED (1.0)`, AND
  incurs a `vision_consult` couple session (the cost).
- A **tier-1** genome cannot consult → a DEFAULT selection → `honestVisionMatch = DEFAULT (0.5)`, no session.
- A **non-vision-sensitive** category is aligned by default at no cost → emits **no vision claim at all**
  (its alignment is not graded) — which keeps the search corpus + the Phase-8 category keystone byte-identical.

This is **INDEPENDENT of completeness**: the category is *booked either way* (`vision_sensitive` is
orthogonal to `requires_couple_approval`), so `vision_match` is a genuine orthogonal value axis, not a
re-skin of completeness. Encoded as SHARED facts `honestVisionMatch(canConsult)` /
`honestVisionConsultSession(canConsult)` in `domain_facts.ts`; both stages call them on the SAME trusted
genome, so an honest run reconciles bit-identically and never self-vetoes (the Phase-6 argument; 0.5/1.0
are exact IEEE-754 doubles, no float hazard).

**Two forges this makes load-bearing:**
1. **Value side (the NEW surface):** a **tier-1** candidate that CLAIMS `vision_match_score = 1.0` it
   cannot earn (honest 0.5, it could not consult) → quality up for free. The trusted record holds 0.5 →
   **field_mismatch** → veto. The new `vision_alignment` reconciliation.
2. **Cost side (rides Phase 9):** a **tier-2** candidate that aligns honestly (1.0) but **shaves/suppresses
   the `vision_consult` session** → same quality at sub-tier-2 cost → lower `effort_cost` → higher ratio.
   Caught by Phase 9's `detectCoupleSessionDivergences` on the `(vision_consult, category_id)` key.

Both proven in `vision_match_forge_keystone.test.ts` (tier-1-vs-tier-1 value; tier-2-vs-tier-2 cost, with
shave + suppress + a 0.51-vs-0.5 / 599-vs-600 near-miss), each via `forgeWouldWinAbsentGate` +
`onlyIntegrityFailed`.

## Decision

1. **Value telemetry:** event `category.vision.aligned` `{ category_id, vision_match_score }`; metric
   `vision_match_rate` = mean over the CLAIMED stream (claims-only denominator, null when none). A SEPARATE
   event from `category.booked` so completeness (a pillar) and quality (a different pillar) keep independent
   denominators — a duplicate/suppressed booking can't perturb the vision rate, and vice versa.
2. **Trusted record** `TrustedVisionAlignmentRecord { category_id, vision_match_score }`; recorder
   `recordVisionAlignment` / `visionAlignment` / `allVisionAlignments`, keyed by `category_id`.
3. **8th effect kind** `vision_alignment`; `detectVisionAlignmentDivergences` mirrors the category detector:
   missing-id (forged) → duplicate-as-forge (before the trusted lookup) → no-trusted (forged) →
   field_mismatch on `vision_match_score` (`skipWhenClaimAbsent:false`) → suppressed. `category_id` defends
   the denominator; `vision_match_score` defends the numerator.
4. **Ground truth** `RequiredCategory.vision_sensitive?: boolean` — runtime-only (NOT in any JSON Schema),
   like `requires_couple_approval`, so vision-bearing scenarios are KEYSTONE-ONLY by construction.
5. **Cost side** = the Phase-9 surface unchanged: `CoupleSessionReason` gains `vision_consult`; Stage A/B
   emit/record one `(vision_consult, category_id)` session per aligned vision-sensitive category. NO new
   gate code for the cost.
6. **`quality`** = `meanOfPresent([vision_match_rate])` in `metric_normalization.ts`.

### Why a SINGLE rubric at the full 0.40 weight is honest but provisional

`scoring_model.md` intends the 0.40 `quality` block to be the mean of THREE rubrics. With two absent
(judge→STOP), `vision_match` alone controls the full 0.40 on a vision-bearing scenario — a 0.5→1.0 swing
moves `planning_value` by 0.20. This is NOT a forge (the firewall still vetoes a lie) but it IS leverage
amplification + a thin-corpus caution (`scoring_model.md`'s "a rising number on a thin corpus means
little"). So: the keystone asserts forge DIRECTION + GATE, never the magnitude of the ratio delta; and the
0.40 weight is **provisional-while-thin** — an additional reason NOT to move vision scenarios into the
search corpus (where the over-weight would distort the optimizer's gradient). The accept-rule interaction
is benign: `quality` is null on every search-corpus scenario, and the aggregate is per-scenario-then-
weighted, so there is no cross-scenario renormalization leak.

## Why the existing invariants hold

- **Byte-identity on the search corpus AND the Phase-8 keystone.** Vision claims + `vision_consult`
  sessions fire ONLY for `vision_sensitive` booked categories; `vision_sensitive` is absent from the search
  corpus and from the Phase-8 `REQUIRED_CATEGORIES`, so `vision_match_rate` is null → `quality` is null →
  `planning_value` renormalizes over the same components as before. Asserted directly
  (`stage_vision.test.ts`: a non-vision-sensitive category, a deferred one, and a category-free scenario
  all emit ZERO vision events).
- **Orthogonal to completeness** — separate event, separate denominator, separate effect kind; pinned by
  `integrity_vision.test.ts`'s orthogonality arm (a vision forge produces no category divergence, vice versa).
- **Grader/numerator input, not a NEW veto-gate input** — extends the firewall to a North-Star numerator
  without changing the integrity-gate completeness invariant ([[integrity-gate-completeness-invariants]]).
- **No fabricated judge** — `vision_match` is a deterministic function of persona ground truth + trusted
  genome policy; `comms_quality`/`intuitiveness` remain honestly `null` (their judge is STOP-and-surface).

## Adversarial review (general-purpose reviewers carrying the named lenses; specialists not provisioned)

- **rigorous-architect** (design, pre-build): APPROVE-WITH-CHANGES — folded: separate effect kind is
  correct (independent denominators protect the Phase-8 keystone's isolation); the single-rubric 0.40
  leverage documented (assert direction+gate not magnitude); keystone corpus cardinality PINNED (a single
  vision-sensitive category → suppress/duplicate are vacuous at the loop level, so covered at the gate
  level only); the tier-2 cost arm pinned to a single immediate guest so `vision_consult` is the provably
  sole `couple_active_minutes_total` mover; reader-seam (`VISION_ALIGNED_REPORT_EVENT_NAMES`) + the
  active_seconds-throw avoidance.
- **doddy** (trust boundary, post-gate): **APPROVE**, no P0/P1 — no value lift or cost shave passes the
  gate across reader-seam / denominator / composition / self-veto axes. P2 fixed: the metric ran
  unconditionally even on a gate-vetoed stream, so a malformed `active_seconds` on a `couple.session.ended`
  (a surface Phase 10 widened via `vision_consult`) **crashed scoring** — made `readCoupleSessionEndedPayload`
  tolerant (null → 0-minute contribution); the gate still vetoes it via its own raw read, so this removes a
  DoS without weakening the firewall. **Corrects the ADR-0009 note** that wrongly claimed the gate verdict
  runs *before* the metric — both run unconditionally; the veto does not prevent the throw.
- **testineer** (keystone): APPROVE-WITH-CHANGES — verified forge isolation empirically (cadence-1 vs
  cadence-2 byte-identical on every honest metric at both tiers) and both counterfactuals fire for real.
  Applied: a value NEAR-MISS arm (0.51 vs 0.5) symmetric with the cost 599-vs-600; pin `vision_match_rate
  === 1` in the cost arms (a clean cost-only forge).

## Consequences

- **`quality` is computed for the first time** — the "every computed North-Star input trusted-backed" arc
  is COMPLETE (rsvp 4b, sentiment 6, qa 7, category 8, cost 4b/9, quality 10). The only North-Star inputs
  still `null` are the two genuinely-judge-shaped rubrics, honestly STOP-gated.
- The `vision_match` value firewall is load-bearing (`vision_match_forge_keystone.test.ts`, 6 arms;
  `integrity_vision.test.ts` gate-level arms), composing with the Phase-9 cost firewall under distinct
  `(reason, about_id)` keys (`booking_approval/cat` vs `vision_consult/cat`).
- A DoS in the couple-cost metric (malformed `active_seconds` crashing scoring) is closed — the
  `readCoupleSessionEndedPayload` tolerant-reader follow-on ADR 0009 itself listed as out-of-scope.

## Out of scope (recorded, not faked)

- **`comms_quality` / `intuitiveness`** — genuinely judge-shaped; honest offline backing needs a real
  Claude judge → STOP-and-surface (ADR 0007). They stay `null`; `quality` is the present-rubric mean.
- **Per-category heterogeneous vision difficulty / continuous alignment** — a richer model (vision_match a
  graded function of selection vs preference, which WOULD make denominator-spread forges load-bearing at the
  keystone level) is a scenario-authoring refinement, not a forge surface. The two-constant model
  (ALIGNED/DEFAULT) follows the 8/9 "start with one constant" discipline; the gate arms are already built
  for heterogeneity.
- **Moving vision/category scenarios INTO the search corpus** — now even more possible (quality is the
  consult payoff, the cost is modeled), but a separate guard/spread decision; the single-rubric 0.40
  over-weight is a fresh reason to keep it keystone-only until `quality` has more than one backed rubric.
