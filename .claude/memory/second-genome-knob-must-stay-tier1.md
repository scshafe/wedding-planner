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
