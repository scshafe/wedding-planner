import { ManualClock, SequentialIdGenerator, type StrategyGenome, type Tenant } from '@wedding-planner/shared'
import { describe, expect, it } from 'vitest'

import {
  type ApiRequest,
  BillingLedger,
  OnboardingService,
  OperatorCredentialStore,
  ProviderWebhookCredentialStore,
  ProductApi,
  type ProductApiDeps,
  SessionStore,
  TenantContextResolver,
  TenantStore,
  WeddingAuthorizer,
  WeddingRepository,
} from '@wedding-planner/product'

/**
 * Step-2 coverage for GET /t/:slug/strategy (Phase 17) — the read-only champion-strategy endpoint riding the
 * SAME 5-stage pipeline. The load-bearing properties: stages 3–4 run BEFORE the method check (route shape is
 * not a pre-auth oracle), the present/absent answer is platform-global (reads no tenant/principal state), and
 * the masked 404 / 401 are byte-identical to the rest of the pipeline.
 */

const THEME: Tenant['theme'] = {
  brand_name: 'Brand',
  primary_color_hex: '#111111',
  accent_color_hex: '#222222',
  logo_ref: 'asset_1',
}

const CHAMPION: StrategyGenome = {
  genome_id: 'g_pub',
  parameters: { rsvp_reminder_cadence: 3, reminder_spacing: 1, reminder_batching: 1 },
}

function makeApi(opts: { champion?: StrategyGenome } = {}): ProductApi {
  const store = new TenantStore(new ManualClock('2027-03-01T00:00:00.000Z'), new SequentialIdGenerator('seedT'))
  store.create({ slug: 'alpha', display_name: 'Alpha', theme: THEME, plan_tier: 'solo', lifecycle_status: 'active' })
  store.create({ slug: 'beta', display_name: 'Beta', theme: THEME, plan_tier: 'solo', lifecycle_status: 'active' })
  store.create({ slug: 'sleepy', display_name: 'Sleepy', theme: THEME, plan_tier: 'solo', lifecycle_status: 'suspended' })
  const deps: ProductApiDeps = {
    resolver: new TenantContextResolver(store),
    sessionStore: new SessionStore(new SequentialIdGenerator('seedS')),
    weddings: new WeddingRepository(store, new ManualClock('2027-04-01T00:00:00.000Z'), new SequentialIdGenerator('seedW')),
    authorizer: new WeddingAuthorizer(),
    operators: new OperatorCredentialStore(new SequentialIdGenerator('seedO'), ['op-secret']),
    webhookCredentials: new ProviderWebhookCredentialStore(new SequentialIdGenerator('seedW'), ['wh-secret']),
    onboarding: new OnboardingService(store, new BillingLedger(new ManualClock('2027-03-01T00:00:00.000Z'), new SequentialIdGenerator('seedB'))),
    ...(opts.champion === undefined ? {} : { championStrategy: opts.champion }),
  }
  return new ProductApi(deps)
}

function req(method: string, path: string, token?: string): ApiRequest {
  return { method, path, headers: token === undefined ? {} : { authorization: `Bearer ${token}` } }
}

function loginToken(api: ProductApi, slug: string, role = 'planner'): string {
  const res = api.handle({ method: 'POST', path: `/t/${slug}/sessions`, headers: {}, rawBody: JSON.stringify({ role }) })
  expect(res.status).toBe(201)
  return (res.body as { token: string }).token
}

describe('GET /t/:slug/strategy — the champion-strategy endpoint', () => {
  it('returns the projected guidance (200) to an authenticated planner', () => {
    const api = makeApi({ champion: CHAMPION })
    const res = api.handle(req('GET', '/t/alpha/strategy', loginToken(api, 'alpha')))
    expect(res.status).toBe(200)
    const strategy = (res.body as { strategy: { headline: string; autonomy: { tier: number }; knobs: unknown[] } }).strategy
    expect(strategy.headline).toMatch(/strategy/i)
    expect(strategy.autonomy.tier).toBe(1)
    expect(strategy.knobs).toHaveLength(3)
  })

  it('returns BYTE-IDENTICAL guidance to a couple and a planner (platform-global, role-agnostic)', () => {
    const api = makeApi({ champion: CHAMPION })
    const plannerRes = api.handle(req('GET', '/t/alpha/strategy', loginToken(api, 'alpha', 'planner')))
    // A couple login requires a wedding_id but never verifies it (no oracle) — any id logs in.
    const coupleTok = (api.handle({ method: 'POST', path: '/t/alpha/sessions', headers: {}, rawBody: JSON.stringify({ role: 'couple', wedding_id: 'wedding_x' }) }).body as { token: string }).token
    const coupleRes = api.handle(req('GET', '/t/alpha/strategy', coupleTok))
    expect(coupleRes.status).toBe(200)
    expect(JSON.stringify(coupleRes.body)).toBe(JSON.stringify(plannerRes.body))
  })

  it('401 for an unauthenticated request — for ANY method (route shape is not a pre-auth oracle)', () => {
    const api = makeApi({ champion: CHAMPION })
    expect(api.handle(req('GET', '/t/alpha/strategy')).status).toBe(401)
    // A POST probe with no session also returns 401, NOT 405 — auth precedes the method check.
    expect(api.handle(req('POST', '/t/alpha/strategy')).status).toBe(401)
  })

  it('405 for a non-GET method once authenticated', () => {
    const api = makeApi({ champion: CHAMPION })
    expect(api.handle(req('POST', '/t/alpha/strategy', loginToken(api, 'alpha'))).status).toBe(405)
  })

  it('masked 404 for an unknown or suspended tenant — regardless of auth header', () => {
    const api = makeApi({ champion: CHAMPION })
    expect(api.handle(req('GET', '/t/ghost/strategy')).status).toBe(404)
    expect(api.handle(req('GET', '/t/ghost/strategy', 'whatever')).status).toBe(404)
    expect(api.handle(req('GET', '/t/sleepy/strategy')).status).toBe(404) // suspended ≡ absent
  })

  it('401 for a cross-tenant session (a token minted for beta presented on alpha)', () => {
    const api = makeApi({ champion: CHAMPION })
    const betaTok = loginToken(api, 'beta')
    expect(api.handle(req('GET', '/t/alpha/strategy', betaTok)).status).toBe(401)
  })

  it('masked 404 when NO champion is published — BYTE-IDENTICAL to the unknown-tenant mask (no oracle)', () => {
    const api = makeApi() // no champion injected
    const res = api.handle(req('GET', '/t/alpha/strategy', loginToken(api, 'alpha')))
    expect(res.status).toBe(404)
    // The champion-absent 404 is the SAME frozen masked body as an unknown tenant/resource — not a distinct
    // strategy-specific 404 that could be turned into a champion-presence signal.
    const unknownTenant404 = api.handle(req('GET', '/t/ghost/strategy'))
    expect(res.body).toEqual(unknownTenant404.body)
    // And champion-absence is NOT observable pre-auth: an unauthed probe is still 401, not 404.
    expect(api.handle(req('GET', '/t/alpha/strategy')).status).toBe(401)
  })
})
