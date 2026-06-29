import { ManualClock, SequentialIdGenerator, type Tenant, type Wedding } from '@wedding-planner/shared'
import { beforeEach, describe, expect, it } from 'vitest'

import {
  GuestAuthorizer,
  type ApiRequest,
  BillingLedger,
  DeterministicGuestQaResponder,
  EscalationLog,
  EscalationReplyLog,
  EscalationResolutionLog,
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
 * Phase 21 + Phase 24 — the JSON guest API (`GET/POST/DELETE /t/:slug/guests`). The opaque recipient_ref
 * travels in the BODY (no `:id` sub-path). Proves the PLANNER (whole-tenant) CRUD happy paths; tenant
 * isolation (a planner never sees another tenant's guests, and a cross-tenant wedding_id reads back the
 * masked 404); duplicate→409; register-to-missing-wedding→404; idempotent remove; body-smuggled tenant_id
 * inert. Phase 24 adds the COUPLE-scoped slice: a couple lists ONLY their wedding's guests and removes them,
 * register stays planner-only (couple→403 even for a duplicate ref — never reaching the 409 oracle), and
 * every couple remove-miss (absent / sibling-wedding / smuggled-wedding_id) is byte-identical {removed:false}
 * with the sibling binding untouched. anon→401 on every verb. (CSRF lives at the web layer — not here; the
 * JSON API is Bearer-only and not CSRF-reachable.)
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
      escalations: new EscalationLog(store, new SequentialIdGenerator('seedEsc')),
      resolutions: new EscalationResolutionLog(store, new SequentialIdGenerator('seedRes'), new ManualClock('2027-03-01T00:00:00.000Z')),
      replies: new EscalationReplyLog(store, new SequentialIdGenerator('seedRep'), new ManualClock('2027-03-01T00:00:00.000Z')),
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

describe('guest JSON API — planner CRUD + couple-scoped list/remove', () => {
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

  it('couple register stays planner-only: 403 — even for a duplicate ref, never reaching the 409 oracle', () => {
    const planner = token(w, 'alpha', { role: 'planner' })
    const weddingId = makeWedding(w, 'alpha', planner)
    // A ref already registered (to the couple's OWN wedding) by the planner.
    expect(w.api.handle(req('POST', '/t/alpha/guests', { token: planner, body: { recipient_ref: 'sms:+exists', wedding_id: weddingId, guest_id: 'g1' } })).status).toBe(201)
    const couple = token(w, 'alpha', { role: 'couple', wedding_id: weddingId })
    // Fresh ref and an already-registered ref are INDISTINGUISHABLE to the couple — both 403, no 409 leak.
    const fresh = w.api.handle(req('POST', '/t/alpha/guests', { token: couple, body: { recipient_ref: 'sms:+fresh', wedding_id: weddingId, guest_id: 'g2' } }))
    const dup = w.api.handle(req('POST', '/t/alpha/guests', { token: couple, body: { recipient_ref: 'sms:+exists', wedding_id: weddingId, guest_id: 'g3' } }))
    expect(fresh.status).toBe(403)
    expect(JSON.stringify(dup)).toBe(JSON.stringify(fresh))
    // The 403 precedes the body parse: a malformed couple body is the same 403, not a 400.
    expect(w.api.handle(req('POST', '/t/alpha/guests', { token: couple, body: { junk: true } })).status).toBe(403)
  })

  it('couple lists ONLY their own wedding\'s guests (a sibling wedding\'s guest never appears)', () => {
    const planner = token(w, 'alpha', { role: 'planner' })
    const mine = makeWedding(w, 'alpha', planner)
    const sibling = makeWedding(w, 'alpha', planner)
    expect(w.api.handle(req('POST', '/t/alpha/guests', { token: planner, body: { recipient_ref: 'sms:+mine', wedding_id: mine, guest_id: 'gm' } })).status).toBe(201)
    expect(w.api.handle(req('POST', '/t/alpha/guests', { token: planner, body: { recipient_ref: 'sms:+sib', wedding_id: sibling, guest_id: 'gs' } })).status).toBe(201)
    const couple = token(w, 'alpha', { role: 'couple', wedding_id: mine })
    const list = w.api.handle(req('GET', '/t/alpha/guests', { token: couple }))
    expect(list.status).toBe(200)
    const guests = (list.body as { guests: { recipient_ref: string; wedding_id: string }[] }).guests
    expect(guests).toHaveLength(1)
    expect(guests[0]?.recipient_ref).toBe('sms:+mine')
    // The planner still sees BOTH (whole-tenant view unchanged).
    expect((w.api.handle(req('GET', '/t/alpha/guests', { token: planner })).body as { guests: unknown[] }).guests).toHaveLength(2)
  })

  it('couple removes their OWN guest (true), and the binding is gone', () => {
    const planner = token(w, 'alpha', { role: 'planner' })
    const mine = makeWedding(w, 'alpha', planner)
    expect(w.api.handle(req('POST', '/t/alpha/guests', { token: planner, body: { recipient_ref: 'sms:+mine', wedding_id: mine, guest_id: 'gm' } })).status).toBe(201)
    const couple = token(w, 'alpha', { role: 'couple', wedding_id: mine })
    const del = w.api.handle(req('DELETE', '/t/alpha/guests', { token: couple, body: { recipient_ref: 'sms:+mine' } }))
    expect(del.status).toBe(200)
    expect((del.body as { removed: boolean }).removed).toBe(true)
    expect((w.api.handle(req('GET', '/t/alpha/guests', { token: couple })).body as { guests: unknown[] }).guests).toHaveLength(0)
  })

  it('couple remove-miss is byte-identical for absent / sibling-wedding / smuggled-wedding_id (no oracle), sibling untouched', () => {
    const planner = token(w, 'alpha', { role: 'planner' })
    const mine = makeWedding(w, 'alpha', planner)
    const sibling = makeWedding(w, 'alpha', planner)
    expect(w.api.handle(req('POST', '/t/alpha/guests', { token: planner, body: { recipient_ref: 'sms:+sib', wedding_id: sibling, guest_id: 'gs' } })).status).toBe(201)
    const couple = token(w, 'alpha', { role: 'couple', wedding_id: mine })
    // (1) a genuinely absent ref.
    const absent = w.api.handle(req('DELETE', '/t/alpha/guests', { token: couple, body: { recipient_ref: 'sms:+absent' } }))
    // (2) a ref bound to a SIBLING wedding in the same tenant.
    const sib = w.api.handle(req('DELETE', '/t/alpha/guests', { token: couple, body: { recipient_ref: 'sms:+sib' } }))
    // (3) a body-smuggled wedding_id (the sibling's) must NOT widen the couple's reach.
    const smuggled = w.api.handle(req('DELETE', '/t/alpha/guests', { token: couple, body: { recipient_ref: 'sms:+sib', wedding_id: sibling } }))
    expect(JSON.stringify(absent)).toBe(JSON.stringify(sib))
    expect(JSON.stringify(smuggled)).toBe(JSON.stringify(absent))
    expect((absent.body as { removed: boolean }).removed).toBe(false)
    // The sibling binding is still there for the planner.
    expect((w.api.handle(req('GET', '/t/alpha/guests', { token: planner })).body as { guests: unknown[] }).guests).toHaveLength(1)
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
