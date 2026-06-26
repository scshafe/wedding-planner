import { ManualClock, SequentialIdGenerator, type Tenant, type Wedding } from '@wedding-planner/shared'
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
 * THE HTTP KEYSTONE — the load-bearing request-edge regression (Phase 13).
 *
 * The product surface now stacks two boundaries: the inter-tenant TenantContext (Phase 12, by
 * construction) and the intra-tenant Principal (planner vs couple, this phase). This pins that NEITHER
 * can be crossed from the request edge, and that the intra-tenant gate carries Phase 12's
 * no-existence-oracle one layer up: a couple addressing a wedding that is not theirs is BYTE-IDENTICAL
 * to a missing wedding. Phases 14–16 build on this edge and may not weaken it.
 *
 * Run against the pure handler (no sockets) so the adversarial surface is fast and deterministic.
 */

const THEME: Tenant['theme'] = {
  brand_name: 'Brand',
  primary_color_hex: '#111111',
  accent_color_hex: '#222222',
  logo_ref: 'asset_1',
}

const NOT_FOUND: ApiResponse = { status: 404, body: { error: 'not_found' } }
const UNAUTHORIZED: ApiResponse = { status: 401, body: { error: 'unauthorized' } }

interface World {
  api: ProductApi
  store: TenantStore
  tenantA: Tenant
  tenantB: Tenant
  pA: string // planner token, tenant A
  pB: string // planner token, tenant B
  wA1: string // a wedding in A, owned by coupleA1
  wA2: string // another wedding in A, owned by someone else
  wB: string // a wedding in B
  coupleA1: string // couple token in A bound to wA1
  couplePhantom: string // couple token in A bound to a never-created wedding
}

function makeWorld(): World {
  const store = new TenantStore(
    new ManualClock('2027-03-01T00:00:00.000Z'),
    new SequentialIdGenerator('seedT'),
  )
  const tenantA = store.create({ slug: 'alpha', display_name: 'Alpha', theme: THEME, plan_tier: 'solo', lifecycle_status: 'active' })
  const tenantB = store.create({ slug: 'beta', display_name: 'Beta', theme: THEME, plan_tier: 'solo', lifecycle_status: 'active' })
  const api = new ProductApi({
    resolver: new TenantContextResolver(store),
    sessionStore: new SessionStore(new SequentialIdGenerator('seedS')),
    operators: new OperatorCredentialStore(new SequentialIdGenerator('seedO'), ['op-secret']),
    onboarding: new OnboardingService(store, new BillingLedger(new ManualClock('2027-03-01T00:00:00.000Z'), new SequentialIdGenerator('seedB'))),
    weddings: new WeddingRepository(store, new ManualClock('2027-04-01T00:00:00.000Z'), new SequentialIdGenerator('seedW')),
    authorizer: new WeddingAuthorizer(),
  })

  const login = (slug: string, body: { role: string; wedding_id?: string }): string => {
    const res = api.handle(httpReq('POST', `/t/${slug}/sessions`, { body }))
    expect(res.status).toBe(201)
    return (res.body as { token: string }).token
  }
  const create = (slug: string, token: string, name: string): string => {
    const res = api.handle(httpReq('POST', `/t/${slug}/weddings`, { token, body: { couple_display_name: name, event_date: '2028-01-01' } }))
    expect(res.status).toBe(201)
    return (res.body as { wedding: Wedding }).wedding.wedding_id
  }

  const pA = login('alpha', { role: 'planner' })
  const pB = login('beta', { role: 'planner' })
  const wA1 = create('alpha', pA, 'A couple 1')
  const wA2 = create('alpha', pA, 'A couple 2')
  const wB = create('beta', pB, 'B couple')
  const coupleA1 = login('alpha', { role: 'couple', wedding_id: wA1 })
  const couplePhantom = login('alpha', { role: 'couple', wedding_id: 'wedding_never_created' })

  return { api, store, tenantA, tenantB, pA, pB, wA1, wA2, wB, coupleA1, couplePhantom }
}

function httpReq(method: string, path: string, opts: { token?: string; body?: unknown; rawBody?: string } = {}): ApiRequest {
  const headers: Record<string, string | undefined> = {}
  if (opts.token !== undefined) headers.authorization = `Bearer ${opts.token}`
  return {
    method,
    path,
    headers,
    rawBody: opts.rawBody ?? (opts.body === undefined ? undefined : JSON.stringify(opts.body)),
  }
}

describe('HTTP keystone — the two stacked boundaries at the request edge', () => {
  it('(a) cross-tenant routing read: A’s planner token on B’s route cannot read B’s wedding', () => {
    const w = makeWorld()
    // Tenant is resolved from the ROUTE (beta); the A-bound session does not match -> 401, not B’s data.
    const res = w.api.handle(httpReq('GET', `/t/beta/weddings/${w.wB}`, { token: w.pA }))
    expect(res).toEqual(UNAUTHORIZED)
    expect(JSON.stringify(res)).not.toContain('B couple')
  })

  it('(b) cross-tenant session replay: A’s token on B’s list route -> 401, never re-scoped to A', () => {
    const w = makeWorld()
    const res = w.api.handle(httpReq('GET', '/t/beta/weddings', { token: w.pA }))
    expect(res).toEqual(UNAUTHORIZED)
    // Not silently scoped to A: A’s weddings must not appear.
    expect(JSON.stringify(res)).not.toContain('A couple')
  })

  it('(c) intra-tenant no-oracle (all directions, GET): foreign-exists, own-absent, missing, and unknown-route are byte-identical 404', () => {
    const w = makeWorld()
    // couple bound to wA1 reading wA2 (a real, foreign-but-same-tenant wedding).
    const foreignExists = w.api.handle(httpReq('GET', `/t/alpha/weddings/${w.wA2}`, { token: w.coupleA1 }))
    // couple bound to a never-created id reading their own (absent) id.
    const ownAbsent = w.api.handle(httpReq('GET', '/t/alpha/weddings/wedding_never_created', { token: w.couplePhantom }))
    // couple reading a genuinely unknown id (non-owned).
    const missing = w.api.handle(httpReq('GET', '/t/alpha/weddings/wedding_nonexistent', { token: w.coupleA1 }))
    // an unknown route under a valid tenant (authenticated).
    const unknownRoute = w.api.handle(httpReq('GET', '/t/alpha/widgets/x', { token: w.coupleA1 }))

    expect(foreignExists).toEqual(NOT_FOUND)
    expect(foreignExists).toEqual(ownAbsent)
    expect(foreignExists).toEqual(missing)
    expect(foreignExists).toEqual(unknownRoute)
    // The body never reveals the foreign couple’s data.
    expect(JSON.stringify(foreignExists)).not.toContain('A couple 2')
  })

  it('(c2) intra-tenant no-oracle (PUT): a couple updating a foreign vs a missing id are byte-identical 404', () => {
    const w = makeWorld()
    const foreign = w.api.handle(httpReq('PUT', `/t/alpha/weddings/${w.wA2}`, { token: w.coupleA1, body: { status: 'active' } }))
    const missing = w.api.handle(httpReq('PUT', '/t/alpha/weddings/wedding_nonexistent', { token: w.coupleA1, body: { status: 'active' } }))
    expect(foreign).toEqual(NOT_FOUND)
    expect(foreign).toEqual(missing)
    // The foreign wedding must be untouched (still owned by tenant A, still its original couple).
    const check = w.api.handle(httpReq('GET', `/t/alpha/weddings/${w.wA2}`, { token: w.pA }))
    expect((check.body as { wedding: Wedding }).wedding.status).toBe('planning')
  })

  it('(c3) a couple updating their OWN wedding succeeds (the mask does not over-deny)', () => {
    const w = makeWorld()
    const res = w.api.handle(httpReq('PUT', `/t/alpha/weddings/${w.wA1}`, { token: w.coupleA1, body: { status: 'active' } }))
    expect(res.status).toBe(200)
    expect((res.body as { wedding: Wedding }).wedding.status).toBe('active')
  })

  it('(d) capability denial: a couple creating -> 403, distinct from the 404 mask and never a 500', () => {
    const w = makeWorld()
    const res = w.api.handle(httpReq('POST', '/t/alpha/weddings', { token: w.coupleA1, body: { couple_display_name: 'x', event_date: '2028-01-01' } }))
    expect(res.status).toBe(403)
    expect(res.body).toEqual({ error: 'forbidden' })
  })

  it('(e) couple list is narrowed to their own wedding; planner list is full', () => {
    const w = makeWorld()
    const coupleList = w.api.handle(httpReq('GET', '/t/alpha/weddings', { token: w.coupleA1 }))
    expect((coupleList.body as { weddings: Wedding[] }).weddings.map((x) => x.wedding_id)).toEqual([w.wA1])

    const plannerList = w.api.handle(httpReq('GET', '/t/alpha/weddings', { token: w.pA }))
    expect((plannerList.body as { weddings: Wedding[] }).weddings.map((x) => x.wedding_id).sort()).toEqual([w.wA1, w.wA2].sort())

    // A couple bound to a never-created wedding sees an empty list — no tenant cardinality leak.
    const phantomList = w.api.handle(httpReq('GET', '/t/alpha/weddings', { token: w.couplePhantom }))
    expect((phantomList.body as { weddings: Wedding[] }).weddings).toEqual([])
  })

  it('(f) no session -> 401; an unknown token -> 401', () => {
    const w = makeWorld()
    expect(w.api.handle(httpReq('GET', '/t/alpha/weddings'))).toEqual(UNAUTHORIZED)
    expect(w.api.handle(httpReq('GET', '/t/alpha/weddings', { token: 'forged_token' }))).toEqual(UNAUTHORIZED)
  })

  it('(g) fail closed mid-session: suspend the tenant after login -> the next request is 404', () => {
    const w = makeWorld()
    // The planner token was valid; now suspend tenant A out from under it.
    w.store.setLifecycleStatus(w.tenantA.tenant_id, 'suspended')
    const res = w.api.handle(httpReq('GET', '/t/alpha/weddings', { token: w.pA }))
    // Tenant resolution fails closed at stage 2 (suspended == absent at the edge) -> 404.
    expect(res).toEqual(NOT_FOUND)
  })

  it('(h) the body cannot carry a foreign tenant_id, a wedding_id, or a __proto__ payload', () => {
    const w = makeWorld()
    // Create with smuggled tenant_id + wedding_id + a prototype-pollution key.
    const created = w.api.handle(
      httpReq('POST', '/t/alpha/weddings', {
        token: w.pA,
        rawBody: JSON.stringify({
          couple_display_name: 'Smuggler',
          event_date: '2028-02-02',
          tenant_id: w.tenantB.tenant_id,
          wedding_id: 'wedding_attacker_chosen',
          __proto__: { tenant_id: w.tenantB.tenant_id },
        }),
      }),
    )
    expect(created.status).toBe(201)
    const wedding = (created.body as { wedding: Wedding }).wedding
    // Ownership is the route/context tenant, never the smuggled one; the id is server-minted.
    expect(wedding.tenant_id).toBe(w.tenantA.tenant_id)
    expect(wedding.wedding_id).not.toBe('wedding_attacker_chosen')
    // Prototype pollution did not take: a plain object’s tenant_id is not B.
    expect(({} as Record<string, unknown>).tenant_id).toBeUndefined()

    // And a PUT cannot re-target identity/ownership via the body either.
    const updated = w.api.handle(
      httpReq('PUT', `/t/alpha/weddings/${w.wA1}`, {
        token: w.pA,
        rawBody: JSON.stringify({ status: 'active', tenant_id: w.tenantB.tenant_id, wedding_id: w.wA2 }),
      }),
    )
    expect(updated.status).toBe(200)
    const uw = (updated.body as { wedding: Wedding }).wedding
    expect(uw.tenant_id).toBe(w.tenantA.tenant_id)
    expect(uw.wedding_id).toBe(w.wA1)
  })

  it('(i) wrong method, unauthenticated, on a tenant route -> 401 (route shape is not a pre-auth oracle)', () => {
    const w = makeWorld()
    // DELETE on a known protected route WITHOUT a session: auth runs before the 405 check.
    expect(w.api.handle(httpReq('DELETE', '/t/alpha/weddings'))).toEqual(UNAUTHORIZED)
    // With a valid session, the same wrong method surfaces as 405.
    expect(w.api.handle(httpReq('DELETE', '/t/alpha/weddings', { token: w.pA })).status).toBe(405)
  })

  it('(j) login is not an existence oracle: a phantom wedding_id logs in identically to a real one', () => {
    const w = makeWorld()
    const real = w.api.handle(httpReq('POST', '/t/alpha/sessions', { body: { role: 'couple', wedding_id: w.wA1 } }))
    const phantom = w.api.handle(httpReq('POST', '/t/alpha/sessions', { body: { role: 'couple', wedding_id: 'wedding_does_not_exist' } }))
    // Both succeed with the same status — login leaks no signal about which wedding_ids exist.
    expect(real.status).toBe(201)
    expect(phantom.status).toBe(201)
    // The difference only surfaces, masked, at read time.
    const phantomToken = (phantom.body as { token: string }).token
    expect(w.api.handle(httpReq('GET', '/t/alpha/weddings/wedding_does_not_exist', { token: phantomToken }))).toEqual(NOT_FOUND)
  })
})
