import { ManualClock, SequentialIdGenerator } from '@wedding-planner/shared'
import { describe, expect, it } from 'vitest'

import { type ApiRequest, type ApiResponse, composeProductSurface, InMemoryRecordStore } from '@wedding-planner/product'

import { COLLECTIONS } from '../../src/persistence/collections'
import { keyPrefixOf } from '../../src/persistence/record_store'

/** Issue #29 — events and RSVPs over HTTP: the routes, the wedding boundary before any body, masking, validation. */

const NOT_FOUND: ApiResponse = { status: 404, body: { error: 'not_found' } }

function setup(store = new InMemoryRecordStore()) {
  const s = composeProductSurface({
    store,
    clock: new ManualClock('2027-06-01T00:00:00.000Z'),
    ids: new SequentialIdGenerator('ev'),
    operatorToken: 'ev-operator-token-0123456789',
    providerWebhookToken: 'ev-webhook-token-0123456789',
    demoSlug: 'demo',
    passwordCost: { N: 16, r: 1, p: 1 },
  })
  const call = (method: string, path: string, token?: string, body?: unknown): ApiResponse =>
    s.api.handle({
      method,
      path,
      headers: token === undefined ? {} : { authorization: `Bearer ${token}` },
      rawBody: body === undefined ? undefined : JSON.stringify(body),
    } as ApiRequest)
  const planner = (call('POST', '/t/demo/sessions', undefined, { role: 'planner' }).body as { token: string }).token
  const ours = s.demo?.weddingId as string
  const theirs = (call('POST', '/t/demo/weddings', planner, { couple_display_name: 'Sam & Kit', event_date: '2028-07-10' }).body as { wedding: { wedding_id: string } }).wedding.wedding_id
  const couple = (call('POST', '/t/demo/sessions', undefined, { role: 'couple', wedding_id: ours }).body as { token: string }).token
  const household = (call('POST', `/t/demo/weddings/${ours}/households`, planner, { name: 'Rivera' }).body as { household: { household_id: string } }).household.household_id
  const guest = (call('POST', `/t/demo/weddings/${ours}/guests`, planner, { household_id: household, first_name: 'Ana', side: 'both' }).body as { guest: { guest_id: string } }).guest.guest_id
  return { call, planner, couple, ours, theirs, guest, tenantId: s.demo?.tenantId as string }
}

describe('/t/:slug/weddings/:id/events and …/guests/:id/rsvps', () => {
  it('the couple adds an event, records an answer, and reads the counts and the guest\'s answers', () => {
    const w = setup()
    const created = w.call('POST', `/t/demo/weddings/${w.ours}/events`, w.couple, { name: 'Dinner', starts_at: '2028-06-10T18:00', location: 'Hall', meal_options: ['Fish', 'Veg'] })
    expect(created.status).toBe(201)
    const event = (created.body as { event: { event_id: string; meal_options: { option_id: string }[] } }).event
    const fish = event.meal_options[0]?.option_id as string
    const answered = w.call('PUT', `/t/demo/weddings/${w.ours}/events/${event.event_id}/rsvps/${w.guest}`, w.couple, { status: 'attending', meal_option_id: fish })
    expect(answered.status).toBe(200)
    expect((answered.body as { rsvp: unknown }).rsvp).toMatchObject({ invited: true, status: 'attending', meal_option_id: fish, answered_by: 'couple' })
    const view = w.call('GET', `/t/demo/weddings/${w.ours}/events`, w.planner).body as { events: { counts: { attending: number; meals: Record<string, number> } }[] }
    expect(view.events[0]?.counts).toMatchObject({ attending: 1, meals: { [fish]: 1 } })
    // A meal renamed by its id keeps the answer's choice.
    expect(w.call('PUT', `/t/demo/weddings/${w.ours}/events/${event.event_id}`, w.couple, { name: 'Dinner', starts_at: '2028-06-10T18:00', meal_options: [{ option_id: fish, label: 'Salmon' }] }).status).toBe(200)
    expect((w.call('GET', `/t/demo/weddings/${w.ours}/guests/${w.guest}/rsvps`, w.couple).body as { rsvps: { meal_option_id?: string }[] }).rsvps[0]?.meal_option_id).toBe(fish)
    const rsvps = w.call('GET', `/t/demo/weddings/${w.ours}/guests/${w.guest}/rsvps`, w.couple).body as { rsvps: { event: { name: string }; status: string }[] }
    expect(rsvps.rsvps.map((r) => [r.event.name, r.status])).toEqual([['Dinner', 'attending']])
    expect(w.call('PUT', `/t/demo/weddings/${w.ours}/events/${event.event_id}`, w.couple, { name: 'Supper', starts_at: '2028-06-10T19:00', invitation: 'selected' }).status).toBe(200)
    expect(w.call('DELETE', `/t/demo/weddings/${w.ours}/events/${event.event_id}`, w.couple).body).toEqual({ removed: true })
  })

  it('another wedding is masked exactly like a missing one, before any body is parsed', () => {
    const w = setup()
    for (const wedding of [w.theirs, 'wedding_missing']) {
      expect(w.call('GET', `/t/demo/weddings/${wedding}/events`, w.couple)).toEqual(NOT_FOUND)
      expect(w.call('POST', `/t/demo/weddings/${wedding}/events`, w.couple, { name: 7 })).toEqual(NOT_FOUND)
      expect(w.call('PUT', `/t/demo/weddings/${wedding}/events/event_x/rsvps/${w.guest}`, w.couple, { status: 'maybe' })).toEqual(NOT_FOUND)
      expect(w.call('GET', `/t/demo/weddings/${wedding}/guests/${w.guest}/rsvps`, w.couple)).toEqual(NOT_FOUND)
      expect(w.call('PATCH', `/t/demo/weddings/${wedding}/events`, w.couple)).toEqual(NOT_FOUND)
    }
    // An event or a guest that is not on this wedding is the same not-found.
    expect(w.call('PUT', `/t/demo/weddings/${w.ours}/events/event_x/rsvps/${w.guest}`, w.couple, { status: 'attending' })).toEqual(NOT_FOUND)
    expect(w.call('GET', `/t/demo/weddings/${w.ours}/guests/wguest_x/rsvps`, w.couple)).toEqual(NOT_FOUND)
  })

  it('deleting a guest or a household through the API removes their answers from the store (the composed hook)', () => {
    const store = new InMemoryRecordStore()
    const w = setup(store)
    const event = (w.call('POST', `/t/demo/weddings/${w.ours}/events`, w.planner, { name: 'Dinner', starts_at: '2028-06-10T18:00' }).body as { event: { event_id: string } }).event.event_id
    const household = (w.call('GET', `/t/demo/weddings/${w.ours}/guest-list`, w.planner).body as { households: { household_id: string }[] }).households[0]?.household_id as string
    const luis = (w.call('POST', `/t/demo/weddings/${w.ours}/guests`, w.planner, { household_id: household, first_name: 'Luis', side: 'both' }).body as { guest: { guest_id: string } }).guest.guest_id
    for (const g of [w.guest, luis]) expect(w.call('PUT', `/t/demo/weddings/${w.ours}/events/${event}/rsvps/${g}`, w.planner, { status: 'attending' }).status).toBe(200)
    const tenant = w.tenantId
    const stored = () => store.listByKeyPrefix(COLLECTIONS.weddingRsvp, tenant, keyPrefixOf(w.ours)).map((r) => r.guest_id)
    expect(stored()).toEqual([w.guest, luis])
    w.call('DELETE', `/t/demo/weddings/${w.ours}/guests/${w.guest}`, w.planner)
    expect(stored()).toEqual([luis])
    w.call('DELETE', `/t/demo/weddings/${w.ours}/households/${household}`, w.planner)
    expect(stored()).toEqual([])
  })

  it('validates bodies with 400s, refuses wrong methods with 405s, and bounds the events with 409', () => {
    const w = setup()
    const add = (body: object) => w.call('POST', `/t/demo/weddings/${w.ours}/events`, w.planner, body).status
    expect(add({ name: 'X' })).toBe(400)
    expect(add({ name: 'X', starts_at: 'tomorrow' })).toBe(400)
    expect(add({ name: 'X', starts_at: '2028-06-10T18:00', meal_options: 'fish' })).toBe(400)
    expect(add({ name: 'X', starts_at: '2028-06-10T18:00', location: 5 })).toBe(400)
    expect(add({ name: 'X', starts_at: '2028-06-10T18:00', invitation: 'some' })).toBe(400)
    expect(add({ name: 'X', starts_at: '2028-06-10T18:00', meal_options: [{ label: 7 }] })).toBe(400)
    expect(add({ name: 'X', starts_at: '2028-06-10T18:00', meal_options: [{ option_id: 'meal_x', label: 'Fish' }] })).toBe(400)
    const started = performance.now()
    expect(add({ name: 'X', starts_at: '2028-06-10T18:00', meal_options: Array.from({ length: 10_000 }, (_, i) => `m${i}`) })).toBe(400)
    expect(performance.now() - started).toBeLessThan(500)
    const event = (w.call('POST', `/t/demo/weddings/${w.ours}/events`, w.planner, { name: 'X', starts_at: '2028-06-10T18:00' }).body as { event: { event_id: string } }).event.event_id
    const answer = (body: object) => w.call('PUT', `/t/demo/weddings/${w.ours}/events/${event}/rsvps/${w.guest}`, w.planner, body).status
    expect(answer({ status: 'maybe' })).toBe(400)
    expect(answer({ status: 'attending', invited: 'yes' })).toBe(400)
    expect(answer({ status: 'attending', meal_option_id: 'meal_x' })).toBe(400)
    expect(answer({ status: 'declined', meal_option_id: 'meal_x' })).toBe(200) // a meal goes only with attending: dropped
    expect(w.call('GET', `/t/demo/weddings/${w.ours}/events/${event}/rsvps/${w.guest}`, w.planner).status).toBe(405)
    expect(w.call('POST', `/t/demo/weddings/${w.ours}/guests/${w.guest}/rsvps`, w.planner, {}).status).toBe(405)
    expect(w.call('GET', `/t/demo/weddings/${w.ours}/events/${event}/other`, w.planner).status).toBe(404)
    for (let i = 1; i < 12; i++) expect(add({ name: `E${i}`, starts_at: '2028-06-10T18:00' })).toBe(201)
    expect(add({ name: 'Thirteenth', starts_at: '2028-06-10T18:00' })).toBe(409)
  })
})
