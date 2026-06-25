---
name: vision-match-trusted-reconciliation
description: Phase 10 — vision_match is the first trusted-backed quality rubric; computes the 0.40 quality North-Star component for the first time (no judge); completes the "every computed North-Star input trusted-backed" arc
metadata:
  type: project
---

**Phase 10 computed the `quality` North-Star component for the FIRST time** (weight **0.40**, the largest
`planning_value` numerator, hard-`null` since Phase 1) — WITHOUT a judge. It built ONE honestly-offline
rubric, **`vision_match`** (the 8th integrity effect kind `vision_alignment`), and set
`quality = meanOfPresent([vision_match_rate])` in `metric_normalization.ts`. This **completes the "every
computed North-Star input trusted-backed" arc**: rsvp (4b), sentiment (6), qa (7), category (8), cost
(4b/9), quality (10). The only still-`null` inputs are `comms_quality`/`intuitiveness` — genuinely
judge-shaped (free-text tone, UX), honestly STOP-gated (ADR 0007), NOT faked.

**`vision_match` is a DETERMINISTIC alignment of a booked category's selection to the couple's
ground-truth vision — NOT an LLM judge.** Load-bearing via the EXISTING tier-2 `autonomy_threshold`
(`canConsult === canEscalate`), same shape as [[category-completeness-trusted-reconciliation]] /
[[qa-accuracy-trusted-reconciliation]]. Shared facts in `domain_facts.ts`:
`honestVisionMatch(canConsult)` = `canConsult ? ALIGNED(1.0) : DEFAULT(0.5)`;
`honestVisionConsultSession(canConsult)` = `canConsult`. A **vision-sensitive** booked category is ALIGNED
(1.0) only by a tier-2 genome that CONSULTS the couple (paying a `vision_consult` couple session); a tier-1
genome books a DEFAULT (0.5) selection at no cost.

**Two forges, two surfaces (the cleanest split yet):**
- **Value (the NEW `vision_alignment` reconciliation):** a tier-1 candidate claims `vision_match_score=1.0`
  it cannot earn (honest 0.5) → `field_mismatch` vs the trusted record → veto. Keystone arm: **tier-1 vs
  tier-1** (completeness + cost held → vision is the SOLE value mover).
- **Cost (rides Phase 9 unchanged):** a tier-2 candidate aligns honestly (1.0) but shaves/suppresses the
  `vision_consult` couple session → lower `effort_cost`. Caught by `detectCoupleSessionDivergences` on the
  `(vision_consult, category_id)` key — **NO new gate code for the cost** (the whole point of Phase 9's
  generalized key: a 4th reason rides it for free). Keystone arm: **tier-2 vs tier-2** (completeness AND
  vision held → `vision_consult` is the SOLE cost mover; pin a single immediate guest so cadence can't add
  an rsvp_escalation confound).

**Non-obvious, carry forward:**
- **SEPARATE event + effect kind, NOT an extension of `category_booking`.** `category.vision.aligned`
  `{category_id, vision_match_score}` is distinct from `category.booked` so completeness (a pillar) and
  quality (a different pillar) keep INDEPENDENT claims-only denominators — a duplicate/suppressed booking
  can't perturb the vision rate and vice versa (protects the Phase-8 keystone's "completeness is sole mover"
  isolation). `vision_match` is ORTHOGONAL to `requires_couple_approval`: the cleanest keystone category is
  approval-FREE + vision-sensitive (booked at any tier, so vision is the only tier-dependent axis).
- **`vision_sensitive` is runtime-only on `RequiredCategory`** (NOT in any JSON Schema), like
  `requires_couple_approval` → vision-bearing scenarios are KEYSTONE-ONLY by construction → byte-identity on
  the search corpus AND the Phase-8 keystone (no vision events there → `vision_match_rate` null → `quality`
  null → `planning_value` renormalizes identically). Vision events fire ONLY for `vision_sensitive && booked`.
- **The 0.40 quality weight rides a SINGLE rubric while thin.** `scoring_model.md` intends it as the mean of
  THREE; with two absent, a 0.5→1.0 vision swing moves planning_value by 0.20. NOT a forge (firewall still
  vetoes lies) but leverage amplification → the keystone asserts forge DIRECTION + GATE, never the ratio-delta
  MAGNITUDE; and the weight is provisional-while-thin → an extra reason NOT to move vision scenarios into the
  search corpus (the over-weight would distort the optimizer gradient).
- **doddy P2 fixed here (corrects a wrong Phase-9 note):** `readCoupleSessionEndedPayload` no longer throws
  on absent/NaN active_seconds — `offline_scorer` runs metrics UNCONDITIONALLY (the gate verdict does NOT
  gate the metric, contra the old note), so a malformed value CRASHED scoring. Now tolerant (null → 0 min);
  the gate still vetoes via its own raw read. See [[couple-attention-cost-generalization]].
- **The metric reader (`readVisionAlignedPayload`) is tolerant (null on non-numeric/out-of-[0,1]); the gate
  keeps its OWN raw `readNumber`** (reader-seam discipline). doddy confirmed no value passes the gate while
  contributing a higher mean.

See `docs/adr/0010-vision-match-quality-capstone.md` and
`.claude/plans/2026-06-25-phase-10-vision-match-quality-capstone.md`. Related:
[[couple-attention-cost-generalization]], [[category-completeness-trusted-reconciliation]],
[[qa-accuracy-trusted-reconciliation]], [[sentiment-trusted-reconciliation]],
[[tier2-promotion-gate-is-load-bearing]], [[integrity-gate-completeness-invariants]],
[[loop-trusted-evidence-boundary]].
