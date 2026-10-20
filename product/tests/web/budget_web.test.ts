import { ManualClock, SequentialIdGenerator } from '@wedding-planner/shared'
import { describe, expect, it } from 'vitest'

import { type ApiRequest, type ApiResponse, composeProductSurface, type HttpResult } from '@wedding-planner/product'

/** Issue #34 through the surface: the JSON routes (planner manages, couple reads shared), the page and its forms. */

function setup() {
  const s = composeProductSurface({
    clock: new ManualClock('2028-01-10T12:00:00.000Z'),
    ids: new SequentialIdGenerator('bw'),
    operatorToken: 'bw-operator-token-0123456789',
    providerWebhookToken: 'bw-webhook-token-0123456789',
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

function get(path: string, cookie?: string): ApiRequest {
  return { method: 'GET', path, headers: cookie === undefined ? {} : { cookie } }
}

function form(path: string, fields: Record<string, string>, cookie?: string): ApiRequest {
  return { method: 'POST', path, headers: { 'content-type': 'application/x-www-form-urlencoded', ...(cookie === undefined ? {} : { cookie }) }, rawBody: new URLSearchParams(fields).toString() }
}

const csrfOf = (page: HttpResult): string => /name="_csrf" value="([^"]+)"/.exec(page.body)?.[1] as string
const NOT_FOUND = { status: 404, body: { error: 'not_found' } }

describe('the budget', () => {
  it('JSON: the planner manages lines; the couple reads shared ones (403 to manage); another wedding is the masked 404', () => {
    const w = setup()
    expect(w.api('POST', `/t/demo/weddings/${w.ours}/budget`, w.coupleBearer, { junk: true }).status).toBe(403)
    const created = w.api('POST', `/t/demo/weddings/${w.ours}/budget`, w.bearer, { name: 'Flowers', estimated_cents: 80000, actual_cents: 90000, paid_cents: 10000, shared_with_couple: true })
    expect(created.status).toBe(201)
    const id = (created.body as { category: { category_id: string } }).category.category_id
    expect((w.api('GET', `/t/demo/weddings/${w.ours}/budget`, w.coupleBearer).body as { totals: { due_cents: number } }).totals.due_cents).toBe(80000)
    expect(w.api('PUT', `/t/demo/weddings/${w.ours}/budget/${id}`, w.bearer, { name: 'Flowers', estimated_cents: 1, shared_with_couple: false }).status).toBe(200)
    expect((w.api('GET', `/t/demo/weddings/${w.ours}/budget`, w.coupleBearer).body as { lines: unknown[] }).lines).toEqual([])
    for (const wedding of [w.theirs, 'wedding_missing']) {
      expect(w.api('GET', `/t/demo/weddings/${wedding}/budget`, w.coupleBearer)).toEqual(NOT_FOUND)
      expect(w.api('POST', `/t/demo/weddings/${wedding}/budget`, w.coupleBearer, { junk: true })).toEqual(NOT_FOUND)
    }
    expect(w.api('POST', `/t/demo/weddings/${w.ours}/budget`, w.bearer, { name: 'X', estimated_cents: '5' }).status).toBe(400)
    expect(w.api('POST', `/t/demo/weddings/${w.ours}/budget`, w.bearer, { name: 'X', estimated_cents: 5, vendor_id: 'vendor_nope' }).status).toBe(400)
    expect(w.api('DELETE', `/t/demo/weddings/${w.ours}/budget/${id}`, w.bearer).body).toEqual({ removed: true })
  })

  it('the page: the planner adds a line in dollars linked to a vendor and sees the totals; the couple sees it read-only', () => {
    const w = setup()
    w.api('POST', `/t/demo/weddings/${w.ours}/vendors`, w.bearer, { category: 'flowers', business_name: 'Bloom', contract_status: 'signed', installments: [{ label: 'All', amount_cents: 75000, due_date: '2028-03-01' }] })
    const planner = w.login({ role: 'planner' })
    const page = w.ui.handle(get(`/t/demo?wedding=${w.ours}&tab=budget`, planner))
    expect(page.status).toBe(200)
    const vendorId = /<option value="(vendor_[^"]+)">Bloom<\/option>/.exec(page.body)?.[1] as string
    const saved = w.ui.handle(form('/t/demo/budget/budget-add', { _csrf: csrfOf(page), wedding_id: w.ours, name: 'Flowers <&>', estimated: '700', vendor_id: vendorId, actual: '', paid: '', shared_with_couple: 'true' }, planner))
    expect(saved.headers.location).toContain('notice=saved')
    const body = w.ui.handle(get(`/t/demo?wedding=${w.ours}&tab=budget`, planner)).body
    expect(body).toContain('Flowers &lt;&amp;&gt;')
    expect(body).toContain('Estimated $700.00 · actual $750.00 · paid $0.00 · still due $750.00')
    expect(body).toContain('$50.00 over the estimate.')
    expect(body).toContain('2028-03-01')
    expect(w.ui.handle(form('/t/demo/budget/budget-add', { _csrf: csrfOf(page), wedding_id: w.ours, name: 'Bad', estimated: '1.234' }, planner)).headers.location).toContain('notice=invalid')
    const couple = w.login({ role: 'couple', wedding_id: w.ours })
    const coupleBody = w.ui.handle(get(`/t/demo?wedding=${w.ours}&tab=budget`, couple)).body
    expect(coupleBody).toContain('Flowers &lt;&amp;&gt;')
    expect(coupleBody).not.toContain('Bloom') // the vendor is not shared
    expect(coupleBody).not.toContain('Add a line')
    expect(w.ui.handle(get(`/t/demo?wedding=${w.theirs}&tab=budget`, couple)).status).toBe(404)
  })
})
