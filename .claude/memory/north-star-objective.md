---
name: north-star-objective
description: The North Star objective and recursive-loop framing for the AI wedding planner product
metadata: 
  node_type: memory
  type: project
  originSessionId: 6516eb65-8633-4b90-8c13-798200fc27e6
---

The product is an AI wedding planner + guest comms service that handles everything top-to-bottom
(venue, catering, band, invitations, RSVPs, guest Q&A, seating, tailored comms). The goal is a
**recursive Claude engineering loop** that improves it against a measurable objective.

North Star = **planning_value / (1 + couple_cost)**, gated. planning_value = quality ×
completeness × guest_experience; couple_cost = effort + money + stress. Four hard **veto gates**
(never traded against score): budget ceiling, hard-constraint violation, false fact to a guest,
unauthorized spend. Metrics split into `[eval]` (offline, what the loop optimizes) and `[telem]`
(production, validates transfer). Goodhart discipline: every "maximize" is paired with a
counter-metric guard.

**Why:** the real feedback signal (a finished wedding) is 12–18 months long, so the loop must run
on an offline eval harness of simulated couples/guests, validated by online telemetry.

**How to apply:** the concrete objective lives in `eval-harness/scoring/scoring_model.md`; the
full 7-pillar goal tree and metric framework were defined in the originating conversation. Built
so far: the eval harness spec (schemas, personas, scenarios, rubrics, scoring) under
`eval-harness/`, and the telemetry taxonomy (event envelope + payloads, vocabularies, event
catalog, metric catalog) under `telemetry/`. The two are coherent — every scenario `metric_code`
is defined in `telemetry/metric_catalog.md` and every gate computes from `telemetry/event_catalog.md`;
the event schema is shared by eval and production so metrics match offline/online. The loop
orchestrator is under `loop-orchestrator/` (proposer → deterministic offline accept rule → risk-tier
gate → shadow→canary→ramp → promote/rollback, meta-gaming firewall, circuit breakers, corpus-hardening).

**Status (4 spec domains, none implemented as code yet):** `eval-harness/`, `telemetry/`,
`loop-orchestrator/`, and `agent-operations/` (the whole stack run by a team of agents — see
[[agent-run-operations-model]]). The loop design was reviewed by 3 specialists (security/stats/
architecture) and **all fixes applied: P0** (trust boundary — see [[loop-trusted-evidence-boundary]]),
**P1** (cluster-randomization for shared-vendor SUTVA, online FDR not Benjamini-Hochberg, surrogate
validation, MDE/power/τ² rigor, sequential vs hard-veto breakers), and **P2** (stage-machine gaps,
crash/restart recovery, queue-as-ledger-projection, naming/validation/PII cleanups). Root `README.md`
indexes all four. Spend autonomy: [[spend-autonomy-model]].

**Next session (user's explicit ask):** design the **oversight-loop mechanics** — how the operations
manager and oversight loops run (cadences, who-watches-whom, build-and-oversee, agent-reviews-agent).
Stub at `agent-operations/README.md` "Deferred". After that, a thin vertical slice is the natural build.
