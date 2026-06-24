import { describe, expect, it } from 'vitest'

import { ManualClock, SequentialIdGenerator } from '@wedding-planner/shared'

describe('ManualClock', () => {
  it('returns the injected start time and only moves when advanced', () => {
    const clock = new ManualClock('2027-01-02T15:00:00.000Z')
    expect(clock.now()).toBe('2027-01-02T15:00:00.000Z')
    clock.advance(60_000)
    expect(clock.now()).toBe('2027-01-02T15:01:00.000Z')
  })

  it('two clocks from the same start produce identical sequences (replayability)', () => {
    const a = new ManualClock('2027-01-02T15:00:00.000Z')
    const b = new ManualClock('2027-01-02T15:00:00.000Z')
    a.advance(1000)
    b.advance(1000)
    expect(a.now()).toBe(b.now())
  })

  it('rejects a non-ISO start', () => {
    expect(() => new ManualClock('not-a-date')).toThrow()
  })
})

describe('SequentialIdGenerator', () => {
  it('produces stable, per-prefix, seed-scoped ids', () => {
    const ids = new SequentialIdGenerator('seedA')
    expect(ids.next('evt')).toBe('evt_seedA_1')
    expect(ids.next('evt')).toBe('evt_seedA_2')
    expect(ids.next('cand')).toBe('cand_seedA_1')
  })

  it('two generators with the same seed and call order produce identical ids', () => {
    const a = new SequentialIdGenerator('s')
    const b = new SequentialIdGenerator('s')
    expect(a.next('evt')).toBe(b.next('evt'))
    expect(a.next('evt')).toBe(b.next('evt'))
  })
})
