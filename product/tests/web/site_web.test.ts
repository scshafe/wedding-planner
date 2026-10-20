import { ManualClock, SequentialIdGenerator } from '@wedding-planner/shared'
import { describe, expect, it } from 'vitest'

import { type ApiRequest, type ApiResponse, composeProductSurface, type HttpResult } from '@wedding-planner/product'

/** Issue #47 through the surface: editing (planner and couple), the public page, masking, escaping, rate limiting. */

function setup() {
  const clock = new ManualClock('2028-01-10T12:00:00.000Z')
  const s = composeProductSurface({
    clock,
    ids: new SequentialIdGenerator('ws'),
    operatorToken: 'ws-operator-token-0123456789',
    providerWebhookToken: 'ws-webhook-token-0123456789',
    demoSlug: 'demo',
    passwordCost: { N: 16, r: 1, p: 1 },
  })
  const api = (method: string, path: string, token?: string, body?: unknown): ApiResponse =>
    s.api.handle({ method, path, headers: token === undefined ? {} : { authorization: `Bearer ${token}` }, rawBody: body === undefined ? undefined : JSON.stringify(body) } as ApiRequest)
  const login = (fields: Record<string, string>): string => {
    const res = s.ui.handle(form('/t/demo/login', fields))
    return `wp_session=${/wp_session=([^;]+)/.exec(res.headers['set-cookie'] ?? '')?.[1]}`
  }
  const ours = s.demo?.weddingId as string
  const bearer = (api('POST', '/t/demo/sessions', undefined, { role: 'planner' }).body as { token: string }).token
  const coupleBearer = (api('POST', '/t/demo/sessions', undefined, { role: 'couple', wedding_id: ours }).body as { token: string }).token
  const theirs = (api('POST', '/t/demo/weddings', bearer, { couple_display_name: 'Sam & Kit', event_date: '2028-07-10' }).body as { wedding: { wedding_id: string } }).wedding.wedding_id
  return { ...s, clock, api, login, ours, theirs, bearer, coupleBearer }
}

const get = (path: string, cookie?: string): ApiRequest => ({ method: 'GET', path, headers: cookie === undefined ? {} : { cookie } })
function form(path: string, fields: Record<string, string>, cookie?: string): ApiRequest {
  return { method: 'POST', path, headers: { 'content-type': 'application/x-www-form-urlencoded', ...(cookie === undefined ? {} : { cookie }) }, rawBody: new URLSearchParams(fields).toString() }
}
const csrfOf = (page: HttpResult): string => /name="_csrf" value="([^"]+)"/.exec(page.body)?.[1] as string
const NOT_FOUND = { status: 404, body: { error: 'not_found' } }

describe('the wedding website', () => {
  it('the couple makes and publishes the site; the public page shows it, escaped, with safe links', () => {
    const w = setup()
    const couple = w.login({ role: 'couple', wedding_id: w.ours })
    const page = w.ui.handle(get(`/t/demo?wedding=${w.ours}&tab=site`, couple))
    expect(page.status).toBe(200)
    const csrf = csrfOf(page)
    const saved = w.ui.handle(form('/t/demo/site/site-save', { _csrf: csrf, wedding_id: w.ours, site_name: 'jo-and-lee', welcome: 'Hello <b>friends</b>', r0_label: 'Shop & more', r0_url: 'https://shop.example/a?b=1&c=2', f0_q: 'Kids?', f0_a: 'Yes' }, couple))
    expect(saved.headers.location).toContain('notice=saved')
    // Unpublished: the generic not-found, identical to an unknown site and an unknown workspace.
    const unknownWorkspace = w.ui.handle(get('/t/nope/login'))
    for (const path of ['/t/demo/w/jo-and-lee', '/t/demo/w/nobody-here', '/t/demo/w/BAD_NAME']) {
      const res = w.ui.handle(get(path))
      expect(res.status).toBe(404)
      expect(res.body).toBe(unknownWorkspace.body)
    }
    expect(w.ui.handle(form('/t/demo/site/site-publish', { _csrf: csrf, wedding_id: w.ours, published: 'true' }, couple)).headers.location).toContain('notice=published')
    const site = w.ui.handle(get('/t/demo/w/jo-and-lee'))
    expect(site.status).toBe(200)
    expect(site.headers['referrer-policy']).toBe('no-referrer')
    expect(site.body).toContain('Hello &lt;b&gt;friends&lt;/b&gt;')
    expect(site.body).toContain('href="https://shop.example/a?b=1&amp;c=2" rel="noopener noreferrer nofollow">Shop &amp; more</a>')
    expect(site.body).toContain('RSVP link sent to your household')
    expect(site.body).not.toContain(w.ours)
  })

  it('JSON: the boundary for editing; a taken name is a 409; bad links are 400s; another wedding is the masked 404', () => {
    const w = setup()
    expect(w.api('PUT', `/t/demo/weddings/${w.ours}/site`, w.coupleBearer, { site_name: 'our-day' }).status).toBe(200)
    expect(w.api('PUT', `/t/demo/weddings/${w.theirs}/site`, w.bearer, { site_name: 'our-day' }).status).toBe(409)
    expect(w.api('PUT', `/t/demo/weddings/${w.ours}/site`, w.bearer, { site_name: 'our-day', registry: [{ label: 'X', url: 'javascript:alert(1)' }] }).status).toBe(400)
    for (const wedding of [w.theirs, 'wedding_missing']) {
      expect(w.api('GET', `/t/demo/weddings/${wedding}/site`, w.coupleBearer)).toEqual(NOT_FOUND)
      expect(w.api('PUT', `/t/demo/weddings/${wedding}/site`, w.coupleBearer, { junk: true })).toEqual(NOT_FOUND)
    }
    expect(w.api('GET', '/t/demo/site/our-day')).toEqual(NOT_FOUND) // not published
    expect(w.api('PUT', `/t/demo/weddings/${w.ours}/site/published`, w.coupleBearer, { published: true }).status).toBe(200)
    expect(w.api('GET', '/t/demo/site/our-day').status).toBe(200)
    expect(w.api('POST', '/t/demo/site/our-day')).toEqual(NOT_FOUND)
  })

  it('public reads of one site are rate-limited (600 per ten minutes)', () => {
    const w = setup()
    w.api('PUT', `/t/demo/weddings/${w.ours}/site`, w.bearer, { site_name: 'busy-site' })
    w.api('PUT', `/t/demo/weddings/${w.ours}/site/published`, w.bearer, { published: true })
    for (let i = 0; i < 600; i++) expect(w.api('GET', '/t/demo/site/busy-site').status).toBe(200)
    expect(w.api('GET', '/t/demo/site/busy-site').status).toBe(429)
    w.clock.advance(601_000)
    expect(w.api('GET', '/t/demo/site/busy-site').status).toBe(200)
  })
})
