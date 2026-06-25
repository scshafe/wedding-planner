---
name: third-tier1-knob-batching-3d-search
description: "Phase-5 — reminder_batching is the 3rd tier-1 forge-free knob; the autonomous search is now 3-D (cadence×spacing×batching); the optimum is non-separable and the landscape has a coordinate-descent trap the full-box sweep escapes"
metadata:
  node_type: memory
  type: project
---

Phase 5 added **`reminder_batching`** (integer 0..3, REQUIRED) — the 3rd tier-1 flow knob — taking the
autonomous offline search from 2-D to **3-D** (cadence × spacing × batching, 64-point box). Builds on
[[second-genome-knob-must-stay-tier1]], [[search-convergence-certificate-semantics]],
[[escalation-forge-detection-load-bearing]]. See `docs/adr/0005`.

**The knob.** `digestSize = batching + 1`; it consolidates already-decided reminders into digest sends —
the delivery-grouping analogue of spacing (which sets WHEN nudges land). Two-sided, sharing the FACT via
`domain_facts.ts` (`effectiveNudges`, `feltTouches`), reducing EXACTLY to today at batching 0
(`digestSize 1`, `ceil(x/1)=x`):
- REACH dilution (downside): `effectiveNudges = ceil(delivered/digestSize)`; resolve iff `>= needed`.
- COMFORT consolidation (upside): `feltTouches = ceil(received/digestSize)` → fewer nags → gentler sentiment.

**Why tier-1 (the doddy weld — load-bearing).** It governs GROUPING of a byte-identical, fixed reminder
set (not content/tone/wording/recipient/segmentation) and is **volume-monotone-DOWN** (the structural
OPPOSITE of the tier-2 contact-volume trigger). The `GENOME_PARAMETER_SURFACES` entry carries an explicit
guard: a digest that VARIES content/segmentation, or any batching that INCREASES contact, is
`guest_comms_content` (tier 2), NOT this knob. Bounded-ness alone does not launder it.

**Why forge-free.** Manufactures no resolution; **Stage B mirrors the identical `effectiveNudges` reach
dilution** via the shared fact (else honest batched genomes self-veto on `suppressed_effect` and the
search dies). The Phase-4b guest_id resolution reconciliation already covers the new dilution-forge
surface → **no new integrity effect-kind**. A tier-1 dilution-forge keystone arm
(`escalation_forge_keystone.test.ts`) proves the gate bites: a lying Stage A claiming a
batching-diluted-away resolution is vetoed and not accepted (this is the SOLE stopper — the candidate is
tier-1, so there is no promotion-gate park). Batching's COMFORT upside flows entirely through
`guest_sentiment_score`, which Phase 5 left claimed-only — **Phase 6 then gave it a trusted backing**
(the comfort consolidation is now reconciled, the enlarged forge surface closed): see
[[sentiment-trusted-reconciliation]]. (`qa_accuracy_rate` stays claimed-only — no Q&A simulator model.)

**The landscape (honest-claims boundary — do NOT overclaim).** Unique strict optimum at **(cadence 3,
spacing 1, batching 1) = 0.8151**, interior on batching(1) and spacing(1) but on the cadence FACE (3).
Claim exactly: **interior on the NEW axis + genuinely NON-SEPARABLE + strictly dominates every b=0 point**.
Do NOT call it a "3-D interior optimum"; do NOT engineer a cube-interior optimum via contrived constants.
Non-separability is mechanism-grounded: argmax cadence at spacing 1 is `[2,3,1,1]` across b — the digest
dilutes a 2-reminder guest, so the optimal cadence FLIPS from 2 (b=0) to 3 (b=1). The b=0 16-value slice
is pinned byte-identical to the Phase-3 matrix; the cube facts are LIVE RELATIONS, never a 64-float
snapshot (brittle + tautological).

**Search/loop.** The box is 3-D, all tier-1; the "never emits `autonomy_threshold`" guard is re-asserted
over it (tier-2 stays injected-only). Convergence/termination unchanged (per-champion coverage = 63;
strict North-Star ratchet over the finite box). The §4 "no PROMOTABLE point" redefinition STAYS deferred.
A REQUIRED knob re-baselines every genome content-hash by design (no `genome:` hashes are pinned anywhere).
