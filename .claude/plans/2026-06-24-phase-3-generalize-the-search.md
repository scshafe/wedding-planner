# Phase 3 — Generalize the offline search to a multi-parameter, non-separable landscape

**Status:** in progress. **Branch:** `build/phase-3-generalize-search`.
**Predecessor:** Phase 2 (planner-simulator substrate) — complete, merged to `main`.

## Why this phase
Phase 2 made the loop a real optimizer over a **1-D** genome (`rsvp_reminder_cadence`), with an
honestly-documented toy search: axis-aligned distance-1 steps + a **global** tabu, and a single
`proposer_exhausted` terminal state that conflates "local optimum" with "globally converged". wolf
deferred the generalization. This phase delivers it: a **2-D non-separable** genome, a search that
fills the box instead of hugging the champion, a **trajectory-relative** tabu, and a **termination
taxonomy** with a real convergence *certificate*.

## Design decisions (locked, with the review that forced them)

Two adversarial design reviews ran before this plan (the repo's specialist agents — wolf, doddy,
rigorous-architect, testineer — are not provisioned in this environment; see commit b1201fa, so the
reviews were run via `general-purpose` adversarial reviewers and are recorded here and in the
handoff). Their findings are folded into the steps below as **[R-…]** tags.

**D1 — the 2nd knob is `reminder_spacing` (tier-1, forge-free), NOT escalate-to-couple.**
See `.claude/memory/second-genome-knob-must-stay-tier1.md`. A tier-2 knob would break autonomous
operation (tier-2 needs human approval to land) and open a forge surface. `reminder_spacing` ∈ {0..3}
is the temporal analogue of cadence: bounded flow orchestration, manufactures no outcome.

**D2 — `reminder_spacing` is REQUIRED in the schema (re-baseline all genome hashes).** [R-arch-P1-4]
Optional + no-op-default would create a behavior-equal/hash-distinct alias (`{cadence:2}` vs
`{cadence:2,spacing:0}`) that defeats the dedupe key. Required = one canonical form. Spacing is tier-1
so requiring it does NOT inflate any genome's tier. Cost: re-baseline fixtures/seeds (one-time).

**D3 — the simulator model (Stage A), forge-free and non-separable:**
- `delivered(c,s) = min(cadence, max(0, SPACING_CAPACITY_BASE − spacing))` — more spacing fits fewer
  reminders in the window (a real downside), capping delivery below cadence.
- A guest resolves iff `needed ≤ delivered` (still from persona ground truth — **no manufacturing**).
- `nags = max(0, delivered − comfortCeiling)`; `penalty_per_nag = BASE_PENALTY · (1 − RELIEF·spacing)`
  — spacing makes each nag gentler (the upside). Sentiment = `1 − penalty_per_nag · nags`.
- Non-separability is **multiplicative** (penalty(spacing) · nags(cadence)) plus the capacity coupling
  — so `argmax_cadence` depends on spacing. Constants (BASE, RELIEF, CAPACITY_BASE, guest mix) are
  tuned **in the test by pinning the 16-value matrix**; North Star weights are NEVER touched.

**D4 — the search (proposer):**
- Searches the full 2-D integer box (cadence × spacing) = 16 points, perturbing a **copy of the
  champion's full parameter set** (never reconstructing from one key) [R-arch-P1-3].
- A **fixed, champion-INDEPENDENT, spread-first** enumeration of the box (NOT "low-discrepancy" — that
  word over-claims sophistication on 16 lattice points [R-search-P1-5]). It is **outcome-neutral under
  a box-sufficient budget**; it only changes which points are covered **under `maxIterations`
  truncation**. We prove that value with a `maxIterations < 16` test, or we cut it.
- **Trajectory-relative tabu**, keyed `(championHashAtProposal, genomeHash)` [R-search-P0-3]. A point
  that lost to a PRIOR champion is eligible again against the new baseline. Content-addressing + strict
  North-Star ascent on accept ⇒ no genome-space cycle.

**D5 — termination taxonomy** [R-search-P0-1, P0-2]:
- `converged` — for the **current standing champion**, all 15 other box points were proposed against
  *that same champion hash* and none was accepted. Tracked as
  `evaluatedAgainst: Map<championHash, Set<genomeHash>>`; the certificate fires only when
  `evaluatedAgainst.get(currentChampionHash).size === boxSize − 1`. This avoids the **mid-sweep
  promotion false-certify** (points scored against champion A must not count toward a B-certificate).
- **Wording is "no box point is acceptable against the standing champion" — NOT "global North-Star
  optimum".** With guards/golden conditions active, a higher-North-Star point can be vetoed, so
  `converged` is a *fixed-point-of-the-accept-rule* certificate, not a global-argmax certificate.
- `budget_exhausted` — `maxIterations` hit before the box was swept: **no** certificate.
- `dry` — `maxDryIterations` consecutive non-accepts before the proposer reported `converged`:
  stalled / not certified. (To obtain a certificate, run with `maxDryIterations ≥ boxSize`.)
- Independent bounds asserted at runtime + in tests: `accepts ≤ boxSize` and **no (champion, genome)
  pair scored twice** — these (not the scalar-ratchet argument, which assumes guard-free monotonicity)
  are what guarantee termination when guards bind [R-search-P0-3].

## Steps (each: `npm run build && npm test && npm run lint` green before ticking + committing)

- [x] **Step 1 — the 2nd genome parameter + stable derivation.**
  - `strategy_genome_schema.json`: add `reminder_spacing` (integer 0..3) to the **required** closed
    `parameters` set, with a description that pins it as a bounded flow/timing knob.
  - `risk_tier.ts`: add `reminder_spacing: 'planning_flow_orchestration'` to `GENOME_PARAMETER_SURFACES`
    with a precedent-guard comment (timing/spacing = flow, tier-1; must NOT auto-launder a content or
    segmentation knob). Sort `deriveRiskTier().perParameter` by parameter name for a stable ledger
    artifact [R-arch-P1-2].
  - Regenerate the contract TS type (`shared` codegen) if needed.
  - Re-baseline every genome fixture/helper/seed to carry both params (search the tree for
    `rsvp_reminder_cadence` constructions). Update `risk_tier.test.ts` (the cadence-only genome is now
    schema-invalid; assert the 2-knob max + sorted perParameter + that a 2-knob genome stays tier-1).
  - The drift-guard test already auto-covers the new param (reads the schema). Verify it passes.

- [x] **Step 2 — Stage A: the 2-D forge-free model (D3).**
  - Extend `rsvpCadencePlanner` to read `reminder_spacing`; implement `delivered`, the gentler-nag
    penalty, and the capacity cap. Keep resolution strictly from ground truth (forge-free). Document
    the model + constants in-code with the testineer-style "explicit modeling decision" comments.
  - Stage B (`stage_b_observer.ts`): **unchanged**, but add a comment documenting *why* no new trusted
    observation is needed — `reminder_spacing` manufactures no outcome (unlike escalation would), so it
    introduces **no new self-report-divergence surface**. This is the line: a knob that only modulates
    the ground-truth-derived computation needs no Stage-B cross-check; a knob that authors an outcome
    does [R-arch-P0-2/P0-3, recorded as the rejected path].

- [x] **Step 3 — the oracle for the 2-D model.**
  - Extend `metamorphic_oracle.test.ts`: per-axis monotonicity where it holds; **anchored** values
    (hand-reasoned from latency labels × spacing, surviving a sign-flip/off-by-one); the multiplicative
    sentiment relation; anti-no-op for `reminder_spacing` (flipping only spacing changes the stream AND
    moves a metric, correct sign); boundary fixed-points.
  - **Pin the full 16-value North-Star matrix** for the keystone corpus and DERIVE from it:
    coordinate-descent fixed point `S`, global argmax `G`, and assert `G` is **interior** (strictly
    beats all in-box axis AND diagonal neighbors) and **off-axis from `S`** (the non-separability
    witness) [R-search-P0-4, P1-6]. Assert strict regression on BOTH sides of the optimum on each axis.
  - Add a constant-sensitivity test: perturb a model constant ±a stated margin, assert the optimum
    stays interior within a documented band (anti-brittleness; names the band honestly) [R-search-P1-6].

- [x] **Step 4 — generalize `SearchProposer` to 2-D (D4).**
  - Replace the 1-D distance-ordered enumeration with the fixed champion-independent spread-first box
    enumeration; perturb a copy of the champion's full parameters. Trajectory-relative tabu keyed
    `(championHash, genomeHash)`. Keep the content-addressing, registry, and honest
    `deriveRiskTier`-derived risk_tier intact.
  - Rename the `exploit`/`explore` label honestly or drop it; update the docstring (no more "global
    tabu" limitation — it's fixed here).
  - Update `search_proposer.test.ts` for the 2-D behavior (re-centering after promotion in 2-D;
    trajectory-tabu re-eligibility; full-box coverage per champion).

- [x] **Step 5 — termination taxonomy in the loop (D5).**
  - Proposer exposes its terminal signal: when it returns null, the per-champion coverage set is full
    ⇒ `converged`. Add `evaluatedAgainst` tracking + the `size === boxSize−1` gate.
  - Extend `LoopTerminationReason` / `OfflineLoopSummary` so the genome loop surfaces `converged`
    (certificate) vs `dry` vs `budget_exhausted`, with the certificate's true meaning documented.
  - Assert the runtime invariants: `accepts ≤ boxSize`, no pair scored twice.

- [ ] **Step 6 — THE KEYSTONE (the proof the generalization earns its keep).**
  - **(a) old-algo-fails:** instantiate the OLD axis-aligned-distance-1 + global-tabu search (a faithful
    local reproduction in the test, ~30 lines) and assert it stalls at champion `S ≠ G` on the pinned
    non-separable landscape. *This test must be RED on the old algorithm* [R-search-P0-4].
  - **(b) new-algo wins:** same seed/corpus/constants, the new loop ratchets the champion to `G`.
  - **(c) certificate:** with `maxDryIterations ≥ boxSize`, the loop terminates `converged` and the
    champion is the box optimum-by-accept-rule; assert the no-acceptable-point meaning (incl. a
    guard-active arm where a higher-NS point is guard-rejected and we do NOT call it a global optimum)
    [R-search-P0-1].
  - **(d) stalled vs converged:** with a small `maxDryIterations`, the loop terminates `dry` (no
    certificate) — the taxonomy distinction the handoff asked for.
  - **(e) guard-active termination:** a guard config making the accept sequence non-NS-monotone; assert
    the loop still terminates via the `accepts ≤ boxSize` bound [R-search-P0-3].
  - **(f) spread-ordering value:** with `maxIterations < boxSize`, the spread order reaches a
    far-from-seed winner a champion-local order would miss within the same budget — or this sub-test
    fails to exist and we CUT the spread ordering [R-search-P1-5].

- [ ] **Step 7 — memory + ADR + handoff.**
  - ADR under `docs/adr/` recording D1–D5.
  - Memory: the `converged` certificate semantics (no-acceptable-point ≠ global optimum); the
    non-separability-via-multiplicative-sentiment fact; spread-ordering only matters under truncation.
  - Update `.claude/handoff.local.md`.

## Invariants this phase must not break
- Offline-first; no real side effects; one safety model; `ops/` and `CLAUDE.md` untouched.
- North Star **weights** are never tuned (only simulator/corpus constants — and those are pinned via
  the matrix test, not reverse-engineered silently).
- The content-address firewall: validate-before-bind, refuse-and-halt on mismatch, honest
  `deriveRiskTier`, content-hash dedupe.
- Stage A/B independence keeps `INTEGRITY.SELF_REPORT_DIVERGENCE` non-vacuous.
