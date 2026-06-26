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
 * Step-4 coverage: the HTML front door routes, renders by the status `api.handle()` returns, forwards
 * the cookie as a Bearer, and delegates non-UI paths to the JSON pipeline unchanged. The adversarial
 * surface (oracle equivalence, injection, cross-tenant replay) is the Step-6 keystone.
 */

const THEME: Tenant['theme'] = {
  brand_name: 'Acme Weddings',
  primary_color_hex: '#a1b2c3',
  accent_color_hex: '#445566',
  logo_ref: 'asset_logo_1',
}

interface World {
  ui: ProductWebUi
  api: ProductApi
}

function makeWorld(): World {
  const store = new TenantStore(new ManualClock('2027-03-01T00:00:00.000Z'), new SequentialIdGenerator('seedT'))
  store.create({ slug: 'acme', display_name: 'Acme', theme: THEME, plan_tier: 'solo', lifecycle_status: 'active' })
  store.create({ slug: 'dormant', display_name: 'Dormant', theme: THEME, plan_tier: 'solo', lifecycle_status: 'suspended' })
  const api = new ProductApi({
    resolver: new TenantContextResolver(store),
    sessionStore: new SessionStore(new SequentialIdGenerator('seedS')),
    operators: new OperatorCredentialStore(new SequentialIdGenerator('seedO'), ['op-secret']),
    onboarding: new OnboardingService(store, new BillingLedger(new ManualClock('2027-03-01T00:00:00.000Z'), new SequentialIdGenerator('seedB'))),
    weddings: new WeddingRepository(store, new ManualClock('2027-04-01T00:00:00.000Z'), new SequentialIdGenerator('seedW')),
    authorizer: new WeddingAuthorizer(),
  })
  return { ui: new ProductWebUi({ api, themes: new ThemeResolver(store) }), api }
}

function get(ui: ProductWebUi, path: string, cookie?: string): HttpResult {
  const headers: ApiRequest['headers'] = cookie === undefined ? {} : { cookie }
  return ui.handle({ method: 'GET', path, headers })
}

/** Log in via the HTML POST and return the wp_session cookie value the front door sets. */
function loginCookie(ui: ProductWebUi, slug: string, role: string, weddingId?: string): string {
  const body = new URLSearchParams({ role, ...(weddingId ? { wedding_id: weddingId } : {}) }).toString()
  const res = ui.handle({
    method: 'POST',
    path: `/t/${slug}/login`,
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    rawBody: body,
  })
  expect(res.status).toBe(303)
  const setCookie = res.headers['set-cookie'] ?? ''
  const token = /wp_session=([^;]+)/.exec(setCookie)?.[1]
  expect(token, 'login should set a wp_session cookie').toBeTruthy()
  return `wp_session=${token}`
}

/** Create a wedding through the JSON API and return its id (planner token). */
function createWedding(api: ProductApi, slug: string, name: string): string {
  const login = api.handle({ method: 'POST', path: `/t/${slug}/sessions`, headers: {}, rawBody: JSON.stringify({ role: 'planner' }) })
  const token = (login.body as { token: string }).token
  const create = api.handle({
    method: 'POST',
    path: `/t/${slug}/weddings`,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    rawBody: JSON.stringify({ couple_display_name: name, event_date: '2029-05-05' }),
  })
  expect(create.status).toBe(201)
  return (create.body as { wedding: { wedding_id: string } }).wedding.wedding_id
}

describe('ProductWebUi routing + rendering', () => {
  it('serves the generic landing at /', () => {
    const { ui } = makeWorld()
    const res = get(ui, '/')
    expect(res.status).toBe(200)
    expect(res.body).toContain('white-label')
  })

  it('shows the themed login for an active tenant when unauthenticated', () => {
    const { ui } = makeWorld()
    const res = get(ui, '/t/acme')
    expect(res.status).toBe(200)
    expect(res.body).toContain('Acme Weddings')
    expect(res.body).toContain('Simulated login')
  })

  it('renders the themed console listing weddings after login', () => {
    const { ui, api } = makeWorld()
    createWedding(api, 'acme', 'Alex & Sam')
    const cookie = loginCookie(ui, 'acme', 'planner')
    const res = get(ui, '/t/acme', cookie)
    expect(res.status).toBe(200)
    expect(res.body).toContain('Alex &amp; Sam')
    expect(res.body).toContain('?wedding=')
  })

  it('renders a themed detail page via ?wedding=ID', () => {
    const { ui, api } = makeWorld()
    const id = createWedding(api, 'acme', 'Alex & Sam')
    const cookie = loginCookie(ui, 'acme', 'planner')
    const res = get(ui, `/t/acme?wedding=${id}`, cookie)
    expect(res.status).toBe(200)
    expect(res.body).toContain('Alex &amp; Sam')
    expect(res.body).toContain('All weddings')
  })

  it('a couple sees only their own wedding; a foreign id is the masked 404 page', () => {
    const { ui, api } = makeWorld()
    const own = createWedding(api, 'acme', 'Own Couple')
    const foreign = createWedding(api, 'acme', 'Other Couple')
    const cookie = loginCookie(ui, 'acme', 'couple', own)

    const ownDetail = get(ui, `/t/acme?wedding=${own}`, cookie)
    expect(ownDetail.status).toBe(200)
    expect(ownDetail.body).toContain('Own Couple')

    const foreignDetail = get(ui, `/t/acme?wedding=${foreign}`, cookie)
    expect(foreignDetail.status).toBe(404)
    expect(foreignDetail.body).not.toContain('Other Couple')
  })

  it('logout clears the cookie and redirects', () => {
    const { ui } = makeWorld()
    const res = ui.handle({ method: 'POST', path: '/t/acme/logout', headers: {} })
    expect(res.status).toBe(303)
    expect(res.headers['set-cookie']).toContain('Max-Age=0')
  })
})

describe('ProductWebUi delegation to the JSON pipeline', () => {
  it('passes /healthz through unchanged as JSON', () => {
    const { ui } = makeWorld()
    const res = get(ui, '/healthz')
    expect(res.status).toBe(200)
    expect(res.headers['content-type']).toBe('application/json')
    expect(res.body).toBe('{"status":"ok"}')
  })

  it('passes the JSON weddings path through (401 JSON, not the HTML login)', () => {
    const { ui } = makeWorld()
    const res = get(ui, '/t/acme/weddings')
    expect(res.status).toBe(401)
    expect(res.headers['content-type']).toBe('application/json')
    expect(res.body).toBe('{"error":"unauthorized"}')
  })
})
