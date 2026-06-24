---
name: search-convergence-certificate-semantics
description: "Phase-3 search facts — what the `converged` certificate does and does NOT claim, why the spread order only matters under truncation, and where non-separability actually comes from"
metadata:
  node_type: memory
  type: project
---

Three load-bearing, easy-to-misread facts about the Phase-3 multi-parameter offline search
(`loop-orchestrator/src/proposer/search_proposer.ts` + `loop/offline_loop.ts`). Builds on
[[second-genome-knob-must-stay-tier1]].

**1. `converged` means "no ACCEPTABLE point against the standing champion" — NOT a global optimum.**
The proposer returns null exactly when every other box point was proposed against the *current*
champion (per-champion-hash coverage) and none was accepted; the loop turns that into `converged`. But
the accept rule is a CONJUNCTION (no golden regression, no new gate failure, no guard regression, AND
strict aggregate-North-Star gain). So with a binding guard or golden condition, a point with strictly
HIGHER North Star can be vetoed — the certificate then says the champion is the best *acceptable*
point, not the box argmax. The guard-active keystone arm asserts exactly this (the global optimum is
guarded out and never adopted). Never relabel `converged` as "optimal".

**2. The spread-first (bit-reversal / van der Corput) box order is OUTCOME-NEUTRAL under a
box-sufficient budget.** Because the loop sweeps the whole box against each champion before declaring
convergence, the *order* cannot change the converged result — only the iteration at which each point
is visited. Its value exists ONLY under `maxIterations` truncation, where spread-first covers
far-from-champion points a champion-local order would not reach within the budget (the keystone proves
this with a K-budget reach comparison). Do not claim it speeds up or improves the converged outcome;
do not call it "low-discrepancy sophistication" (it is a 16-point lattice).

**3. Non-separability comes from the MULTIPLICATIVE sentiment term, not the cost denominator.**
`sentiment = 1 − penalty_per_nag(spacing) · nags(cadence)` couples the two knobs in the North Star
*numerator* (guest_experience), so the optimal cadence depends on spacing (argmax cadence is 2 at
spacing≤1, drops once capacity caps reach). This 2-D landscape is coordinate-descent-SOLVABLE (the
global optimum is reachable by axis moves), so the Phase-3 keystone does NOT claim a coordinate-descent
saddle. **UPDATE (Phase 5):** this CD-solvable statement is **2-D-only**. The 3rd knob
([[third-tier1-knob-batching-3d-search]]) makes the 3-D (cadence×spacing×batching) landscape
coordinate-descent-UNSOLVABLE — there is a CD trap at (2,1,0) (reaching the optimum (3,1,1) needs a
SIMULTANEOUS cadence+batching move) — that the full-box spread-first sweep escapes. Do NOT carry the
"coordinate-descent-solvable" wording into 3-D; the Phase-5 keystone may (and does) claim the stronger
"full-box sweep escapes a CD trap the 2-D-blind search is stuck in".
What it DOES prove: the optimum requires a non-default value on the second knob, which the pre-Phase-3
1-D (cadence-only, spacing-pinned) search is structurally incapable of reaching — that is the honest
"old search misses the interaction win". The genome→North-Star surface is pinned as a 16-value matrix
in `metamorphic_oracle.test.ts`; the simulator constants (capacity profile `[3,3,1,0]`, relief 0.25)
were tuned to that matrix — never the North Star weights.

**Termination guarantee:** every accept strictly raises the champion North Star (accept condition 4),
so over the finite content-addressed genome box promotions are bounded and no champion recurs — true
even with binding guards (a guard can reject but never make an accept non-monotone in North Star). The
trajectory-relative tabu (keyed on champion hash) therefore cannot cycle.

**4. DEFERRED FIX for 4b — `converged` must become "no PROMOTABLE point" once tier-2 enters the search.**
Phase 4a added the tier-2 promotion gate ([[tier2-promotion-gate-is-load-bearing]]): an accepted tier-2
candidate PARKS (not promoted) absent a human approval. This is safe in 4a because the autonomous search
box is tier-1 only, so parking never happens mid-sweep and the certificate above is unchanged. But if 4b
(or any phase) lets the autonomous proposer emit tier-2 (escalation>0) candidates, a parked point is
**acceptable-but-not-promotable** — it passes the accept rule yet does not ratchet the champion. The
current certificate ("no ACCEPTABLE point") would then FALSELY fire while a strictly-better point sits
parked. Before that, redefine: **promotable = acceptable AND tier ≤ 1 (or approved)**; `converged` =
"no PROMOTABLE point against the standing champion"; a parked-but-acceptable point gets a DISTINCT
terminal (`awaiting_oversight`), never `converged`/`dry`. Also re-prove termination: split the bound into
`promotions ≤ boxSize` (kept) and `parks` bounded per champion (a parked genome can re-surface once per
distinct champion after a ratchet). The Phase-3 `accepts ≤ boxSize` runtime assertion will NOT hold once
parks exist.

**UPDATE (Phase 4b — the redefinition STAYS deferred).** 4b built the escalate-to-couple knob +
forge-detection ([[escalation-forge-detection-load-bearing]]) but kept escalation **injected-only**: the
autonomous proposer's box stays tier-1 (cadence × spacing) and a guard test pins that `search_proposer`
never emits `autonomy_threshold`. So no parked-but-acceptable point arises mid-sweep, `isConverged()`
stays honest, and the certificate above is unchanged. This §4 fix is still pending — required only when a
phase actually lets the autonomous proposer emit tier-2 (escalation>0) candidates.

**UPDATE (Phase 5 — the box is 3-D but still all tier-1).** [[third-tier1-knob-batching-3d-search]] added
`reminder_batching` as the 3rd autonomous knob, so the box is now cadence×spacing×batching (64 points).
It is still ALL tier-1 (the proposer never emits `autonomy_threshold`; guard re-asserted), so §4 stays
deferred — no parked-but-acceptable point arises. Termination/coverage generalize unchanged:
per-champion coverage = boxSize−1 = 63; the strict North-Star ratchet over the finite cube still bounds
promotions. Point §2 (spread-order outcome-neutral under a box-sufficient budget) is unchanged; loop
fixtures asserting the certificate must use `maxDryIterations >= 64`.
