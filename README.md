# Wedding Planner

> ## 🤖 This repository is entirely agent-managed
> It is **built, maintained, and operated by autonomous AI agents** (Claude Code) running on a
> schedule — humans set the goals and the safety rails; agents own every engineering and direction
> decision. A scheduled loop reads the continuation state, continues the current plan or writes the
> next one, builds it (green at every commit, on a `build/*` branch), and keeps `main` current.
> **If you are a Claude session, read [`CLAUDE.md`](CLAUDE.md) first.** How the loop runs and how to
> deploy it on a server is in [`ops/AUTONOMOUS_OPERATION.md`](ops/AUTONOMOUS_OPERATION.md); where the
> last run left off is in [`.claude/handoff.local.md`](.claude/handoff.local.md).

An AI wedding planner + guest-communication service that handles a wedding top-to-bottom — venue,
catering, music, invitations, RSVPs, guest Q&A, seating, tailored comms — and **improves and
operates itself** under a team of agents, with humans on a narrow exception path.

This repository began as **design specs** and is being built out, domain by domain, by the
autonomous loop. Each domain has its own `README.md`; start there. Running code now exists for the
offline core (telemetry, eval-harness, loop-orchestrator) — see the git history on `main`.

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

**The offline core is real, running code.** `telemetry/`, `eval-harness/`, and `loop-orchestrator/`
are implemented and green through eleven autonomous build phases — the trusted-evidence integrity arc
(every North-Star input is now trusted-backed, not self-reported) plus an advisory tier-2
recommendation layer. `agent-operations/` is specs + the hardened **oversight-loop mechanics**
([`agent-operations/oversight_loops.md`](agent-operations/oversight_loops.md): three tempos, the
additive-only review gate, the L0–L4 who-watches-whom DAG) and the eval→prod evidence boundary
([`agent-operations/trusted_evidence_channel.md`](agent-operations/trusted_evidence_channel.md):
verifying path ≠ acting path, signed liveness that fails closed, key custody outside every agent). The
autonomous loop advances `main` when green; where the last run left off is in
[`.claude/handoff.local.md`](.claude/handoff.local.md).

**The next strategic direction — the customer-facing product surface.** Everything above is the
*engine*: how the system scores, measures, and improves itself. For this to be the **business** it is
meant to be, it needs the **product** — a **white-label, multi-tenant** web app that real wedding
planners and their couples sign up for, theme, and use. This is now a first-class goal. It is built
**offline-first as a deployable Docker container** (locally runnable, demoable, launch-*ready*;
onboarding/billing/comms simulated offline); **actually going live stays human-reserved** (real
hosting, tenants, money, comms). The autonomous loop owns when it starts and how it's built — see the
boundary in [`CLAUDE.md`](CLAUDE.md).

**Also open / earlier threads:**
- The **action→surface/scope map** — trusted config mapping an operational action to its blast-radius
  surface and each role to a machine-checkable scope; the ops analogue of
  [`loop-orchestrator/risk_tier_derivation.md`](loop-orchestrator/risk_tier_derivation.md), required
  before derived-tier and `SCOPE_EXCEEDED` are computable for ops actions. *(Named dependency, open.)*
- **Agent strategy-autonomy scope** — whether/how agents may ideate and ship *growth* (e.g. setting
  pricing or signing planner contracts for the white-label platform), with irreversible business
  commitments still human-reserved. A design thread, not yet decided.
