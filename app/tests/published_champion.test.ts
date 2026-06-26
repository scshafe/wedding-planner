import { deriveRiskTier } from '@wedding-planner/shared'
import { describe, expect, it } from 'vitest'

import { assertTier1Champion, publishedChampion } from '../published_champion'

/**
 * A build-time drift-guard for the committed champion snapshot (Phase 17). The artifact is injected at boot
 * and asserted tier-1 there (fail-closed); these tests catch a bad hand-edit in CI rather than at boot — e.g.
 * accidentally adding `autonomy_threshold` (which would elevate it to tier-2, a strategy that must NEVER be
 * presented as the active default without human approval).
 */
describe('publishedChampion — the committed snapshot of the loop champion', () => {
  it('is the documented tier-1 optimum (cadence 3, spacing 1, batching 1)', () => {
    expect(publishedChampion.parameters).toEqual({
      rsvp_reminder_cadence: 3,
      reminder_spacing: 1,
      reminder_batching: 1,
    })
    expect(publishedChampion.parameters.autonomy_threshold).toBeUndefined()
  })

  it('re-derives to tier-1 via the trusted derivation', () => {
    expect(deriveRiskTier(publishedChampion).tier).toBe(1)
  })

  it('passes the fail-closed tier-1 inject assertion', () => {
    expect(() => assertTier1Champion(publishedChampion)).not.toThrow()
    expect(assertTier1Champion(publishedChampion)).toBe(publishedChampion)
  })

  it('the inject assertion REFUSES a tier-2 strategy (autonomy_threshold present)', () => {
    const tier2 = { genome_id: 'g2', parameters: { ...publishedChampion.parameters, autonomy_threshold: 2 } }
    expect(() => assertTier1Champion(tier2)).toThrow(/non-tier-1|tier 2|human approval/i)
  })

  it('the inject assertion REFUSES an invalid genome (fail-closed validation)', () => {
    const bad = { genome_id: 'g', parameters: { rsvp_reminder_cadence: 9, reminder_spacing: 1, reminder_batching: 1 } }
    expect(() => assertTier1Champion(bad as never)).toThrow()
  })
})
