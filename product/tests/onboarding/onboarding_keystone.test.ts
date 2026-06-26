import { ManualClock, SequentialIdGenerator, type Tenant } from '@wedding-planner/shared'
import { describe, expect, it } from 'vitest'

import {
  type ApiRequest,
  type ApiResponse,
  BillingLedger,
  OnboardingService,
  OperatorCredentialStore,
  ProductApi,
  SessionStore,
  TenantContextResolver,
  TenantStore,
  WeddingAuthorizer,
  WeddingRepository,
} from '@wedding-planner/product'

/**
 * THE ONBOARDING KEYSTONE — the load-bearing regression for the third (platform/operator) trust tier
 * and the lifecycle driver (Phase 15).
 *
 * Phase 15 adds an operator-gated /admin surface that provisions tenants and drives their lifecycle. This
 * pins the two properties that surface MUST hold, forever:
 *
 *  1. It introduces NO new anonymous oracle. The pre-existing disclosure boundary — absent ≡ suspended ≡
 *     onboarding is byte-identical 404, while active existence is disclosed (401) — is UNCHANGED. A
 *     provisioned-but-onboarding tenant is byte-identical (on BOTH the list and the login edge) to an
 *     absent one and to a suspended one. Provisioning state is reachable ONLY through an operator
 *     credential, and an unauthenticated /admin probe is a byte-identical 401 for ANY method/path (route
 *     shape is not a pre-auth oracle).
 *  2. The three token namespaces never cross: an operator token is rejected on a tenant route, and a
 *     tenant session token is rejected on /admin — both via the SAME constant 401 as no token at all.
 *
 * Run against the pure handler (no sockets) so the adversarial surface is fast and deterministic.
 */

const THEME: Tenant['theme'] = {
  brand_name: 'Brand',
  primary_color_hex: '#111111',
  accent_color_hex: '#222222',
  logo_ref: 'asset_1',
}

const OP = 'op-secret'
const NOT_FOUND: ApiResponse = { status: 404, body: { error: 'not_found' } }
const UNAUTHORIZED: ApiResponse = { status: 401, body: { error: 'unauthorized' } }

function req(method: string, path: string, opts: { token?: string; body?: unknown } = {}): ApiRequest {
  const headers: Record<string, string | undefined> = {}
  if (opts.token !== undefined) headers.authorization = `Bearer ${opts.token}`
  return { method, path, headers, rawBody: opts.body === undefined ? undefined : JSON.stringify(opts.body) }
}

function makeWorld() {
  const store = new TenantStore(new ManualClock('2027-03-01T00:00:00.000Z'), new SequentialIdGenerator('seedT'))
  const api = new ProductApi({
    resolver: new TenantContextResolver(store),
    sessionStore: new SessionStore(new SequentialIdGenerator('seedS')),
    operators: new OperatorCredentialStore(new SequentialIdGenerator('seedO'), [OP]),
    onboarding: new OnboardingService(
      store,
      new BillingLedger(new ManualClock('2027-03-01T00:00:00.000Z'), new SequentialIdGenerator('seedB')),
    ),
    weddings: new WeddingRepository(store, new ManualClock('2027-04-01T00:00:00.000Z'), new SequentialIdGenerator('seedW')),
    authorizer: new WeddingAuthorizer(),
  })

  const provision = (slug: string): string => {
    const res = api.handle(req('POST', '/admin/tenants', { token: OP, body: { slug, display_name: slug, plan_tier: 'studio', theme: THEME } }))
    expect(res.status).toBe(201)
    return (res.body as { tenant: { tenant_id: string } }).tenant.tenant_id
  }

  // Three lifecycle states behind the same provisioning flow + one never-provisioned slug ('ghost').
  const onboardingId = provision('onboard1')
  const activeId = provision('active1')
  expect(api.handle(req('POST', `/admin/tenants/${activeId}/activate`, { token: OP })).status).toBe(200)
  const suspendedId = provision('susp1')
  api.handle(req('POST', `/admin/tenants/${suspendedId}/activate`, { token: OP }))
  api.handle(req('POST', `/admin/tenants/${suspendedId}/suspend`, { token: OP }))

  // A real tenant session on the active tenant (a token from the OTHER — session — namespace).
  const loginRes = api.handle(req('POST', '/t/active1/sessions', { body: { role: 'planner' } }))
  expect(loginRes.status).toBe(201)
  const sessionToken = (loginRes.body as { token: string }).token

  return { api, store, onboardingId, activeId, suspendedId, sessionToken }
}

describe('Onboarding keystone — the /admin operator boundary (no pre-auth oracle)', () => {
  it('an unauthenticated /admin probe is byte-identical 401 for ANY method and path shape', () => {
    const w = makeWorld()
    const paths = ['/admin', '/admin/tenants', '/admin/nope', '/admin/tenants/x/activate', '/admin/tenants/x/billing']
    for (const method of ['GET', 'POST', 'PUT', 'DELETE']) {
      for (const path of paths) {
        // No token, and a foreign (non-operator) token — both byte-identical 401: route shape, method
        // mismatch, and unknown sub-route are ALL unreachable before operator-auth.
        expect(w.api.handle(req(method, path))).toEqual(UNAUTHORIZED)
        expect(w.api.handle(req(method, path, { token: 'not-an-operator' }))).toEqual(UNAUTHORIZED)
      }
    }
  })

  it('an unknown top-level path stays byte-identical 404 (the /admin fold did not perturb the catch-all)', () => {
    const w = makeWorld()
    expect(w.api.handle(req('GET', '/nonsense'))).toEqual(NOT_FOUND)
    expect(w.api.handle(req('POST', '/nonsense'))).toEqual(NOT_FOUND)
  })
})

describe('Onboarding keystone — the anonymous mask is preserved (provisioning adds no oracle)', () => {
  it('onboarding ≡ suspended ≡ absent: byte-identical 404 on BOTH the list edge and the login edge', () => {
    const w = makeWorld()
    const listEdges = ['onboard1', 'susp1', 'ghost'].map((slug) => w.api.handle(req('GET', `/t/${slug}/weddings`)))
    const loginEdges = ['onboard1', 'susp1', 'ghost'].map((slug) =>
      w.api.handle(req('POST', `/t/${slug}/sessions`, { body: { role: 'planner' } })),
    )
    for (const res of [...listEdges, ...loginEdges]) expect(res).toEqual(NOT_FOUND)
  })

  it('only the ACTIVE tenant discloses existence (401 unauth list; 201 login) — the pre-Phase-15 boundary', () => {
    const w = makeWorld()
    expect(w.api.handle(req('GET', '/t/active1/weddings'))).toEqual(UNAUTHORIZED)
    expect(w.api.handle(req('POST', '/t/active1/sessions', { body: { role: 'planner' } })).status).toBe(201)
  })
})

describe('Onboarding keystone — the three token namespaces never cross', () => {
  it('an operator token is rejected on a tenant route (same constant 401 as no token)', () => {
    const w = makeWorld()
    expect(w.api.handle(req('GET', '/t/active1/weddings', { token: OP }))).toEqual(UNAUTHORIZED)
    expect(w.api.handle(req('GET', '/t/active1/weddings'))).toEqual(UNAUTHORIZED)
  })

  it('a tenant session token is rejected on /admin (same constant 401 as no token)', () => {
    const w = makeWorld()
    expect(w.api.handle(req('POST', '/admin/tenants', { token: w.sessionToken, body: {} }))).toEqual(UNAUTHORIZED)
    expect(w.api.handle(req('GET', `/admin/tenants/${w.activeId}/billing`, { token: w.sessionToken }))).toEqual(
      UNAUTHORIZED,
    )
  })
})

describe('Onboarding keystone — the lifecycle drive end-to-end + the billing fold', () => {
  it('provision → activate → suspend → reactivate is tracked by the JSON edge', () => {
    const w = makeWorld()
    const id = w.api
      .handle(req('POST', '/admin/tenants', { token: OP, body: { slug: 'drive', display_name: 'Drive', plan_tier: 'solo', theme: THEME } }))
      .body as { tenant: { tenant_id: string } }
    const tid = id.tenant.tenant_id
    expect(w.api.handle(req('GET', '/t/drive/weddings'))).toEqual(NOT_FOUND) // onboarding
    w.api.handle(req('POST', `/admin/tenants/${tid}/activate`, { token: OP }))
    expect(w.api.handle(req('GET', '/t/drive/weddings'))).toEqual(UNAUTHORIZED) // active
    w.api.handle(req('POST', `/admin/tenants/${tid}/suspend`, { token: OP }))
    expect(w.api.handle(req('GET', '/t/drive/weddings'))).toEqual(NOT_FOUND) // suspended
    w.api.handle(req('POST', `/admin/tenants/${tid}/reactivate`, { token: OP }))
    expect(w.api.handle(req('GET', '/t/drive/weddings'))).toEqual(UNAUTHORIZED) // active again
  })

  it('the billing view is per-tenant: querying one tenant never returns another tenant\'s events', () => {
    const w = makeWorld()
    const active = w.api.handle(req('GET', `/admin/tenants/${w.activeId}/billing`, { token: OP }))
    const onboarding = w.api.handle(req('GET', `/admin/tenants/${w.onboardingId}/billing`, { token: OP }))
    // active1 was charged+paid on activation (settled, 0); onboard1 only has its provisioned marker.
    expect((active.body as { events: { kind: string }[] }).events.map((e) => e.kind)).toEqual([
      'provisioned',
      'charge',
      'payment',
    ])
    expect((active.body as { balance_cents: number }).balance_cents).toBe(0)
    expect((onboarding.body as { events: { kind: string }[] }).events.map((e) => e.kind)).toEqual(['provisioned'])
  })

  it('a duplicate slug is an honest 409 to the operator (NOT masked — the operator legitimately sees state)', () => {
    const w = makeWorld()
    const dup = w.api.handle(req('POST', '/admin/tenants', { token: OP, body: { slug: 'active1', display_name: 'Dup', plan_tier: 'solo', theme: THEME } }))
    expect(dup.status).toBe(409)
  })
})
