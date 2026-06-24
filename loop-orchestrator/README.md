# Loop Orchestrator

The control loop that recursively improves the AI wedding planner. It proposes a change, scores
it offline against the eval-harness corpus, validates survivors in production under guardrails,
and promotes or rolls back — then mines failures into new eval cases so the next iteration is
harder. This is the engine that turns the measurement layer (`../eval-harness/`, `../telemetry/`)
into actual improvement.

## Five principles (the rest of this domain is consequences of these)

1. **The model proposes; deterministic code decides.** Claude generates and implements candidate
   changes. Whether a candidate advances is decided by deterministic functions over grade
   reports and production metrics — never by a model judging its own work. A creative proposer
   behind a mechanical gate is the whole trust model.

2. **Cheap filter before expensive risk.** Offline scoring is fast, deterministic, and harmless
   — every candidate runs it, and most die there. Only survivors touch production, which is slow
   (a wedding lifecycle is 12–18 months) and consequential. The funnel exists to make sure the
   loop spends its risk budget only on candidates that already proved themselves offline.

3. **The loop may change the product, never its own objective.** The proposer's write scope is
   the product under test. It physically *cannot* edit `../eval-harness/scoring/`,
   `../eval-harness/rubrics/`, the corpus acceptance thresholds, or the graders. An optimizer
   that can rewrite its own fitness function will — see `safety_and_governance.md` (the
   meta-gaming firewall). Changes to the objective are human-authored, full stop.

4. **Everything is reversible, and harm trips a breaker immediately.** Every candidate is a
   versioned, atomically revertible artifact. Production guardrail monitors (unauthorized spend,
   false facts to guests, constraint violations) trigger auto-rollback the instant they fire,
   independent of any experiment's statistics. Real weddings do not get to be the casualty of an
   experiment.

5. **Failures compound the corpus.** Every offline failure and every offline/online divergence
   becomes a new adversarial scenario. The harness the loop optimizes against gets stronger over
   time; a change that games today's corpus is caught by tomorrow's.

## The funnel

```
   proposer ──► implement (isolated) ──► OFFLINE SCORING ──► [accept rule] ──► reject ─┐
                                            (whole corpus,         │                    │
                                             deterministic)        ▼                    │
                                                            risk-tier gate              │
                                                          (human if Tier 2)             │
                                                                  │                     │
                                                                  ▼                     │
                              SHADOW ──► CANARY ──► RAMP ──► PROMOTE                     │
                            (no actions) (sticky    (cohort   (100%)                     │
                                         cohort,    ramp)                                │
                                         guardrails)   │                                 │
                                                  rollback ◄──── circuit breaker         │
                                                       │                                 │
   ledger ◄───────────────────────────────────────────┴─────────────────────────────────┘
       │
       └──► failures mined into ../eval-harness/scenarios/adversarial/
```

Most candidates exit at the offline accept rule. The expensive stages process a rate-limited
queue of offline survivors.

## Two clocks

The loop runs on two cadences because its signals do:

- **Fast offline clock** — many candidates per day, each scored in minutes against the corpus.
  This is where the bulk of iteration happens. Builds a queue of offline-passed candidates.
- **Slow online clock** — a few experiments ramping over days-to-weeks, rate-limited. Production
  validation leans on *leading* indicators (time-to-first-plan, couple effort, RSVP resolution,
  guardrail breaches) observable in days — not the *lagging* outcome (the actual wedding), which
  is too slow to gate on. See `experiment_design.md`.

## What this domain owns

- `loop_architecture.md` — the stage machine, the accept rule, the ledger flow, convergence.
- `proposer_design.md` — how Claude generates candidates (directed by the scorecard, hypothesis-first).
- `experiment_design.md` — the production funnel and its statistical decision rules.
- `safety_and_governance.md` — reversibility, circuit breakers, the meta-gaming firewall, risk tiers, human gates.
- `schemas/` — the contracts: `candidate_change`, `ledger_entry`, `rollout_stage`.

## What it consumes (and does not own)

- Calls `../eval-harness/` to score candidates; reads `grade_report`s.
- Applies the accept/reject rule defined in `../eval-harness/scoring/scoring_model.md` (it
  *implements* that rule; it does not get to change it).
- Reads the production mirror of metrics defined in `../telemetry/metric_catalog.md`.
- Writes new scenarios into `../eval-harness/scenarios/adversarial/` (the one place it writes
  outside the product — adding hard cases is always safe; it can only make the bar higher).
- Is itself the **`product_improvement_loop` member of the `../agent-operations/` roster** — one
  agent on the team that runs the whole stack. Its safety model is the template the other ops
  agents copy; this domain defines the loop, `../agent-operations/` defines the team around it.

## Implementation substrate

Built as a Claude Agent SDK program: each iteration is an agent turn with a fixed toolset
(read scorecard/ledger, propose+implement in an isolated worktree, invoke the harness, request a
rollout stage). The deterministic selector, experiment engine, and circuit breakers are ordinary
code the agent *calls* — they are not things the agent reasons its way past.
