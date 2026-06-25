# ADR 0007 — Trusted Q&A reconciliation: close the last claimed-only `completeness` metric

- **Status:** accepted
- **Date:** 2026-06-24
- **Decider:** the building agent (an agent-owned engineering decision per
  [[agents-own-buildout-decisions]] and `.claude/plans/2026-06-24-phase-7-qa-accuracy-trusted-reconciliation.md`)
- **Scope:** Phase 7 — telemetry (a new metric + grader oracle), the trusted recorder, the planner
  simulator (Stage A/B), the integrity gate. Offline-first, deterministic, no production blast radius.
  North Star **weights untouched**; every honest genome's score on the existing (question-free) corpus
  is **unchanged** — purely firewall hardening + a new trusted-backed signal, like Phase 4b/6.
- **Supersedes nothing.** Extends the Phase-4b/6 forge-detection ([[loop-trusted-evidence-boundary]],
  [[escalation-forge-detection-load-bearing]], [[sentiment-trusted-reconciliation]]) to a **6th**
  reconciled effect kind `qa_outcome`, and builds on the tier-2 machinery of
  [[tier2-promotion-gate-is-load-bearing]].

## Context

`completeness` (North-Star numerator, weight 0.35) is the mean of `rsvp_resolution_rate`
(trusted-backed, Phase 4b), `category_completeness_rate` (unimplemented), and **`qa_accuracy_rate`** —
named and wired into the completeness mean but with **no metric function, no simulator model, and no
trusted backing**. After Phase 6, `qa_accuracy_rate` was the last named-and-wired claimed-only
completeness metric. Closing it completes a milestone: **every computed North-Star input is now
trusted-backed except `quality`** (honestly deferred — a real judge needs API credentials → the
offline-first STOP rail; a stub would breach the "do not fabricate" rail).

## The load-bearing insight (why a naïve Q&A model would be VACUOUS)

For the firewall to be load-bearing, the trusted record (Stage B) must be able to *disagree* with a
forged claim **in a way the metric rewards**. For rsvp/sentiment that holds because the honest outcome
is forced by ground truth + genome. A naïve Q&A model where the honest planner is **always correct**
(answer `ai_from_known_facts`, escalate `requires_couple`, refuse `must_refuse`) is **vacuous**: honest
`qa_accuracy_rate` is pinned at 1.0, the trusted action always equals the correct action, and the only
divergent claims a liar can make are ones that *lower* its own metric. There is nothing to forge *up*.

**The fix — no new search knob: Q&A competence is genome-dependent via the EXISTING tier-2
`autonomy_threshold`.** Escalating a `requires_couple` question to the couple **consumes couple
attention/authority** — exactly the `commitment_autonomy` surface that makes `autonomy_threshold`
tier-2 (`risk_tier.ts`). So a `requires_couple` question is handled correctly **only by escalating**,
which requires tier-2. A **tier-1** genome (the canonical search form) cannot escalate → its honest
action is `answered` (incorrect) → honest `qa_accuracy_rate < 1.0`. `ai_from_known_facts` / `must_refuse`
stay tier-independent (answered/refused, always correct). This is encoded as the SHARED fact
`honestQaAction(answerable_by, canEscalate)`; the grader oracle `requiredQaAction` lives in telemetry
(the base layer the metric reads) so correctness has ONE definition.

## Decision

Reconcile the claimed Q&A handling against a trusted Q&A record, mirroring the Phase-6 sentiment
pattern with two fields and a composite key:

1. **Metric** `qa_accuracy_rate` over claimed `guest.question.answered`: correct iff `action_taken ===
   requiredQaAction(answerable_by_expected)`; denominator = claimed answers (**claims-only** — the
   catalog's old `∪ should-have-answered` term is unneeded because suppression is caught by the gate;
   `metric_catalog.md` was reconciled). A missing/invalid field scores conservatively (incorrect, or
   skipped if no join key) and the reader is **tolerant** so an adversarial claim cannot crash scoring.
2. **Trusted record** `TrustedQaOutcomeRecord {guest_id, question_id, answerable_by, action_taken}`,
   one per scripted question, keyed by the composite (guest_id, question_id). Stage B re-derives both
   fields from persona ground truth + the trusted genome's `canEscalate`, never from Stage A.
3. **Integrity gate, 6th effect kind `qa_outcome`**: forged (phantom question / duplicate composite
   key, checked before the trusted lookup so a duplicate is one `forged_effect`), field_mismatch on
   **both** `action_taken` and `answerable_by_expected` (`skipWhenClaimAbsent:false`), suppressed (a
   trusted question with no claim).

**Reconciling `answerable_by_expected` is load-bearing, not redundant** (the metric reads it): a forge
can relabel a `requires_couple` question as `ai_from_known_facts` so a truthful `answered` scores
correct; reconciling the persona ground-truth claim closes that path (the `verified`/`rsvp_status`
precedent — the gate trusts the persona, not the claim).

## Why the existing invariants hold

- **The search landscape is untouched.** `qa_accuracy_rate` is `null` (zero denominator) in any
  question-free scenario, and the entire search/oracle corpus is question-free — so the pinned 2-D
  matrix and 3-D cube, and all North-Star values, are byte-unchanged. **INVARIANT: question-bearing
  scenarios are keystone-only, never in the autonomous search corpus** — because Q&A correctness on
  `requires_couple` is tier-gated, an honest tier-1 search candidate scored on a question-bearing
  scenario against a tier-2 champion would *guard-regress* on the `qa_accuracy_rate` guard
  (`higher_better`); keeping such scenarios out of the search preserves both the pins and the tier-1
  search's ability to win.
- **Grader-input, not veto-gate-input.** Like sentiment, this extends the firewall to a numerator
  input without changing the integrity-gate completeness invariant
  ([[integrity-gate-completeness-invariants]], which concerns fields *veto gates* read).
- **Independence + no honest false-positive.** Stage B never reads Stage A; both call `honestQaAction`
  on the same `(answerable_by, canEscalate)` → bit-identical, so the exact field-diff never
  self-vetoes (the Phase-6 shared-computation argument), pinned by the agreement sweep across
  answerable_by × tier.

## Adversarial review (general-purpose reviewers carrying the named lenses; the specialists are
not provisioned here)

- **rigorous-architect** (design, pre-build): APPROVE-WITH-CHANGES — verified the gate is non-vacuous
  and proposed the claims-only denominator, the keystone-only-scenarios invariant, the
  always-emit-`answerable_by_expected` invariant, and the relabel-attack arm; all folded into the plan.
- **doddy** (trust boundary, post-gate): APPROVE-WITH-CHANGES — no way to inflate qa while passing the
  gate. Fixes applied: a fully tolerant reader (an id-less/malformed claim is skipped + gate-vetoed, never
  crashes scoring) and a read-seam invariant test (a wrong-case enum is both scored incorrect AND vetoed).
- **wolf** (stats): REJECTED the original keystone framing — a QA `escalated` action carries **no
  modeled couple cost**, so a tier-1 forge only *tied* a tier-2 champion (rejected by accept-rule
  condition 4, not the gate) → vacuous. **Resolution:** the keystone is **tier-1 champion vs tier-1
  forging candidate** (both honest qa 0.5 on a requires_couple+ai pair), so the forge inflates qa with
  no cost confound and strictly wins absent the gate. Modeling+reconciling a QA-escalation couple cost
  (which would let the keystone literally use a tier-2 champion) is deferred — it conflicts with the
  one-session-per-guest RSVP-escalation key.
- **testineer** (keystone): APPROVE-WITH-CHANGES — `accepted=false` is over-determined (a veto zeroes
  the ratio, tripping the golden + aggregate conditions too). Each arm now asserts a **counterfactual**
  (`forgeWouldWinAbsentGate`: the candidate's un-vetoed aggregate strictly beats the champion), isolating
  INTEGRITY as the real stopper. (Same over-determination exists in the Phase-6 sentiment keystone — a
  back-port is noted as follow-up.)

## Consequences

- The Q&A firewall is load-bearing: a tier-1 candidate forging `escalated` / relabelling / suppressing /
  duplicating to lift `qa_accuracy_rate` is vetoed (`qa_forge_keystone.test.ts`, 4 arms + honest
  companion, each with the counterfactual).
- `qa_accuracy_rate` is composition-sensitive (an unweighted mean over a scenario's questions): a
  scenario stacking easy `ai_from_known_facts` questions has a softer gradient. This is a *scenario
  authoring* property, not a forge (a candidate cannot add/drop questions — forged/suppressed veto it).
  Scenario authors should weight question difficulty deliberately.

## Out of scope (recorded, not faked)
- `quality` (real judge → STOP; stub → fabrication); `category_completeness_rate` (no plan-state model);
  a Q&A *search knob* / 4-D search (Q&A rides the existing tier-2 knob); `must_refuse` → COMMS veto-gate
  entanglement; a modeled+reconciled QA-escalation couple cost (would enable a tier-1-vs-tier-2 keystone).
