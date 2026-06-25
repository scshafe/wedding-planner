# Handoff

## Where things stand — Phase 10 (the `quality`/`vision_match` capstone) is BUILT ✅
`.claude/plans/2026-06-25-phase-10-vision-match-quality-capstone.md` is **complete — all steps ticked**
(Step 0 design review + Steps 1–8), on branch **`build/phase-3-generalize-search`** (the open review
artifact for `main`; Phases 3/4a/4b/5/6/7/8/9/10 build on it; the loop's merge-keeper advances `main` when
green). Working tree clean. `npm run build && npm test && npm run lint` all green (**388 tests**, up from
350 at the start of this run). `main` has Phase 1+2; this branch is the review artifact for Phases 3–10.

**What changed:** the North-Star `quality` component (weight **0.40**, the largest numerator component,
hard-`null` since Phase 1) is now **computed for the first time** — via ONE honestly-offline rubric,
`vision_match` (the 8th integrity effect kind `vision_alignment`). This **completes the "every computed
North-Star input trusted-backed" arc**: rsvp (4b), sentiment (6), qa (7), category (8), cost (4b/9),
quality (10). The only still-`null` inputs are `comms_quality`/`intuitiveness` — genuinely judge-shaped,
honestly STOP-gated (ADR 0007), NOT faked. See `docs/adr/0010`, memory [[vision-match-trusted-reconciliation]].

## The load-bearing insight (carry forward — same shape as Phase 7/8/9)
`vision_match` is a DETERMINISTIC alignment of a booked category's selection to the couple's ground-truth
vision — **NOT a judge**. Load-bearing via the EXISTING tier-2 `autonomy_threshold` (`canConsult ===
canEscalate`): a `vision_sensitive` booked category is ALIGNED (1.0) only by a tier-2 genome that CONSULTS
the couple (paying a `vision_consult` couple session); a tier-1 genome books a DEFAULT (0.5) selection at
no cost. INDEPENDENT of completeness (booked either way → orthogonal value axis). Two forges:
- **Value (new `vision_alignment` surface):** tier-1 claims 1.0 it can't earn → field_mismatch vs trusted
  0.5 → veto. Keystone arm tier-1-vs-tier-1 (vision is the sole value mover).
- **Cost (rides Phase 9 unchanged):** tier-2 aligns honestly but shaves/suppresses the `vision_consult`
  session → caught by `detectCoupleSessionDivergences` on the `(vision_consult, category_id)` key, **NO new
  gate code**. Keystone arm tier-2-vs-tier-2 (vision_consult is the sole cost mover; single immediate guest
  excludes the rsvp confound).

## What's new this phase (by step)
- **Step 0** — architect-lens design review (APPROVE-WITH-CHANGES; six findings folded: separate effect
  kind, single-rubric 0.40 leverage, pinned keystone corpus cardinality, sole-cost-mover, active_seconds
  throw, reader-seam/guard-direction).
- **Steps 1–2** — value telemetry (`category.vision.aligned`, `vision_match_rate`, tolerant
  `readVisionAlignedPayload`, `vision_consult` reason) + `TrustedVisionAlignmentRecord` + recorder.
- **Steps 3–4** — shared honest facts (`honestVisionMatch`/`honestVisionConsultSession`,
  `ALIGNED=1`/`DEFAULT=0.5`); `RequiredCategory.vision_sensitive` (runtime-only); Stage A emit + Stage B
  record; byte-identity asserted (zero vision events on the search corpus, the Phase-8 keystone, a
  non-vision-sensitive category, and a deferred one).
- **Step 5** — integrity gate `detectVisionAlignmentDivergences` (mirror category). **doddy APPROVE** (no
  P0/P1). doddy P2 surfaced + FIXED: `readCoupleSessionEndedPayload` was throwing on absent/NaN
  active_seconds and CRASHING scoring (metrics run unconditionally — the gate verdict does NOT gate the
  metric, which corrects the wrong Phase-9 note); now tolerant, gate still vetoes via its own raw read.
- **Step 6** — wired `quality = meanOfPresent([vision_match_rate])`; honest-run audit + multi-surface
  co-present scenario (booking_approval + vision_consult on one category) + read-seam.
- **Step 7** — `vision_match_forge_keystone.test.ts` (loop-orchestrator, 6 arms): value forge + cost
  shave/suppress + value near-miss (0.51) + honest companions, each `forgeWouldWinAbsentGate` +
  `onlyIntegrityFailed`. **testineer APPROVE-WITH-CHANGES** (added the value near-miss + pinned vision held
  in the cost arms).
- **Step 8** — `docs/adr/0010` + memory [[vision-match-trusted-reconciliation]] + Phase-9 memory
  correction + `GUARD_DIRECTIONS.vision_match_rate` (inert) + this handoff.

## Next action — your call. The big remaining levers (ranked)
- **Move category/vision/question scenarios INTO the search corpus** — now the most natural next phase. The
  costs (couple attention) AND the value payoffs (completeness, qa_accuracy, vision_match/quality) are ALL
  modeled and trusted-backed, so a tier-2's gains are offset by a real couple cost — the search can finally
  trade them. BUT: needs a guard/spread analysis (the keystone-only invariant was the missing cost+value;
  what remains is the search-landscape decision), AND the **single-rubric 0.40 quality over-weight is a
  fresh blocker** (moving vision in would let the optimizer over-chase one rubric — see ADR 0010). Likely
  makes `category_completeness_rate`/`qa_accuracy_rate`/`vision_match_rate` active search guards. Design
  with the architect lens first.
- **A 4th tier-1 knob → 4-D search** — pure search generalization, forge-free; lower marginal value than
  corpus expansion but lower risk. The cleanest "more search" move.
- **`comms_quality` / `intuitiveness` rubrics** — the last two `quality` rubrics, both genuinely
  judge-shaped (free-text tone, UX). Honest offline backing needs a real Claude judge → **STOP-and-surface**
  (offline-first, ADR 0007). Do NOT build a stub. If a clean deterministic proxy exists (as vision_match was
  for the aesthetic axis), design it architect-first; otherwise leave null and surface the judge need.
- **Per-category heterogeneous vision difficulty** — a richer vision model (graded alignment) that would
  make the denominator-spread forges load-bearing at the keystone level (today they're gate-level only).
  Scenario-authoring refinement, low marginal value.

## Non-obvious Phase-10 context (carry forward)
- **`quality = meanOfPresent([vision_match_rate])`** — null on the search corpus (no vision events), so the
  pre-Phase-10 landscape is byte-identical. The 0.40 weight rides ONE rubric while thin: keystones assert
  forge DIRECTION + GATE, never the ratio-delta magnitude.
- **SEPARATE event/effect-kind from `category_booking`** (independent claims-only denominators) — protects
  the Phase-8 keystone's "completeness is sole mover" isolation. The cleanest keystone category is
  approval-FREE + vision-sensitive (vision is the only tier-dependent axis).
- **`vision_sensitive` is runtime-only on `RequiredCategory`** (NOT in any JSON Schema) → vision-bearing
  scenarios KEYSTONE-ONLY by construction. Vision events fire ONLY for `vision_sensitive && booked`.
- **doddy's ordering correction (now in memory):** `offline_scorer` runs `runVetoGates` AND `computeMany`
  UNCONDITIONALLY — a gate veto does NOT prevent a metric throw. Any reader that THROWS can DoS scoring even
  on a vetoed stream. The couple-session + all category/qa/vision readers are now tolerant; keep new readers
  tolerant too (throw-free), and field-diff strictly in the gate instead.
- **CI/exit-code lesson (still true):** never pipe `npm run build` to tail/grep when gating with `&&` (the
  pipe masks the non-zero exit). Run build standalone, check `$?`. `npm run build` runs from the REPO ROOT.
- The repo's named specialist sub-agents (doddy/wolf/testineer/rigorous-architect) are **not provisioned**
  here — route adversarial reviews through `general-purpose` agents carrying the persona lens (this run did,
  for architect at design, doddy at the gate, testineer at the keystone).
- Durable facts: `MEMORY.md` index — Phase 10 added **[[vision-match-trusted-reconciliation]]**. Still
  load-bearing: [[couple-attention-cost-generalization]], [[category-completeness-trusted-reconciliation]],
  [[qa-accuracy-trusted-reconciliation]], [[sentiment-trusted-reconciliation]],
  [[escalation-forge-detection-load-bearing]], [[tier2-promotion-gate-is-load-bearing]],
  [[genome-content-address-firewall]], [[loop-trusted-evidence-boundary]],
  [[integrity-gate-completeness-invariants]], [[accept-rule-composition-invariance]],
  [[second-genome-knob-must-stay-tier1]], [[search-convergence-certificate-semantics]],
  [[third-tier1-knob-batching-3d-search]].
