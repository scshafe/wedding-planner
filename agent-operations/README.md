# Agent Operations

The whole stack — CI/CD, product-change decisions, customer/guest support, monitoring / SRE /
incident response, routine ops — is run by a **team of agents**. Humans are not in the operating
loop; they sit on the **exception path**. This domain defines that team, the discipline every
member inherits, and the sharp line where an agent must stop and hand off to a person.

## The operating principle

Agents run the business; humans own only what an agent must never cross alone. There are exactly
**four human-reserved exceptions**:

1. **Elevated customer support** — abuse, legal claims, acute distress, a wedding-day emergency an
   agent can't resolve, or remedies beyond standing policy.
2. **Total system failure** — production down or data integrity at risk with automated recovery
   exhausted.
3. **Security breaches** — confirmed or credibly-suspected intrusion, exfiltration, or compromise.
4. **Billing — the *business's own* finances and legal commitments** — infra billing, contracts,
   pricing, payouts. (NOT a couple's wedding budget; that is the product's job, governed by
   [[spend-autonomy-model]] / `../eval-harness/rubrics/gate_checks.md` `SPEND.*`.)

These four are the **operational analogue of `loop-orchestrator`'s `risk_tier: 3`**: the class of
action that is human-authored, full stop. The pattern is identical — an agent may operate *right
up to* the line (detect, contain, freeze, recommend, draft the handoff) and may *never cross it*
(own breach response, declare all-clear after a total failure, commit the business's money, make
legal representations). The four are defined precisely, line by line, in `human_reserved_boundary.md`.

This is not "humans review everything." It is "agents do everything, and the four exceptions are
the only places the steering wheel is handed over."

## One pattern set, not two

Every ops agent inherits the **same operating invariants** the product-improvement loop already
runs on — reversibility, trusted-evidence gates, out-of-band circuit breakers, an append-only
hash-chained ledger, risk-tiered autonomy with human gates, and audit. The org has *one* safety
model, not a separate one per team. `shared_operating_discipline.md` states the invariants and
ties each back to `../loop-orchestrator/safety_and_governance.md` and `../telemetry/README.md`.

## How it composes with the other domains

- `../loop-orchestrator/` **is** one member of this team — the product-improvement agent. This
  domain references it; it does not redefine it. The orchestrator's safety model is the template
  the rest of the roster copies.
- `../eval-harness/` and `../telemetry/` are the measurement substrate every agent reads from.
  Ops decisions, like product decisions, are made over the **trusted** portion of the event /
  signal stream — never a component's self-report (`../telemetry/README.md` "Integrity").

## What this domain owns

- `human_reserved_boundary.md` — the four exceptions, each as trigger / may-do / may-not-do / handoff.
- `agent_roster.md` — the team: each role's ownership, autonomous actions, guardrails, escalation triggers.
- `shared_operating_discipline.md` — the invariants every ops agent inherits, tied to the loop's model.
- `oversight_loops.md` — the **dynamics**: the three oversight tempos, the build-and-oversee control
  loop, the pre-landing review gate, the who-watches-whom graph, and how the roster is kept honest.
- `trusted_evidence_channel.md` — how the L0 floor is made **un-authorable in production**: the
  verifying path separated from the acting path, signed liveness that fails closed, key custody
  outside every agent process, provision-before-serve, and tenant isolation.
- `schemas/escalation_record_schema.json` — the contract for an escalation/incident handoff,
  chained into the shared ledger.
- `schemas/oversight_record_schema.json` — the contract for one act of oversight (inline review,
  monitor trip, sweep finding, obligation violation), chained into the same ledger.
- `schemas/trusted_feed_schema.json` — the contract for one production out-of-band trusted feed,
  pinning the properties that keep it un-authorable by the agents it watches.

## What this domain does NOT own

- The product itself, the eval corpus, the metric/event definitions, or the recursive improvement
  mechanics — those live in `../loop-orchestrator/`, `../eval-harness/`, `../telemetry/`.
- **The rules oversight enforces** — the risk-tier policy, the surface→tier map, the graders, the
  obligation set, and the ledger store. Those are Tier-3 / human-authored; oversight *applies* them
  and is walled off from editing them, exactly as the proposer is from its objective
  (`oversight_loops.md` "Keeping oversight honest"; `../loop-orchestrator/safety_and_governance.md` §1).

## Directory layout

```
agent-operations/
  README.md                       ← you are here
  human_reserved_boundary.md      ← the four exceptions, drawn sharply
  agent_roster.md                 ← the team and each role's authority
  shared_operating_discipline.md  ← the invariants every ops agent inherits
  oversight_loops.md              ← the dynamics: how the roster runs and watches itself
  trusted_evidence_channel.md     ← how the L0 floor is made un-authorable in production
  schemas/
    escalation_record_schema.json ← the handoff/incident contract, chained into the ledger
    oversight_record_schema.json  ← the contract for one act of oversight, chained into the ledger
    trusted_feed_schema.json      ← the contract for one production out-of-band trusted feed
```

## The dynamics: how the roster runs and watches itself

The *structure* above (who exists, what each may do, the shared discipline, the human boundary) is
made to *run* by `oversight_loops.md`. Its one idea: **oversight is the meta-gaming firewall turned
sideways** — every agent is walled off from the judgment of its own work, and whether work lands is
decided on evidence the actor cannot author. That dissolves the "who watches the watcher" regress,
because the chain terminates at a **non-agent floor** (trusted recorder, out-of-band signals, the
append-only ledger, deterministic gates), not at a maximally-trusted agent. Three load-bearing moves:

- **Three tempos.** *Inline* (the pre-landing review gate — what lets Tier-1 ops be safe without a
  human on each action), *continuous* (breakers + obligation monitors on the agents themselves), and
  *periodic* (the manager's ledger sweep + the human supervisor's slow meta-review). The inline gate
  is the third clock the loop's fast-offline / slow-online pair did not need.
- **Additive-only authority.** A reviewer may only *raise* scrutiny (flag / block / escalate /
  raise-tier), never *lower* it (no clear / approve / widen / bypass). So a captured or colluding
  reviewer degrades to "no review happened" — never to "bad work cleared." Pinned in the schema: an
  agent reviewer's `verdict` cannot be `cleared`.
- **Obligations checked out-of-band.** The *duty* to escalate / roll back / stay in scope is verified
  by non-agent monitors that route a violation **past** the operations_manager straight to the human,
  so a watcher going dark cannot suppress the alarm about itself.

The human supervisor from `../loop-orchestrator/safety_and_governance.md` §5 is the standing L4
backstop and the sole owner of the four exceptions.
