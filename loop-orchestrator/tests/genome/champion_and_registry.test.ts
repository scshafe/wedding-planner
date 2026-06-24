import { ChampionStore, GenomeRegistry } from '@wedding-planner/loop-orchestrator'
import { genomeArtifactRef, type StrategyGenome } from '@wedding-planner/shared'
import { describe, expect, it } from 'vitest'

/**
 * Step 5: the ChampionStore (the standard a candidate must beat; ratchets on offline-accept) and the
 * content-addressed GenomeRegistry (resolves a candidate's artifact_ref to its genome).
 */

function genome(cadence: number, genome_id = `g_${cadence}`): StrategyGenome {
  return { genome_id, parameters: { rsvp_reminder_cadence: cadence } }
}

describe('ChampionStore', () => {
  it('seeds with a champion and returns it', () => {
    const store = new ChampionStore(genome(0))
    expect(store.current().parameters.rsvp_reminder_cadence).toBe(0)
  })

  it('promote advances the champion (the monotonic ratchet)', () => {
    const store = new ChampionStore(genome(0))
    store.promote(genome(2))
    expect(store.current().parameters.rsvp_reminder_cadence).toBe(2)
    expect(store.currentHash()).toBe(
      // currentHash is the content-address of the promoted genome (id-independent).
      genomeArtifactRef(genome(2, 'different_id')).replace('genome:', ''),
    )
  })

  it('validates the seed and any promoted genome (the weld)', () => {
    expect(() => new ChampionStore({ genome_id: 'bad', parameters: { rsvp_reminder_cadence: 99 } })).toThrow()
    const store = new ChampionStore(genome(0))
    expect(() => store.promote({ genome_id: 'bad', parameters: { rsvp_reminder_cadence: 9 } })).toThrow()
  })
})

describe('GenomeRegistry', () => {
  it('register returns the content-addressed ref and resolve round-trips it', () => {
    const registry = new GenomeRegistry()
    const g = genome(1)
    const ref = registry.register(g)
    expect(ref).toBe(genomeArtifactRef(g))
    expect(registry.resolve(ref)?.parameters.rsvp_reminder_cadence).toBe(1)
    expect(registry.has(ref)).toBe(true)
  })

  it('is idempotent on behavior-equal genomes (same parameters -> same ref regardless of id)', () => {
    const registry = new GenomeRegistry()
    const ref1 = registry.register(genome(2, 'id_a'))
    const ref2 = registry.register(genome(2, 'id_b'))
    expect(ref1).toBe(ref2)
  })

  it('resolve returns undefined for an unregistered hash or a malformed (non-genome) ref', () => {
    const registry = new GenomeRegistry()
    registry.register(genome(1))
    expect(registry.resolve(genomeArtifactRef(genome(3)))).toBeUndefined() // never registered
    expect(registry.resolve('branch:nope')).toBeUndefined() // not a genome ref
    expect(registry.has('branch:nope')).toBe(false)
  })

  it('validates on register: an invalid genome can never be stored or resolved', () => {
    const registry = new GenomeRegistry()
    expect(() => registry.register({ genome_id: 'bad', parameters: { rsvp_reminder_cadence: 42 } })).toThrow()
  })
})
