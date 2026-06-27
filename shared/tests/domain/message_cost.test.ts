import { describe, expect, it } from 'vitest'

import { CHANNELS, type Channel, isChannel, MESSAGE_COST_CENTS, messageCostCents } from '../../src/index'

/**
 * Drift guard for the inward per-message cost basis. `MESSAGE_COST_CENTS` must stay EXHAUSTIVE over the
 * canonical `Channel` enum — a new channel must carry a cost or the North-Star money term silently drops it.
 * The values are pinned so a careless edit is loud at CI, and asserted to be positive integer cents (money
 * is never a float here; a zero/negative cost would make a message free or a credit, both nonsensical).
 */
describe('MESSAGE_COST_CENTS — the inward per-message cost basis', () => {
  it('is exhaustive over CHANNELS, with positive integer cents for every channel', () => {
    for (const channel of CHANNELS) {
      const cents = MESSAGE_COST_CENTS[channel]
      expect(cents, `channel ${channel} must have a cost`).toBeTypeOf('number')
      expect(Number.isInteger(cents)).toBe(true)
      expect(cents).toBeGreaterThan(0)
    }
    // No EXTRA keys beyond the canonical channel set (a stale channel would price a non-existent medium).
    expect(Object.keys(MESSAGE_COST_CENTS).sort()).toEqual([...CHANNELS].sort())
  })

  it('pins the canonical cost values (drift is loud at CI)', () => {
    expect(MESSAGE_COST_CENTS).toEqual({ email: 1, sms: 2, whatsapp: 1, phone: 5, postal: 60 })
  })

  it('messageCostCents returns the table value and throws on a non-channel (stale cast guard)', () => {
    expect(messageCostCents('email')).toBe(1)
    expect(messageCostCents('postal')).toBe(60)
    expect(() => messageCostCents('carrier_pigeon' as Channel)).toThrow(/unknown channel/)
  })

  it('isChannel guards membership before indexing the cost table', () => {
    expect(isChannel('sms')).toBe(true)
    expect(isChannel('carrier_pigeon')).toBe(false)
    expect(isChannel(undefined)).toBe(false)
    expect(isChannel(3)).toBe(false)
  })
})
