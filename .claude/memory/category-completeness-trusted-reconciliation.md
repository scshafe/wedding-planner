---
name: category-completeness-trusted-reconciliation
description: Phase 8 — category_completeness_rate is trusted-backed (7th integrity effect kind), the FIRST plan-side model; load-bearing via tier-2 autonomy_threshold; completes the completeness trilogy
metadata:
  type: project
---

**Phase 8 made `category_completeness_rate` trusted-backed — the 7th integrity effect kind
`category_booking`, and the FIRST plan-side model** (every prior phase modeled guest interactions; this
models the PLAN — which categories the couple needs vs which the planner books). It **completes the
completeness trilogy**: all three inputs of the `completeness` North-Star component
(rsvp_resolution_rate, qa_accuracy_rate, category_completeness_rate) are now trusted-backed. After this,
**every computed North-Star input is trusted-backed except `quality`** (deferred behind judge→STOP /
stub→fabrication, ADR 0007).

**The load-bearing insight (same shape as [[qa-accuracy-trusted-reconciliation]]):** a naïve model where
the honest planner books every category is VACUOUS (honest rate pinned at 1.0, nothing to forge up). It
is load-bearing ONLY because booking competence is genome-dependent via the EXISTING tier-2
`autonomy_threshold` — the SAME `commitment_autonomy` surface Q&A escalation uses. A required category
carries a ground-truth `requires_couple_approval` flag; an approval-required category is honestly
`booked` only by a tier-2 genome (it needs the couple's commitment-authority), so a **tier-1** genome
honestly `deferred`s it (completeness < 1.0). The forge: a tier-1 candidate CLAIMS `booked` (completeness
up) without the couple commitment cost → trusted `deferred` ≠ claimed `booked` → field_mismatch → veto.
Shared fact `honestCategoryStatus(requiresCoupleApproval, canEscalate)` (= `booked` iff
`!requiresCoupleApproval || canEscalate`); NO grader oracle (correctness is just `status==='booked'`, a
deliberate asymmetry from Q&A, whose metric reads `answerable_by`).

**Non-obvious, carry forward:**
- **Ground truth lives on the runtime `ScenarioDefinition.required_categories`, NOT a JSON Schema** — the
  `bookedPlanFacts` precedent (plan-state fact, no LLM role-player). This avoids a contract regen AND
  makes "category-bearing scenarios are KEYSTONE-ONLY" **structural** (a runtime-only field can't leak
  into the YAML persona corpus the loader ingests, so the cube/matrix pins are protected by construction).
- **TWO reconciliation surfaces, ONE field:** the join key `category_id` defends the DENOMINATOR (forged /
  duplicate-as-forge / suppressed — all three must be built, they're not redundant with the field diff);
  `booking_status` defends the NUMERATOR (field_mismatch, skipWhenClaimAbsent:false).
  `requires_couple_approval` is never claimed and the metric never reads it → NO relabel surface (so only
  one field is diffed, unlike Q&A's two). Pin the metric's load-bearing field set so this can't rot.
- **The deferred booking-approval COST and the keystone-only invariant are ONE constraint.** Phase 8 does
  NOT charge a couple-attention cost for booking approval (consistent with Q&A escalation also being
  cost-free today). This is load-bearing, not convenient: if a category-bearing scenario ever entered the
  search corpus before the cost is modeled, a tier-2 genome would show a FREE completeness gain. Modeling
  the cost (+ a per-(guest/category, reason) session key) is the clean follow-on.
- **Keystone is tier-1-vs-tier-1 with the `forgeWouldWinAbsentGate` counterfactual** (a veto zeroes the
  ratio, over-determining `accepted=false`); assert `onlyIntegrityFailed` (INTEGRITY is the SOLE new gate
  failure) to isolate the gate as the real stopper. Corpus MUST co-locate a booked + a deferred category
  so the honest rate is < 1 and every forge arm has room to strictly raise it.
- `category_completeness_rate: 'higher_better'` is registered in `GUARD_DIRECTIONS` (constants
  consistency) but NEVER added to an active search guard set while category scenarios are keystone-only.

See `docs/adr/0008` and `.claude/plans/2026-06-25-phase-8-category-completeness-trusted-reconciliation.md`.
Related: [[qa-accuracy-trusted-reconciliation]], [[sentiment-trusted-reconciliation]],
[[tier2-promotion-gate-is-load-bearing]], [[integrity-gate-completeness-invariants]],
[[escalation-forge-detection-load-bearing]], [[loop-trusted-evidence-boundary]].
