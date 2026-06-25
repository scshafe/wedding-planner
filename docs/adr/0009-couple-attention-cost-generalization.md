# ADR 0009 — Trusted couple-attention cost: generalize `couple_session` to booking-approval & Q&A escalation

- **Status:** accepted
- **Date:** 2026-06-25
- **Decider:** the building agent (an agent-owned engineering decision per
  [[agents-own-buildout-decisions]] and `.claude/plans/2026-06-25-phase-9-couple-attention-cost-generalization.md`)
- **Scope:** Phase 9 — the telemetry couple-session vocabulary, the trusted recorder + record, the
  planner simulator (Stage A/B), the integrity gate. Offline-first, deterministic, no production blast
  radius. North Star **weights untouched**; every honest genome's score on the existing
  (category/question-free) search corpus is **byte-identical** — purely firewall hardening + a new
  trusted-backed cost signal, like Phase 4b/6/7/8.
- **Supersedes nothing.** Generalizes the Phase-4b RSVP couple-session reconciliation
  ([[escalation-forge-detection-load-bearing]]) to a per-`(reason, about_id)` key carrying **two new
  reasons**, closing the deferral that ADR 0007 (Q&A) and ADR 0008 (category) both recorded.

## Context

Escalating to the couple consumes the couple's scarce commitment-authority — the cost side of the
escalate-to-couple tradeoff, feeding `couple.session.ended → active_seconds → couple_active_minutes_total
→ effort_cost` (the North-Star denominator). **Phase 4b modeled this cost for RSVP escalation only.**
Phase 7 (Q&A escalation) and Phase 8 (booking approval) each ADDED a tier-2-gated escalation but charged
it **no couple cost**, and both ADRs flagged the same gap as their cleanest follow-on: *"the deferred
booking-approval cost and the keystone-only invariant are ONE constraint"* — if a category/question
scenario ever entered the autonomous search corpus before the cost was modeled, a tier-2 genome would
show a **FREE completeness / qa_accuracy gain**. The trusted couple-session record was also keyed **per
guest** (`coupleSessionsByGuestId`), a key that collides once a guest carries more than one escalation
reason and cannot represent a category escalation at all.

This phase is also the **prerequisite for the `quality` capstone** (still `null`, the largest unbuilt
value lever). A legitimate, load-bearing `vision_match` signal needs a degree of freedom that did not
exist: the planner consulting the couple **at a cost** to raise selection quality — exactly the Goodhart
guard `scoring_model.md` names (*"couple_active_minutes ↓ → guard: vision_match"*). That guard is only
meaningful once consultation HAS a reconciled cost. Phase 9 builds that surface.

## The load-bearing insight (why the new cost is non-vacuous)

The cost must be genome-dependent so the trusted record can *disagree* with a forge **in a way the North
Star rewards** (a cost to forge DOWN). A couple session is incurred ONLY when the planner actually takes
the couple's commitment-authority, which requires the EXISTING tier-2 `autonomy_threshold` (`canEscalate`):

- A **tier-2** genome that honestly books a `requires_couple_approval` category incurs a
  `booking_approval` session; a **tier-1** genome defers it (no booking, no cost) — consistent.
- A **tier-2** genome that honestly escalates a `requires_couple` question incurs a `qa_escalation`
  session; a tier-1 genome answers it (no escalation, no cost).
- An **approval-FREE** category is booked autonomously at any tier with **no** couple cost — so the
  predicate is `requires_couple_approval && canEscalate`, NOT `honestCategoryStatus === 'booked'`
  (architect P1: an approval-free booked category must charge nothing).

Encoded as the SHARED facts `honestBookingApprovalSession(requiresCoupleApproval, canEscalate)` and
`honestQaEscalationSession(answerableBy, canEscalate)` (= `honestQaAction === 'escalated'`) in
`domain_facts.ts`. Both stages call them on the SAME trusted genome, so an honest run reconciles
bit-identically and never self-vetoes (the Phase-6 shared-computation argument).

**The forge this makes load-bearing (the new surface):** a **tier-2** candidate that books the approval
category / escalates the question (keeping the tier-2 completeness / qa_accuracy) but **shaves or
suppresses** the couple-attention cost — tier-2 outcomes at sub-tier-2 cost → lower `effort_cost` →
higher ratio. The trusted record holds the honest cost, so a shaved `active_seconds` → field_mismatch, a
dropped session → suppressed_effect → veto. Absent the gate it strictly dominates the honest champion;
with the gate it is rejected. That is the keystone (`couple_cost_forge_keystone.test.ts`).

## Decision

Generalize the couple-session reconciliation to one mechanism, three reasons:

1. **Vocabulary** `CoupleSessionReason = 'rsvp_escalation' | 'qa_escalation' | 'booking_approval'`
   (telemetry base layer, validated by `COUPLE_SESSION_REASONS`).
2. **Composite key** `(session_reason, about_id)` where `about_id` is a guest_id (rsvp), question_id
   (qa), or category_id (booking). The recorder keys by this tuple; the RSVP path passes
   `rsvp_escalation` + guest_id and reconciles identically.
3. **Shared honest-cost facts** (above) that Stage A emits from and Stage B records from.
4. **Integrity gate** keyed on `(session_reason, about_id)`: missing-join-field → unknown-reason
   (forged) → no-trusted (forged) → field_mismatch on `active_seconds` (`skipWhenClaimAbsent:false`) →
   suppressed. A reason-relabel is caught DOUBLY (forged on the wrong key + suppressed on the real one).

### Why two reconciliation properties suffice (and what is deliberately NOT diffed)

- The metric `couple_active_minutes_total` is reason-agnostic — it SUMS `active_seconds` across every
  session — so `session_reason`/`about_id` are JOIN-KEY fields, not magnitude fields. They are not
  separately field-diffed: a wrong reason/about_id changes the join target, surfacing as forged +
  suppressed (strictly stronger than a field_mismatch). Diffing them would be redundant.
- **No duplicate-as-forge arm** (deliberate asymmetry from category/sentiment): the metric SUMS, so a
  duplicate `(reason, about_id)` ADDS cost — self-harm for the forger, never a lift. Confirmed safe by
  doddy (a duplicate cannot interact with the `claimedKeys` set or suppression detection to lower cost).
- **Uniform `active_seconds` is what keeps a reason-relabel cost-NEUTRAL today** (no cheaper bucket). The
  composite key keeps relabel CAUGHT even if a future phase differentiates per-reason magnitudes — but
  that phase MUST keep `session_reason` in the key. Do not enshrine "reason is purely cosmetic."

## Why the existing invariants hold

- **Byte-identity on the search corpus.** New sessions fire ONLY when a `requires_couple_approval`
  category is booked or a `requires_couple` question is escalated — both KEYSTONE-ONLY (Phase 7/8:
  `required_categories` / `guest_persona.questions` are absent from the search corpus, and tier-1 search
  candidates cannot escalate). Asserted directly (`stage_couple_session.test.ts`: zero new sessions on
  the category/question-free corpus); the metamorphic cube/matrix and all North-Star values are unchanged.
- **The Phase-4b RSVP path is behaviorally unchanged** — same event, same metric contribution, same
  reconciliation; it now just carries an explicit `session_reason: 'rsvp_escalation'`.
- **Keystone-only stays the structural invariant.** This phase models the cost but does NOT move
  category/question scenarios into the search corpus. With the cost modeled, a future keystone MAY use a
  literal tier-2 champion (the tier-1 forge now dodges a real cost), strengthening Phase 7/8 — optional.
- **Grader/denominator input, not a NEW veto-gate input** — extends the firewall to a North-Star
  denominator without changing the integrity-gate completeness invariant
  ([[integrity-gate-completeness-invariants]], which concerns fields VETO gates read).

## Adversarial review (general-purpose reviewers carrying the named lenses; the specialists are not
provisioned here)

- **rigorous-architect** (design, pre-build): APPROVE-WITH-CHANGES — folded in: gate the booking session
  on `requires_couple_approval && canEscalate` (not `booked`); the metric throws on absent active_seconds
  (use present-but-lower / event-drop in tests, never absent); multi-reason co-present honest sweep;
  enumerated test migrations. (Also surfaced, then corrected by me: the keystones live in
  `loop-orchestrator/tests/loop/`, not `eval-harness/` — the helpers DO exist; the handoff was accurate.)
- **doddy** (trust boundary, post-gate): **APPROVE**, no P0/P1 — no way to lower
  `couple_active_minutes_total` while passing the gate (shave/suppress/forge/relabel all veto; duplicate
  self-harms a summed cost; the gate verdict is computed before the metric). P2 applied: documented the
  slash-free-reason invariant the gate's key-string relies on. P2 noted (not exploitable, pre-existing):
  `readCoupleSessionEndedPayload` throws on absent active_seconds rather than degrading tolerantly like
  the qa/category readers — fail-stop, and the gate vetoes absent active_seconds first.
- **testineer** (keystone): APPROVE-WITH-CHANGES — verified the counterfactual is sound and quantitatively
  isolated (planning_value held fixed, effort is the sole mover; the honest tie is empirical, not
  assumed; rsvp_escalation confound structurally excluded). Applied: a NEAR-MISS shave arm (599 vs 600)
  pinning the field diff as EXACT equality.

## Consequences

- The couple-attention cost firewall is load-bearing across all three reasons: a candidate shaving /
  suppressing a booking_approval / qa_escalation / rsvp_escalation cost to lower `effort_cost` is vetoed
  (`couple_cost_forge_keystone.test.ts`, 6 arms; `integrity_rsvp_couple.test.ts` gate-level arms).
- The Phase-7/Q&A and Phase-8/category deferred costs are CLOSED via one generalized surface.
- The `vision_match`/`quality` capstone is now UNBLOCKED — the consultation-cost degree of freedom it
  needs exists and is reconciled.
- Back-ported `forgeWouldWinAbsentGate` + `onlyIntegrityFailed` to the Phase-6 sentiment keystone (lever 3).

## Out of scope (recorded, not faked)
- `quality` / `vision_match` (the capstone this unblocks — its own phase: judge→STOP or a ground-truth
  rubric riding this cost surface); moving category/question scenarios into the search corpus (now
  possible, but a separate guard/spread decision); per-reason DISTINCT cost magnitudes / a couple-attention
  budget cap (a scenario-authoring refinement — but would require keeping `session_reason` in the key, and
  reconsidering whether a relabel becomes a live shave); a tolerant `readCoupleSessionEndedPayload`.
