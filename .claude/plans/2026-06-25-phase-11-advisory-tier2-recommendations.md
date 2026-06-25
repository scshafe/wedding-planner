# Phase 11 — Advisory tier-2 exploration → promotable recommendations

## Why this, why now

Phases 4b–10 made **every computed North-Star input trusted-backed** (rsvp, sentiment, qa, category,
cost, and — Phase 10 — `quality` via `vision_match`, the largest 0.40 component). But that entire
plan-side value is **DORMANT**: the autonomous search optimizes only the **tier-1 reminder box**
(cadence × spacing × batching), the `SearchProposer` **never emits a tier-2 genome** (the "box is
tier-1" guard, `search_proposer.ts:209-216`), and the plan-side scenarios (`required_categories`,
`vision_sensitive`) are **keystone-only by construction** (runtime-only `ScenarioDefinition` fields,
absent from `scenario_schema.json`). So consulting-the-couple value — the whole point of the tier-2
`autonomy_threshold` surface — **never reaches any output**. The 8 trusted effect kinds are
firewall-ready but never influence a champion or a recommendation.

The safety rail is the reason: **tier-2 (commitment autonomy) may not auto-land** — it requires an
exogenous human approval (`MAX_AUTONOMOUS_PROMOTION_TIER = 1`, `promotion_gate.ts:44`). So the
autonomous loop **cannot** optimize tier-2 directly. The honest move that respects the rail is to
**explore tier-2 candidates and SURFACE the best as ranked "promotable, pending human approval"
recommendations** — never landing them. This is the deferred **§4** the search-convergence memory
records ("no PROMOTABLE point" once tier-2 enters the search), and a concrete instance of the
additive oversight loop ([[agent-run-operations-model]]).

**Verified premise (empirically checked, scratch probe, then deleted):** on a vision-sensitive
scenario an honest tier-1 champion scores North-Star ratio **0.80**; an honest tier-2 candidate that
consults the couple scores **0.992** (vision_match 0.5→1.0, +10 couple-minutes) — a **+0.19**
improvement, accept-rule `accepted=true`, **zero gate failures**. So a tier-2 candidate, if proposed,
is **accepted-then-parked**. The advisory pass is **non-vacuous**: the parked set is a real
recommendation set.

## The design: an advisory wrapper around the existing engine (reuse, do not fork)

The advisory pass is `runOfflineLoop` (the SAME scorer / veto gates / integrity reconciliation /
promotion gate) configured so that **every accepted tier-2 candidate parks**, plus a thin wrapper that
**reinterprets** the parked set as recommendations. Reuse — not a parallel engine — is the safety
property: the firewall path is identical to production.

1. **Advisory plan-side corpus** — vision-sensitive scenarios (reuse the Phase-10 keystone builder).
   Separate from `RSVP_CORPUS`; **never** added to the tier-1 search corpus (byte-identity preserved).
2. **A SEPARATE advisory tier-2 proposer** — a distinct class (NOT a branch in `SearchProposer`) that
   enumerates tier-2 candidates by varying `autonomy_threshold` over a fixed tier-1 base genome. Emits
   ONLY tier-2 genomes (every candidate honestly derives tier 2 — declared tier matches
   `deriveRiskTier`, so it passes the pre-score reconciliation gate and reaches the park, never a
   firewall reject).
3. **Reuse `runOfflineLoop`** with the advisory proposer + advisory corpus + **`approvals: []`** +
   **isolated `ChampionStore` / `GenomeRegistry` / `Ledger`** → every accepted tier-2 candidate PARKS
   (`promotion_gate.ts:100-101`); champion never ratchets; no approval minted.
4. **Recommendation-report builder** — from the advisory summary + isolated ledger, emit one record per
   parked (promotable) candidate: `{ genome, advisory_champion, landing_key, north_star_delta }`,
   ranked by `north_star_delta` descending. Tag each record's provenance **"advisory recommendation —
   never entered the auto-loop"** so no reader confuses it with a real auto-loop park awaiting approval.
5. **Advisory certificate** — define `frontierFullyExplored = terminatedReason === 'converged' &&
   parked === accepted && promoted === 0` in the wrapper. Do **NOT** overload the generic
   `LoopTerminationReason.converged` with an advisory meaning. Pin `maxDryIterations >=
   advisoryBoxSize` so the frontier is explored before the dry cap trips (else the recommendation set
   is silently truncated).

## The load-bearing safety properties (from the architect + doddy design reviews — both APPROVE-WITH-CHANGES)

- **Provably cannot auto-land tier-2.** `approvals: []` → `runPromotionGate` re-derives tier from the
  content-addressed genome at the seam (`promotion_gate.ts:75`), routes tier≥2 to `human_review`, finds
  no approval, `parkCandidate` (no `championStore.promote`). The loop has no approval-minting method.
- **Recommendations are firewall-protected.** The advisory pass runs `scoreCandidateOffline` verbatim
  → `runVetoGates` → integrity reconciliation. A forged tier-2 candidate (claims vision 1.0 it can't
  earn, or shaves/suppresses the `vision_consult` cost) is VETOED → fails the accept rule → never
  reaches `onAccepted`/park → **excluded from the recommendation set**. A human only ever sees honest,
  trusted-backed recommendations.
- **Landing key is safe to surface.** `landingKeyFor` is a public content-address (sha256 of
  genome+champion hashes), an index an approval must bind to — not a credential. It auto-invalidates if
  the champion ratchets (re-review required); the report surfaces the `(genome, champion)` pair so the
  binding is explicit.
- **Isolated stores (doddy P1-A, HARD requirement).** The advisory pass MUST use throwaway
  `ChampionStore` / `GenomeRegistry` / `Ledger` — never the auto-loop's references — so an advisory run
  cannot corrupt the real champion, pollute the real audit trail / lessons stream, or make an advisory
  tier-2 genome resolvable in the main path.
- **Guard set as a positive rule (architect P2).** Advisory guards = **{all value metrics present in
  the advisory corpus} minus {`couple_active_minutes_total`}**. Excluding the cost is required (it is
  already priced into the North-Star denominator via `effort_cost`; guarding it double-counts and
  rejects every tier-2 candidate — empirically confirmed). Guarding the value metrics
  (`rsvp_resolution_rate`, `vision_match_rate`) closes the cross-value-regression hole.
- **Byte-identity holds.** Separate proposer class + separate corpus; `SearchProposer` and
  `RSVP_CORPUS` untouched; `quality` stays null on the search corpus.

## Steps

- [x] **Step 0 — Design reviews folded.** Architect + doddy (trust-boundary) lenses reviewed the design
  pre-build; both APPROVE-WITH-CHANGES. Findings folded into this plan: maxDry≥boxSize + certificate
  relabel (arch P1×2); isolated stores + separate proposer + park-can't-land keystone + advisory-park
  provenance (doddy P1-A/B/C, P2-A); positive guard rule + honest-tier-2 pre-score + (genome,champion,
  landing_key,delta) report + split (arch P2). _(This step is documentation-only; tick on commit.)_

- [x] **Step 1 — Advisory tier-2 proposer** (`loop-orchestrator/src/proposer/advisory_proposer.ts`).
  A distinct class implementing the `Proposer` interface, enumerating tier-2 candidates (vary
  `autonomy_threshold ∈ {1,2,3}` over a fixed tier-1 base). Every emitted genome derives tier 2 and
  declares tier 2 (passes the pre-score gate). `isConverged()` true when its finite box is exhausted.
  **Guard test** (sibling to `search_proposer.test.ts`): (a) `SearchProposer` still emits only tier-1;
  (b) the advisory proposer emits only tier-2 — so it can never be the auto-loop's proposer.

- [x] **Step 2 — Advisory plan-side corpus** (`loop-orchestrator/tests/fixtures/advisory_corpus.ts` or
  a `src/` fixture if the wrapper needs it at runtime). Vision-sensitive scenarios reusing the
  Phase-10 keystone scenario builder (single approval-free vision-sensitive category + single immediate
  guest). Assert it is NOT referenced by the tier-1 search corpus.

- [x] **Step 3 — Advisory pass wrapper** (`loop-orchestrator/src/loop/advisory_loop.ts`). Wire
  `runGenomeOfflineLoop`/`runOfflineLoop` with: advisory proposer, advisory corpus, the positive guard
  set (Step "guard rule"), `approvals: []`, **isolated** champion/registry/ledger, and
  `maxDryIterations >= advisoryBoxSize`. Return `{ recommendations, frontierFullyExplored, summary }`.
  The recommendation record = `{ genome, advisory_champion, landing_key, north_star_delta, provenance:
  'advisory' }`, ranked by `north_star_delta` desc. Unit-test: honest tier-2 candidates appear, ranked.

- [x] **Step 4 — The keystone** (`loop-orchestrator/tests/loop/advisory_recommendation_keystone.test.ts`).
  The load-bearing regression test (doddy P1-C): run the advisory pass and assert
  (a) `summary.promoted === 0`, `summary.parked > 0`; (b) the advisory champion hash is unchanged from
  seed AND a separately-constructed real champion store is untouched; (c) a **forged** advisory
  candidate (claims vision 1.0 / shaves the `vision_consult` cost) is REJECTED — never parked, never in
  the recommendation set; (d) the cross-value-regression candidate (vision-up but rsvp-down) is rejected
  by the value guard; (e) honest tier-2 candidates ARE surfaced with positive `north_star_delta`.

- [ ] **Step 5 — doddy boundary re-review** of the built code (not just the design): trace that no
  shared reference leaks, `approvals:[]` is enforced, and the forged-candidate exclusion holds against
  the real seams. Apply findings.

- [ ] **Step 6 — ADR 0011 + memory + handoff.** `docs/adr/0011-advisory-tier2-recommendations.md`; a
  memory file `advisory-tier2-promotable-recommendations.md` (+ MEMORY.md index) capturing: dormant
  plan-side value now surfaced as human recommendations; park==recommend reuse with isolated stores;
  the positive guard rule; the §4 certificate redefinition; never auto-lands. Update
  `.claude/handoff.local.md`.

## Out of scope (recorded, not faked)

- **Category-scenario half of the advisory corpus** — vision-only is enough to prove the mechanism
  (the keystone gives the builder). Adding category/qa scenarios to the advisory corpus is a clean
  follow-on (more recommendation variety), not load-bearing for the mechanism.
- **Moving plan-side scenarios INTO the tier-1 search corpus** — still blocked by the single-rubric
  0.40 over-weight (ADR 0010) and pointless for the tier-1 box (constant 0.5, no gradient). The advisory
  pass is the correct path to use the plan-side value without that distortion.
- **A real human-approval UI / oversight surface** — the recommendation report is the offline artifact;
  wiring it to a real human channel is a human-reserved operational step (offline-first; surface, don't
  fake).
- **`comms_quality` / `intuitiveness`** — still judge-shaped, STOP-gated (ADR 0007), unchanged.
