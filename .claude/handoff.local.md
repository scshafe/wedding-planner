# Handoff

## Where things stand — Phase 2 (the planner simulator substrate) is BUILT ✅
`.claude/plans/2026-06-24-phase-2-planner-simulator-substrate.md` is **complete — all 7 steps ticked**,
on branch **`build/phase-1-offline-core`** (now 19 commits ahead of `main`; 8 added this run). Working
tree clean. **No git remote** (user declined the push), so the branch is the review artifact.
`npm run build && npm test && npm run lint` all green (**166 tests**, up from 107).

**What changed:** the offline loop went from *optimizing nothing* to a **real optimizer**. In Phase 1
the `ProductRunner` was candidate-blind — a hand-set `improve` boolean (not the candidate's content)
decided wins. Now a candidate carries a structured **strategy genome** that a deterministic two-stage
**planner simulator** interprets into different plans → events → metrics → North Star, scored by the
**unmodified** harness; a **heuristic search proposer** perturbs a **champion** genome that ratchets on
accept (real hill-climbing). Fully offline/deterministic, zero side effects — same rails as Phase 1.

### What's running (additions this phase)
- **`shared/`** — `strategy_genome` contract (the 13th, content-addressed: `artifact_ref =
  genome:<sha256(canonicalJson(parameters))>`); `genome.ts` (hash + `classifyGenomeArtifactRef`
  match/mismatch/malformed); `risk_tier.ts` (`deriveRiskTier` + the genome→surface map — the firewall's
  first real mechanism, `risk_tier_derivation.md` was doc-only before).
- **`eval-harness/`** — the **planner simulator**: **Stage A** (`stage_a_planner.ts`, planner→claims
  from persona `rsvp_truth`) / **Stage B** (`stage_b_observer.ts`, trusted record from persona ground
  truth, never from Stage A — keeps `INTEGRITY.SELF_REPORT_DIVERGENCE` non-vacuous); content-address
  enforced at construction. Plus the non-circular **metamorphic + anchored + anti-no-op oracle**.
- **`loop-orchestrator/`** — `ChampionStore` (ratchet), content-addressed `GenomeRegistry`,
  `SearchProposer` (perturbs champion, dedupe on genome hash), `reconcileCandidateRiskTier` (re-derives
  the tier, rejects under-declaration), and `runGenomeOfflineLoop` wiring it all + the **keystone test**.

### Specialist reviews — all found real issues, all applied + journaled
- **doddy** (Steps 1, 2): content-addressing is the firewall binding; **validate-before-bind**, distinct
  refuse-and-halt verdicts, fixed a schema-prose/map tier contradiction, pinned the closed-set fact.
  Memory: **[[genome-content-address-firewall]]**.
- **testineer** (Steps 4, 7): the metamorphic relations are only self-*consistency* checks — added
  **anchored** oracles (hand-reasoned values that survive a sign-flip); the keystone now proves the
  causal chain with a non-target scenario making attribution test *localization*, strict-regression on
  the negative arm, and `accepted===2`/`proposer_exhausted`/overshoot-tried-and-refused on the loop.
- **wolf** (Step 6): the exploit/explore split is *relabeled enumeration*, not a policy; the global tabu
  poisons re-exploration after a champion move. Documented honestly + **deferred** the fix (see below).

## Next action — pick the next phase (each its own plan, gated behind this substrate)
The loop now optimizes a real (simulated) fitness landscape. Highest-value candidates, your call:
1. **Generalize the search (wolf's deferred work)** — fully offline, no credentials, the natural next
   step. Multi-parameter genomes; replace axis-aligned distance-1 steps + global tabu with a
   **trajectory-relative tabu + a low-discrepancy deterministic sequence**, and a **termination taxonomy**
   that distinguishes "local optimum" from "globally converged" (today both surface as `dry`/exhausted).
   Add genome parameters beyond `rsvp_reminder_cadence` (each needs a schema edit + a surface-map entry).
2. **Real Claude-Agent-SDK proposer** — plugs into the SAME `Proposer` interface + genome type.
   **Needs API credentials → STOP-and-surface** (the local-only rail): write it in the handoff and stop,
   do not fake calls.
3. **Production funnel** (`loop-orchestrator/experiment_design.md`) — first real blast radius, heavily
   gated; offline-first means simulate, no real ramp.

**Recommend #1** (search generalization) — it's the honest, in-rails next lever and wolf already scoped it.

## Non-obvious Phase-2 context (carry forward)
- **Guards vs North Star (deliberate):** the cadence tradeoff lives in the **North Star** (guest_sentiment
  feeds `guest_experience`), NOT as a hard guard. If `guest_sentiment_score` were a hard guard, *every*
  cadence increase would regress it and the loop could never climb. The loop's default `guards: []`; the
  interior optimum (cadence 2 on the keystone corpus, ratios ~0.56/0.68/0.78/0.75) emerges from the North
  Star. A separate keystone arm proves the guard *mechanism* still works when sentiment IS a guard.
- **COMFORT_CAP nag model** (`stage_a_planner.ts`) is an explicit choice: a universal comfort ceiling
  (a 2nd+ reminder mildly annoys even when it converts), so the guard has a gradient even without an
  unreachable guest. Documented in-code; revisit if it distorts the gradient the real proposer climbs.
- **Promotion is offline-only:** the loop promotes the champion on offline-ACCEPT (offline has no
  `promoted` transition). The champion ratchets monotonically; lineage is a `champion_lineage:` lesson on
  the accepted ledger entry (the loop only forwards *rejected* lessons to the proposer, so it's inert).
- **`deriveRiskTier`'s fail-closed throw is unreachable for valid input** (closed schema + drift guard) —
  it's defense-in-depth against schema/map drift; the drift-guard test is the primary protection.
- **`npm run build` is still `tsc --noEmit`** (a strict typecheck), no emit. Phase-1/2 runtime is the
  test-driven core; a real emit (project refs / bundler) is needed before any deployable runtime.
- Durable facts: `MEMORY.md` index — Phase-2 added **[[genome-content-address-firewall]]**; still load-
  bearing: [[loop-trusted-evidence-boundary]], [[integrity-gate-completeness-invariants]],
  [[accept-rule-composition-invariance]], [[prod-trusted-evidence-channel]].
