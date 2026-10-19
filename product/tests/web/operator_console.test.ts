import { ManualClock, SequentialIdGenerator } from '@wedding-planner/shared'
import { describe, expect, it } from 'vitest'

import { type ApiRequest, composeProductSurface, type HttpResult } from '@wedding-planner/product'

/**
 * Issue #9: the operator console in the browser. Sign-in exchanges the credential for an HttpOnly console
 * session cookie scoped to /admin; the outbox page renders every simulated email escaped; mutations are
 * CSRF-checked; sign-out revokes the session server-side.
 */

const OP = 'console-operator-token-0123456789'

function surface() {
  return composeProductSurface({
    clock: new ManualClock('2027-06-01T00:00:00.000Z'),
    ids: new SequentialIdGenerator('console'),
    operatorToken: OP,
    providerWebhookToken: 'console-webhook-token-0123456789',
    demoSlug: 'demo',
  })
}

function form(path: string, fields: Record<string, string>, cookie?: string): ApiRequest {
  const headers: Record<string, string | undefined> = { 'content-type': 'application/x-www-form-urlencoded' }
  if (cookie !== undefined) headers.cookie = cookie
  return { method: 'POST', path, headers, rawBody: new URLSearchParams(fields).toString() }
}

function get(path: string, cookie?: string): ApiRequest {
  return { method: 'GET', path, headers: cookie === undefined ? {} : { cookie } }
}

function signIn(ui: { handle(req: ApiRequest): HttpResult }): { cookie: string; csrf: string } {
  const res = ui.handle(form('/admin/login', { token: OP }))
  expect(res.status).toBe(303)
  const value = /wp_operator=([^;]+)/.exec(res.headers['set-cookie'] ?? '')?.[1] as string
  const cookie = `wp_operator=${value}`
  const page = ui.handle(get('/admin/outbox', cookie))
  const csrf = /name="_csrf" value="([^"]+)"/.exec(page.body)?.[1] as string
  return { cookie, csrf }
}

describe('operator console — sign-in', () => {
  it('GET /admin and /admin/login show the sign-in form', () => {
    const { ui } = surface()
    for (const path of ['/admin', '/admin/login']) {
      const res = ui.handle(get(path))
      expect(res.status).toBe(200)
      expect(res.body).toContain('action="/admin/login"')
      expect(res.headers['content-security-policy']).toContain("script-src 'none'")
    }
  })

  it('a wrong credential re-renders the form (401) and sets no cookie', () => {
    const { ui } = surface()
    const res = ui.handle(form('/admin/login', { token: 'wrong-credential-0123456789' }))
    expect(res.status).toBe(401)
    expect(res.body).toContain('was not accepted')
    expect(res.headers['set-cookie']).toBeUndefined()
    expect(ui.handle(form('/admin/login', {})).status).toBe(401)
  })

  it('the right credential sets an HttpOnly, SameSite=Strict, /admin-scoped session cookie that is NOT the credential', () => {
    const { ui } = surface()
    const res = ui.handle(form('/admin/login', { token: OP }))
    expect(res.status).toBe(303)
    expect(res.headers.location).toBe('/admin/outbox')
    const cookie = res.headers['set-cookie'] ?? ''
    expect(cookie).toMatch(/^wp_operator=[A-Za-z0-9_-]+; HttpOnly; SameSite=Strict; Path=\/admin; Max-Age=43200$/)
    expect(cookie).not.toContain(OP)
  })

  it('a signed-in operator visiting /admin/login goes straight to the outbox', () => {
    const { ui } = surface()
    const { cookie } = signIn(ui)
    const res = ui.handle(get('/admin/login', cookie))
    expect(res.status).toBe(303)
    expect(res.headers.location).toBe('/admin/outbox')
  })
})

describe('operator console — the outbox page', () => {
  it('without a console session the page redirects to sign-in; a tenant session cookie does not help', () => {
    const { ui } = surface()
    expect(ui.handle(get('/admin/outbox')).headers.location).toBe('/admin/login')
    const login = ui.handle(form('/t/demo/login', { role: 'planner' }))
    const tenantToken = /wp_session=([^;]+)/.exec(login.headers['set-cookie'] ?? '')?.[1] as string
    expect(ui.handle(get('/admin/outbox', `wp_operator=${tenantToken}`)).headers.location).toBe('/admin/login')
  })

  it('lists every message newest first, with untrusted text escaped', () => {
    const { ui, email } = surface()
    email.send({ to: 'a@example.test', subject: 'First', text_body: 'plain', purpose: 'operator_test' })
    email.send({
      to: 'b@example.test',
      subject: '<script>alert(1)</script>',
      text_body: '<img src=x onerror=alert(2)>',
      purpose: 'invitation',
      tenant_id: 'tenant_x',
    })
    const { cookie } = signIn(ui)
    const page = ui.handle(get('/admin/outbox', cookie))
    expect(page.status).toBe(200)
    expect(page.body.indexOf('b@example.test')).toBeLessThan(page.body.indexOf('a@example.test'))
    expect(page.body).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
    expect(page.body).toContain('&lt;img src=x onerror=alert(2)&gt;')
    expect(page.body).not.toContain('<script>alert(1)')
    expect(page.body).toContain('tenant_x')
  })

  it('a script presenting a Bearer gets the JSON API at the same path', () => {
    const { ui } = surface()
    const res = ui.handle({ method: 'GET', path: '/admin/outbox', headers: { authorization: `Bearer ${OP}` } })
    expect(res.status).toBe(200)
    expect(res.headers['content-type']).toBe('application/json')
    expect(JSON.parse(res.body)).toEqual({ messages: [] })
  })

  it('the test-send form is CSRF-checked: a forged token sends nothing', () => {
    const { ui, email } = surface()
    const { cookie } = signIn(ui)
    const forged = ui.handle(form('/admin/outbox/send', { _csrf: 'forged', to: 'x@example.test' }, cookie))
    expect(forged.status).toBe(303)
    expect(forged.headers.location).toBe('/admin/login')
    expect(email.recent(10)).toEqual([])
  })

  it('a valid test send records the message and lands back on the outbox; a bad address re-renders with a notice', () => {
    const { ui, email } = surface()
    const { cookie, csrf } = signIn(ui)
    const sent = ui.handle(form('/admin/outbox/send', { _csrf: csrf, to: 'owner@example.test' }, cookie))
    expect(sent.status).toBe(303)
    expect(sent.headers.location).toBe('/admin/outbox?sent=1')
    expect(email.recent(10).map((m) => m.to)).toEqual(['owner@example.test'])
    expect(ui.handle(get('/admin/outbox?sent=1', cookie)).body).toContain('Test message recorded')

    const bad = ui.handle(form('/admin/outbox/send', { _csrf: csrf, to: 'not an address' }, cookie))
    expect(bad.status).toBe(400)
    expect(bad.body).toContain('That address was not accepted')
    expect(email.recent(10)).toHaveLength(1)
  })
})

describe('operator console — sign-out', () => {
  it('revokes the session server-side and clears the cookie', () => {
    const { ui } = surface()
    const { cookie, csrf } = signIn(ui)
    const res = ui.handle(form('/admin/logout', { _csrf: csrf }, cookie))
    expect(res.status).toBe(303)
    expect(res.headers['set-cookie']).toBe('wp_operator=; HttpOnly; SameSite=Strict; Path=/admin; Max-Age=0')
    // The old cookie no longer works even if a browser kept it.
    expect(ui.handle(get('/admin/outbox', cookie)).headers.location).toBe('/admin/login')
  })

  it('a forged sign-out does not revoke the session', () => {
    const { ui } = surface()
    const { cookie } = signIn(ui)
    ui.handle(form('/admin/logout', { _csrf: 'forged' }, cookie))
    expect(ui.handle(get('/admin/outbox', cookie)).status).toBe(200)
  })

  it('the operator credential never appears in a page', () => {
    const { ui } = surface()
    const { cookie } = signIn(ui)
    for (const path of ['/admin/login', '/admin/outbox']) {
      const res = ui.handle(get(path, cookie))
      expect(res.body).not.toContain(OP)
      expect(JSON.stringify(res.headers)).not.toContain(OP)
    }
  })
})
