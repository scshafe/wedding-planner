---
name: second-genome-knob-must-stay-tier1
description: "Phase-3 decision — the autonomous offline search may only optimize TIER-1 genome knobs; a tier-2 knob (e.g. escalate-to-couple) would break autonomous operation, so the 2nd knob is reminder_spacing not escalation"
metadata:
  node_type: memory
  type: project
---

When generalizing the offline search to a multi-parameter genome (wolf's deferred Phase-2 work), the
SECOND knob must be **tier-1 (planning_flow_orchestration) AND forge-free**, or the autonomous loop
cannot run. This is load-bearing and non-obvious.

**Why.** The safety model gates by risk tier: a **Tier-2 action requires human approval before it
lands** (`oversight_record.ts` `human_gate`; "For a Tier-2 action: the human approval that must
precede land"), and Tier-3 blocks. The offline loop *autonomously* promotes accepted genomes (the
champion ratchet). If a genome's `deriveRiskTier` is ≥2, autonomously promoting it is the loop
granting itself tier-2 autonomy — a safety-model violation. So an all-tier-2 search either fakes
autonomy it isn't allowed (rail breach) or must gate every candidate (search blocked). Either way the
autonomous search dies. **The autonomously-optimizable surface is exactly the tier-1 box.**

**The rejected knob: `rsvp_escalation_threshold` (escalate a pending guest to the couple).** Tempting
(it gives a non-separable cost/value tradeoff via couple effort_cost) but design review killed it:
1. It is **`commitment_autonomy` → tier 2**, not tier 1. The AI deciding to consume the couple's
   scarce attention is an autonomy-governing threshold — exactly the `autonomy_threshold` reserved
   entry in `GENOME_PARAMETER_SURFACES`. Classifying it tier-1 "because it's bounded" is the precise
   auto-laundering the doddy precedent guard in `risk_tier.ts` forbids (bounded-ness already failed
   once as a sole tier argument). See [[genome-content-address-firewall]].
2. It **manufactures a trusted outcome** (emits `guest.rsvp.received` for a never-responder), a NEW
   forge surface the integrity gate doesn't cover and Stage B doesn't independently observe — it would
   break the [[loop-trusted-evidence-boundary]] / [[integrity-gate-completeness-invariants]] unless
   Stage B got an independent escalation/resolution ground truth + an integrity effect-kind. Big scope
   for a search-generalization phase, and still tier-2.

**The chosen knob: `reminder_spacing` (int 0..3).** Tier-1 flow (the temporal analogue of cadence —
*how spaced* the nudges are, not *what* they say, not couple time, no commitment), and **forge-free**
(resolution still requires `needed <= delivered`, all from persona ground truth — nothing manufactured).
Non-separability comes from the **multiplicative** sentiment term (`penalty_per_nag(spacing) *
nags(cadence)`) plus a real spacing downside (`delivered = min(cadence, capacity(spacing))`, capacity
falling with spacing) — so the optimal cadence depends on spacing and the 2-D optimum is interior, not
a corner. Escalation-as-tier-2 is still worth building LATER as the phase that makes the firewall's
tier-2 human-gate + integrity forge-detection load-bearing — but as its own gated phase, never folded
into the autonomous search.

**UPDATE (Phase 4a, the split happened).** This deferred work was split into two phases on adversarial
review. **Phase 4a built the tier-2 promotion GATE** ([[tier2-promotion-gate-is-load-bearing]]): the
loop now PARKS any accepted tier-2 candidate absent an exogenous human approval, proven with an
*injected* tier-2 candidate via the optional unwired `autonomy_threshold` knob — no escalation, no new
simulator, no forge surface (which is exactly why folding escalation into the search was rejected again).
**UPDATE (Phase 4b, BUILT — [[escalation-forge-detection-load-bearing]]).** The escalate-to-couple knob +
forge-detection shipped. The headline P0 (metric-reads-claims) was closed by reconciling EVERY claimed
RSVP resolution (by guest_id, any cause — closing a pre-existing reminder-resolution hole too) and the
couple-cost (field-level `active_seconds`) against a trusted record Stage B authors independently — so a
forged resolution / shaved cost is a veto, not free score. Critically, escalation stayed **injected-only**
(the search box is still pinned tier-1, with a guard test), exactly as this memory demanded — so the
convergence-certificate "no PROMOTABLE point" redefinition ([[search-convergence-certificate-semantics]]
§4) stays DEFERRED (no parked point arises mid-sweep). Tier-2 still never enters the autonomous search.

**UPDATE (Phase 5 — a 3rd TIER-1 knob shipped).** [[third-tier1-knob-batching-3d-search]] added
`reminder_batching` (delivery-grouping/digest consolidation) as the 3rd autonomous knob — tier-1 and
forge-free, exactly the kind of knob this memory says the search MAY optimize. The box is now 3-D
(cadence×spacing×batching), still all tier-1; the "never emits `autonomy_threshold`" guard is re-asserted
over it. The doddy precedent guard held: batching is tier-1 ONLY because it groups a byte-identical fixed
reminder set and is volume-monotone-DOWN (a content/segmentation-varying or contact-increasing digest
would be tier-2 `guest_comms_content`). Tier-2 still never enters the autonomous search.
