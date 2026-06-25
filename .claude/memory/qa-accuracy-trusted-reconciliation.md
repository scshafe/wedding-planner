---
name: qa-accuracy-trusted-reconciliation
description: "Phase-7 — qa_accuracy_rate is now trusted-backed (6th integrity effect kind qa_outcome): the gate reconciles every claimed guest.question.answered (action_taken + answerable_by_expected) against a per-question trusted Q&A outcome; the firewall is load-bearing ONLY because Q&A competence is genome-dependent via the EXISTING tier-2 autonomy_threshold"
metadata:
  node_type: memory
  type: project
---

Phase 7 gave **`qa_accuracy_rate`** (a third of the `completeness` North-Star component, the LAST
named-and-wired claimed-only completeness metric) a **trusted backing**, extending the Phase-4b/6
forge-detection to a **6th reconciled effect kind (`qa_outcome`)**. **Milestone: every computed
North-Star input is now trusted-backed except `quality`** (deferred — real judge → STOP rail; stub →
fabrication rail). See `docs/adr/0007`. Builds on [[sentiment-trusted-reconciliation]],
[[escalation-forge-detection-load-bearing]], [[tier2-promotion-gate-is-load-bearing]].

**The load-bearing insight (the non-obvious part).** A naïve Q&A model where the honest planner is
ALWAYS correct (answer ai / escalate couple / refuse trap) makes the gate **VACUOUS**: honest qa is
pinned at 1.0, trusted action == correct action always, so the only divergent claims a liar can make
LOWER its own metric — nothing to forge *up*. The firewall is load-bearing ONLY because **Q&A
competence is genome-dependent via the EXISTING tier-2 `autonomy_threshold` knob** (no new search knob):
a `requires_couple` question is handled correctly only by ESCALATING (which consumes couple
attention/authority — the `commitment_autonomy` tier-2 surface), so a **tier-1** genome honestly
ANSWERS it (incorrect, qa < 1.0). The shared fact `honestQaAction(answerable_by, canEscalate)` encodes
this; `canEscalate = autonomy_threshold !== undefined`. The grader oracle `requiredQaAction` lives in
**telemetry** (the base layer the metric reads) so correctness has ONE definition; `honestQaAction`
(eval-harness `domain_facts`) builds on it.

**The mechanism.** Stage A emits one `guest.question.answered` per scripted question (always with
`answerable_by_expected`); Stage B records one `TrustedQaOutcomeRecord {guest_id, question_id,
answerable_by, action_taken}` per question (from persona ground truth + the TRUSTED genome's
`canEscalate`, never Stage A). The metric `qa_accuracy_rate` = correct ÷ answered (CLAIMS-only; correct
= `action_taken === requiredQaAction(answerable_by_expected)`). The gate's `qa_outcome` keys by the
composite (guest_id, question_id) and field-diffs BOTH fields the metric reads.

**Load-bearing facts (non-obvious, easy to get wrong):**

1. **Reconciling `answerable_by_expected` is load-bearing, not redundant.** The metric reads it, so a
   relabel forge (call a `requires_couple` question `ai_from_known_facts` → a truthful `answered` scores
   correct, no escalation) is closed ONLY by diffing it against the trusted persona truth. Diffing
   `action_taken` alone misses it. (The `verified`/`rsvp_status` precedent — gate trusts the persona,
   not the claim.)
2. **The per-question denominator needs the duplicate-as-forge guard, checked BEFORE the trusted
   lookup** (mirror `detectSentimentDivergences`), so a duplicate yields ONE `forged_effect` not also a
   `field_mismatch`. Same class as the Phase-6 sentiment mean: a per-event aggregator + an id-SET key
   needs duplicates vetoed.
3. **The metric reader is fully TOLERANT** (every field enum-or-null, ids included): an
   adversarial/malformed claim scores conservatively (incorrect, or skipped if no join key) and is
   gate-vetoed, but NEVER crashes scoring (which runs metrics even after a gate fails). The gate keeps
   its OWN raw read; a read-seam invariant test pins that a present-but-invalid enum is BOTH scored
   incorrect AND vetoed (safe today by the bijection, but unguarded otherwise).
4. **INVARIANT: question-bearing scenarios are KEYSTONE-ONLY — never in the autonomous search corpus.**
   Q&A is `null` in question-free scenarios (so the pinned cube/matrix are byte-unchanged), and Q&A
   correctness on `requires_couple` is tier-gated, so an honest tier-1 search candidate on a
   question-bearing scenario would *guard-regress* on the `qa_accuracy_rate` guard vs a tier-2 champion.
   Keeping them out preserves both the pins and the tier-1 search's ability to win.
5. **The keystone is tier-1-vs-tier-1, not tier-1-vs-tier-2** (wolf P0): the QA `escalated` action
   carries NO modeled couple cost, so a tier-1 forge only TIES a tier-2 champion (rejected by
   accept-rule condition 4, not the gate → vacuous). Using two tier-1 genomes (both honest qa 0.5 on a
   requires_couple+ai pair) lets the forge inflate qa with NO cost confound and strictly win absent the
   gate. **A vetoed run zeroes the ratio, over-determining `accepted=false`** (it also trips the golden
   + aggregate conditions) — so the keystone asserts a COUNTERFACTUAL (`forgeWouldWinAbsentGate`: the
   candidate's UN-vetoed aggregate strictly beats the champion) to isolate INTEGRITY as the real
   stopper. (The Phase-6 sentiment keystone shares this over-determination — back-port the counterfactual
   is a noted follow-up.)

**Honest runs are unaffected** (claimed === trusted by shared computation), so the search landscape and
all North-Star values are unchanged — purely firewall hardening + a new trusted-backed signal. **Still
deferred:** `quality` (judge → STOP / stub → fabrication), `category_completeness_rate` (no plan-state
model), a Q&A search knob / 4-D search (Q&A rides the tier-2 knob), and a modeled+reconciled
QA-escalation couple cost (would let the keystone use a literal tier-2 champion; conflicts with the
one-couple-session-per-guest RSVP-escalation key).
