# Wedding Planner

An AI wedding planner + guest-communication service that handles a wedding top-to-bottom — venue,
catering, music, invitations, RSVPs, guest Q&A, seating, tailored comms — and **improves and
operates itself** under a team of agents, with humans on a narrow exception path.

This repository currently holds the **design specs** for that system (not yet running code),
across four domains. Each has its own `README.md`; start there.

## The four domains

| domain | owns | one-liner |
|---|---|---|
| [`eval-harness/`](eval-harness/README.md) | what "good" means | simulated couples/guests + scenarios + rubrics + the North Star scoring model; the offline fitness function |
| [`telemetry/`](telemetry/README.md) | how it's measured | the canonical event schema + metric catalog; every gate/metric is a function over a **trusted** event stream |
| [`loop-orchestrator/`](loop-orchestrator/README.md) | how it improves itself | propose → score offline → guardrail-gate → shadow/canary/ramp → promote; the recursive product-improvement loop |
| [`agent-operations/`](agent-operations/README.md) | how the whole stack is run | the team of agents (CI/CD, support, SRE, security, the loop itself) and the four human-reserved exceptions |

## How they fit together

```
        agent-operations/  ── the team of agents that runs everything
                │   (loop-orchestrator is ONE member of this team)
                ▼
        loop-orchestrator/ ── proposes & ships product changes
                │   scores candidates against ↓ , reads metrics from ↓
                ▼
   eval-harness/  ◄──reads metric_codes / computes gates──  telemetry/
   (what good is)                                          (how it's measured)
```

## Load-bearing design decisions (the throughlines)

- **One safety model, everywhere.** Reversibility, trusted-evidence gates, out-of-band circuit
  breakers, an append-only hash-chained ledger, risk-tiered autonomy + human gates. The
  product-improvement loop and every ops agent inherit the *same* invariants.
- **The graders' inputs are trusted, not the product's self-report.** "A metric is a pure function
  over events" is determinism, not integrity — so security-relevant ground truth comes from the
  harness's out-of-band trusted recorder and grader-side determinations, never product-set fields.
  In production there is no sandbox, so this extends to walling the evidence *channel* itself (feed
  config, credentials, signing keys are agent-unwritable, with liveness asserted) — see
  [`agent-operations/oversight_loops.md`](agent-operations/oversight_loops.md).
- **Two narrow human boundaries.** Product money is propose-confirm with opt-in autonomy (the
  couple's budget); the *business's* own finances/legal, total system failure, security breaches,
  and elevated support are the four operational exceptions. Everything else is agent-run.

## Status & next step

All four domains are **specs**, reviewed (security / statistics / architecture) and hardened. None
is implemented as running code yet. The **oversight-loop mechanics** are now designed and hardened
(security + architecture review, P0/P1/P2 applied) in
[`agent-operations/oversight_loops.md`](agent-operations/oversight_loops.md): three oversight tempos,
the additive-only review gate, the L0–L4 who-watches-whom DAG, and the eval→prod evidence boundary —
whose production realization is specified in
[`agent-operations/trusted_evidence_channel.md`](agent-operations/trusted_evidence_channel.md)
(verifying path ≠ acting path, signed liveness that fails closed, key custody outside every agent).

**Next steps:**
- The **action→surface/scope map** — trusted config mapping an operational action to its blast-radius
  surface and each role to a machine-checkable scope; the ops analogue of
  [`loop-orchestrator/risk_tier_derivation.md`](loop-orchestrator/risk_tier_derivation.md), required
  before derived-tier and `SCOPE_EXCEEDED` are computable for ops actions. *(Named dependency, open.)*
- **Agent strategy-autonomy scope** — whether/how agents may ideate and ship *growth* (e.g. a
  white-label multi-tenant pivot), with irreversible business commitments still human-reserved. A
  design thread, not yet decided.
- **Implementation** — the Claude Agent SDK substrate the loop README sketches; the repo is still
  all design specs.
