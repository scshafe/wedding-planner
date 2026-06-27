import { ManualClock, SequentialIdGenerator, type Tenant, type Wedding } from '@wedding-planner/shared'
import { beforeEach, describe, expect, it } from 'vitest'

import {
  GuestAuthorizer,
  type ApiRequest,
  type ApiResponse,
  BillingLedger,
  DeterministicGuestQaResponder,
  GuestRegistry,
  InboundReceiptLog,
  MessagingService,
  OnboardingService,
  OperatorCredentialStore,
  ProviderWebhookCredentialStore,
  ProductApi,
  SessionStore,
  SimulatedMessagingAdapter,
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
  const operators = new OperatorCredentialStore(new SequentialIdGenerator('seedO'), ['op-secret'])
  const webhookCredentials = new ProviderWebhookCredentialStore(new SequentialIdGenerator('seedW'), ['wh-secret'])
  const billing = new BillingLedger(new ManualClock('2027-03-01T00:00:00.000Z'), new SequentialIdGenerator('seedB'))
  const onboarding = new OnboardingService(store, billing)
  const adapter = new SimulatedMessagingAdapter(new ManualClock('2027-05-01T00:00:00.000Z'), new SequentialIdGenerator('seedM'))
  const messagingService = new MessagingService(adapter, store, billing, new SequentialIdGenerator('seedMS'))
  const api = new ProductApi({
    resolver,
    sessionStore: sessions,
    weddings,
    authorizer,
    guests: { registry: new GuestRegistry(store), weddings, authorizer: new GuestAuthorizer() },
    operators,
    onboarding,
    webhookCredentials,
    messaging: {
      port: adapter,
      receipts: new InboundReceiptLog(store, new SequentialIdGenerator('seedIR')),
      registry: new GuestRegistry(store),
      weddings,
      responder: new DeterministicGuestQaResponder(),
      service: messagingService,
    },
  })
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

  it('create/update carry the optional guest-visible logistics fields (round-trip + patch-preserves + absent-on-create)', () => {
    const token = plannerToken(w)
    // Create with all four logistics fields set.
    const created = w.api.handle(
      req('POST', '/t/alpha/weddings', {
        token,
        body: {
          couple_display_name: 'Logi & Stics',
          event_date: '2028-05-05',
          ceremony_time: '16:30',
          venue_name: 'The Grand Hall',
          parking_info: 'Free lot on 5th St',
          dress_code: 'Black tie',
        },
      }),
    )
    expect(created.status).toBe(201)
    const id = weddingOf(created).wedding_id
    expect(weddingOf(created)).toMatchObject({
      ceremony_time: '16:30',
      venue_name: 'The Grand Hall',
      parking_info: 'Free lot on 5th St',
      dress_code: 'Black tie',
    })

    // Patch one field; the others (and identity) are preserved from the existing record.
    const patched = w.api.handle(req('PUT', `/t/alpha/weddings/${id}`, { token, body: { dress_code: 'Cocktail' } }))
    expect(patched.status).toBe(200)
    expect(weddingOf(patched)).toMatchObject({ dress_code: 'Cocktail', venue_name: 'The Grand Hall', ceremony_time: '16:30' })

    // Create WITHOUT logistics -> the optional fields are simply absent (not null/undefined keys).
    const bare = w.api.handle(
      req('POST', '/t/alpha/weddings', { token, body: { couple_display_name: 'Bare', event_date: '2028-06-06' } }),
    )
    expect(weddingOf(bare)).not.toHaveProperty('dress_code')
    expect(weddingOf(bare)).not.toHaveProperty('ceremony_time')
  })

  it('PUT clears an optional logistics field to absent via the "" sentinel (Phase 25), three-way per field', () => {
    const token = plannerToken(w)
    const created = w.api.handle(
      req('POST', '/t/alpha/weddings', {
        token,
        body: {
          couple_display_name: 'Clr & Able',
          event_date: '2028-07-07',
          ceremony_time: '17:00',
          venue_name: 'The Old Mill',
          parking_info: 'Lot B',
          dress_code: 'Black tie',
        },
      }),
    )
    const id = weddingOf(created).wedding_id

    // '' clears dress_code to absent; an OMITTED field (ceremony_time/venue_name/parking_info) is PRESERVED.
    const cleared = w.api.handle(req('PUT', `/t/alpha/weddings/${id}`, { token, body: { dress_code: '' } }))
    expect(cleared.status).toBe(200)
    expect(weddingOf(cleared)).not.toHaveProperty('dress_code')
    expect(weddingOf(cleared)).toMatchObject({ ceremony_time: '17:00', venue_name: 'The Old Mill', parking_info: 'Lot B' })

    // The clear PERSISTS (re-read shows the field still absent — not a transient view).
    const reread = w.api.handle(req('GET', `/t/alpha/weddings/${id}`, { token }))
    expect(weddingOf(reread)).not.toHaveProperty('dress_code')

    // A non-empty value still SETS; the other three each clear independently.
    const reset = w.api.handle(req('PUT', `/t/alpha/weddings/${id}`, { token, body: { dress_code: 'Cocktail' } }))
    expect(weddingOf(reset)).toMatchObject({ dress_code: 'Cocktail' })
    const clearAll = w.api.handle(
      req('PUT', `/t/alpha/weddings/${id}`, { token, body: { ceremony_time: '', venue_name: '', parking_info: '', dress_code: '' } }),
    )
    expect(clearAll.status).toBe(200)
    for (const k of ['ceremony_time', 'venue_name', 'parking_info', 'dress_code']) {
      expect(weddingOf(clearAll)).not.toHaveProperty(k)
    }

    // The '' sentinel is RAW + strict: a non-string ([''], 0, null) is neither absent nor '' -> requireString -> 400
    // (cannot reach a clear, cannot persist an invalid record).
    expect(w.api.handle(req('PUT', `/t/alpha/weddings/${id}`, { token, body: { dress_code: [''] } })).status).toBe(400)
    expect(w.api.handle(req('PUT', `/t/alpha/weddings/${id}`, { token, body: { dress_code: 0 } })).status).toBe(400)
    expect(w.api.handle(req('PUT', `/t/alpha/weddings/${id}`, { token, body: { dress_code: null } })).status).toBe(400)
  })

  it('POST keeps the create contract: an empty optional ("" = clear) is NOT a thing on create -> 400 (Phase 25)', () => {
    const token = plannerToken(w)
    const post = (body: Record<string, unknown>) =>
      w.api.handle(req('POST', '/t/alpha/weddings', { token, body: { couple_display_name: 'x', event_date: '2028-01-01', ...body } })).status
    // The '' clear sentinel lives ONLY on PUT; on POST every optional '' is malformed (contract minLength/pattern).
    expect(post({ dress_code: '' })).toBe(400)
    expect(post({ ceremony_time: '' })).toBe(400)
    expect(post({ venue_name: '' })).toBe(400)
    expect(post({ parking_info: '' })).toBe(400)
  })

  it('rejects malformed logistics fields -> 400 (bad ceremony_time pattern, null, numeric, too long)', () => {
    const token = plannerToken(w)
    const post = (body: Record<string, unknown>) =>
      w.api.handle(req('POST', '/t/alpha/weddings', { token, body: { couple_display_name: 'x', event_date: '2028-01-01', ...body } })).status
    expect(post({ ceremony_time: '25:00' })).toBe(400) // out-of-range hour (contract pattern)
    expect(post({ ceremony_time: '4pm' })).toBe(400) // wrong shape
    expect(post({ dress_code: null })).toBe(400) // null is not undefined -> not a string -> 400 (F8)
    expect(post({ dress_code: 42 })).toBe(400) // numeric -> 400 (F8)
    expect(post({ dress_code: 'x'.repeat(201) })).toBe(400) // exceeds maxLength 200 (F7)
    expect(post({ venue_name: '' })).toBe(400) // '' passes optionalString, rejected by the contract's minLength 1
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

  describe('the operator-gated /admin edge', () => {
    const OP = 'op-secret'
    const provisionBody = { slug: 'beta', display_name: 'Beta Co', plan_tier: 'studio', theme: THEME }

    it('provisions a tenant in onboarding (201) for a valid operator', () => {
      const res = w.api.handle(req('POST', '/admin/tenants', { token: OP, body: provisionBody }))
      expect(res.status).toBe(201)
      expect((res.body as { tenant: { slug: string; lifecycle_status: string } }).tenant.slug).toBe('beta')
      expect((res.body as { tenant: { lifecycle_status: string } }).tenant.lifecycle_status).toBe('onboarding')
    })

    it('drives the lifecycle through /admin actions, and the JSON edge tracks it', () => {
      const created = w.api.handle(req('POST', '/admin/tenants', { token: OP, body: provisionBody }))
      const id = (created.body as { tenant: { tenant_id: string } }).tenant.tenant_id
      // While onboarding, the public edge masks the tenant as a 404 (both list and login).
      expect(w.api.handle(req('GET', '/t/beta/weddings')).status).toBe(404)
      expect(w.api.handle(req('POST', '/t/beta/sessions', { body: { role: 'planner' } })).status).toBe(404)
      // Activate -> the edge now discloses active-existence (401 unauth list; 201 login).
      expect(w.api.handle(req('POST', `/admin/tenants/${id}/activate`, { token: OP })).status).toBe(200)
      expect(w.api.handle(req('GET', '/t/beta/weddings')).status).toBe(401)
      expect(w.api.handle(req('POST', '/t/beta/sessions', { body: { role: 'planner' } })).status).toBe(201)
      // Suspend -> masked again; reactivate -> usable again.
      expect(w.api.handle(req('POST', `/admin/tenants/${id}/suspend`, { token: OP })).status).toBe(200)
      expect(w.api.handle(req('GET', '/t/beta/weddings')).status).toBe(404)
      expect(w.api.handle(req('POST', `/admin/tenants/${id}/reactivate`, { token: OP })).status).toBe(200)
      expect(w.api.handle(req('GET', '/t/beta/weddings')).status).toBe(401)
    })

    it('serves the billing ledger view to the operator', () => {
      const created = w.api.handle(req('POST', '/admin/tenants', { token: OP, body: provisionBody }))
      const id = (created.body as { tenant: { tenant_id: string } }).tenant.tenant_id
      w.api.handle(req('POST', `/admin/tenants/${id}/activate`, { token: OP }))
      const view = w.api.handle(req('GET', `/admin/tenants/${id}/billing`, { token: OP }))
      expect(view.status).toBe(200)
      const body = view.body as { events: { kind: string }[]; balance_cents: number }
      expect(body.events.map((e) => e.kind)).toEqual(['provisioned', 'charge', 'payment'])
      expect(body.balance_cents).toBe(0)
    })

    it('a duplicate slug is an honest 409 to the trusted operator', () => {
      w.api.handle(req('POST', '/admin/tenants', { token: OP, body: provisionBody }))
      expect(w.api.handle(req('POST', '/admin/tenants', { token: OP, body: provisionBody })).status).toBe(409)
    })

    it('an illegal lifecycle transition is a 409 (double-activate)', () => {
      const created = w.api.handle(req('POST', '/admin/tenants', { token: OP, body: provisionBody }))
      const id = (created.body as { tenant: { tenant_id: string } }).tenant.tenant_id
      w.api.handle(req('POST', `/admin/tenants/${id}/activate`, { token: OP }))
      expect(w.api.handle(req('POST', `/admin/tenants/${id}/activate`, { token: OP })).status).toBe(409)
    })

    it('a malformed provision body (missing theme / bad tier) -> 400', () => {
      expect(w.api.handle(req('POST', '/admin/tenants', { token: OP, body: { slug: 'g', display_name: 'G', plan_tier: 'studio' } })).status).toBe(400)
      expect(
        w.api.handle(req('POST', '/admin/tenants', { token: OP, body: { ...provisionBody, slug: 'h', plan_tier: 'enterprise' } })).status,
      ).toBe(400)
    })

    it('after auth, an unknown /admin sub-route -> 404 and a bad method -> 405', () => {
      expect(w.api.handle(req('GET', '/admin/nope', { token: OP })).status).toBe(404)
      expect(w.api.handle(req('GET', '/admin/tenants', { token: OP })).status).toBe(405)
    })

    it('billing on an unknown tenant id -> 404 (consistent with the other actions, no empty-200)', () => {
      expect(w.api.handle(req('GET', '/admin/tenants/tnt_missing/billing', { token: OP })).status).toBe(404)
    })
  })

  // Phase 19 Step 1 — the provider-webhook inbound surface (skeleton). Auth tier + route precedence + the
  // frozen uniform 202. Body validation / guest resolution / the metered reply land in later steps.
  describe('the provider-webhook inbound edge', () => {
    const WH = 'wh-secret'

    const validInbound = { channel: 'sms', from_ref: 'guest_ref_1', text: 'hello', provider_message_ref: 'pmr_1' }

    it('an authenticated POST of a valid payload -> the frozen 202 constant (uniform acknowledgement)', () => {
      const res = w.api.handle(req('POST', '/t/alpha/messaging/inbound', { token: WH, body: validInbound }))
      expect(res).toEqual({ status: 202, body: { status: 'accepted' } })
    })

    it('no credential -> 401; a session/operator-namespace token -> identical 401 (no cross-namespace privilege)', () => {
      expect(w.api.handle(req('POST', '/t/alpha/messaging/inbound', { body: {} })).status).toBe(401)
      // A planner SESSION token is absent in the webhook namespace -> the same 401.
      const planner = plannerToken(w)
      expect(w.api.handle(req('POST', '/t/alpha/messaging/inbound', { token: planner, body: {} })).status).toBe(401)
      // The OPERATOR token, likewise, is not a webhook credential.
      expect(w.api.handle(req('POST', '/t/alpha/messaging/inbound', { token: 'op-secret', body: {} })).status).toBe(401)
    })

    it('route shape is NOT a pre-auth oracle: any /messaging path+method unauthenticated -> byte-identical 401', () => {
      const a = w.api.handle(req('POST', '/t/alpha/messaging/inbound', {}))
      const b = w.api.handle(req('GET', '/t/alpha/messaging/inbound', {}))
      const c = w.api.handle(req('DELETE', '/t/alpha/messaging/totally-unknown', {}))
      expect(a).toEqual({ status: 401, body: { error: 'unauthorized' } })
      expect(b).toEqual(a)
      expect(c).toEqual(a)
    })

    it('after auth, a non-POST method on inbound -> 405, and an unknown messaging sub-route -> 404', () => {
      expect(w.api.handle(req('GET', '/t/alpha/messaging/inbound', { token: WH })).status).toBe(405)
      expect(w.api.handle(req('POST', '/t/alpha/messaging/nope', { token: WH, body: {} })).status).toBe(404)
    })

    it('a well-formed inbound payload validates -> 202; a malformed/non-conformant one -> honest 400 (post-auth)', () => {
      const good = { channel: 'sms', from_ref: 'guest_ref_1', text: 'when is the wedding?', provider_message_ref: 'pmr_1' }
      expect(w.api.handle(req('POST', '/t/alpha/messaging/inbound', { token: WH, body: good }))).toEqual({
        status: 202,
        body: { status: 'accepted' },
      })
      // Missing required field, a non-enum channel, and an extra property are each a 400 (additionalProperties:false).
      expect(w.api.handle(req('POST', '/t/alpha/messaging/inbound', { token: WH, body: { channel: 'sms', from_ref: 'g', text: 'hi' } })).status).toBe(400)
      expect(w.api.handle(req('POST', '/t/alpha/messaging/inbound', { token: WH, body: { ...good, channel: 'carrier_pigeon' } })).status).toBe(400)
      expect(w.api.handle(req('POST', '/t/alpha/messaging/inbound', { token: WH, body: { ...good, extra: 'x' } })).status).toBe(400)
      // An empty from_ref/text (minLength 1) is rejected at the edge.
      expect(w.api.handle(req('POST', '/t/alpha/messaging/inbound', { token: WH, body: { ...good, from_ref: '' } })).status).toBe(400)
      // No body at all -> 400 (parseObjectBody).
      expect(w.api.handle(req('POST', '/t/alpha/messaging/inbound', { token: WH })).status).toBe(400)
    })

    it('an unknown tenant -> 404 BEFORE webhook auth (tenant-resolve precedence; mask holds vs a secret-holder)', () => {
      // Even WITH a valid webhook secret, a non-active/unknown slug is the byte-identical masked 404.
      expect(w.api.handle(req('POST', '/t/ghost/messaging/inbound', { token: WH, body: {} }))).toEqual({
        status: 404,
        body: { error: 'not_found' },
      })
    })
  })
})
