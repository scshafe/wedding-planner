# Handoff

## Where things stand — Phase 5 (3rd tier-1 knob, 3-D search) is BUILT ✅
`.claude/plans/2026-06-24-phase-5-third-tier1-knob-3d-search.md` is **complete — all 7 steps ticked**,
on branch **`build/phase-3-generalize-search`** (the open review artifact for `main`; 3/4a/4b/5 build on
it; the loop's merge-keeper advances `main` when green). Working tree clean.
`npm run build && npm test && npm run lint` all green (**249 tests**, up from 234 at the start of this run).
`main` contains Phase 1 + Phase 2; this branch is the review artifact for Phases 3, 4a, 4b **and 5**.

**What changed:** the autonomous offline search went from **2-D to 3-D**. A 3rd TIER-1, forge-free flow
knob — **`reminder_batching`** (digest consolidation) — joins cadence × spacing, so the search box is now
the 64-point cube (all tier-1). The optimum is genuinely **non-separable** (the optimal cadence flips with
batching) and the 3-D landscape has a **coordinate-descent trap the full-box sweep escapes** — a sharper
"old search misses it" than 2-D could claim. No new tier-2 surface: escalation/`autonomy_threshold` stays
injected-only, and the 4a/4b tier-2 firewalls are untouched. See `docs/adr/0005`.

### What's new this phase (by step)
- **Step 1** — `reminder_batching` (int 0..3, REQUIRED) in the schema + risk map (tier-1
  `planning_flow_orchestration`, with the doddy precedent-guard weld) + the SHARED digest FACT in
  `domain_facts.ts` (`digestSize`, `effectiveNudges`, `feltTouches`; identity at b=0). Threaded `b:0`
  (behavior-identical) through every genome fixture/`parameters` literal (the required knob makes
  omitting genomes schema-invalid). Re-baselines every genome content-hash by design (no `genome:` hashes pinned).
- **Step 2** — batching wired into BOTH stages together (the forge weld): Stage A's `guestOutcome` (reach
  dilution + comfort consolidation) AND Stage B's `reminderResolves` (IDENTICAL `effectiveNudges` reach
  calc via the shared fact). Model oracle: hand-anchored reach/comfort values, batching reach- &
  comfort-monotonicity (with strict-movement anti-vacuity pins), anti-no-op, boundary fixed-points;
  Stage B↔honest Stage A agreement sweep extended to the full 64-point cube.
- **Step 3** — the 3-D cube oracle (live `cube()` relations, not pinned cells): b=0 slice byte-identical
  to the pinned 2-D matrix; UNIQUE strict optimum at **(cadence 3, spacing 1, batching 1)=0.8151** over its
  axis neighbours (margin ~0.0130); strictly beats every b=0 point; non-separable BOTH directions
  (`[2,3,1,1]` argmax cadence + argmax batching depends on cadence). Honest-claims boundary documented.
- **Step 4** — SearchProposer enumerates the 64-point cube spread-first; `batchingMin/batchingMax` spec
  knobs; the "never emits `autonomy_threshold`" guard re-asserted over the 3-D box (BOX_SIZE 64, coverage 63).
- **Step 5** — loop keystone converges (certificate) to (3,1,1) from (0,0,0) and the opposite corner
  (3,3,3); `maxDryIterations` bumped past the 64-box; NEW 2-D-blind contrast (batching pinned 0 STALLS at
  (2,1,0), missing the 3-D win).
- **Step 6** — THE tier-1 dilution-forge keystone arm: a lying Stage A claiming a batching-diluted-away
  resolution moves the claimed rate above the champion (RED) but the integrity gate vetoes it and it is
  not accepted (GREEN) — the sole stopper (the candidate is tier-1, no promotion-gate park). Companion
  arm: the honest batching candidate is gate-clean.
- **Step 7** — `docs/adr/0005` + memory ([[third-tier1-knob-batching-3d-search]] + updates to
  [[second-genome-knob-must-stay-tier1]] and [[search-convergence-certificate-semantics]] §3/§4) + this handoff.

## Next action — your call. Recommended: Phase 6 = LLM-judge quality OR a real claimed-metric reconciliation
The 3-D autonomous search, both tier-2 firewalls, and the forge-detection are all load-bearing. In-rails options:
- **Wire the `quality` North-Star component** (currently always `null` — no LLM rubric scores). This is the
  biggest unbuilt value lever (PLANNING_VALUE_WEIGHTS.quality = 0.4, the largest weight, dropped today).
  Offline-first: a deterministic stub rubric over the simulator's claimed plan, OR — if it needs a real
  Claude judge — that requires API credentials → STOP-and-surface (the local-only rail). Decide which.
- **Close the `guest_sentiment_score` claimed-only gap** (D7 / [[third-tier1-knob-batching-3d-search]]):
  give sentiment a trusted backing so the firewall covers the metric batching now enlarges. This is the
  natural forge-detection follow-on; `wolf`/`doddy` territory (a trusted sentiment observation in Stage B).
- **A 4th tier-1 knob → 4-D** (e.g. a timing-of-day knob): more of the same search-generalization; lower
  marginal value than the two above, and a timing knob needs per-guest receptivity ground truth + Stage B
  reach changes (see ADR 0005 alternatives).
- **The deferred §4 convergence redefinition** — still only worth doing as a prelude to putting tier-2 in
  the autonomous search, which memory says not to do; low priority.

## Non-obvious Phase-5 context (carry forward)
- **Honest-claims boundary (do NOT overclaim):** the optimum is interior on batching+spacing but on the
  cadence FACE (3). Claim "interior on the NEW axis + non-separable + dominates every b=0 point", NEVER
  "3-D interior optimum". Do not retune constants to manufacture a cube-interior optimum.
- **The b=0 slice is byte-identical to the Phase-3 2-D matrix** — that's the backward-compat oracle and the
  reason all prior anchored/2-D tests survived untouched. Keep batching 0 an EXACT reduction (`ceil(x/1)=x`).
- **Stage B reads `reminder_batching` too** (it mirrors the reach dilution). If a future change touches the
  reach model, BOTH stages must move together via the shared `domain_facts.ts` fact, or honest runs self-veto.
- **`guest_sentiment_score` is still claimed-only/unreconciled** (like `qa_accuracy_rate`); batching enlarges
  that unreconciled value — an acknowledged, pre-accepted deferral (D7), not a silent inheritance.
- **The search box is 3-D but ALL tier-1**; the §4 "no PROMOTABLE point" redefinition stays deferred. Loop
  fixtures asserting the convergence certificate need `maxDryIterations >= 64` (the box grew 16→64).
- **CI/exit-code lesson:** never pipe `npm run build` to `tail`/`grep` when gating with `&&` — the pipe
  masks the build's non-zero exit. Run build standalone and check `$?` (one red commit happened this run
  from that; fixed in dce4630).
- The repo's named specialist sub-agents (doddy/wolf/testineer/rigorous-architect) are **not provisioned**
  in this environment — route adversarial reviews through `general-purpose` agents carrying the persona
  lens (extracted from prior transcripts), as prior phases did.
- Durable facts: `MEMORY.md` index — Phase 5 added **[[third-tier1-knob-batching-3d-search]]** and updated
  [[second-genome-knob-must-stay-tier1]], [[search-convergence-certificate-semantics]] §3/§4. Still
  load-bearing: [[escalation-forge-detection-load-bearing]], [[tier2-promotion-gate-is-load-bearing]],
  [[genome-content-address-firewall]], [[loop-trusted-evidence-boundary]], [[integrity-gate-completeness-invariants]],
  [[accept-rule-composition-invariance]].
