import { ManualClock, SequentialIdGenerator, type GuestEscalation, type Tenant, type Wedding } from '@wedding-planner/shared'
import { beforeEach, describe, expect, it } from 'vitest'

import {
  GuestAuthorizer,
  type ApiRequest,
  type ApiResponse,
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
 * Phase 28/34 — `POST /t/:slug/escalations` with a `reply_text` REPLIES to an escalated guest from the inbox: a
 * console-initiated METERED send (through the SAME MessagingService the inbound webhook uses). Phase 34 made it
 * MULTI-TURN: a reply APPENDS to the escalation's thread and does NOT auto-resolve, so an operator can send many
 * follow-ups while the escalation stays OPEN (resolving/dismissing is the separate Phase-27 action). It is
 * SCOPED like resolve and provably oracle-free for a couple: an absent escalation_id, a couple's foreign-wedding
 * escalation_id, and an already-HANDLED (resolved/dismissed) escalation ALL return the byte-identical
 * `{replied:false}` (RESP_REPLY_MISS) with NO send, NO charge, NO record (the dismissed-no-bill keystone). The
 * double-submit guard is the render-time `seq` (thread position): the meter key is `reply:${id}:${seq}`, a
 * re-submit of the SAME seq+body meters once, and a same-seq/DIFFERENT-body lost-update is an honest 409. channel
 * + recipient come from the LIVE escalation (a smuggled body field is inert).
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
  const replies = new EscalationReplyLog(store, new SequentialIdGenerator('seedRep'), clock)
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
      resolutions,
      replies,
    },
    escalations: { escalations, resolutions, replies, authorizer: guestAuthorizer, service: messaging },
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

interface ReplyOpts {
  seq?: number
  reply_text?: string
}
function reply(w: World, slug: string, token: string, escalation_id: string, opts: ReplyOpts = {}): ApiResponse {
  const body = { escalation_id, reply_text: opts.reply_text ?? 'Parking is in lot B.', seq: opts.seq ?? 0 }
  return w.api.handle(req('POST', `/t/${slug}/escalations`, { token, body }))
}

interface ReplyRow {
  escalation_id: string
  seq: number
  sender: string
  body: string
}
function listReplies(w: World, slug: string, token: string): ReplyRow[] {
  return (w.api.handle(req('GET', `/t/${slug}/escalations`, { token })).body as { replies: ReplyRow[] }).replies
}
function listResolutions(w: World, slug: string, token: string): { escalation_id: string; status: string; resolved_by: string }[] {
  return (w.api.handle(req('GET', `/t/${slug}/escalations`, { token })).body as { resolutions: { escalation_id: string; status: string; resolved_by: string }[] }).resolutions
}

function usage(w: World, slug: string): ReturnType<MessagingService['usageView']> {
  return w.messaging.usageView(w.resolver.resolveBySlug(slug).tenant_id)
}

describe('escalation reply-from-the-inbox (Phase 28/34 multi-turn)', () => {
  let w: World
  beforeEach(() => {
    w = makeWorld()
  })

  it('a planner reply sends a metered message + appends to the thread, and the escalation STAYS OPEN (no auto-resolve)', () => {
    const planner = login(w, 'alpha', { role: 'planner' })
    const wedA = makeWedding(w, 'alpha', planner)
    registerGuest(w, 'alpha', planner, 'sms:+1', wedA)
    const escId = escalate(w, 'alpha', planner, 'sms:+1', 'pm_1')

    const res = reply(w, 'alpha', planner, escId, { seq: 0 })
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ replied: true })

    // The meter fired: ONE send to the guest's from_ref over the ask channel.
    const u = usage(w, 'alpha')
    expect(u.message_count).toBe(1)
    expect(u.records[0]).toMatchObject({ recipient_ref: 'sms:+1', channel: 'sms' })
    expect(u.billed_total_cents).toBeGreaterThan(0)

    // DECOUPLED: the escalation is NOT resolved; the reply lives on the thread (sender = planner, seq 0).
    expect(listResolutions(w, 'alpha', planner)).toHaveLength(0)
    expect(listReplies(w, 'alpha', planner)).toEqual([
      { ...listReplies(w, 'alpha', planner)[0], escalation_id: escId, seq: 0, sender: 'planner', body: 'Parking is in lot B.' },
    ])
  })

  it('multi-turn: a SECOND distinct reply at seq=1 sends again (the thread grows; nothing is resolved)', () => {
    const planner = login(w, 'alpha', { role: 'planner' })
    const wedA = makeWedding(w, 'alpha', planner)
    registerGuest(w, 'alpha', planner, 'sms:+1', wedA)
    const escId = escalate(w, 'alpha', planner, 'sms:+1', 'pm_1')

    expect(reply(w, 'alpha', planner, escId, { seq: 0, reply_text: 'Parking is in lot B.' }).body).toEqual({ replied: true })
    expect(reply(w, 'alpha', planner, escId, { seq: 1, reply_text: 'By the oak tree.' }).body).toEqual({ replied: true })
    expect(usage(w, 'alpha').message_count).toBe(2)
    const thread = listReplies(w, 'alpha', planner)
    expect(thread.map((r) => r.body)).toEqual(['Parking is in lot B.', 'By the oak tree.'])
    expect(listResolutions(w, 'alpha', planner)).toHaveLength(0)
  })

  it('a couple replies ONLY to their bound wedding escalation (sender: couple)', () => {
    const planner = login(w, 'alpha', { role: 'planner' })
    const wedA = makeWedding(w, 'alpha', planner)
    registerGuest(w, 'alpha', planner, 'sms:+1', wedA)
    const escId = escalate(w, 'alpha', planner, 'sms:+1', 'pm_1')

    const coupleA = login(w, 'alpha', { role: 'couple', wedding_id: wedA })
    expect(reply(w, 'alpha', coupleA, escId, { seq: 0 }).body).toEqual({ replied: true })
    expect(usage(w, 'alpha').message_count).toBe(1)
    expect(listReplies(w, 'alpha', coupleA)[0]).toMatchObject({ sender: 'couple' })
  })

  it('the reply channel is the GUEST-chosen inbound channel (whatsapp asked -> whatsapp reply)', () => {
    const planner = login(w, 'alpha', { role: 'planner' })
    const wedA = makeWedding(w, 'alpha', planner)
    registerGuest(w, 'alpha', planner, 'wa:+1', wedA)
    const escId = escalate(w, 'alpha', planner, 'wa:+1', 'pm_w', 'whatsapp')
    expect(reply(w, 'alpha', planner, escId, { seq: 0 }).body).toEqual({ replied: true })
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
    const absent = reply(w, 'alpha', coupleA, 'escalation_does_not_exist', { seq: 0 })
    const foreign = reply(w, 'alpha', coupleA, escB, { seq: 0 })
    expect(absent.status).toBe(200)
    expect(foreign.status).toBe(200)
    expect(JSON.stringify(absent.body)).toBe(JSON.stringify(foreign.body))
    expect(foreign.body).toEqual({ replied: false })
    // The foreign-wedding probe sent/charged/recorded NOTHING.
    expect(usage(w, 'alpha').message_count).toBe(0)
    expect(listReplies(w, 'alpha', planner)).toHaveLength(0)
  })

  it('double-submit: same seq + same body meters exactly ONCE (idempotent); same seq + DIFFERENT body -> 409', () => {
    const planner = login(w, 'alpha', { role: 'planner' })
    const wedA = makeWedding(w, 'alpha', planner)
    registerGuest(w, 'alpha', planner, 'sms:+1', wedA)
    const escId = escalate(w, 'alpha', planner, 'sms:+1', 'pm_1')

    expect(reply(w, 'alpha', planner, escId, { seq: 0, reply_text: 'X' }).body).toEqual({ replied: true })
    // Re-submit of the SAME rendered form (same seq + same body) -> idempotent success, NO second send.
    const resubmit = reply(w, 'alpha', planner, escId, { seq: 0, reply_text: 'X' })
    expect(resubmit.status).toBe(200)
    expect(resubmit.body).toEqual({ replied: true })
    expect(usage(w, 'alpha').message_count).toBe(1)
    // Same seq but a DIFFERENT body (a stale form / a co-operator raced the slot) -> honest 409, NO send.
    const conflict = reply(w, 'alpha', planner, escId, { seq: 0, reply_text: 'Y' })
    expect(conflict.status).toBe(409)
    expect(conflict.body).toEqual({ replied: false })
    expect(usage(w, 'alpha').message_count).toBe(1)
    // The thread holds exactly the first message.
    expect(listReplies(w, 'alpha', planner).map((r) => r.body)).toEqual(['X'])
  })

  it('an already-DISMISSED escalation cannot be replied to (no billed message to an ignored guest — keystone)', () => {
    const planner = login(w, 'alpha', { role: 'planner' })
    const wedA = makeWedding(w, 'alpha', planner)
    registerGuest(w, 'alpha', planner, 'sms:+1', wedA)
    const escId = escalate(w, 'alpha', planner, 'sms:+1', 'pm_1')
    // Dismiss it first (status-based resolve), then attempt a reply.
    expect(w.api.handle(req('POST', `/t/alpha/escalations`, { token: planner, body: { escalation_id: escId, status: 'dismissed' } })).body).toEqual({ resolved: true })
    expect(reply(w, 'alpha', planner, escId, { seq: 0 }).body).toEqual({ replied: false })
    expect(usage(w, 'alpha').message_count).toBe(0)
    expect(listReplies(w, 'alpha', planner)).toHaveLength(0)
  })

  it('an already-RESOLVED escalation cannot be replied to (a closed escalation accepts no further reply)', () => {
    const planner = login(w, 'alpha', { role: 'planner' })
    const wedA = makeWedding(w, 'alpha', planner)
    registerGuest(w, 'alpha', planner, 'sms:+1', wedA)
    const escId = escalate(w, 'alpha', planner, 'sms:+1', 'pm_1')
    expect(w.api.handle(req('POST', `/t/alpha/escalations`, { token: planner, body: { escalation_id: escId, status: 'resolved' } })).body).toEqual({ resolved: true })
    expect(reply(w, 'alpha', planner, escId, { seq: 0 }).body).toEqual({ replied: false })
    expect(usage(w, 'alpha').message_count).toBe(0)
  })

  it('a malformed reply (missing/empty reply_text) is a masked 400 INDEPENDENT of existence (no oracle)', () => {
    const planner = login(w, 'alpha', { role: 'planner' })
    const wedA = makeWedding(w, 'alpha', planner)
    registerGuest(w, 'alpha', planner, 'sms:+1', wedA)
    const escId = escalate(w, 'alpha', planner, 'sms:+1', 'pm_1')
    // Present escalation, empty reply_text -> 400. Absent escalation, empty reply_text -> the SAME 400.
    const present = w.api.handle(req('POST', `/t/alpha/escalations`, { token: planner, body: { escalation_id: escId, reply_text: '', seq: 0 } }))
    const absent = w.api.handle(req('POST', `/t/alpha/escalations`, { token: planner, body: { escalation_id: 'nope', reply_text: '', seq: 0 } }))
    expect(present.status).toBe(400)
    expect(absent.status).toBe(400)
    expect(JSON.stringify(present.body)).toBe(JSON.stringify(absent.body))
    expect(usage(w, 'alpha').message_count).toBe(0)
  })

  it('a malformed/absent seq is a masked 400 INDEPENDENT of existence (no oracle); never defaulted', () => {
    const planner = login(w, 'alpha', { role: 'planner' })
    const wedA = makeWedding(w, 'alpha', planner)
    registerGuest(w, 'alpha', planner, 'sms:+1', wedA)
    const escId = escalate(w, 'alpha', planner, 'sms:+1', 'pm_1')
    // A present escalation with a bad/absent seq, and an absent escalation with a bad seq, 400 BYTE-IDENTICALLY.
    for (const seqVal of [undefined, -1, 1.5, 'abc'] as const) {
      const presentBody: Record<string, unknown> = { escalation_id: escId, reply_text: 'hi' }
      const absentBody: Record<string, unknown> = { escalation_id: 'nope', reply_text: 'hi' }
      if (seqVal !== undefined) {
        presentBody.seq = seqVal
        absentBody.seq = seqVal
      }
      const present = w.api.handle(req('POST', `/t/alpha/escalations`, { token: planner, body: presentBody }))
      const absent = w.api.handle(req('POST', `/t/alpha/escalations`, { token: planner, body: absentBody }))
      expect(present.status).toBe(400)
      expect(absent.status).toBe(400)
      expect(JSON.stringify(present.body)).toBe(JSON.stringify(absent.body))
    }
    expect(usage(w, 'alpha').message_count).toBe(0)
  })

  it('transcript: the operator reply is PERSISTED on the thread + read back via the scoped GET', () => {
    const planner = login(w, 'alpha', { role: 'planner' })
    const wedA = makeWedding(w, 'alpha', planner)
    registerGuest(w, 'alpha', planner, 'sms:+1', wedA)
    const escId = escalate(w, 'alpha', planner, 'sms:+1', 'pm_1')

    expect(reply(w, 'alpha', planner, escId, { seq: 0, reply_text: 'Parking is in lot B, by the oak tree.' }).body).toEqual({ replied: true })
    expect(listReplies(w, 'alpha', planner).find((r) => r.escalation_id === escId)?.body).toBe('Parking is in lot B, by the oak tree.')
  })

  it('a resolve-FORM resolution (no reply) appends NO thread message', () => {
    const planner = login(w, 'alpha', { role: 'planner' })
    const wedA = makeWedding(w, 'alpha', planner)
    registerGuest(w, 'alpha', planner, 'sms:+1', wedA)
    const escId = escalate(w, 'alpha', planner, 'sms:+1', 'pm_1')

    // Resolve via the status form (Phase 27 path), not a reply -> no send, no thread message.
    expect(w.api.handle(req('POST', `/t/alpha/escalations`, { token: planner, body: { escalation_id: escId, status: 'resolved' } })).status).toBe(200)
    expect(listReplies(w, 'alpha', planner)).toHaveLength(0)
    expect(listResolutions(w, 'alpha', planner).find((x) => x.escalation_id === escId)).toMatchObject({ status: 'resolved' })
    expect(usage(w, 'alpha').message_count).toBe(0)
  })

  it('tenant isolation: a planner cannot reply to another tenant escalation (id is absent in their partition)', () => {
    const plannerA = login(w, 'alpha', { role: 'planner' })
    const wedA = makeWedding(w, 'alpha', plannerA)
    registerGuest(w, 'alpha', plannerA, 'sms:+1', wedA)
    const escA = escalate(w, 'alpha', plannerA, 'sms:+1', 'pm_1')

    const plannerB = login(w, 'beta', { role: 'planner' })
    expect(reply(w, 'beta', plannerB, escA, { seq: 0 }).body).toEqual({ replied: false })
    expect(usage(w, 'beta').message_count).toBe(0)
    expect(usage(w, 'alpha').message_count).toBe(0)
  })
})
