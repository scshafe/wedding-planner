# ADR 0005 — A 3rd tier-1 forge-free knob (`reminder_batching`): the autonomous search goes 3-D

- **Status:** accepted
- **Date:** 2026-06-24
- **Decider:** the building agent (an agent-owned engineering decision per
  [[agents-own-buildout-decisions]] and `.claude/plans/2026-06-24-phase-5-third-tier1-knob-3d-search.md`)
- **Scope:** Phase 5 — the strategy_genome schema + risk map, the offline planner simulator (Stage A/B),
  the SearchProposer, and the loop keystone. Offline-first, deterministic, no production blast radius.
  North Star **weights** are untouched; the pinned tier-1 **b=0 matrix slice is byte-identical** to the
  Phase-3 2-D matrix.
- **Supersedes nothing.** It extends [[search-convergence-certificate-semantics]] (ADR 0002) to a 3rd
  dimension and is the "3rd tier-1 forge-free knob" the handoff and [[second-genome-knob-must-stay-tier1]]
  named. It does NOT touch the tier-2 firewalls (4a human-gate, 4b forge-detection).

## Context

4a + 4b made BOTH tier-2 firewalls load-bearing. The clean next move that builds on the hardened
substrate WITHOUT adding tier-2 surface: take the autonomous search from 2-D (cadence × spacing) to 3-D
by adding a **3rd TIER-1, forge-free flow knob** — stressing the spread-first enumeration, the
convergence certificate, the termination proof, and the non-separability story at higher dimension.

Three adversarial design reviews ran before implementation (the repo's specialist sub-agents are not
provisioned in this environment, see prior phases; reviews via `general-purpose` reviewers framed with
the **doddy** (security/trust-boundary), **wolf** (statistics/landscape), and **testineer**
(test-strategy) lenses). All three **approved the core design**; their conditions are D1–D7.

## Decision

**The knob: `reminder_batching` (integer 0..3, REQUIRED).** `digestSize = batching + 1`. It governs how
many already-decided RSVP reminder nudges are CONSOLIDATED into a single digest send — the delivery-
grouping analogue of `reminder_spacing` (which sets WHEN nudges land). Two-sided model, sharing the FACT
via `domain_facts.ts` (each stage applies it by its own computation), and reducing EXACTLY to today at
batching 0 (`digestSize 1`, `ceil(x/1)=x`):
- REACH dilution (downside): `effectiveNudges = ceil(delivered / digestSize)`; a guest resolves iff
  `effectiveNudges >= ground-truth needed`. Forge-free — manufactures no resolution.
- COMFORT consolidation (upside): `feltTouches = ceil(received / digestSize)` → fewer nags → gentler
  `guest_sentiment_score`.

### D1 — Tier-1, but WELDED against the comms-content reading (doddy-C1)
`reminder_batching` derives to `planning_flow_orchestration` (tier 1) — but, per the doddy precedent
guard, ONLY because it changes delivery GROUPING of a byte-identical, fixed reminder set (not
content/tone/wording/recipient/segmentation) and is volume-monotone-DOWN (the structural OPPOSITE of the
tier-2 contact-volume trigger). The `GENOME_PARAMETER_SURFACES` entry carries an explicit guard naming
the tier-2 boundary it must not cross (a digest that varies content/segmentation, or any batching that
increases contact, is `guest_comms_content`, tier 2). Bounded-ness alone does not launder it.

### D2 — Stage B mirrors the reach dilution (doddy-C2 — the forge weld)
`stage_b_observer.reminderResolves` applies the IDENTICAL `effectiveNudges` reach calc via the shared
fact, by its own computation. Without it, honest batched genomes self-veto (`suppressed_effect`) and the
tier-1 search dies; with it, the Phase-4b guest_id resolution reconciliation already covers the new
dilution-forge surface — **no new integrity effect-kind**. A tier-1 dilution-forge keystone arm proves
the gate bites (a lying Stage A claiming a batching-diluted-away resolution is vetoed and not accepted).

### D3 — REQUIRED in the schema (no optional/default-as-no-op alias)
Same rationale as the other tier-1 flow knobs (an absent-vs-disabled alias defeats the content-address
dedupe key). Consequence: adding it **re-baselines every genome content-hash** and makes every
batching-omitting genome fixture schema-INVALID — handled by threading `reminder_batching: 0` (behavior-
identical) through every fixture/`parameters` literal. No literal `genome:` hashes are pinned anywhere.

### D4 — Honest claims only; NO "3-D interior optimum" overclaim (wolf)
The unique strict optimum is at **(cadence 3, spacing 1, batching 1) = 0.8151** — interior on the NEW
(batching) axis and on spacing, but on the cadence FACE (3). We claim exactly: interior on the new axis,
genuinely NON-SEPARABLE (the optimal cadence FLIPS with batching — argmax cadence at spacing 1 is
`[2,3,1,1]`), and strictly DOMINATES every batching-0 point. We do NOT call it a cube-interior optimum
and did NOT engineer one via contrived constants.

### D5 — Pin the b=0 slice + RELATIONS + hand-anchored values; NOT all 64 cube cells (wolf, testineer)
The b=0 16-value slice is pinned byte-identical to the Phase-3 matrix (the backward-compat oracle). The
cube facts are asserted as live RELATIONS (unique strict optimum + margin, dominates-every-b0-point,
non-separability both directions) plus 1–2 hand-anchored batching values reasoned from `ceil(·)` —
never a 64-float snapshot (brittle + tautological).

### D6 — The search box is 3-D (cadence × spacing × batching), ALL tier-1; tier-2 stays injected-only
The SearchProposer enumerates the 64-point cube spread-first; the "never emits `autonomy_threshold`"
guard is re-asserted over the 3-D box. The §4 convergence redefinition ("no PROMOTABLE point") STAYS
deferred (no tier-2 in the box). Termination holds: strict North-Star ratchet over a finite 64-point box;
per-champion coverage = 63.

### D7 — Acknowledge (not fix) the sentiment gap (doddy-C3)
Batching's comfort upside flows entirely through `guest_sentiment_score`, a claimed-only/unreconciled
metric (like `qa_accuracy_rate`). Batching ENLARGES the unreconciled value and its plausible cover story.
This inherits the pre-accepted deferral, re-stated here so a future reviewer knows the gap now carries
more weight — not silently inherited.

## Consequences

- **The autonomous search is genuinely 3-D and the 3rd dimension is load-bearing.** The loop converges to
  (3,1,1) from both (0,0,0) and the opposite corner (3,3,3); a 2-D-blind search (batching pinned 0)
  STALLS at (2,1,0). Notably the 3-D landscape is **coordinate-descent-UNSOLVABLE** — there is a CD trap
  at (2,1,0) (reaching the optimum needs a simultaneous cadence+batching move) — that the full-box sweep
  escapes. This is a *sharper* "old search misses it" than the 2-D phase could claim; memory §3 is updated.
- **No new tier-2 surface; both 4a/4b firewalls untouched.** The injected-only tier-2 boundary holds.
- **Forge-free for the new knob is TESTED.** The dilution-forge keystone makes the claim load-bearing,
  not asserted.
- **Trade-off accepted:** the genome-hash re-baseline (D3) and a larger 64-point box (slower convergence:
  63 proposals per champion) — both intended and bounded.

## Alternatives considered (and rejected)
- **A comfort-only 3rd knob** (pure sentiment upside): optimum would sit at the batching-3 corner (no
  tradeoff) — fails the "genuine interior tradeoff on the new axis" bar. Rejected for the two-sided model.
- **Engineering a cube-interior optimum** by retuning constants: would be the dishonest move (wolf). The
  coarse integer landscape does not naturally yield one; we claim only what is true.
- **A timing-of-day knob**: needs per-guest receptivity ground-truth and Stage B reach changes for less
  clean a reduction-to-today than batching's `ceil(x/digestSize)` (identity at b=0). Deferred as an option.
