import { ManualClock, SequentialIdGenerator, type Tenant } from '@wedding-planner/shared'
import { describe, expect, it } from 'vitest'

import {
  type GuestBinding,
  GuestRegistry,
  type TenantContext,
  TenantContextResolver,
  TenantStore,
} from '@wedding-planner/product'

/**
 * Phase 19 Step 3 — the guest registry is the segmentation gate. It inherits tenant isolation from the
 * TenantScopedRepository: per-tenant partition keyed by the minted context, the lookup key is the opaque
 * from_ref ALONE, an unknown/foreign ref returns the byte-identical undefined (no oracle), and a binding can
 * never be planted or read across tenants.
 */

const THEME: Tenant['theme'] = {
  brand_name: 'Brand',
  primary_color_hex: '#111111',
  accent_color_hex: '#222222',
  logo_ref: 'asset_1',
}

interface World {
  registry: GuestRegistry
  ctxA: TenantContext
  ctxB: TenantContext
}

function makeWorld(): World {
  const store = new TenantStore(new ManualClock('2027-03-01T00:00:00.000Z'), new SequentialIdGenerator('seedT'))
  store.create({ slug: 'alpha', display_name: 'Alpha', theme: THEME, plan_tier: 'solo', lifecycle_status: 'active' })
  store.create({ slug: 'beta', display_name: 'Beta', theme: THEME, plan_tier: 'solo', lifecycle_status: 'active' })
  const resolver = new TenantContextResolver(store)
  return {
    registry: new GuestRegistry(store),
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

describe('GuestRegistry', () => {
  it('registers a binding and resolves it by the from_ref alone', () => {
    const w = makeWorld()
    w.registry.register(w.ctxA, { recipient_ref: 'sms:+1555', wedding_id: 'wed_1', guest_id: 'guest_1' })
    const found = w.registry.lookup(w.ctxA, 'sms:+1555')
    expect(found).toMatchObject({ wedding_id: 'wed_1', guest_id: 'guest_1', recipient_ref: 'sms:+1555' })
  })

  it('returns undefined for an unregistered ref (the byte-identical no-oracle path)', () => {
    const w = makeWorld()
    expect(w.registry.lookup(w.ctxA, 'sms:+1999')).toBeUndefined()
  })

  it('is per-tenant: tenant B cannot see a binding registered under tenant A (segmentation)', () => {
    const w = makeWorld()
    w.registry.register(w.ctxA, { recipient_ref: 'sms:+1555', wedding_id: 'wed_1', guest_id: 'guest_1' })
    // The SAME from_ref on B's partition resolves to nothing — no cross-tenant bleed.
    expect(w.registry.lookup(w.ctxB, 'sms:+1555')).toBeUndefined()
  })

  it('two tenants may bind the same from_ref to different weddings with zero collision', () => {
    const w = makeWorld()
    w.registry.register(w.ctxA, { recipient_ref: 'sms:+1555', wedding_id: 'wed_A', guest_id: 'g_A' })
    w.registry.register(w.ctxB, { recipient_ref: 'sms:+1555', wedding_id: 'wed_B', guest_id: 'g_B' })
    expect(w.registry.lookup(w.ctxA, 'sms:+1555')?.wedding_id).toBe('wed_A')
    expect(w.registry.lookup(w.ctxB, 'sms:+1555')?.wedding_id).toBe('wed_B')
  })

  it('rejects a forged (un-minted) context at lookup AND register (inherited brand gate)', () => {
    const w = makeWorld()
    const forged = { tenant_id: 'alpha', lifecycle_status: 'active' } as unknown as TenantContext
    expect(codeOfThrow(() => w.registry.lookup(forged, 'sms:+1555'))).toBe('PRODUCT.FORGED_CONTEXT')
    expect(
      codeOfThrow(() => w.registry.register(forged, { recipient_ref: 'x', wedding_id: 'w', guest_id: 'g' })),
    ).toBe('PRODUCT.FORGED_CONTEXT')
  })

  it('does not enumerate/serialize its bindings (the backing partition is #-private)', () => {
    const w = makeWorld()
    w.registry.register(w.ctxA, { recipient_ref: 'sms:+1555', wedding_id: 'wed_1', guest_id: 'guest_1' })
    expect(JSON.stringify(w.registry)).not.toContain('sms:+1555')
  })

  it('rejects a duplicate ref (no silent rebind) and preserves the original binding', () => {
    const w = makeWorld()
    w.registry.register(w.ctxA, { recipient_ref: 'sms:+1555', wedding_id: 'wed_1', guest_id: 'g_1' })
    expect(
      codeOfThrow(() =>
        w.registry.register(w.ctxA, { recipient_ref: 'sms:+1555', wedding_id: 'wed_2', guest_id: 'g_2' }),
      ),
    ).toBe('PRODUCT.GUEST_ALREADY_REGISTERED')
    // The first binding is untouched — a duplicate is a no-op, never a rebind.
    const found = w.registry.lookup(w.ctxA, 'sms:+1555') as GuestBinding
    expect(found.wedding_id).toBe('wed_1')
  })

  it('lists only the context tenant partition, and remove is idempotent + tenant-scoped', () => {
    const w = makeWorld()
    w.registry.register(w.ctxA, { recipient_ref: 'sms:+1555', wedding_id: 'wed_1', guest_id: 'g_1' })
    w.registry.register(w.ctxA, { recipient_ref: 'sms:+1666', wedding_id: 'wed_1', guest_id: 'g_2' })
    w.registry.register(w.ctxB, { recipient_ref: 'sms:+1777', wedding_id: 'wed_9', guest_id: 'g_9' })

    // list is tenant-scoped: A sees its two, never B's.
    expect(w.registry.list(w.ctxA).map((g) => g.recipient_ref).sort()).toEqual(['sms:+1555', 'sms:+1666'])
    expect(w.registry.list(w.ctxB).map((g) => g.recipient_ref)).toEqual(['sms:+1777'])

    // remove returns true when present, false (idempotent no-op) when absent.
    expect(w.registry.remove(w.ctxA, 'sms:+1555')).toBe(true)
    expect(w.registry.remove(w.ctxA, 'sms:+1555')).toBe(false)
    expect(w.registry.lookup(w.ctxA, 'sms:+1555')).toBeUndefined()

    // A cannot remove B's binding (foreign ref → false no-op; B's binding intact).
    expect(w.registry.remove(w.ctxA, 'sms:+1777')).toBe(false)
    expect(w.registry.lookup(w.ctxB, 'sms:+1777')).toBeDefined()
  })

  it('listForWedding filters the tenant partition to one wedding (undefined → [])', () => {
    const w = makeWorld()
    w.registry.register(w.ctxA, { recipient_ref: 'sms:+mine', wedding_id: 'wed_mine', guest_id: 'gm' })
    w.registry.register(w.ctxA, { recipient_ref: 'sms:+sib', wedding_id: 'wed_sib', guest_id: 'gs' })
    expect(w.registry.listForWedding(w.ctxA, 'wed_mine').map((g) => g.recipient_ref)).toEqual(['sms:+mine'])
    expect(w.registry.listForWedding(w.ctxA, 'wed_unknown')).toEqual([])
    expect(w.registry.listForWedding(w.ctxA, undefined)).toEqual([])
  })

  it('removeForWedding deletes ONLY on a wedding_id match; every miss is false (sibling untouched)', () => {
    const w = makeWorld()
    w.registry.register(w.ctxA, { recipient_ref: 'sms:+mine', wedding_id: 'wed_mine', guest_id: 'gm' })
    w.registry.register(w.ctxA, { recipient_ref: 'sms:+sib', wedding_id: 'wed_sib', guest_id: 'gs' })
    // A sibling-wedding ref, an absent ref, and an undefined wedding_id all no-op false.
    expect(w.registry.removeForWedding(w.ctxA, 'sms:+sib', 'wed_mine')).toBe(false)
    expect(w.registry.removeForWedding(w.ctxA, 'sms:+absent', 'wed_mine')).toBe(false)
    expect(w.registry.removeForWedding(w.ctxA, 'sms:+mine', undefined)).toBe(false)
    // The sibling binding is untouched by the failed scoped remove.
    expect(w.registry.lookup(w.ctxA, 'sms:+sib')).toBeDefined()
    // A wedding_id match deletes.
    expect(w.registry.removeForWedding(w.ctxA, 'sms:+mine', 'wed_mine')).toBe(true)
    expect(w.registry.lookup(w.ctxA, 'sms:+mine')).toBeUndefined()
  })

  it('removeForWedding runs the liveness guard on every path (suspended tenant throws even on a miss)', () => {
    const store = new TenantStore(new ManualClock('2027-03-01T00:00:00.000Z'), new SequentialIdGenerator('seedT'))
    const tenant = store.create({ slug: 'gamma', display_name: 'Gamma', theme: THEME, plan_tier: 'solo', lifecycle_status: 'active' })
    const resolver = new TenantContextResolver(store)
    const registry = new GuestRegistry(store)
    const ctx = resolver.resolveBySlug('gamma')
    store.setLifecycleStatus(tenant.tenant_id, 'suspended')
    // A MISS on a suspended tenant still throws the liveness error (the read runs the guard on every path) —
    // so a suspended couple can't distinguish a miss from a hit by error vs silent-false.
    expect(codeOfThrow(() => registry.removeForWedding(ctx, 'sms:+absent', 'wed_mine'))).toBe('PRODUCT.TENANT_NOT_USABLE')
  })
})
