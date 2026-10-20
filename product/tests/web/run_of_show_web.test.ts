import { ManualClock, SequentialIdGenerator } from '@wedding-planner/shared'
import { describe, expect, it } from 'vitest'

import { type ApiRequest, type ApiResponse, composeProductSurface, type HttpResult } from '@wedding-planner/product'

/** Issue #45 through the surface: the JSON routes, the page with its forms, the print view and the couple's view. */

function setup() {
  const s = composeProductSurface({
    clock: new ManualClock('2028-01-10T12:00:00.000Z'),
    ids: new SequentialIdGenerator('rw'),
    operatorToken: 'rw-operator-token-0123456789',
    providerWebhookToken: 'rw-webhook-token-0123456789',
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
  return { ...s, api, login, ours, theirs, bearer, coupleBearer }
}

const get = (path: string, cookie?: string): ApiRequest => ({ method: 'GET', path, headers: cookie === undefined ? {} : { cookie } })
function form(path: string, fields: Record<string, string>, cookie?: string): ApiRequest {
  return { method: 'POST', path, headers: { 'content-type': 'application/x-www-form-urlencoded', ...(cookie === undefined ? {} : { cookie }) }, rawBody: new URLSearchParams(fields).toString() }
}
const csrfOf = (page: HttpResult): string => /name="_csrf" value="([^"]+)"/.exec(page.body)?.[1] as string
const NOT_FOUND = { status: 404, body: { error: 'not_found' } }

describe('the run of show', () => {
  it('the planner page grows with items plus vendors, not items times vendors', () => {
    const w = setup()
    for (let v = 0; v < 40; v++) w.api('POST', `/t/demo/weddings/${w.ours}/vendors`, w.bearer, { category: 'other', category_other: 'x', business_name: `Vendor ${'&'.repeat(100)} ${v}`, contract_status: 'none' })
    for (let i = 0; i < 100; i++) w.api('POST', `/t/demo/weddings/${w.ours}/run-of-show`, w.bearer, { starts_at: '2028-06-10T16:00', title: `Item ${i}`, owner: 'planner' })
    const page = w.ui.handle(get(`/t/demo?wedding=${w.ours}&tab=run-of-show`, w.login({ role: 'planner' })))
    expect(page.status).toBe(200)
    expect(page.body.length).toBeLessThan(200_000)
  })

  it('JSON: the planner manages items; the couple reads (403 to manage, before the body); another wedding is the masked 404', () => {
    const w = setup()
    expect(w.api('POST', `/t/demo/weddings/${w.ours}/run-of-show`, w.coupleBearer, { junk: true }).status).toBe(403)
    const created = w.api('POST', `/t/demo/weddings/${w.ours}/run-of-show`, w.bearer, { starts_at: '2028-06-10T16:00', title: 'Vows', owner: 'couple' })
    expect(created.status).toBe(201)
    expect((w.api('GET', `/t/demo/weddings/${w.ours}/run-of-show`, w.coupleBearer).body as { lines: unknown[] }).lines).toHaveLength(1)
    for (const wedding of [w.theirs, 'wedding_missing']) {
      expect(w.api('GET', `/t/demo/weddings/${wedding}/run-of-show`, w.coupleBearer)).toEqual(NOT_FOUND)
      expect(w.api('POST', `/t/demo/weddings/${wedding}/run-of-show`, w.coupleBearer, { junk: true })).toEqual(NOT_FOUND)
    }
    expect(w.api('POST', `/t/demo/weddings/${w.ours}/run-of-show`, w.bearer, { starts_at: '2028-06-10T16:00', title: 'X', owner: 'guest' }).status).toBe(400)
    const id = (created.body as { item: { item_id: string } }).item.item_id
    expect(w.api('DELETE', `/t/demo/weddings/${w.ours}/run-of-show/${id}`, w.bearer).body).toEqual({ removed: true })
  })

  it('the page: the planner adds a vendor\'s item with a call time; the print view is the timeline alone; the couple reads it', () => {
    const w = setup()
    w.api('POST', `/t/demo/weddings/${w.ours}/vendors`, w.bearer, { category: 'photography', business_name: 'Snap <Studio>', contract_status: 'signed' })
    const planner = w.login({ role: 'planner' })
    const page = w.ui.handle(get(`/t/demo?wedding=${w.ours}&tab=run-of-show`, planner))
    expect(page.status).toBe(200)
    const vendor = /<option value="(vendor:[^"]+)">Snap &lt;Studio&gt;<\/option>/.exec(page.body)?.[1] as string
    const saved = w.ui.handle(form('/t/demo/run-of-show/show-add', { _csrf: csrfOf(page), wedding_id: w.ours, title: 'Portraits', starts_at: '2028-06-10T15:30', owner_choice: vendor, vendor_call_time: '2028-06-10T14:00', notes: 'secret note' }, planner))
    expect(saved.headers.location).toContain('notice=saved')
    const body = w.ui.handle(get(`/t/demo?wedding=${w.ours}&tab=run-of-show`, planner)).body
    expect(body.indexOf('Snap &lt;Studio&gt; arrives')).toBeLessThan(body.indexOf('<strong>15:30</strong> Portraits'))
    // One item's edit form at a time: the list links to it.
    expect(body).not.toContain('show-update')
    const itemId = /&amp;item=([^"]+)"/.exec(body)?.[1] as string
    expect(w.ui.handle(get(`/t/demo?wedding=${w.ours}&tab=run-of-show&item=${itemId}`, planner)).body).toContain('show-update')
    const print = w.ui.handle(get(`/t/demo?wedding=${w.ours}&tab=run-of-show&print=1`, planner)).body
    expect(print).toContain('Portraits')
    expect(print).not.toContain('<form')
    expect(w.ui.handle(form('/t/demo/run-of-show/show-add', { _csrf: csrfOf(page), wedding_id: w.ours, title: 'X', starts_at: '2028-06-10T15:30', owner_choice: 'planner', vendor_call_time: '2028-06-10T14:00' }, planner)).headers.location).toContain('notice=invalid')
    const couple = w.login({ role: 'couple', wedding_id: w.ours })
    const coupleBody = w.ui.handle(get(`/t/demo?wedding=${w.ours}&tab=run-of-show`, couple)).body
    expect(coupleBody).toContain('Portraits')
    expect(coupleBody).toContain('A vendor')
    expect(coupleBody).not.toContain('arrives')
    expect(coupleBody).not.toContain('Snap')
    expect(coupleBody).not.toContain('secret note')
    expect(coupleBody).not.toContain('Add to the run of show')
    expect(w.ui.handle(get(`/t/demo?wedding=${w.theirs}&tab=run-of-show`, couple)).status).toBe(404)
  })
})
