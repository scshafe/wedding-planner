import { ManualClock, SequentialIdGenerator, type Tenant } from '@wedding-planner/shared'
import { describe, expect, it } from 'vitest'

import {
  fanOutGuestListHooks,
  GUEST_LIST_LIMITS,
  GuestDirectory,
  GuestListService,
  InMemoryRecordStore,
  SeatingService,
  SessionStore,
  TenantContextResolver,
  TenantStore,
  WeddingAuthorizer,
  WeddingEventService,
  WeddingRepository,
} from '@wedding-planner/product'

/**
 * Issue #46 — a wedding's seating plan below the HTTP edge: capacity as a hard rule (a household all or none), the
 * plan for one event (attending guests; the reception by default), unseating on guest or table removal, and the
 * wedding's boundary (the planner and the couple both manage seating).
 */

const THEME: Tenant['theme'] = { brand_name: 'B', primary_color_hex: '#111111', accent_color_hex: '#222222', logo_ref: 'l' }

function world() {
  const clock = new ManualClock('2028-01-10T12:00:00.000Z')
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
  const authorizer = new WeddingAuthorizer()
  const ids = new SequentialIdGenerator('x')
  const directory = new GuestDirectory(tenants, store)
  const events = new WeddingEventService(tenants, weddings, authorizer, directory, clock, ids, store)
  const seating = new SeatingService(tenants, weddings, authorizer, directory, events, clock, ids, store)
  const guestList = new GuestListService(tenants, weddings, authorizer, clock, ids, store, GUEST_LIST_LIMITS, fanOutGuestListHooks(events, seating))
  const rivera = guestList.addHousehold(ctx, planner, ours, { name: 'Rivera' })
  const ana = guestList.addGuest(ctx, planner, ours, { household_id: rivera.household_id, first_name: 'Ana', last_name: 'Rivera', side: 'both', dietary: 'vegan' })
  const bo = guestList.addGuest(ctx, planner, ours, { household_id: rivera.household_id, first_name: 'Bo', last_name: 'Rivera', side: 'both' })
  const chen = guestList.addHousehold(ctx, planner, ours, { name: 'Chen' })
  const mei = guestList.addGuest(ctx, planner, ours, { household_id: chen.household_id, first_name: 'Mei', last_name: 'Chen', side: 'both' })
  return { ctx, ours, theirs, planner, couple, events, seating, guestList, rivera, chen, ana, bo, mei }
}

function codeOf(fn: () => unknown): string {
  try {
    fn()
  } catch (error) {
    return (error as { code?: string }).code ?? `NON_CODED:${String(error)}`
  }
  return 'NO_THROW'
}

describe('SeatingService', () => {
  it('without events every guest is offered; seating respects capacity, and a household is seated all or none', () => {
    const w = world()
    const small = w.seating.addTable(w.ctx, w.couple, w.ours, { name: 'Small', capacity: 1 })
    const big = w.seating.addTable(w.ctx, w.planner, w.ours, { name: 'Big', capacity: 3 })
    expect(w.seating.view(w.ctx, w.planner, w.ours).unseated.map((g) => g.name)).toEqual(['Ana Rivera', 'Bo Rivera', 'Mei Chen'])
    expect(codeOf(() => w.seating.seatHousehold(w.ctx, w.planner, w.ours, w.rivera.household_id, small.table_id))).toBe('PRODUCT.SEATING_FULL')
    expect(w.seating.view(w.ctx, w.planner, w.ours).tables[0]?.guests).toEqual([])
    expect(w.seating.seatHousehold(w.ctx, w.couple, w.ours, w.rivera.household_id, big.table_id)).toBe(2)
    w.seating.seatGuest(w.ctx, w.planner, w.ours, w.mei.guest_id, small.table_id)
    expect(codeOf(() => w.seating.seatGuest(w.ctx, w.planner, w.ours, w.ana.guest_id, small.table_id))).toBe('PRODUCT.SEATING_FULL')
    const view = w.seating.view(w.ctx, w.planner, w.ours)
    expect(view.tables.map((t) => [t.table.name, t.guests.map((g) => g.name), t.free])).toEqual([
      ['Small', ['Mei Chen'], 0],
      ['Big', ['Ana Rivera', 'Bo Rivera'], 1],
    ])
    expect(view.tables[1]?.guests[0]?.dietary).toBe('vegan')
    expect(view.unseated).toEqual([])
    // Moving a guest frees their old seat; a table cannot shrink below the guests it seats.
    w.seating.seatGuest(w.ctx, w.planner, w.ours, w.mei.guest_id, big.table_id)
    expect(codeOf(() => w.seating.updateTable(w.ctx, w.planner, w.ours, big.table_id, { name: 'Big', capacity: 2 }))).toBe('PRODUCT.SEATING_FULL')
    expect(w.seating.updateTable(w.ctx, w.planner, w.ours, small.table_id, { name: 'Small', capacity: 2 }).capacity).toBe(2)
  })

  it('the plan is for one event: attending guests are offered, and seated guests no longer attending are flagged', () => {
    const w = world()
    const ceremony = w.events.addEvent(w.ctx, w.planner, w.ours, { name: 'Ceremony', starts_at: '2028-06-10T16:00' })
    const reception = w.events.addEvent(w.ctx, w.planner, w.ours, { name: 'Reception', starts_at: '2028-06-10T18:00' })
    w.events.addEvent(w.ctx, w.planner, w.ours, { name: 'Brunch', starts_at: '2028-06-11T10:00' })
    w.events.recordAnswer(w.ctx, w.planner, w.ours, reception.event_id, w.ana.guest_id, { invited: true, status: 'attending' })
    w.events.recordAnswer(w.ctx, w.planner, w.ours, reception.event_id, w.bo.guest_id, { invited: true, status: 'attending' })
    w.events.recordAnswer(w.ctx, w.planner, w.ours, ceremony.event_id, w.mei.guest_id, { invited: true, status: 'attending' })
    const table = w.seating.addTable(w.ctx, w.planner, w.ours, { name: 'T1', capacity: 8 })
    const byDefault = w.seating.view(w.ctx, w.planner, w.ours)
    expect(byDefault.event?.name).toBe('Reception')
    expect(byDefault.unseated.map((g) => g.name)).toEqual(['Ana Rivera', 'Bo Rivera'])
    expect(w.seating.view(w.ctx, w.planner, w.ours, ceremony.event_id).unseated.map((g) => g.name)).toEqual(['Mei Chen'])
    w.seating.seatGuest(w.ctx, w.planner, w.ours, w.ana.guest_id, table.table_id)
    w.events.recordAnswer(w.ctx, w.planner, w.ours, reception.event_id, w.ana.guest_id, { invited: true, status: 'declined' })
    expect(w.seating.view(w.ctx, w.planner, w.ours).seated_not_attending.map((g) => g.name)).toEqual(['Ana Rivera'])
  })

  it('a removed guest or household loses their seats (the hook); a removed table unseats its guests', () => {
    const w = world()
    const table = w.seating.addTable(w.ctx, w.planner, w.ours, { name: 'T1', capacity: 8 })
    w.seating.seatHousehold(w.ctx, w.planner, w.ours, w.rivera.household_id, table.table_id)
    w.seating.seatGuest(w.ctx, w.planner, w.ours, w.mei.guest_id, table.table_id)
    w.guestList.removeGuest(w.ctx, w.planner, w.ours, w.ana.guest_id)
    expect(w.seating.view(w.ctx, w.planner, w.ours).tables[0]?.guests.map((g) => g.name)).toEqual(['Bo Rivera', 'Mei Chen'])
    w.guestList.removeHousehold(w.ctx, w.planner, w.ours, w.rivera.household_id)
    expect(w.seating.view(w.ctx, w.planner, w.ours).tables[0]?.guests.map((g) => g.name)).toEqual(['Mei Chen'])
    expect(w.seating.removeTable(w.ctx, w.planner, w.ours, table.table_id)).toBe(true)
    expect(w.seating.view(w.ctx, w.planner, w.ours).unseated.map((g) => g.name)).toEqual(['Mei Chen'])
  })

  it('refuses bad tables; another wedding is the masked NOT_FOUND; a sibling wedding\'s guest or table is not found', () => {
    const w = world()
    for (const capacity of [0, 51, 2.5]) expect(codeOf(() => w.seating.addTable(w.ctx, w.planner, w.ours, { name: 'X', capacity }))).toBe('PRODUCT.BAD_REQUEST')
    expect(codeOf(() => w.seating.addTable(w.ctx, w.planner, w.ours, { name: 'A\nB', capacity: 2 }))).toBe('PRODUCT.BAD_REQUEST')
    expect(codeOf(() => w.seating.view(w.ctx, w.couple, w.theirs))).toBe('PRODUCT.NOT_FOUND')
    expect(codeOf(() => w.seating.addTable(w.ctx, w.couple, w.theirs, { name: 'X', capacity: 2 }))).toBe('PRODUCT.NOT_FOUND')
    const theirTable = w.seating.addTable(w.ctx, w.planner, w.theirs, { name: 'Theirs', capacity: 2 })
    expect(codeOf(() => w.seating.seatGuest(w.ctx, w.planner, w.ours, w.ana.guest_id, theirTable.table_id))).toBe('PRODUCT.NOT_FOUND')
    expect(codeOf(() => w.seating.seatGuest(w.ctx, w.planner, w.theirs, w.ana.guest_id, theirTable.table_id))).toBe('PRODUCT.NOT_FOUND')
    expect(w.seating.removeTable(w.ctx, w.planner, w.ours, theirTable.table_id)).toBe(false)
  })
})
