import { ManualClock, SequentialIdGenerator, type Tenant } from '@wedding-planner/shared'
import { describe, expect, it } from 'vitest'

import {
  EscalationResolutionLog,
  type TenantContext,
  TenantContextResolver,
  TenantStore,
} from '@wedding-planner/product'

/**
 * Phase 27 — the escalation-RESOLUTION log records that a guest escalation has been HANDLED (resolved/dismissed)
 * WITHOUT mutating the immutable escalation (ADR 0026 F6 / ADR 0027). It inherits tenant isolation from the
 * TenantScopedRepository, keys by escalation_id (read-first-put-if-absent → first-writer-wins), stamps resolved_at
 * from the injected clock, and exposes a planner `list` + a couple `listForWedding` partition filter.
 */

const THEME: Tenant['theme'] = {
  brand_name: 'Brand',
  primary_color_hex: '#111111',
  accent_color_hex: '#222222',
  logo_ref: 'asset_1',
}

interface World {
  log: EscalationResolutionLog
  clock: ManualClock
  store: TenantStore
  ctxA: TenantContext
  ctxB: TenantContext
}

function makeWorld(): World {
  const clock = new ManualClock('2027-03-01T00:00:00.000Z')
  const store = new TenantStore(clock, new SequentialIdGenerator('seedT'))
  store.create({ slug: 'alpha', display_name: 'Alpha', theme: THEME, plan_tier: 'solo', lifecycle_status: 'active' })
  store.create({ slug: 'beta', display_name: 'Beta', theme: THEME, plan_tier: 'solo', lifecycle_status: 'active' })
  const resolver = new TenantContextResolver(store)
  return {
    log: new EscalationResolutionLog(store, new SequentialIdGenerator('seedR'), clock),
    clock,
    store,
    ctxA: resolver.resolveBySlug('alpha'),
    ctxB: resolver.resolveBySlug('beta'),
  }
}

function codeOfThrow(fn: () => unknown): string {
  try {
    fn()
  } catch (error) {
    return (error as { code?: string }).code ?? `NON_CODED:${String(error)}`
  }
  return 'NO_THROW'
}

describe('EscalationResolutionLog', () => {
  it('resolves: mints an id, stamps tenant_id from the context + resolved_at from the clock, validates, persists', () => {
    const w = makeWorld()
    const rec = w.log.resolve(w.ctxA, {
      escalation_id: 'escalation_1',
      wedding_id: 'wed_1',
      status: 'resolved',
      resolved_by: 'couple',
    })
    expect(rec).toMatchObject({
      tenant_id: w.ctxA.tenant_id,
      escalation_id: 'escalation_1',
      wedding_id: 'wed_1',
      status: 'resolved',
      resolved_by: 'couple',
    })
    expect(rec.resolution_id).toMatch(/^resolution/)
    // resolved_at is the REAL clock-stamped value — validates with no 500.
    expect(rec.resolved_at).toBe('2027-03-01T00:00:00.000Z')
    expect(w.log.list(w.ctxA)).toHaveLength(1)
  })

  it('is idempotent by escalation_id → FIRST-WRITER-WINS: a re-resolve returns the original, status never changes', () => {
    const w = makeWorld()
    const first = w.log.resolve(w.ctxA, {
      escalation_id: 'escalation_dup',
      wedding_id: 'wed_1',
      status: 'resolved',
      resolved_by: 'couple',
    })
    // Advancing the clock proves the second call neither re-stamps nor overwrites — the original record is returned.
    w.clock.advance(60_000)
    const second = w.log.resolve(w.ctxA, {
      escalation_id: 'escalation_dup',
      wedding_id: 'wed_1',
      status: 'dismissed', // a later DISMISS of an already-RESOLVED escalation is a no-op (first status sticks)
      resolved_by: 'planner',
    })
    expect(second).toEqual(first)
    expect(second.status).toBe('resolved')
    expect(second.resolved_at).toBe('2027-03-01T00:00:00.000Z')
    expect(w.log.list(w.ctxA)).toHaveLength(1)
  })

  it('list returns the whole tenant partition (planner); listForWedding filters to one wedding (couple)', () => {
    const w = makeWorld()
    w.log.resolve(w.ctxA, { escalation_id: 'e1', wedding_id: 'wed_1', status: 'resolved', resolved_by: 'couple' })
    w.log.resolve(w.ctxA, { escalation_id: 'e2', wedding_id: 'wed_1', status: 'dismissed', resolved_by: 'planner' })
    w.log.resolve(w.ctxA, { escalation_id: 'e3', wedding_id: 'wed_2', status: 'resolved', resolved_by: 'planner' })
    expect(w.log.list(w.ctxA)).toHaveLength(3)
    expect(w.log.listForWedding(w.ctxA, 'wed_1').map((r) => r.escalation_id)).toEqual(['e1', 'e2'])
    expect(w.log.listForWedding(w.ctxA, 'wed_2').map((r) => r.escalation_id)).toEqual(['e3'])
  })

  it('listForWedding collapses an undefined wedding_id to [] (a couple with no bound wedding)', () => {
    const w = makeWorld()
    w.log.resolve(w.ctxA, { escalation_id: 'e1', wedding_id: 'wed_1', status: 'resolved', resolved_by: 'couple' })
    expect(w.log.listForWedding(w.ctxA, undefined)).toEqual([])
  })

  it('is tenant-isolated: tenant B never sees tenant A resolutions (no cross-tenant read)', () => {
    const w = makeWorld()
    w.log.resolve(w.ctxA, { escalation_id: 'e1', wedding_id: 'wed_1', status: 'resolved', resolved_by: 'couple' })
    expect(w.log.list(w.ctxB)).toEqual([])
    expect(w.log.listForWedding(w.ctxB, 'wed_1')).toEqual([])
  })

  it('fails closed on a suspended tenant: every op runs the inherited liveness guard', () => {
    const w = makeWorld()
    w.log.resolve(w.ctxA, { escalation_id: 'e1', wedding_id: 'wed_1', status: 'resolved', resolved_by: 'couple' })
    w.store.setLifecycleStatus(w.ctxA.tenant_id, 'suspended')
    const input = { escalation_id: 'e2', wedding_id: 'wed_1', status: 'resolved', resolved_by: 'couple' } as const
    expect(codeOfThrow(() => w.log.resolve(w.ctxA, input))).toMatch(/TENANT/)
    expect(codeOfThrow(() => w.log.list(w.ctxA))).toMatch(/TENANT/)
    expect(codeOfThrow(() => w.log.listForWedding(w.ctxA, 'wed_1'))).toMatch(/TENANT/)
  })
})
