import { glob } from 'glob'
import { describe, expect, it } from 'vitest'

import {
  CONTRACT_DEFINITIONS,
  CONTRACT_COUNT,
  REPO_ROOT,
  SchemaRegistry,
} from '@wedding-planner/shared'

describe('schema registry', () => {
  it('registers exactly the 18 canonical contracts', () => {
    expect(CONTRACT_COUNT).toBe(18)
    expect(CONTRACT_DEFINITIONS).toHaveLength(18)
  })

  it('compiles every contract under ajv without error', () => {
    const registry = new SchemaRegistry()
    for (const key of registry.contractKeys()) {
      // getValidateFunction forces ajv to compile the schema; a non-compiling schema throws.
      const validate = registry.getValidateFunction(key)
      expect(typeof validate).toBe('function')
    }
  })

  it('matches on-disk schema discovery exactly (no drift between files and the manifest)', async () => {
    const discovered = await glob('**/schemas/*.json', {
      cwd: REPO_ROOT,
      ignore: ['**/node_modules/**'],
      posix: true,
    })
    const discoveredSet = new Set(discovered)
    const manifestSet = new Set(CONTRACT_DEFINITIONS.map((definition) => definition.repoRelativePath))

    // Every registered contract exists on disk.
    for (const path of manifestSet) {
      expect(discoveredSet, `manifest path missing on disk: ${path}`).toContain(path)
    }
    // Every schema file on disk is registered in the manifest (catches an unregistered new schema).
    for (const path of discoveredSet) {
      expect(manifestSet, `schema file on disk not registered in the manifest: ${path}`).toContain(
        path,
      )
    }
    expect(discoveredSet.size).toBe(CONTRACT_COUNT)
  })

  it('validates a conforming value and rejects a non-conforming one for the same contract', () => {
    const registry = new SchemaRegistry()

    const validEnvelope = {
      event_id: 'evt_1',
      event_name: 'commitment.executed',
      occurred_at: '2027-01-01T00:00:00Z',
      trace_id: 'trace_1',
      wedding_id: 'wed_1',
      phase: 'booking',
      capability: 'budget_management',
      actor: 'ai',
      source: 'eval',
      payload: {},
      meta: { schema_version: '1.0.0' },
    }
    const valid = registry.validate('event_envelope', validEnvelope)
    expect(valid.valid).toBe(true)

    // capability not in the enum -> must fail, with structured errors surfaced.
    const invalidEnvelope = { ...validEnvelope, capability: 'not_a_capability' }
    const invalid = registry.validate('event_envelope', invalidEnvelope)
    expect(invalid.valid).toBe(false)
    expect(invalid.errors.length).toBeGreaterThan(0)
  })

  it('assertValid throws a coded ContractValidationFailedError on invalid input', () => {
    const registry = new SchemaRegistry()
    try {
      registry.assertValid('event_envelope', { not: 'an envelope' })
      throw new Error('expected assertValid to throw')
    } catch (error) {
      expect(error).toMatchObject({ code: 'CONTRACT.VALIDATION_FAILED', contractKey: 'event_envelope' })
    }
  })
})
