import { ManualClock, SequentialIdGenerator, type Tenant } from '@wedding-planner/shared'
import { describe, expect, it } from 'vitest'

import {
  GuestListService,
  InMemoryRecordStore,
  SessionStore,
  TenantContextResolver,
  TenantStore,
  WeddingAuthorizer,
  WeddingRepository,
} from '@wedding-planner/product'

import { COLLECTIONS } from '../../src/persistence/collections'
import { groupedKey } from '../../src/persistence/record_store'

/**
 * Issue #27 — the guest list's own rules, below the HTTP edge: plus-ones (allowance, one each, same household, never
 * their own), cascading removals, the wedding boundary for a couple, validation, and the per-wedding bounds.
 */

const THEME: Tenant['theme'] = { brand_name: 'B', primary_color_hex: '#111111', accent_color_hex: '#222222', logo_ref: 'l' }

function world(limits?: { households: number; guests: number }) {
  const clock = new ManualClock('2027-06-01T00:00:00.000Z')
  const store = new InMemoryRecordStore()
  const tenants = new TenantStore(clock, new SequentialIdGenerator('t'), store)
  tenants.create({ slug: 'alpha', display_name: 'Alpha', theme: THEME, plan_tier: 'solo', lifecycle_status: 'active' })
  const ctx = new TenantContextResolver(tenants).resolveBySlug('alpha')
  const weddings = new WeddingRepository(tenants, clock, new SequentialIdGenerator('w'), store)
  const ours = weddings.create(ctx, { couple_display_name: 'Jo & Lee', event_date: '2028-06-10' }).wedding_id
  const theirs = weddings.create(ctx, { couple_display_name: 'Sam & Kit', event_date: '2028-07-10' }).wedding_id
  const sessions = new SessionStore(new SequentialIdGenerator('s'))
  const planner = sessions.login(ctx, { role: 'planner' }).principal
  const couple = sessions.login(ctx, { role: 'couple', wedding_id: ours }).principal
  const list = new GuestListService(tenants, weddings, new WeddingAuthorizer(), clock, new SequentialIdGenerator('g'), store, limits)
  return { ctx, ours, theirs, planner, couple, list, store }
}

function codeOf(fn: () => unknown): string {
  try {
    fn()
  } catch (error) {
    return (error as { code?: string }).code ?? `NON_CODED:${String(error)}`
  }
  return 'NO_THROW'
}

describe('GuestListService', () => {
  it('keeps households and guests per wedding, with counts', () => {
    const w = world()
    const h = w.list.addHousehold(w.ctx, w.planner, w.ours, { name: ' The Rivera family ', address: '1 Main St' })
    expect(h).toMatchObject({ name: 'The Rivera family', address: '1 Main St', wedding_id: w.ours })
    w.list.addGuest(w.ctx, w.planner, w.ours, { household_id: h.household_id, first_name: 'Ana', side: 'partner_one', tags: [' Family ', 'family'] })
    w.list.addGuest(w.ctx, w.planner, w.ours, { household_id: h.household_id, first_name: 'Luis', last_name: 'Rivera', side: 'both' })
    const view = w.list.view(w.ctx, w.planner, w.ours)
    expect(view.guests.map((g) => g.first_name)).toEqual(['Ana', 'Luis'])
    expect(view.guests[0]?.tags).toEqual(['family'])
    expect(view.counts).toEqual({ guests: 2, households: 1, plus_ones: 0, by_side: { partner_one: 1, partner_two: 0, both: 1 } })
    // The other wedding's list is separate.
    expect(w.list.view(w.ctx, w.planner, w.theirs).counts.guests).toBe(0)
  })

  it('a plus-one needs the allowance, is at most one, joins the host household, and never has their own', () => {
    const w = world()
    const h1 = w.list.addHousehold(w.ctx, w.planner, w.ours, { name: 'One' })
    const h2 = w.list.addHousehold(w.ctx, w.planner, w.ours, { name: 'Two' })
    const host = w.list.addGuest(w.ctx, w.planner, w.ours, { household_id: h1.household_id, first_name: 'Ana', side: 'both', plus_one_allowed: true })
    const plain = w.list.addGuest(w.ctx, w.planner, w.ours, { household_id: h1.household_id, first_name: 'Bo', side: 'both' })
    expect(codeOf(() => w.list.addGuest(w.ctx, w.planner, w.ours, { first_name: 'X', side: 'both', plus_one_of: plain.guest_id }))).toBe('PRODUCT.BAD_REQUEST')
    const plusOne = w.list.addGuest(w.ctx, w.planner, w.ours, {
      household_id: h2.household_id, // ignored: a plus-one joins the host's household
      first_name: 'Guest of Ana',
      side: 'both',
      plus_one_allowed: true, // ignored: a plus-one never has their own
      plus_one_of: host.guest_id,
    })
    expect(plusOne).toMatchObject({ household_id: h1.household_id, plus_one_allowed: false, plus_one_of: host.guest_id })
    expect(codeOf(() => w.list.addGuest(w.ctx, w.planner, w.ours, { first_name: 'Y', side: 'both', plus_one_of: host.guest_id }))).toBe('PRODUCT.PLUS_ONE_EXISTS')
    expect(codeOf(() => w.list.addGuest(w.ctx, w.planner, w.ours, { first_name: 'Z', side: 'both', plus_one_of: plusOne.guest_id }))).toBe('PRODUCT.BAD_REQUEST')
    // Taking the allowance away while the plus-one exists is refused.
    expect(codeOf(() => w.list.updateGuest(w.ctx, w.planner, w.ours, host.guest_id, { first_name: 'Ana', side: 'both', plus_one_allowed: false }))).toBe(
      'PRODUCT.PLUS_ONE_EXISTS',
    )
    expect(w.list.view(w.ctx, w.planner, w.ours).counts.plus_ones).toBe(1)
  })

  it('removing a guest removes their plus-one; removing a household removes its guests', () => {
    const w = world()
    const h = w.list.addHousehold(w.ctx, w.planner, w.ours, { name: 'One' })
    const host = w.list.addGuest(w.ctx, w.planner, w.ours, { household_id: h.household_id, first_name: 'Ana', side: 'both', plus_one_allowed: true })
    w.list.addGuest(w.ctx, w.planner, w.ours, { first_name: 'Guest', side: 'both', plus_one_of: host.guest_id })
    w.list.addGuest(w.ctx, w.planner, w.ours, { household_id: h.household_id, first_name: 'Bo', side: 'both' })
    expect(w.list.removeGuest(w.ctx, w.planner, w.ours, host.guest_id)).toBe(true)
    expect(w.list.view(w.ctx, w.planner, w.ours).guests.map((g) => g.first_name)).toEqual(['Bo'])
    expect(w.list.removeHousehold(w.ctx, w.planner, w.ours, h.household_id)).toBe(true)
    expect(w.list.view(w.ctx, w.planner, w.ours).counts).toMatchObject({ guests: 0, households: 0 })
    expect(w.list.removeGuest(w.ctx, w.planner, w.ours, 'wguest_nope')).toBe(false)
  })

  it('a host who moves household takes their plus-one along; removing either household then leaves no orphan', () => {
    for (const removeFirst of ['old', 'new'] as const) {
      const w = world()
      const h1 = w.list.addHousehold(w.ctx, w.planner, w.ours, { name: 'One' })
      const h2 = w.list.addHousehold(w.ctx, w.planner, w.ours, { name: 'Two' })
      const host = w.list.addGuest(w.ctx, w.planner, w.ours, { household_id: h1.household_id, first_name: 'Host', side: 'both', plus_one_allowed: true })
      const plusOne = w.list.addGuest(w.ctx, w.planner, w.ours, { first_name: 'Plus', side: 'both', plus_one_of: host.guest_id })
      w.list.updateGuest(w.ctx, w.planner, w.ours, host.guest_id, { household_id: h2.household_id, first_name: 'Host', side: 'both', plus_one_allowed: true })
      const moved = w.list.view(w.ctx, w.planner, w.ours).guests
      expect(moved.map((g) => [g.first_name, g.household_id])).toEqual([
        ['Host', h2.household_id],
        ['Plus', h2.household_id],
      ])
      expect(moved.find((g) => g.guest_id === plusOne.guest_id)?.updated_at).toBe('2027-06-01T00:00:00.000Z')
      w.list.removeHousehold(w.ctx, w.planner, w.ours, removeFirst === 'old' ? h1.household_id : h2.household_id)
      const left = w.list.view(w.ctx, w.planner, w.ours)
      expect(left.counts.guests).toBe(removeFirst === 'old' ? 2 : 0)
      // Never a plus-one whose host is gone.
      expect(left.guests.filter((g) => g.plus_one_of !== undefined && !left.guests.some((x) => x.guest_id === g.plus_one_of))).toEqual([])
    }
  })

  it('removing a household also removes a plus-one of its guests recorded in another household (a stale record)', () => {
    const clock = new ManualClock('2027-06-01T00:00:00.000Z')
    const store = new InMemoryRecordStore()
    const tenants = new TenantStore(clock, new SequentialIdGenerator('t'), store)
    tenants.create({ slug: 'alpha', display_name: 'Alpha', theme: THEME, plan_tier: 'solo', lifecycle_status: 'active' })
    const ctx = new TenantContextResolver(tenants).resolveBySlug('alpha')
    const weddings = new WeddingRepository(tenants, clock, new SequentialIdGenerator('w'), store)
    const wedding = weddings.create(ctx, { couple_display_name: 'Jo & Lee', event_date: '2028-06-10' }).wedding_id
    const planner = new SessionStore(new SequentialIdGenerator('s')).login(ctx, { role: 'planner' }).principal
    const list = new GuestListService(tenants, weddings, new WeddingAuthorizer(), clock, new SequentialIdGenerator('g'), store)
    const h1 = list.addHousehold(ctx, planner, wedding, { name: 'One' })
    const h2 = list.addHousehold(ctx, planner, wedding, { name: 'Two' })
    const host = list.addGuest(ctx, planner, wedding, { household_id: h1.household_id, first_name: 'Host', side: 'both', plus_one_allowed: true })
    const plusOne = list.addGuest(ctx, planner, wedding, { first_name: 'Plus', side: 'both', plus_one_of: host.guest_id })
    // A record written before the move-along rule: the plus-one sits in h2 while the host is in h1.
    const stale = { ...plusOne, household_id: h2.household_id }
    store.put(COLLECTIONS.weddingGuest, ctx.tenant_id, groupedKey(wedding, plusOne.guest_id), stale)
    list.removeHousehold(ctx, planner, wedding, h1.household_id)
    expect(list.view(ctx, planner, wedding).guests).toEqual([])
  })

  it('reads one wedding by its key prefix, never the whole tenant partition', () => {
    const w = world()
    const h = w.list.addHousehold(w.ctx, w.planner, w.theirs, { name: 'Theirs' })
    w.list.addGuest(w.ctx, w.planner, w.theirs, { household_id: h.household_id, first_name: 'Kit', side: 'both' })
    const reads: string[] = []
    const store = w.store
    const list = store.list.bind(store)
    const byPrefix = store.listByKeyPrefix.bind(store)
    store.list = (c, p) => (reads.push(`list ${c.name}`), list(c, p))
    store.listByKeyPrefix = (c, p, x) => (reads.push(`prefix ${c.name} ${x}`), byPrefix(c, p, x))
    expect(w.list.view(w.ctx, w.planner, w.ours)).toMatchObject({ households: [], guests: [] })
    expect(reads.filter((r) => r.includes('household') || r.includes('wedding_guest'))).toEqual([
      `prefix household ${w.ours}/`,
      `prefix wedding_guest ${w.ours}/`,
    ])
    expect(w.list.view(w.ctx, w.planner, w.theirs).counts).toMatchObject({ guests: 1, households: 1 })
  })

  it('tells its hook which guests went: a guest with their plus-one, a household with its guests', () => {
    const clock = new ManualClock('2027-06-01T00:00:00.000Z')
    const store = new InMemoryRecordStore()
    const tenants = new TenantStore(clock, new SequentialIdGenerator('t'), store)
    tenants.create({ slug: 'alpha', display_name: 'Alpha', theme: THEME, plan_tier: 'solo', lifecycle_status: 'active' })
    const ctx = new TenantContextResolver(tenants).resolveBySlug('alpha')
    const weddings = new WeddingRepository(tenants, clock, new SequentialIdGenerator('w'), store)
    const wedding = weddings.create(ctx, { couple_display_name: 'Jo & Lee', event_date: '2028-06-10' }).wedding_id
    const planner = new SessionStore(new SequentialIdGenerator('s')).login(ctx, { role: 'planner' }).principal
    const removed: string[][] = []
    const list = new GuestListService(tenants, weddings, new WeddingAuthorizer(), clock, new SequentialIdGenerator('g'), store, undefined, {
      guestsRemoved: (_c, w, ids) => {
        expect(w).toBe(wedding)
        removed.push([...ids])
      },
    })
    const h = list.addHousehold(ctx, planner, wedding, { name: 'One' })
    const host = list.addGuest(ctx, planner, wedding, { household_id: h.household_id, first_name: 'Ana', side: 'both', plus_one_allowed: true })
    const plusOne = list.addGuest(ctx, planner, wedding, { first_name: 'Sam', side: 'both', plus_one_of: host.guest_id })
    const bo = list.addGuest(ctx, planner, wedding, { household_id: h.household_id, first_name: 'Bo', side: 'both' })
    list.removeGuest(ctx, planner, wedding, host.guest_id)
    list.removeHousehold(ctx, planner, wedding, h.household_id)
    expect(removed).toEqual([[host.guest_id, plusOne.guest_id], [bo.guest_id]])
  })

  it('a couple reaches only its own wedding: the other wedding and a missing one are the same NOT_FOUND', () => {
    const w = world()
    const h = w.list.addHousehold(w.ctx, w.couple, w.ours, { name: 'Ours' })
    expect(w.list.view(w.ctx, w.couple, w.ours).households.map((x) => x.household_id)).toEqual([h.household_id])
    expect(codeOf(() => w.list.view(w.ctx, w.couple, w.theirs))).toBe('PRODUCT.NOT_FOUND')
    expect(codeOf(() => w.list.view(w.ctx, w.couple, 'wedding_missing'))).toBe('PRODUCT.NOT_FOUND')
    expect(codeOf(() => w.list.addHousehold(w.ctx, w.couple, w.theirs, { name: 'x' }))).toBe('PRODUCT.NOT_FOUND')
    // An id from a sibling wedding is not found on this one, even for the planner.
    const other = w.list.addHousehold(w.ctx, w.planner, w.theirs, { name: 'Theirs' })
    expect(codeOf(() => w.list.addGuest(w.ctx, w.planner, w.ours, { household_id: other.household_id, first_name: 'A', side: 'both' }))).toBe(
      'PRODUCT.BAD_REQUEST',
    )
    expect(w.list.removeHousehold(w.ctx, w.planner, w.ours, other.household_id)).toBe(false)
  })

  it('validates names, email and tags, and bounds each wedding\'s list', () => {
    const w = world({ households: 1, guests: 1 })
    const h = w.list.addHousehold(w.ctx, w.planner, w.ours, { name: 'One' })
    expect(codeOf(() => w.list.addHousehold(w.ctx, w.planner, w.ours, { name: 'Two' }))).toBe('PRODUCT.LIMIT_REACHED')
    expect(codeOf(() => w.list.addGuest(w.ctx, w.planner, w.ours, { household_id: h.household_id, first_name: '  ', side: 'both' }))).toBe(
      'CONTRACT.VALIDATION_FAILED',
    )
    expect(codeOf(() => w.list.addGuest(w.ctx, w.planner, w.ours, { household_id: h.household_id, first_name: 'A', side: 'both', email: 'nope' }))).toBe(
      'PRODUCT.BAD_REQUEST',
    )
    for (const bad of ['A\nB', 'A\u0000', 'A\u007f']) {
      expect(codeOf(() => w.list.addGuest(w.ctx, w.planner, w.ours, { household_id: h.household_id, first_name: bad, side: 'both' }))).toBe('PRODUCT.BAD_REQUEST')
    }
    expect(codeOf(() => w.list.updateHousehold(w.ctx, w.planner, w.ours, h.household_id, { name: 'One\r\nTwo' }))).toBe('PRODUCT.BAD_REQUEST')
    const tags = Array.from({ length: 21 }, (_, i) => `t${i}`)
    expect(codeOf(() => w.list.addGuest(w.ctx, w.planner, w.ours, { household_id: h.household_id, first_name: 'A', side: 'both', tags }))).toBe(
      'PRODUCT.BAD_REQUEST',
    )
    w.list.addGuest(w.ctx, w.planner, w.ours, { household_id: h.household_id, first_name: 'A', side: 'both' })
    expect(codeOf(() => w.list.addGuest(w.ctx, w.planner, w.ours, { household_id: h.household_id, first_name: 'B', side: 'both' }))).toBe(
      'PRODUCT.LIMIT_REACHED',
    )
  })
})
