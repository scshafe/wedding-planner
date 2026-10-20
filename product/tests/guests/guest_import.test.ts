import { ManualClock, SequentialIdGenerator, type Tenant } from '@wedding-planner/shared'
import { describe, expect, it } from 'vitest'

import {
  GuestListService,
  InMemoryRecordStore,
  SessionStore,
  TenantContextResolver,
  TenantStore,
  toGuestCsv,
  WeddingAuthorizer,
  WeddingRepository,
} from '@wedding-planner/product'

/**
 * Issue #28 — `GuestListService.importGuests`: a preview writes nothing, a plan with a problem writes nothing, a clean
 * commit applies every row (hosts before their plus-ones), and re-importing never duplicates. The wedding boundary
 * is the list's own.
 */

const THEME: Tenant['theme'] = { brand_name: 'B', primary_color_hex: '#111111', accent_color_hex: '#222222', logo_ref: 'l' }
const HEADER = 'household,address,first_name,last_name,side,tags,plus_one_allowed,plus_one_of,dietary,email,phone'

function world() {
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
  const list = new GuestListService(tenants, weddings, new WeddingAuthorizer(), clock, new SequentialIdGenerator('g'), store)
  return { ctx, ours, theirs, planner, couple, list }
}

const FILE = [
  HEADER,
  'The Rivera family,"1 Main St, Springfield",Ana,Rivera,partner_one,family,yes,,,ana@example.test,',
  'The Rivera family,,Sam,,,,,Ana Rivera,,,',
  'The Rivera family,,Luis,Rivera,both,,no,,vegetarian,,',
  'Chen,,Mei,Chen,partner_two,"friends; college",,,,,+1 555 0100',
].join('\r\n')

describe('GuestListService.importGuests', () => {
  it('a preview reports the plan and writes nothing', () => {
    const w = world()
    expect(w.list.importGuests(w.ctx, w.planner, w.ours, FILE, false)).toEqual({ applied: false, problems: [], creates: 4, updates: 0, households_created: 2 })
    expect(w.list.view(w.ctx, w.planner, w.ours).counts.guests).toBe(0)
  })

  it('a commit applies every row: households with their address, a plus-one linked to a host from the same file', () => {
    const w = world()
    expect(w.list.importGuests(w.ctx, w.planner, w.ours, FILE, true)).toMatchObject({ applied: true, creates: 4 })
    const view = w.list.view(w.ctx, w.planner, w.ours)
    expect(view.households.map((h) => [h.name, h.address])).toEqual([
      ['The Rivera family', '1 Main St, Springfield'],
      ['Chen', undefined],
    ])
    const byName = new Map(view.guests.map((g) => [g.first_name, g]))
    expect(byName.get('Sam')).toMatchObject({ plus_one_of: byName.get('Ana')?.guest_id, household_id: byName.get('Ana')?.household_id, plus_one_allowed: false })
    expect(byName.get('Mei')).toMatchObject({ side: 'partner_two', tags: ['friends', 'college'], phone: '+1 555 0100' })
    expect(view.counts).toMatchObject({ guests: 4, households: 2, plus_ones: 1 })
  })

  it('one bad row and nothing is written, even with commit', () => {
    const w = world()
    const result = w.list.importGuests(w.ctx, w.planner, w.ours, `${FILE}\r\nChen,,Kit,,left,,,,,,`, true)
    expect(result).toMatchObject({ applied: false, problems: [{ row: 6, message: 'side must be partner_one, partner_two or both' }] })
    expect(w.list.view(w.ctx, w.planner, w.ours).counts.guests).toBe(0)
  })

  it('re-importing the same file, or the exported list, updates instead of duplicating', () => {
    const w = world()
    w.list.importGuests(w.ctx, w.planner, w.ours, FILE, true)
    expect(w.list.importGuests(w.ctx, w.planner, w.ours, FILE, true)).toMatchObject({ applied: true, creates: 0, updates: 4, households_created: 0 })
    const exported = toGuestCsv(w.list.view(w.ctx, w.planner, w.ours))
    const edited = exported.replace('vegetarian', 'vegan')
    expect(w.list.importGuests(w.ctx, w.planner, w.ours, edited, true)).toMatchObject({ applied: true, creates: 0, updates: 4 })
    const view = w.list.view(w.ctx, w.planner, w.ours)
    expect(view.counts).toMatchObject({ guests: 4, households: 2, plus_ones: 1 })
    expect(view.guests.find((g) => g.first_name === 'Luis')?.dietary).toBe('vegan')
  })

  it('adds a plus-one for a host already on the list, and a new address updates the household', () => {
    const w = world()
    const h = w.list.addHousehold(w.ctx, w.planner, w.ours, { name: 'Rivera' })
    const host = w.list.addGuest(w.ctx, w.planner, w.ours, { household_id: h.household_id, first_name: 'Ana', last_name: 'Rivera', side: 'both', plus_one_allowed: true })
    const result = w.list.importGuests(w.ctx, w.planner, w.ours, [HEADER, 'Rivera,2 Elm St,Sam,,,,,Ana Rivera,,,'].join('\n'), true)
    expect(result).toMatchObject({ applied: true, creates: 1 })
    const view = w.list.view(w.ctx, w.planner, w.ours)
    expect(view.guests.find((g) => g.first_name === 'Sam')).toMatchObject({ plus_one_of: host.guest_id, household_id: h.household_id })
    expect(view.households[0]?.address).toBe('2 Elm St')
  })

  it('links a new plus-one to the host the preview resolved, even when a plus-one on the list has the same name', () => {
    const w = world()
    const lee = w.list.addHousehold(w.ctx, w.planner, w.ours, { name: 'Lee' })
    const ann = w.list.addGuest(w.ctx, w.planner, w.ours, { household_id: lee.household_id, first_name: 'Ann', last_name: 'Lee', side: 'both', plus_one_allowed: true })
    const bo = w.list.addGuest(w.ctx, w.planner, w.ours, { household_id: lee.household_id, first_name: 'Bo', last_name: 'Lee', side: 'both', plus_one_allowed: true })
    w.list.addGuest(w.ctx, w.planner, w.ours, { first_name: 'Ann', last_name: 'Lee', side: 'both', plus_one_of: bo.guest_id }) // Bo's plus-one, also "Ann Lee"
    const file = [HEADER, 'Lee,,Pat,,,,,Ann Lee,,,'].join('\n')
    expect(w.list.importGuests(w.ctx, w.planner, w.ours, file, false)).toMatchObject({ applied: false, problems: [], creates: 1 })
    expect(w.list.importGuests(w.ctx, w.planner, w.ours, file, true)).toMatchObject({ applied: true })
    expect(w.list.view(w.ctx, w.planner, w.ours).guests.find((g) => g.first_name === 'Pat')?.plus_one_of).toBe(ann.guest_id)
  })

  it('the couple imports into its own wedding; another wedding is the masked NOT_FOUND, and stays untouched', () => {
    const w = world()
    expect(w.list.importGuests(w.ctx, w.couple, w.ours, FILE, true)).toMatchObject({ applied: true })
    let code = 'NO_THROW'
    try {
      w.list.importGuests(w.ctx, w.couple, w.theirs, FILE, true)
    } catch (error) {
      code = (error as { code?: string }).code ?? 'NON_CODED'
    }
    expect(code).toBe('PRODUCT.NOT_FOUND')
    expect(w.list.view(w.ctx, w.planner, w.theirs).counts.guests).toBe(0)
  })
})
