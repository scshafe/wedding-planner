import { ManualClock, SequentialIdGenerator, type Tenant } from '@wedding-planner/shared'
import { describe, expect, it } from 'vitest'

import {
  InMemoryRecordStore,
  type RecordStore,
  type TenantContext,
  TenantContextResolver,
  TenantScopedRepository,
  TenantStore,
} from '@wedding-planner/product'

import { collection, groupedKey } from '../../src/persistence/record_store'
import { SqliteRecordStore } from '../../src/persistence/sqlite_record_store'

/**
 * `TenantScopedRepository.listGroup` (ADR 0039 addendum): reading one group of a tenant's records keeps every
 * guard `list` has — the partition is the minted context's tenant, a forged context is refused, a suspended tenant
 * fails closed — on both adapters.
 */

interface Item {
  readonly tenant_id: string
  readonly group_id: string
  readonly item_id: string
}

const ITEMS = collection<Item>('scoped_item', 'tenant')
const THEME: Tenant['theme'] = { brand_name: 'B', primary_color_hex: '#111111', accent_color_hex: '#222222', logo_ref: 'l' }

const ADAPTERS: readonly (readonly [string, () => RecordStore])[] = [
  ['in-memory', () => new InMemoryRecordStore()],
  ['sqlite', () => SqliteRecordStore.open({ path: ':memory:', clock: new ManualClock('2027-01-01T00:00:00.000Z') })],
]

function world(makeStore: () => RecordStore) {
  const backing = makeStore()
  const tenants = new TenantStore(new ManualClock('2027-03-01T00:00:00.000Z'), new SequentialIdGenerator('t'), backing)
  const a = tenants.create({ slug: 'alpha', display_name: 'Alpha', theme: THEME, plan_tier: 'solo', lifecycle_status: 'active' })
  const b = tenants.create({ slug: 'beta', display_name: 'Beta', theme: THEME, plan_tier: 'solo', lifecycle_status: 'active' })
  const resolver = new TenantContextResolver(tenants)
  const repo = new TenantScopedRepository<Item>(tenants, (i) => groupedKey(i.group_id, i.item_id), ITEMS, backing)
  return { tenants, repo, a, b, ctxA: resolver.resolveBySlug('alpha'), ctxB: resolver.resolveBySlug('beta') }
}

function codeOfThrow(fn: () => unknown): string {
  try {
    fn()
  } catch (error) {
    return (error as { code?: string }).code ?? `NON_CODED:${String(error)}`
  }
  throw new Error('expected the operation to throw, but it did not')
}

describe.each(ADAPTERS)('TenantScopedRepository.listGroup (%s store)', (_adapter, makeStore) => {
  it('returns only this tenant’s records of the group, even when another tenant uses the same keys', () => {
    const w = world(makeStore)
    w.repo.put(w.ctxA, { tenant_id: w.a.tenant_id, group_id: 'g1', item_id: 'x' })
    w.repo.put(w.ctxA, { tenant_id: w.a.tenant_id, group_id: 'g2', item_id: 'y' })
    w.repo.put(w.ctxB, { tenant_id: w.b.tenant_id, group_id: 'g1', item_id: 'x' })
    expect(w.repo.listGroup(w.ctxA, 'g1')).toEqual([{ tenant_id: w.a.tenant_id, group_id: 'g1', item_id: 'x' }])
    expect(w.repo.listGroup(w.ctxB, 'g1')).toEqual([{ tenant_id: w.b.tenant_id, group_id: 'g1', item_id: 'x' }])
    expect(w.repo.listGroup(w.ctxB, 'g2')).toEqual([])
  })

  it('refuses a forged context and fails closed for a suspended tenant', () => {
    const w = world(makeStore)
    const forged = { tenant_id: w.a.tenant_id, slug: 'alpha' } as unknown as TenantContext
    expect(codeOfThrow(() => w.repo.listGroup(forged, 'g1'))).toBe('PRODUCT.FORGED_CONTEXT')
    w.tenants.setLifecycleStatus(w.a.tenant_id, 'suspended')
    expect(codeOfThrow(() => w.repo.listGroup(w.ctxA, 'g1'))).toBe('PRODUCT.TENANT_NOT_USABLE')
  })
})
