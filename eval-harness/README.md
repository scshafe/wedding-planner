# Eval Harness

The eval harness is the offline scoring substrate for the AI wedding planner. It runs
the product-under-test against **simulated couples and guests**, grades the outputs
against gates / metrics / rubrics, and emits a machine-readable grade report. It is the
fitness function the recursive Claude engineering loop optimizes against.

It exists because the real-world feedback signal for a wedding planner is 12–18 months
long. The loop cannot iterate on that cadence. The harness compresses a full planning
lifecycle into a minutes-long simulated run so that a candidate change (a prompt, a tool,
a flow, a new integration) can be scored before it ever reaches a real couple.

## What this domain owns

- The **persona corpus** (`personas/`): seed definitions of simulated couples and guests
  that LLM role-players drive during a run.
- The **scenario corpus** (`scenarios/`): wirings of personas + injected world events +
  success criteria. `golden/` are known-good regression anchors; `adversarial/` are cases
  designed to break the product.
- The **rubrics** (`rubrics/`): grading instructions for subjective axes (vision match,
  comms quality, intuitiveness) and the deterministic **gate checks**.
- The **scoring model** (`scoring/`): how gate results, metric values, and rubric scores
  roll up into the North Star objective and a per-capability scorecard.
- The **schemas** (`schemas/`): JSON Schema contracts every persona, scenario, and grade
  report must conform to. These are the public interface of this domain.

## What this domain does NOT own

- The product-under-test (the planner agents, integrations, UI). The harness treats it as
  a black box reached through a single run entrypoint.
- The loop orchestrator (proposer → selector → A/B → promote). The harness is *called by*
  the loop; it does not drive it. See the `../loop-orchestrator/` domain.
- Production telemetry. Online metrics validate that offline gains transferred; they live
  with the product, not here. Each metric below is tagged `[eval]` (this harness scores it)
  or `[telem]` (production scores it; mirrored here only where a simulated proxy exists).
- The metric and event definitions themselves. Every `metric_code` used in `scenarios/` is
  defined operationally in `../telemetry/metric_catalog.md`, and every gate computes from the
  events in `../telemetry/event_catalog.md`. This harness *references* that contract; the
  contract is shared with production so the same metric is computed offline and online.

## The objective being scored (recap)

```
            planning_value (quality × completeness × guest_experience)
North Star = ───────────────────────────────────────────────────────── , gated.
              couple_cost (effort + money + stress)
```

Hard veto gates (a run FAILS outright if any is breached, regardless of ratio):

- `BUDGET.CEILING_EXCEEDED` — committed spend over the couple's hard ceiling.
- `CONSTRAINT.HARD_VIOLATED` — date, guest count, allergy, accessibility, cultural/religious.
- `COMMS.FALSE_FACT_TO_GUEST` — any incorrect logistics fact sent to a guest.
- `SPEND.UNAUTHORIZED_COMMIT` — money/binding commitment made outside the authorization model.

### Spend authorization model (product decision, encoded as a gate)

Default is **propose-confirm**: the AI researches, compares, holds, and drafts, but every
binding commitment or payment requires explicit couple approval. A couple may **opt in
ahead of time to per-item or per-category autonomy**, which only applies while the action
is **within budget** and within the opted-in scope. Anything over budget, outside scope,
or non-refundable/irreversible escalates back to confirm. The exact allow/deny/escalate
logic lives in `rubrics/gate_checks.md` (`SPEND.*`) and is probed by
`scenarios/adversarial/adversarial_spend_autonomy_boundary.yaml`.

## Run contract

One run = (product-under-test entrypoint) × (one scenario) → one grade report.

1. **Seed.** Load the scenario, resolve its `couple_persona_ref` and `guest_persona_refs`.
2. **Drive.** An LLM role-player acts as the couple (seeded by the couple persona's
   `simulation_behavior`); separate role-players act as each guest. They interact with the
   product exactly as a real user would (chat, approvals, RSVPs, questions). Injected
   `world_events` (e.g. a vendor cancellation) fire at their scheduled phase.
3. **Capture.** Every product action, message, commitment, and the couple's effort/time is
   recorded into a run trace.
4. **Grade.** The grading pipeline runs over the trace (see below).
5. **Emit.** A grade report conforming to `schemas/grade_report_schema.json`.

Runs must be **deterministic given a seed**: role-player temperature, world inventory, and
event timing are fixed per run so a score delta is attributable to the product change, not
simulation noise. `Date.now()`/random must be injected, never read ambient.

## Grading pipeline (order matters)

1. **Gates first.** Deterministic checks (`rubrics/gate_checks.md`). If any veto gate fails,
   `verdict = fail` — but continue grading so the report still shows *why* and *how far off*.
2. **Metrics.** Compute each scenario's `target_metrics` from the trace (budget variance,
   RSVP resolution rate, couple-minutes per milestone, autonomy rate, etc.).
3. **Rubrics.** LLM-as-judge scores the subjective axes named in the scenario's
   `graded_axes`, each with an explicit rationale and the judge model id (auditable).
4. **Roll up.** `scoring/scoring_model.md` combines the above into North Star components and
   a `per_capability_scorecard` so the loop knows *which* capability moved the score.
5. **Mine failures.** Any new failure mode worth keeping becomes a
   `new_adversarial_candidates[]` entry — the harness gets harder over time.

## Directory layout

```
eval-harness/
  README.md                  ← you are here
  schemas/                   ← JSON Schema contracts (the public interface)
    couple_persona_schema.json
    guest_persona_schema.json
    scenario_schema.json
    grade_report_schema.json
  personas/                  ← simulated couples (couple_*) and guests (guest_*)
  scenarios/
    golden/                  ← known-good end-to-end regression anchors
    adversarial/             ← cases designed to break the product
  rubrics/                   ← LLM-judge rubrics + deterministic gate_checks.md
  scoring/                   ← scoring_model.md: rollup into the North Star
```

## Conventions

- Money is integer `*_cents`. Timestamps are `*_at`, UTC, injected (never ambient).
- Personas/scenarios are YAML; contracts are JSON Schema; rubrics/docs are Markdown.
- Every persona and scenario carries a stable `*_id` and a one-line `description`.
- Guest personas carry **ground-truth answers** to the questions they ask, so the
  `COMMS.FALSE_FACT_TO_GUEST` gate and Q&A-accuracy metric are checkable, not vibes.
- A scenario names exactly which pillar(s) it stresses (`focus`) so coverage gaps are visible.

## Coverage ledger (keep honest)

This corpus is a seed, not full coverage. Known gaps to fill before trusting the score:
geographic breadth (one region modeled), vendor-inventory realism (fixtures, not live),
LGBTQ+ / non-traditional family structures, destination weddings, very large guest lists
(>300), and elopements. Do not let a high score on this seed read as "covered everything."
