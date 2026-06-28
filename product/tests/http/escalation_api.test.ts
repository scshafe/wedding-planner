import { ManualClock, SequentialIdGenerator, type GuestEscalation, type Tenant, type Wedding } from '@wedding-planner/shared'
import { beforeEach, describe, expect, it } from 'vitest'

import {
  GuestAuthorizer,
  type ApiRequest,
  BillingLedger,
  DeterministicGuestQaResponder,
  EscalationLog,
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
 * Phase 26 — the escalation-inbox JSON read surface (`GET /t/:slug/escalations`). An `escalated` guest
 * question (recorded at the inbound edge) is read scoped by manageScope: a PLANNER sees the whole tenant's
 * escalations; a COUPLE sees ONLY their bound wedding's (a sibling wedding's never appears); cross-tenant
 * isolation holds; a non-GET method is 405; an anonymous request is 401. The read deps and the inbound
 * capture share ONE EscalationLog instance (as composeProductSurface wires them).
 */

const THEME: Tenant['theme'] = {
  brand_name: 'Brand',
  primary_color_hex: '#111111',
  accent_color_hex: '#222222',
  logo_ref: 'asset_1',
}
const WH = 'wh-secret'

interface World {
  api: ProductApi
}

function makeWorld(): World {
  const clock = new ManualClock('2027-03-01T00:00:00.000Z')
  const store = new TenantStore(clock, new SequentialIdGenerator('seedT'))
  store.create({ slug: 'alpha', display_name: 'Alpha', theme: THEME, plan_tier: 'solo', lifecycle_status: 'active' })
  store.create({ slug: 'beta', display_name: 'Beta', theme: THEME, plan_tier: 'solo', lifecycle_status: 'active' })
  const resolver = new TenantContextResolver(store)
  const sessions = new SessionStore(new SequentialIdGenerator('seedS'))
  const weddings = new WeddingRepository(store, clock, new SequentialIdGenerator('seedW'))
  const registry = new GuestRegistry(store)
  const billing = new BillingLedger(clock, new SequentialIdGenerator('seedB'))
  const adapter = new SimulatedMessagingAdapter(clock, new SequentialIdGenerator('seedM'))
  // ONE log instance — the inbound capture writes it, the read surface reads it (as compose wires).
  const escalations = new EscalationLog(store, new SequentialIdGenerator('seedEsc'))
  const guestAuthorizer = new GuestAuthorizer()
  const api = new ProductApi({
    resolver,
    sessionStore: sessions,
    weddings,
    authorizer: new WeddingAuthorizer(),
    guests: { registry, weddings, authorizer: guestAuthorizer },
    operators: new OperatorCredentialStore(new SequentialIdGenerator('seedO'), ['op-secret']),
    onboarding: new OnboardingService(store, billing),
    webhookCredentials: new ProviderWebhookCredentialStore(new SequentialIdGenerator('seedWH'), [WH]),
    messaging: {
      port: adapter,
      receipts: new InboundReceiptLog(store, new SequentialIdGenerator('seedIR')),
      registry,
      weddings,
      responder: new DeterministicGuestQaResponder(),
      service: new MessagingService(adapter, store, billing, new SequentialIdGenerator('seedMS')),
      escalations,
    },
    escalations: { escalations, authorizer: guestAuthorizer },
  })
  return { api }
}

function req(method: string, path: string, opts: { token?: string; body?: unknown } = {}): ApiRequest {
  const headers: Record<string, string | undefined> = {}
  if (opts.token !== undefined) headers.authorization = `Bearer ${opts.token}`
  return { method, path, headers, rawBody: opts.body === undefined ? undefined : JSON.stringify(opts.body) }
}

function login(w: World, slug: string, body: { role: string; wedding_id?: string }): string {
  const res = w.api.handle(req('POST', `/t/${slug}/sessions`, { body }))
  expect(res.status).toBe(201)
  return (res.body as { token: string }).token
}

function makeWedding(w: World, slug: string, plannerToken: string): string {
  const res = w.api.handle(
    req('POST', `/t/${slug}/weddings`, { token: plannerToken, body: { couple_display_name: 'Alex & Sam', event_date: '2027-09-18' } }),
  )
  expect(res.status).toBe(201)
  return (res.body as { wedding: Wedding }).wedding.wedding_id
}

function registerGuest(w: World, slug: string, plannerToken: string, ref: string, weddingId: string): void {
  const res = w.api.handle(req('POST', `/t/${slug}/guests`, { token: plannerToken, body: { recipient_ref: ref, wedding_id: weddingId, guest_id: `g_${ref}` } }))
  expect(res.status).toBe(201)
}

/** Drive an UNANSWERABLE inbound (a parking question on a wedding with no parking_info) -> records an escalation. */
function escalate(w: World, slug: string, ref: string, providerRef: string, text = 'where do I park?'): void {
  const res = w.api.handle({
    method: 'POST',
    path: `/t/${slug}/messaging/inbound`,
    headers: { authorization: `Bearer ${WH}` },
    rawBody: JSON.stringify({ channel: 'sms', from_ref: ref, text, provider_message_ref: providerRef }),
  })
  expect(res.status).toBe(202)
}

function listEscalations(w: World, slug: string, token?: string): { status: number; rows: GuestEscalation[] } {
  const res = w.api.handle(req('GET', `/t/${slug}/escalations`, token === undefined ? {} : { token }))
  const rows = (res.body as { escalations?: GuestEscalation[] }).escalations ?? []
  return { status: res.status, rows }
}

describe('escalation-inbox JSON read surface', () => {
  let w: World
  beforeEach(() => {
    w = makeWorld()
  })

  it('a planner sees ALL of the tenant escalations (whole partition)', () => {
    const planner = login(w, 'alpha', { role: 'planner' })
    const wedA = makeWedding(w, 'alpha', planner)
    const wedB = makeWedding(w, 'alpha', planner)
    registerGuest(w, 'alpha', planner, 'sms:+1', wedA)
    registerGuest(w, 'alpha', planner, 'sms:+2', wedB)
    escalate(w, 'alpha', 'sms:+1', 'pm_1')
    escalate(w, 'alpha', 'sms:+2', 'pm_2')

    const { status, rows } = listEscalations(w, 'alpha', planner)
    expect(status).toBe(200)
    expect(rows.map((r) => r.provider_message_ref).sort()).toEqual(['pm_1', 'pm_2'])
  })

  it('a couple sees ONLY their bound wedding escalations (a sibling wedding never appears)', () => {
    const planner = login(w, 'alpha', { role: 'planner' })
    const wedA = makeWedding(w, 'alpha', planner)
    const wedB = makeWedding(w, 'alpha', planner)
    registerGuest(w, 'alpha', planner, 'sms:+1', wedA)
    registerGuest(w, 'alpha', planner, 'sms:+2', wedB)
    escalate(w, 'alpha', 'sms:+1', 'pm_A')
    escalate(w, 'alpha', 'sms:+2', 'pm_B')

    const coupleA = login(w, 'alpha', { role: 'couple', wedding_id: wedA })
    const a = listEscalations(w, 'alpha', coupleA)
    expect(a.status).toBe(200)
    expect(a.rows.map((r) => r.provider_message_ref)).toEqual(['pm_A'])
    expect(a.rows.every((r) => r.wedding_id === wedA)).toBe(true)

    const coupleB = login(w, 'alpha', { role: 'couple', wedding_id: wedB })
    expect(listEscalations(w, 'alpha', coupleB).rows.map((r) => r.provider_message_ref)).toEqual(['pm_B'])
  })

  it('a couple bound to NO escalated wedding sees an empty inbox (no leak)', () => {
    const planner = login(w, 'alpha', { role: 'planner' })
    const wedA = makeWedding(w, 'alpha', planner)
    const wedOther = makeWedding(w, 'alpha', planner)
    registerGuest(w, 'alpha', planner, 'sms:+1', wedA)
    escalate(w, 'alpha', 'sms:+1', 'pm_A')

    const coupleOther = login(w, 'alpha', { role: 'couple', wedding_id: wedOther })
    expect(listEscalations(w, 'alpha', coupleOther).rows).toEqual([])
  })

  it('is tenant-isolated: tenant beta planner never sees tenant alpha escalations', () => {
    const plannerA = login(w, 'alpha', { role: 'planner' })
    const wedA = makeWedding(w, 'alpha', plannerA)
    registerGuest(w, 'alpha', plannerA, 'sms:+1', wedA)
    escalate(w, 'alpha', 'sms:+1', 'pm_A')

    const plannerB = login(w, 'beta', { role: 'planner' })
    expect(listEscalations(w, 'beta', plannerB).rows).toEqual([])
  })

  it('a non-GET method is 405; an anonymous request is 401', () => {
    const planner = login(w, 'alpha', { role: 'planner' })
    expect(w.api.handle(req('POST', '/t/alpha/escalations', { token: planner })).status).toBe(405)
    expect(w.api.handle(req('DELETE', '/t/alpha/escalations', { token: planner })).status).toBe(405)
    expect(w.api.handle(req('GET', '/t/alpha/escalations')).status).toBe(401)
  })

  it('an ANSWERED question never appears in the inbox (only escalations land)', () => {
    const planner = login(w, 'alpha', { role: 'planner' })
    const wedA = makeWedding(w, 'alpha', planner)
    registerGuest(w, 'alpha', planner, 'sms:+1', wedA)
    // "when is the wedding?" answers from event_date (required) -> no escalation.
    escalate(w, 'alpha', 'sms:+1', 'pm_ans', 'when is the wedding?')
    expect(listEscalations(w, 'alpha', planner).rows).toEqual([])
  })
})
