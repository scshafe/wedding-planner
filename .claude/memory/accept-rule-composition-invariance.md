---
name: accept-rule-composition-invariance
description: "An accept rule over a corpus must pin composition-invariance, not just per-condition pass/fail — else the candidate games the estimand by adding/dropping scenarios"
metadata: 
  node_type: memory
  type: project
  originSessionId: e797abb3-1adc-4d2b-9538-a31f279a8220
---

From testineer's review of the Phase-1 offline accept rule (it ran probes against the real code and
found a confirmed P0). Generalizable to any A/B-style accept rule over a mutable corpus, including the
later production experiment engine.

**The hole:** the offline accept rule compared `weightedMeanRatio(candidateRuns)` vs
`weightedMeanRatio(baselineRuns)` over *whichever scenarios each set contained*. A candidate could
then game condition 4 (aggregate North Star improves) by **adding easy scenarios** (inflate the mean)
or **dropping hard ones** (remove the drag), and a candidate-only scenario **bypassed the guard
check** (condition 3 skipped scenarios absent from baseline). This is the canonical Goodhart /
specification-gaming attack the scoring model exists to stop — the estimand was "mean over the set the
candidate chose," not "mean over the fixed corpus."

**The fix:** the candidate must be scored across the WHOLE corpus, so `evaluateAcceptRule` now requires
candidate and baseline to cover the **same scenario_id set**; a mismatch is not evaluable → reject
(`corpus_mismatch`). Closed both the aggregate-gaming and the guard-bypass with one invariant.

**Why / how to apply:** when building ANY accept gate over a corpus (offline OR the production
experiment engine), the estimand must be fixed by the harness, never by the thing under test. Pin
**composition-invariance** in tests (add/drop a scenario → reject), not just per-condition pass/fail.
Sibling lesson to [[integrity-gate-completeness-invariants]]: there, the gate's field coverage must
equal its input surface; here, the aggregate's scenario set must equal the fixed corpus. Both are
"the gate's scope must be controlled by the harness, not the gradee."

Also fixed alongside: `computeNorthStar` now throws on an out-of-[0,1] component (a tripwire for the
future metric→component normalization layer, which will feed unbounded indices like
`quality_per_dollar_index`).
