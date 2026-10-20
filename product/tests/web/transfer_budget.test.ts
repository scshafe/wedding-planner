import { describe, expect, it } from 'vitest'

import { TRANSFER_LIMITS, TransferBudget } from '@wedding-planner/product'

/** Issue #48 — the transfer budget: bytes in flight overall and per key, forced holds, releases that run once. */

const MIB = 1024 * 1024

describe('TransferBudget', () => {
  it('holds up to the budget; a key holds up to its own share; each release runs once', () => {
    const b = new TransferBudget({ ...TRANSFER_LIMITS, in_flight_bytes: 20 * MIB, per_key_bytes: 12 * MIB })
    const a1 = b.hold(8 * MIB, { key: 'a' })
    expect(a1).toBeDefined()
    expect(b.hold(8 * MIB, { key: 'a' })).toBeUndefined()
    expect(b.canSend(8 * MIB, 'a')).toBe(false)
    const b1 = b.hold(8 * MIB, { key: 'b' })
    expect(b1).toBeDefined()
    // Overall: 16 of 20 held.
    expect(b.hold(8 * MIB)).toBeUndefined()
    a1?.()
    a1?.()
    expect(b.canSend(8 * MIB, 'a')).toBe(true)
    expect(b.canSend(12 * MIB)).toBe(true)
    expect(b.canSend(13 * MIB)).toBe(false)
  })

  it('a forced hold passes the budget (an applied write) and is released like any other', () => {
    const b = new TransferBudget({ ...TRANSFER_LIMITS, in_flight_bytes: MIB })
    const release = b.hold(5 * MIB, { force: true })
    expect(b.canSend(1)).toBe(false)
    release?.()
    expect(b.canSend(MIB)).toBe(true)
  })

  it('one large upload place per owner, a few in all', () => {
    const b = new TransferBudget({ ...TRANSFER_LIMITS, large_uploads: 2 })
    const x = b.holdUpload('x')
    expect(b.holdUpload('x')).toBeUndefined()
    expect(b.holdUpload('y')).toBeDefined()
    expect(b.holdUpload('z')).toBeUndefined()
    x?.()
    expect(b.holdUpload('z')).toBeDefined()
  })
})
