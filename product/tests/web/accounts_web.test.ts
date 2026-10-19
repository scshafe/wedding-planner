import { ManualClock, SequentialIdGenerator, type Tenant } from '@wedding-planner/shared'
import { describe, expect, it } from 'vitest'

import { type ApiRequest, composeProductSurface, type HttpResult } from '@wedding-planner/product'

/**
 * Issue #10 — real sign-in in the browser: the password form on every workspace, the labeled simulated picker only
 * on the demo tenant, a pre-session anti-forgery check (double-submit cookie) on the sign-in, forgot and reset
 * forms, and reset pages that keep their token out of referrers and caches.
 */

const OP = 'accounts-web-operator-token-0123456789'
const THEME: Tenant['theme'] = { brand_name: 'Acme Weddings', primary_color_hex: '#123456', accent_color_hex: '#654321', logo_ref: 'acme' }
const PASSWORD = 'a perfectly long password'

function setup() {
  const clock = new ManualClock('2027-06-01T00:00:00.000Z')
  const surface = composeProductSurface({
    clock,
    ids: new SequentialIdGenerator('web'),
    operatorToken: OP,
    providerWebhookToken: 'accounts-web-webhook-token-0123456789',
    demoSlug: 'demo',
    passwordCost: { N: 16, r: 1, p: 1 },
  })
  const api = (method: string, path: string, body?: unknown) =>
    surface.api.handle({ method, path, headers: { authorization: `Bearer ${OP}` }, rawBody: body === undefined ? undefined : JSON.stringify(body) })
  const acmeId = (api('POST', '/admin/tenants', { slug: 'acme', display_name: 'Acme', plan_tier: 'solo', theme: THEME }).body as { tenant: { tenant_id: string } }).tenant.tenant_id
  api('POST', `/admin/tenants/${acmeId}/activate`)
  const outbox = () => (api('GET', '/admin/outbox').body as { messages: { text_body: string }[] }).messages
  return { ...surface, clock, api, acmeId, outbox }
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

/** The pre-session value a page set: the cookie header to send back and the form field. */
function pre(page: HttpResult): { cookie: string; csrf: string } {
  const value = /wp_pre=([^;]+)/.exec(page.headers['set-cookie'] ?? '')?.[1] as string
  const csrf = /name="_csrf" value="([^"]+)"/.exec(page.body)?.[1] as string
  return { cookie: `wp_pre=${value}`, csrf }
}

/** Set up the acme owner through the operator and choose a password through the emailed link. */
function owner(w: ReturnType<typeof setup>): void {
  w.api('POST', `/admin/tenants/${w.acmeId}/owner`, { email: 'owner@acme.test' })
  const token = /token=([A-Za-z0-9_-]+)/.exec(w.outbox()[0]?.text_body ?? '')?.[1] as string
  const page = w.ui.handle(get(`/t/acme/reset?token=${token}`))
  const { cookie, csrf } = pre(page)
  expect(w.ui.handle(form('/t/acme/reset', { _csrf: csrf, token, password: PASSWORD, confirm: PASSWORD }, cookie)).headers.location).toBe(
    '/t/acme/login?reset=1',
  )
}

describe('the sign-in page', () => {
  it('a real workspace offers email + password and no role picker', () => {
    const w = setup()
    const page = w.ui.handle(get('/t/acme/login'))
    expect(page.status).toBe(200)
    expect(page.body).toContain('name="password"')
    expect(page.body).toContain('href="/t/acme/forgot"')
    expect(page.body).not.toContain('name="role"')
    expect(page.headers['set-cookie']).toMatch(/^wp_pre=[A-Za-z0-9_-]+; HttpOnly; SameSite=Strict; Path=\/t\/acme; Max-Age=3600$/)
  })

  it('the demo workspace also offers the simulated picker, clearly labeled', () => {
    const w = setup()
    const page = w.ui.handle(get('/t/demo/login'))
    expect(page.body).toContain('name="password"')
    expect(page.body).toContain('Demo workspace: simulated sign-in')
    expect(page.body).toContain('name="role"')
  })

  it('an unauthenticated visit to the console shows the same sign-in page', () => {
    const w = setup()
    const page = w.ui.handle(get('/t/acme'))
    expect(page.body).toContain('name="password"')
    expect(page.body).not.toContain('name="role"')
  })
})

describe('password sign-in in the browser', () => {
  it('signs in with the right password: sets the session cookie and lands on the console', () => {
    const w = setup()
    owner(w)
    const { cookie, csrf } = pre(w.ui.handle(get('/t/acme/login')))
    const res = w.ui.handle(form('/t/acme/login', { _csrf: csrf, email: 'owner@acme.test', password: PASSWORD }, cookie))
    expect(res.status).toBe(303)
    expect(res.headers.location).toBe('/t/acme')
    expect(res.headers['set-cookie']).toMatch(/^wp_session=[A-Za-z0-9_-]+; HttpOnly; SameSite=Strict; Path=\/t\/acme$/)
  })

  it('a missing or mismatched pre-session value is refused before any credential check (login CSRF)', () => {
    const w = setup()
    owner(w)
    const { cookie, csrf } = pre(w.ui.handle(get('/t/acme/login')))
    for (const [fields, sent] of [
      [{ email: 'owner@acme.test', password: PASSWORD }, cookie],
      [{ _csrf: csrf, email: 'owner@acme.test', password: PASSWORD }, undefined],
      [{ _csrf: 'forged', email: 'owner@acme.test', password: PASSWORD }, cookie],
    ] as const) {
      const res = w.ui.handle(form('/t/acme/login', fields as Record<string, string>, sent))
      expect(res.status).toBe(400)
      expect(res.body).toContain('That form expired')
      expect(res.headers['set-cookie'] ?? '').not.toContain('wp_session')
    }
  })

  it('a wrong password re-renders the page with one generic notice (401)', () => {
    const w = setup()
    owner(w)
    const { cookie, csrf } = pre(w.ui.handle(get('/t/acme/login')))
    const wrong = w.ui.handle(form('/t/acme/login', { _csrf: csrf, email: 'owner@acme.test', password: 'nope nope nope' }, cookie))
    const unknown = w.ui.handle(form('/t/acme/login', { _csrf: csrf, email: 'ghost@acme.test', password: PASSWORD }, cookie))
    expect(wrong.status).toBe(401)
    expect(unknown.status).toBe(401)
    expect(wrong.body).toContain('That email or password was not accepted.')
    expect(unknown.body).toContain('That email or password was not accepted.')
  })
})

describe('forgot password and the reset page', () => {
  it('forgot answers with the same page for known and unknown emails; only the known one gets a link', () => {
    const w = setup()
    owner(w)
    const before = w.outbox().length
    for (const email of ['owner@acme.test', 'ghost@acme.test']) {
      const { cookie, csrf } = pre(w.ui.handle(get('/t/acme/forgot')))
      const res = w.ui.handle(form('/t/acme/forgot', { _csrf: csrf, email }, cookie))
      expect(res.status).toBe(200)
      expect(res.body).toContain('If an account exists for that address')
    }
    w.ui.runDeferredWork()
    expect(w.outbox().length).toBe(before + 1)
  })

  it('the reset page keeps its token out of referrers and caches, and checks the confirmation first', () => {
    const w = setup()
    owner(w)
    const { cookie, csrf } = pre(w.ui.handle(get('/t/acme/forgot')))
    w.ui.handle(form('/t/acme/forgot', { _csrf: csrf, email: 'owner@acme.test' }, cookie))
    w.ui.runDeferredWork()
    const token = /token=([A-Za-z0-9_-]+)/.exec(w.outbox()[0]?.text_body ?? '')?.[1] as string
    const page = w.ui.handle(get(`/t/acme/reset?token=${token}`))
    expect(page.headers['referrer-policy']).toBe('no-referrer')
    expect(page.headers['cache-control']).toBe('no-store')
    const p = pre(page)
    const mismatch = w.ui.handle(form('/t/acme/reset', { _csrf: p.csrf, token, password: 'one long password', confirm: 'another long one' }, p.cookie))
    expect(mismatch.body).toContain('did not match')
    const weak = w.ui.handle(form('/t/acme/reset', { _csrf: p.csrf, token, password: 'short', confirm: 'short' }, p.cookie))
    expect(weak.body).toContain('10 to 128 characters')
    // Neither used the link up.
    const done = w.ui.handle(form('/t/acme/reset', { _csrf: p.csrf, token, password: 'my brand new password', confirm: 'my brand new password' }, p.cookie))
    expect(done.headers.location).toBe('/t/acme/login?reset=1')
    expect(w.ui.handle(get('/t/acme/login?reset=1')).body).toContain('Your password is set.')
    const again = w.ui.handle(form('/t/acme/reset', { _csrf: p.csrf, token, password: 'yet another password', confirm: 'yet another password' }, p.cookie))
    expect(again.body).toContain('This link is invalid or has expired')
  })

  it('an unknown tenant is the generic 404 on every account page', () => {
    const w = setup()
    for (const path of ['/t/nope/login', '/t/nope/forgot', '/t/nope/reset?token=x']) expect(w.ui.handle(get(path)).status).toBe(404)
  })
})

describe('the operator console tenants page', () => {
  it('lists tenants and sets up an owner through a CSRF-checked form', () => {
    const w = setup()
    const signIn = w.ui.handle(form('/admin/login', { token: OP }))
    const cookie = `wp_operator=${/wp_operator=([^;]+)/.exec(signIn.headers['set-cookie'] ?? '')?.[1]}`
    const page = w.ui.handle(get('/admin/tenants', cookie))
    expect(page.status).toBe(200)
    expect(page.body).toContain('/t/acme')
    const csrf = /name="_csrf" value="([^"]+)"/.exec(page.body)?.[1] as string
    const forged = w.ui.handle(form('/admin/tenants/owner', { _csrf: 'forged', tenant_id: w.acmeId, email: 'o@acme.test' }, cookie))
    expect(forged.headers.location).toBe('/admin/login')
    const sent = w.ui.handle(form('/admin/tenants/owner', { _csrf: csrf, tenant_id: w.acmeId, email: 'o@acme.test' }, cookie))
    expect(sent.headers.location).toBe('/admin/tenants?notice=owner_sent')
    expect(w.ui.handle(get('/admin/tenants?notice=owner_sent', cookie)).body).toContain('The set-your-password link is in the outbox')
    expect(w.outbox()[0]?.text_body).toContain('/t/acme/reset?token=')
    const invalid = w.ui.handle(form('/admin/tenants/owner', { _csrf: csrf, tenant_id: w.acmeId, email: 'bad' }, cookie))
    expect(invalid.headers.location).toBe('/admin/tenants?notice=owner_invalid')
  })
})
