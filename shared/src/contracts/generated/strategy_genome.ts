/* eslint-disable */
/**
 * GENERATED from shared/schemas/strategy_genome_schema.json — DO NOT EDIT BY HAND.
 * The JSON Schema file is the source of truth. Regenerate with: npm run gen:types
 */

/**
 * A structured, content-addressable parameter set that deterministically configures the wedding-planner product (the offline planner simulator interprets it). This is the offline analogue of 'the change that lives in the branch a candidate_change.artifact_ref points to': a candidate cryptographically commits to exactly the genome that will run via artifact_ref = 'genome:' + sha256(canonicalJson(parameters)). The parameters object is CLOSED (additionalProperties:false) on purpose — a new behavioral knob requires a reviewed schema edit AND a genome->surface map entry (fail-closed risk derivation), so the firewall always covers the thing that actually changes behavior. See loop-orchestrator/proposer_design.md and risk_tier_derivation.md.
 */
export interface StrategyGenome {
/**
 * Stable, injected identity for tracing/lineage. NOT part of the content hash — two genomes are behavior-equal (and content-address-equal) iff their parameters are equal, regardless of genome_id.
 */
genome_id: string
/**
 * The behavioral knobs the planner simulator reads. CLOSED set: every parameter must appear in the genome->surface map (shared deriveRiskTier) or risk derivation fails closed. The canonical hash is computed over THIS object only. The tier-1 FLOW knobs are REQUIRED (no optional/default-as-no-op knobs): an absent-vs-disabled alias would let one behavior carry two content-addresses and defeat the dedupe key, so a new tier-1 knob re-baselines every genome hash by design. The tier-2 autonomy knob (autonomy_threshold) is the deliberate exception — it is OPTIONAL because its mere PRESENCE elevates the whole genome to tier-2 (it has no 0='off' value; its range starts at 1), so omitting it IS the canonical tier-1 form and there is no absent-vs-disabled alias. The autonomous search never emits it (it stays on the tier-1 box); a tier-2 genome is constructed only when a tier-2 change is genuinely proposed, and the promotion gate then requires human approval before it lands (Phase 4a).
 */
parameters: {
/**
 * Number of RSVP reminder nudges the planner sends a still-pending guest before the rsvp_window closes. Higher resolves more RSVPs (moves rsvp_resolution_rate up) but past a comfort threshold reads as nagging and depresses guest_sentiment_score (its paired guard). A bounded, non-binding cadence/flow knob: touches no spend/booking/PII/autonomy surface. Its AUTHORITATIVE risk tier is derived from the genome->surface map (shared deriveRiskTier), NOT restated here — this schema does not assert a tier it cannot enforce.
 */
rsvp_reminder_cadence: number
/**
 * How spread out the reminder nudges are in the rsvp_window (0 = tightly packed, 3 = very spread). More spacing makes each nudge gentler (a smaller guest_sentiment_score hit per nag) but fits FEWER nudges in the fixed window (delivered = min(cadence, capacity(spacing))), so it trades reminder reach for guest comfort. The TEMPORAL analogue of rsvp_reminder_cadence: a bounded flow/timing knob (WHEN nudges land, not WHAT they say), touching no comms-content, spend, booking, PII, or autonomy surface — so it derives to the SAME planning_flow_orchestration surface (tier 1). It manufactures no outcome: a guest still resolves only if its ground-truth need is met, so it adds no self-report-divergence surface.
 */
reminder_spacing: number
/**
 * OPTIONAL, TIER-2 (commitment_autonomy). How much the planner acts on the couple's behalf WITHOUT asking — the autonomy-governing threshold (1 = narrowest elevated autonomy, 3 = widest). Its mere PRESENCE elevates the whole genome to tier-2 via the genome->surface map (deriveRiskTier), because the AI deciding to consume the couple's scarce attention/authority is a commitment-autonomy surface, not flow. There is intentionally NO 0='off' value: a genome either OMITS this knob (the canonical tier-1 form) or carries an elevated value 1..3 (tier-2), so optionality introduces no absent-vs-disabled content-address alias. PHASE 4a: this knob is classified-but-not-yet-wired — Stage A does not read it and the autonomous search never emits it; it exists so a tier-2 genome is constructible to exercise the promotion gate (which parks tier-2 candidates pending an exogenous human approval). Its Stage-A behavioral wiring + forge-detection are deferred to Phase 4b. Its AUTHORITATIVE tier is derived from the surface map, never asserted here.
 */
autonomy_threshold?: number
}
}
