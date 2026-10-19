import { ManualClock, SequentialIdGenerator } from '@wedding-planner/shared'
import { describe, expect, it } from 'vitest'

import { type ApiRequest, composeProductSurface, type ProvisionTenantInput } from '@wedding-planner/product'

/**
 * Issue #8: sessions persist across deploys, so sign-out revokes server-side (`DELETE /t/:slug/sessions`, and the
 * browser Sign out form calls it), and the unauthenticated login persists only a bounded, id-shaped wedding_id.
 */

const OP = 'session-operator-token-0123456789'
const UNAUTHORIZED = { status: 401, body: { error: 'unauthorized' } }

function surface() {
  return composeProductSurface({
    clock: new ManualClock('2027-05-01T00:00:00.000Z'),
    ids: new SequentialIdGenerator('sess'),
    operatorToken: OP,
    providerWebhookToken: 'session-webhook-token-0123456789',
    demoSlug: 'demo',
  })
}

function req(method: string, path: string, opts: { token?: string; body?: unknown } = {}): ApiRequest {
  const headers: Record<string, string | undefined> = {}
  if (opts.token !== undefined) headers.authorization = `Bearer ${opts.token}`
  return { method, path, headers, rawBody: opts.body === undefined ? undefined : JSON.stringify(opts.body) }
}

function login(api: { handle(r: ApiRequest): { status: number; body: unknown } }, slug: string, body: object): string {
  const res = api.handle(req('POST', `/t/${slug}/sessions`, { body }))
  expect(res.status).toBe(201)
  return (res.body as { token: string }).token
}

describe('DELETE /t/:slug/sessions — server-side sign-out', () => {
  it('revokes the presented session; the token stops working', () => {
    const { api } = surface()
    const token = login(api, 'demo', { role: 'planner' })
    expect(api.handle(req('DELETE', '/t/demo/sessions', { token }))).toEqual({ status: 200, body: { signed_out: true } })
    expect(api.handle(req('GET', '/t/demo/weddings', { token }))).toEqual(UNAUTHORIZED)
    expect(api.handle(req('DELETE', '/t/demo/sessions', { token }))).toEqual(UNAUTHORIZED)
  })

  it('is authenticated and tenant-bound: no token, or another tenant\'s session, is a 401 that revokes nothing', () => {
    const { api } = surface()
    const theme: ProvisionTenantInput['theme'] = {
      brand_name: 'Other',
      primary_color_hex: '#123456',
      accent_color_hex: '#654321',
      logo_ref: 'other_logo',
    }
    const created = api.handle(
      req('POST', '/admin/tenants', { token: OP, body: { slug: 'other', display_name: 'Other', plan_tier: 'solo', theme } }),
    )
    const tenantId = (created.body as { tenant: { tenant_id: string } }).tenant.tenant_id
    expect(api.handle(req('POST', `/admin/tenants/${tenantId}/activate`, { token: OP })).status).toBe(200)
    const demoToken = login(api, 'demo', { role: 'planner' })
    expect(api.handle(req('DELETE', '/t/demo/sessions'))).toEqual(UNAUTHORIZED)
    expect(api.handle(req('DELETE', '/t/other/sessions', { token: demoToken }))).toEqual(UNAUTHORIZED)
    expect(api.handle(req('GET', '/t/demo/weddings', { token: demoToken })).status).toBe(200)
    expect(api.handle(req('PUT', '/t/demo/sessions', { token: demoToken })).status).toBe(405)
  })

  it('the browser Sign out form revokes the session, so the old cookie no longer signs in', () => {
    const { ui } = surface()
    const form = (path: string, fields: Record<string, string>, cookie?: string): ApiRequest => ({
      method: 'POST',
      path,
      headers: { 'content-type': 'application/x-www-form-urlencoded', ...(cookie === undefined ? {} : { cookie }) },
      rawBody: new URLSearchParams(fields).toString(),
    })
    const signedIn = ui.handle(form('/t/demo/login', { role: 'planner' }))
    const cookie = `wp_session=${/wp_session=([^;]+)/.exec(signedIn.headers['set-cookie'] ?? '')?.[1]}`
    const home = ui.handle({ method: 'GET', path: '/t/demo', headers: { cookie } })
    const csrf = /name="_csrf" value="([^"]+)"/.exec(home.body)?.[1] as string
    expect(ui.handle(form('/t/demo/logout', { _csrf: csrf }, cookie)).status).toBe(303)
    // A browser that kept the cookie anyway gets the sign-in page, not the console.
    const after = ui.handle({ method: 'GET', path: '/t/demo', headers: { cookie } })
    expect(after.body).toContain('action="/t/demo/login"')
  })
})

describe('POST /t/:slug/sessions — the persisted wedding_id is bounded and id-shaped', () => {
  it('refuses an oversized or non-id wedding_id (400) without checking existence', () => {
    const { api } = surface()
    for (const wedding_id of ['x'.repeat(129), 'wedding 1', 'wedding_1;drop', '../x', 'w\n1']) {
      expect(api.handle(req('POST', '/t/demo/sessions', { body: { role: 'couple', wedding_id } })).status).toBe(400)
    }
    // A well-formed id that does not exist still logs in (no existence oracle), exactly as before.
    expect(api.handle(req('POST', '/t/demo/sessions', { body: { role: 'couple', wedding_id: 'wedding_never_made' } })).status).toBe(201)
    expect(api.handle(req('POST', '/t/demo/sessions', { body: { role: 'couple', wedding_id: 'x'.repeat(128) } })).status).toBe(201)
  })
})
