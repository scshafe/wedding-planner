# Project Memory — wedding-planner

- [North Star objective](north-star-objective.md) — the planning_value/(1+couple_cost) objective and recursive-loop framing for the AI wedding planner
- [Spend autonomy model](spend-autonomy-model.md) — default propose-confirm + per-item/category opt-in autonomy gated by within-budget
- [Loop trusted-evidence boundary](loop-trusted-evidence-boundary.md) — the firewall must protect grader INPUTS not just code; P0+P1+P2 all applied
- [Agent-run operations model](agent-run-operations-model.md) — whole stack run by agents; humans reserved for only 4 exceptions (elevated support, total failure, security breach, business billing); oversight-loop dynamics now designed (additive-only, L0–L4 DAG, 3 tempos)
- [Prod trusted-evidence channel](prod-trusted-evidence-channel.md) — eval→prod: wall the evidence CHANNEL/keys/liveness, not just inputs; sandbox property doesn't transfer for free
- [White-label growth & agent strategy autonomy](white-label-growth-and-agent-strategy-autonomy.md) — candidate multi-tenant white-label direction; user wants agents to ideate/ship growth (stretches the human-reserved boundary)
- [Agents own build-out decisions](agents-own-buildout-decisions.md) — the project is a testbed for autonomous agent build-out; leave stack/structure/design to the agents; humans set goals + safety rails, not implementation. Don't gate engineering choices.
- [Integrity-gate completeness invariants](integrity-gate-completeness-invariants.md) — the divergence gate must diff EVERY trusted field a gate reads (full-field reconciliation) + one shared report-event-name set (no reader seam); from doddy's Phase-1 firewall review
- [Accept-rule composition invariance](accept-rule-composition-invariance.md) — a corpus accept rule must fix the scenario set (reject add/drop) so the candidate can't game the aggregate estimand; from testineer's Phase-1 review (confirmed P0)
- [Autonomous build loop](autonomous-build-loop.md) — a macOS system LaunchDaemon (user 'cole') runs ops/run.sh every 3h with full autonomy (commits to build/* branches, pushes main to origin); expect agent-authored commits between manual sessions; pause via `sudo launchctl bootout system/com.coleshaffer.wedding-planner-build`
- [Genome content-address firewall](genome-content-address-firewall.md) — Phase 2: content-address the strategy genome (commit to the thing that runs), re-derive risk independently, Stage A/B simulator split keeps INTEGRITY non-vacuous
