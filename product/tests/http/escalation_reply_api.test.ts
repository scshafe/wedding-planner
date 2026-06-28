import { ManualClock, SequentialIdGenerator, type GuestEscalation, type Tenant, type Wedding } from '@wedding-planner/shared'
import { beforeEach, describe, expect, it } from 'vitest'

import {
  GuestAuthorizer,
  type ApiRequest,
  type ApiResponse,
  BillingLedger,
  DeterministicGuestQaResponder,
  EscalationLog,
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
 * Phase 28 — `POST /t/:slug/escalations` with a `reply_text` REPLIES to an escalated guest from the inbox: a
 * console-initiated METERED send (through the SAME MessagingService the inbound webhook uses) that AUTO-records
 * a `resolved` resolution. It is SCOPED like resolve and provably oracle-free for a couple: an absent
 * escalation_id, a couple's foreign-wedding escalation_id, and an already-handled escalation ALL return the
 * byte-identical `{replied:false}` (RESP_REPLY_MISS) with NO send, NO charge, NO record. channel + recipient
 * come from the LIVE escalation (a smuggled body field is inert); the meter key is the deterministic
 * `reply:${id}` so a double-submit meters/dispatches exactly once.
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
  messaging: MessagingService
  resolver: TenantContextResolver
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
  const escalations = new EscalationLog(store, new SequentialIdGenerator('seedEsc'))
  const resolutions = new EscalationResolutionLog(store, new SequentialIdGenerator('seedRes'), clock)
  const messaging = new MessagingService(adapter, store, billing, new SequentialIdGenerator('seedMS'))
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
      service: messaging,
      escalations,
    },
    escalations: { escalations, resolutions, authorizer: guestAuthorizer, service: messaging },
  })
  return { api, messaging, resolver }
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

/** Drive an UNANSWERABLE inbound -> records an escalation; return its server-minted id. */
function escalate(w: World, slug: string, plannerToken: string, ref: string, providerRef: string, channel = 'sms'): string {
  const res = w.api.handle({
    method: 'POST',
    path: `/t/${slug}/messaging/inbound`,
    headers: { authorization: `Bearer ${WH}` },
    rawBody: JSON.stringify({ channel, from_ref: ref, text: 'where do I park?', provider_message_ref: providerRef }),
  })
  expect(res.status).toBe(202)
  const listed = w.api.handle(req('GET', `/t/${slug}/escalations`, { token: plannerToken }))
  const row = (listed.body as { escalations: GuestEscalation[] }).escalations.find((e) => e.provider_message_ref === providerRef)
  expect(row).toBeDefined()
  return row!.escalation_id
}

function reply(w: World, slug: string, token: string, escalation_id: string, reply_text = 'Parking is in lot B.'): ApiResponse {
  return w.api.handle(req('POST', `/t/${slug}/escalations`, { token, body: { escalation_id, reply_text } }))
}

function usage(w: World, slug: string): ReturnType<MessagingService['usageView']> {
  return w.messaging.usageView(w.resolver.resolveBySlug(slug).tenant_id)
}

describe('escalation reply-from-the-inbox (Phase 28)', () => {
  let w: World
  beforeEach(() => {
    w = makeWorld()
  })

  it('a planner replies to any tenant escalation: a metered send goes out + the escalation is auto-resolved', () => {
    const planner = login(w, 'alpha', { role: 'planner' })
    const wedA = makeWedding(w, 'alpha', planner)
    registerGuest(w, 'alpha', planner, 'sms:+1', wedA)
    const escId = escalate(w, 'alpha', planner, 'sms:+1', 'pm_1')

    const res = reply(w, 'alpha', planner, escId)
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ replied: true })

    // The meter fired: ONE send to the guest's from_ref over the ask channel.
    const u = usage(w, 'alpha')
    expect(u.message_count).toBe(1)
    expect(u.records[0]).toMatchObject({ recipient_ref: 'sms:+1', channel: 'sms' })
    expect(u.billed_total_cents).toBeGreaterThan(0)

    // Auto-resolved: it moves to the Handled set with status `resolved`, resolved_by the planner.
    const listed = w.api.handle(req('GET', `/t/alpha/escalations`, { token: planner }))
    const resolutions = (listed.body as { resolutions: { escalation_id: string; status: string; resolved_by: string }[] }).resolutions
    expect(resolutions).toEqual([{ ...resolutions[0], escalation_id: escId, status: 'resolved', resolved_by: 'planner' }])
  })

  it('a couple replies ONLY to their bound wedding escalation (resolved_by: couple)', () => {
    const planner = login(w, 'alpha', { role: 'planner' })
    const wedA = makeWedding(w, 'alpha', planner)
    registerGuest(w, 'alpha', planner, 'sms:+1', wedA)
    const escId = escalate(w, 'alpha', planner, 'sms:+1', 'pm_1')

    const coupleA = login(w, 'alpha', { role: 'couple', wedding_id: wedA })
    expect(reply(w, 'alpha', coupleA, escId).body).toEqual({ replied: true })
    expect(usage(w, 'alpha').message_count).toBe(1)
    const listed = w.api.handle(req('GET', `/t/alpha/escalations`, { token: coupleA }))
    expect((listed.body as { resolutions: { resolved_by: string }[] }).resolutions[0]).toMatchObject({ resolved_by: 'couple' })
  })

  it('the reply channel is the GUEST-chosen inbound channel (whatsapp asked -> whatsapp reply)', () => {
    const planner = login(w, 'alpha', { role: 'planner' })
    const wedA = makeWedding(w, 'alpha', planner)
    registerGuest(w, 'alpha', planner, 'wa:+1', wedA)
    const escId = escalate(w, 'alpha', planner, 'wa:+1', 'pm_w', 'whatsapp')
    expect(reply(w, 'alpha', planner, escId).body).toEqual({ replied: true })
    expect(usage(w, 'alpha').records[0]).toMatchObject({ recipient_ref: 'wa:+1', channel: 'whatsapp' })
  })

  it('NO-ORACLE: a couple replying to an ABSENT id and a SIBLING-WEDDING id get the BYTE-IDENTICAL {replied:false}, NO send', () => {
    const planner = login(w, 'alpha', { role: 'planner' })
    const wedA = makeWedding(w, 'alpha', planner)
    const wedB = makeWedding(w, 'alpha', planner)
    registerGuest(w, 'alpha', planner, 'sms:+1', wedA)
    registerGuest(w, 'alpha', planner, 'sms:+2', wedB)
    const escB = escalate(w, 'alpha', planner, 'sms:+2', 'pm_B') // an escalation in wedding B

    const coupleA = login(w, 'alpha', { role: 'couple', wedding_id: wedA })
    const absent = reply(w, 'alpha', coupleA, 'escalation_does_not_exist')
    const foreign = reply(w, 'alpha', coupleA, escB)
    expect(absent.status).toBe(200)
    expect(foreign.status).toBe(200)
    expect(JSON.stringify(absent.body)).toBe(JSON.stringify(foreign.body))
    expect(foreign.body).toEqual({ replied: false })
    // The foreign-wedding probe sent/charged/recorded NOTHING.
    expect(usage(w, 'alpha').message_count).toBe(0)
    expect((w.api.handle(req('GET', `/t/alpha/escalations`, { token: planner })).body as { resolutions: unknown[] }).resolutions).toHaveLength(0)
  })

  it('single-charge: a double-submit of the SAME reply meters + dispatches exactly ONCE (deterministic key)', () => {
    const planner = login(w, 'alpha', { role: 'planner' })
    const wedA = makeWedding(w, 'alpha', planner)
    registerGuest(w, 'alpha', planner, 'sms:+1', wedA)
    const escId = escalate(w, 'alpha', planner, 'sms:+1', 'pm_1')

    expect(reply(w, 'alpha', planner, escId).body).toEqual({ replied: true })
    // The second submit finds the escalation already handled -> RESP_REPLY_MISS, no second send.
    const second = reply(w, 'alpha', planner, escId, 'a different correction')
    expect(second.body).toEqual({ replied: false })
    expect(usage(w, 'alpha').message_count).toBe(1)
  })

  it('an already-DISMISSED escalation cannot be replied to (no billed message to an ignored guest)', () => {
    const planner = login(w, 'alpha', { role: 'planner' })
    const wedA = makeWedding(w, 'alpha', planner)
    registerGuest(w, 'alpha', planner, 'sms:+1', wedA)
    const escId = escalate(w, 'alpha', planner, 'sms:+1', 'pm_1')
    // Dismiss it first (status-based resolve), then attempt a reply.
    expect(w.api.handle(req('POST', `/t/alpha/escalations`, { token: planner, body: { escalation_id: escId, status: 'dismissed' } })).body).toEqual({ resolved: true })
    expect(reply(w, 'alpha', planner, escId).body).toEqual({ replied: false })
    expect(usage(w, 'alpha').message_count).toBe(0)
    // The recorded status is still `dismissed` (the reply did not override it).
    const resolutions = (w.api.handle(req('GET', `/t/alpha/escalations`, { token: planner })).body as { resolutions: { status: string }[] }).resolutions
    expect(resolutions[0]).toMatchObject({ status: 'dismissed' })
  })

  it('a malformed reply (missing/empty reply_text) is a masked 400 INDEPENDENT of existence (no oracle)', () => {
    const planner = login(w, 'alpha', { role: 'planner' })
    const wedA = makeWedding(w, 'alpha', planner)
    registerGuest(w, 'alpha', planner, 'sms:+1', wedA)
    const escId = escalate(w, 'alpha', planner, 'sms:+1', 'pm_1')
    // Present escalation, empty reply_text -> 400. Absent escalation, empty reply_text -> the SAME 400.
    const present = w.api.handle(req('POST', `/t/alpha/escalations`, { token: planner, body: { escalation_id: escId, reply_text: '' } }))
    const absent = w.api.handle(req('POST', `/t/alpha/escalations`, { token: planner, body: { escalation_id: 'nope', reply_text: '' } }))
    expect(present.status).toBe(400)
    expect(absent.status).toBe(400)
    expect(JSON.stringify(present.body)).toBe(JSON.stringify(absent.body))
    expect(usage(w, 'alpha').message_count).toBe(0)
  })

  it('tenant isolation: a planner cannot reply to another tenant escalation (id is absent in their partition)', () => {
    const plannerA = login(w, 'alpha', { role: 'planner' })
    const wedA = makeWedding(w, 'alpha', plannerA)
    registerGuest(w, 'alpha', plannerA, 'sms:+1', wedA)
    const escA = escalate(w, 'alpha', plannerA, 'sms:+1', 'pm_1')

    const plannerB = login(w, 'beta', { role: 'planner' })
    expect(reply(w, 'beta', plannerB, escA).body).toEqual({ replied: false })
    expect(usage(w, 'beta').message_count).toBe(0)
    expect(usage(w, 'alpha').message_count).toBe(0)
  })
})
