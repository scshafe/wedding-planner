import { ManualClock, SequentialIdGenerator } from '@wedding-planner/shared'
import { describe, expect, it } from 'vitest'

import { type ApiRequest, composeProductSurface, type HttpResult } from '@wedding-planner/product'

/** Issue #29 in the browser: the events page, RSVPs on a guest's page, counts on the wedding, CSRF and the boundary. */

function setup() {
  const s = composeProductSurface({
    clock: new ManualClock('2027-06-01T00:00:00.000Z'),
    ids: new SequentialIdGenerator('evw'),
    operatorToken: 'evw-operator-token-0123456789',
    providerWebhookToken: 'evw-webhook-token-0123456789',
    demoSlug: 'demo',
    passwordCost: { N: 16, r: 1, p: 1 },
  })
  const login = (fields: Record<string, string>): string => {
    const res = s.ui.handle(form('/t/demo/login', fields))
    return `wp_session=${/wp_session=([^;]+)/.exec(res.headers['set-cookie'] ?? '')?.[1]}`
  }
  return { ...s, ours: s.demo?.weddingId as string, planner: login({ role: 'planner' }), login }
}

function get(path: string, cookie?: string): ApiRequest {
  return { method: 'GET', path, headers: cookie === undefined ? {} : { cookie } }
}

function form(path: string, fields: Record<string, string>, cookie?: string): ApiRequest {
  return {
    method: 'POST',
    path,
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...(cookie === undefined ? {} : { cookie }) },
    rawBody: new URLSearchParams(fields).toString(),
  }
}

const csrfOf = (page: HttpResult): string => /name="_csrf" value="([^"]+)"/.exec(page.body)?.[1] as string

describe('the events pages', () => {
  it('a planner adds an event, records a guest\'s answer on the guest page, and sees the counts', () => {
    const w = setup()
    const page = w.ui.handle(get(`/t/demo?wedding=${w.ours}&tab=events`, w.planner))
    expect(page.status).toBe(200)
    expect(page.body).toContain('Events &amp; RSVPs')
    const csrf = csrfOf(page)
    const added = w.ui.handle(
      form('/t/demo/events/event-add', { _csrf: csrf, wedding_id: w.ours, name: 'Dinner <b>', starts_at: '2028-06-10T18:00', location: 'Hall', meal_options: 'Fish\r\nVeg\r\n' }, w.planner),
    )
    expect(added.headers.location).toBe(`/t/demo?wedding=${w.ours}&tab=events&notice=saved`)
    const events = w.ui.handle(get(`/t/demo?wedding=${w.ours}&tab=events&notice=saved`, w.planner)).body
    expect(events).toContain('Dinner &lt;b&gt;')
    expect(events).toContain('0 attending · 0 declined · 0 pending (of 0 invited)')

    w.ui.handle(form('/t/demo/guest-list/household-add', { _csrf: csrf, wedding_id: w.ours, name: 'Rivera' }, w.planner))
    const householdId = /name="household_id" value="(household_[^"]+)"/.exec(w.ui.handle(get(`/t/demo?wedding=${w.ours}&tab=guests`, w.planner)).body)?.[1] as string
    w.ui.handle(form('/t/demo/guest-list/guest-add', { _csrf: csrf, wedding_id: w.ours, household_id: householdId, first_name: 'Ana', side: 'both' }, w.planner))
    const guestId = /guest=(wguest_[^"&]+)/.exec(w.ui.handle(get(`/t/demo?wedding=${w.ours}&tab=guests`, w.planner)).body)?.[1] as string
    const edit = w.ui.handle(get(`/t/demo?wedding=${w.ours}&tab=guests&guest=${guestId}`, w.planner))
    expect(edit.body).toContain('RSVPs')
    const eventId = /name="event_id" value="([^"]+)"/.exec(edit.body)?.[1] as string
    const veg = /<option value="([^"]+)">Veg<\/option>/.exec(edit.body)?.[1] as string
    const saved = w.ui.handle(
      form('/t/demo/events/rsvp-set', { _csrf: csrf, wedding_id: w.ours, guest_id: guestId, event_id: eventId, invited: 'true', status: 'attending', meal_option_id: veg }, w.planner),
    )
    expect(saved.headers.location).toBe(`/t/demo?wedding=${w.ours}&tab=guests&guest=${guestId}&notice=saved`)
    const after = w.ui.handle(get(`/t/demo?wedding=${w.ours}&tab=guests&guest=${guestId}&notice=saved`, w.planner)).body
    expect(after).toContain('<option value="attending" selected>Attending</option>')
    expect(after).toContain(`<option value="${veg}" selected>Veg</option>`)
    expect(after).toContain('Saved.')
    const detail = w.ui.handle(get(`/t/demo?wedding=${w.ours}`, w.planner)).body
    expect(detail).toContain('1 attending · 0 declined · 0 pending (of 1 invited)')
    expect(detail).toContain('Meals — Fish: 0 · Veg: 1')
    expect(detail).toContain('tab=events')

    const bad = w.ui.handle(form('/t/demo/events/rsvp-set', { _csrf: csrf, wedding_id: w.ours, guest_id: guestId, event_id: eventId, invited: 'true', status: 'declined', meal_option_id: veg }, w.planner))
    expect(bad.headers.location).toBe(`/t/demo?wedding=${w.ours}&tab=guests&guest=${guestId}&notice=invalid`)
  })

  it('edits and removes an event; a bad date comes back with a notice; a forged form changes nothing', () => {
    const w = setup()
    const csrf = csrfOf(w.ui.handle(get(`/t/demo?wedding=${w.ours}&tab=events`, w.planner)))
    expect(w.ui.handle(form('/t/demo/events/event-add', { _csrf: 'forged', wedding_id: w.ours, name: 'X', starts_at: '2028-06-10T18:00' }, w.planner)).status).toBe(403)
    expect(w.ui.handle(form('/t/demo/events/event-add', { _csrf: csrf, wedding_id: w.ours, name: 'X', starts_at: 'soon' }, w.planner)).headers.location).toContain('notice=invalid')
    w.ui.handle(form('/t/demo/events/event-add', { _csrf: csrf, wedding_id: w.ours, name: 'Ceremony', starts_at: '2028-06-10T16:00' }, w.planner))
    const eventId = /name="event_id" value="([^"]+)"/.exec(w.ui.handle(get(`/t/demo?wedding=${w.ours}&tab=events`, w.planner)).body)?.[1] as string
    w.ui.handle(form('/t/demo/events/event-update', { _csrf: csrf, wedding_id: w.ours, event_id: eventId, name: 'Vows', starts_at: '2028-06-10T16:30', location: '' }, w.planner))
    expect(w.ui.handle(get(`/t/demo?wedding=${w.ours}&tab=events`, w.planner)).body).toContain('2028-06-10 16:30')
    const removed = w.ui.handle(form('/t/demo/events/event-remove', { _csrf: csrf, wedding_id: w.ours, event_id: eventId }, w.planner))
    expect(removed.headers.location).toBe(`/t/demo?wedding=${w.ours}&tab=events&notice=removed`)
    expect(w.ui.handle(get(`/t/demo?wedding=${w.ours}&tab=events`, w.planner)).body).not.toContain('Vows')
  })

  it('a couple manages its own wedding\'s events; another wedding is the generic not-found', () => {
    const w = setup()
    const couple = w.login({ role: 'couple', wedding_id: w.ours })
    const page = w.ui.handle(get(`/t/demo?wedding=${w.ours}&tab=events`, couple))
    expect(page.status).toBe(200)
    const foreignPage = w.ui.handle(get('/t/demo?wedding=wedding_other&tab=events', couple))
    const foreignPost = w.ui.handle(form('/t/demo/events/event-add', { _csrf: csrfOf(page), wedding_id: 'wedding_other', name: 'X', starts_at: '2028-06-10T18:00' }, couple))
    expect(foreignPage.status).toBe(404)
    expect(foreignPost.status).toBe(404)
    expect(foreignPost.body).toBe(foreignPage.body)
  })
})
