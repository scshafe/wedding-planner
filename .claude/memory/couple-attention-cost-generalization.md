---
name: couple-attention-cost-generalization
description: Phase 9 — generalize couple_session to a per-(reason, about_id) key; model + reconcile the booking-approval & qa-escalation couple-attention cost; closes the Phase 7/8 deferral; unblocks the quality capstone
metadata:
  type: project
---

**Phase 9 generalized the couple-attention COST firewall** from RSVP-only (Phase 4b) to a per-`(reason,
about_id)` composite key carrying **three reasons**: `rsvp_escalation` (guest_id), `qa_escalation`
(question_id), `booking_approval` (category_id). It **closes the deferral ADR 0007 (Q&A) and ADR 0008
(category) both flagged** — escalating to the couple now costs couple attention
(`couple.session.ended → active_seconds → couple_active_minutes_total → effort_cost`, the North-Star
denominator), not just RSVP escalation. It is the **prerequisite for the `quality`/`vision_match`
capstone** (the only remaining unbuilt computed North-Star input): a legitimate, load-bearing vision_match
needs the planner to consult the couple AT A COST to raise selection quality — the Goodhart guard
`scoring_model.md` names — which is only meaningful once consultation has a reconciled cost.

**The load-bearing insight (same shape as [[qa-accuracy-trusted-reconciliation]] /
[[category-completeness-trusted-reconciliation]]):** the cost is non-vacuous because it is incurred ONLY
when the planner takes the couple's commitment-authority, which requires the EXISTING tier-2
`autonomy_threshold` (`canEscalate`). Shared facts in `domain_facts.ts`:
`honestBookingApprovalSession(requiresCoupleApproval, canEscalate)` = `requiresCoupleApproval &&
canEscalate` (NOT `honestCategoryStatus === 'booked'` — an approval-FREE category books autonomously at
NO couple cost; architect P1) and `honestQaEscalationSession(answerableBy, canEscalate)` =
`honestQaAction === 'escalated'`. Both stages compute them on the SAME trusted genome → bit-identical →
no honest self-veto. **The forge:** a TIER-2 candidate that books/escalates honestly (keeps the tier-2
completeness/qa_accuracy) but SHAVES (`field_mismatch`) or SUPPRESSES (`suppressed_effect`) the couple
cost → lower denominator → higher ratio absent the gate, vetoed with it. The keystone is **tier-2 vs
tier-2** (cleaner than the tier-1-vs-tier-1 category/Q&A keystones: planning_value is held fixed so
`effort_cost` is the SOLE mover, and a single immediate guest excludes the rsvp_escalation confound).

**Non-obvious, carry forward:**
- **The metric `couple_active_minutes_total` is reason-AGNOSTIC — it SUMS `active_seconds` across every
  session** (`metric_definitions.ts:61`). So `session_reason`/`about_id` are JOIN-KEY fields, not
  magnitude fields; only `active_seconds` is field-diffed. A reason-relabel is caught DOUBLY (forged on
  the wrong key + suppressed on the real one), so no separate reason-diff is needed.
- **NO duplicate-as-forge arm (deliberate asymmetry from category/sentiment):** a SUMMED cost makes a
  duplicate self-harm (it ADDS cost), so it is not a forge. doddy confirmed it cannot interact with
  suppression detection to lower cost.
- **Uniform `active_seconds` (600) is what keeps a relabel cost-NEUTRAL today.** The composite key keeps
  relabel CAUGHT even under future per-reason magnitudes — but such a phase MUST keep `session_reason` in
  the key (don't enshrine "reason is cosmetic"). The gate's in-set key string `${reason}/${about_id}` is
  unambiguous ONLY because reasons are slash-free (documented at the call site).
- **Byte-identity on the search corpus** holds because new sessions fire only on category/question-bearing
  KEYSTONE-ONLY scenarios (tier-1 search candidates can't escalate). Phase 9 does NOT move those into the
  search corpus (separate decision) — but with the cost modeled, a future keystone MAY use a literal
  tier-2 champion, strengthening Phase 7/8.
- **doddy P2 — FIXED in Phase 10 (and the old rationale CORRECTED):** `readCoupleSessionEndedPayload` used
  to THROW on absent/NaN active_seconds. The Phase-9 note claimed this was safe because "the gate vetoes
  before the metric runs" — that ordering claim is **factually wrong**: `offline_scorer` runs `runVetoGates`
  AND `computeMany` UNCONDITIONALLY and sequentially (the veto does NOT prevent the throw), so a malformed
  active_seconds CRASHED scoring of the whole run (a DoS, not a score-lift — the run never passes). Phase 10
  widened the trigger surface (the `vision_consult` reason = a 4th session emit site) and FIXED it: the
  reader is now tolerant (null → 0-minute contribution); the gate still vetoes the malformed session via its
  OWN raw `readNumber` (`skipWhenClaimAbsent:false`), so the firewall is unweakened. See [[vision-match-trusted-reconciliation]].
- **Keystones live in `loop-orchestrator/tests/loop/`, NOT `eval-harness/tests/`** — `forgeWouldWinAbsentGate`
  / `onlyIntegrityFailed` are LOCAL helpers per keystone file (not exported). A grep over `eval-harness/`
  alone misses them (this tripped both the architect lens and the first pass this run).

See `docs/adr/0009-couple-attention-cost-generalization.md` and
`.claude/plans/2026-06-25-phase-9-couple-attention-cost-generalization.md`. Related:
[[escalation-forge-detection-load-bearing]], [[qa-accuracy-trusted-reconciliation]],
[[category-completeness-trusted-reconciliation]], [[tier2-promotion-gate-is-load-bearing]],
[[loop-trusted-evidence-boundary]], [[integrity-gate-completeness-invariants]].
