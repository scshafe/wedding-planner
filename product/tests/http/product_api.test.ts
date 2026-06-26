import { ManualClock, SequentialIdGenerator, type Tenant, type Wedding } from '@wedding-planner/shared'
import { beforeEach, describe, expect, it } from 'vitest'

import {
  type ApiRequest,
  type ApiResponse,
  ProductApi,
  SessionStore,
  TenantContextResolver,
  TenantStore,
  WeddingAuthorizer,
  WeddingRepository,
} from '@wedding-planner/product'

/**
 * Step-3 handler-level coverage: every endpoint's happy path + the error->status map. The adversarial
 * cross-boundary cases live in the keystone (Step 5); here we prove the routes work and map correctly.
 */

const THEME: Tenant['theme'] = {
  brand_name: 'Brand',
  primary_color_hex: '#111111',
  accent_color_hex: '#222222',
  logo_ref: 'asset_1',
}

interface World {
  api: ProductApi
  sessions: SessionStore
  weddings: WeddingRepository
  resolver: TenantContextResolver
}

function makeWorld(): World {
  const store = new TenantStore(
    new ManualClock('2027-03-01T00:00:00.000Z'),
    new SequentialIdGenerator('seedT'),
  )
  store.create({ slug: 'alpha', display_name: 'Alpha', theme: THEME, plan_tier: 'solo', lifecycle_status: 'active' })
  const resolver = new TenantContextResolver(store)
  const sessions = new SessionStore(new SequentialIdGenerator('seedS'))
  const weddings = new WeddingRepository(
    store,
    new ManualClock('2027-04-01T00:00:00.000Z'),
    new SequentialIdGenerator('seedW'),
  )
  const authorizer = new WeddingAuthorizer()
  const api = new ProductApi({ resolver, sessionStore: sessions, weddings, authorizer })
  return { api, sessions, weddings, resolver }
}

function req(method: string, path: string, opts: { token?: string; body?: unknown } = {}): ApiRequest {
  const headers: Record<string, string | undefined> = {}
  if (opts.token !== undefined) headers.authorization = `Bearer ${opts.token}`
  return {
    method,
    path,
    headers,
    rawBody: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  }
}

/** Log in a planner for the alpha tenant and return the token. */
function plannerToken(w: World): string {
  return loginToken(w, { role: 'planner' })
}
function loginToken(w: World, body: { role: string; wedding_id?: string }): string {
  const res = w.api.handle(req('POST', '/t/alpha/sessions', { body }))
  expect(res.status).toBe(201)
  return (res.body as { token: string }).token
}
function weddingOf(res: ApiResponse): Wedding {
  return (res.body as { wedding: Wedding }).wedding
}

describe('product_api — endpoints', () => {
  let w: World
  beforeEach(() => {
    w = makeWorld()
  })

  it('GET /healthz -> 200 constant, no tenant/auth', () => {
    const res = w.api.handle(req('GET', '/healthz'))
    expect(res).toEqual({ status: 200, body: { status: 'ok' } })
  })

  it('POST /t/:slug/sessions logs in a planner and a couple', () => {
    const planner = w.api.handle(req('POST', '/t/alpha/sessions', { body: { role: 'planner' } }))
    expect(planner.status).toBe(201)
    expect((planner.body as { principal: { role: string } }).principal.role).toBe('planner')

    const couple = w.api.handle(req('POST', '/t/alpha/sessions', { body: { role: 'couple', wedding_id: 'w1' } }))
    expect(couple.status).toBe(201)
    expect((couple.body as { principal: { wedding_id: string } }).principal.wedding_id).toBe('w1')
  })

  it('a planner can create, read, list, and update a wedding', () => {
    const token = plannerToken(w)
    const created = w.api.handle(
      req('POST', '/t/alpha/weddings', { token, body: { couple_display_name: 'Alex & Sam', event_date: '2028-09-09' } }),
    )
    expect(created.status).toBe(201)
    const id = weddingOf(created).wedding_id

    const read = w.api.handle(req('GET', `/t/alpha/weddings/${id}`, { token }))
    expect(read.status).toBe(200)
    expect(weddingOf(read).couple_display_name).toBe('Alex & Sam')

    const list = w.api.handle(req('GET', '/t/alpha/weddings', { token }))
    expect(list.status).toBe(200)
    expect((list.body as { weddings: Wedding[] }).weddings).toHaveLength(1)

    const updated = w.api.handle(
      req('PUT', `/t/alpha/weddings/${id}`, { token, body: { status: 'active' } }),
    )
    expect(updated.status).toBe(200)
    expect(weddingOf(updated).status).toBe('active')
    // The update preserved identity/ownership from route+context, not the body.
    expect(weddingOf(updated).wedding_id).toBe(id)
  })

  it('a couple sees only their own wedding in a list and can read/update it', () => {
    const ptoken = plannerToken(w)
    const created = w.api.handle(
      req('POST', '/t/alpha/weddings', { token: ptoken, body: { couple_display_name: 'Couple', event_date: '2028-01-01' } }),
    )
    const id = weddingOf(created).wedding_id

    const ctoken = loginToken(w, { role: 'couple', wedding_id: id })
    const list = w.api.handle(req('GET', '/t/alpha/weddings', { token: ctoken }))
    expect((list.body as { weddings: Wedding[] }).weddings.map((x) => x.wedding_id)).toEqual([id])

    const read = w.api.handle(req('GET', `/t/alpha/weddings/${id}`, { token: ctoken }))
    expect(read.status).toBe(200)
  })

  describe('the status map', () => {
    it('unknown tenant -> 404', () => {
      expect(w.api.handle(req('GET', '/t/ghost/weddings', { token: 'x' })).status).toBe(404)
    })
    it('no session -> 401; unknown token -> 401', () => {
      expect(w.api.handle(req('GET', '/t/alpha/weddings')).status).toBe(401)
      expect(w.api.handle(req('GET', '/t/alpha/weddings', { token: 'nope' })).status).toBe(401)
    })
    it('a couple creating -> 403 (capability denial)', () => {
      const ctoken = loginToken(w, { role: 'couple', wedding_id: 'w1' })
      const res = w.api.handle(
        req('POST', '/t/alpha/weddings', { token: ctoken, body: { couple_display_name: 'x', event_date: '2028-01-01' } }),
      )
      expect(res.status).toBe(403)
    })
    it('a malformed body -> 400; a bad enum -> 400', () => {
      const token = plannerToken(w)
      expect(w.api.handle({ method: 'POST', path: '/t/alpha/weddings', headers: { authorization: `Bearer ${token}` }, rawBody: '{not json' }).status).toBe(400)
      expect(
        w.api.handle(req('POST', '/t/alpha/weddings', { token, body: { couple_display_name: 'x', event_date: 'NOT-A-DATE' } })).status,
      ).toBe(400)
    })
    it('an unknown route -> 404; a bad method on a known route (authed) -> 405', () => {
      const token = plannerToken(w)
      expect(w.api.handle(req('GET', '/t/alpha/nope', { token })).status).toBe(404)
      expect(w.api.handle(req('DELETE', '/t/alpha/weddings', { token })).status).toBe(405)
    })
    it('login requires role planner|couple -> 400 otherwise', () => {
      expect(w.api.handle(req('POST', '/t/alpha/sessions', { body: { role: 'admin' } })).status).toBe(400)
    })
  })
})
