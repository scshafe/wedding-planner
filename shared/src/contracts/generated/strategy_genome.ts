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
 * The behavioral knobs the planner simulator reads. CLOSED set: every parameter must appear in the genome->surface map (shared deriveRiskTier) or risk derivation fails closed. The canonical hash is computed over THIS object only.
 */
parameters: {
/**
 * Number of RSVP reminder nudges the planner sends a still-pending guest before the rsvp_window closes. Higher resolves more RSVPs (moves rsvp_resolution_rate up) but past a comfort threshold reads as nagging and depresses guest_sentiment_score (its paired guard). Tier 0 (no spend/comms-content/autonomy surface).
 */
rsvp_reminder_cadence: number
}
}
