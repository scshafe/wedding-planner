import { describe, expect, it } from 'vitest'

import {
  assertValidGenome,
  canonicalGenomeHash,
  classifyGenomeArtifactRef,
  GENOME_ARTIFACT_REF_PREFIX,
  genomeArtifactRef,
  genomeMatchesArtifactRef,
  getSchemaRegistry,
  type StrategyGenome,
} from '@wedding-planner/shared'

/**
 * Step 1: the strategy_genome contract + its content-address binding. These tests pin the firewall
 * property — a candidate commits to exactly the genome that runs via artifact_ref = genome:<hash> —
 * and the non-spoofability of that hash (parameters-only, key-order-independent).
 *
 * Phase 3: the closed parameter set is now {rsvp_reminder_cadence, reminder_spacing}, both REQUIRED.
 * `cad(c, s)` builds a conforming parameters object; the firewall properties are unchanged.
 */

function genome(parameters: StrategyGenome['parameters'], genome_id = 'g_test'): StrategyGenome {
  return { genome_id, parameters }
}

/** A conforming parameters object at (cadence, spacing). */
function cad(cadence: number, spacing = 0): StrategyGenome['parameters'] {
  return { rsvp_reminder_cadence: cadence, reminder_spacing: spacing }
}

describe('strategy_genome contract', () => {
  it('compiles and validates a conforming genome via the schema registry', () => {
    const valid = getSchemaRegistry().validate('strategy_genome', genome(cad(1, 2)))
    expect(valid.valid).toBe(true)
  })

  it('rejects an out-of-range parameter, an unknown parameter, and a missing required parameter', () => {
    const registry = getSchemaRegistry()
    // additionalProperties:false + range bounds + required are the firewall: a proposer cannot
    // smuggle an unmapped knob or an out-of-band value past the contract.
    expect(registry.validate('strategy_genome', genome({ rsvp_reminder_cadence: 9, reminder_spacing: 0 } as never)).valid).toBe(false)
    expect(registry.validate('strategy_genome', genome({ ...cad(1), sneaky: 1 } as never)).valid).toBe(false)
    // A missing required parameter (only cadence, no spacing) is rejected: every knob is required.
    expect(registry.validate('strategy_genome', { genome_id: 'g', parameters: { rsvp_reminder_cadence: 1 } } as never).valid).toBe(false)
    expect(registry.validate('strategy_genome', { genome_id: 'g', parameters: {} }).valid).toBe(false)
  })

  it('assertValidGenome throws a coded error on an invalid genome', () => {
    expect(() => assertValidGenome({ genome_id: 'g', parameters: { rsvp_reminder_cadence: 'two', reminder_spacing: 0 } })).toThrow(
      /CONTRACT\.VALIDATION_FAILED|strategy_genome/,
    )
  })
})

describe('canonicalGenomeHash — the content-address binding', () => {
  it('is deterministic: same parameters -> same hash', () => {
    expect(canonicalGenomeHash(genome(cad(2, 1)))).toBe(canonicalGenomeHash(genome(cad(2, 1))))
  })

  it('changes when ANY parameter value changes (behavior-distinct -> hash-distinct)', () => {
    // Either knob distinguishes behavior, so either must distinguish the hash.
    expect(canonicalGenomeHash(genome(cad(1, 0)))).not.toBe(canonicalGenomeHash(genome(cad(2, 0))))
    expect(canonicalGenomeHash(genome(cad(2, 0)))).not.toBe(canonicalGenomeHash(genome(cad(2, 1))))
  })

  it('ignores genome_id: the hash is over parameters only (no id-aliasing of one behavior)', () => {
    const a = canonicalGenomeHash(genome(cad(1, 1), 'id_a'))
    const b = canonicalGenomeHash(genome(cad(1, 1), 'id_b'))
    expect(a).toBe(b)
  })

  it('is key-order independent (canonical-JSON over parameters)', () => {
    // Two logically-equal parameter objects built by different insertion orders must hash equal.
    const params1 = {} as Record<string, number>
    params1.reminder_spacing = 2
    params1.rsvp_reminder_cadence = 3
    const params2: Record<string, number> = { rsvp_reminder_cadence: 3, reminder_spacing: 2 }
    expect(canonicalGenomeHash(genome(params1 as never))).toBe(canonicalGenomeHash(genome(params2 as never)))
  })
})

describe('genomeArtifactRef / genomeMatchesArtifactRef', () => {
  it('produces a prefixed content-addressed ref', () => {
    const ref = genomeArtifactRef(genome(cad(0)))
    expect(ref.startsWith(GENOME_ARTIFACT_REF_PREFIX)).toBe(true)
    expect(ref).toBe(`${GENOME_ARTIFACT_REF_PREFIX}${canonicalGenomeHash(genome(cad(0)))}`)
  })

  it('matches its own ref and rejects a substituted genome or a malformed ref', () => {
    const g = genome(cad(1))
    expect(genomeMatchesArtifactRef(g, genomeArtifactRef(g))).toBe(true)
    // Substitution: a different-behavior genome must NOT match the committed ref.
    expect(genomeMatchesArtifactRef(genome(cad(2)), genomeArtifactRef(g))).toBe(false)
    // A genome differing only in spacing is also a substitution (spacing is behavioral).
    expect(genomeMatchesArtifactRef(genome(cad(1, 2)), genomeArtifactRef(g))).toBe(false)
    // Malformed / missing prefix.
    expect(genomeMatchesArtifactRef(g, canonicalGenomeHash(g))).toBe(false)
    expect(genomeMatchesArtifactRef(g, 'branch:whatever')).toBe(false)
  })

  it('classifies the three verdicts distinctly (so a caller cannot collapse malformed into regenerate)', () => {
    const g = genome(cad(1))
    expect(classifyGenomeArtifactRef(g, genomeArtifactRef(g))).toBe('match')
    // Right scheme, wrong genome -> substitution.
    expect(classifyGenomeArtifactRef(genome(cad(0)), genomeArtifactRef(g))).toBe('mismatch')
    // Not a genome content-address at all.
    expect(classifyGenomeArtifactRef(g, 'branch:whatever')).toBe('malformed_ref')
    expect(classifyGenomeArtifactRef(g, canonicalGenomeHash(g))).toBe('malformed_ref')
  })
})

describe('the validation weld (doddy invariant: validate before you bind)', () => {
  it('canonicalGenomeHash TRUSTS its caller — it will hash an unvalidated object with a smuggled knob', () => {
    // This is the documented precondition made visible: the hash itself does NOT close the value
    // space. A smuggled parameter produces a perfectly stable hash. The closed-set guarantee lives in
    // assertValidGenome, which enforcement callers (Steps 2/3) must run FIRST.
    const smuggled = { genome_id: 'g', parameters: { ...cad(1), sneaky: 9 } } as never
    expect(typeof canonicalGenomeHash(smuggled)).toBe('string')
  })

  it('assertValidGenome is the weld: it rejects the smuggled-knob genome the hash would have accepted', () => {
    const smuggled = { genome_id: 'g', parameters: { ...cad(1), sneaky: 9 } }
    expect(() => assertValidGenome(smuggled)).toThrow()
  })
})
