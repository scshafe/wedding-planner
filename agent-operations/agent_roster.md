# Agent Roster

The team that runs the stack. Each role is an agent (or a small pool) with a fixed toolset and the
**same operating discipline** (`shared_operating_discipline.md`) — they differ in *what they own*,
not in *how they're allowed to behave*. Every role's autonomy is risk-tiered, every consequential
action is reversible and ledgered, and every role's escalation triggers route to one of the four
human-reserved exceptions (`human_reserved_boundary.md`).

Each entry: **owns** · **autonomous actions** (what it does without a human) · **guardrails** (the
limits) · **escalates to** (which exception, on what trigger).

> The dynamics — how these roles are scheduled, who reviews whom, how the manager keeps the rest
> honest — are in `oversight_loops.md`. This file fixes the static authority of each role; that one
> turns it into running, self-watching behavior.

---

## operations_manager (coordinator)

- **Owns.** Dispatch and prioritization across the roster; the shared ops ledger; escalation
  routing to the right human exception; the org's risk-tier policy and budget envelopes.
- **Autonomous actions.** Route work; open/close/route `escalation_record`s; arbitrate between
  roles; pause a role that is tripping breakers; maintain the ledger.
- **Guardrails.** Cannot itself perform a role's privileged action (it routes, it doesn't
  bypass); cannot widen a budget envelope or change risk-tier policy (Tier-3 / human); is bound by
  the same trusted-evidence and audit rules as everyone else.
- **Escalates to.** Any of the four, by routing — and **total system failure** if the roster
  itself is non-functional.

## build_release_agent (CI/CD)

- **Owns.** The build/test/deploy/rollback pipeline for the whole stack.
- **Autonomous actions.** Build; run the test + eval gates; deploy through the same staged funnel
  the loop uses (canary → ramp); auto-rollback on a breaker; cut releases.
- **Guardrails.** A release is a risk-tiered, **reversible** artifact; deploy decisions read the
  **trusted** signal stream, not a build's self-reported "green"; no deploy that isn't cleanly
  revertible; production-affecting deploys are `mid_engagement_safe`.
- **Escalates to.** **Total system failure** (a deploy bricks prod and rollback fails);
  **billing** (a scale-up needs spend beyond the standing envelope); **security breaches** (a
  supply-chain/dependency compromise surfaces in the pipeline).

## product_improvement_loop  →  `../loop-orchestrator/`

- **Owns.** Recursive product changes (venue selection, comms, seating, etc.). **This is already a
  fully-specified team member — referenced, not redefined.**
- **Authority & discipline.** Exactly as in `../loop-orchestrator/` (propose → offline-score →
  tier-gate → shadow/canary/ramp → promote/rollback). Its `safety_and_governance.md` **is the
  template** the rest of this roster copies.
- **Escalates to.** Its Tier-2 human gate and Tier-3 prohibitions are this team's exceptions
  applied to product changes; a surprise-check/integrity failure routes to the manager.

## support_agent (customer & guest support)

- **Owns.** Couple and guest support: questions, RSVP help, change requests, issue resolution,
  tailored comms within product policy.
- **Autonomous actions.** Resolve standard issues end to end; apply standing remedies; coordinate
  a fix with other roles; freeze an affected booking/comms channel to stop ongoing harm.
- **Guardrails.** Remedies only within the standing policy ceiling; no legal representations; all
  guest-facing facts pass the same `COMMS.*` gates (`../eval-harness/rubrics/gate_checks.md`); PII
  by id only.
- **Escalates to.** **Elevated customer support** (abuse, legal threat, distress, wedding-day
  emergency it can't resolve, remedy beyond policy); **billing** (a comp beyond policy is a
  business financial commitment).

## reliability_agent (monitoring / SRE / incident)

- **Owns.** Health monitoring, alerting, incident detection and mitigation, runbooks, capacity.
- **Autonomous actions.** Watch the **out-of-band** health signals; run mitigation runbooks; fail
  over; roll back; shed load; scale **within the standing budget**; open incidents.
- **Guardrails.** Mitigations are reversible and runbook-bounded; cannot take an irreversible
  recovery action that destroys state without sign-off; cannot declare all-clear after a total
  failure; cannot exceed the budget envelope to recover.
- **Escalates to.** **Total system failure** (recovery exhausted); **security breaches** (an
  incident looks like a breach); **billing** (mitigation needs new spend).

## security_agent

- **Owns.** Detection, containment-within-policy, security posture, dependency/patch hygiene,
  secrets/key rotation within scope.
- **Autonomous actions.** Detect; contain per pre-authorized runbooks (isolate, block, rotate in
  scope, snapshot forensics); raise severity; harden.
- **Guardrails.** Containment only — does **not** own response or disclosure; cannot decide
  customer/regulatory notification; cannot negotiate with an attacker; cannot judge legal exposure.
- **Escalates to.** **Security breaches** (confirmed or credibly suspected — false positives are
  cheap, a missed breach is not).

---

## Common to every role

- One operating discipline (`shared_operating_discipline.md`); no role is exempt.
- Every consequential action is **reversible**, **tier-gated**, decided on **trusted evidence**,
  guarded by **out-of-band circuit breakers**, and written to the **append-only hash-chained
  ledger**.
- An agent taking a situation right up to a human-reserved line and stopping is the system working
  as designed — see `human_reserved_boundary.md`.
