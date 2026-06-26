import { ManualClock, SequentialIdGenerator, type Tenant } from '@wedding-planner/shared'
import { describe, expect, it } from 'vitest'

import {
  type ApiRequest,
  type HttpResult,
  BillingLedger,
  OnboardingService,
  OperatorCredentialStore,
  ProductApi,
  ProductWebUi,
  SessionStore,
  TenantContextResolver,
  TenantStore,
  ThemeResolver,
  WeddingAuthorizer,
  WeddingRepository,
} from '@wedding-planner/product'

/**
 * THE WEB KEYSTONE — the load-bearing regression for the server-rendered surface (Phase 14).
 *
 * The HTML front door is themed and stateful where the JSON API was neither, so it could re-introduce
 * an oracle (themed-vs-generic / redirect-vs-404 leaking tenant existence or lifecycle) or an injection
 * (theme/wedding/slug fields into HTML/CSS/URL/headers) that the JSON keystone never had to consider.
 * This pins, against the PURE handler (no sockets), that it does neither — and that it routes around
 * NEITHER boundary. Later phases build on this surface and may not weaken it.
 *
 * The crux, carried from Phase 13: the JSON API already discloses active-tenant existence (401 vs 404)
 * while keeping absent ≡ suspended ≡ onboarding byte-identical. The UI must disclose EXACTLY that set —
 * no more (no theme/branding leak that distinguishes suspended from absent), no less.
 */

const THEME: Tenant['theme'] = {
  brand_name: 'Acme Weddings',
  primary_color_hex: '#a1b2c3',
  accent_color_hex: '#445566',
  logo_ref: 'asset_logo_1',
}

/** A theme whose free strings are injection payloads (colors must be valid hex — the schema enforces it). */
const EVIL_THEME: Tenant['theme'] = {
  brand_name: '</style><script>alert(1)</script>',
  primary_color_hex: '#a1b2c3',
  accent_color_hex: '#445566',
  logo_ref: 'javascript:alert(document.cookie)',
}

interface World {
  ui: ProductWebUi
  api: ProductApi
  store: TenantStore
}

function makeWorld(): World {
  const store = new TenantStore(new ManualClock('2027-03-01T00:00:00.000Z'), new SequentialIdGenerator('seedT'))
  store.create({ slug: 'alpha', display_name: 'Alpha', theme: THEME, plan_tier: 'solo', lifecycle_status: 'active' })
  store.create({ slug: 'beta', display_name: 'Beta', theme: THEME, plan_tier: 'solo', lifecycle_status: 'active' })
  store.create({ slug: 'suspendedco', display_name: 'Susp', theme: THEME, plan_tier: 'solo', lifecycle_status: 'suspended' })
  store.create({ slug: 'onboardco', display_name: 'Onb', theme: THEME, plan_tier: 'solo', lifecycle_status: 'onboarding' })
  store.create({ slug: 'evilbrand', display_name: 'Evil', theme: EVIL_THEME, plan_tier: 'solo', lifecycle_status: 'active' })
  const api = new ProductApi({
    resolver: new TenantContextResolver(store),
    sessionStore: new SessionStore(new SequentialIdGenerator('seedS')),
    operators: new OperatorCredentialStore(new SequentialIdGenerator('seedO'), ['op-secret']),
    onboarding: new OnboardingService(store, new BillingLedger(new ManualClock('2027-03-01T00:00:00.000Z'), new SequentialIdGenerator('seedB'))),
    weddings: new WeddingRepository(store, new ManualClock('2027-04-01T00:00:00.000Z'), new SequentialIdGenerator('seedW')),
    authorizer: new WeddingAuthorizer(),
  })
  return { ui: new ProductWebUi({ api, themes: new ThemeResolver(store) }), api, store }
}

function get(ui: ProductWebUi, path: string, cookie?: string): HttpResult {
  const headers: ApiRequest['headers'] = cookie === undefined ? {} : { cookie }
  return ui.handle({ method: 'GET', path, headers })
}

function loginCookie(ui: ProductWebUi, slug: string, role: string, weddingId?: string): string {
  const body = new URLSearchParams({ role, ...(weddingId ? { wedding_id: weddingId } : {}) }).toString()
  const res = ui.handle({
    method: 'POST',
    path: `/t/${slug}/login`,
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    rawBody: body,
  })
  const token = /wp_session=([^;]+)/.exec(res.headers['set-cookie'] ?? '')?.[1]
  return `wp_session=${token}`
}

function createWedding(api: ProductApi, slug: string, name: string): string {
  const login = api.handle({ method: 'POST', path: `/t/${slug}/sessions`, headers: {}, rawBody: JSON.stringify({ role: 'planner' }) })
  const token = (login.body as { token: string }).token
  const create = api.handle({
    method: 'POST',
    path: `/t/${slug}/weddings`,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    rawBody: JSON.stringify({ couple_display_name: name, event_date: '2029-05-05' }),
  })
  return (create.body as { wedding: { wedding_id: string } }).wedding.wedding_id
}

describe('(a) the pre-auth equivalence keystone — no existence/lifecycle oracle', () => {
  it('unknown, suspended, onboarding, and malformed-slug are BYTE-IDENTICAL generic 404s', () => {
    const { ui } = makeWorld()
    const unknown = get(ui, '/t/ghost')
    const suspended = get(ui, '/t/suspendedco')
    const onboarding = get(ui, '/t/onboardco')
    const malformed = get(ui, '/t/bad_slug') // underscore: not the schema shape -> masked at the edge

    expect(suspended).toEqual(unknown)
    expect(onboarding).toEqual(unknown)
    expect(malformed).toEqual(unknown)
    expect(unknown.status).toBe(404)
    expect(unknown.body).not.toContain('Acme')
  })

  it('an active tenant pre-auth is a DISTINCT themed login (matching the API 401-vs-404 line, no more)', () => {
    const { ui } = makeWorld()
    const active = get(ui, '/t/alpha')
    const unknown = get(ui, '/t/ghost')
    expect(active.status).toBe(200)
    expect(active.body).toContain('Simulated login')
    expect(active).not.toEqual(unknown)
  })
})

describe('(b) injection corpus — escaped in body, never in a header', () => {
  it('theme payloads are escaped on the themed login (no live markup)', () => {
    const { ui } = makeWorld()
    const res = get(ui, '/t/evilbrand')
    const lowered = res.body.toLowerCase()
    expect(lowered).not.toContain('<script')
    expect(lowered).not.toContain('</style><script')
    expect(lowered).not.toContain('href="javascript:')
    expect(lowered).not.toContain('src="javascript:')
  })

  it('a CRLF/attribute-injecting slug is masked at the edge — no header is built from it', () => {
    const { ui } = makeWorld()
    for (const evil of ['a\r\nSet-Cookie:x', 'a%0d%0aSet-Cookie:x', 'a; Domain=evil', '..%2fevil']) {
      const res = ui.handle({ method: 'POST', path: `/t/${evil}/login`, headers: {}, rawBody: 'role=planner' })
      expect(res.status).toBe(404)
      expect(res.headers['set-cookie']).toBeUndefined()
      expect(res.headers.location).toBeUndefined()
    }
  })

  it('the validated slug + server token in the login Set-Cookie/Location carry no injection', () => {
    const { ui } = makeWorld()
    const res = ui.handle({ method: 'POST', path: '/t/alpha/login', headers: {}, rawBody: 'role=planner' })
    expect(res.status).toBe(303)
    expect(res.headers.location).toBe('/t/alpha')
    expect(res.headers['set-cookie']).toMatch(/^wp_session=[A-Za-z0-9_-]+; HttpOnly; SameSite=Strict; Path=\/t\/alpha$/)
  })
})

describe('(c) the masked-detail keystone — foreign ≡ missing-own ≡ garbage, id never reflected', () => {
  it('a couple gets a byte-identical 404 for a foreign, a missing, and a garbage wedding id', () => {
    const { ui, api } = makeWorld()
    const own = createWedding(api, 'alpha', 'Own Couple')
    const foreign = createWedding(api, 'alpha', 'Other Couple')
    const cookie = loginCookie(ui, 'alpha', 'couple', own)

    const foreignRes = get(ui, `/t/alpha?wedding=${foreign}`, cookie)
    const missingRes = get(ui, `/t/alpha?wedding=wedding_does_not_exist`, cookie)
    const garbageRes = get(ui, `/t/alpha?wedding=${encodeURIComponent('"><script>alert(1)</script>')}`, cookie)

    expect(foreignRes.status).toBe(404)
    expect(missingRes).toEqual(foreignRes)
    expect(garbageRes).toEqual(foreignRes)
    expect(foreignRes.body).not.toContain('Other Couple')
    expect(foreignRes.body).not.toContain(foreign)
    expect(foreignRes.body).not.toContain('script')

    // The couple's OWN wedding still renders (the mask is structural, not a blanket deny).
    const ownRes = get(ui, `/t/alpha?wedding=${own}`, cookie)
    expect(ownRes.status).toBe(200)
    expect(ownRes.body).toContain('Own Couple')
  })
})

describe('(d) the deputy keystone — cross-tenant replay never yields the other tenant data', () => {
  it("alpha's session replayed on beta gets beta's login, never beta's weddings", () => {
    const { ui, api } = makeWorld()
    createWedding(api, 'beta', 'Beta Couple')
    const alphaCookie = loginCookie(ui, 'alpha', 'planner')

    const replay = get(ui, '/t/beta', alphaCookie)
    // Active tenant + a foreign (bind-vetoed) session -> 401 -> themed LOGIN, not beta's console data.
    expect(replay.status).toBe(200)
    expect(replay.body).toContain('Simulated login')
    expect(replay.body).not.toContain('Beta Couple')
  })

  it('the JSON path also vetoes the replay (401), proving the bind veto runs through the web layer', () => {
    const { ui, api } = makeWorld()
    const login = api.handle({ method: 'POST', path: '/t/alpha/sessions', headers: {}, rawBody: JSON.stringify({ role: 'planner' }) })
    const token = (login.body as { token: string }).token
    const res = ui.handle({ method: 'GET', path: '/t/beta/weddings', headers: { authorization: `Bearer ${token}` } })
    expect(res.status).toBe(401)
    expect(res.headers['content-type']).toBe('application/json')
  })
})

describe('(e) routing keystone — the JSON weddings path is not UI-shadowed', () => {
  it('GET /t/:slug/weddings/:id still reaches the unchanged JSON handler', () => {
    const { ui, api } = makeWorld()
    const id = createWedding(api, 'alpha', 'Routed Couple')
    const login = api.handle({ method: 'POST', path: '/t/alpha/sessions', headers: {}, rawBody: JSON.stringify({ role: 'planner' }) })
    const token = (login.body as { token: string }).token

    const res = ui.handle({ method: 'GET', path: `/t/alpha/weddings/${id}`, headers: { authorization: `Bearer ${token}` } })
    expect(res.status).toBe(200)
    expect(res.headers['content-type']).toBe('application/json')
    expect(JSON.parse(res.body)).toMatchObject({ wedding: { couple_display_name: 'Routed Couple' } })
  })

  it('the same path with no token is the JSON 401 (not the HTML login)', () => {
    const { ui } = makeWorld()
    const res = get(ui, '/t/alpha/weddings/wedding_x')
    expect(res.status).toBe(401)
    expect(res.headers['content-type']).toBe('application/json')
  })
})

describe('(f) safeColor is wired into the render path', () => {
  it('a valid stored brand color reaches the page as a custom property (the render-time backstop is unit-pinned)', () => {
    const { ui } = makeWorld()
    const res = get(ui, '/t/alpha')
    expect(res.body).toContain('--brand:#a1b2c3')
    expect(res.body).toContain('--accent:#445566')
  })
})

describe('(g) the security-header floor on every response (no silent regression)', () => {
  it('a themed HTML page carries nosniff + a script-less CSP', () => {
    const { ui } = makeWorld()
    const res = get(ui, '/t/alpha')
    expect(res.headers['x-content-type-options']).toBe('nosniff')
    expect(res.headers['content-security-policy']).toContain("script-src 'none'")
  })

  it('the masked 404 and the login redirect both carry nosniff', () => {
    const { ui } = makeWorld()
    expect(get(ui, '/t/ghost').headers['x-content-type-options']).toBe('nosniff')
    const redirect = ui.handle({ method: 'POST', path: '/t/alpha/login', headers: {}, rawBody: 'role=planner' })
    expect(redirect.status).toBe(303)
    expect(redirect.headers['x-content-type-options']).toBe('nosniff')
  })

  it('a delegated JSON response also carries nosniff', () => {
    const { ui } = makeWorld()
    expect(get(ui, '/healthz').headers['x-content-type-options']).toBe('nosniff')
  })
})
