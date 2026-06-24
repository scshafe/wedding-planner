# Scenarios

A scenario wires a couple persona, guest personas, an optional stream of injected world
events, and explicit success criteria into one runnable eval case. All files conform to
`schemas/scenario_schema.json`. A run consumes exactly one scenario and emits one grade report.

## golden/ — regression anchors

Known-good, happy-path cases with `golden_expected_outcomes` (the plan signature a healthy
product produces: all categories booked, on budget, every guest resolved). Golden scenarios
answer one question: *did a candidate change make the common case worse?* The loop should
treat any golden regression as a hard stop.

## adversarial/ — designed to break

Cases built around a specific failure mode: a vendor cancels two weeks out, a fatal allergy
threads through a dual-tradition menu, an autonomy boundary gets pushed, a guest probes for a
surprise. Adversarial scenarios are where the gates earn their keep. The product is only as
trustworthy as the hardest adversarial case it passes.

## The corpus must grow

The harness is exactly as good as the situations it covers. Every grade report can emit
`new_adversarial_candidates[]` — failure modes seen in a run that are worth keeping. Promote
the good ones into new files here. A static adversarial set rots; a growing one compounds.

## Admission gate for loop-authored scenarios (enforced, not assumed)

The `loop-orchestrator` is allowed to write new cases here — its one sanctioned write outside the
product — because "adding hard cases only raises the bar." But that is **enforced**, not trusted:
a proposer-authored scenario is admitted only if it

1. **fails the current product** — a case the product already passes raises no bar and is rejected; and
2. **increases a measured coverage dimension** — it must cover a `focus`/persona/failure-mode the
   corpus did not already exercise (displacing coverage with an easy look-alike is rejected).

Admission is reviewed by a human as a **Tier-3 change** (authoring the fitness corpus is editing
the objective — see `../../loop-orchestrator/safety_and_governance.md` §1). Scenarios are weighted
in scoring by **coverage contribution**, never by a self-applied `adversarial` label — so adding
trivially-passable "adversarial" cases cannot inflate the corpus mean or mislead the
loop-until-dry scheduler into marking a weak capability "covered."

## Authoring rules

- `scenario_id` must be prefixed `golden_` or `adversarial_` to match `scenario_type`.
- Name `focus[]` honestly — it is the coverage ledger. If nothing stresses
  `business_viability`, that gap should be visible, not hidden.
- Every gate the scenario means to test goes in `success_criteria.gates_must_hold`.
- Prefer `world_state.mode: fixture` for loop runs (deterministic). Use `live_sandbox` only
  for periodic integration-reality checks, not the fast inner loop.
- Injected `world_events` fire at their `at_phase`; keep payloads concrete (days, amounts).
