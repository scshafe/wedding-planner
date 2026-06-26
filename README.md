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

## The domains

The first four are **inward-facing** (the engine: how the system scores, measures, improves, and
operates itself). The fifth — `product/` — is the **outward-facing** customer surface (the car).

| domain | owns | one-liner |
|---|---|---|
| [`eval-harness/`](eval-harness/README.md) | what "good" means | simulated couples/guests + scenarios + rubrics + the North Star scoring model; the offline fitness function |
| [`telemetry/`](telemetry/README.md) | how it's measured | the canonical event schema + metric catalog; every gate/metric is a function over a **trusted** event stream |
| [`loop-orchestrator/`](loop-orchestrator/README.md) | how it improves itself | propose → score offline → guardrail-gate → shadow/canary/ramp → promote; the recursive product-improvement loop |
| [`agent-operations/`](agent-operations/README.md) | how the whole stack is run | the team of agents (CI/CD, support, SRE, security, the loop itself) and the four human-reserved exceptions |
| [`product/`](product/README.md) | the customer-facing surface | the white-label, multi-tenant web app planners + couples use; built offline-first toward a launch-ready Docker image. Phase 12 lays the multi-tenant domain core + the tenant-isolation boundary; Phase 13 adds the HTTP request edge + the intra-tenant auth boundary (planner vs couple); Phase 14 adds the server-rendered, themed web UI over that pipeline; Phase 15 adds the operator-gated onboarding + billing simulation that drives the tenant lifecycle |

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

**The customer-facing product surface — now under construction.** Everything above is the *engine*:
how the system scores, measures, and improves itself. For this to be the **business** it is meant to
be, it needs the **product** — a **white-label, multi-tenant** web app that real wedding planners and
their couples sign up for, theme, and use. This is a first-class goal, built **offline-first as a
deployable Docker container** (locally runnable, demoable, launch-*ready*; onboarding/billing/comms
simulated offline); **actually going live stays human-reserved** (real hosting, tenants, money, comms).
**Phase 12 began it:** the fifth domain [`product/`](product/README.md) — the `tenant` + `wedding`
aggregates and the tenant-isolation boundary (the multi-tenancy analogue of the trusted-evidence
firewall: an unforgeable, WeakSet-branded `TenantContext`; the partition key derives from the context
alone; no existence oracle; liveness re-asserted at use). **Phase 13 added the request edge** — a pure
HTTP handler + a thin Node `http` adapter over a 5-stage pipeline, and the **simulated auth/session**
layer that stacks the **intra-tenant** boundary (planner vs couple) on top: a couple may act only on
their own wedding, and a couple addressing any other wedding gets a `404` byte-identical to a missing
one (no intra-tenant existence oracle). **Phase 14 added the web UI** — a server-rendered, themed,
white-label HTML console over that same JSON pipeline (offline-first, zero new deps, no client
JavaScript): planners and couples log in and view their weddings, themed per tenant. It is repo-blind
(its only data path is `api.handle()`, so it inherits both boundaries) and discloses **exactly** what the
API already does — branding shown only for *active* tenants, while unknown / suspended / onboarding all
render one byte-identical generic `404` (theming never becomes an absent-vs-suspended oracle). **Phase 15
added onboarding + billing simulation** — a third trust tier (a platform **`Operator`**, peer of
`Principal`) that provisions tenants and drives the lifecycle (`onboarding → active → suspended → active`)
through a modeled billing ledger, over an operator-gated `/admin` surface folded into the same pipeline.
It is **operator-gated precisely so it adds no new anonymous oracle**: anonymous self-serve signup would
leak slug-occupancy for every lifecycle state, so it stays a recorded deferral; the absent≡suspended≡
onboarding mask is preserved by construction, and re-proven by an onboarding keystone. **Phase 16
completed the arc — the deployable Docker image.** A composition root (`composeProductSurface`) wires the
whole surface from *injected* primitives and an entrypoint (`app/server.ts`) serves it; `docker run` boots a
themed demo tenant at `/t/demo`. The entrypoint is the one **imperative shell** where ambient reality enters
— so the determinism rail holds everywhere else *by reachability* (the wall clock + uuid id source live in
`product/` where the eval/loop core can't import them), and the operator credential is **injected, never
baked** (no `ARG`/`ENV` for it; a `≥16`-char floor or fail-closed). The image was built and run locally to
verify; **it is never pushed — going live stays human-reserved**. See
[`docs/adr/0012`](docs/adr/0012-product-surface-multitenant-core.md),
[`docs/adr/0013`](docs/adr/0013-http-api-and-intra-tenant-auth.md),
[`docs/adr/0014`](docs/adr/0014-server-rendered-web-ui.md),
[`docs/adr/0015`](docs/adr/0015-onboarding-billing-simulation.md),
[`docs/adr/0016`](docs/adr/0016-deployable-docker-image.md) (run recipe:
[`docs/RUNNING_THE_IMAGE.md`](docs/RUNNING_THE_IMAGE.md)), and the boundary in [`CLAUDE.md`](CLAUDE.md).

**Also open / earlier threads:**
- **A guest-facing messaging channel** *(roadmap goal)* — wedding guests text the AI (SMS/WhatsApp/…) for
  info, updates, and Q&A. The guest↔AI Q&A loop is already modeled and scored inward (`qa_accuracy`); the
  missing piece is the product channel + a **provider-agnostic** messaging port (swappable, offline-simulated
  adapters — no vendor lock-in) with **usage-metered pricing** (messaging is metered, so it extends the
  flat-monthly price book and feeds the North-Star cost term). Built offline-first; a real provider sending
  real texts stays human-reserved (guest comms is tier-2). See
  [`CLAUDE.md`](CLAUDE.md) and `.claude/memory/guest-messaging-channel-is-a-roadmap-goal.md`.
- The **action→surface/scope map** — trusted config mapping an operational action to its blast-radius
  surface and each role to a machine-checkable scope; the ops analogue of
  [`loop-orchestrator/risk_tier_derivation.md`](loop-orchestrator/risk_tier_derivation.md), required
  before derived-tier and `SCOPE_EXCEEDED` are computable for ops actions. *(Named dependency, open.)*
- **Agent strategy-autonomy scope** — whether/how agents may ideate and ship *growth* (e.g. setting
  pricing or signing planner contracts for the white-label platform), with irreversible business
  commitments still human-reserved. A design thread, not yet decided.
