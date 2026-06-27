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

  it('overwrites a re-registered ref (last binding wins) rather than duplicating', () => {
    const w = makeWorld()
    w.registry.register(w.ctxA, { recipient_ref: 'sms:+1555', wedding_id: 'wed_1', guest_id: 'g_1' })
    w.registry.register(w.ctxA, { recipient_ref: 'sms:+1555', wedding_id: 'wed_2', guest_id: 'g_2' })
    const found = w.registry.lookup(w.ctxA, 'sms:+1555') as GuestBinding
    expect(found.wedding_id).toBe('wed_2')
  })
})
