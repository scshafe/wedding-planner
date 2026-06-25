# Handoff

## Where things stand — Phase 9 (trusted couple-attention cost generalization) is BUILT ✅
`.claude/plans/2026-06-25-phase-9-couple-attention-cost-generalization.md` is **complete — all steps
ticked** (Step 0 design review + Steps 1–9), on branch **`build/phase-3-generalize-search`** (the open
review artifact for `main`; Phases 3/4a/4b/5/6/7/8/9 build on it; the loop's merge-keeper advances `main`
when green). Working tree clean. `npm run build && npm test && npm run lint` all green (**350 tests**, up
from 330 at the start of this run). `main` has Phase 1+2; this branch is the review artifact for Phases
3, 4a, 4b, 5, 6, 7, 8 **and 9**.

**What changed:** the couple-attention COST firewall went from **RSVP-only** (Phase 4b) to a generalized
per-`(session_reason, about_id)` key carrying **three reasons** — `rsvp_escalation` (guest_id),
`qa_escalation` (question_id), `booking_approval` (category_id). Phase 7 (Q&A) and Phase 8 (category)
each added a tier-2-gated escalation but charged it **no couple cost**; both ADRs flagged that as "ONE
constraint." This phase **closes both deferrals via one surface**: escalating to the couple now costs
couple attention (`couple.session.ended → active_seconds → couple_active_minutes_total → effort_cost`,
the North-Star denominator). Honest runs on the existing (category/question-free) search corpus are
**byte-identical** — the new sessions fire only on keystone-only scenarios (tier-1 search candidates
can't escalate). See `docs/adr/0009`. Encoded in memory [[couple-attention-cost-generalization]].

### The load-bearing insight (carry forward — same shape as Phase 7/8)
The cost is non-vacuous because it is incurred ONLY when the planner takes the couple's
commitment-authority, which requires the EXISTING tier-2 `autonomy_threshold` (`canEscalate`). Shared
facts `honestBookingApprovalSession(requiresCoupleApproval, canEscalate)` (= `requiresCoupleApproval &&
canEscalate` — NOT `honestCategoryStatus === 'booked'`; an approval-FREE category books at NO couple cost)
and `honestQaEscalationSession` (= `honestQaAction === 'escalated'`). The forge: a **tier-2** candidate
that books/escalates honestly (keeps the tier-2 completeness/qa_accuracy) but **shaves/suppresses** the
couple cost → lower denominator → higher ratio absent the gate, vetoed with it. The keystone is **tier-2
vs tier-2** (cleaner than Phase 7/8: planning_value held fixed → `effort_cost` is the SOLE mover).

### What's new this phase (by step)
- **Step 0** — architect-lens design review (APPROVE-WITH-CHANGES; all folded in). NB: it AND my first
  grep searched only `eval-harness/` and wrongly concluded the keystone helpers don't exist — they live
  in `loop-orchestrator/tests/loop/`; corrected mid-run.
- **Steps 1–2** — `CoupleSessionReason` vocab; `TrustedCoupleSessionRecord` + recorder + gate rekeyed to
  the composite `(session_reason, about_id)`; RSVP path migrated `about_guest_id → about_id` +
  `session_reason:'rsvp_escalation'` byte-identically. Reason-relabel caught as forged+suppressed; NO
  duplicate-as-forge arm (a SUMMED cost makes a duplicate self-harm).
- **Steps 3–4** — shared honest-cost facts; Stage A emits + Stage B records one session per honest
  booking-approval / qa-escalation; byte-identity on the search corpus asserted.
- **Step 6** — honest-run audit (zero divergences, reason × tier) + a MULTI-REASON CO-PRESENT scenario
  (rsvp+qa+booking coexist via the composite key — the OLD per-guest key could not) + read-seam.
- **Step 7** — `couple_cost_forge_keystone.test.ts` (loop-orchestrator): shave + suppress × {booking,qa}
  + a near-miss shave (599 vs 600) + honest companion, each with `forgeWouldWinAbsentGate` +
  `onlyIntegrityFailed`. **doddy APPROVE** (no P0/P1; documented the slash-free-reason invariant).
  **testineer APPROVE-WITH-CHANGES** (added the near-miss arm).
- **Step 8** — back-ported `forgeWouldWinAbsentGate` + `onlyIntegrityFailed` to the Phase-6 sentiment
  keystone (the handoff's lever 3); the bounded duplicate arm keeps its RED-vs-honest counterfactual.
- **Step 9** — `docs/adr/0009` + memory [[couple-attention-cost-generalization]] + this handoff.

## Next action — your call. The big remaining levers (ranked)
- **`quality` / `vision_match` North-Star component** (weight 0.40, still `null`) — THE capstone, now
  UNBLOCKED. Phase 9 built the missing degree of freedom: the planner can consult the couple at a
  reconciled cost to raise selection quality (the Goodhart guard `scoring_model.md` names). A legitimate
  offline design: give each booked category a ground-truth couple preference (`couple.vision` /
  `budget.category_priorities`), let the genome OPTIONALLY consult the couple on a category to align the
  selection (paying a `booking_approval`-style couple cost), and score `vision_match` = alignment of the
  booked selection vs the preference, reconciled like category/qa (an 8th effect kind, or extend
  category_booking with a `vision_match` field). This is genome-dependent (consult → aligned but costs;
  don't-consult → partial) and INDEPENDENT of completeness (the category is booked either way), so it is
  a real, load-bearing value signal — NOT a stub and NOT a judge (no API credentials). Design it with the
  architect lens first; if a clean design needs a real Claude judge, STOP-and-surface (offline-first).
  This completes the "every computed North-Star input trusted-backed" arc.
- **Move category/question scenarios INTO the search corpus** — now POSSIBLE (the cost is modeled, so a
  tier-2's completeness/qa gain is offset by a real couple cost). Needs a guard/spread analysis (the
  keystone-only invariant was partly the missing cost; what remains is the search-landscape decision) and
  likely makes `category_completeness_rate` / `qa_accuracy_rate` active search guards. Search-breadth value.
- **A 4th tier-1 knob → 4-D search** — more search generalization; lower marginal value than `quality`.

## Non-obvious Phase-9 context (carry forward)
- **The metric `couple_active_minutes_total` is reason-AGNOSTIC (SUMS active_seconds);** so reason/about_id
  are JOIN-KEY-only (only `active_seconds` is field-diffed), a relabel is caught as forged+suppressed, and
  there is no duplicate-as-forge (a summed cost self-harms on duplicate).
- **Uniform `active_seconds` (600) keeps a relabel cost-NEUTRAL today.** A future per-reason-magnitude
  phase MUST keep `session_reason` in the key (the composite key still catches relabel; the gate's
  `${reason}/${about_id}` string is unambiguous ONLY because reasons are slash-free — documented at the
  call site).
- **doddy P2 (not exploitable, pre-existing):** `readCoupleSessionEndedPayload` THROWS on absent
  active_seconds (unlike the tolerant qa/category readers). Fail-stop; the gate vetoes absent active_seconds
  first. A tolerant reader is the clean follow-on (recorded in ADR 0009 Out-of-scope).
- **Keystones live in `loop-orchestrator/tests/loop/`** (not `eval-harness/tests/`);
  `forgeWouldWinAbsentGate` / `onlyIntegrityFailed` are LOCAL helpers per file. Grep the whole repo, not
  just `eval-harness/`, when looking for the full-North-Star counterfactual machinery.
- **CI/exit-code lesson (still true):** never pipe `npm run build` to tail/grep when gating with `&&` —
  the pipe masks the build's non-zero exit. Run build standalone and check `$?`. Also: `npm run build`
  must run from the REPO ROOT (the eval-harness workspace has no `build` script).
- The repo's named specialist sub-agents (doddy/wolf/testineer/rigorous-architect) are **not provisioned**
  here — route adversarial reviews through `general-purpose` agents carrying the persona lens (this run
  did, for architect at design, doddy at the gate, testineer at the keystone).
- Durable facts: `MEMORY.md` index — Phase 9 added **[[couple-attention-cost-generalization]]**. Still
  load-bearing: [[category-completeness-trusted-reconciliation]], [[qa-accuracy-trusted-reconciliation]],
  [[sentiment-trusted-reconciliation]], [[escalation-forge-detection-load-bearing]],
  [[tier2-promotion-gate-is-load-bearing]], [[genome-content-address-firewall]],
  [[loop-trusted-evidence-boundary]], [[integrity-gate-completeness-invariants]],
  [[accept-rule-composition-invariance]], [[second-genome-knob-must-stay-tier1]],
  [[search-convergence-certificate-semantics]], [[third-tier1-knob-batching-3d-search]].
