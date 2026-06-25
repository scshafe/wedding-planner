# ADR 0006 — Trusted sentiment reconciliation: close the claimed-only `guest_sentiment_score` forge gap

- **Status:** accepted
- **Date:** 2026-06-24
- **Decider:** the building agent (an agent-owned engineering decision per
  [[agents-own-buildout-decisions]] and `.claude/plans/2026-06-24-phase-6-sentiment-trusted-reconciliation.md`)
- **Scope:** Phase 6 — the trusted recorder, the planner simulator (Stage A/B), the integrity gate.
  Offline-first, deterministic, no production blast radius. North Star **weights are untouched**; every
  honest genome's score is **unchanged** (this is purely firewall hardening, like Phase 4b).
- **Supersedes nothing.** It CLOSES deferral **D7** of ADR 0005 / [[escalation-forge-detection-load-bearing]]
  and extends the Phase-4b forge-detection ([[loop-trusted-evidence-boundary]]) to a 5th reconciled effect.

## Context

`guest_sentiment_score` (the mean over claimed `guest.sentiment.sampled` events) is half of the
`guest_experience` North-Star component. Through Phase 5 it had **no trusted backing**:
`domain_facts.ts` literally noted "Comfort is a CLAIMED-ONLY signal." Phase 5's `reminder_batching`
made this load-bearing: its entire *upside* is the comfort-consolidation term
`feltTouches = ceil(received/digestSize)` → fewer nags → gentler sentiment, so batching **enlarges an
unreconciled value the autonomous search optimizes**. A lying planner could inflate a nagged guest's
score, drop an unhappy guest's sample (raising the mean over survivors), forge a phantom-happy guest,
or re-emit a happy guest's sample to re-weight the mean — and lie its way to a higher North Star.

The alternative candidate for this phase — wiring the always-`null` `quality` component (weight 0.4) —
needs either a real Claude judge (API credentials → the offline-first STOP rail) or a fabricated stub
(the "do not simulate/fabricate" rail, and it would add a *new* unbacked claimed-only forge surface).
So sentiment reconciliation — fully offline, load-bearing, on-theme — was the right next move.

Two adversarial design reviews ran (the named specialist sub-agents are not provisioned here; reviews
via `general-purpose` reviewers framed with the **doddy** security/trust-boundary and **wolf**
statistics/numerical lenses). Both approved the core design and **independently found the same hole**
(D5 below), which is fixed.

## Decision

Give `guest_sentiment_score` a trusted backing so the integrity gate reconciles it, mirroring the
Phase-4b pattern for resolution/cost.

### D1 — The sentiment model becomes a SHARED FACT (share the FACT, never the claim path)
The sentiment formula moved out of `stage_a_planner.ts` into `domain_facts.ts` as a pure operator
`honestSentimentScore(needed, delivered, resolved, spacing, batching)` (encapsulating `comfortCeiling`,
`feltTouches`, `penaltyPerNag`, the clamp). Both stages compute the primitives `(needed, delivered,
resolved)` **by their own computation** from the shared facts (`REMINDERS_NEEDED`, `spacingCapacity`,
`effectiveNudges`) and call the shared fact — Stage A to EMIT the claim, Stage B to RECORD the trusted
observation. Stage B never imports Stage A's emission path, so the firewall stays non-vacuous
([[genome-content-address-firewall]], the 4b independence discipline).

### D2 — Stage B records ONE trusted sentiment observation per guest
Stage A samples every guest unconditionally, so Stage B authors one `recordSentimentObservation` per
guest (resolved, pending, never-responder alike). A claimed sample with no trusted observation is then a
forge; a trusted observation with no claim is a suppression.

### D3 — Exact equality is safe by SHARED COMPUTATION, not by dyadic constants (wolf)
The gate field-diffs the claimed `sentiment_score` against the trusted one with exact `!==`. This never
false-positives on an honest run because **both stages call the same pure function on the same inputs →
bit-identical results**. This is a stronger guarantee than "the constants are dyadic": it would hold for
a future non-dyadic constant too. The real protective invariant (wolf, the most fragile assumption):
*sentiment's inputs must be drawn only from `domain_facts` shared facts and computed at an identical
pipeline point in both stages.* Today both compute it from the **reminder-only** `resolved` BEFORE
escalation, so a couple-resolved guest has `resolved=false` for sentiment on both sides — verified
identical across the 64-point cube × 4 latencies by the Step-3 agreement sweep.

### D4 — A GRADER input, not a VETO-GATE input (the completeness invariant is untouched) (doddy)
No veto gate reads sentiment — it feeds the North-Star numerator only. So this does NOT change the
integrity-gate completeness invariant ([[integrity-gate-completeness-invariants]]), which concerns the
fields *veto gates* read. Phase 6 *extends* the firewall from gate-inputs to a grader-input, exactly as
Phase 4b did for resolution/cost. (Documented so a future reader does not conclude sentiment must become
a gate input.)

### D5 — Veto DUPLICATE samples: the mean-re-weighting forge (doddy P0 / wolf P1, independently found)
`guest_sentiment_score` means over **every** emitted sample with no dedup, but the gate keys
reconciliation on a `Set<guest_id>`. So a second sample for an already-reported guest — re-emitting an
honest HIGH score to drag the mean up — passes the field diff (it equals the trusted value) and evades
forged/suppressed. `detectSentimentDivergences` now flags a repeated `guest_id` as a **forged_effect**
(the trusted record observed exactly one sentiment per guest; the honest planner emits exactly one, so
no false positive). This is the firewall-consistent fix — it makes the lie a veto without touching the
production telemetry metric contract. The sibling `rsvp_resolution_rate` avoids this class by using
`distinct` guest sets; sentiment's per-event mean needed the gate to enforce multiplicity instead.

## Consequences

- **The sentiment forge is now load-bearing-vetoed.** The Phase-6 keystone proves four arms — inflate a
  nagged guest's score, suppress an unhappy guest's sample, and duplicate a happy sample (re-weighting) —
  each moves the claimed `guest_sentiment_score` favourably yet produces a NEW integrity failure and is
  rejected. Both genomes are tier-1, so INTEGRITY is the SOLE stopper (no promotion-gate park).
- **Honest runs are unaffected.** Claimed === trusted for every honest genome (bit-identical), so the
  search landscape, the 3-D cube oracle, and the North-Star values are all unchanged.
- **D7 of ADR 0005 is CLOSED for sentiment.** `qa_accuracy_rate` remains a claimed-only deferral (no Q&A
  simulator model backs it); `quality` remains deferred pending an offline-legitimate rubric.

## Alternatives considered (and rejected)
- **Metric-side dedup** (mean over distinct guests) instead of the gate-side duplicate veto: also valid
  and matches the `rsvp_resolution_rate` idiom, but changes the production telemetry metric contract in a
  security phase and makes the duplicate *inert* rather than a *veto* — weaker than "make the lie a veto
  failure," the integrity gate's stated philosophy. Recorded as the fallback if the metric is ever
  consumed before the gate runs.
- **Wiring `quality` this phase:** STOP rail (real judge) or fabrication rail (stub). Deferred.
- **Tolerance-based sentiment diff** instead of exact equality: unnecessary given bit-identity (D3), and
  a tolerance would hide a real divergence. Rejected.
