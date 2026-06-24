# Proposer Design

The proposer is the loop's creative engine: a Claude agent that reads the current state of the
product's performance and emits a `candidate_change` with a falsifiable hypothesis. It is the
*only* place a model authors changes; everything downstream is deterministic.

## Inputs (a directed search, not a random walk)

Each proposal cycle, the proposer reads:

1. **The per-capability scorecard** (latest `grade_report`s rolled up) — to target the **weakest
   capability**. Improving the bottleneck moves the North Star more than polishing a strength.
2. **Open `new_adversarial_candidates`** and the adversarial scenarios the product currently
   fails — concrete, known failures are the highest-yield targets.
3. **The ledger `lessons[]`** — what has already been tried for this capability and why it
   failed. The proposer must not re-propose a dead idea; it should build on or branch away from it.
4. **The goal tree / metric catalog** — so a proposal names a real `target_metric_code` and its
   paired guards.

This makes the search *directed*: weakest capability × known failure × not-already-tried.

## Output: hypothesis-first

A proposal is not "change X." It is a **prediction**:

> Changing `<artifact>` will move `<target_metric_code>` `<direction>` on
> `<target_scenario_ids>`, without regressing `<guards_to_watch>`, because `<rationale>`.

Hypothesis-first buys three things:
- **Falsifiability** — the selector checks `hypothesis_confirmed`, not just the aggregate.
- **Gaming detection** — an aggregate gain whose declared mechanism didn't fire is flagged
  suspect (see `loop_architecture.md` surprise check).
- **Better lessons** — a failed *prediction* teaches more than a failed *change*.

The proposer also self-assigns `capabilities_touched` and asserts `reversible` and
`mid_engagement_safe`; the risk-tier gate independently verifies the tier from
`capabilities_touched` (the proposer does not get to under-declare risk).

## Implementation discipline

- Changes are implemented in an **isolated worktree/branch** (`artifact_ref`), never against the
  live product, so a candidate is atomically revertible and offline scoring is hermetic.
- One candidate = one coherent change with one hypothesis. Stacking multiple bets in a single
  candidate makes attribution impossible; if a change depends on another unpromoted change, it
  declares `depends_on` rather than bundling.
- The proposer may change `prompt`, `tool`, `flow`, `integration`, `config`, `ranking`, `copy`.
  It may **not** change the objective, graders, corpus thresholds, or the spend-authorization
  model — those are `risk_tier: 3`, `author: human` only. An attempt to emit
  `change_type: weights_PROHIBITED` is rejected explicitly (named so the rejection is legible,
  not silent).

## Exploration vs. exploitation

A purely greedy proposer tunnels on the current weakest capability and misses compounding
structural wins. The cycle policy mixes:

- **Exploit (majority):** incremental changes to the weakest capability / failing scenarios.
- **Explore (minority):** occasional larger structural bets (a new tool, a reworked flow) even
  where the scorecard isn't screaming — budgeted, and expected to fail more often offline. The
  loop-until-dry signal triggers more exploration: when incremental search goes dry, structural
  bets are how you un-stick it.

## Diversity (a panel, not a soloist)

For a hard target, the proposer can generate **several independent candidates from different
angles** in one cycle (e.g. fix the prompt vs. add a tool vs. restructure the flow), score them
all offline, and let the deterministic accept rule pick the survivor — grafting the best ideas
from the runners-up into the next cycle. Independent attempts beat one-attempt-iterated when the
solution space is wide. This is the proposer's analogue of a judge panel: many proposals, one
mechanical selector.

## What the proposer is NOT

- Not the decider — it never advances its own candidate past `implemented`.
- Not the grader — it does not score its own change; the harness does.
- Not the objective-setter — it optimizes the fitness function; it cannot edit it.

That separation is what lets a creative, high-variance proposer be safe: its blast radius is a
reversible, tier-gated, independently-scored candidate.
