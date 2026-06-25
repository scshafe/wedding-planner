# ADR 0011 — Advisory tier-2 exploration → promotable recommendations

- **Status:** accepted
- **Date:** 2026-06-25
- **Decider:** the building agent (an agent-owned engineering decision per
  [[agents-own-buildout-decisions]] and `.claude/plans/2026-06-25-phase-11-advisory-tier2-recommendations.md`)
- **Scope:** Phase 11 — the `AdvisoryProposer` (a tier-2-only exploration proposer), `runAdvisoryLoop`
  (a wrapper around the existing engine), the advisory plan-side corpus, and the `PromotableRecommendation`
  report. Offline-first, deterministic, no production blast radius. The auto-landing tier-1 loop is
  **byte-identical untouched**; this is purely additive — it makes the dormant plan-side value visible.
- **Supersedes nothing.** It is the deferred **§4** the search-convergence memory recorded ("no
  PROMOTABLE point" once tier-2 enters the search) and a concrete instance of the additive oversight loop
  ([[agent-run-operations-model]]). It rides Phase 4a's promotion gate ([[tier2-promotion-gate-is-load-bearing]])
  and the Phase 7–10 trusted firewall unchanged.

## Context

Phases 4b–10 made **every computed North-Star input trusted-backed** (rsvp, sentiment, qa, category,
cost, and — Phase 10 — `quality` via `vision_match`, the largest 0.40 component). But that entire
plan-side value was **DORMANT**: the autonomous search optimizes only the tier-1 reminder box
(cadence × spacing × batching), the `SearchProposer` **never emits a tier-2 genome** (the "box is
tier-1" guard), and the plan-side scenarios (`required_categories`, `vision_sensitive`) are keystone-only
by construction (runtime-only `ScenarioDefinition` fields, absent from `scenario_schema.json`). So
consulting-the-couple value — the whole point of the tier-2 `autonomy_threshold` surface — **never
reached any output**. The 8 trusted effect kinds were firewall-ready but never influenced a champion or
a recommendation.

The safety rail is the reason: **tier-2 (commitment autonomy) may not auto-land** —
`MAX_AUTONOMOUS_PROMOTION_TIER = 1`. The autonomous loop **cannot** optimize tier-2 directly. The honest
move that respects the rail is to **explore tier-2 candidates and SURFACE the best as ranked
"promotable, pending human approval" recommendations** — never landing them; a human (the exogenous
approval channel) decides whether any land.

**Verified premise (empirically, before building):** on a vision-sensitive scenario an honest tier-1
champion scores North-Star ratio **0.80**; an honest tier-2 candidate that consults the couple scores
**0.992** (vision_match 0.5→1.0, +10 couple-minutes) — a **+0.19** improvement, `accepted=true`, zero
gate failures. So a tier-2 candidate, if proposed, is **accepted-then-parked**: the advisory pass is
non-vacuous, and the parked set is a real recommendation set.

## Decision

1. **`AdvisoryProposer`** — a SEPARATE `Proposer` class (not a branch in `SearchProposer`) that emits
   ONLY tier-2 candidates: the tier-1 base genome + `autonomy_threshold ∈ {1..3}`. Every emitted genome
   HONESTLY derives tier 2 (so it reconciles at the pre-score gate and reaches the park, never a firewall
   reject). A distinct class so the "box is tier-1" guard keeps protecting the auto-landing path; the
   paired guard test pins both — `SearchProposer` emits only tier-1, `AdvisoryProposer` only tier-2.
2. **`runAdvisoryLoop`** — reuses the generic `runOfflineLoop` with the SAME scorer + veto gates +
   integrity reconciliation (`scoreCandidateOffline`) and the SAME promotion gate (`runPromotionGate`),
   configured with the advisory proposer + advisory corpus + an **EMPTY ApprovalStore** (constructed
   internally, never from caller input) + **isolated** champion/registry/ledger → every accepted tier-2
   candidate PARKS. The parked set IS the recommendation set.
3. **`PromotableRecommendation`** `{ candidate_id, genome, advisory_champion, landing_key,
   north_star_delta, provenance: 'advisory' }`, ranked by `north_star_delta` desc. The delta is the
   accept rule's own `aggregate_north_star_delta` (captured during the run — no re-scoring, no second
   code path). The landing key is `landingKeyFor(genome, advisory_champion)` — the content-address a
   human approval must bind to.
4. **The advisory certificate** `frontierFullyExplored = terminatedReason === 'converged' && promoted
   === 0 && humanRejected === 0 && parked === accepted`, computed in the wrapper. The generic
   `LoopTerminationReason.converged` is NOT overloaded with an advisory meaning. `maxDryIterations` is
   forced to `boxSize + 1` so the dry cap cannot trip before the frontier is fully explored and certified
   (every tier-2 candidate parks, climbing `consecutiveDry` to `boxSize`; one more iteration must reach
   the converged certificate).
5. **The advisory guard set** = a POSITIVE rule: `{value metrics present in the advisory corpus} minus
   {couple_active_minutes_total}`. Excluding the cost is required (it is already priced into the
   North-Star denominator via `effort_cost`; guarding it double-counts and rejects every tier-2
   candidate). Guarding the value metrics (`rsvp_resolution_rate`, `vision_match_rate`) closes the
   cross-value-regression hole.

## Why the safety rail holds (three independent barriers — doddy APPROVE on the built code)

The advisory pass is **provably incapable of landing tier-2 autonomously**:

1. **The proposer emits only tier-2 genomes** (`autonomy_threshold` always present), honestly derived to
   tier 2 — pinned by the proposer-pair guard test.
2. **The promotion gate re-derives the tier from the content-addressed genome at the seam** and routes
   tier ≥ 2 to `human_review`; `MAX_AUTONOMOUS_PROMOTION_TIER = 1` means only tier ≤ 1 reaches
   `landPromotion`.
3. **The ApprovalStore is hardcoded empty** (`new ApprovalStore([])`); `AdvisoryLoopConfig` has no
   `approvals` field, so a caller cannot inject one. Empty store ⇒ no approval ⇒ `parkCandidate` (no
   `championStore.promote`).

And it **never surfaces a firewall-failing recommendation**: the advisory pass runs the SAME unconditional
veto gates + integrity reconciliation, so a forged candidate (e.g. a vision_consult cost suppressed while
vision held at 1.0 — which would out-rank the honest companions) is VETOED → fails the accept rule →
never parks → EXCLUDED. The keystone proves this through the real `runAdvisoryLoop` path
(`suppressVisionConsult` planner → recommendations.length === 0).

**The optional `planner` override is NOT a firewall bypass** (doddy's sharpest check): the planner feeds
ONLY Stage A claims; the trusted record is built by `observeTrustedRecord(scenario, genome)`,
independent of planner output. A lying planner can only forge claims, which the integrity gate diffs
against the trusted record and vetoes — it cannot fabricate a trusted backing, so it cannot inject a
fake "honest" recommendation.

**Isolation** (doddy P1-A): stores are caller-injected instances with no module-level singletons; an
advisory run cannot corrupt the real champion / ledger / registry / lessons stream (the keystone's
ISOLATION arm pins a separate real champion store byte-identical after a run). **Provenance** (doddy
P2): the PARK ledger transition self-identifies via `parkProvenanceNote`, so an advisory park can never
be mistaken for a real auto-loop park awaiting approval even read outside its isolated ledger.

## Consequences

- **The plan-side value (8 trusted effect kinds, quality 0.40) is no longer dormant** — it now produces
  ranked, firewall-clean, human-reviewable tier-2 recommendations, the first artifact that connects the
  Phase 7–10 firewall investment to the recursive loop's output.
- The auto-landing tier-1 search is **byte-identical untouched** (separate proposer class + separate
  corpus; `SearchProposer` and `RSVP_CORPUS` unchanged; `quality` stays null on the search corpus).
- Test count 388 → 407. New: `advisory_proposer.test.ts` (proposer-pair guard), `advisory_loop.test.ts`
  (wrapper mechanics), `advisory_recommendation_keystone.test.ts` (the load-bearing keystone).

## Out of scope (recorded, not faked)

- **Category-scenario half of the advisory corpus** — vision-only proves the mechanism; adding
  category/qa scenarios is a clean follow-on (more recommendation variety), not load-bearing.
- **Moving plan-side scenarios INTO the tier-1 search corpus** — still blocked by the single-rubric 0.40
  over-weight (ADR 0010) and pointless for the tier-1 box (constant 0.5, no gradient). The advisory pass
  is the correct path to use the plan-side value without that distortion.
- **A real human-approval UI / oversight surface** — the recommendation report is the offline artifact;
  wiring it to a real human channel is a human-reserved operational step (offline-first; surface, don't
  fake).
- **`comms_quality` / `intuitiveness`** — still judge-shaped, STOP-gated (ADR 0007), unchanged.
