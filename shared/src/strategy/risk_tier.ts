import { type StrategyGenome } from '../contracts/contract_types'
import { WeddingPlannerError } from '../errors/wedding_planner_error'
import { assertValidGenome } from './genome'

/**
 * @canonical genome_risk_tier -- the deterministic risk-tier derivation for a strategy genome.
 *
 * The offline analogue of loop-orchestrator/risk_tier_derivation.md: that spec derives a candidate's
 * authoritative tier from a static analysis of the DIFF at artifact_ref, NEVER from the proposer's
 * self-declared `risk_tier` (relaundering the claim is not verification). Offline, the "diff" is the
 * genome's `parameters`, and `touched_surfaces` is the set of sensitivity surfaces of the parameters
 * present. The tier is `max` over those surfaces' floors — touching anything higher pulls the whole
 * genome up. This is the firewall's FIRST real mechanism (the spec was doc-only before Phase 2).
 *
 * Two load-bearing properties (doddy, Phase-2 reviews):
 *  - VALIDATE FIRST (the weld): the genome is `assertValidGenome`-d before any surface lookup, so an
 *    unmapped parameter cannot ride along inside a stable content hash.
 *  - FAIL CLOSED: a schema-valid parameter with no entry in the trusted surface map throws (it does
 *    NOT default to tier 0). The schema's CLOSED parameter set plus the drift-guard test
 *    (every schema parameter is mapped) means this only fires on genuine map/schema drift — and when
 *    it does, the safe answer is "refuse", not "assume harmless".
 *
 * The GENOME_PARAMETER_SURFACES map is TRUSTED CONFIG: it lives in `shared` (which the proposer
 * imports read-only), outside any proposer's write scope, exactly like the graders and the corpus.
 *
 * related: genome.ts (the content-address binding it welds to), risk_tier_derivation.md (the spec).
 */

/** The sensitivity surfaces a genome parameter can touch, mirroring risk_tier_derivation.md Step 2. */
export type SensitivitySurface =
  | 'ranking_copy_cosmetic'
  | 'planning_flow_orchestration'
  | 'guest_comms_content'
  | 'binding_integration'
  | 'commitment_autonomy'
  | 'pii_handling'
  | 'spend_authorization_model'
  | 'objective_graders_corpus'
  | 'legal_terms'

/** The tier floor each surface pulls a genome up to (risk_tier_derivation.md Step 2 table). */
export const SURFACE_TIER_FLOOR: Readonly<Record<SensitivitySurface, 0 | 1 | 2 | 3>> = {
  ranking_copy_cosmetic: 0,
  planning_flow_orchestration: 1,
  guest_comms_content: 2,
  binding_integration: 2,
  commitment_autonomy: 2,
  pii_handling: 2,
  spend_authorization_model: 3,
  objective_graders_corpus: 3,
  legal_terms: 3,
}

/**
 * The trusted parameter -> surface map. EVERY parameter in strategy_genome_schema.json's closed
 * `parameters` set MUST appear here (asserted by a drift-guard test); a new knob requires a reviewed
 * edit to BOTH the schema and this map. Reserved (commented) entries name where the dangerous knobs
 * will land so their tier is decided before they exist, not after.
 */
export const GENOME_PARAMETER_SURFACES: Readonly<Record<string, SensitivitySurface>> = {
  // rsvp_reminder_cadence is a non-binding FLOW knob (how many reminder nudges to schedule) — not
  // comms *content* and not segmentation, so it sits at planning-flow (tier 1), not guest_comms (2).
  // The nagging risk is held by its paired guard metric (guest_sentiment_score), not by the tier.
  // PRECEDENT GUARD (doddy, Step-2 review): this Tier-1 classification holds because the knob is
  // BOUNDED (0..3 in the schema). It must NOT auto-launder a future *unbounded* outreach-volume knob
  // (e.g. a wide-range followup_interval): high-volume unsolicited guest contact is a guest-comms
  // surface (tier 2), even though it looks like "cadence". Bounded reminder cadence != outreach volume.
  rsvp_reminder_cadence: 'planning_flow_orchestration',
  // reminder_spacing is the TEMPORAL twin of cadence: it sets WHEN nudges land (how spread out), not
  // WHAT they say. Timing/spacing is flow orchestration, not comms *content* and not segmentation, and
  // it is BOUNDED (0..3) — so it sits at the SAME planning-flow surface (tier 1) as cadence. Same
  // PRECEDENT GUARD applies (Phase-2 doddy review): this holds only because the knob is bounded and
  // outcome-neutral (it manufactures no resolution — see stage_a_planner). It must NOT auto-launder a
  // future knob that changes comms CONTENT/tone (guest_comms_content, tier 2) or that lets the AI
  // decide to consume couple time / take an action (commitment_autonomy, tier 2) just because it,
  // too, looks like "a small bounded scheduling number". See memory: second-genome-knob-must-stay-tier1.
  reminder_spacing: 'planning_flow_orchestration',
  // autonomy_threshold is the FIRST tier-2 knob (Phase 4a). It governs how much the planner acts on the
  // couple's behalf WITHOUT asking — an autonomy-governing threshold, i.e. the AI deciding to consume the
  // couple's scarce attention/authority. That is the commitment_autonomy surface (tier 2), NOT flow:
  // PRECEDENT GUARD — its bounded 1..3 range does NOT launder it to tier 1 the way the bounded cadence
  // knob sits at tier 1. Bounded-ness was already rejected once as a sole tier argument (the cadence
  // comment above); an autonomy threshold is tier-2 because of WHAT it governs (acting without asking),
  // not how wide its range is. It is OPTIONAL in the schema (presence => tier-2; omission => tier-1
  // canonical form), so deriveRiskTier returns 1 for every genome the autonomous tier-1 search emits and
  // 2 only for a genome that carries it. The promotion gate (Phase 4a) parks tier-2 candidates pending an
  // exogenous human approval; the knob's Stage-A wiring + forge-detection are Phase 4b.
  // See memory: second-genome-knob-must-stay-tier1, tier2-promotion-gate-is-load-bearing.
  autonomy_threshold: 'commitment_autonomy',
  // Reserved for later phases (decide the tier before the knob exists):
  //   any spend-authorization knob            -> 'spend_authorization_model' (tier 3, prohibited)
  //   unbounded outreach-volume / contact-frequency knob -> 'guest_comms_content' (tier 2)
}

/** Thrown when a schema-valid genome carries a parameter with no entry in the trusted surface map. */
export class UnmappedGenomeParameterError extends WeddingPlannerError {
  readonly unmappedParameters: readonly string[]

  constructor(unmappedParameters: readonly string[]) {
    super(
      'RISK.UNMAPPED_GENOME_PARAMETER',
      `Genome parameter(s) have no sensitivity-surface mapping (fail closed, refusing to tier): ` +
        unmappedParameters.join(', '),
      { context: { unmappedParameters } },
    )
    this.unmappedParameters = unmappedParameters
  }
}

/** The per-parameter surface attribution behind a derived tier (for the ledger / mismatch reporting). */
export interface ParameterSurface {
  readonly parameter: string
  readonly surface: SensitivitySurface
  readonly tierFloor: 0 | 1 | 2 | 3
}

/** The authoritative tier derived from a genome, with its surface attribution. */
export interface GenomeRiskDerivation {
  readonly tier: 0 | 1 | 2 | 3
  readonly perParameter: readonly ParameterSurface[]
  readonly touchedSurfaces: readonly SensitivitySurface[]
}

/**
 * Derive the authoritative risk tier of a genome: `max` over the tier floors of the surfaces its
 * parameters touch. Validates the genome first (the weld) and fails closed on any unmapped parameter.
 * A genome with no parameters is not possible (the schema requires at least the mapped knob), so the
 * derivation always has at least one surface and a defined tier.
 */
export function deriveRiskTier(genome: StrategyGenome): GenomeRiskDerivation {
  const valid = assertValidGenome(genome)
  const parameterKeys = Object.keys(valid.parameters)

  const unmapped = parameterKeys.filter((key) => !(key in GENOME_PARAMETER_SURFACES))
  if (unmapped.length > 0) {
    throw new UnmappedGenomeParameterError(unmapped)
  }

  // Sort by parameter name so the derivation/ledger artifact is stable regardless of the genome's
  // property insertion order (the content hash is already order-independent; this keeps the AUDIT
  // packet order-independent too, so two behavior-equal genomes produce byte-identical attribution).
  const perParameter: ParameterSurface[] = [...parameterKeys]
    .sort()
    .map((parameter) => {
      const surface = GENOME_PARAMETER_SURFACES[parameter] as SensitivitySurface
      return { parameter, surface, tierFloor: SURFACE_TIER_FLOOR[surface] }
    })

  const tier = perParameter.reduce<0 | 1 | 2 | 3>(
    (max, entry) => (entry.tierFloor > max ? entry.tierFloor : max),
    0,
  )
  const touchedSurfaces = [...new Set(perParameter.map((entry) => entry.surface))]

  return { tier, perParameter, touchedSurfaces }
}
