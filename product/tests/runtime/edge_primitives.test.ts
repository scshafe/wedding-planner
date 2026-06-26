import type { Clock, IdGenerator } from '@wedding-planner/shared'
import { describe, expect, it } from 'vitest'

import { RandomIdGenerator } from '../../src/runtime/random_id_generator'
import { SystemClock } from '../../src/runtime/system_clock'

/**
 * Step-1 coverage for the EDGE-ONLY runtime primitives — the one deliberate exception to the determinism
 * rail, deployed only by `app/server.ts`. These are imported by RELATIVE PATH on purpose: they are exported
 * from neither the shared nor the product barrel, so the eval/loop replay core (which imports only the shared
 * barrel) is structurally unable to reach a wall clock or a non-deterministic id source. This test imports
 * them the same way the entrypoint does, and pins that each conforms to the injected interface it stands in
 * for, so `composeProductSurface` can accept either the deterministic double or the live edge impl.
 */

describe('SystemClock — the edge-only wall clock', () => {
  it('is a Clock and returns a valid ISO 8601 UTC instant', () => {
    const clock: Clock = new SystemClock()
    const now = clock.now()
    // Round-trips through Date and re-serializes identically => a real ISO 8601 UTC string (Z-suffixed).
    expect(now).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
    expect(new Date(now).toISOString()).toBe(now)
  })

  it('never goes backwards across successive reads', () => {
    const clock = new SystemClock()
    const a = Date.parse(clock.now())
    const b = Date.parse(clock.now())
    expect(b).toBeGreaterThanOrEqual(a)
  })
})

describe('RandomIdGenerator — the edge-only non-deterministic id source', () => {
  it('is an IdGenerator and stamps the requested prefix', () => {
    const ids: IdGenerator = new RandomIdGenerator()
    expect(ids.next('tenant')).toMatch(/^tenant_/)
    expect(ids.next('wedding')).toMatch(/^wedding_/)
  })

  it('mints collision-free ids across many calls (no fixed sequence to replay)', () => {
    const ids = new RandomIdGenerator()
    const minted = new Set<string>()
    for (let i = 0; i < 5000; i += 1) minted.add(ids.next('id'))
    expect(minted.size).toBe(5000)
  })
})
