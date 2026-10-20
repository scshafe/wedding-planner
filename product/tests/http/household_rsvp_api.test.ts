import { ManualClock, SequentialIdGenerator } from '@wedding-planner/shared'
import { describe, expect, it } from 'vitest'

import { type ApiRequest, type ApiResponse, composeProductSurface } from '@wedding-planner/product'

/**
 * Issue #30 over HTTP: making RSVP links (planner or couple), closing RSVPs (planner), and the public
 * /t/:slug/household-rsvp/:token route — masked 404 for anything that does not resolve, all-or-nothing answers,
 * a 409 once closed, a 429 past the per-link limit.
 */

const NOT_FOUND: ApiResponse = { status: 404, body: { error: 'not_found' } }

function setup() {
  const clock = new ManualClock('2027-06-01T00:00:00.000Z')
  const s = composeProductSurface({
    clock,
    ids: new SequentialIdGenerator('hr'),
    operatorToken: 'hr-operator-token-0123456789',
    providerWebhookToken: 'hr-webhook-token-0123456789',
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
  const couple = (call('POST', '/t/demo/sessions', undefined, { role: 'couple', wedding_id: ours }).body as { token: string }).token
  const household = (call('POST', `/t/demo/weddings/${ours}/households`, planner, { name: 'Rivera' }).body as { household: { household_id: string } }).household.household_id
  const guest = (call('POST', `/t/demo/weddings/${ours}/guests`, planner, { household_id: household, first_name: 'Ana', side: 'both' }).body as { guest: { guest_id: string } }).guest.guest_id
  const event = (call('POST', `/t/demo/weddings/${ours}/events`, planner, { name: 'Dinner', starts_at: '2028-06-10T18:00' }).body as { event: { event_id: string } }).event.event_id
  const made = call('POST', `/t/demo/weddings/${ours}/households/${household}/rsvp-link`, couple)
  const token = decodeURIComponent((made.body as { url: string }).url.split('/rsvp/')[1] ?? '')
  return { call, clock, planner, couple, ours, household, guest, event, made, token }
}

describe('/t/:slug/household-rsvp/:token and the RSVP link routes', () => {
  it('the couple makes a link (201, shown once); the household reads its page and answers', () => {
    const w = setup()
    expect(w.made.status).toBe(201)
    expect((w.made.body as { url: string }).url).toMatch(/^\/t\/demo\/rsvp\/rsvp_/)
    expect(w.call('GET', `/t/demo/weddings/${w.ours}/rsvp-links`, w.planner).body).toEqual({ links: [{ household_id: w.household, created_at: '2027-06-01T00:00:00.000Z' }] })
    const page = w.call('GET', `/t/demo/household-rsvp/${w.token}`)
    expect(page.status).toBe(200)
    expect(page.body).toMatchObject({ household_name: 'Rivera', closed: false, events: [{ name: 'Dinner', answers: [{ guest_id: w.guest, status: 'pending' }] }] })
    const answered = w.call('POST', `/t/demo/household-rsvp/${w.token}`, undefined, { answers: [{ guest_id: w.guest, event_id: w.event, status: 'attending' }], dietary: [{ guest_id: w.guest, note: 'vegan' }] })
    expect(answered.status).toBe(200)
    expect(answered.body).toMatchObject({ guests: [{ dietary: 'vegan' }], events: [{ answers: [{ status: 'attending' }] }] })
    expect((w.call('GET', `/t/demo/weddings/${w.ours}/events`, w.planner).body as { events: { counts: { attending: number } }[] }).events[0]?.counts.attending).toBe(1)
  })

  it('an unknown, replaced or other-tenant token is the masked 404, for every method', () => {
    const w = setup()
    const old = w.token
    const fresh = decodeURIComponent((w.call('POST', `/t/demo/weddings/${w.ours}/households/${w.household}/rsvp-link`, w.planner).body as { url: string }).url.split('/rsvp/')[1] ?? '')
    for (const token of [old, 'rsvp_unknown', 'x'.repeat(300)]) {
      expect(w.call('GET', `/t/demo/household-rsvp/${token}`)).toEqual(NOT_FOUND)
      expect(w.call('POST', `/t/demo/household-rsvp/${token}`, undefined, { answers: [] })).toEqual(NOT_FOUND)
      expect(w.call('DELETE', `/t/demo/household-rsvp/${token}`)).toEqual(NOT_FOUND)
    }
    expect(w.call('GET', `/t/nope/household-rsvp/${fresh}`)).toEqual(NOT_FOUND)
    expect(w.call('GET', `/t/demo/household-rsvp/${fresh}`).status).toBe(200)
  })

  it('an answer outside the household is refused whole (400, nothing written); bodies are bounded', () => {
    const w = setup()
    const other = (w.call('POST', `/t/demo/weddings/${w.ours}/households`, w.planner, { name: 'Chen' }).body as { household: { household_id: string } }).household.household_id
    const mei = (w.call('POST', `/t/demo/weddings/${w.ours}/guests`, w.planner, { household_id: other, first_name: 'Mei', side: 'both' }).body as { guest: { guest_id: string } }).guest.guest_id
    const post = (body: unknown) => w.call('POST', `/t/demo/household-rsvp/${w.token}`, undefined, body).status
    expect(post({ answers: [{ guest_id: w.guest, event_id: w.event, status: 'attending' }, { guest_id: mei, event_id: w.event, status: 'attending' }] })).toBe(400)
    expect((w.call('GET', `/t/demo/household-rsvp/${w.token}`).body as { events: { answers: { status: string }[] }[] }).events[0]?.answers[0]?.status).toBe('pending')
    expect(post({ answers: [{ guest_id: w.guest, event_id: w.event, status: 'pending' }] })).toBe(400)
    expect(post({ answers: 'all' })).toBe(400)
    expect(post({ answers: Array.from({ length: 241 }, () => ({ guest_id: w.guest, event_id: w.event, status: 'attending' })) })).toBe(400)
    expect(post({ answers: [], dietary: [{ guest_id: w.guest, note: 'x'.repeat(301) }] })).toBe(400)
  })

  it('closing is the planner\'s (a couple gets 403); once closed, answers are a 409', () => {
    const w = setup()
    expect(w.call('PUT', `/t/demo/weddings/${w.ours}/rsvp-settings`, w.couple, { closed: true }).status).toBe(403)
    expect(w.call('PUT', `/t/demo/weddings/${w.ours}/rsvp-settings`, w.planner, { closed: 'yes' }).status).toBe(400)
    expect(w.call('PUT', `/t/demo/weddings/${w.ours}/rsvp-settings`, w.planner, { closed: true }).status).toBe(200)
    expect((w.call('GET', `/t/demo/household-rsvp/${w.token}`).body as { closed: boolean }).closed).toBe(true)
    expect(w.call('POST', `/t/demo/household-rsvp/${w.token}`, undefined, { answers: [] }).status).toBe(409)
  })

  it('more than 20 submissions from one link in ten minutes are a 429, until the window passes', () => {
    const w = setup()
    const post = () => w.call('POST', `/t/demo/household-rsvp/${w.token}`, undefined, { answers: [] }).status
    for (let i = 0; i < 20; i++) expect(post()).toBe(200)
    expect(post()).toBe(429)
    w.clock.advance(601_000)
    expect(post()).toBe(200)
  })
})
