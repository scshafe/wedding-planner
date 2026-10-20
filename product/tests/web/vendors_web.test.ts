import { ManualClock, SequentialIdGenerator } from '@wedding-planner/shared'
import { describe, expect, it } from 'vitest'

import { type ApiRequest, type ApiResponse, composeProductSurface, type HttpResult, VENDOR_LIMITS } from '@wedding-planner/product'

/** Issue #33 through the surface: the JSON routes (planner manages, couple reads shared), the page and its forms. */

function setup() {
  const s = composeProductSurface({
    clock: new ManualClock('2028-01-10T12:00:00.000Z'),
    ids: new SequentialIdGenerator('vw'),
    operatorToken: 'vw-operator-token-0123456789',
    providerWebhookToken: 'vw-webhook-token-0123456789',
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

describe('vendors', () => {
  it('JSON: the planner manages; the couple reads shared vendors only; another wedding is the masked 404 first', () => {
    const w = setup()
    const body = { category: 'catering', business_name: 'Feast', contract_status: 'sent', shared_with_couple: false, installments: [{ label: 'Deposit', amount_cents: 1000, due_date: '2028-02-01', deposit: true }] }
    expect(w.api('POST', `/t/demo/weddings/${w.ours}/vendors`, w.coupleBearer, { junk: true }).status).toBe(403)
    const created = w.api('POST', `/t/demo/weddings/${w.ours}/vendors`, w.bearer, body)
    expect(created.status).toBe(201)
    const vendor = (created.body as { vendor: { vendor_id: string; installments: { installment_id: string }[] } }).vendor
    expect((w.api('GET', `/t/demo/weddings/${w.ours}/vendors`, w.coupleBearer).body as { vendors: unknown[] }).vendors).toEqual([])
    // The whole schedule is resent with its ids, so the installment (and whether it was paid) carries over.
    const kept = vendor.installments[0]?.installment_id as string
    const shared = w.api('PUT', `/t/demo/weddings/${w.ours}/vendors/${vendor.vendor_id}`, w.bearer, { ...body, shared_with_couple: true, installments: [{ ...body.installments[0], installment_id: kept }] })
    expect(shared.status).toBe(200)
    expect((shared.body as { vendor: { installments: { installment_id: string }[] } }).vendor.installments[0]?.installment_id).toBe(kept)
    expect((w.api('GET', `/t/demo/weddings/${w.ours}/vendors`, w.coupleBearer).body as { vendors: unknown[] }).vendors).toHaveLength(1)
    expect(w.api('PUT', `/t/demo/weddings/${w.ours}/vendors/${vendor.vendor_id}/installments/${kept}`, w.bearer, { paid: true }).status).toBe(200)
    expect(w.api('PUT', `/t/demo/weddings/${w.ours}/vendors/${vendor.vendor_id}/installments/inst_nope`, w.bearer, { paid: true })).toEqual(NOT_FOUND)
    for (const wedding of [w.theirs, 'wedding_missing']) {
      expect(w.api('GET', `/t/demo/weddings/${wedding}/vendors`, w.coupleBearer)).toEqual(NOT_FOUND)
      expect(w.api('POST', `/t/demo/weddings/${wedding}/vendors`, w.coupleBearer, { junk: true })).toEqual(NOT_FOUND)
    }
    const bad = (b: object) => w.api('POST', `/t/demo/weddings/${w.ours}/vendors`, w.bearer, { ...body, ...b }).status
    expect(bad({ category: 'magic' })).toBe(400)
    expect(bad({ contract_status: 'maybe' })).toBe(400)
    expect(bad({ installments: [{ label: 'X', amount_cents: '10', due_date: '2028-01-01' }] })).toBe(400)
    expect(bad({ installments: Array.from({ length: 25 }, () => ({ label: 'X', amount_cents: 1, due_date: '2028-01-01' })) })).toBe(400)
    expect(w.api('DELETE', `/t/demo/weddings/${w.ours}/vendors/${vendor.vendor_id}`, w.bearer).body).toEqual({ removed: true })
  })

  it('at the limits, the planner page grows with vendors plus rows, not vendors times form fields (issue #54)', () => {
    const w = setup()
    const installments = Array.from({ length: VENDOR_LIMITS.installments }, (_, n) => ({ label: `Payment ${n}`, amount_cents: 100_000 + n, due_date: '2028-03-01' }))
    for (let v = 0; v < VENDOR_LIMITS.vendors; v++) {
      w.api('POST', `/t/demo/weddings/${w.ours}/vendors`, w.bearer, { category: 'other', category_other: 'x', business_name: `Vendor ${'&'.repeat(60)} ${v}`, contract_status: 'none', installments })
    }
    const planner = w.login({ role: 'planner' })
    const page = w.ui.handle(get(`/t/demo?wedding=${w.ours}&tab=vendors`, planner))
    expect(page.status).toBe(200)
    expect((page.body.match(/<form /g) ?? []).length).toBeLessThan(5)
    expect(page.body.length).toBeLessThan(350_000)
    const vendorId = /&amp;vendor=([A-Za-z0-9_]+)/.exec(page.body)?.[1] as string
    const view = w.ui.handle(get(`/t/demo?wedding=${w.ours}&tab=vendors&vendor=${vendorId}`, planner))
    expect(view.body.length).toBeLessThan(60_000)
  })

  it('the page: the planner adds a vendor with a schedule in dollars, marks a payment, and sees what is due next', () => {
    const w = setup()
    const planner = w.login({ role: 'planner' })
    const page = w.ui.handle(get(`/t/demo?wedding=${w.ours}&tab=vendors`, planner))
    expect(page.status).toBe(200)
    const csrf = csrfOf(page)
    const added = w.ui.handle(
      form('/t/demo/vendors/vendor-add', { _csrf: csrf, wedding_id: w.ours, category: 'photography', business_name: 'Snap <&>', contract_status: 'signed', shared_with_couple: 'true', i0_id: '', i0_label: 'Deposit', i0_amount: '1,250.50', i0_due: '2028-01-05', i0_deposit: 'true', i1_id: '', i1_label: 'Balance', i1_amount: '2000', i1_due: '2028-05-01', i2_id: '', i2_label: '', i2_amount: '', i2_due: '' }, planner),
    )
    expect(added.headers.location).toContain('notice=saved')
    const body = w.ui.handle(get(`/t/demo?wedding=${w.ours}&tab=vendors`, planner)).body
    expect(body).toContain('Snap &lt;&amp;&gt;')
    expect(body).toContain('Deposit (deposit): $1250.50, due 2028-01-05 — not paid')
    expect(body).toContain('2028-01-05 (overdue)')
    expect(body).toContain('Total $3250.50 · paid $0.00 · still due $3250.50')
    // The list carries no per-vendor forms (issue #54): each vendor is edited on its own view.
    expect(body).not.toContain('installment-paid')
    expect(body).not.toContain('vendor-update')
    const vendorId = /&amp;vendor=([A-Za-z0-9_]+)/.exec(body)?.[1] as string
    const view = w.ui.handle(get(`/t/demo?wedding=${w.ours}&tab=vendors&vendor=${vendorId}`, planner)).body
    expect(view).toContain('vendor-update')
    expect(view).not.toContain('Add a vendor')
    const installmentId = /name="installment_id" value="([^"]+)"/.exec(view)?.[1] as string
    const marked = w.ui.handle(form('/t/demo/vendors/installment-paid', { _csrf: csrf, wedding_id: w.ours, vendor_id: vendorId, installment_id: installmentId, paid: 'true' }, planner))
    expect(marked.headers.location).toBe(`/t/demo?wedding=${w.ours}&tab=vendors&vendor=${vendorId}&notice=saved`)
    expect(w.ui.handle(get(`/t/demo?wedding=${w.ours}&tab=vendors`, planner)).body).toContain('paid $1250.50')
    const invalid = w.ui.handle(form('/t/demo/vendors/vendor-add', { _csrf: csrf, wedding_id: w.ours, category: 'cake', business_name: 'Cake', contract_status: 'none', i0_id: '', i0_label: 'All', i0_amount: '12.345', i0_due: '2028-03-01' }, planner))
    expect(invalid.headers.location).toContain('notice=invalid')
    // A label with no amount, or a decimal comma, is refused rather than saved as $0 or 100 times too much.
    for (const amount of ['', '12,34']) {
      const res = w.ui.handle(form('/t/demo/vendors/vendor-add', { _csrf: csrf, wedding_id: w.ours, category: 'cake', business_name: 'Cake', contract_status: 'none', i0_id: '', i0_label: 'All', i0_amount: amount, i0_due: '2028-03-01' }, planner))
      expect(res.headers.location).toContain('notice=invalid')
    }
    // The edit form carries no "paid": saving it keeps the payment marked above.
    expect(w.ui.handle(get(`/t/demo?wedding=${w.ours}&tab=vendors`, planner)).body).not.toContain('_paid"')
  })

  it('the couple sees the shared vendors read-only (no forms); another wedding is the generic not-found', () => {
    const w = setup()
    w.api('POST', `/t/demo/weddings/${w.ours}/vendors`, w.bearer, { category: 'venue', business_name: 'Shared Hall', contract_status: 'signed', shared_with_couple: true, notes: 'internal note' })
    w.api('POST', `/t/demo/weddings/${w.ours}/vendors`, w.bearer, { category: 'music', business_name: 'Hidden Band', contract_status: 'none' })
    const couple = w.login({ role: 'couple', wedding_id: w.ours })
    const page = w.ui.handle(get(`/t/demo?wedding=${w.ours}&tab=vendors`, couple))
    expect(page.status).toBe(200)
    expect(page.body).toContain('Shared Hall')
    expect(page.body).not.toContain('Hidden Band')
    expect(page.body).not.toContain('internal note')
    expect(page.body).not.toContain('Add a vendor')
    expect(w.ui.handle(get(`/t/demo?wedding=${w.theirs}&tab=vendors`, couple)).status).toBe(404)
  })
})
