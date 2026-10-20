import { ManualClock, SequentialIdGenerator } from '@wedding-planner/shared'
import { describe, expect, it } from 'vitest'

import { type ApiRequest, type ApiResponse, composeProductSurface } from '@wedding-planner/product'

/** Issue #27 — the guest list over HTTP: the wedding boundary for planner and couple, masking, and validation. */

const NOT_FOUND: ApiResponse = { status: 404, body: { error: 'not_found' } }
const UNAUTHORIZED: ApiResponse = { status: 401, body: { error: 'unauthorized' } }

function setup() {
  const s = composeProductSurface({
    clock: new ManualClock('2027-06-01T00:00:00.000Z'),
    ids: new SequentialIdGenerator('gl'),
    operatorToken: 'gl-operator-token-0123456789',
    providerWebhookToken: 'gl-webhook-token-0123456789',
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
  return { call, planner, couple, ours, theirs }
}

describe('/t/:slug/weddings/:id/{guest-list,households,guests}', () => {
  it('a planner builds a list: households, guests, a plus-one, counts', () => {
    const w = setup()
    const h = w.call('POST', `/t/demo/weddings/${w.ours}/households`, w.planner, { name: 'The Rivera family' })
    expect(h.status).toBe(201)
    const hid = (h.body as { household: { household_id: string } }).household.household_id
    const host = w.call('POST', `/t/demo/weddings/${w.ours}/guests`, w.planner, {
      household_id: hid,
      first_name: 'Ana',
      last_name: 'Rivera',
      side: 'partner_one',
      tags: ['family'],
      plus_one_allowed: true,
      email: 'ana@example.test',
    })
    expect(host.status).toBe(201)
    const hostId = (host.body as { guest: { guest_id: string } }).guest.guest_id
    expect(w.call('POST', `/t/demo/weddings/${w.ours}/guests`, w.planner, { first_name: 'Guest', side: 'partner_one', plus_one_of: hostId }).status).toBe(201)
    expect(w.call('POST', `/t/demo/weddings/${w.ours}/guests`, w.planner, { first_name: 'Two', side: 'both', plus_one_of: hostId }).status).toBe(409)
    const view = w.call('GET', `/t/demo/weddings/${w.ours}/guest-list`, w.planner).body as { counts: Record<string, unknown> }
    expect(view.counts).toEqual({ guests: 2, households: 1, plus_ones: 1, by_side: { partner_one: 2, partner_two: 0, both: 0 } })
  })

  it('the couple manages its own wedding\'s list; another wedding is masked exactly like a missing one', () => {
    const w = setup()
    expect(w.call('POST', `/t/demo/weddings/${w.ours}/households`, w.couple, { name: 'Ours' }).status).toBe(201)
    expect(w.call('GET', `/t/demo/weddings/${w.ours}/guest-list`, w.couple).status).toBe(200)
    expect(w.call('GET', `/t/demo/weddings/${w.theirs}/guest-list`, w.couple)).toEqual(NOT_FOUND)
    expect(w.call('GET', '/t/demo/weddings/wedding_missing/guest-list', w.couple)).toEqual(NOT_FOUND)
    expect(w.call('POST', `/t/demo/weddings/${w.theirs}/households`, w.couple, { name: 'x' })).toEqual(NOT_FOUND)
    expect(w.call('GET', `/t/demo/weddings/${w.ours}/guest-list`)).toEqual(UNAUTHORIZED)
  })

  it('the wedding boundary runs before the body is parsed: a junk body to a foreign or missing wedding is the 404', () => {
    const w = setup()
    for (const wedding of [w.theirs, 'wedding_missing']) {
      expect(w.call('POST', `/t/demo/weddings/${wedding}/households`, w.couple, { name: 7 })).toEqual(NOT_FOUND)
      expect(w.call('POST', `/t/demo/weddings/${wedding}/guests`, w.couple, { side: 'left' })).toEqual(NOT_FOUND)
      expect(w.call('PUT', `/t/demo/weddings/${wedding}/guests/wguest_x`, w.couple, [])).toEqual(NOT_FOUND)
      expect(w.call('PATCH', `/t/demo/weddings/${wedding}/guest-list`, w.couple)).toEqual(NOT_FOUND)
    }
    // On its own wedding the same junk body is the 400 it always was.
    expect(w.call('POST', `/t/demo/weddings/${w.ours}/households`, w.couple, { name: 7 }).status).toBe(400)
  })

  it('edits and removals go through the same boundary; a sibling wedding\'s ids are not found', () => {
    const w = setup()
    const theirsHousehold = (w.call('POST', `/t/demo/weddings/${w.theirs}/households`, w.planner, { name: 'Theirs' }).body as { household: { household_id: string } }).household.household_id
    expect(w.call('PUT', `/t/demo/weddings/${w.ours}/households/${theirsHousehold}`, w.planner, { name: 'renamed' })).toEqual(NOT_FOUND)
    expect(w.call('DELETE', `/t/demo/weddings/${w.ours}/households/${theirsHousehold}`, w.planner).body).toEqual({ removed: false })
    expect(w.call('DELETE', `/t/demo/weddings/${w.theirs}/households/${theirsHousehold}`, w.couple)).toEqual(NOT_FOUND)
    expect(w.call('PUT', `/t/demo/weddings/${w.theirs}/households/${theirsHousehold}`, w.planner, { name: 'Renamed', address: '2 Elm' }).status).toBe(200)
  })

  it('POST …/guest-list/import previews, then imports; a foreign wedding is the 404 and a bad body a 400', () => {
    const w = setup()
    const csv = 'household,first_name\nRivera,Ana\nRivera,Luis\n'
    const preview = w.call('POST', `/t/demo/weddings/${w.ours}/guest-list/import`, w.couple, { csv })
    expect(preview).toEqual({ status: 200, body: { applied: false, problems: [], creates: 2, updates: 0, households_created: 1 } })
    expect(w.call('POST', `/t/demo/weddings/${w.ours}/guest-list/import`, w.couple, { csv, commit: 'yes' }).body).toMatchObject({ applied: false })
    expect(w.call('POST', `/t/demo/weddings/${w.ours}/guest-list/import`, w.couple, { csv, commit: true }).body).toMatchObject({ applied: true })
    expect((w.call('GET', `/t/demo/weddings/${w.ours}/guest-list`, w.couple).body as { counts: { guests: number } }).counts.guests).toBe(2)
    expect(w.call('POST', `/t/demo/weddings/${w.theirs}/guest-list/import`, w.couple, { csv, commit: true })).toEqual(NOT_FOUND)
    expect(w.call('POST', `/t/demo/weddings/${w.ours}/guest-list/import`, w.couple, { csv: 7 }).status).toBe(400)
    expect(w.call('POST', `/t/demo/weddings/${w.ours}/guest-list/import`, w.couple, { csv: 'household,first_name\n"open' }).body).toMatchObject({ applied: false, problems: [{ row: 1 }] })
    expect(w.call('GET', `/t/demo/weddings/${w.ours}/guest-list/import`, w.couple).status).toBe(405)
  })

  it('validates bodies (side, tags, booleans, names, email) with 400s', () => {
    const w = setup()
    const hid = (w.call('POST', `/t/demo/weddings/${w.ours}/households`, w.planner, { name: 'One' }).body as { household: { household_id: string } }).household.household_id
    const add = (body: object) => w.call('POST', `/t/demo/weddings/${w.ours}/guests`, w.planner, { household_id: hid, ...body }).status
    expect(add({ first_name: 'A', side: 'left' })).toBe(400)
    expect(add({ first_name: 'A', side: 'both', tags: 'family' })).toBe(400)
    expect(add({ first_name: 'A', side: 'both', plus_one_allowed: 'yes' })).toBe(400)
    expect(add({ side: 'both' })).toBe(400)
    expect(add({ first_name: 'A', side: 'both', email: 'not an email' })).toBe(400)
    expect(add({ first_name: 'A', side: 'both', household_id: 'household_nope' })).toBe(400)
    expect(w.call('PATCH', `/t/demo/weddings/${w.ours}/guests`, w.planner).status).toBe(405)
  })
})
