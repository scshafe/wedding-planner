# ADR 0008 — Trusted category-completeness reconciliation: the first plan-side model, completing the completeness trilogy

- **Status:** accepted
- **Date:** 2026-06-25
- **Decider:** the building agent (an agent-owned engineering decision per
  [[agents-own-buildout-decisions]] and `.claude/plans/2026-06-25-phase-8-category-completeness-trusted-reconciliation.md`)
- **Scope:** Phase 8 — telemetry (a new metric + payload vocabulary), the trusted recorder, the planner
  simulator (Stage A/B), the integrity gate. Offline-first, deterministic, no production blast radius.
  North Star **weights untouched**; every honest genome's score on the existing (category-free) corpus
  is **byte-identical** — purely firewall hardening + a new trusted-backed signal, like Phase 4b/6/7.
- **Supersedes nothing.** Extends the Phase-4b/6/7 forge-detection ([[loop-trusted-evidence-boundary]],
  [[escalation-forge-detection-load-bearing]], [[sentiment-trusted-reconciliation]],
  [[qa-accuracy-trusted-reconciliation]]) to a **7th** reconciled effect kind `category_booking`, and
  builds on the tier-2 machinery of [[tier2-promotion-gate-is-load-bearing]].

## Context

`completeness` (North-Star numerator, weight 0.35) is the mean of `rsvp_resolution_rate` (trusted-backed,
Phase 4b), `qa_accuracy_rate` (trusted-backed, Phase 7), and **`category_completeness_rate`** — named in
the catalog, wired into the completeness mean, with a reserved metric code and a reserved `category.booked`
event name, but with **no metric function, no simulator model, and no trusted backing**. It was the last
claimed-only completeness metric. Closing it **completes the completeness trilogy** (all three completeness
inputs trusted-backed).

It is also the **first plan-side model** in the system. Every prior phase (RSVP, sentiment, Q&A) modeled
GUEST interactions; none modeled the PLAN itself — which categories the couple needs and which the planner
books. This is the substrate a future `quality` phase needs (vision-match scores a booked plan), so it is
foundational, not merely incremental. `quality` (the only larger lever, weight 0.4) stays honestly
deferred: a real judge needs API credentials → the offline-first STOP rail; a stub adds an unbacked
claimed-only forge surface → the fabrication rail (ADR 0007).

## The load-bearing insight (why a naïve booking model would be VACUOUS)

For the firewall to be load-bearing, the trusted record (Stage B) must be able to *disagree* with a forged
claim **in a way the metric rewards** — there must be a genome-dependent honest gap to forge UP. A naïve
model where the honest planner books **every** required category is **vacuous**: honest
`category_completeness_rate` is pinned at 1.0 and the only divergent claims a liar can make *lower* its own
metric (the Phase-7 vacuity trap).

**The fix — no new search knob: booking competence is genome-dependent via the EXISTING tier-2
`autonomy_threshold`, the SAME `commitment_autonomy` surface Q&A escalation uses.** A required category
carries a ground-truth `requires_couple_approval` flag. Securing the couple's sign-off on a high-commitment
booking consumes couple commitment-authority — the tier-2 surface (`risk_tier.ts`). So a
`requires_couple_approval` category is honestly `booked` **only by a genome that can escalate** (tier-2); a
**tier-1** genome (the canonical search form) honestly `deferred`s it → `category_completeness_rate < 1.0`.
An approval-free category is `booked` at any tier. Encoded as the SHARED fact
`honestCategoryStatus(requiresCoupleApproval, canEscalate)` (both stages compute it bit-identically),
mirroring `honestQaAction`. There is NO grader oracle — correctness is simply `booking_status === 'booked'`
— so this fact is the only status definition needed (a deliberate asymmetry from Q&A).

**The forge this makes load-bearing:** a tier-1 candidate that **claims it booked** a
`requires_couple_approval` category (completeness up) **without** the couple commitment cost — tier-2-grade
completeness for free. The trusted record (Stage B, re-derived from the tier-1 genome) says `deferred`, so
claimed `booked` ≠ trusted `deferred` → field_mismatch → veto.

## Decision

Add a **7th integrity effect kind `category_booking`**, reconciling the claimed `category.booked` stream
against a per-required-category trusted record. **Two reconciliation surfaces** (not Q&A's two *fields*):

- the **join key `category_id`** defends the DENOMINATOR — forged (claim with no trusted record), forged-on-
  duplicate (a 2nd claim for a claimed category_id; checked before the trusted lookup, yielding one
  forged_effect), and suppressed (a trusted required category with no claim — dropping a `deferred` would
  raise the claims-only rate);
- the field **`booking_status`** defends the NUMERATOR — field_mismatch (`skipWhenClaimAbsent:false`).
- `requires_couple_approval` is **never claimed** and the metric never reads it, so there is **no relabel
  surface** to diff (unlike Q&A, whose metric reads `answerable_by`). Only `booking_status` is field-diffed.

Ground truth lives on the **runtime `ScenarioDefinition.required_categories`** — the same home as
`bookedPlanFacts`, NOT a JSON Schema — because it is a plan-state simulator/grader fact with no LLM
role-player. This avoids a contract regen and makes the keystone-only invariant **structural** (a
runtime-only field cannot leak into the YAML persona corpus the loader ingests).

The metric `category_completeness_rate` is CLAIMS-ONLY: `booked / handled` over `category.booked` claims
with a valid `category_id`; `null` when zero (the category-free search corpus). `metric_catalog.md` was
reconciled to this formula (the prior "before their lead-time deadline" clause struck as out-of-scope — no
booking-timing model this phase; the overclaimed `BUDGET.CEILING`/`vision_match` paired-gate column
corrected).

## Why the existing invariants hold

- **Byte-identity on the search corpus.** With no `required_categories`, Stage A emits ZERO `category.booked`
  events and Stage B records ZERO trusted bookings, so the metric is `null` and the pinned 2-D matrix / 3-D
  cube and all North-Star values are unchanged (asserted directly, not merely inferred).
- **Category-bearing scenarios are KEYSTONE-ONLY.** Because booking correctness on
  `requires_couple_approval` categories is tier-gated, an honest tier-1 search candidate scored on a
  category-bearing scenario against an enthroned tier-2 champion would guard-regress on the metric. The
  runtime-only ground-truth placement enforces this structurally.
- **The tier-1 search box stays tier-1 and forge-free.** The metric is null in the box; correct booking of an
  approval-required category requires tier-2, which the promotion gate already PARKS.
- **Grader-input, not veto-gate-input.** Like sentiment/Q&A this extends the firewall to a North-Star
  numerator input; it does NOT change the integrity-gate completeness invariant
  ([[integrity-gate-completeness-invariants]], which concerns fields *veto gates* read).

## Adversarial review (general-purpose reviewers carrying the named lenses; the specialists are not provisioned here)

- **rigorous-architect (design):** APPROVE-WITH-CHANGES. Moved `required_categories` to the runtime
  `ScenarioDefinition` (the `bookedPlanFacts` precedent, not `guest_persona.questions`); named the two
  reconciliation surfaces; dropped the oracle module (only the status union is needed); required the keystone
  to co-locate a booked + deferred category; tied the deferred booking-cost to the keystone-only invariant.
- **doddy (security):** APPROVE-WITH-CHANGES, NO bypass found across the full reader-seam cross-product (no
  `booking_status` value inflates the metric while the gate stays silent). Applied: pin the metric's
  load-bearing field set, duplicate detail wording, a test that the duplicate lift is real (gate is the sole
  stopper).
- **testineer (test strategy):** APPROVE-WITH-CHANGES. Verified RED→GREEN and that disabling the detector
  fails 3/4 arms. Applied: `onlyIntegrityFailed` (INTEGRITY is the SOLE new gate failure, isolating it past
  the over-determined `accepted=false`) + a positive honest-clean assertion.

## Consequences

- **The completeness trilogy is complete** — all three of `completeness`'s inputs are trusted-backed. Every
  computed North-Star input is now trusted-backed **except `quality`** (deferred behind the judge→STOP /
  stub→fabrication rail).
- The first plan-side trusted record exists, ready to be extended by a future `quality` (vision-match) or
  budget-reconciliation phase.
- +20 tests (310→330). Honest runs on the existing corpus are byte-identical.

## Out of scope (recorded, not faked)

- **The booking-approval couple COST is not modeled** — consistent with Q&A escalation also being cost-free
  today (the "QA-escalation couple cost" deferral). This is LOAD-BEARING, not merely convenient: it is
  *why* category-bearing scenarios must stay keystone-only. If such a scenario ever entered the search
  corpus before the cost is modeled, a tier-2 genome would show a FREE completeness gain. Modeling the cost
  (and the per-(guest/category, reason) session key it needs) is the clean follow-on that would let one
  keystone exercise both the completeness lift and its commitment cost.
- **No booking-timing / lead-time-deadline model** — completeness is the booked/deferred status alone.
- **`quality`** (judge→STOP; stub→fabrication) and a 4-D search remain the open levers.
