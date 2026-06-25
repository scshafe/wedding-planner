---
name: sentiment-trusted-reconciliation
description: "Phase-6 — guest_sentiment_score is now trusted-backed: the integrity gate reconciles every claimed sentiment sample (inflate/suppress/forge/duplicate) against a per-guest trusted observation Stage B authors via the shared honestSentimentScore fact; closes ADR-0005 deferral D7"
metadata:
  node_type: memory
  type: project
---

Phase 6 gave **`guest_sentiment_score`** (half of the `guest_experience` North-Star component) a
**trusted backing**, extending the Phase-4b forge-detection to a **5th reconciled effect kind
(`guest_sentiment`)**. It CLOSES deferral **D7** of ADR 0005 / [[escalation-forge-detection-load-bearing]]
and [[third-tier1-knob-batching-3d-search]] (batching's comfort upside flows entirely through this
metric, so Phase 5 had *enlarged* a claimed-only forge surface). See `docs/adr/0006`. Builds on
[[loop-trusted-evidence-boundary]], [[genome-content-address-firewall]].

**The mechanism.** The sentiment formula moved into `domain_facts.ts` as the SHARED pure fact
`honestSentimentScore(needed, delivered, resolved, spacing, batching)`. Both stages compute the
primitives `(needed, delivered, resolved)` by their OWN computation from the shared facts and call it:
Stage A to EMIT the `guest.sentiment.sampled` claim, Stage B (`observeTrustedRecord`, via its own
`guestReach` helper) to RECORD one trusted observation PER GUEST. Stage B never imports Stage A's
emission path, so the gate stays non-vacuous. The gate field-diffs claimed `sentiment_score` vs trusted
with **exact `!==`**.

**Load-bearing facts (non-obvious, easy to get wrong):**

1. **Exact equality is safe by SHARED COMPUTATION, not by dyadic constants.** Both stages call the same
   pure function on the same inputs → BIT-IDENTICAL results, so honest runs never self-veto. This is
   stronger than "the penalty constants are dyadic" — it holds for a future non-dyadic constant too. The
   real invariant: *sentiment's inputs must come only from `domain_facts` shared facts and be computed at
   an identical pipeline point in both stages.* Today both use the **reminder-only** `resolved` computed
   BEFORE escalation (a couple-resolved guest has `resolved=false` for sentiment on both sides). If a
   future phase makes sentiment depend on couple-resolution / `autonomy_threshold` / any quantity one
   stage computes differently, the exact diff will false-positive every honest run. The Step-3 agreement
   sweep (`stage_b_observer.test.ts`) pins trusted == claimed across the 64-cube × 4 latencies.

2. **The integrity gate keys per-effect by an id-SET; any per-event aggregator (mean/sum) needs
   multiplicity handled or duplicates are a free metric move.** `guest_sentiment_score` means over EVERY
   emitted sample (no dedup), so a DUPLICATE sample for an already-reported guest re-weights the mean
   while passing the field diff. doddy + wolf found this independently. Fix: `detectSentimentDivergences`
   flags a repeated `guest_id` as a `forged_effect` (the honest planner emits exactly one sample/guest →
   no false positive). The sibling `rsvp_resolution_rate` dodges this class via `distinct` guest sets —
   **the next per-event mean/sum metric added MUST either dedup by its id or have duplicates vetoed.**

3. **Sentiment is a GRADER input, not a VETO-GATE input.** It feeds only the North-Star numerator, so it
   does NOT change the integrity-gate completeness invariant ([[integrity-gate-completeness-invariants]],
   which concerns fields *veto gates* read). Phase 6 extends the firewall from gate-inputs to a
   grader-input, as 4b did for resolution/cost — do not conclude sentiment must become a gate input.

4. **The keystone (`loop-orchestrator/.../sentiment_forge_keystone.test.ts`) has FOUR forge arms**, all
   tier-1 (INTEGRITY is the sole stopper, no promotion-gate park): inflate a nagged guest's score,
   suppress the unhappy guest's sample, and duplicate a happy sample (RED measured vs the candidate's
   HONEST claim, since a re-weight can't exceed 1.0). Companion arm: the honest candidate is gate-clean.

**Honest runs are unaffected** (claimed === trusted), so the search landscape, the 3-D cube oracle, and
all North-Star values are unchanged — purely firewall hardening. **Still deferred:** `qa_accuracy_rate`
(no Q&A simulator model) and the `quality` component (a real judge → STOP rail; a stub → fabrication
rail) — both acknowledged, not faked.
