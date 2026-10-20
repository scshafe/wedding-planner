import { ManualClock, SequentialIdGenerator } from '@wedding-planner/shared'
import { describe, expect, it } from 'vitest'

import { type ApiRequest, type ApiResponse, composeProductSurface, type HttpResult } from '@wedding-planner/product'

/** Issue #46 through the surface: the JSON routes, the page, the printable table list, and the boundary. */

function setup() {
  const s = composeProductSurface({
    clock: new ManualClock('2028-01-10T12:00:00.000Z'),
    ids: new SequentialIdGenerator('sw'),
    operatorToken: 'sw-operator-token-0123456789',
    providerWebhookToken: 'sw-webhook-token-0123456789',
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
  const household = (api('POST', `/t/demo/weddings/${ours}/households`, bearer, { name: 'Rivera' }).body as { household: { household_id: string } }).household.household_id
  const ana = (api('POST', `/t/demo/weddings/${ours}/guests`, bearer, { household_id: household, first_name: 'Ana', last_name: '<Rivera>', side: 'both', dietary: 'vegan' }).body as { guest: { guest_id: string } }).guest.guest_id
  return { ...s, api, login, ours, theirs, bearer, coupleBearer, household, ana }
}

const get = (path: string, cookie?: string): ApiRequest => ({ method: 'GET', path, headers: cookie === undefined ? {} : { cookie } })
function form(path: string, fields: Record<string, string>, cookie?: string): ApiRequest {
  return { method: 'POST', path, headers: { 'content-type': 'application/x-www-form-urlencoded', ...(cookie === undefined ? {} : { cookie }) }, rawBody: new URLSearchParams(fields).toString() }
}
const csrfOf = (page: HttpResult): string => /name="_csrf" value="([^"]+)"/.exec(page.body)?.[1] as string
const NOT_FOUND = { status: 404, body: { error: 'not_found' } }

describe('seating', () => {
  it('the page grows with guests plus tables, not guests times tables', () => {
    const w = setup()
    for (let t = 0; t < 40; t++) w.api('POST', `/t/demo/weddings/${w.ours}/seating/tables`, w.bearer, { name: `Table ${'&'.repeat(50)} ${t}`, capacity: 10 })
    for (let g = 0; g < 200; g++) w.api('POST', `/t/demo/weddings/${w.ours}/guests`, w.bearer, { household_id: w.household, first_name: `Guest${g}`, side: 'both' })
    const page = w.ui.handle(get(`/t/demo?wedding=${w.ours}&tab=seating`, w.login({ role: 'planner' })))
    expect(page.status).toBe(200)
    expect(page.body.length).toBeLessThan(250_000)
  })

  it('JSON: the couple manages its own seating; a full table is a 409; another wedding is the masked 404', () => {
    const w = setup()
    const table = (w.api('POST', `/t/demo/weddings/${w.ours}/seating/tables`, w.coupleBearer, { name: 'T1', capacity: 1 }).body as { table: { table_id: string } }).table.table_id
    expect(w.api('PUT', `/t/demo/weddings/${w.ours}/seating/households/${w.household}`, w.coupleBearer, { table_id: table }).status).toBe(200)
    const bo = (w.api('POST', `/t/demo/weddings/${w.ours}/guests`, w.bearer, { household_id: w.household, first_name: 'Bo', side: 'both' }).body as { guest: { guest_id: string } }).guest.guest_id
    expect(w.api('PUT', `/t/demo/weddings/${w.ours}/seating/seats/${bo}`, w.coupleBearer, { table_id: table }).status).toBe(409)
    expect(w.api('PUT', `/t/demo/weddings/${w.ours}/seating/seats/${w.ana}`, w.coupleBearer, { table_id: null }).body).toEqual({ seated: false })
    for (const wedding of [w.theirs, 'wedding_missing']) {
      expect(w.api('GET', `/t/demo/weddings/${wedding}/seating`, w.coupleBearer)).toEqual(NOT_FOUND)
      expect(w.api('POST', `/t/demo/weddings/${wedding}/seating/tables`, w.coupleBearer, { junk: true })).toEqual(NOT_FOUND)
    }
    expect(w.api('POST', `/t/demo/weddings/${w.ours}/seating/tables`, w.bearer, { name: 'X', capacity: '8' }).status).toBe(400)
    expect(w.api('PUT', `/t/demo/weddings/${w.ours}/seating/seats/${w.ana}`, w.bearer, { table_id: 7 }).status).toBe(400)
  })

  it('the page: add a table, seat a guest, and print the table list with dietary notes', () => {
    const w = setup()
    const planner = w.login({ role: 'planner' })
    const page = w.ui.handle(get(`/t/demo?wedding=${w.ours}&tab=seating`, planner))
    expect(page.status).toBe(200)
    expect(page.body).toContain('No events yet')
    const csrf = csrfOf(page)
    expect(w.ui.handle(form('/t/demo/seating/table-add', { _csrf: csrf, wedding_id: w.ours, event_id: '', name: 'Head <table>', capacity: '8' }, planner)).headers.location).toContain('notice=saved')
    const withTable = w.ui.handle(get(`/t/demo?wedding=${w.ours}&tab=seating`, planner)).body
    const tableId = /<option value="([^"]+)">Head &lt;table&gt; \(8 free\)<\/option>/.exec(withTable)?.[1] as string
    expect(w.ui.handle(form('/t/demo/seating/seat-guest', { _csrf: csrf, wedding_id: w.ours, event_id: '', guest_id: w.ana, table_id: tableId }, planner)).headers.location).toContain('notice=saved')
    const print = w.ui.handle(get(`/t/demo?wedding=${w.ours}&tab=seating&print=1`, planner)).body
    expect(print).toContain('Head &lt;table&gt; (1/8)')
    expect(print).toContain('Ana &lt;Rivera&gt;')
    expect(print).toContain('(vegan)')
    expect(print).not.toContain('<form')
    expect(w.ui.handle(form('/t/demo/seating/table-add', { _csrf: csrf, wedding_id: w.ours, event_id: '', name: 'X', capacity: '99' }, planner)).headers.location).toContain('notice=invalid')
    const couple = w.login({ role: 'couple', wedding_id: w.ours })
    expect(w.ui.handle(get(`/t/demo?wedding=${w.theirs}&tab=seating`, couple)).status).toBe(404)
  })
})
