# Safety and Governance

This loop autonomously modifies a product that spends couples' money, communicates with their
guests, and books real vendors. The safety properties below are not advisory — they are the
preconditions for letting it run without a human in every cycle. Each is enforced by mechanism,
not by asking the proposer to behave.

## 1. The meta-gaming firewall (the single most important property)

An optimizer that can influence its own fitness function will eventually do so instead of
improving the product. The firewall must therefore wall the proposer off from **both** the
rulebook (the grader code) **and** the evidence (the inputs the graders read). Protecting one
without the other is this design's most dangerous failure mode: walling off grader code while
leaving the event stream the gates read under the proposer's control means every "untouchable"
gate is defeatable by a product-only change that forges or suppresses events.

**The rulebook.** The `ai_proposer` has **no write access** to `../eval-harness/scoring/`,
`../eval-harness/rubrics/`, the corpus acceptance thresholds, the graders, the spend-authorization
model, or **the ledger store** (§7). Enforced at the path level (the agent's file-write capability
is scoped), not by convention or prompt. Any change to these is `risk_tier: 3`, `author: human`.
A candidate emitting `change_type: weights_PROHIBITED` is rejected explicitly and logged.

**The evidence.** The veto gates, the surprise check, the risk-tier derivation, and the production
circuit breakers all read ground truth from channels the product cannot forge — the harness's
out-of-band **trusted recorder** (interception of the product's actual, sandboxed effects) and
**grader-side** determinations from persona ground truth — never the product's self-reported
events (see `../telemetry/README.md` "Integrity"). A product-only change that forges or suppresses
an event to dodge a gate fails `INTEGRITY.SELF_REPORT_DIVERGENCE`
(`../eval-harness/rubrics/gate_checks.md`).

**The one sanctioned write outside the product** — new cases in
`../eval-harness/scenarios/adversarial/` — is **not** unconditional. "Adding hard cases only
raises the bar" is *enforced*, not assumed: a proposer-authored scenario is admitted only if it
(a) **fails the current product** (a case the product already passes raises no bar) and (b)
**increases a measured coverage dimension**, and it is reviewed by a human as a Tier-3 change —
authoring the fitness corpus is editing the objective. Scenarios are weighted by coverage
contribution, never by a self-applied `adversarial` label
(`../eval-harness/scenarios/README.md`).

If the loop wants a different objective, the correct outcome is a human conversation about the
objective — never the loop quietly rewriting it, weakening its corpus, or forging its evidence.

## 2. Reversibility (every change, always)

- Every candidate is a versioned, **atomically revertible** artifact (`artifact_ref`).
  `reversible: true` is a precondition to leave offline; a change that cannot be cleanly reverted
  does not advance.
- Production changes must be `mid_engagement_safe`: rolling back partway through a couple's
  12–18 month engagement leaves no orphaned state. Rollback reverts behavior going forward,
  gracefully, for in-flight couples (see `experiment_design.md`).
- No candidate performs an irreversible real-world act as part of *being tested*. Shadow takes no
  action; canary acts only within the normal product guardrails (which already cap autonomous
  spend per `../eval-harness/rubrics/gate_checks.md`).

## 3. Circuit breakers (harm reverts instantly, no debate)

Production runs real-time monitors on the **production analogues of the veto gates** and the
critical counter-metrics: unauthorized commitments, false facts sent to guests, hard-constraint
violations, spend-authorization violations. Crucially, a safety-critical breaker reads
**out-of-band signals the product cannot author** — the payment processor's actual charge ledger,
the vendor API's actual booking confirmations, chargeback/complaint feeds — not the product's
self-reported metric stream (a breaker fed by the monitored component's own account of itself is
the escape hatch a gamed candidate uses, and is not a breaker). A breaker has exactly one action:
`auto_rollback`. It does **not** page a human and wait — it reverts first, logs
`decided_by: circuit_breaker`, and *then* surfaces for review. A wedding is never the thing that
waits for an on-call response.

## 4. Risk tiers (depth of scrutiny scales with blast radius)

| tier | scope | required path |
|---|---|---|
| **0** | cosmetic, copy, ranking | offline → canary → auto-promote |
| **1** | flow, orchestration, non-binding tools | offline → shadow → canary → ramp; human **notified** |
| **2** | money (commitments, autonomy scopes), guest-facing comms content, bookings, PII handling | offline → **human approval gate** → shadow → canary → **slow** ramp |
| **3** | objective, graders, corpus thresholds, spend-authorization model, legal/contractual terms | **human-authored only — prohibited for the loop** |

The tier is derived deterministically from a **static analysis of the actual diff** at
`artifact_ref` — **not** from the proposer's self-declared `capabilities_touched` (recomputing
from an attacker-controlled field just relaunders the claim). The proposer's declared
`capabilities_touched` / `risk_tier` are *claims checked against the diff*; an under-declaration
(declared tier < derived tier) is auto-rejected and escalated as a firewall-evasion signal.
Touching *anything* in a higher surface pulls the whole candidate up. The full total function —
surface map, tier floors, and reconciliation rules — is in `risk_tier_derivation.md`.

## 5. Human-in-the-loop

- **Tier 2 approval gate:** a person signs off before a money/comms/booking/PII change reaches
  even shadow. The grade report + hypothesis + diff are the review packet.
- **Standing loop supervisor:** a person who reviews the ledger on a cadence — what's been
  promoted, what's been rejected, what the breakers caught — and holds the authority to pause the
  loop, change tiers, or author Tier-3 changes.
- **Surprise escalation:** any candidate flagged suspect by the offline surprise check (aggregate
  gain without its hypothesized mechanism firing) routes to human review regardless of tier.

## 6. Rate limits and cooldowns

- Max *N* concurrent production experiments (the online clock's concurrency cap).
- Mandatory cooldown on a capability after any rollback touching it before another candidate for
  that capability may enter production — prevents thrashing a fragile area.
- Bounded ramp speed per tier (Tier 2 ramps slowest).
- Offline cycles are token/compute-budget bounded per the two-clock design.

## 7. Audit

- The ledger is an **append-only, hash-chained log** (each entry carries the prior entry's hash),
  on a WORM-backed store **outside the proposer's write scope** (§1). Append-only is enforced by
  the substrate, not by convention — the audit record of the firewall must not be rewritable by
  the thing it audits. `decided_by` is **bound to the deciding process's identity** (signed by the
  selector / risk-tier gate / experiment engine / breaker), not a self-set string a forged entry
  could spoof. Each transition records `decided_by`, rationale, and evidence, so "what changed and
  on what evidence" is fully — and tamper-evidently — reconstructable.
- Telemetry's PII discipline holds throughout: candidates and ledger entries reference couples and
  guests by id, never raw PII; sensitive free-text is `[REDACTED]` (see `../telemetry/README.md`).
- Promotions are attributable to the grade reports and experiment readouts that justified them —
  a promoted behavior can always be traced back to its evidence.

## The property all of these protect

A creative, high-variance, autonomous proposer is **safe to run** precisely because its blast
radius is bounded on every axis: reversible, tier-gated, independently scored, harm-circuit-broken,
and walled off from its own objective. Loosen any one of these and "autonomous self-improvement"
becomes "autonomous self-justification." Keep them and the loop can be bold, because the cost of a
bad idea is a reverted branch — not someone's wedding.
