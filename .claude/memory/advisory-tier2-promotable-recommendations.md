---
name: advisory-tier2-promotable-recommendations
description: Phase 11 — the advisory pass surfaces dormant plan-side value as human-reviewable tier-2 recommendations without ever auto-landing tier-2
metadata:
  type: project
---

Phase 11 CONNECTS the dormant plan-side value to the loop's output. After Phases 7–10 made every
computed North-Star input trusted-backed (quality 0.40 via vision_match, completeness, qa, cost), that
value was DORMANT: the autonomous `SearchProposer` only ranges the tier-1 reminder box and never emits a
tier-2 genome, and category/vision/qa scenarios are keystone-only (runtime-only `ScenarioDefinition`
fields). So consulting-the-couple value never reached any output — tier-2 can't auto-land
(`MAX_AUTONOMOUS_PROMOTION_TIER = 1`, the safety rail).

**The move:** an ADVISORY pass that EXPLORES tier-2 candidates and SURFACES the firewall-clean,
accept-rule-passing ones as ranked "promotable, pending human approval" recommendations — never landing
them. This is the deferred §4 of [[search-convergence-certificate-semantics]] and an instance of the
additive oversight loop ([[agent-run-operations-model]]).

**Design = reuse, do not fork.** `runAdvisoryLoop` wraps the SAME generic `runOfflineLoop` (same scorer
+ veto gates + integrity reconciliation + promotion gate) with: a SEPARATE `AdvisoryProposer` (tier-2
only — tier-1 base + `autonomy_threshold ∈ {1..3}`, honestly tier-2), the vision-sensitive advisory
corpus, an EMPTY `ApprovalStore` (hardcoded, no caller injection path), and ISOLATED
champion/registry/ledger. Every accepted tier-2 candidate PARKS; the parked set IS the recommendation set
(`PromotableRecommendation {genome, advisory_champion, landing_key, north_star_delta, provenance}`, ranked
by the accept rule's own `aggregate_north_star_delta`). The auto-landing tier-1 loop is byte-identical
untouched.

**Why it's safe (three independent barriers — doddy APPROVE):** tier-2-only proposer; promotion gate
re-derives tier from the content-addressed genome and parks tier≥2 without an approval; empty ApprovalStore
with no caller path. And it NEVER surfaces a firewall-failing rec: the same unconditional integrity gate
vetoes a forged candidate (e.g. a suppressed `vision_consult` cost) → fails accept → never parks →
excluded. The optional `planner` override is NOT a bypass: it authors only Stage A claims; the trusted
record is derived independently from the genome/scenario (`observeTrustedRecord`), so a lying planner
self-incriminates.

**Load-bearing non-obvious facts (carry forward):**
- **The guard set is a POSITIVE rule:** value metrics MINUS `couple_active_minutes_total`. The consult
  cost is already priced into the North-Star denominator (`effort_cost`); guarding it DOUBLE-COUNTS and
  rejects every tier-2 candidate (empirically: guarding it → zero recommendations). Guarding the value
  metrics (rsvp/vision) closes the cross-value-regression hole. This mirrors why
  `vision_match_rate`/`category_completeness_rate` are kept OUT of the active search guard set while
  keystone-only (ADR 0008/0010).
- **`maxDryIterations` forced to `boxSize + 1`:** every tier-2 candidate parks (parked accepts increment
  `consecutiveDry`, never reset), so the dry cap must exceed `boxSize` or the frontier is truncated before
  the `converged` certificate. The advisory certificate `frontierFullyExplored` is computed in the wrapper
  (`converged && parked === accepted && promoted === 0`); the generic `converged` enum is NOT overloaded.
- **`park` is a SAFETY outcome reused as an advisory OUTPUT** — kept distinguishable by isolated stores +
  a `parkProvenanceNote` stamped on the park ledger transition (doddy P2), so an advisory park can never be
  mistaken for a real auto-loop park awaiting approval.
- **Honest tier-2 genuinely beats tier-1** on a vision scenario (0.80 → 0.992, +0.19): the consult value
  (vision 0.5→1.0 × 0.40 weight) outweighs the +10 couple-minute cost. That's why the pass is non-vacuous.

See `docs/adr/0011`, plan `2026-06-25-phase-11-advisory-tier2-recommendations.md`. Files:
`loop-orchestrator/src/proposer/advisory_proposer.ts`, `loop-orchestrator/src/loop/advisory_loop.ts`,
`loop-orchestrator/tests/fixtures/advisory_corpus.ts`,
`loop-orchestrator/tests/loop/advisory_recommendation_keystone.test.ts`. Builds on
[[tier2-promotion-gate-is-load-bearing]], [[vision-match-trusted-reconciliation]],
[[second-genome-knob-must-stay-tier1]].
