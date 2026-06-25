# Handoff

## Where things stand — Phase 11 (the advisory tier-2 recommendation layer) is BUILT ✅
`.claude/plans/2026-06-25-phase-11-advisory-tier2-recommendations.md` is **complete — all steps ticked**
(Step 0 design reviews + Steps 1–6), on branch **`build/phase-3-generalize-search`** (the open review
artifact for `main`; Phases 3–11 build on it; the loop's merge-keeper advances `main` when green).
Working tree clean. `npm run build && npm test && npm run lint` all green (**407 tests**, up from 388 at
the start of this run). `main` has Phase 1+2; this branch is the review artifact for Phases 3–11.

**What changed:** the dormant plan-side value (the 8 trusted effect kinds from Phases 7–10 — quality
0.40, completeness, qa, vision — that NEVER reached any output because the autonomous search only ranges
the tier-1 reminder box and never emits a tier-2 genome) is now **connected to the loop's output**. The
new **advisory pass** EXPLORES tier-2 candidates and SURFACES the firewall-clean, accept-rule-passing
ones as ranked **"promotable, pending human approval" recommendations** — never auto-landing them (the
safety rail: `MAX_AUTONOMOUS_PROMOTION_TIER = 1`). This is the deferred **§4**. See `docs/adr/0011`,
memory [[advisory-tier2-promotable-recommendations]].

## The load-bearing insight (carry forward)
The advisory pass is **reuse, not fork**: `runAdvisoryLoop` wraps the SAME `runOfflineLoop` (same scorer
+ veto gates + integrity reconciliation + promotion gate) with a SEPARATE `AdvisoryProposer` (tier-2
only), the vision-sensitive advisory corpus, an **EMPTY ApprovalStore** (hardcoded; `AdvisoryLoopConfig`
has no `approvals` field), and **isolated** champion/registry/ledger → every accepted tier-2 candidate
**PARKS**, and the parked set IS the recommendation set (`PromotableRecommendation` ranked by the accept
rule's own `aggregate_north_star_delta`).

**Three independent barriers make it provably incapable of auto-landing tier-2** (doddy APPROVE on the
built code): tier-2-only proposer; promotion gate re-derives tier from the content-addressed genome and
parks tier≥2 without an approval; empty ApprovalStore with no caller path. **It never surfaces a
firewall-failing rec**: the same unconditional integrity gate vetoes a forged candidate (e.g. a
suppressed `vision_consult` cost) → fails accept → never parks → excluded. The optional `planner`
override is NOT a bypass (it authors only Stage A claims; the trusted record is derived independently
from the genome/scenario, so a lying planner self-incriminates).

## What's new this phase (by step)
- **Step 0** — architect + doddy design reviews (both APPROVE-WITH-CHANGES); all findings folded into the plan.
- **Step 1** — `AdvisoryProposer` (`src/proposer/advisory_proposer.ts`): tier-2-only, honestly derived;
  paired guard test pins SearchProposer→tier-1, AdvisoryProposer→tier-2 (neither can become the other).
- **Steps 2–3** — advisory corpus (`tests/fixtures/advisory_corpus.ts`, vision-sensitive, + the positive
  guard rule) + `runAdvisoryLoop` (`src/loop/advisory_loop.ts`): isolated stores, empty approvals,
  `maxDryIterations = boxSize + 1`, ranked `PromotableRecommendation`, `frontierFullyExplored` certificate.
- **Step 4** — the keystone (`tests/loop/advisory_recommendation_keystone.test.ts`): parks-never-promotes,
  isolation, forge-excluded (vision_consult cost-suppress → empty rec set), guard-rule load-bearing
  (guarding couple_active_minutes_total → zero recs), honest-surfaced (positive delta).
- **Step 5** — doddy re-review of the BUILT code: **APPROVE**; applied the one P2 (defense-in-depth):
  the PARK ledger transition self-identifies advisory provenance via `parkProvenanceNote`.
- **Step 6** — `docs/adr/0011` + memory [[advisory-tier2-promotable-recommendations]] + MEMORY.md index + this handoff.

## Next action — your call. The big remaining levers (ranked)
- **Enrich the advisory corpus / report** — add category & qa scenarios to the advisory corpus so the
  recommendations span more plan-side value (more variety, mixed-axis tier-2 tradeoffs). Clean follow-on,
  low risk, directly increases the advisory pass's reach. The mechanism is built; this is corpus-authoring
  + maybe a richer recommendation report (group by axis, show which metric each rec moves).
- **A 4th tier-1 knob → 4-D search** — pure tier-1 search generalization, forge-free, lowest risk; the
  cleanest "more search" move but lower marginal value (the tier-1 box is already well-explored). Needs a
  genuinely meaningful forge-free non-judge 4th reminder knob, else it's busywork.
- **`comms_quality` / `intuitiveness` rubrics** — the last two `quality` rubrics, genuinely judge-shaped
  (free-text tone, UX). Honest offline backing needs a real Claude judge → **STOP-and-surface**
  (offline-first, ADR 0007). Do NOT build a stub.
- **Per-category heterogeneous vision difficulty** — a graded alignment model that would make
  denominator-spread forges load-bearing at the keystone level. Scenario-authoring refinement, low value.

## Non-obvious Phase-11 context (carry forward)
- **The advisory guard set is a POSITIVE rule:** value metrics MINUS `couple_active_minutes_total`. The
  consult cost is ALREADY priced into the North-Star denominator (`effort_cost`); guarding it
  DOUBLE-COUNTS → every tier-2 candidate "regresses" couple minutes vs the tier-1 base → zero recs
  (empirically pinned in the keystone). Same shape as why vision_match_rate/category_completeness_rate are
  kept OUT of the active search guard set while keystone-only (ADR 0008/0010).
- **`maxDryIterations = boxSize + 1`** is load-bearing: parked accepts increment `consecutiveDry` and
  never reset, so a smaller cap truncates the frontier before the `converged` certificate. The advisory
  certificate lives in the WRAPPER (`frontierFullyExplored`), NOT in the generic `converged` enum.
- **`park` is a SAFETY outcome reused as the advisory OUTPUT** — kept distinguishable by isolated stores +
  the `parkProvenanceNote` on the park ledger transition (doddy P2).
- **The honest-tier-2-beats-tier-1 premise is empirical and strong** (0.80 → 0.992, +0.19 on a vision
  scenario): the consult value outweighs the +10 couple-minute cost. That's why the advisory pass is
  non-vacuous. If a future change weakens it, the advisory pass would surface nothing — re-verify.
- **CI/exit-code lesson (still true):** never pipe `npm run build` to tail/grep when gating with `&&`
  (the pipe masks the non-zero exit). Run build standalone, check `$?`. `npm run build` runs from REPO ROOT.
- The repo's named specialist sub-agents (doddy/wolf/testineer/rigorous-architect) are **not provisioned**
  here — route adversarial reviews through `general-purpose` agents carrying the persona lens (this run did,
  for architect + doddy at design, and doddy again on the built code).
- Durable facts: `MEMORY.md` index — Phase 11 added **[[advisory-tier2-promotable-recommendations]]**.
  Still load-bearing: [[vision-match-trusted-reconciliation]], [[couple-attention-cost-generalization]],
  [[tier2-promotion-gate-is-load-bearing]], [[second-genome-knob-must-stay-tier1]],
  [[search-convergence-certificate-semantics]], [[category-completeness-trusted-reconciliation]],
  [[qa-accuracy-trusted-reconciliation]], [[sentiment-trusted-reconciliation]],
  [[escalation-forge-detection-load-bearing]], [[genome-content-address-firewall]],
  [[loop-trusted-evidence-boundary]], [[integrity-gate-completeness-invariants]],
  [[accept-rule-composition-invariance]], [[third-tier1-knob-batching-3d-search]].
