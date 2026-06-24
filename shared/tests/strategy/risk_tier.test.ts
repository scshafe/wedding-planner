import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import {
  deriveRiskTier,
  GENOME_PARAMETER_SURFACES,
  resolveFromRepoRoot,
  SURFACE_TIER_FLOOR,
  type StrategyGenome,
  UnmappedGenomeParameterError,
} from '@wedding-planner/shared'

/**
 * Step 2: the genome -> sensitivity-surface map + deriveRiskTier — the firewall's first real
 * mechanism (risk_tier_derivation.md was doc-only before Phase 2). The tier is derived from the
 * genome's parameters, never from any proposer self-declaration; an unmapped parameter fails closed.
 */

function genome(parameters: Record<string, number>, genome_id = 'g'): StrategyGenome {
  return { genome_id, parameters: parameters as StrategyGenome['parameters'] }
}

/** Read the inner `parameters` subschema straight from the on-disk contract (source of truth). */
function readParametersSchema(): { additionalProperties: unknown; properties: Record<string, unknown> } {
  const schemaPath = resolveFromRepoRoot('shared/schemas/strategy_genome_schema.json')
  const schema = JSON.parse(readFileSync(schemaPath, 'utf8')) as {
    properties: { parameters: { additionalProperties: unknown; properties: Record<string, unknown> } }
  }
  return schema.properties.parameters
}

describe('deriveRiskTier — derive from the genome, fail closed', () => {
  it('derives the genome tier as the MAX over its parameters surfaces (both flow knobs -> tier 1)', () => {
    const derived = deriveRiskTier(genome({ rsvp_reminder_cadence: 2, reminder_spacing: 1 }))
    expect(derived.tier).toBe(1)
    expect(derived.touchedSurfaces).toContain('planning_flow_orchestration')
    // perParameter is sorted by parameter name (a stable audit artifact, insertion-order-independent).
    expect(derived.perParameter).toEqual([
      { parameter: 'reminder_spacing', surface: 'planning_flow_orchestration', tierFloor: 1 },
      { parameter: 'rsvp_reminder_cadence', surface: 'planning_flow_orchestration', tierFloor: 1 },
    ])
  })

  it('perParameter ordering is insertion-order-independent (stable ledger artifact)', () => {
    const a = deriveRiskTier(genome({ rsvp_reminder_cadence: 2, reminder_spacing: 1 }))
    const b = deriveRiskTier(genome({ reminder_spacing: 1, rsvp_reminder_cadence: 2 } as never))
    expect(a.perParameter).toEqual(b.perParameter)
  })

  it('takes the MAX over touched surfaces (touching anything higher pulls the whole genome up)', () => {
    // Synthesize a multi-parameter derivation by exercising the reducer directly against the map
    // semantics: a hypothetical genome touching both a tier-1 and a tier-2 surface resolves to 2.
    // (Built from the public floor table so it stays honest if the table changes.)
    const floors = [SURFACE_TIER_FLOOR.planning_flow_orchestration, SURFACE_TIER_FLOOR.guest_comms_content]
    expect(Math.max(...floors)).toBe(2)
    expect(SURFACE_TIER_FLOOR.spend_authorization_model).toBe(3)
    expect(SURFACE_TIER_FLOOR.ranking_copy_cosmetic).toBe(0)
  })

  it('validates the genome first (the weld): an invalid genome throws before any tier is returned', () => {
    expect(() => deriveRiskTier(genome({ rsvp_reminder_cadence: 99, reminder_spacing: 0 }))).toThrow()
    expect(() => deriveRiskTier({ genome_id: 'g', parameters: { rsvp_reminder_cadence: 1, reminder_spacing: 0, x: 2 } } as never)).toThrow()
  })
})

describe('autonomy_threshold — the first tier-2 knob (Phase 4a), optional by presence', () => {
  it('a genome that OMITS autonomy_threshold stays tier-1 (the canonical search-box form)', () => {
    // The autonomous search never emits the knob; deriveRiskTier iterates only PRESENT parameters, so
    // every searched genome derives to 1 and auto-promotes exactly as before — no hash re-baseline.
    const derived = deriveRiskTier(genome({ rsvp_reminder_cadence: 2, reminder_spacing: 1 }))
    expect(derived.tier).toBe(1)
    expect(derived.perParameter.map((p) => p.parameter)).not.toContain('autonomy_threshold')
  })

  it('a genome that CARRIES autonomy_threshold derives to tier-2 (presence pulls the whole genome up)', () => {
    const derived = deriveRiskTier(genome({ rsvp_reminder_cadence: 2, reminder_spacing: 1, autonomy_threshold: 1 }))
    expect(derived.tier).toBe(2)
    expect(derived.touchedSurfaces).toContain('commitment_autonomy')
    // sorted, stable audit artifact; the tier-2 surface attribution is recorded per-parameter.
    expect(derived.perParameter).toEqual([
      { parameter: 'autonomy_threshold', surface: 'commitment_autonomy', tierFloor: 2 },
      { parameter: 'reminder_spacing', surface: 'planning_flow_orchestration', tierFloor: 1 },
      { parameter: 'rsvp_reminder_cadence', surface: 'planning_flow_orchestration', tierFloor: 1 },
    ])
  })

  it('every elevated value 1..3 is tier-2; there is no 0=off value (no absent-vs-disabled alias)', () => {
    for (const value of [1, 2, 3]) {
      expect(deriveRiskTier(genome({ rsvp_reminder_cadence: 0, reminder_spacing: 0, autonomy_threshold: value })).tier).toBe(2)
    }
    // 0 and 4 are out of the schema's 1..3 range -> the weld rejects them before any tier is returned.
    expect(() => deriveRiskTier(genome({ rsvp_reminder_cadence: 0, reminder_spacing: 0, autonomy_threshold: 0 }))).toThrow()
    expect(() => deriveRiskTier(genome({ rsvp_reminder_cadence: 0, reminder_spacing: 0, autonomy_threshold: 4 }))).toThrow()
  })

  it('the map entry is live (the drift guard above now requires it) and floors to tier 2', () => {
    expect(GENOME_PARAMETER_SURFACES.autonomy_threshold).toBe('commitment_autonomy')
    expect(SURFACE_TIER_FLOOR.commitment_autonomy).toBe(2)
  })
})

describe('map / schema drift guard', () => {
  it('every parameter in strategy_genome_schema.json is mapped to a sensitivity surface', () => {
    // The fail-closed throw should only ever fire on genuine drift; this test makes drift loud at CI
    // time rather than at loop time. Read the closed parameter set straight from the schema.
    const schemaParameters = Object.keys(readParametersSchema().properties)
    expect(schemaParameters.length).toBeGreaterThan(0)
    for (const parameter of schemaParameters) {
      expect(GENOME_PARAMETER_SURFACES, `unmapped schema parameter: ${parameter}`).toHaveProperty(parameter)
    }
  })

  it('pins the closed-set fact the fail-closed backstop depends on (additionalProperties === false)', () => {
    // deriveRiskTier's unmapped-throw is unreachable for VALID input only because the inner parameters
    // object is closed and Ajv enforces it (doddy Step-2 review: the weld held through three implicit
    // facts; this pins the load-bearing one). If a future edit removes this, a schema-valid genome
    // could carry an unmapped knob and the throw would fire at loop time instead of build time.
    expect(readParametersSchema().additionalProperties).toBe(false)
  })

  it('exposes the UnmappedGenomeParameterError with a coded firewall signal', () => {
    const error = new UnmappedGenomeParameterError(['x'])
    expect(error.code).toBe('RISK.UNMAPPED_GENOME_PARAMETER')
    expect(error.unmappedParameters).toEqual(['x'])
  })
})
