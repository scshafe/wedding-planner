import { ManualClock, SequentialIdGenerator, type StrategyGenome, type Tenant } from '@wedding-planner/shared'
import { describe, expect, it } from 'vitest'

import {
  GuestAuthorizer,
  GuestRegistry,
  type ApiRequest,
  type HttpResult,
  BillingLedger,
  OnboardingService,
  OperatorCredentialStore,
  ProviderWebhookCredentialStore,
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
 * Step-3 coverage for the themed /t/:slug/strategy page (Phase 17). It mirrors `#console`: one api.handle(),
 * themed strictly by status. The load-bearing checks: the page renders the guidance, it leaks NO engine
 * internals (doddy DP1), and it is byte-identical for a planner and a couple (platform-global, DP2).
 */

const THEME: Tenant['theme'] = {
  brand_name: 'Acme Weddings',
  primary_color_hex: '#a1b2c3',
  accent_color_hex: '#445566',
  logo_ref: 'asset_logo_1',
}

const CHAMPION: StrategyGenome = {
  genome_id: 'g_pub_secret_lineage',
  parameters: { rsvp_reminder_cadence: 3, reminder_spacing: 1, reminder_batching: 1 },
}

function makeUi(opts: { champion?: StrategyGenome } = {}): { ui: ProductWebUi; api: ProductApi } {
  const store = new TenantStore(new ManualClock('2027-03-01T00:00:00.000Z'), new SequentialIdGenerator('seedT'))
  store.create({ slug: 'acme', display_name: 'Acme', theme: THEME, plan_tier: 'solo', lifecycle_status: 'active' })
  store.create({ slug: 'dormant', display_name: 'Dormant', theme: THEME, plan_tier: 'solo', lifecycle_status: 'suspended' })
  const api = new ProductApi({
    resolver: new TenantContextResolver(store),
    sessionStore: new SessionStore(new SequentialIdGenerator('seedS')),
    operators: new OperatorCredentialStore(new SequentialIdGenerator('seedO'), ['op-secret']),
    webhookCredentials: new ProviderWebhookCredentialStore(new SequentialIdGenerator('seedW'), ['wh-secret']),
    onboarding: new OnboardingService(store, new BillingLedger(new ManualClock('2027-03-01T00:00:00.000Z'), new SequentialIdGenerator('seedB'))),
    weddings: new WeddingRepository(store, new ManualClock('2027-04-01T00:00:00.000Z'), new SequentialIdGenerator('seedW')),
    authorizer: new WeddingAuthorizer(),
    guests: { registry: new GuestRegistry(store), weddings: new WeddingRepository(store, new ManualClock('2027-04-01T00:00:00.000Z'), new SequentialIdGenerator('seedGW')), authorizer: new GuestAuthorizer() },
    ...(opts.champion === undefined ? {} : { championStrategy: opts.champion }),
  })
  return { ui: new ProductWebUi({ api, themes: new ThemeResolver(store) }), api }
}

function get(ui: ProductWebUi, path: string, cookie?: string): HttpResult {
  const headers: ApiRequest['headers'] = cookie === undefined ? {} : { cookie }
  return ui.handle({ method: 'GET', path, headers })
}

function loginCookie(ui: ProductWebUi, slug: string, role: string, weddingId?: string): string {
  const body = new URLSearchParams({ role, ...(weddingId ? { wedding_id: weddingId } : {}) }).toString()
  const res = ui.handle({ method: 'POST', path: `/t/${slug}/login`, headers: { 'content-type': 'application/x-www-form-urlencoded' }, rawBody: body })
  expect(res.status).toBe(303)
  const token = /wp_session=([^;]+)/.exec(res.headers['set-cookie'] ?? '')?.[1]
  expect(token).toBeTruthy()
  return `wp_session=${token}`
}

function bodyOf(res: HttpResult): string {
  return typeof res.body === 'string' ? res.body : ''
}

describe('GET /t/:slug/strategy — the themed planning-strategy page', () => {
  it('renders the themed guidance to an authenticated planner', () => {
    const { ui } = makeUi({ champion: CHAMPION })
    const res = get(ui, '/t/acme/strategy', loginCookie(ui, 'acme', 'planner'))
    expect(res.status).toBe(200)
    const html = bodyOf(res)
    expect(html).toContain('Data-optimized planning strategy')
    expect(html).toContain('RSVP reminders')
    expect(html).toContain('Reminder bundling')
    expect(html).toContain('Applied automatically')
    expect(html).toMatch(/not a score of any individual wedding/i)
    // Themed: the brand name renders in the shell.
    expect(html).toContain('Acme Weddings')
  })

  it('shows the themed LOGIN (not the page) to an unauthenticated visitor of an active tenant', () => {
    const { ui } = makeUi({ champion: CHAMPION })
    const res = get(ui, '/t/acme/strategy')
    expect(res.status).toBe(200)
    expect(bodyOf(res)).toContain('Sign in') // the login form, themed
    expect(bodyOf(res)).not.toContain('Data-optimized planning strategy')
  })

  it('masks unknown and suspended tenants as the constant 404 (no theme)', () => {
    const { ui } = makeUi({ champion: CHAMPION })
    expect(get(ui, '/t/ghost/strategy').status).toBe(404)
    expect(get(ui, '/t/dormant/strategy').status).toBe(404)
    expect(bodyOf(get(ui, '/t/dormant/strategy'))).not.toContain('Acme Weddings') // no theme leak
  })

  it('leaks NO engine lineage/surface internals in the rendered page', () => {
    const { ui } = makeUi({ champion: CHAMPION })
    const html = bodyOf(get(ui, '/t/acme/strategy', loginCookie(ui, 'acme', 'planner')))
    expect(html).not.toContain('g_pub_secret_lineage') // genome_id
    expect(html).not.toContain('genome:') // content-hash artifact ref
    expect(html).not.toMatch(/planning_flow_orchestration|commitment_autonomy/) // surface names
    expect(html).not.toMatch(/RISK\.|PRODUCT\.|CONTRACT\./) // error codes
    expect(html).not.toMatch(/tenant_[A-Za-z0-9]/) // no tenant_id
  })

  it('renders BYTE-IDENTICAL for a planner and a couple (platform-global, role-agnostic)', () => {
    const { ui } = makeUi({ champion: CHAMPION })
    const plannerHtml = bodyOf(get(ui, '/t/acme/strategy', loginCookie(ui, 'acme', 'planner')))
    const coupleHtml = bodyOf(get(ui, '/t/acme/strategy', loginCookie(ui, 'acme', 'couple', 'wedding_anything')))
    expect(coupleHtml).toBe(plannerHtml)
  })

  it('the console links to the strategy page', () => {
    const { ui } = makeUi({ champion: CHAMPION })
    const html = bodyOf(get(ui, '/t/acme', loginCookie(ui, 'acme', 'planner')))
    expect(html).toContain('/t/acme/strategy')
    expect(html).toMatch(/planning strategy/i)
  })

  it('masks the page as 404 when no champion is published (still themed-login when unauthed)', () => {
    const { ui } = makeUi() // no champion
    expect(get(ui, '/t/acme/strategy', loginCookie(ui, 'acme', 'planner')).status).toBe(404)
    expect(get(ui, '/t/acme/strategy').status).toBe(200) // unauthed → themed login, champion-absence not observable
  })
})
