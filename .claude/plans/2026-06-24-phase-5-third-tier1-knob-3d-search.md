# Phase 5 — A 3rd TIER-1 forge-free knob (`reminder_batching`): the autonomous search goes 3-D

**Status:** IN PROGRESS — step boxes below. **Branch:** `build/phase-3-generalize-search` (the open review
artifact for `main`; 3/4a/4b build on it; the merge-keeper advances `main` when green). **Predecessor:**
Phase 4b — escalation forge-detection load-bearing (complete, 234 tests).

## Why this phase
4a + 4b made BOTH tier-2 firewalls (human-gate, forge-detection) load-bearing. The clean next move named
in the handoff and `second-genome-knob-must-stay-tier1.md`: add a **3rd TIER-1, forge-free knob** to take
the autonomous search from 2-D to **3-D**. This stresses the spread-first enumeration, the convergence
certificate, the termination proof, and the non-separability story at higher dimension — **without adding
any new tier-2 surface** (escalation/`autonomy_threshold` stays injected-only, the search box stays tier-1).

**The knob: `reminder_batching` (integer 0..3, REQUIRED).** `digestSize = batching + 1`. Domain meaning:
how many already-decided RSVP reminder nudges are CONSOLIDATED into a single digest send. `0` = each
reminder sent separately (today's EXACT behavior); `3` = bundle up to 4 per digest. It governs DELIVERY
GROUPING of a byte-identical, fixed reminder set — never content, tone, wording, recipient set, or
segmentation — and can only REDUCE send volume. That is the temporal/flow analogue of `reminder_spacing`,
so it derives to the SAME `planning_flow_orchestration` surface (tier 1).

**The model (two-sided; reduces EXACTLY to today at b=0, where digestSize=1 and `ceil(x/1)=x`):**
- REACH dilution (downside): `effectiveNudges = ceil(delivered / digestSize)`; a guest resolves iff
  `effectiveNudges >= ground-truth needed`. Manufactures NO resolution — a never-responder still never
  resolves; resolution still requires the ground-truth need met. Batching can REDUCE resolution.
- COMFORT consolidation (upside): `feltTouches = ceil(received / digestSize)` (`received = needed` if
  resolved else `delivered`); `nags = max(0, feltTouches - comfortCeiling)`; sentiment rises with batching
  where reach is preserved (the per-nag penalty is unchanged; fewer felt touches → fewer nags).

## The verified 3-D landscape (computed over the UNCHANGED keystone guest mix; `wolf` re-derived independently)
- The **b=0 slice is BYTE-IDENTICAL to the current 2-D matrix** — so every existing anchored/domain-meaning
  and 2-D test is preserved untouched (the strongest asset of this design).
- **UNIQUE optimum at (cadence 3, spacing 1, batching 1) = 0.8151**, STRICT over its in-box axis neighbors
  (min margin **0.0130**, binding neighbor (3,1,0)=0.8021).
- The 3-D optimum **strictly beats the best b=0 point** (cadence 2, spacing 1)=0.7956 by 0.0195 — the old
  2-D search (b pinned to 0) structurally cannot reach it.
- **NON-SEPARABILITY (real, mechanism-grounded):** argmax cadence at spacing 1 across b=0..3 is **[2,3,1,1]**
  — a STRICT flip (at b=1, c3 beats c2 by 0.1263). Cause: the `after_multiple_reminders` guest (needs 2) —
  at b=1, digestSize 2 dilutes reach so cadence 2 delivers only 1 effective nudge and FAILS to resolve,
  while cadence 3 delivers 2 and resolves AND lands feltTouches=1 (zero nags). True two-knob coupling.
- **Coordinate-descent TRAP escaped by the full-box sweep:** at 3-D, round-robin coordinate descent is
  trapped at (2,1,0)=0.7956 from the natural seed (reaching the optimum needs a SIMULTANEOUS c:2→3 ∧ b:0→1
  diagonal move). The loop's proposer is a full-box exhaustive spread-first sweep, so it evaluates all 64
  points and DOES find (3,1,1). This is a *sharper* "old search misses it" than 2-D could claim.

## Design reviews (three adversarial reviewers; the repo's named specialists are not provisioned in this
environment, so `general-purpose` reviewers were framed with the **doddy** (security/trust-boundary),
**wolf** (statistics/landscape), and **testineer** (test-strategy) lenses, as prior phases did). All three
**approved the core design**; their conditions are folded in below as **[doddy-C…]/[wolf-…]/[test-P…]**.

## Design decisions (locked)
- **D1 — Tier-1 is DEFENSIBLE but must be WELDED.** [doddy-C1] Batching governs grouping of a fixed,
  byte-identical reminder set and is volume-monotone-DOWN — the structural OPPOSITE of the tier-2
  contact-volume trigger. But it sits closer to the tier-2 line than spacing did. The
  `GENOME_PARAMETER_SURFACES` entry gets an explicit precedent-guard comment: tier-1 ONLY because it changes
  delivery GROUPING (not content/tone/wording/recipient/segmentation) and can only reduce volume; a digest
  that VARIES content/segmentation, or any batching that INCREASES contact, is `guest_comms_content` (tier 2).
- **D2 — Stage B MUST mirror the reach dilution.** [doddy-C2, test-P0] `stage_b_observer.reminderResolves`
  applies the IDENTICAL `effectiveNudges = ceil(delivered/digestSize)` reach computation, sharing the
  digest-size fact via `domain_facts.ts`, by its OWN computation (never importing Stage A's path). Without
  this, honest batched genomes self-veto (`suppressed_effect`) and the tier-1 search dies; with it, the
  Phase-4b guest_id resolution reconciliation already covers the forge surface and **NO new integrity
  effect-kind is needed**. A dilution-forge keystone arm proves the gate bites (Step 6).
- **D3 — The 3rd knob is REQUIRED in the schema (no optional/default-as-no-op alias).** Same rationale as
  the other tier-1 flow knobs: an absent-vs-disabled alias would let one behavior carry two
  content-addresses and defeat the dedupe key. Consequence: **adding the required knob re-baselines every
  genome content-hash AND makes every batching-omitting genome fixture schema-INVALID** — so Step 1 threads
  `reminder_batching` (default 0, behavior-identical) through EVERY genome fixture/`parameters` literal.
  [test plumbing] No literal `genome:` hashes are pinned anywhere (verified) — only the re-baseline.
- **D4 — Honest claims only (NO overclaim).** [wolf] The optimum is interior on batching(1) and spacing(1)
  but on the cadence FACE (3). We claim **"interior on the new (batching) axis, non-separable, and strictly
  dominates every b=0 point"** + **"a coordinate-descent trap the full-box sweep escapes"**. We do NOT call
  it a "3-D interior optimum" and do NOT engineer a cube-interior optimum via contrived constants.
- **D5 — Pin the b=0 slice + RELATIONS + 1–2 hand-anchored values; do NOT pin all 64 cube cells.** [wolf,
  test] Pinning 64 floats is brittle drift-noise that restates the simulator's own arithmetic (tautology).
- **D6 — The autonomous search box becomes cadence×spacing×batching (ALL tier-1); tier-2 stays
  injected-only.** [doddy-C4] The "search never emits `autonomy_threshold`" guard is re-asserted over the
  3-D box. The §4 convergence redefinition ("no PROMOTABLE point") STAYS deferred (no tier-2 in the box →
  no parked-but-acceptable point arises). Termination still holds: strict North-Star ratchet over a finite
  64-point box; per-champion coverage = boxSize−1 = 63.
- **D7 — Acknowledge (not fix) the sentiment gap.** [doddy-C3] Batching's comfort upside flows entirely
  through `guest_sentiment_score`, a claimed-only/unreconciled metric (no trusted backing, like today).
  Batching ENLARGES the unreconciled value and its plausible cover story. This inherits the pre-accepted
  deferral (same as `qa_accuracy_rate`) but is re-stated in the ADR/memory, not silently inherited.

## Steps (each: `npm run build && npm test && npm run lint` green before ticking + commit)

- [x] **Step 1 — Schema + risk map + domain facts + fixtures (required knob, behavior UNCHANGED at b=0).**
  - `shared/schemas/strategy_genome_schema.json`: add `reminder_batching` (integer, 0..3) to `parameters`
    and to `required`; description = the D1 tier-1 flow framing. Regenerate types (`npm run gen:types`).
  - `shared/src/strategy/risk_tier.ts`: add `reminder_batching: 'planning_flow_orchestration'` with the
    D1 precedent-guard weld comment. (Drift-guard test already asserts every schema param is mapped.)
  - `eval-harness/src/simulator/domain_facts.ts`: add the SHARED digest fact —
    `digestSize(batching) = batching + 1` and a shared `effectiveNudges(delivered, batching)` /
    `feltTouches(received, batching)` helper (the FACTS both stages read; identity at batching 0).
  - Thread `reminder_batching` (default 0) through EVERY genome fixture + `parameters` literal so the tree
    stays green at b=0: `simulator_fixtures.ts` (`makeGenome`, `makeTier2Genome`), `search_proposer.test.ts`
    `genome(...)`, `genome_keystone.test.ts` `genome2(...)` and the `LegacyOneDProposer` literal, any other
    `parameters: { … }` literal (audit with grep). Stage A/B do NOT read batching yet → all pinned values
    unchanged → green.
  - Tests: `risk_tier.test.ts` — a genome with `batching>0` still derives **tier 1**; `genome.test.ts` —
    content-hash re-baseline expected (hashes computed live, none pinned). `npm test` green.

- [ ] **Step 2 — Wire batching into BOTH stages together + the model oracle (D2, the forge weld).**
  - `stage_a_planner.ts`: `guestOutcome` reads `reminder_batching`; resolution via shared
    `effectiveNudges(delivered, batching) >= needed`; comfort via `feltTouches(received, batching)`. b=0 is
    a perfect reduction (assert by the preserved b=0 oracle).
  - `stage_b_observer.ts`: `reminderResolves` applies the IDENTICAL shared `effectiveNudges` reach calc
    (D2). Stage B still never reads Stage A.
  - Metamorphic model oracle (`metamorphic_oracle.test.ts`) — NON-circular, hand-reasoned [test-P1, wolf]:
    (a) the b=0 16-value slice equals the EXISTING pinned 2-D `EXPECTED` matrix literal (backward-compat);
    (b) **anchored** batching values reasoned from `ceil(delivered/(b+1))` (e.g. the `after_multiple_reminders`
    guest resolves at (c2,s0,b0) but goes UNRESOLVED at (c2,s0,b1) — reach dilution; sentiment rises with b
    where reach is preserved — comfort), literal rates pinned like the spacing anchors;
    (c) batching reach-monotonicity (raising b never RAISES `rsvp_resolution_rate` at fixed (c,s)) + a
    STRICT-drop fixture (anti-vacuity); (d) the comfort dual (raising b never LOWERS sentiment where reach
    is preserved) + strict-move fixture; (e) anti-no-op (flip ONLY batching → stream changes AND a metric
    moves, correct sign), on a deliberately non-flat segment; (f) boundary fixed-point (all-immediate →
    1.0 for EVERY batching level; rate ∈ [0,1] across the b-band).
  - `stage_b_observer.test.ts`: extend the honest Stage-A ↔ Stage-B agreement sweep to the full **64-point
    cube** [test-P0] — honest resolved set == trusted resolved set at every (c,s,b). `npm test` green.

- [ ] **Step 3 — The 3-D landscape oracle (relations over a LIVE `matrix3d()`; D4/D5).**
  - `matrix3d()` computes the 4×4×4 aggregate North Star over the keystone corpus (like `matrix()` does in
    2-D). Assert (computed live, not against pinned cube cells):
    - **unique** global argmax at (3,1,1) with value 0.8151; **strict** over the (in-box) 6 axis-neighbors
      [test: 6 not 26] + a **finite margin** `> 0.01` (actual 0.0130); global argmax count == 1;
    - the optimum **strictly beats every b=0 point** (the "requires the 3rd knob" relation);
    - **non-separability BOTH directions** [test-P2]: argmax cadence by batching == `[2,3,1,1]` (at s1)
      AND argmax batching depends on cadence (or spacing) — proving genuine 3-way interaction, not a shared cap;
    - a comment naming the honest claim (D4) and explicitly NOT claiming "3-D interior optimum".
  - `npm test` green.

- [ ] **Step 4 — SearchProposer goes 3-D (D6).**
  - `search_proposer.ts`: `SearchProposerSpec` gains `batchingMin?/batchingMax?` (default 0..3);
    `BoxPoint` gains `batching`; `genomeFor` emits `reminder_batching` (else schema-invalid — doddy-C4);
    `buildBoxOrder` enumerates the cube (cadence outer, spacing mid, batching inner) in bit-reversal
    spread-first order (`bits = ceil(log2(64)) = 6`, a clean bijection); rationale string includes batching.
  - `search_proposer.test.ts`: `BOX_SIZE = 64`; coverage = 63; spread-first enumerates the cube;
    trajectory-tabu + convergence-certificate logic unchanged; **re-assert the guard** that the proposer
    NEVER emits `autonomy_threshold` over the 3-D box (every emitted genome derives tier 1). `npm test` green.

- [ ] **Step 5 — Loop keystone at 3-D (convergence + the "old search misses it" contrast).**
  - Bump `maxDryIterations` to **≥ boxSize (64)** wherever the convergence certificate is asserted (the
    keystone's default 20 < 64 would flip `converged`→`dry`) [test plumbing]; the taxonomy test's tight/loose
    values adjusted accordingly (tight stays well below boxSize; loose ≥ boxSize).
  - `genome_keystone.test.ts`: the full loop converges (certificate) to **(cadence 3, spacing 1, batching 1)**
    from multiple seed corners (e.g. (0,0,0) and (3,3,3)); promotions bounded by boxSize; ledger chains intact.
  - The **2-D-blind contrast** [test, replaces the 1-D legacy fixture's role]: a `SearchProposer` restricted
    to `batchingMin=batchingMax=0` converges to **(2,1,0)** and MISSES the (3,1,1) interaction win — the
    loop-level proof the 3rd dimension is load-bearing. (Keep/retire `LegacyOneDProposer` as appropriate.)
  - Confirm any live loop config / pipeline fixture's `maxIterations` accommodates the 64-point box (or
    documents honest truncation). `npm test` green.

- [ ] **Step 6 — The dilution-forge keystone arm (D2 proof; test-P0).**
  - In `escalation_forge_keystone.test.ts` (or a sibling `batching_forge_keystone.test.ts`): a tier-1 genome
    with `batching ≥ 1` where some guest is diluted-out of resolution; a lying Stage A (test double) claims
    that guest's `guest.rsvp.received` (reminder-attributed, no escalation vocabulary — the bypass arm).
    Assert: claimed `rsvp_resolution_rate` RISES (RED) but the integrity gate fires (`integrityFailed`,
    `new_gate_failures` non-empty) and the candidate is NOT accepted (GREEN). This is the load-bearing
    "forge-free for the new knob is TESTED, not asserted". `npm test` green.

- [ ] **Step 7 — Docs + memory + handoff.**
  - `docs/adr/0005-*.md`: the 3rd tier-1 knob + 3-D search; the honest-claims boundary (D4); the D7
    sentiment-gap acknowledgment; the coordinate-descent-trap-escaped-by-full-box-sweep result.
  - Memory: **update** `search-convergence-certificate-semantics.md` §3 — at 3-D the landscape is
    coordinate-descent-UNSOLVABLE (a CD trap at (2,1,0)) while the full-box sweep still solves it; the old
    "coordinate-descent-solvable" wording is 2-D-only. §4 redefinition still deferred (box stays tier-1).
    **Update** `second-genome-knob-must-stay-tier1.md` (the 3rd tier-1 knob shipped). **Add**
    `third-tier1-knob-batching-3d-search.md` (the knob, the model, the honest-claims boundary, the
    sentiment-gap deferral, links). Index in `MEMORY.md`.
  - Update `.claude/handoff.local.md` (where we are, next action, fresh context). Commit.

## Out of scope (in-rails, deferred)
- The §4 "no PROMOTABLE point" convergence redefinition (only needed if tier-2 enters the autonomous
  search — it does not here).
- Reconciling model-output metrics (`guest_sentiment_score`, `qa_accuracy_rate`) — claimed-only by design.
- The real Claude-Agent-SDK proposer (needs API credentials → STOP-and-surface, the local-only rail).
