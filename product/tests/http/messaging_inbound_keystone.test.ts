import { ManualClock, SequentialIdGenerator, type Tenant } from '@wedding-planner/shared'
import { describe, expect, it } from 'vitest'

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
  ProductApi,
  ProviderWebhookCredentialStore,
  SessionStore,
  SimulatedMessagingAdapter,
  type TenantContext,
  TenantContextResolver,
  TenantStore,
  WeddingAuthorizer,
  WeddingRepository,
} from '@wedding-planner/product'

/**
 * THE KEYSTONE — the guest inbound edge (Phase 19). A guest texts in; the platform meters a reply ONLY for a
 * registered guest's answerable question, and the response NEVER discloses registry state. Pins the doddy
 * must-fixes as executable invariants:
 *   P0  the reply-cardinality firewall: re-delivery (same provider_message_ref) does NOT double-charge.
 *   P1  the uniform 202: byte-identical across unregistered / escalated / answered / replay / cross-tenant.
 *   P1  segmentation: a ref registered on B, presented on A, yields no reply and reads/charges nothing.
 *   --  the meter finally fires from the request pipeline (a registered, answerable inbound -> one usage_charge).
 */

const THEME: Tenant['theme'] = {
  brand_name: 'Brand',
  primary_color_hex: '#111111',
  accent_color_hex: '#222222',
  logo_ref: 'asset_1',
}
const WH = 'wh-secret'
const REF = 'sms:+15550100'

interface World {
  api: ProductApi
  service: MessagingService
  registry: GuestRegistry
  escalations: EscalationLog
  resolutions: EscalationResolutionLog
  replies: EscalationReplyLog
  resolver: TenantContextResolver
  weddings: WeddingRepository
  tenantAId: string
  tenantBId: string
  ctxA: TenantContext
  ctxB: TenantContext
}

function makeWorld(): World {
  const clock = new ManualClock('2027-03-01T00:00:00.000Z')
  const store = new TenantStore(clock, new SequentialIdGenerator('seedT'))
  const a = store.create({ slug: 'alpha', display_name: 'Alpha', theme: THEME, plan_tier: 'studio', lifecycle_status: 'active' })
  const b = store.create({ slug: 'beta', display_name: 'Beta', theme: THEME, plan_tier: 'studio', lifecycle_status: 'active' })
  const resolver = new TenantContextResolver(store)
  const weddings = new WeddingRepository(store, clock, new SequentialIdGenerator('seedW'))
  const billing = new BillingLedger(clock, new SequentialIdGenerator('seedB'))
  const adapter = new SimulatedMessagingAdapter(clock, new SequentialIdGenerator('seedAdpt'))
  const service = new MessagingService(adapter, store, billing, new SequentialIdGenerator('seedMS'))
  const registry = new GuestRegistry(store)
  const escalations = new EscalationLog(store, new SequentialIdGenerator('seedEsc'))
  const resolutions = new EscalationResolutionLog(store, new SequentialIdGenerator('seedRes'), clock)
  const replies = new EscalationReplyLog(store, new SequentialIdGenerator('seedRep'), clock)
  const api = new ProductApi({
    resolver,
    sessionStore: new SessionStore(new SequentialIdGenerator('seedS')),
    weddings,
    authorizer: new WeddingAuthorizer(),
    guests: { registry: new GuestRegistry(store), weddings: new WeddingRepository(store, new ManualClock('2027-04-01T00:00:00.000Z'), new SequentialIdGenerator('seedGW')), authorizer: new GuestAuthorizer() },
    operators: new OperatorCredentialStore(new SequentialIdGenerator('seedO'), ['op-secret']),
    onboarding: new OnboardingService(store, billing),
    webhookCredentials: new ProviderWebhookCredentialStore(new SequentialIdGenerator('seedWH'), [WH]),
    messaging: {
      port: adapter,
      receipts: new InboundReceiptLog(store, new SequentialIdGenerator('seedIR')),
      registry,
      weddings,
      responder: new DeterministicGuestQaResponder(),
      service,
      escalations,
      resolutions,
      replies,
    },
  })
  return {
    api,
    service,
    registry,
    escalations,
    resolutions,
    replies,
    resolver,
    weddings,
    tenantAId: a.tenant_id,
    tenantBId: b.tenant_id,
    ctxA: resolver.resolveBySlug('alpha'),
    ctxB: resolver.resolveBySlug('beta'),
  }
}

/** Register a guest on tenant alpha bound to a freshly-created wedding; return the wedding id. */
function seedGuestOnAlpha(w: World, ref = REF): string {
  const wedding = w.weddings.create(w.ctxA, { couple_display_name: 'Alex & Sam', event_date: '2027-09-18' })
  w.registry.register(w.ctxA, { recipient_ref: ref, wedding_id: wedding.wedding_id, guest_id: 'guest_1' })
  return wedding.wedding_id
}

function inbound(slug: string, body: Record<string, unknown>, token = WH): ApiRequest {
  const headers: Record<string, string | undefined> = { authorization: `Bearer ${token}` }
  return { method: 'POST', path: `/t/${slug}/messaging/inbound`, headers, rawBody: JSON.stringify(body) }
}

function payload(over: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    channel: 'sms',
    from_ref: REF,
    text: 'When is the wedding?',
    provider_message_ref: 'pmr_1',
    ...over,
  }
}

const ACCEPTED: ApiResponse = { status: 202, body: { status: 'accepted' } }

describe('the guest inbound edge — keystone', () => {
  it('a registered guest asking an answerable question -> 202 AND exactly one metered reply (the meter fires)', () => {
    const w = makeWorld()
    seedGuestOnAlpha(w)
    expect(w.api.handle(inbound('alpha', payload()))).toEqual(ACCEPTED)
    const usage = w.service.usageView(w.tenantAId)
    expect(usage.message_count).toBe(1)
    expect(usage.billed_total_cents).toBeGreaterThan(0)
    expect(usage.records[0]?.channel).toBe('sms')
  })

  it('P0 — re-delivery of the same provider_message_ref does NOT double-charge (idempotent receive)', () => {
    const w = makeWorld()
    seedGuestOnAlpha(w)
    expect(w.api.handle(inbound('alpha', payload()))).toEqual(ACCEPTED)
    // Same provider_message_ref again -> uniform 202, but no second metered send.
    expect(w.api.handle(inbound('alpha', payload()))).toEqual(ACCEPTED)
    expect(w.service.usageView(w.tenantAId).message_count).toBe(1)
  })

  it('a genuinely fresh provider_message_ref for a registered guest re-charges (documented residual)', () => {
    const w = makeWorld()
    seedGuestOnAlpha(w)
    w.api.handle(inbound('alpha', payload({ provider_message_ref: 'pmr_1' })))
    w.api.handle(inbound('alpha', payload({ provider_message_ref: 'pmr_2' })))
    // Two distinct provider refs = two distinct messages = two metered replies (the provider's trust level).
    expect(w.service.usageView(w.tenantAId).message_count).toBe(2)
  })

  it('P1 segmentation — a ref registered on B, presented on A, yields no reply and charges nothing on either', () => {
    const w = makeWorld()
    // Register the ref ONLY on tenant B.
    const wedB = w.weddings.create(w.ctxB, { couple_display_name: 'Bo & Cy', event_date: '2028-01-01' })
    w.registry.register(w.ctxB, { recipient_ref: REF, wedding_id: wedB.wedding_id, guest_id: 'guest_b' })
    // The same ref texts tenant A's route -> A has no binding for it -> uniform 202, no reply.
    expect(w.api.handle(inbound('alpha', payload()))).toEqual(ACCEPTED)
    expect(w.service.usageView(w.tenantAId).message_count).toBe(0)
    expect(w.service.usageView(w.tenantBId).message_count).toBe(0)
  })

  it('an unregistered ref -> 202, no reply, no meter entry (no oracle for which numbers are known)', () => {
    const w = makeWorld()
    seedGuestOnAlpha(w, 'sms:+15550999') // a DIFFERENT ref is registered
    expect(w.api.handle(inbound('alpha', payload({ from_ref: 'sms:+15550100' })))).toEqual(ACCEPTED)
    expect(w.service.usageView(w.tenantAId).message_count).toBe(0)
  })

  it('a registered guest asking a NON-answerable question escalates -> 202, no reply, no meter', () => {
    const w = makeWorld()
    seedGuestOnAlpha(w)
    expect(w.api.handle(inbound('alpha', payload({ text: 'Can I bring my dog?' })))).toEqual(ACCEPTED)
    expect(w.service.usageView(w.tenantAId).message_count).toBe(0)
  })

  it('Phase 22 — a logistics question answered from a SET fact -> 202 AND exactly one metered reply', () => {
    const w = makeWorld()
    // Seed a guest bound to a wedding that HAS a dress code set.
    const wedding = w.weddings.create(w.ctxA, { couple_display_name: 'Alex & Sam', event_date: '2027-09-18', dress_code: 'Black tie' })
    w.registry.register(w.ctxA, { recipient_ref: REF, wedding_id: wedding.wedding_id, guest_id: 'guest_1' })
    expect(w.api.handle(inbound('alpha', payload({ text: 'what should I wear?' })))).toEqual(ACCEPTED)
    expect(w.service.usageView(w.tenantAId).message_count).toBe(1)
  })

  it('Phase 22 — a logistics question with the fact UNSET escalates wire-silently -> 202, no meter', () => {
    const w = makeWorld()
    seedGuestOnAlpha(w) // bare wedding: no dress_code
    expect(w.api.handle(inbound('alpha', payload({ text: 'what should I wear?' })))).toEqual(ACCEPTED)
    expect(w.service.usageView(w.tenantAId).message_count).toBe(0)
  })

  it('Phase 22 — a surprise probe REFUSES wire-silently -> 202, NO send (handler unchanged; refuse never sends)', () => {
    const w = makeWorld()
    // Even on a wedding with logistics set, a surprise probe sends nothing and charges nothing.
    const wedding = w.weddings.create(w.ctxA, { couple_display_name: 'Alex & Sam', event_date: '2027-09-18', dress_code: 'Black tie' })
    w.registry.register(w.ctxA, { recipient_ref: REF, wedding_id: wedding.wedding_id, guest_id: 'guest_1' })
    expect(w.api.handle(inbound('alpha', payload({ text: 'I heard there is a surprise — what is it?' })))).toEqual(ACCEPTED)
    expect(w.service.usageView(w.tenantAId).message_count).toBe(0)
  })

  it('P1 — the 202 is BYTE-IDENTICAL across every post-validation branch (no registry-state disclosure)', () => {
    const w = makeWorld()
    seedGuestOnAlpha(w)
    const answered = w.api.handle(inbound('alpha', payload({ provider_message_ref: 'r_ans' })))
    const replay = w.api.handle(inbound('alpha', payload({ provider_message_ref: 'r_ans' })))
    const escalated = w.api.handle(inbound('alpha', payload({ provider_message_ref: 'r_esc', text: 'parking?' })))
    const unregistered = w.api.handle(inbound('alpha', payload({ provider_message_ref: 'r_unk', from_ref: 'sms:+10000000' })))
    for (const res of [answered, replay, escalated, unregistered]) {
      expect(res).toEqual(ACCEPTED)
    }
  })

  it('a body-smuggled guest_id/wedding_id is rejected at the edge (additionalProperties:false -> 400)', () => {
    const w = makeWorld()
    seedGuestOnAlpha(w)
    // Even though the schema blocks it, this proves the binding can never come from the body.
    expect(w.api.handle(inbound('alpha', payload({ wedding_id: 'wed_other' }))).status).toBe(400)
    expect(w.service.usageView(w.tenantAId).message_count).toBe(0)
  })

  // -------------------------------------------------------------------------------------------------
  // Phase 26 — the escalation inbox. An `escalated` question is RECORDED (couple/planner read it); an
  // `answered` or `refused` question records NOTHING. The wire stays the uniform 202 throughout.
  // -------------------------------------------------------------------------------------------------

  it('Phase 26 — an ESCALATED question records exactly one escalation, sourced from trusted state', () => {
    const w = makeWorld()
    const weddingId = seedGuestOnAlpha(w) // bare wedding: no parking_info -> a parking question escalates
    expect(w.api.handle(inbound('alpha', payload({ text: 'where do I park?', provider_message_ref: 'pm_esc' })))).toEqual(ACCEPTED)
    const recorded = w.escalations.list(w.ctxA)
    expect(recorded).toHaveLength(1)
    expect(recorded[0]).toMatchObject({
      tenant_id: w.tenantAId,
      wedding_id: weddingId, // from the BINDING, never the body
      from_ref: REF, // the message sender_ref (the guest's identity)
      text: 'where do I park?',
      provider_message_ref: 'pm_esc',
    })
  })

  it('Phase 26 — an ANSWERED question records NO escalation (only unanswerable ones land in the inbox)', () => {
    const w = makeWorld()
    seedGuestOnAlpha(w)
    expect(w.api.handle(inbound('alpha', payload({ text: 'when is the wedding?' })))).toEqual(ACCEPTED)
    expect(w.service.usageView(w.tenantAId).message_count).toBe(1) // answered + metered
    expect(w.escalations.list(w.ctxA)).toHaveLength(0)
  })

  it('Phase 26 — a REFUSED surprise probe records NO escalation (fact-independent; never persisted)', () => {
    const w = makeWorld()
    const wedding = w.weddings.create(w.ctxA, { couple_display_name: 'Alex & Sam', event_date: '2027-09-18', dress_code: 'Black tie' })
    w.registry.register(w.ctxA, { recipient_ref: REF, wedding_id: wedding.wedding_id, guest_id: 'guest_1' })
    expect(w.api.handle(inbound('alpha', payload({ text: 'what is the surprise?' })))).toEqual(ACCEPTED)
    expect(w.escalations.list(w.ctxA)).toHaveLength(0) // refused is NOT recorded
  })

  it('Phase 26 — re-delivery of an escalated ref records exactly one escalation (idempotent by ref)', () => {
    const w = makeWorld()
    seedGuestOnAlpha(w)
    const req = inbound('alpha', payload({ text: 'where do I park?', provider_message_ref: 'pm_dup' }))
    expect(w.api.handle(req)).toEqual(ACCEPTED)
    expect(w.api.handle(req)).toEqual(ACCEPTED) // same ref again
    expect(w.escalations.list(w.ctxA)).toHaveLength(1)
  })
})

// An unknown-topic text (no keyword) always escalates; distinct refs = distinct messages.
const ESC1 = { text: 'Can I bring my dog?', provider_message_ref: 'pmr_e1' }
const ESC2 = { text: 'Do you have a gift list?', provider_message_ref: 'pmr_e2' }

describe('Phase 35 — guest-reply → thread correlation', () => {
  it('a follow-up escalation from a guest with an OPEN escalation THREADS into it (sender:guest, no new escalation, no send)', () => {
    const w = makeWorld()
    seedGuestOnAlpha(w)
    expect(w.api.handle(inbound('alpha', payload(ESC1)))).toEqual(ACCEPTED) // opens E1
    expect(w.api.handle(inbound('alpha', payload(ESC2)))).toEqual(ACCEPTED) // threads into E1
    expect(w.escalations.list(w.ctxA)).toHaveLength(1) // NOT a second escalation
    const thread = w.replies.list(w.ctxA)
    expect(thread).toHaveLength(1)
    expect(thread[0]).toMatchObject({ sender: 'guest', body: ESC2.text, provider_message_ref: ESC2.provider_message_ref })
    expect(thread[0]?.escalation_id).toBe(w.escalations.list(w.ctxA)[0]?.escalation_id)
    expect(w.service.usageView(w.tenantAId).message_count).toBe(0) // a guest turn is RECEIVED — no metered send
  })

  it('§B0 the COMMON break: re-delivery of a freshly-escalated message does NOT spawn a spurious guest turn', () => {
    const w = makeWorld()
    seedGuestOnAlpha(w)
    expect(w.api.handle(inbound('alpha', payload(ESC1)))).toEqual(ACCEPTED) // opens E1 (now OPEN)
    expect(w.api.handle(inbound('alpha', payload(ESC1)))).toEqual(ACCEPTED) // SAME ref re-delivered
    expect(w.escalations.list(w.ctxA)).toHaveLength(1)
    expect(w.replies.list(w.ctxA)).toHaveLength(0) // the gate no-ops it; NOT threaded into E1
  })

  it('re-delivery of a THREADED follow-up is idempotent (one guest turn)', () => {
    const w = makeWorld()
    seedGuestOnAlpha(w)
    w.api.handle(inbound('alpha', payload(ESC1))) // E1
    w.api.handle(inbound('alpha', payload(ESC2))) // threads
    w.api.handle(inbound('alpha', payload(ESC2))) // re-delivery of the follow-up
    expect(w.replies.list(w.ctxA)).toHaveLength(1)
  })

  it('a RESOLVED escalation does not receive the follow-up — a new conversation opens a fresh escalation', () => {
    const w = makeWorld()
    const weddingId = seedGuestOnAlpha(w)
    w.api.handle(inbound('alpha', payload(ESC1))) // E1
    const e1 = w.escalations.list(w.ctxA)[0]
    w.resolutions.resolve(w.ctxA, { escalation_id: e1!.escalation_id, wedding_id: weddingId, status: 'resolved', resolved_by: 'couple' })
    expect(w.api.handle(inbound('alpha', payload(ESC2)))).toEqual(ACCEPTED) // no OPEN escalation -> fresh
    expect(w.escalations.list(w.ctxA)).toHaveLength(2) // E2 opened
    expect(w.replies.list(w.ctxA)).toHaveLength(0) // not threaded
  })

  it('§B0 the CROSS-RESOLVE break: a threaded follow-up re-delivered AFTER its escalation is resolved is a no-op (not a fresh escalation)', () => {
    const w = makeWorld()
    const weddingId = seedGuestOnAlpha(w)
    w.api.handle(inbound('alpha', payload(ESC1))) // E1
    w.api.handle(inbound('alpha', payload(ESC2))) // threads ESC2 into E1
    const e1 = w.escalations.list(w.ctxA)[0]
    w.resolutions.resolve(w.ctxA, { escalation_id: e1!.escalation_id, wedding_id: weddingId, status: 'resolved', resolved_by: 'couple' })
    w.api.handle(inbound('alpha', payload(ESC2))) // re-delivery of the threaded follow-up after resolve
    expect(w.escalations.list(w.ctxA)).toHaveLength(1) // guestTurnByProviderRef no-ops it — NO duplicate escalation
    expect(w.replies.list(w.ctxA)).toHaveLength(1)
  })

  it('cross-wedding re-bind: after a guest moves A->B, a follow-up opens a FRESH escalation in B (never threads into A)', () => {
    const w = makeWorld()
    const weddingA = seedGuestOnAlpha(w)
    w.api.handle(inbound('alpha', payload(ESC1))) // E1 OPEN in wedding A
    // Re-bind the same ref from wedding A to a new wedding B (remove then register — register rejects a dup ref).
    const weddingB = w.weddings.create(w.ctxA, { couple_display_name: 'Bee & Cee', event_date: '2028-02-02' })
    expect(w.registry.remove(w.ctxA, REF)).toBe(true)
    w.registry.register(w.ctxA, { recipient_ref: REF, wedding_id: weddingB.wedding_id, guest_id: 'guest_2' })
    w.api.handle(inbound('alpha', payload(ESC2))) // now bound to B
    expect(w.replies.list(w.ctxA)).toHaveLength(0) // NEVER threaded into A's open E1
    const fresh = w.escalations.list(w.ctxA).find((e) => e.provider_message_ref === ESC2.provider_message_ref)
    expect(fresh?.wedding_id).toBe(weddingB.wedding_id) // the new escalation is in wedding B
    expect(weddingB.wedding_id).not.toBe(weddingA)
  })

  it('an ANSWERED follow-up still sends a metered reply and does NOT thread (deferral pinned)', () => {
    const w = makeWorld()
    seedGuestOnAlpha(w)
    w.api.handle(inbound('alpha', payload(ESC1))) // opens E1
    expect(w.api.handle(inbound('alpha', payload({ text: 'when is the wedding?', provider_message_ref: 'pmr_ans' })))).toEqual(ACCEPTED)
    expect(w.service.usageView(w.tenantAId).message_count).toBe(1) // answered + metered
    expect(w.replies.list(w.ctxA)).toHaveLength(0) // an auto-answer is NOT threaded
    expect(w.escalations.list(w.ctxA)).toHaveLength(1) // E1 stays open, unchanged
  })
})
