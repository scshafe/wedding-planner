# ADR 0002 — Generalize the offline search to a multi-parameter, non-separable genome

- **Status:** accepted
- **Date:** 2026-06-24
- **Decider:** the building agent (an agent-owned engineering decision per
  [[agents-own-buildout-decisions]] and `.claude/plans/2026-06-24-phase-3-generalize-the-search.md`)
- **Scope:** Phase 3 — the offline optimizer only. Offline-first, deterministic, no production blast
  radius. North Star **weights** untouched (only the simulator/corpus constants were tuned, pinned by
  the matrix test).

## Context

Phase 2 made the loop a real optimizer over a **1-D** genome (`rsvp_reminder_cadence`) but with a toy
search the code itself flagged: axis-aligned distance-1 steps, a **global** tabu, and a single
`proposer_exhausted` terminal state that conflated "stuck" with "done". wolf deferred the
generalization. Two adversarial design reviews ran before implementation (the repo's specialist
sub-agents — wolf/doddy/rigorous-architect/testineer — are not provisioned in this environment, see
commit b1201fa; reviews were run via `general-purpose` adversarial reviewers). Their P0/P1 findings
shaped every decision below.

## Decisions

### D1 — the second knob is `reminder_spacing` (tier-1, forge-free), NOT escalate-to-couple

The autonomous offline loop promotes accepted genomes itself. A **Tier-2** action requires human
approval to land (`oversight_record` `human_gate`); Tier-3 blocks. So the autonomously-optimizable
surface is exactly the **tier-1** box — a tier-2 knob would either break the autonomy rail or block
the search. The tempting escalate-to-couple knob is `commitment_autonomy` (tier-2) AND manufactures a
trusted outcome (a forge surface). We rejected it and chose `reminder_spacing`: the temporal twin of
cadence (bounded flow/timing → `planning_flow_orchestration`, tier-1) that **manufactures no outcome**
(a guest still resolves only if its ground-truth need is met). See
`.claude/memory/second-genome-knob-must-stay-tier1.md`.

### D2 — `reminder_spacing` is REQUIRED (re-baseline all genome hashes)

An optional, no-op-default knob would let one behavior carry two content-addresses
(`{cadence:2}` vs `{cadence:2,spacing:0}`) and defeat the dedupe key. Required = one canonical form.
Spacing is tier-1, so requiring it does not inflate any genome's tier. Cost: a one-time fixture/seed
re-baseline.

### D3 — a forge-free, non-separable simulator model

`delivered = min(cadence, capacity(spacing))` (spacing fits fewer nudges in the window — a real
downside) and `penalty_per_nag = base·(1 − relief·spacing)` (gentler nags — the upside) make the
sentiment term **multiplicative** (`penalty(spacing)·nags(cadence)`), so the optimal cadence depends
on spacing. The capacity profile `[3,3,1,0]` yields a STRICT, UNIQUE, INTERIOR optimum at
(cadence 2, spacing 1), pinned by the 16-value matrix oracle. At spacing 0 the model equals Phase 2.

### D4 — full-box, champion-independent, spread-first search + trajectory-relative tabu

The proposer enumerates the whole (cadence × spacing) box in a fixed bit-reversal (van der Corput)
order — **outcome-neutral under a box-sufficient budget**, valuable only under `maxIterations`
truncation (honest framing; not "low-discrepancy sophistication" on 16 points). The tabu is keyed
`(championHashAtProposal, genomeHash)`, so a point re-opens once the champion ratchets (fixing the
Phase-2 global-tabu interaction-miss).

### D5 — a termination taxonomy with an honest certificate

`converged` (the proposer exhausted the box against the standing champion with nothing acceptable —
"no ACCEPTABLE point", NOT a global-North-Star optimum, since guards/golden conditions can veto a
higher-NS point) vs `dry` (stalled before the box was swept) vs `budget_exhausted` (cap hit first).
Termination is guaranteed because every accept strictly raises the champion North Star (accept
condition 4), so over a finite content-addressed genome space promotions are bounded and no champion
recurs — even with binding guards.

## Consequences

- The keystone is **red on the old 1-D search** (it stalls at (cadence 2, spacing 0)) and **green on
  the new** (reaches (cadence 2, spacing 1)) — the generalization is proven, not asserted.
- The escalate-to-couple knob remains valuable LATER as the phase that makes the firewall's tier-2
  human-gate + integrity forge-detection load-bearing — as its own gated phase, never folded into the
  autonomous search.
- Adding a third knob needs: schema edit (required) + surface-map entry + the box generator extended
  to the new dimension. The matrix oracle will re-pin; the certificate/taxonomy are dimension-agnostic.
