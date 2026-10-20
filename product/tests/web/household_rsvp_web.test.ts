import { ManualClock, SequentialIdGenerator } from '@wedding-planner/shared'
import { describe, expect, it } from 'vitest'

import { type ApiRequest, composeProductSurface, type HttpResult } from '@wedding-planner/product'

/**
 * Issue #30 in the browser: the planner makes a household's RSVP link (shown once), the household answers on the
 * public themed page with the pre-session anti-forgery check, and anything that does not resolve is the generic
 * not-found. The page names only the household's own guests.
 */

function setup() {
  const s = composeProductSurface({
    clock: new ManualClock('2027-06-01T00:00:00.000Z'),
    ids: new SequentialIdGenerator('hrw'),
    operatorToken: 'hrw-operator-token-0123456789',
    providerWebhookToken: 'hrw-webhook-token-0123456789',
    demoSlug: 'demo',
    passwordCost: { N: 16, r: 1, p: 1 },
  })
  const login = (fields: Record<string, string>): string => {
    const res = s.ui.handle(form('/t/demo/login', fields))
    return `wp_session=${/wp_session=([^;]+)/.exec(res.headers['set-cookie'] ?? '')?.[1]}`
  }
  const ours = s.demo?.weddingId as string
  const planner = login({ role: 'planner' })
  const api = (method: string, path: string, token?: string, body?: unknown) =>
    s.api.handle({ method, path, headers: token === undefined ? {} : { authorization: `Bearer ${token}` }, rawBody: body === undefined ? undefined : JSON.stringify(body) })
  const bearer = (api('POST', '/t/demo/sessions', undefined, { role: 'planner' }).body as { token: string }).token
  const rivera = (api('POST', `/t/demo/weddings/${ours}/households`, bearer, { name: 'Rivera' }).body as { household: { household_id: string } }).household.household_id
  const chen = (api('POST', `/t/demo/weddings/${ours}/households`, bearer, { name: 'Chen' }).body as { household: { household_id: string } }).household.household_id
  api('POST', `/t/demo/weddings/${ours}/guests`, bearer, { household_id: rivera, first_name: 'Ana', last_name: 'Rivera', side: 'both' })
  api('POST', `/t/demo/weddings/${ours}/guests`, bearer, { household_id: chen, first_name: 'Mei', last_name: 'Chen', side: 'both' })
  api('POST', `/t/demo/weddings/${ours}/events`, bearer, { name: 'Dinner <b>', starts_at: '2028-06-10T18:00', meal_options: ['Fish', 'Veg'] })
  return { ...s, ours, planner, login, rivera, chen }
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
const preCookieOf = (page: HttpResult): string => `wp_pre=${/wp_pre=([^;]+)/.exec(page.headers['set-cookie'] ?? '')?.[1]}`

function makeLink(w: ReturnType<typeof setup>): { page: HttpResult; path: string } {
  const csrf = csrfOf(w.ui.handle(get(`/t/demo?wedding=${w.ours}&tab=guests`, w.planner)))
  const page = w.ui.handle(form('/t/demo/guest-list/rsvp-link', { _csrf: csrf, wedding_id: w.ours, household_id: w.rivera }, w.planner))
  const url = /value="(\/t\/demo\/rsvp\/[^"]+)"/.exec(page.body)?.[1] as string
  return { page, path: url }
}

describe('the household RSVP pages', () => {
  it('the planner makes the link once; the guest list then says when it was made', () => {
    const w = setup()
    const { page, path } = makeLink(w)
    expect(page.status).toBe(201)
    expect(page.body).toContain('RSVP link for Rivera')
    expect(path).toMatch(/^\/t\/demo\/rsvp\/rsvp_/)
    const list = w.ui.handle(get(`/t/demo?wedding=${w.ours}&tab=guests`, w.planner)).body
    expect(list).toContain('RSVP link made 2027-06-01.')
    expect(list).toContain('Make a new link (the old one stops working)')
    expect(list).not.toContain(path)
  })

  it('the household answers on the public page: only its own guests, pre-session anti-forgery, no referrer', () => {
    const w = setup()
    const { path } = makeLink(w)
    const page = w.ui.handle(get(path))
    expect(page.status).toBe(200)
    expect(page.headers['referrer-policy']).toBe('no-referrer')
    expect(page.body).toContain('RSVP for Rivera')
    expect(page.body).toContain('Ana Rivera')
    expect(page.body).toContain('Dinner &lt;b&gt;')
    expect(page.body).not.toContain('Mei')
    expect(page.body).not.toContain(w.demo?.weddingId as string)
    const fish = /<option value="([^"]+)">Fish<\/option>/.exec(page.body)?.[1] as string
    const fields = { _csrf: csrfOf(page), g0: /name="g0" value="([^"]+)"/.exec(page.body)?.[1] as string, e0: /name="e0" value="([^"]+)"/.exec(page.body)?.[1] as string, s0: 'attending', m0: fish, dg0: /name="dg0" value="([^"]+)"/.exec(page.body)?.[1] as string, d0: 'no nuts' }
    // Without the matching pre-session cookie: nothing saved, the page asks again.
    const forged = w.ui.handle(form(path, fields))
    expect(forged.status).toBe(400)
    expect(forged.body).toContain('This page was open too long')
    const saved = w.ui.handle(form(path, fields, preCookieOf(page)))
    expect(saved.status).toBe(303)
    expect(saved.headers.location).toBe(`${path}?saved=1`)
    const after = w.ui.handle(get(`${path}?saved=1`)).body
    expect(after).toContain('your answers are saved')
    expect(after).toContain('value="attending" checked')
    expect(after).toContain(`<option value="${fish}" selected>Fish</option>`)
    expect(after).toContain('value="no nuts"')
  })

  it('a junk form to a link that does not resolve is the not-found before any form work; an oversized form is refused', () => {
    const w = setup()
    const rows = Array.from({ length: 241 }, (_, i) => `g${i}=x&s${i}=attending&dg${i}=x`).join('&')
    const junk = `_csrf=abc&${'a='.repeat(150_000)}&${rows}`
    const started = performance.now()
    const res = w.ui.handle({ method: 'POST', path: '/t/demo/rsvp/rsvp_unknown', headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: 'wp_pre=abc' }, rawBody: junk })
    expect(performance.now() - started).toBeLessThan(100)
    expect(res.status).toBe(404)
    const { path } = makeLink(w)
    const page = w.ui.handle(get(path))
    const oversized = w.ui.handle({ method: 'POST', path, headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: preCookieOf(page) }, rawBody: `_csrf=${csrfOf(page)}&${'a=1&'.repeat(3000)}` })
    expect(oversized.status).toBe(400)
    expect(oversized.body).toContain('could not be saved')
  })

  it('a tab left open never reverts what the planner recorded since: only changed rows are sent', () => {
    const w = setup()
    const { path } = makeLink(w)
    const stale = w.ui.handle(get(path))
    const field = (name: string) => new RegExp(`name="${name}" value="([^"]*)"`).exec(stale.body)?.[1] as string
    // Meanwhile the planner records Ana as declined (the household's page still shows "no answer").
    const bearer = (w.api.handle({ method: 'POST', path: '/t/demo/sessions', headers: {}, rawBody: JSON.stringify({ role: 'planner' }) }).body as { token: string }).token
    w.api.handle({ method: 'PUT', path: `/t/demo/weddings/${w.ours}/events/${field('e0')}/rsvps/${field('g0')}`, headers: { authorization: `Bearer ${bearer}` }, rawBody: JSON.stringify({ status: 'declined' }) })
    // The household saves the old tab, changing only the dietary note.
    const saved = w.ui.handle(form(path, { _csrf: csrfOf(stale), g0: field('g0'), e0: field('e0'), o0: field('o0'), om0: '', dg0: field('dg0'), od0: '', d0: 'vegan' }, preCookieOf(stale)))
    expect(saved.status).toBe(303)
    const after = w.ui.handle(get(path)).body
    expect(after).toContain('value="declined" checked')
    expect(after).toContain('value="vegan"')
  })

  it('an unknown or replaced link is the console\'s generic not-found, identical to an unknown workspace', () => {
    const w = setup()
    const { path: first } = makeLink(w)
    makeLink(w)
    const unknownRoute = w.ui.handle(get('/t/nope/login'))
    for (const res of [w.ui.handle(get(first)), w.ui.handle(get('/t/demo/rsvp/rsvp_unknown')), w.ui.handle(form('/t/demo/rsvp/rsvp_unknown', { _csrf: 'x' }))]) {
      expect(res.status).toBe(404)
      expect(res.body).toBe(unknownRoute.body)
    }
  })

  it('the planner closes RSVPs from the events page (a couple is refused); the page then shows it closed', () => {
    const w = setup()
    const { path } = makeLink(w)
    const couple = w.login({ role: 'couple', wedding_id: w.ours })
    const coupleEvents = w.ui.handle(get(`/t/demo?wedding=${w.ours}&tab=events`, couple))
    expect(w.ui.handle(form('/t/demo/events/rsvp-close', { _csrf: csrfOf(coupleEvents), wedding_id: w.ours, closed: 'true' }, couple)).status).toBe(403)
    const events = w.ui.handle(get(`/t/demo?wedding=${w.ours}&tab=events`, w.planner))
    expect(events.body).toContain('Close RSVPs')
    const closed = w.ui.handle(form('/t/demo/events/rsvp-close', { _csrf: csrfOf(events), wedding_id: w.ours, closed: 'true' }, w.planner))
    expect(closed.headers.location).toBe(`/t/demo?wedding=${w.ours}&tab=events&notice=saved`)
    expect(w.ui.handle(get(`/t/demo?wedding=${w.ours}&tab=events`, w.planner)).body).toContain('Reopen RSVPs')
    const page = w.ui.handle(get(path))
    expect(page.body).toContain('disabled')
    expect(page.body).not.toContain('Save our answers')
    const refused = w.ui.handle(form(path, { _csrf: csrfOf(page) }, preCookieOf(page)))
    expect(refused.status).toBe(409)
    expect(refused.body).toContain('RSVPs are closed')
  })
})
