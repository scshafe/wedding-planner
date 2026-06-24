# Loop Architecture

The stage machine a candidate moves through, the deterministic rules that advance it, and how
the loop schedules and converges.

## The stage machine

```
proposed ─► implemented ─► offline_scoring ─┬─► offline_rejected ─► (ledger, lessons) ─► [proposer learns]
                                            └─► offline_passed
offline_passed ─► risk_tier_gate ─┬─► human_review ─► human_rejected ─► (ledger)
                                  │              └─► (approved)
                                  └─► (Tier 0/1 auto)
                                          │
                                          ▼
                                       shadow ─► canary ─► ramp ─► promoted
                                          │        │        │
                                          └────────┴────────┴─► rolled_back  (circuit breaker or losing readout)
```

Every transition is appended to the candidate's `ledger_entry` with `decided_by` set to the
mechanism that made it. **Only deterministic mechanisms advance a candidate** — `ai_proposer`
appears only on the `proposed → implemented` edge. Past that, the selector, risk-tier gate,
experiment engine, circuit breaker, and human are the only deciders.

### Parked, ramp steps, and recorded side-effects

Three details the diagram compresses:

- **`parked`.** A candidate whose `depends_on` is unmet is moved `offline_passed → parked` by the
  `deterministic_selector`; it **un-parks** (back to the gate) when its dependency reaches
  `promoted`, or is closed as `final_disposition: parked` if the dependency is rejected. Parking
  exists so dependent changes don't stack unvalidated on top of one another.
- **Ramp is per-step.** `ramp` is not one node — each step is its own `rollout_stage` record with a
  `ramp_step_index`, and each step re-clears the decision rule, so the ledger preserves the full
  ramp history (`ramp → ramp` transitions are real).
- **Recorded notifications.** The Tier-1 "human notified" requirement is a logged side-effect:
  the transition carries a `notified` marker, so the audit trail proves the required notification
  actually happened — an un-recorded mandatory notify is a hole in a governance artifact.

## The offline accept rule (the cheap gate most candidates exit at)

Implements `../eval-harness/scoring/scoring_model.md` verbatim. The candidate is run across the
**whole corpus** (golden + adversarial); it advances to `offline_passed` only if **all** hold:

1. **No golden regression** — every `golden_*` scenario still passes its gates and stays within
   tolerance of its `golden_expected_outcomes`. (Hard stop: a change that wins on hard cases by
   breaking the common case is a net loss.)
2. **No new veto-gate failures** on any scenario, and **zero** new `FATAL` flags.
3. **No counter-metric regression** beyond tolerance — specifically the `guards_to_watch` the
   candidate declared, plus the standing Goodhart guards in the metric catalog.
4. **Aggregate North Star improves** — mean `north_star_ratio` across the corpus rises, with
   adversarial scenarios weighted ≥ golden.

A failure on any of these → `offline_rejected`, with the specific reason written to
`offline_result` so the proposer learns the right lesson (not just "it failed").

### The surprise check (anti-gaming, offline)

The candidate declared a `hypothesis`: a `target_metric` moving a `expected_direction` on
`target_scenario_ids`. The selector records `hypothesis_confirmed`. A candidate that improves the
**aggregate** while its **declared mechanism did not fire** is flagged suspect and routed to
`human_review` regardless of risk tier — an aggregate gain through an unhypothesized path is the
signature of corpus gaming, not real improvement.

## The risk-tier gate

`offline_passed` candidates are gated by `risk_tier`, **derived from a static analysis of the
diff** (see `risk_tier_derivation.md`), not from the proposer's self-declared `capabilities_touched`:

| tier | what | path |
|---|---|---|
| 0 | cosmetic, copy, ranking | offline → canary → auto-promote |
| 1 | flow, orchestration, non-binding tools | offline → shadow → canary → ramp, human *notified* |
| 2 | money (commitments, autonomy scopes), guest-facing comms content, bookings, PII | offline → **human approval** → shadow → canary → slow ramp |
| 3 | objective / graders / corpus thresholds / spend-authorization model / legal terms | **PROHIBITED for `ai_proposer`** — human-authored only |

Tier rationale and enforcement live in `safety_and_governance.md`.

## The ledger flow

The `ledger_entry` is the loop's durable memory and audit trail:

- **Append-only, hash-chained transitions** on a WORM store outside the proposer's write scope
  make every decision tamper-evidently reconstructable (mechanism in `safety_and_governance.md` §7).
- **`lessons[]`** feed the proposer: rejected approaches and their reasons, plus refs to any
  adversarial scenarios spawned from this candidate's failures. The proposer reads the ledger
  before proposing so it does not re-litigate dead ideas.
- A promoted candidate's entry is the record of *why* the product behaves as it does — the thing
  a human reviews when asking "what changed and on what evidence."

## Convergence and scheduling

The loop runs on the two clocks from the README:

- **Offline (fast):** a continuous propose→score→learn loop. It targets the weakest capability
  on the `per_capability_scorecard`, draining `new_adversarial_candidates` as it goes. Uses a
  **loop-until-dry** rule: after *K* consecutive iterations with no `offline_passed` candidate
  for the current target, mark that capability "dry," move to the next weakest, and log the
  plateau. When *all* capabilities are dry against the current corpus, the loop is not "done" —
  it shifts to **corpus-hardening mode**: mine production for new hard cases (see
  `experiment_design.md`) to refill the adversarial set, which un-dries the search.
- **Online (slow):** a rate-limited queue, which is **a projection over the ledger** (the
  candidates in `offline_passed`/`parked` not yet terminal or active), not a second piece of
  mutable state — so it survives a restart for free. Dequeue is **weakest-capability-first**
  (matching the offline targeting), tie-broken by tier (lower tier first, cheaper to validate). At
  most *N* concurrent experiments; a candidate touching a capability in post-rollback **cooldown**
  is **skipped, not blocked at the head** (no head-of-line stall). Ramp speed is bounded per tier.

### Budget bounding

The offline loop is bounded by a compute/token budget per cycle; within it, depth scales to the
budget (more finder/verifier passes per candidate when budget is ample). The online loop is
bounded by the concurrency cap and ramp limits, not tokens — its scarce resource is *exposed
couples*, spent only on offline survivors.

## Failure and recovery

The loop is a long-running, money-touching controller, so what happens when *the loop itself* dies
mid-iteration is a first-class concern — a breaker that doesn't survive a restart is not a breaker.

- **The ledger is the authoritative recovery log.** On startup the loop scans for non-terminal
  candidates and reconciles real-world state against the ledger's last recorded transition:
  orphaned worktrees are discarded; production exposure (flag/cohort) is reconciled to the last
  recorded `rollout_stage`; any candidate whose last transition was a `circuit_breaker` firing
  resolves to `rolled_back` (fail safe — a half-applied rollback completes, never silently reverts
  to live).
- **Transition appends are idempotent**, keyed by `candidate_id × from_state × to_state` (plus the
  hash chain), so a re-driven turn after a crash cannot double-append or fork the history.
- **Crash between implement and ledger-append** leaves only an orphaned worktree (no recorded
  state), which startup reconciliation garbage-collects; the candidate is simply re-proposed.

## Where the loop writes

Exactly two places, both safe by construction:
1. **The product under test** — only as reversible, tier-gated candidate artifacts.
2. **`../eval-harness/scenarios/adversarial/`** — and only through an admission gate that
   *enforces* "raises the bar": a proposer-authored scenario must fail the current product AND
   increase a coverage dimension, and is human-reviewed as a Tier-3 change before admission
   (`safety_and_governance.md` §1, `../eval-harness/scenarios/README.md`).

It writes **nowhere** in `../eval-harness/scoring/`, `../eval-harness/rubrics/`, the graders, or
the ledger store. That boundary is the subject of `safety_and_governance.md`.
