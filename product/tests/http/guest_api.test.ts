import { ManualClock, SequentialIdGenerator, type Tenant, type Wedding } from '@wedding-planner/shared'
import { beforeEach, describe, expect, it } from 'vitest'

import {
  GuestAuthorizer,
  type ApiRequest,
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
 * Phase 21 Step 4 — the planner-only JSON guest API (`GET/POST/DELETE /t/:slug/guests`). The opaque
 * recipient_ref travels in the BODY (no `:id` sub-path). Proves: planner CRUD happy paths; couple→403 /
 * anon→401 on every verb; tenant isolation (a planner never sees another tenant's guests, and a
 * cross-tenant wedding_id reads back the masked 404); duplicate→409; register-to-missing-wedding→404;
 * idempotent remove; body-smuggled tenant_id inert. (CSRF lives at the web layer — not here; the JSON API
 * is Bearer-only and not CSRF-reachable.)
 */

const THEME: Tenant['theme'] = {
  brand_name: 'Brand',
  primary_color_hex: '#111111',
  accent_color_hex: '#222222',
  logo_ref: 'asset_1',
}

interface World {
  api: ProductApi
}

function makeWorld(): World {
  const store = new TenantStore(new ManualClock('2027-03-01T00:00:00.000Z'), new SequentialIdGenerator('seedT'))
  store.create({ slug: 'alpha', display_name: 'Alpha', theme: THEME, plan_tier: 'solo', lifecycle_status: 'active' })
  store.create({ slug: 'beta', display_name: 'Beta', theme: THEME, plan_tier: 'solo', lifecycle_status: 'active' })
  const resolver = new TenantContextResolver(store)
  const sessions = new SessionStore(new SequentialIdGenerator('seedS'))
  const weddings = new WeddingRepository(store, new ManualClock('2027-04-01T00:00:00.000Z'), new SequentialIdGenerator('seedW'))
  const registry = new GuestRegistry(store)
  const billing = new BillingLedger(new ManualClock('2027-03-01T00:00:00.000Z'), new SequentialIdGenerator('seedB'))
  const adapter = new SimulatedMessagingAdapter(new ManualClock('2027-05-01T00:00:00.000Z'), new SequentialIdGenerator('seedM'))
  const api = new ProductApi({
    resolver,
    sessionStore: sessions,
    weddings,
    authorizer: new WeddingAuthorizer(),
    guests: { registry, weddings, authorizer: new GuestAuthorizer() },
    operators: new OperatorCredentialStore(new SequentialIdGenerator('seedO'), ['op-secret']),
    onboarding: new OnboardingService(store, billing),
    webhookCredentials: new ProviderWebhookCredentialStore(new SequentialIdGenerator('seedWH'), ['wh-secret']),
    messaging: {
      port: adapter,
      receipts: new InboundReceiptLog(store, new SequentialIdGenerator('seedIR')),
      registry,
      weddings,
      responder: new DeterministicGuestQaResponder(),
      service: new MessagingService(adapter, store, billing, new SequentialIdGenerator('seedMS')),
    },
  })
  return { api }
}

function req(method: string, path: string, opts: { token?: string; body?: unknown } = {}): ApiRequest {
  const headers: Record<string, string | undefined> = {}
  if (opts.token !== undefined) headers.authorization = `Bearer ${opts.token}`
  return { method, path, headers, rawBody: opts.body === undefined ? undefined : JSON.stringify(opts.body) }
}

function token(w: World, slug: string, body: { role: string; wedding_id?: string }): string {
  const res = w.api.handle(req('POST', `/t/${slug}/sessions`, { body }))
  expect(res.status).toBe(201)
  return (res.body as { token: string }).token
}

/** Create a wedding (as a planner) and return its id. */
function makeWedding(w: World, slug: string, plannerToken: string): string {
  const res = w.api.handle(
    req('POST', `/t/${slug}/weddings`, { token: plannerToken, body: { couple_display_name: 'Alex & Sam', event_date: '2027-09-18' } }),
  )
  expect(res.status).toBe(201)
  return (res.body as { wedding: Wedding }).wedding.wedding_id
}

describe('guest JSON API — planner-only CRUD', () => {
  let w: World
  beforeEach(() => {
    w = makeWorld()
  })

  it('planner can register, list, and remove a guest (happy path)', () => {
    const planner = token(w, 'alpha', { role: 'planner' })
    const weddingId = makeWedding(w, 'alpha', planner)

    const reg = w.api.handle(req('POST', '/t/alpha/guests', { token: planner, body: { recipient_ref: 'sms:+15550100', wedding_id: weddingId, guest_id: 'g1' } }))
    expect(reg.status).toBe(201)
    expect((reg.body as { guest: { tenant_id: string; wedding_id: string } }).guest.wedding_id).toBe(weddingId)

    const list = w.api.handle(req('GET', '/t/alpha/guests', { token: planner }))
    expect(list.status).toBe(200)
    expect((list.body as { guests: unknown[] }).guests).toHaveLength(1)

    const del = w.api.handle(req('DELETE', '/t/alpha/guests', { token: planner, body: { recipient_ref: 'sms:+15550100' } }))
    expect(del.status).toBe(200)
    expect((del.body as { removed: boolean }).removed).toBe(true)

    const list2 = w.api.handle(req('GET', '/t/alpha/guests', { token: planner }))
    expect((list2.body as { guests: unknown[] }).guests).toHaveLength(0)
  })

  it('rejects a duplicate recipient_ref with 409 (no silent rebind)', () => {
    const planner = token(w, 'alpha', { role: 'planner' })
    const weddingId = makeWedding(w, 'alpha', planner)
    const body = { recipient_ref: 'sms:+15550100', wedding_id: weddingId, guest_id: 'g1' }
    expect(w.api.handle(req('POST', '/t/alpha/guests', { token: planner, body })).status).toBe(201)
    expect(w.api.handle(req('POST', '/t/alpha/guests', { token: planner, body })).status).toBe(409)
  })

  it('register to a non-existent wedding -> 404 (referential integrity, honest to the trusted planner)', () => {
    const planner = token(w, 'alpha', { role: 'planner' })
    const res = w.api.handle(req('POST', '/t/alpha/guests', { token: planner, body: { recipient_ref: 'sms:+1', wedding_id: 'wedding_nope', guest_id: 'g1' } }))
    expect(res.status).toBe(404)
  })

  it('remove is idempotent: absent ref -> 200 { removed: false }', () => {
    const planner = token(w, 'alpha', { role: 'planner' })
    const res = w.api.handle(req('DELETE', '/t/alpha/guests', { token: planner, body: { recipient_ref: 'sms:+absent' } }))
    expect(res.status).toBe(200)
    expect((res.body as { removed: boolean }).removed).toBe(false)
  })

  it('a couple is forbidden (403) on every verb (capability denial, not a resource probe)', () => {
    const planner = token(w, 'alpha', { role: 'planner' })
    const weddingId = makeWedding(w, 'alpha', planner)
    const couple = token(w, 'alpha', { role: 'couple', wedding_id: weddingId })
    expect(w.api.handle(req('GET', '/t/alpha/guests', { token: couple })).status).toBe(403)
    expect(w.api.handle(req('POST', '/t/alpha/guests', { token: couple, body: { recipient_ref: 'x', wedding_id: weddingId, guest_id: 'g' } })).status).toBe(403)
    expect(w.api.handle(req('DELETE', '/t/alpha/guests', { token: couple, body: { recipient_ref: 'x' } })).status).toBe(403)
  })

  it('an anonymous request is unauthorized (401) on every verb', () => {
    expect(w.api.handle(req('GET', '/t/alpha/guests')).status).toBe(401)
    expect(w.api.handle(req('POST', '/t/alpha/guests', { body: { recipient_ref: 'x', wedding_id: 'w', guest_id: 'g' } })).status).toBe(401)
    expect(w.api.handle(req('DELETE', '/t/alpha/guests', { body: { recipient_ref: 'x' } })).status).toBe(401)
  })

  it('tenant isolation: a planner never sees another tenant\'s guests, and a cross-tenant wedding_id -> 404', () => {
    const alpha = token(w, 'alpha', { role: 'planner' })
    const beta = token(w, 'beta', { role: 'planner' })
    const betaWedding = makeWedding(w, 'beta', beta)
    expect(w.api.handle(req('POST', '/t/beta/guests', { token: beta, body: { recipient_ref: 'sms:+1777', wedding_id: betaWedding, guest_id: 'gb' } })).status).toBe(201)

    // alpha's planner lists only alpha (empty), never beta's guest.
    expect((w.api.handle(req('GET', '/t/alpha/guests', { token: alpha })).body as { guests: unknown[] }).guests).toHaveLength(0)
    // alpha's planner registering against beta's wedding_id -> the id is absent in alpha's partition -> 404.
    expect(w.api.handle(req('POST', '/t/alpha/guests', { token: alpha, body: { recipient_ref: 'sms:+2', wedding_id: betaWedding, guest_id: 'g' } })).status).toBe(404)
    // alpha's session presented on beta's route -> cross-tenant bind veto (401), never re-scoped.
    expect(w.api.handle(req('GET', '/t/beta/guests', { token: alpha })).status).toBe(401)
  })

  it('a body-smuggled tenant_id is inert (the binding is stamped from the context)', () => {
    const planner = token(w, 'alpha', { role: 'planner' })
    const weddingId = makeWedding(w, 'alpha', planner)
    const reg = w.api.handle(req('POST', '/t/alpha/guests', { token: planner, body: { recipient_ref: 'sms:+1', wedding_id: weddingId, guest_id: 'g', tenant_id: 'beta' } }))
    expect(reg.status).toBe(201)
    expect((reg.body as { guest: { tenant_id: string } }).guest.tenant_id).not.toBe('beta')
  })
})
