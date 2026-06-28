import { ManualClock, SequentialIdGenerator, type Tenant } from '@wedding-planner/shared'
import { describe, expect, it } from 'vitest'

import {
  GuestAuthorizer,
  GuestRegistry,
  type ApiRequest,
  type BillingSummary,
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
  monthlyPriceCents,
} from '@wedding-planner/product'

/**
 * Step-2 coverage for GET /t/:slug/billing (Phase 30) — the planner-facing billing & usage summary on the SAME
 * 5-stage pipeline. Load-bearing properties: planner-only (couple -> 403 for ANY method, no method oracle),
 * auth before the method/authorize check (route shape is not a pre-auth oracle), the summary is folded from the
 * caller's OWN ledger keyed by the trusted context.tenant_id (a body-smuggled tenant_id is inert), and the route
 * is an unmounted-subresource 404 when the billing dep is absent.
 */

const THEME: Tenant['theme'] = {
  brand_name: 'Brand',
  primary_color_hex: '#111111',
  accent_color_hex: '#222222',
  logo_ref: 'asset_1',
}

interface Harness {
  readonly api: ProductApi
  readonly ledger: BillingLedger
  readonly store: TenantStore
}

function makeApi(opts: { mountBilling?: boolean } = {}): Harness {
  const mountBilling = opts.mountBilling ?? true
  const store = new TenantStore(new ManualClock('2027-03-01T00:00:00.000Z'), new SequentialIdGenerator('seedT'))
  store.create({ slug: 'alpha', display_name: 'Alpha', theme: THEME, plan_tier: 'studio', lifecycle_status: 'active' })
  store.create({ slug: 'beta', display_name: 'Beta', theme: THEME, plan_tier: 'solo', lifecycle_status: 'active' })
  store.create({ slug: 'sleepy', display_name: 'Sleepy', theme: THEME, plan_tier: 'solo', lifecycle_status: 'suspended' })
  const ledger = new BillingLedger(new ManualClock('2027-03-01T00:00:00.000Z'), new SequentialIdGenerator('seedB'))
  const guestAuthorizer = new GuestAuthorizer()
  const deps: ProductApiDeps = {
    resolver: new TenantContextResolver(store),
    sessionStore: new SessionStore(new SequentialIdGenerator('seedS')),
    weddings: new WeddingRepository(store, new ManualClock('2027-04-01T00:00:00.000Z'), new SequentialIdGenerator('seedW')),
    authorizer: new WeddingAuthorizer(),
    guests: { registry: new GuestRegistry(store), weddings: new WeddingRepository(store, new ManualClock('2027-04-01T00:00:00.000Z'), new SequentialIdGenerator('seedGW')), authorizer: guestAuthorizer },
    operators: new OperatorCredentialStore(new SequentialIdGenerator('seedO'), ['op-secret']),
    webhookCredentials: new ProviderWebhookCredentialStore(new SequentialIdGenerator('seedWH'), ['wh-secret']),
    onboarding: new OnboardingService(store, ledger),
    ...(mountBilling ? { billing: { ledger, tenants: store, authorizer: guestAuthorizer } } : {}),
  }
  return { api: new ProductApi(deps), ledger, store }
}

function req(method: string, path: string, token?: string, body?: unknown): ApiRequest {
  const headers: Record<string, string> = {}
  if (token !== undefined) headers.authorization = `Bearer ${token}`
  if (body !== undefined) headers['content-type'] = 'application/json'
  return { method, path, headers, ...(body === undefined ? {} : { rawBody: JSON.stringify(body) }) }
}

function loginToken(api: ProductApi, slug: string, role = 'planner', wedding_id?: string): string {
  const loginBody: Record<string, string> = { role }
  if (wedding_id !== undefined) loginBody.wedding_id = wedding_id
  const res = api.handle({ method: 'POST', path: `/t/${slug}/sessions`, headers: { 'content-type': 'application/json' }, rawBody: JSON.stringify(loginBody) })
  expect(res.status).toBe(201)
  return (res.body as { token: string }).token
}

function tenantId(store: TenantStore, slug: string): string {
  const tenant = store.findBySlug(slug)
  expect(tenant).toBeDefined()
  return tenant!.tenant_id
}

describe('GET /t/:slug/billing — the planner billing & usage summary', () => {
  it('returns the tenant summary (200) to an authenticated planner', () => {
    const { api, ledger, store } = makeApi()
    const tid = tenantId(store, 'alpha')
    ledger.record({ tenant_id: tid, kind: 'charge', amount_cents: 9900 })
    ledger.record({ tenant_id: tid, kind: 'payment', amount_cents: 9900 })
    ledger.record({ tenant_id: tid, kind: 'usage_charge', amount_cents: 5 })
    ledger.record({ tenant_id: tid, kind: 'usage_charge', amount_cents: 6 })
    const res = api.handle(req('GET', '/t/alpha/billing', loginToken(api, 'alpha')))
    expect(res.status).toBe(200)
    const billing = (res.body as { billing: BillingSummary }).billing
    expect(billing.plan_tier).toBe('studio')
    expect(billing.monthly_price_cents).toBe(monthlyPriceCents('studio'))
    expect(billing.messages_sent).toBe(2)
    expect(billing.messaging_spend_cents).toBe(11)
    expect(billing.subscription_charges_cents).toBe(9900)
    expect(billing.payments_cents).toBe(9900)
    expect(billing.balance_cents).toBe(11)
  })

  it('reflects ONLY the caller\'s own tenant ledger (another tenant\'s events are invisible)', () => {
    const { api, ledger, store } = makeApi()
    ledger.record({ tenant_id: tenantId(store, 'alpha'), kind: 'usage_charge', amount_cents: 5 })
    ledger.record({ tenant_id: tenantId(store, 'beta'), kind: 'usage_charge', amount_cents: 95 })
    const alpha = (api.handle(req('GET', '/t/alpha/billing', loginToken(api, 'alpha'))).body as { billing: BillingSummary }).billing
    const beta = (api.handle(req('GET', '/t/beta/billing', loginToken(api, 'beta'))).body as { billing: BillingSummary }).billing
    expect(alpha.messaging_spend_cents).toBe(5)
    expect(beta.messaging_spend_cents).toBe(95)
    expect(beta.plan_tier).toBe('solo')
  })

  it('403 for a couple — for ANY method (a capability they lack; no method oracle)', () => {
    const { api } = makeApi()
    const coupleTok = loginToken(api, 'alpha', 'couple', 'wedding_x')
    expect(api.handle(req('GET', '/t/alpha/billing', coupleTok)).status).toBe(403)
    // A couple POST is the SAME 403 (capability check precedes the method branch) — not a 405.
    expect(api.handle(req('POST', '/t/alpha/billing', coupleTok)).status).toBe(403)
  })

  it('a body-smuggled tenant_id is inert — the summary is keyed by the trusted context, never the body', () => {
    const { api, ledger, store } = makeApi()
    ledger.record({ tenant_id: tenantId(store, 'alpha'), kind: 'usage_charge', amount_cents: 5 })
    ledger.record({ tenant_id: tenantId(store, 'beta'), kind: 'usage_charge', amount_cents: 95 })
    // alpha's planner asks for billing but smuggles beta's tenant_id in the body — the summary is still alpha's.
    const res = api.handle(req('GET', '/t/alpha/billing', loginToken(api, 'alpha'), { tenant_id: tenantId(store, 'beta') }))
    const billing = (res.body as { billing: BillingSummary }).billing
    expect(billing.messaging_spend_cents).toBe(5) // alpha's, not beta's 95
    expect(billing.plan_tier).toBe('studio')
  })

  it('401 for an unauthenticated request — for ANY method (route shape is not a pre-auth oracle)', () => {
    const { api } = makeApi()
    expect(api.handle(req('GET', '/t/alpha/billing')).status).toBe(401)
    expect(api.handle(req('POST', '/t/alpha/billing')).status).toBe(401)
  })

  it('405 for a non-GET method once authenticated as a planner', () => {
    const { api } = makeApi()
    expect(api.handle(req('POST', '/t/alpha/billing', loginToken(api, 'alpha'))).status).toBe(405)
  })

  it('masked 404 for an unknown or suspended tenant — regardless of auth header', () => {
    const { api } = makeApi()
    expect(api.handle(req('GET', '/t/ghost/billing')).status).toBe(404)
    expect(api.handle(req('GET', '/t/sleepy/billing')).status).toBe(404) // suspended ≡ absent
  })

  it('401 for a cross-tenant session (a token minted for beta presented on alpha)', () => {
    const { api } = makeApi()
    expect(api.handle(req('GET', '/t/alpha/billing', loginToken(api, 'beta'))).status).toBe(401)
  })

  it('unmounted-subresource 404 when the billing dep is not wired (byte-identical for any caller)', () => {
    const { api } = makeApi({ mountBilling: false })
    // The billing branch is skipped (dep undefined) and the request falls through to routeNotFound -> 404,
    // identical for an authenticated planner and an unauthenticated probe (a valid tenant, no such sub-resource).
    expect(api.handle(req('GET', '/t/alpha/billing', loginToken(api, 'alpha'))).status).toBe(404)
    expect(api.handle(req('GET', '/t/alpha/billing')).status).toBe(404)
  })
})
