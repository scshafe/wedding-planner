import { ManualClock, SequentialIdGenerator, type Tenant, type Wedding } from '@wedding-planner/shared'
import { describe, expect, it } from 'vitest'

import {
  type TenantContext,
  TenantContextResolver,
  TenantStore,
  WeddingRepository,
} from '@wedding-planner/product'

/**
 * THE KEYSTONE — the load-bearing tenant-isolation regression (Phase 12).
 *
 * A TenantContext for tenant A can NEVER read, list, or write tenant B's data. This is the
 * multi-tenancy analogue of the trusted-evidence firewall (wall the channel, fail closed, no
 * existence oracle). Phases 13–16 are built on this boundary and may not weaken it. Each `it`
 * pins one of the nine boundary invariants against the attack a real caller would attempt.
 *
 * Scope: this proves INTER-tenant isolation only. Intra-tenant authorization (planner vs couple)
 * lands with principals in Phase 13 and is not covered here.
 */

const THEME: Tenant['theme'] = {
  brand_name: 'Brand',
  primary_color_hex: '#111111',
  accent_color_hex: '#222222',
  logo_ref: 'asset_1',
}

interface World {
  store: TenantStore
  resolver: TenantContextResolver
  weddings: WeddingRepository
  ctxA: TenantContext
  ctxB: TenantContext
  tenantA: Tenant
  tenantB: Tenant
}

function makeWorld(): World {
  const store = new TenantStore(
    new ManualClock('2027-03-01T00:00:00.000Z'),
    new SequentialIdGenerator('seedT'),
  )
  const tenantA = store.create({ slug: 'alpha', display_name: 'Alpha', theme: THEME, plan_tier: 'solo', lifecycle_status: 'active' })
  const tenantB = store.create({ slug: 'beta', display_name: 'Beta', theme: THEME, plan_tier: 'solo', lifecycle_status: 'active' })
  const resolver = new TenantContextResolver(store)
  // A SINGLE wedding repository serves all tenants — isolation is the partition, not separate stores.
  const weddings = new WeddingRepository(
    store,
    new ManualClock('2027-04-01T00:00:00.000Z'),
    new SequentialIdGenerator('seedW'),
  )
  return {
    store,
    resolver,
    weddings,
    ctxA: resolver.resolveBySlug('alpha'),
    ctxB: resolver.resolveBySlug('beta'),
    tenantA,
    tenantB,
  }
}

function codeOfThrow(fn: () => unknown): string {
  try {
    fn()
  } catch (error) {
    return (error as { code?: string }).code ?? `NON_CODED:${String(error)}`
  }
  throw new Error('expected the operation to throw, but it did not')
}

describe('tenant isolation keystone', () => {
  it('(a) no existence oracle: a foreign-tenant id reads back identically to a never-existed id', () => {
    const w = makeWorld()
    const bWedding = w.weddings.create(w.ctxB, { couple_display_name: 'B couple', event_date: '2028-02-02' })

    // Reading B's real wedding_id under A's context.
    const foreign = w.weddings.get(w.ctxA, bWedding.wedding_id)
    // Reading an id that exists in NO partition under A's context.
    const missing = w.weddings.get(w.ctxA, 'wedding_does_not_exist')

    // Byte-identical outcome: both undefined, no throw, no distinguishing value. A caller cannot
    // tell "exists but not yours" from "doesn't exist".
    expect(foreign).toBeUndefined()
    expect(missing).toBeUndefined()
    expect(foreign).toBe(missing)
  })

  it('(b) list under A returns only A’s records, never B’s', () => {
    const w = makeWorld()
    const a1 = w.weddings.create(w.ctxA, { couple_display_name: 'A1', event_date: '2028-01-01' })
    const a2 = w.weddings.create(w.ctxA, { couple_display_name: 'A2', event_date: '2028-01-02' })
    w.weddings.create(w.ctxB, { couple_display_name: 'B1', event_date: '2028-03-03' })

    const aList = w.weddings.list(w.ctxA)
    expect(aList.map((wd) => wd.wedding_id).sort()).toEqual([a1.wedding_id, a2.wedding_id].sort())
    expect(aList.every((wd) => wd.tenant_id === w.tenantA.tenant_id)).toBe(true)
    expect(w.weddings.list(w.ctxB)).toHaveLength(1)
  })

  it('(c) a write/update under A cannot mutate B’s wedding (cross-tenant write veto, both paths)', () => {
    const w = makeWorld()
    const bWedding = w.weddings.create(w.ctxB, { couple_display_name: 'B couple', event_date: '2028-02-02' })

    // Update path: hand B's record (tenant_id=B) to an A-scoped update — the partition is selected by
    // the context, the payload tenant_id is compare-only and vetoes the mismatch.
    expect(codeOfThrow(() => w.weddings.update(w.ctxA, { ...bWedding, status: 'cancelled' }))).toBe(
      'PRODUCT.CROSS_TENANT_WRITE',
    )
    // B's record is untouched and still invisible to A.
    expect(w.weddings.get(w.ctxB, bWedding.wedding_id)?.status).toBe('planning')
    expect(w.weddings.get(w.ctxA, bWedding.wedding_id)).toBeUndefined()
  })

  it('(d)(i) a forged/cast TenantContext is rejected at the repository entry (bypass-the-resolver attack)', () => {
    const w = makeWorld()
    // The attack the brand defends: a hand-built object straight to the repo, never through the resolver.
    const forged = { tenant_id: w.tenantA.tenant_id, slug: 'alpha' } as unknown as TenantContext
    expect(codeOfThrow(() => w.weddings.get(forged, 'whatever'))).toBe('PRODUCT.FORGED_CONTEXT')
    expect(codeOfThrow(() => w.weddings.list(forged))).toBe('PRODUCT.FORGED_CONTEXT')
    expect(
      codeOfThrow(() => w.weddings.create(forged, { couple_display_name: 'x', event_date: '2028-01-01' })),
    ).toBe('PRODUCT.FORGED_CONTEXT')
  })

  it('(d)(iv) the brand cannot be lifted off a real context and re-stamped onto a forged one', () => {
    const w = makeWorld()
    w.weddings.create(w.ctxB, { couple_display_name: 'B couple', event_date: '2028-02-02' })

    // The attack the WeakSet token defends: copy every reflectable own symbol/prop from a legitimate
    // context onto a hand-built object scoped to ANOTHER tenant, then use it. A real context carries
    // NO own symbols (the brand is type-only + a WeakSet membership), so there is nothing to lift.
    const restamped: Record<string | symbol, unknown> = {
      tenant_id: w.tenantB.tenant_id,
      slug: 'beta',
    }
    for (const sym of Object.getOwnPropertySymbols(w.ctxA)) {
      restamped[sym] = (w.ctxA as unknown as Record<symbol, unknown>)[sym]
    }
    // No own symbols exist to copy — witness that the brand is unreflectable.
    expect(Object.getOwnPropertySymbols(w.ctxA)).toHaveLength(0)
    expect(codeOfThrow(() => w.weddings.list(restamped as unknown as TenantContext))).toBe(
      'PRODUCT.FORGED_CONTEXT',
    )
  })

  it('(d)(ii) a minted context is frozen — its tenant_id cannot be mutated', () => {
    const w = makeWorld()
    expect(Object.isFrozen(w.ctxA)).toBe(true)
    try {
      ;(w.ctxA as unknown as { tenant_id: string }).tenant_id = w.tenantB.tenant_id
    } catch {
      // strict-mode assignment to a frozen prop throws; either way the value must not change.
    }
    expect(w.ctxA.tenant_id).toBe(w.tenantA.tenant_id)
  })

  it('(d)(iii) resolveBySlug rejects an unregistered slug', () => {
    const w = makeWorld()
    expect(codeOfThrow(() => w.resolver.resolveBySlug('ghost'))).toBe('PRODUCT.UNKNOWN_TENANT')
  })

  it('(e) liveness at use: a context held past a suspension fails closed', () => {
    const w = makeWorld()
    const a1 = w.weddings.create(w.ctxA, { couple_display_name: 'A1', event_date: '2028-01-01' })
    // A was active when ctxA was minted; now suspend A out from under the live context.
    w.store.setLifecycleStatus(w.tenantA.tenant_id, 'suspended')
    expect(codeOfThrow(() => w.weddings.get(w.ctxA, a1.wedding_id))).toBe('PRODUCT.TENANT_NOT_USABLE')
    expect(codeOfThrow(() => w.weddings.list(w.ctxA))).toBe('PRODUCT.TENANT_NOT_USABLE')
    expect(
      codeOfThrow(() => w.weddings.create(w.ctxA, { couple_display_name: 'x', event_date: '2028-01-01' })),
    ).toBe('PRODUCT.TENANT_NOT_USABLE')
  })

  it('(e2) an onboarding tenant cannot mint a usable context', () => {
    const store = new TenantStore(new ManualClock('2027-03-01T00:00:00.000Z'), new SequentialIdGenerator('s'))
    store.create({ slug: 'fresh', display_name: 'Fresh', theme: THEME, plan_tier: 'solo' }) // defaults to onboarding
    const resolver = new TenantContextResolver(store)
    expect(codeOfThrow(() => resolver.resolveBySlug('fresh'))).toBe('PRODUCT.TENANT_NOT_USABLE')
  })

  it('(f) two tenants cannot share a slug, including a case variant', () => {
    const w = makeWorld()
    expect(
      codeOfThrow(() => w.store.create({ slug: 'ALPHA', display_name: 'Dup', theme: THEME, plan_tier: 'solo' })),
    ).toBe('PRODUCT.DUPLICATE_SLUG')
  })

  it('(g) deliberate wedding_id collision across tenants resolves to the right record under each context', () => {
    const w = makeWorld()
    const collidingId = 'wedding_collision'
    const base = { wedding_id: collidingId, event_date: '2028-05-05', status: 'planning', created_at: '2027-04-01T00:00:00.000Z' } as const
    const aRecord: Wedding = { ...base, tenant_id: w.tenantA.tenant_id, couple_display_name: 'A-collide' }
    const bRecord: Wedding = { ...base, tenant_id: w.tenantB.tenant_id, couple_display_name: 'B-collide' }

    w.weddings.update(w.ctxA, aRecord)
    w.weddings.update(w.ctxB, bRecord)

    // Same id, two partitions — each context sees only its own. The lookup key is (tenant_id, id).
    expect(w.weddings.get(w.ctxA, collidingId)?.couple_display_name).toBe('A-collide')
    expect(w.weddings.get(w.ctxB, collidingId)?.couple_display_name).toBe('B-collide')
  })

  it('(h) serialization leaks no tenant data (private backing maps)', () => {
    const w = makeWorld()
    w.weddings.create(w.ctxA, { couple_display_name: 'SECRET_COUPLE_NAME', event_date: '2028-01-01' })

    const dumpRepo = JSON.stringify(w.weddings)
    const dumpStore = JSON.stringify(w.store)
    const dumpSpread = JSON.stringify({ ...w.weddings })

    for (const dump of [dumpRepo, dumpStore, dumpSpread]) {
      expect(dump).not.toContain('SECRET_COUPLE_NAME')
      expect(dump).not.toContain(w.tenantA.tenant_id)
    }

    // Witness #-privateness directly (a Map serializes to {} even as a plain `private` field, so the
    // string checks above would pass even after a downgrade). The backing partition map must NOT be a
    // reflectable own property of the scoped repository — if someone downgraded `#partitions` to TS
    // `private partitions`, it would appear here and this assertion would fail.
    const scoped = (w.weddings as unknown as { repository: object }).repository
    expect(Object.getOwnPropertyNames(scoped)).not.toContain('partitions')
    expect(Object.getOwnPropertyNames(w.store)).not.toContain('byId')
  })
})
