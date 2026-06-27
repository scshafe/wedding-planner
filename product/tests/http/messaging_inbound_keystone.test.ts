import { ManualClock, SequentialIdGenerator, type Tenant } from '@wedding-planner/shared'
import { describe, expect, it } from 'vitest'

import {
  type ApiRequest,
  type ApiResponse,
  BillingLedger,
  DeterministicGuestQaResponder,
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
  const api = new ProductApi({
    resolver,
    sessionStore: new SessionStore(new SequentialIdGenerator('seedS')),
    weddings,
    authorizer: new WeddingAuthorizer(),
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
    },
  })
  return {
    api,
    service,
    registry,
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
    expect(w.api.handle(inbound('alpha', payload({ text: 'What is the parking and dress code?' })))).toEqual(ACCEPTED)
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
})
