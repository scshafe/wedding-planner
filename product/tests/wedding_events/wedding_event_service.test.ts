import { ManualClock, SequentialIdGenerator, type Tenant } from '@wedding-planner/shared'
import { describe, expect, it } from 'vitest'

import {
  GUEST_LIST_LIMITS,
  GuestDirectory,
  GuestListService,
  InMemoryRecordStore,
  isLocalDateTime,
  SessionStore,
  TenantContextResolver,
  TenantStore,
  WeddingAuthorizer,
  WeddingEventService,
  WeddingRepository,
} from '@wedding-planner/product'

import { COLLECTIONS } from '../../src/persistence/collections'
import { keyPrefixOf } from '../../src/persistence/record_store'

/**
 * Issue #29 — a wedding's events and the RSVPs per guest per event, below the HTTP edge: the defaults (the event's
 * invitation, a plus-one following their host, pending), meal choices and their stable ids, live counts, cascades
 * from guest and event removal, the bounds, and the wedding's boundary.
 */

const THEME: Tenant['theme'] = { brand_name: 'B', primary_color_hex: '#111111', accent_color_hex: '#222222', logo_ref: 'l' }

function world(limits?: { events: number; meal_options: number; meal_inputs: number }) {
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
  // Wired exactly as compose.ts does: the events read the directory; the guest list calls the events' hook.
  const events = new WeddingEventService(tenants, weddings, authorizer, new GuestDirectory(tenants, store), clock, ids, store, limits)
  const guestList = new GuestListService(tenants, weddings, authorizer, clock, ids, store, GUEST_LIST_LIMITS, events)
  const household = guestList.addHousehold(ctx, planner, ours, { name: 'Rivera' })
  const ana = guestList.addGuest(ctx, planner, ours, { household_id: household.household_id, first_name: 'Ana', side: 'both', plus_one_allowed: true })
  const luis = guestList.addGuest(ctx, planner, ours, { household_id: household.household_id, first_name: 'Luis', side: 'both' })
  return { clock, store, ctx, ours, theirs, planner, couple, guestList, events, household, ana, luis }
}

const meals = (...labels: string[]) => labels.map((label) => ({ label }))

function codeOf(fn: () => unknown): string {
  try {
    fn()
  } catch (error) {
    return (error as { code?: string }).code ?? `NON_CODED:${String(error)}`
  }
  return 'NO_THROW'
}

describe('WeddingEventService', () => {
  it('keeps events per wedding, sorted by start, with trimmed fields and deduplicated meal options', () => {
    const w = world()
    w.events.addEvent(w.ctx, w.planner, w.ours, { name: ' Reception ', starts_at: '2028-06-10T18:00', location: ' Hall ', meal_options: meals('Fish', ' fish ', 'Veg', '') })
    w.events.addEvent(w.ctx, w.planner, w.ours, { name: 'Ceremony', starts_at: '2028-06-10T16:00' })
    const view = w.events.view(w.ctx, w.planner, w.ours)
    expect(view.events.map(({ event }) => [event.name, event.starts_at, event.location, event.invitation])).toEqual([
      ['Ceremony', '2028-06-10T16:00', undefined, 'everyone'],
      ['Reception', '2028-06-10T18:00', 'Hall', 'everyone'],
    ])
    expect(view.events[1]?.event.meal_options.map((o) => o.label)).toEqual(['Fish', 'Veg'])
    expect(w.events.view(w.ctx, w.planner, w.theirs).events).toEqual([])
  })

  it('refuses a date-time that is not real, an empty name, too many meals or meal inputs, and too many events', () => {
    const w = world({ events: 1, meal_options: 2, meal_inputs: 4 })
    expect(codeOf(() => w.events.addEvent(w.ctx, w.planner, w.ours, { name: 'X', starts_at: '2028-02-30T10:00' }))).toBe('PRODUCT.BAD_REQUEST')
    expect(codeOf(() => w.events.addEvent(w.ctx, w.planner, w.ours, { name: 'X', starts_at: '2028-06-10 10:00' }))).toBe('PRODUCT.BAD_REQUEST')
    expect(codeOf(() => w.events.addEvent(w.ctx, w.planner, w.ours, { name: '  ', starts_at: '2028-06-10T10:00' }))).toBe('CONTRACT.VALIDATION_FAILED')
    expect(codeOf(() => w.events.addEvent(w.ctx, w.planner, w.ours, { name: 'X', starts_at: '2028-06-10T10:00', meal_options: meals('a', 'b', 'c') }))).toBe('PRODUCT.BAD_REQUEST')
    expect(codeOf(() => w.events.addEvent(w.ctx, w.planner, w.ours, { name: 'X', starts_at: '2028-06-10T10:00', meal_options: meals('a', 'a', 'a', 'a', 'a') }))).toBe('PRODUCT.BAD_REQUEST')
    w.events.addEvent(w.ctx, w.planner, w.ours, { name: 'X', starts_at: '2028-06-10T10:00' })
    expect(codeOf(() => w.events.addEvent(w.ctx, w.planner, w.ours, { name: 'Y', starts_at: '2028-06-10T11:00' }))).toBe('PRODUCT.LIMIT_REACHED')
    expect(isLocalDateTime('2028-06-10T24:00')).toBe(false)
    expect(isLocalDateTime('2028-12-31T23:59')).toBe(true)
  })

  it('refuses a huge meal list at once, before any per-item work', () => {
    const w = world()
    const started = performance.now()
    const many = Array.from({ length: 50_000 }, (_, i) => ({ label: `m${i}` }))
    expect(codeOf(() => w.events.addEvent(w.ctx, w.planner, w.ours, { name: 'X', starts_at: '2028-06-10T10:00', meal_options: many }))).toBe('PRODUCT.BAD_REQUEST')
    expect(performance.now() - started).toBeLessThan(100)
  })

  it('no record means the event\'s invitation and pending; answers count live, meals by choice', () => {
    const w = world()
    const dinner = w.events.addEvent(w.ctx, w.planner, w.ours, { name: 'Dinner', starts_at: '2028-06-10T18:00', meal_options: meals('Fish', 'Veg') })
    const [fish, veg] = dinner.meal_options.map((o) => o.option_id) as [string, string]
    expect(w.events.view(w.ctx, w.planner, w.ours).events[0]?.counts).toEqual({ invited: 2, attending: 0, declined: 0, pending: 2, meals: { [fish]: 0, [veg]: 0 }, meal_unchosen: 0 })
    w.events.recordAnswer(w.ctx, w.planner, w.ours, dinner.event_id, w.ana.guest_id, { invited: true, status: 'attending', meal_option_id: veg })
    w.events.recordAnswer(w.ctx, w.couple, w.ours, dinner.event_id, w.luis.guest_id, { invited: true, status: 'attending' })
    expect(w.events.view(w.ctx, w.planner, w.ours).events[0]?.counts).toMatchObject({ invited: 2, attending: 2, pending: 0, meals: { [fish]: 0, [veg]: 1 }, meal_unchosen: 1 })
    w.events.recordAnswer(w.ctx, w.planner, w.ours, dinner.event_id, w.luis.guest_id, { invited: true, status: 'declined' })
    expect(w.events.view(w.ctx, w.planner, w.ours).events[0]?.counts).toMatchObject({ attending: 1, declined: 1, pending: 0, meal_unchosen: 0 })
    // Not invited: out of every count, and the answer resets to pending with no meal.
    const rsvp = w.events.recordAnswer(w.ctx, w.planner, w.ours, dinner.event_id, w.ana.guest_id, { invited: false, status: 'attending', meal_option_id: veg })
    expect(rsvp).toMatchObject({ invited: false, status: 'pending', answered_by: 'planner' })
    expect(rsvp.meal_option_id).toBeUndefined()
    expect(w.events.view(w.ctx, w.planner, w.ours).events[0]?.counts).toMatchObject({ invited: 1, attending: 0, declined: 1, pending: 0 })
  })

  it('an invite-only event invites nobody by default; a plus-one without a record follows their host', () => {
    const w = world()
    const plusOne = w.guestList.addGuest(w.ctx, w.planner, w.ours, { first_name: 'Sam', side: 'both', plus_one_of: w.ana.guest_id })
    const rehearsal = w.events.addEvent(w.ctx, w.planner, w.ours, { name: 'Rehearsal', starts_at: '2028-06-09T19:00', invitation: 'selected' })
    expect(w.events.view(w.ctx, w.planner, w.ours).events[0]?.counts).toMatchObject({ invited: 0, pending: 0 })
    w.events.recordAnswer(w.ctx, w.planner, w.ours, rehearsal.event_id, w.ana.guest_id, { invited: true, status: 'pending' })
    expect(w.events.view(w.ctx, w.planner, w.ours).events[0]?.counts).toMatchObject({ invited: 2, pending: 2 })
    expect(w.events.guestRsvps(w.ctx, w.planner, w.ours, plusOne.guest_id)[0]).toMatchObject({ invited: true, status: 'pending' })
    expect(w.events.guestRsvps(w.ctx, w.planner, w.ours, w.luis.guest_id)[0]).toMatchObject({ invited: false })
    // The plus-one's own record wins over the host's.
    w.events.recordAnswer(w.ctx, w.planner, w.ours, rehearsal.event_id, plusOne.guest_id, { invited: false, status: 'pending' })
    expect(w.events.view(w.ctx, w.planner, w.ours).events[0]?.counts).toMatchObject({ invited: 1 })
    // An edit that leaves the invitation out keeps it.
    expect(w.events.updateEvent(w.ctx, w.planner, w.ours, rehearsal.event_id, { name: 'Rehearsal dinner', starts_at: '2028-06-09T19:30' }).invitation).toBe('selected')
  })

  it('a meal choice must be one of the event\'s options while attending, and is dropped otherwise; the recorder is the role', () => {
    const w = world()
    const dinner = w.events.addEvent(w.ctx, w.planner, w.ours, { name: 'Dinner', starts_at: '2028-06-10T18:00', meal_options: meals('Fish') })
    const brunch = w.events.addEvent(w.ctx, w.planner, w.ours, { name: 'Brunch', starts_at: '2028-06-11T10:00' })
    const fish = dinner.meal_options[0]?.option_id as string
    expect(codeOf(() => w.events.recordAnswer(w.ctx, w.planner, w.ours, brunch.event_id, w.ana.guest_id, { invited: true, status: 'attending', meal_option_id: fish }))).toBe('PRODUCT.BAD_REQUEST')
    const declined = w.events.recordAnswer(w.ctx, w.planner, w.ours, dinner.event_id, w.ana.guest_id, { invited: true, status: 'declined', meal_option_id: fish })
    expect(declined.meal_option_id).toBeUndefined()
    expect(w.events.recordAnswer(w.ctx, w.couple, w.ours, dinner.event_id, w.ana.guest_id, { invited: true, status: 'attending', meal_option_id: fish })).toMatchObject({ meal_option_id: fish, answered_by: 'couple' })
    expect(w.events.guestRsvps(w.ctx, w.planner, w.ours, w.ana.guest_id).map((r) => [r.event.name, r.invited, r.status, r.meal_option_id])).toEqual([
      ['Dinner', true, 'attending', fish],
      ['Brunch', true, 'pending', undefined],
    ])
  })

  it('a meal renamed by its id keeps its choices; a meal left out clears them, as the editor\'s change', () => {
    const w = world()
    const dinner = w.events.addEvent(w.ctx, w.planner, w.ours, { name: 'Dinner', starts_at: '2028-06-10T18:00', meal_options: meals('Chiken', 'Veg') })
    const [chicken, veg] = dinner.meal_options.map((o) => o.option_id) as [string, string]
    w.events.recordAnswer(w.ctx, w.couple, w.ours, dinner.event_id, w.ana.guest_id, { invited: true, status: 'attending', meal_option_id: chicken })
    w.events.recordAnswer(w.ctx, w.couple, w.ours, dinner.event_id, w.luis.guest_id, { invited: true, status: 'attending', meal_option_id: veg })
    const updated = w.events.updateEvent(w.ctx, w.planner, w.ours, dinner.event_id, {
      name: 'Dinner',
      starts_at: '2028-06-10T19:00',
      meal_options: [{ option_id: chicken, label: 'Chicken' }, { label: 'Beef' }],
    })
    expect(updated.meal_options.map((o) => [o.label, o.option_id === chicken])).toEqual([
      ['Chicken', true],
      ['Beef', false],
    ])
    const answer = (guest: string) => w.events.guestRsvps(w.ctx, w.planner, w.ours, guest)[0]
    expect(answer(w.ana.guest_id)).toMatchObject({ status: 'attending', meal_option_id: chicken, answered_by: 'couple' })
    expect(answer(w.luis.guest_id)).toMatchObject({ status: 'attending', answered_by: 'planner' })
    expect(answer(w.luis.guest_id)?.meal_option_id).toBeUndefined()
    // A label alone still matches an existing option; an id that is not on the event is refused.
    expect(w.events.updateEvent(w.ctx, w.planner, w.ours, dinner.event_id, { name: 'Dinner', starts_at: '2028-06-10T19:00', meal_options: meals('CHICKEN') }).meal_options[0]?.option_id).toBe(chicken)
    expect(codeOf(() => w.events.updateEvent(w.ctx, w.planner, w.ours, dinner.event_id, { name: 'Dinner', starts_at: '2028-06-10T19:00', meal_options: [{ option_id: 'meal_other', label: 'X' }] }))).toBe('PRODUCT.BAD_REQUEST')
  })

  it('removing a guest (or their household) forgets their answers; removing an event forgets its answers', () => {
    const w = world()
    const dinner = w.events.addEvent(w.ctx, w.planner, w.ours, { name: 'Dinner', starts_at: '2028-06-10T18:00' })
    const brunch = w.events.addEvent(w.ctx, w.planner, w.ours, { name: 'Brunch', starts_at: '2028-06-11T10:00' })
    const plusOne = w.guestList.addGuest(w.ctx, w.planner, w.ours, { first_name: 'Sam', side: 'both', plus_one_of: w.ana.guest_id })
    for (const g of [w.ana, w.luis, plusOne]) {
      for (const e of [dinner, brunch]) w.events.recordAnswer(w.ctx, w.planner, w.ours, e.event_id, g.guest_id, { invited: true, status: 'attending' })
    }
    const stored = () => w.store.listByKeyPrefix(COLLECTIONS.weddingRsvp, w.ctx.tenant_id, keyPrefixOf(w.ours)).length
    expect(stored()).toBe(6)
    w.guestList.removeGuest(w.ctx, w.planner, w.ours, w.ana.guest_id) // and her plus-one
    expect(stored()).toBe(2)
    w.events.removeEvent(w.ctx, w.planner, w.ours, brunch.event_id)
    expect(stored()).toBe(1)
    w.guestList.removeHousehold(w.ctx, w.planner, w.ours, w.household.household_id)
    expect(stored()).toBe(0)
    expect(w.events.view(w.ctx, w.planner, w.ours).events[0]?.counts).toMatchObject({ invited: 0, attending: 0 })
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
    expect(codeOf(() => w.events.recordAnswer(w.ctx, w.planner, w.ours, theirs.event_id, w.ana.guest_id, { invited: true, status: 'attending' }))).toBe('PRODUCT.NOT_FOUND')
    expect(codeOf(() => w.events.recordAnswer(w.ctx, w.planner, w.ours, ours.event_id, theirGuest.guest_id, { invited: true, status: 'attending' }))).toBe('PRODUCT.NOT_FOUND')
    expect(codeOf(() => w.events.guestRsvps(w.ctx, w.planner, w.ours, theirGuest.guest_id))).toBe('PRODUCT.NOT_FOUND')
    expect(codeOf(() => w.events.updateEvent(w.ctx, w.planner, w.ours, theirs.event_id, { name: 'X', starts_at: '2028-06-10T10:00' }))).toBe('PRODUCT.NOT_FOUND')
    expect(w.events.removeEvent(w.ctx, w.planner, w.ours, theirs.event_id)).toBe(false)
    expect(w.events.view(w.ctx, w.planner, w.theirs).events.map(({ event }) => event.name)).toEqual(['Theirs'])
  })
})
