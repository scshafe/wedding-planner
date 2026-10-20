import { ManualClock, SequentialIdGenerator, type Tenant } from '@wedding-planner/shared'
import { describe, expect, it } from 'vitest'

import {
  EventService,
  GUEST_LIST_LIMITS,
  GuestListService,
  InMemoryRecordStore,
  isLocalDateTime,
  SessionStore,
  TenantContextResolver,
  TenantStore,
  WeddingAuthorizer,
  WeddingRepository,
} from '@wedding-planner/product'

import { COLLECTIONS } from '../../src/persistence/collections'
import { keyPrefixOf } from '../../src/persistence/record_store'

/**
 * Issue #29 — a wedding's events and the RSVPs per guest per event, below the HTTP edge: the default (invited,
 * pending), meal choices, live counts, cascades from guest and event removal, and the wedding's boundary.
 */

const THEME: Tenant['theme'] = { brand_name: 'B', primary_color_hex: '#111111', accent_color_hex: '#222222', logo_ref: 'l' }

function world(limits?: { events: number; meal_options: number }) {
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
  const authorizer = new WeddingAuthorizer()
  const ids = new SequentialIdGenerator('g')
  const guestList: GuestListService = new GuestListService(tenants, weddings, authorizer, clock, ids, store, GUEST_LIST_LIMITS, {
    guestsRemoved: (c, w, removed) => events.forgetGuests(c, w, removed),
  })
  const events: EventService = new EventService(tenants, weddings, authorizer, guestList, clock, ids, store, limits)
  const household = guestList.addHousehold(ctx, planner, ours, { name: 'Rivera' })
  const ana = guestList.addGuest(ctx, planner, ours, { household_id: household.household_id, first_name: 'Ana', side: 'both', plus_one_allowed: true })
  const luis = guestList.addGuest(ctx, planner, ours, { household_id: household.household_id, first_name: 'Luis', side: 'both' })
  return { clock, store, ctx, ours, theirs, planner, couple, guestList, events, household, ana, luis }
}

function codeOf(fn: () => unknown): string {
  try {
    fn()
  } catch (error) {
    return (error as { code?: string }).code ?? `NON_CODED:${String(error)}`
  }
  return 'NO_THROW'
}

describe('EventService', () => {
  it('keeps events per wedding, sorted by start, with trimmed fields and deduplicated meal options', () => {
    const w = world()
    w.events.addEvent(w.ctx, w.planner, w.ours, { name: ' Reception ', starts_at: '2028-06-10T18:00', location: ' Hall ', meal_options: ['Fish', ' fish ', 'Veg', ''] })
    w.events.addEvent(w.ctx, w.planner, w.ours, { name: 'Ceremony', starts_at: '2028-06-10T16:00' })
    const view = w.events.view(w.ctx, w.planner, w.ours)
    expect(view.events.map((e) => [e.name, e.starts_at, e.location])).toEqual([
      ['Ceremony', '2028-06-10T16:00', undefined],
      ['Reception', '2028-06-10T18:00', 'Hall'],
    ])
    expect(view.events[1]?.meal_options.map((o) => o.label)).toEqual(['Fish', 'Veg'])
    expect(w.events.view(w.ctx, w.planner, w.theirs).events).toEqual([])
  })

  it('refuses a date-time that is not real, an empty name, too many meals, and too many events', () => {
    const w = world({ events: 1, meal_options: 2 })
    expect(codeOf(() => w.events.addEvent(w.ctx, w.planner, w.ours, { name: 'X', starts_at: '2028-02-30T10:00' }))).toBe('PRODUCT.BAD_REQUEST')
    expect(codeOf(() => w.events.addEvent(w.ctx, w.planner, w.ours, { name: 'X', starts_at: '2028-06-10 10:00' }))).toBe('PRODUCT.BAD_REQUEST')
    expect(codeOf(() => w.events.addEvent(w.ctx, w.planner, w.ours, { name: '  ', starts_at: '2028-06-10T10:00' }))).toBe('CONTRACT.VALIDATION_FAILED')
    expect(codeOf(() => w.events.addEvent(w.ctx, w.planner, w.ours, { name: 'X', starts_at: '2028-06-10T10:00', meal_options: ['a', 'b', 'c'] }))).toBe('PRODUCT.BAD_REQUEST')
    w.events.addEvent(w.ctx, w.planner, w.ours, { name: 'X', starts_at: '2028-06-10T10:00' })
    expect(codeOf(() => w.events.addEvent(w.ctx, w.planner, w.ours, { name: 'Y', starts_at: '2028-06-10T11:00' }))).toBe('PRODUCT.LIMIT_REACHED')
    expect(isLocalDateTime('2028-06-10T24:00')).toBe(false)
    expect(isLocalDateTime('2028-12-31T23:59')).toBe(true)
  })

  it('no record means invited and pending; answers count live, meals by choice', () => {
    const w = world()
    const dinner = w.events.addEvent(w.ctx, w.planner, w.ours, { name: 'Dinner', starts_at: '2028-06-10T18:00', meal_options: ['Fish', 'Veg'] })
    const [fish, veg] = dinner.meal_options.map((o) => o.option_id) as [string, string]
    expect(w.events.view(w.ctx, w.planner, w.ours).counts).toEqual([
      { event_id: dinner.event_id, invited: 2, attending: 0, declined: 0, pending: 2, meals: { [fish]: 0, [veg]: 0 }, meal_unchosen: 0 },
    ])
    w.events.setRsvp(w.ctx, w.planner, w.ours, dinner.event_id, w.ana.guest_id, { invited: true, status: 'attending', meal_option_id: veg })
    w.events.setRsvp(w.ctx, w.couple, w.ours, dinner.event_id, w.luis.guest_id, { invited: true, status: 'attending' })
    expect(w.events.view(w.ctx, w.planner, w.ours).counts[0]).toMatchObject({ invited: 2, attending: 2, pending: 0, meals: { [fish]: 0, [veg]: 1 }, meal_unchosen: 1 })
    w.events.setRsvp(w.ctx, w.planner, w.ours, dinner.event_id, w.luis.guest_id, { invited: true, status: 'declined' })
    expect(w.events.view(w.ctx, w.planner, w.ours).counts[0]).toMatchObject({ attending: 1, declined: 1, pending: 0, meal_unchosen: 0 })
    // Not invited: out of every count, and the answer resets to pending with no meal.
    const rsvp = w.events.setRsvp(w.ctx, w.planner, w.ours, dinner.event_id, w.ana.guest_id, { invited: false, status: 'attending' })
    expect(rsvp).toMatchObject({ invited: false, status: 'pending', answered_by: 'planner' })
    expect(rsvp.meal_option_id).toBeUndefined()
    expect(w.events.view(w.ctx, w.planner, w.ours).counts[0]).toMatchObject({ invited: 1, attending: 0, declined: 1, pending: 0 })
  })

  it('a meal choice is one of the event\'s options and only goes with attending; the recorder is the principal\'s role', () => {
    const w = world()
    const dinner = w.events.addEvent(w.ctx, w.planner, w.ours, { name: 'Dinner', starts_at: '2028-06-10T18:00', meal_options: ['Fish'] })
    const brunch = w.events.addEvent(w.ctx, w.planner, w.ours, { name: 'Brunch', starts_at: '2028-06-11T10:00' })
    const fish = dinner.meal_options[0]?.option_id as string
    expect(codeOf(() => w.events.setRsvp(w.ctx, w.planner, w.ours, dinner.event_id, w.ana.guest_id, { invited: true, status: 'declined', meal_option_id: fish }))).toBe('PRODUCT.BAD_REQUEST')
    expect(codeOf(() => w.events.setRsvp(w.ctx, w.planner, w.ours, brunch.event_id, w.ana.guest_id, { invited: true, status: 'attending', meal_option_id: fish }))).toBe('PRODUCT.BAD_REQUEST')
    expect(w.events.setRsvp(w.ctx, w.couple, w.ours, dinner.event_id, w.ana.guest_id, { invited: true, status: 'attending', meal_option_id: fish })).toMatchObject({ meal_option_id: fish, answered_by: 'couple' })
    expect(w.events.guestRsvps(w.ctx, w.planner, w.ours, w.ana.guest_id).map((r) => [r.event.name, r.invited, r.status, r.meal_option_id])).toEqual([
      ['Dinner', true, 'attending', fish],
      ['Brunch', true, 'pending', undefined],
    ])
  })

  it('a renamed meal keeps its choices; a dropped meal clears them', () => {
    const w = world()
    const dinner = w.events.addEvent(w.ctx, w.planner, w.ours, { name: 'Dinner', starts_at: '2028-06-10T18:00', meal_options: ['Fish', 'Veg'] })
    const [fish, veg] = dinner.meal_options.map((o) => o.option_id) as [string, string]
    w.events.setRsvp(w.ctx, w.planner, w.ours, dinner.event_id, w.ana.guest_id, { invited: true, status: 'attending', meal_option_id: fish })
    w.events.setRsvp(w.ctx, w.planner, w.ours, dinner.event_id, w.luis.guest_id, { invited: true, status: 'attending', meal_option_id: veg })
    const updated = w.events.updateEvent(w.ctx, w.planner, w.ours, dinner.event_id, { name: 'Dinner', starts_at: '2028-06-10T19:00', meal_options: ['Beef', 'FISH'] })
    expect(updated.meal_options.map((o) => [o.label, o.option_id === fish])).toEqual([
      ['Beef', false],
      ['FISH', true],
    ])
    const answers = (guest: string) => w.events.guestRsvps(w.ctx, w.planner, w.ours, guest)[0]
    expect(answers(w.ana.guest_id)).toMatchObject({ status: 'attending', meal_option_id: fish })
    expect(answers(w.luis.guest_id)).toMatchObject({ status: 'attending' })
    expect(answers(w.luis.guest_id)?.meal_option_id).toBeUndefined()
  })

  it('removing a guest (or their household) forgets their answers; removing an event forgets its answers', () => {
    const w = world()
    const dinner = w.events.addEvent(w.ctx, w.planner, w.ours, { name: 'Dinner', starts_at: '2028-06-10T18:00' })
    const brunch = w.events.addEvent(w.ctx, w.planner, w.ours, { name: 'Brunch', starts_at: '2028-06-11T10:00' })
    const plusOne = w.guestList.addGuest(w.ctx, w.planner, w.ours, { first_name: 'Sam', side: 'both', plus_one_of: w.ana.guest_id })
    for (const g of [w.ana, w.luis, plusOne]) {
      for (const e of [dinner, brunch]) w.events.setRsvp(w.ctx, w.planner, w.ours, e.event_id, g.guest_id, { invited: true, status: 'attending' })
    }
    const stored = () => w.store.listByKeyPrefix(COLLECTIONS.weddingRsvp, w.ctx.tenant_id, keyPrefixOf(w.ours)).length
    expect(stored()).toBe(6)
    w.guestList.removeGuest(w.ctx, w.planner, w.ours, w.ana.guest_id) // and her plus-one
    expect(stored()).toBe(2)
    w.events.removeEvent(w.ctx, w.planner, w.ours, brunch.event_id)
    expect(stored()).toBe(1)
    w.guestList.removeHousehold(w.ctx, w.planner, w.ours, w.household.household_id)
    expect(stored()).toBe(0)
    expect(w.events.view(w.ctx, w.planner, w.ours).counts[0]).toMatchObject({ invited: 0, attending: 0 })
  })

  it('the couple reaches only its own wedding; a sibling wedding\'s event or guest is not found', () => {
    const w = world()
    expect(codeOf(() => w.events.view(w.ctx, w.couple, w.theirs))).toBe('PRODUCT.NOT_FOUND')
    expect(codeOf(() => w.events.view(w.ctx, w.couple, 'wedding_missing'))).toBe('PRODUCT.NOT_FOUND')
    expect(codeOf(() => w.events.addEvent(w.ctx, w.couple, w.theirs, { name: 'X', starts_at: '2028-06-10T10:00' }))).toBe('PRODUCT.NOT_FOUND')
    const theirs = w.events.addEvent(w.ctx, w.planner, w.theirs, { name: 'Theirs', starts_at: '2028-07-10T10:00' })
    const theirHousehold = w.guestList.addHousehold(w.ctx, w.planner, w.theirs, { name: 'Kit' })
    const theirGuest = w.guestList.addGuest(w.ctx, w.planner, w.theirs, { household_id: theirHousehold.household_id, first_name: 'Kit', side: 'both' })
    const ours = w.events.addEvent(w.ctx, w.couple, w.ours, { name: 'Ours', starts_at: '2028-06-10T10:00' })
    expect(codeOf(() => w.events.setRsvp(w.ctx, w.planner, w.ours, theirs.event_id, w.ana.guest_id, { invited: true, status: 'attending' }))).toBe('PRODUCT.NOT_FOUND')
    expect(codeOf(() => w.events.setRsvp(w.ctx, w.planner, w.ours, ours.event_id, theirGuest.guest_id, { invited: true, status: 'attending' }))).toBe('PRODUCT.NOT_FOUND')
    expect(codeOf(() => w.events.guestRsvps(w.ctx, w.planner, w.ours, theirGuest.guest_id))).toBe('PRODUCT.NOT_FOUND')
    expect(codeOf(() => w.events.updateEvent(w.ctx, w.planner, w.ours, theirs.event_id, { name: 'X', starts_at: '2028-06-10T10:00' }))).toBe('PRODUCT.NOT_FOUND')
    expect(w.events.removeEvent(w.ctx, w.planner, w.ours, theirs.event_id)).toBe(false)
    expect(w.events.view(w.ctx, w.planner, w.theirs).events.map((e) => e.name)).toEqual(['Theirs'])
  })
})
