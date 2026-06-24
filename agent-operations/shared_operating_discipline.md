# Shared Operating Discipline

The invariants **every** ops agent inherits, regardless of role. The point of this file is that
the org runs on **one** safety model: the same one the product-improvement loop already runs on.
Each invariant below is the operations generalization of a rule first stated for the loop; the
canonical statement lives in `../loop-orchestrator/safety_and_governance.md` and
`../telemetry/README.md`, and this file binds the whole roster to it.

## 1. Reversibility — every consequential action

Every action an agent takes is a versioned, **atomically revertible** artifact: a deploy, a config
change, a remedy, a mitigation. Reversibility is a precondition to *act*, not a cleanup afterthought.
Production-affecting actions are `mid_engagement_safe` — rolling back must not orphan an in-flight
couple's state. *(Generalizes `safety_and_governance.md` §2.)*

## 2. Trusted evidence — decide on signals the actor can't author

An agent never decides on a component's **self-report** of itself. Build "green," a service's own
"healthy," a deploy's own "succeeded" are *claims*; the decision reads the **out-of-band / trusted**
signal (independent health checks, the payment processor's actual ledger, the vendor API's actual
confirmation, grader-side determinations). A divergence between a component's claim and the trusted
record is itself an incident (`INTEGRITY.SELF_REPORT_DIVERGENCE`). This is the same boundary
relocation the loop made: protect the *evidence*, not just the code. *(Generalizes
`safety_and_governance.md` §1 "The evidence" and `../telemetry/README.md` "Integrity".)*

## 3. Out-of-band circuit breakers — harm reverts instantly

Each role runs real-time monitors on its harm conditions, fed by **out-of-band signals the
monitored component cannot author**. A breaker has one action: `auto_rollback` / `auto_contain` —
it reverts first, logs `decided_by: circuit_breaker`, and *then* surfaces. It never pages-and-waits.
*(Generalizes `safety_and_governance.md` §3; breaker `source` must be out-of-band per
`../loop-orchestrator/schemas/rollout_stage_schema.json`.)*

## 4. Risk-tiered autonomy + human gates

Operational actions carry the **same 0–3 tier ladder** as product changes, derived from the
**actual blast radius of the action**, never from the agent's self-declaration (the tier-from-diff
rule, generalized — `safety_and_governance.md` §4, `../loop-orchestrator/risk_tier_derivation.md`):

| tier | operational scope | path |
|---|---|---|
| **0** | cosmetic / low-impact (copy, dashboards, non-prod) | act → log |
| **1** | routine prod ops (standard deploy, runbook mitigation, standard support) | act → log → human *notified* |
| **2** | high-blast-radius ops (schema/data migration, broad config, remedy near a policy ceiling, infra change within budget) | **human approval gate** → act → log |
| **3 (the four exceptions)** | elevated support · total system failure · security breach response & disclosure · the business's finances/legal | **human-owned** — agent may detect/contain/recommend/freeze, never cross (`human_reserved_boundary.md`) |

Tier 3 here is the four human-reserved exceptions — the operational analogue of the loop's Tier-3
(objective / graders / spend-model). An under-declared tier is auto-rejected and escalated.

## 5. Append-only, hash-chained ledger — one audit substrate

Every consequential action and every escalation is written to the **same append-only,
hash-chained, WORM-backed ledger** the loop uses, on a store **outside any agent's write scope**.
`decided_by` is **signed**, bound to the acting process's identity — a forged entry can't spoof who
acted. `escalation_record`s chain into this ledger via the same `entry_hash` / `prev_entry_hash`
fields. The audit record of the agents must not be rewritable by the agents. *(Generalizes
`safety_and_governance.md` §7; chaining fields shared with
`../loop-orchestrator/schemas/ledger_entry_schema.json`.)*

## 6. Audit & PII discipline

Decisions are attributable to the trusted evidence that justified them. Telemetry's PII discipline
holds everywhere: people are referenced by `guest_id` / `wedding_id`, never raw PII; sensitive
free-text is `[REDACTED]`; ground truth is read from the access-controlled record, not the event
text. *(Per `../telemetry/README.md` "Privacy & PII discipline".)*

## Why one pattern set

Two safety models is a seam an optimizer (or an attacker) exploits — the weaker one. The loop
already proved a creative, autonomous agent is safe to run when its blast radius is bounded on
every axis (reversible · trusted-evidence · tier-gated · circuit-broken · ledgered · walled off
from its own objective). Running the *rest* of the org on those same axes is what lets the whole
stack be agent-operated with humans only on the four exceptions — without inventing a second,
unproven set of guarantees.
