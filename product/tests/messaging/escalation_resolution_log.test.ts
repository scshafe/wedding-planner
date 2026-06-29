import { ManualClock, SequentialIdGenerator, type Tenant } from '@wedding-planner/shared'
import { describe, expect, it } from 'vitest'

import {
  EscalationResolutionLog,
  type TenantContext,
  TenantContextResolver,
  TenantStore,
} from '@wedding-planner/product'

/**
 * Phase 27 + Phase 36 — the escalation status-TRANSITION log records the sequence of resolved/dismissed/reopened
 * transitions over a guest escalation WITHOUT mutating the immutable escalation (ADR 0026 F6 / ADR 0027 / ADR
 * 0036). It inherits tenant isolation from the TenantScopedRepository, keys by `${escalation_id}:${seq}`
 * (server-allocated `seq = max+1`), stamps resolved_at from the injected clock, and folds the rows to an
 * EFFECTIVE status (highest-`seq`; `reopened` → open). The directional rule (`resolve`/`dismiss` from open;
 * `reopen` from handled) makes every double-submit an idempotent no-op without a client seq or nonce.
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
  it('transitions an OPEN escalation: mints an id, stamps tenant_id + resolved_at + seq:0, validates, persists', () => {
    const w = makeWorld()
    const rec = w.log.transition(w.ctxA, {
      escalation_id: 'escalation_1',
      wedding_id: 'wed_1',
      status: 'resolved',
      by: 'couple',
    })
    expect(rec).toMatchObject({
      tenant_id: w.ctxA.tenant_id,
      escalation_id: 'escalation_1',
      wedding_id: 'wed_1',
      seq: 0,
      status: 'resolved',
      resolved_by: 'couple',
    })
    expect(rec!.resolution_id).toMatch(/^resolution/)
    // resolved_at is the REAL clock-stamped value — validates with no 500.
    expect(rec!.resolved_at).toBe('2027-03-01T00:00:00.000Z')
    expect(w.log.effectiveStatus(w.ctxA, 'escalation_1')).toBe('resolved')
    expect(w.log.list(w.ctxA)).toHaveLength(1)
  })

  it('effectiveStatus of a never-handled escalation is open (no rows fold to open)', () => {
    const w = makeWorld()
    expect(w.log.effectiveStatus(w.ctxA, 'never')).toBe('open')
    expect(w.log.effectiveTransition(w.ctxA, 'never')).toBeUndefined()
  })

  it('directional no-op preserves first-writer-wins: resolve→dismiss does nothing (status stays resolved, one row)', () => {
    const w = makeWorld()
    const first = w.log.transition(w.ctxA, { escalation_id: 'e', wedding_id: 'wed_1', status: 'resolved', by: 'couple' })
    w.clock.advance(60_000)
    // dismiss of an already-HANDLED (effective resolved) escalation is out-of-direction → no-op (returns undefined).
    const second = w.log.transition(w.ctxA, { escalation_id: 'e', wedding_id: 'wed_1', status: 'dismissed', by: 'planner' })
    expect(second).toBeUndefined()
    expect(w.log.effectiveStatus(w.ctxA, 'e')).toBe('resolved')
    expect(w.log.effectiveTransition(w.ctxA, 'e')).toEqual(first)
    expect(w.log.list(w.ctxA)).toHaveLength(1)
  })

  it('double-submit of the same transition is an idempotent no-op (one row, no duplicate)', () => {
    const w = makeWorld()
    w.log.transition(w.ctxA, { escalation_id: 'e', wedding_id: 'wed_1', status: 'resolved', by: 'couple' })
    expect(w.log.transition(w.ctxA, { escalation_id: 'e', wedding_id: 'wed_1', status: 'resolved', by: 'couple' })).toBeUndefined()
    expect(w.log.list(w.ctxA)).toHaveLength(1)
  })

  it('cycles resolved→reopened→resolved: effective status follows the highest-seq row; rows accrete', () => {
    const w = makeWorld()
    const r0 = w.log.transition(w.ctxA, { escalation_id: 'e', wedding_id: 'wed_1', status: 'resolved', by: 'planner' })
    expect(r0!.seq).toBe(0)
    expect(w.log.effectiveStatus(w.ctxA, 'e')).toBe('resolved')
    // reopen of a HANDLED escalation → effective open; seq allocated above the high-water mark.
    const r1 = w.log.transition(w.ctxA, { escalation_id: 'e', wedding_id: 'wed_1', status: 'reopened', by: 'planner' })
    expect(r1!.seq).toBe(1)
    expect(w.log.effectiveStatus(w.ctxA, 'e')).toBe('open')
    expect(w.log.effectiveTransition(w.ctxA, 'e')!.status).toBe('reopened')
    // a reopen of an already-OPEN escalation is a no-op (out of direction).
    expect(w.log.transition(w.ctxA, { escalation_id: 'e', wedding_id: 'wed_1', status: 'reopened', by: 'planner' })).toBeUndefined()
    // re-resolve from the reopened (open) state → effective resolved again, seq 2.
    const r2 = w.log.transition(w.ctxA, { escalation_id: 'e', wedding_id: 'wed_1', status: 'resolved', by: 'couple' })
    expect(r2!.seq).toBe(2)
    expect(w.log.effectiveStatus(w.ctxA, 'e')).toBe('resolved')
    expect(w.log.list(w.ctxA).filter((row) => row.escalation_id === 'e')).toHaveLength(3)
  })

  it('reopen works from a DISMISSED escalation too (an operator un-dismiss → open)', () => {
    const w = makeWorld()
    w.log.transition(w.ctxA, { escalation_id: 'e', wedding_id: 'wed_1', status: 'dismissed', by: 'planner' })
    expect(w.log.effectiveStatus(w.ctxA, 'e')).toBe('dismissed')
    w.log.transition(w.ctxA, { escalation_id: 'e', wedding_id: 'wed_1', status: 'reopened', by: 'planner' })
    expect(w.log.effectiveStatus(w.ctxA, 'e')).toBe('open')
  })

  it('list returns the whole tenant partition (planner); listForWedding filters to one wedding (couple) — multi-row safe', () => {
    const w = makeWorld()
    // e1 cycles (2 rows), all carrying wed_1; e3 in wed_2. The per-wedding filter must hold on EVERY transition row.
    w.log.transition(w.ctxA, { escalation_id: 'e1', wedding_id: 'wed_1', status: 'resolved', by: 'couple' })
    w.log.transition(w.ctxA, { escalation_id: 'e1', wedding_id: 'wed_1', status: 'reopened', by: 'couple' })
    w.log.transition(w.ctxA, { escalation_id: 'e2', wedding_id: 'wed_1', status: 'dismissed', by: 'planner' })
    w.log.transition(w.ctxA, { escalation_id: 'e3', wedding_id: 'wed_2', status: 'resolved', by: 'planner' })
    expect(w.log.list(w.ctxA)).toHaveLength(4)
    expect(w.log.listForWedding(w.ctxA, 'wed_1').map((r) => r.escalation_id).sort()).toEqual(['e1', 'e1', 'e2'])
    expect(w.log.listForWedding(w.ctxA, 'wed_2').map((r) => r.escalation_id)).toEqual(['e3'])
  })

  it('listForWedding collapses an undefined wedding_id to [] (a couple with no bound wedding)', () => {
    const w = makeWorld()
    w.log.transition(w.ctxA, { escalation_id: 'e1', wedding_id: 'wed_1', status: 'resolved', by: 'couple' })
    expect(w.log.listForWedding(w.ctxA, undefined)).toEqual([])
  })

  it('is tenant-isolated: tenant B never sees tenant A transitions (no cross-tenant read)', () => {
    const w = makeWorld()
    w.log.transition(w.ctxA, { escalation_id: 'e1', wedding_id: 'wed_1', status: 'resolved', by: 'couple' })
    expect(w.log.list(w.ctxB)).toEqual([])
    expect(w.log.listForWedding(w.ctxB, 'wed_1')).toEqual([])
    expect(w.log.effectiveStatus(w.ctxB, 'e1')).toBe('open') // B's fold sees no rows
  })

  it('fails closed on a suspended tenant: every op runs the inherited liveness guard', () => {
    const w = makeWorld()
    w.log.transition(w.ctxA, { escalation_id: 'e1', wedding_id: 'wed_1', status: 'resolved', by: 'couple' })
    w.store.setLifecycleStatus(w.ctxA.tenant_id, 'suspended')
    const input = { escalation_id: 'e2', wedding_id: 'wed_1', status: 'resolved', by: 'couple' } as const
    expect(codeOfThrow(() => w.log.transition(w.ctxA, input))).toMatch(/TENANT/)
    expect(codeOfThrow(() => w.log.effectiveStatus(w.ctxA, 'e1'))).toMatch(/TENANT/)
    expect(codeOfThrow(() => w.log.list(w.ctxA))).toMatch(/TENANT/)
    expect(codeOfThrow(() => w.log.listForWedding(w.ctxA, 'wed_1'))).toMatch(/TENANT/)
  })
})
