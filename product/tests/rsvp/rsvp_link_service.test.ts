import { ManualClock, SequentialIdGenerator, sha256Hex, type Tenant } from '@wedding-planner/shared'
import { describe, expect, it } from 'vitest'

import {
  assertHouseholdGrant,
  fanOutGuestListHooks,
  GUEST_LIST_LIMITS,
  GuestDirectory,
  GuestListService,
  type HouseholdRsvpGrant,
  InMemoryRecordStore,
  RsvpLinkService,
  SessionStore,
  TenantContextResolver,
  TenantStore,
  WeddingAuthorizer,
  WeddingEventService,
  WeddingRepository,
} from '@wedding-planner/product'

import { COLLECTIONS } from '../../src/persistence/collections'
import { groupedKey } from '../../src/persistence/record_store'

/**
 * Issue #30 — households' RSVP links and what a resolved link may do: the token is stored only as its hash, a new
 * link turns the old one off, a link never crosses tenants or survives its household, and the household page sees
 * and answers only for its own guests at the events they are invited to, until the planner closes RSVPs.
 */

const THEME: Tenant['theme'] = { brand_name: 'B', primary_color_hex: '#111111', accent_color_hex: '#222222', logo_ref: 'l' }

function world() {
  const clock = new ManualClock('2027-06-01T00:00:00.000Z')
  const store = new InMemoryRecordStore()
  const tenants = new TenantStore(clock, new SequentialIdGenerator('t'), store)
  tenants.create({ slug: 'alpha', display_name: 'Alpha', theme: THEME, plan_tier: 'solo', lifecycle_status: 'active' })
  tenants.create({ slug: 'beta', display_name: 'Beta', theme: THEME, plan_tier: 'solo', lifecycle_status: 'active' })
  const resolver = new TenantContextResolver(tenants)
  const ctx = resolver.resolveBySlug('alpha')
  const other = resolver.resolveBySlug('beta')
  const weddings = new WeddingRepository(tenants, clock, new SequentialIdGenerator('w'), store)
  const ours = weddings.create(ctx, { couple_display_name: 'Jo & Lee', event_date: '2028-06-10' }).wedding_id
  const theirs = weddings.create(ctx, { couple_display_name: 'Sam & Kit', event_date: '2028-07-10' }).wedding_id
  const sessions = new SessionStore(new SequentialIdGenerator('s'))
  const planner = sessions.login(ctx, { role: 'planner' }).principal
  const couple = sessions.login(ctx, { role: 'couple', wedding_id: ours }).principal
  const authorizer = new WeddingAuthorizer()
  const ids = new SequentialIdGenerator('g')
  const directory = new GuestDirectory(tenants, store)
  const events = new WeddingEventService(tenants, weddings, authorizer, directory, clock, ids, store)
  const links = new RsvpLinkService(tenants, weddings, authorizer, directory, clock, ids, store, 'https://planner.example')
  const guestList = new GuestListService(tenants, weddings, authorizer, clock, ids, store, GUEST_LIST_LIMITS, fanOutGuestListHooks(events, links))
  const rivera = guestList.addHousehold(ctx, planner, ours, { name: 'Rivera' })
  const chen = guestList.addHousehold(ctx, planner, ours, { name: 'Chen' })
  const ana = guestList.addGuest(ctx, planner, ours, { household_id: rivera.household_id, first_name: 'Ana', last_name: 'Rivera', side: 'both', plus_one_allowed: true })
  const sam = guestList.addGuest(ctx, planner, ours, { first_name: 'Sam', side: 'both', plus_one_of: ana.guest_id })
  const mei = guestList.addGuest(ctx, planner, ours, { household_id: chen.household_id, first_name: 'Mei', last_name: 'Chen', side: 'both' })
  const tokenOf = (url: string) => decodeURIComponent(url.split('/rsvp/')[1] ?? '')
  return { clock, store, ctx, other, ours, theirs, planner, couple, guestList, events, links, rivera, chen, ana, sam, mei, tokenOf }
}

function codeOf(fn: () => unknown): string {
  try {
    fn()
  } catch (error) {
    return (error as { code?: string }).code ?? `NON_CODED:${String(error)}`
  }
  return 'NO_THROW'
}

describe('RsvpLinkService', () => {
  it('makes a link the planner or the couple copies once: only its hash is stored, and it resolves to the household', () => {
    const w = world()
    const made = w.links.issue(w.ctx, w.couple, w.ours, w.rivera.household_id)
    expect(made.url).toMatch(/^https:\/\/planner\.example\/t\/alpha\/rsvp\/rsvp_/)
    const token = w.tokenOf(made.url)
    expect(JSON.stringify(w.store.list(COLLECTIONS.rsvpLink, w.ctx.tenant_id))).not.toContain(token)
    expect(w.store.get(COLLECTIONS.rsvpLink, w.ctx.tenant_id, sha256Hex(token))).toMatchObject({ household_id: w.rivera.household_id })
    expect(w.links.resolve(w.ctx, token)).toMatchObject({ wedding_id: w.ours, household_id: w.rivera.household_id })
    expect(w.links.links(w.ctx, w.planner, w.ours)).toEqual([{ household_id: w.rivera.household_id, created_at: '2027-06-01T00:00:00.000Z' }])
  })

  it('a new link turns the old one off; another tenant, a removed household or a junk token resolve to nothing', () => {
    const w = world()
    const first = w.tokenOf(w.links.issue(w.ctx, w.planner, w.ours, w.rivera.household_id).url)
    const second = w.tokenOf(w.links.issue(w.ctx, w.planner, w.ours, w.rivera.household_id).url)
    expect(w.links.resolve(w.ctx, first)).toBeUndefined()
    expect(w.links.resolve(w.ctx, second)).toBeDefined()
    expect(w.links.resolve(w.other, second)).toBeUndefined()
    for (const junk of ['', 'x'.repeat(129), 'rsvp_unknown']) expect(w.links.resolve(w.ctx, junk)).toBeUndefined()
    w.guestList.removeHousehold(w.ctx, w.planner, w.ours, w.rivera.household_id)
    expect(w.links.resolve(w.ctx, second)).toBeUndefined()
    expect(w.store.list(COLLECTIONS.rsvpLink, w.ctx.tenant_id)).toEqual([])
    expect(w.links.links(w.ctx, w.planner, w.ours)).toEqual([])
  })

  it('the couple makes links only for its own wedding; a household of another wedding is not found', () => {
    const w = world()
    const kit = w.guestList.addHousehold(w.ctx, w.planner, w.theirs, { name: 'Kit' })
    expect(codeOf(() => w.links.issue(w.ctx, w.couple, w.theirs, kit.household_id))).toBe('PRODUCT.NOT_FOUND')
    expect(codeOf(() => w.links.issue(w.ctx, w.planner, w.ours, kit.household_id))).toBe('PRODUCT.NOT_FOUND')
    expect(codeOf(() => w.links.links(w.ctx, w.couple, w.theirs))).toBe('PRODUCT.NOT_FOUND')
  })

  it('a grant comes only from a resolved link: a hand-built one is refused everywhere it is accepted', () => {
    const w = world()
    const forged = { context: w.ctx, wedding_id: w.ours, household_id: w.rivera.household_id } as unknown as HouseholdRsvpGrant
    expect(codeOf(() => assertHouseholdGrant(forged))).toBe('PRODUCT.FORGED_CONTEXT')
    expect(codeOf(() => w.events.householdView(forged))).toBe('PRODUCT.FORGED_CONTEXT')
    expect(codeOf(() => w.events.answerAsHousehold(forged, []))).toBe('PRODUCT.FORGED_CONTEXT')
    expect(codeOf(() => w.guestList.setDietaryAsHousehold(forged, w.ana.guest_id, 'vegan'))).toBe('PRODUCT.FORGED_CONTEXT')
  })
})

describe('the household RSVP page (WeddingEventService + GuestListService with a grant)', () => {
  function withEvents() {
    const w = world()
    const dinner = w.events.addEvent(w.ctx, w.planner, w.ours, { name: 'Dinner', starts_at: '2028-06-10T18:00', location: 'Hall', meal_options: [{ label: 'Fish' }, { label: 'Veg' }] })
    const rehearsal = w.events.addEvent(w.ctx, w.planner, w.ours, { name: 'Rehearsal', starts_at: '2028-06-09T19:00', invitation: 'selected' })
    const brunch = w.events.addEvent(w.ctx, w.planner, w.ours, { name: 'Brunch', starts_at: '2028-06-11T10:00', invitation: 'selected' })
    w.events.recordAnswer(w.ctx, w.planner, w.ours, rehearsal.event_id, w.mei.guest_id, { invited: true, status: 'pending' })
    w.events.recordAnswer(w.ctx, w.planner, w.ours, brunch.event_id, w.ana.guest_id, { invited: true, status: 'pending' })
    const grant = w.links.resolve(w.ctx, w.tokenOf(w.links.issue(w.ctx, w.planner, w.ours, w.rivera.household_id).url)) as HouseholdRsvpGrant
    return { ...w, dinner, rehearsal, brunch, grant }
  }

  it('shows only the household\'s guests and the events they are invited to', () => {
    const w = withEvents()
    const view = w.events.householdView(w.grant)
    expect(view.household_name).toBe('Rivera')
    expect(view.guests.map((g) => g.first_name)).toEqual(['Ana', 'Sam'])
    // The rehearsal invites only Mei (another household): not shown. The brunch invites Ana, and Sam follows her.
    expect(view.events.map((e) => [e.name, e.answers.map((a) => a.guest_id)])).toEqual([
      ['Dinner', [w.ana.guest_id, w.sam.guest_id]],
      ['Brunch', [w.ana.guest_id, w.sam.guest_id]],
    ])
    expect(JSON.stringify(view)).not.toContain('Mei')
    expect(JSON.stringify(view)).not.toContain('Jo & Lee')
    expect(view.closed).toBe(false)
  })

  it('answers for its own guests as the household, with meals and dietary notes; the counts move at once', () => {
    const w = withEvents()
    const fish = w.dinner.meal_options[0]?.option_id as string
    w.events.answerAsHousehold(w.grant, [
      { guest_id: w.ana.guest_id, event_id: w.dinner.event_id, status: 'attending', meal_option_id: fish },
      { guest_id: w.sam.guest_id, event_id: w.dinner.event_id, status: 'declined', meal_option_id: fish },
    ])
    w.guestList.setDietaryAsHousehold(w.grant, w.ana.guest_id, ' no nuts ')
    const rsvps = w.events.guestRsvps(w.ctx, w.planner, w.ours, w.ana.guest_id)
    expect(rsvps[1]).toMatchObject({ event: { name: 'Dinner' }, status: 'attending', meal_option_id: fish, answered_by: 'household' })
    expect(w.events.guestRsvps(w.ctx, w.planner, w.ours, w.sam.guest_id)[1]?.meal_option_id).toBeUndefined()
    expect(w.events.view(w.ctx, w.planner, w.ours).events.find((e) => e.event.name === 'Dinner')?.counts).toMatchObject({ attending: 1, declined: 1, meals: { [fish]: 1 } })
    expect(w.guestList.view(w.ctx, w.planner, w.ours).guests.find((g) => g.guest_id === w.ana.guest_id)?.dietary).toBe('no nuts')
  })

  it('refuses another household\'s guest, an event the guest is not invited to, and changes nothing', () => {
    const w = withEvents()
    expect(codeOf(() => w.events.answerAsHousehold(w.grant, [{ guest_id: w.mei.guest_id, event_id: w.dinner.event_id, status: 'attending' }]))).toBe('PRODUCT.BAD_REQUEST')
    expect(codeOf(() => w.events.answerAsHousehold(w.grant, [{ guest_id: w.ana.guest_id, event_id: w.rehearsal.event_id, status: 'attending' }]))).toBe('PRODUCT.BAD_REQUEST')
    expect(codeOf(() => w.guestList.setDietaryAsHousehold(w.grant, w.mei.guest_id, 'vegan'))).toBe('PRODUCT.BAD_REQUEST')
    expect(codeOf(() => w.guestList.setDietaryAsHousehold(w.grant, w.ana.guest_id, 'a\nb'))).toBe('PRODUCT.BAD_REQUEST')
    expect(codeOf(() => w.events.answerAsHousehold(w.grant, Array.from({ length: 241 }, () => ({ guest_id: w.ana.guest_id, event_id: w.dinner.event_id, status: 'attending' as const }))))).toBe('PRODUCT.BAD_REQUEST')
    expect(w.events.guestRsvps(w.ctx, w.planner, w.ours, w.mei.guest_id).every((r) => r.answered_by !== 'household')).toBe(true)
  })

  it('a household-answered plus-one follows the host\'s later invitation; one the planner set keeps theirs', () => {
    const w = withEvents()
    // The brunch is invite-only; the planner invited Ana, and Sam (her plus-one) follows her.
    w.events.answerAsHousehold(w.grant, [{ guest_id: w.sam.guest_id, event_id: w.brunch.event_id, status: 'attending' }])
    w.events.recordAnswer(w.ctx, w.planner, w.ours, w.brunch.event_id, w.ana.guest_id, { invited: false, status: 'pending' })
    const brunch = () => w.events.view(w.ctx, w.planner, w.ours).events.find((e) => e.event.name === 'Brunch')?.counts
    expect(brunch()).toMatchObject({ invited: 0, attending: 0 })
    // Ana is invited again: Sam follows her, with the answer he gave.
    w.events.recordAnswer(w.ctx, w.planner, w.ours, w.brunch.event_id, w.ana.guest_id, { invited: true, status: 'pending' })
    expect(brunch()).toMatchObject({ invited: 2, attending: 1 })
    // Once the planner sets Sam's invitation, Ana's no longer moves it.
    w.events.recordAnswer(w.ctx, w.planner, w.ours, w.brunch.event_id, w.sam.guest_id, { invited: true, status: 'attending' })
    w.events.recordAnswer(w.ctx, w.planner, w.ours, w.brunch.event_id, w.ana.guest_id, { invited: false, status: 'pending' })
    expect(brunch()).toMatchObject({ invited: 1, attending: 1 })
  })

  it('a plus-one the planner invited keeps the invitation after the household answers for them (issue #41, case C)', () => {
    const w = withEvents()
    // The brunch is invite-only: Ana is invited, and the planner invites Sam (her plus-one) directly too.
    w.events.recordAnswer(w.ctx, w.planner, w.ours, w.brunch.event_id, w.sam.guest_id, { invited: true, status: 'pending' })
    w.events.answerAsHousehold(w.grant, [{ guest_id: w.sam.guest_id, event_id: w.brunch.event_id, status: 'attending' }])
    w.events.recordAnswer(w.ctx, w.planner, w.ours, w.brunch.event_id, w.ana.guest_id, { invited: false, status: 'pending' })
    const brunch = w.events.view(w.ctx, w.planner, w.ours).events.find((e) => e.event.name === 'Brunch')?.counts
    expect(brunch).toMatchObject({ invited: 1, attending: 1 })
    expect(w.events.guestRsvps(w.ctx, w.planner, w.ours, w.sam.guest_id).find((r) => r.event.name === 'Brunch')).toMatchObject({ invited: true, answered_by: 'household' })
  })

  it('an event switched to invite-only drops a household-answered plus-one with their host (issue #41, case D)', () => {
    const w = withEvents()
    // The dinner invites everyone; the household answers for Sam only, and Ana has no record.
    w.events.answerAsHousehold(w.grant, [{ guest_id: w.sam.guest_id, event_id: w.dinner.event_id, status: 'attending' }])
    w.events.updateEvent(w.ctx, w.planner, w.ours, w.dinner.event_id, { name: 'Dinner', starts_at: '2028-06-10T18:00', invitation: 'selected', meal_options: w.dinner.meal_options })
    const dinner = w.events.view(w.ctx, w.planner, w.ours).events.find((e) => e.event.name === 'Dinner')?.counts
    expect(dinner).toMatchObject({ invited: 0, attending: 0 })
  })

  it('a record written before invitation_by by the planner still counts as the planner\'s invitation', () => {
    const w = withEvents()
    // As #29 wrote it: the planner un-invited Mei from the dinner, with no invitation_by on the record.
    w.store.put(COLLECTIONS.weddingRsvp, w.ctx.tenant_id, groupedKey(w.ours, `${w.dinner.event_id}:${w.mei.guest_id}`), {
      tenant_id: w.ctx.tenant_id,
      wedding_id: w.ours,
      event_id: w.dinner.event_id,
      guest_id: w.mei.guest_id,
      invited: false,
      status: 'pending',
      answered_by: 'planner',
      updated_at: '2027-06-01T00:00:00.000Z',
    })
    expect(w.events.guestRsvps(w.ctx, w.planner, w.ours, w.mei.guest_id).find((r) => r.event.name === 'Dinner')?.invited).toBe(false)
    expect(w.events.view(w.ctx, w.planner, w.ours).events.find((e) => e.event.name === 'Dinner')?.counts.invited).toBe(2)
  })

  it('an answer that changes nothing writes nothing: the planner\'s recorded answer keeps its provenance', () => {
    const w = withEvents()
    w.events.recordAnswer(w.ctx, w.planner, w.ours, w.dinner.event_id, w.ana.guest_id, { invited: true, status: 'declined' })
    w.events.answerAsHousehold(w.grant, [{ guest_id: w.ana.guest_id, event_id: w.dinner.event_id, status: 'declined' }])
    expect(w.events.guestRsvps(w.ctx, w.planner, w.ours, w.ana.guest_id)[1]).toMatchObject({ status: 'declined', answered_by: 'planner' })
  })

  it('refuses control characters, line separators and bidirectional overrides in a dietary note', () => {
    const w = withEvents()
    for (const note of ['a\u202eb', 'a\u2028b', 'a\u0085b', 'a\u2066b']) {
      expect(codeOf(() => w.guestList.setDietaryAsHousehold(w.grant, w.ana.guest_id, note))).toBe('PRODUCT.BAD_REQUEST')
    }
  })

  it('the planner closes RSVPs (the couple may not): the page shows it, and answers are refused', () => {
    const w = withEvents()
    expect(codeOf(() => w.events.setRsvpsClosed(w.ctx, w.couple, w.ours, true))).toBe('PRODUCT.FORBIDDEN')
    w.events.setRsvpsClosed(w.ctx, w.planner, w.ours, true)
    expect(w.events.householdView(w.grant).closed).toBe(true)
    expect(w.events.view(w.ctx, w.couple, w.ours).rsvps_closed).toBe(true)
    expect(codeOf(() => w.events.answerAsHousehold(w.grant, []))).toBe('PRODUCT.RSVPS_CLOSED')
    w.events.setRsvpsClosed(w.ctx, w.planner, w.ours, false)
    expect(codeOf(() => w.events.answerAsHousehold(w.grant, []))).toBe('NO_THROW')
  })
})
