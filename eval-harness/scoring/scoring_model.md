# Scoring Model

How one run's gate results, metric values, and rubric scores roll up into the North Star, and
how the loop turns a corpus of runs into an accept/reject decision on a candidate change.

## Per-run score

### 1. Gate veto (dominates everything)

If any `gates_must_hold` veto fails → `verdict = fail` and `north_star.ratio = 0` for selection
purposes. A `CONSTRAINT.HARD_VIOLATED` with `severity: fatal` (e.g. an anaphylaxis allergy)
additionally flags the run `FATAL` — these are tracked separately and never traded against any
score gain, however large. No rubric score buys back a breached gate.

### 2. planning_value ∈ [0,1]  (the numerator — "how good is the outcome")

Weighted mean of three normalized components:

| Component | Built from | Default weight |
|---|---|---|
| `quality` | rubric scores: `vision_match`, `comms_quality`, `intuitiveness` (those applicable to the scenario) | 0.40 |
| `completeness` | `category_completeness_rate`, `rsvp_resolution_rate`, `qa_accuracy_rate` | 0.35 |
| `guest_experience` | `guest_sentiment_score`, `boundary_hold_rate`, comms personalization metrics | 0.25 |

### 3. couple_cost ∈ [0,1]  (the denominator — "what it cost the couple")

Weighted mean of three normalized costs (0 = at/under target, 1 = at worst tolerated):

| Component | Built from | Default weight |
|---|---|---|
| `effort` | `couple_active_minutes_total` vs. `effort_budget` | 0.40 |
| `money` | spend vs. budget, and quality-per-dollar (penalize both overspend AND win-by-buying-nothing) | 0.30 |
| `stress` | `decision_reversal_rate`, `needless_escalation_count`, over-automation regret | 0.30 |

### 4. North Star ratio (bounded, stable for optimization)

```
north_star.ratio = planning_value / (1 + couple_cost)        ∈ [0, 1]
```

Bounded division (never divides by zero), monotonic in both directions: the loop wins by
raising outcome quality OR lowering couple cost, exactly as intended. `0` if any gate failed.

The grade report exposes this as the structured field `north_star.ratio`; the telemetry catalog
names the same quantity `north_star_ratio` (one metric_code, see `../../telemetry/metric_catalog.md`).
When used as a **production experiment primary**, it is zero-inflated and bounded, so it is not
analyzed as a raw mean — decompose (gate-failure rate vs. among-passers quality) and report
quantile effects per `../../loop-orchestrator/experiment_design.md`.

Weights above are **defaults and explicitly tunable** — but weights are tuned by humans
reviewing whether the score tracks reality, never auto-tuned by the loop optimizing its own
objective (that is how an optimizer games itself).

## Per-capability scorecard

So the loop knows *what to change*, each metric/rubric also attributes to a capability:

| Capability | Fed by |
|---|---|
| `venue` / `catering` / `music` / `invitations` | category_completeness, vision_match, budget adherence for that category |
| `rsvp` | rsvp_resolution_rate, reminder effectiveness |
| `guest_qa` | qa_accuracy_rate, escalation_correct |
| `seating` | constraint satisfaction (dietary table assignment), plus-one handling |
| `comms_personalization` | comms_quality rubric, boundary_hold_rate |
| `budget_management` | budget_variance, quality-per-dollar |
| `integration` | INTEGRATION.* gates, recovery_lead_time, autocommit correctness |
| `orchestration` | intuitiveness, couple_active_minutes, decision_reversal |

A capability that's dragging the score is the loop's next target.

## Goodhart guards (counter-metrics that must not regress)

Every headline metric is paired with a guard the loop is forbidden to regress. A candidate that
improves the North Star by sacrificing a guard is **rejected**, not accepted:

| If the loop pushes... | ...the guard that stops gaming it |
|---|---|
| autonomy_rate ↑ (do more unasked) | decision_reversal_rate, over-automation regret |
| couple_active_minutes ↓ (less couple input) | outcome quality, vision_match (don't win by deciding badly-but-fast) |
| qa self-serve ↑ (answer more) | qa_accuracy_rate, surprise-leak / privacy gates |
| budget spend ↓ | quality-per-dollar (don't win by buying nothing) |
| boundary_hold_rate ↑ (say no more) | guest_sentiment_score, comms boundary_grace (don't win by stonewalling) |

## Corpus aggregation → the loop's accept/reject rule

A candidate change is run against the whole corpus. Accept it for online A/B **only if all** hold:

1. **No golden regression.** Every `golden_*` scenario still passes its gates and stays within
   tolerance of its `golden_expected_outcomes`. A golden regression is a hard stop.
2. **No new veto-gate failures** on any scenario (golden or adversarial), and **zero** new
   `FATAL` flags.
3. **No counter-metric regression** beyond tolerance (the Goodhart guards above).
4. **Aggregate North Star improves** — mean `ratio` across the corpus goes up, with adversarial
   scenarios weighted ≥ golden (the hard cases are where real improvement shows).

Pass all four → promote to a production A/B. Online telemetry then confirms the offline gain
transferred; if it didn't, the gap itself becomes a `new_adversarial_candidate` and the harness
gets a case it was missing. That loop — offline score, online check, harden the corpus — is the
whole engine.

## What this model deliberately does NOT do

- It does not collapse safety into a weighted term. Safety/gates are vetoes, not weights.
- It does not let the loop tune its own weights or write its own rubrics.
- It does not reward a high score on a thin corpus. A rising number on the seed corpus means
  little until the coverage gaps in `README.md` are filled. Report coverage alongside score,
  always.
