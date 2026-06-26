import { ManualClock, SequentialIdGenerator, type Tenant } from '@wedding-planner/shared'
import { describe, expect, it } from 'vitest'

import {
  TenantContextResolver,
  TenantStore,
  WeddingRepository,
  normalizeSlug,
} from '@wedding-planner/product'

const THEME: Tenant['theme'] = {
  brand_name: 'Evergreen Weddings',
  primary_color_hex: '#1a2b3c',
  accent_color_hex: '#ffccaa',
  logo_ref: 'asset_logo_1',
}

function newStore(): { store: TenantStore; clock: ManualClock; ids: SequentialIdGenerator } {
  const clock = new ManualClock('2027-03-01T00:00:00.000Z')
  const ids = new SequentialIdGenerator('seedT')
  return { store: new TenantStore(clock, ids), clock, ids }
}

function activeTenant(store: TenantStore, slug: string): Tenant {
  const tenant = store.create({
    slug,
    display_name: `${slug} planners`,
    theme: THEME,
    plan_tier: 'studio',
    lifecycle_status: 'active',
  })
  return tenant
}

describe('TenantStore', () => {
  it('creates a tenant with injected id + created_at and the normalized slug', () => {
    const { store } = newStore()
    const tenant = store.create({
      slug: 'Evergreen',
      display_name: 'Evergreen Co',
      theme: THEME,
      plan_tier: 'solo',
    })
    expect(tenant.tenant_id).toBe('tenant_seedT_1')
    expect(tenant.created_at).toBe('2027-03-01T00:00:00.000Z')
    expect(tenant.slug).toBe('evergreen')
    // A freshly-created tenant defaults to onboarding (not yet usable).
    expect(tenant.lifecycle_status).toBe('onboarding')
    expect(store.isUsable(tenant.tenant_id)).toBe(false)
  })

  it('finds a tenant by slug case-insensitively', () => {
    const { store } = newStore()
    const tenant = activeTenant(store, 'acme')
    expect(store.findBySlug('ACME')?.tenant_id).toBe(tenant.tenant_id)
    expect(store.findBySlug('acme')?.tenant_id).toBe(tenant.tenant_id)
    expect(store.findBySlug('missing')).toBeUndefined()
  })

  it('isUsable tracks lifecycle transitions', () => {
    const { store } = newStore()
    const tenant = activeTenant(store, 'acme')
    expect(store.isUsable(tenant.tenant_id)).toBe(true)
    store.setLifecycleStatus(tenant.tenant_id, 'suspended')
    expect(store.isUsable(tenant.tenant_id)).toBe(false)
  })

  it('resolveSlug returns routing-only data (no wedding/private payload)', () => {
    const { store } = newStore()
    const tenant = activeTenant(store, 'acme')
    const routing = store.resolveSlug('acme')
    expect(routing).toEqual({ tenant_id: tenant.tenant_id, slug: 'acme', theme: THEME })
  })
})

describe('TenantContextResolver', () => {
  it('mints a frozen, branded context for an active tenant', () => {
    const { store } = newStore()
    activeTenant(store, 'acme')
    const resolver = new TenantContextResolver(store)
    const context = resolver.resolveBySlug('acme')
    expect(context.slug).toBe('acme')
    expect(Object.isFrozen(context)).toBe(true)
  })
})

describe('WeddingRepository (happy path)', () => {
  it('creates and reads a wedding within the tenant scope', () => {
    const { store } = newStore()
    const tenant = activeTenant(store, 'acme')
    const resolver = new TenantContextResolver(store)
    const context = resolver.resolveBySlug('acme')

    const clock = new ManualClock('2027-04-01T00:00:00.000Z')
    const ids = new SequentialIdGenerator('seedW')
    const weddings = new WeddingRepository(store, clock, ids)

    const created = weddings.create(context, {
      couple_display_name: 'Alex & Sam',
      event_date: '2028-06-15',
    })
    expect(created.wedding_id).toBe('wedding_seedW_1')
    expect(created.tenant_id).toBe(tenant.tenant_id)
    expect(created.status).toBe('planning')

    expect(weddings.get(context, created.wedding_id)).toEqual(created)
    expect(weddings.list(context)).toEqual([created])
  })

  it('updates a wedding it owns', () => {
    const { store } = newStore()
    activeTenant(store, 'acme')
    const resolver = new TenantContextResolver(store)
    const context = resolver.resolveBySlug('acme')
    const weddings = new WeddingRepository(
      store,
      new ManualClock('2027-04-01T00:00:00.000Z'),
      new SequentialIdGenerator('seedW'),
    )
    const created = weddings.create(context, { couple_display_name: 'A & B', event_date: '2028-01-01' })
    const updated = weddings.update(context, { ...created, status: 'active' })
    expect(updated.status).toBe('active')
    expect(weddings.get(context, created.wedding_id)?.status).toBe('active')
  })
})

describe('normalizeSlug', () => {
  it('lowercases', () => {
    expect(normalizeSlug('AcMe')).toBe('acme')
  })
})
