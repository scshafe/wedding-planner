import { type Channel, ManualClock, SequentialIdGenerator, type Tenant } from '@wedding-planner/shared'
import { beforeEach, describe, expect, it } from 'vitest'

import {
  BillingLedger,
  messagePriceCents,
  MessagingService,
  OnboardingService,
  SIMULATED_PROVIDER_COST_CENTS,
  SimulatedMessagingAdapter,
  TenantStore,
  type MessagingPort,
  type OutboundMessage,
  type ProviderCostReport,
} from '@wedding-planner/product'

const THEME: Tenant['theme'] = {
  brand_name: 'Evergreen',
  primary_color_hex: '#1a2b3c',
  accent_color_hex: '#ffccaa',
  logo_ref: 'asset_logo_1',
}

function makeWorld() {
  const clock = new ManualClock('2026-06-26T00:00:00.000Z')
  const tenants = new TenantStore(clock, new SequentialIdGenerator('seedT'))
  const billing = new BillingLedger(clock, new SequentialIdGenerator('seedB'))
  const onboarding = new OnboardingService(tenants, billing)
  const adapter = new SimulatedMessagingAdapter(clock, new SequentialIdGenerator('seedP'))
  const service = new MessagingService(adapter, tenants, billing, new SequentialIdGenerator('seedM'))
  return { clock, tenants, billing, onboarding, adapter, service }
}

/** Provision + activate a tenant so it exists with a known plan_tier. Returns its tenant_id. */
function activeTenant(w: ReturnType<typeof makeWorld>, slug: string, plan_tier: Tenant['plan_tier']): string {
  const tenant = w.onboarding.provision({ slug, display_name: 'Co', theme: THEME, plan_tier })
  w.onboarding.activate(tenant.tenant_id)
  return tenant.tenant_id
}

function outbound(overrides: Partial<OutboundMessage> = {}): OutboundMessage {
  return {
    channel: 'sms',
    recipient_ref: 'guest-1',
    body: 'Your RSVP reminder',
    idempotency_key: 'idem-1',
    ...overrides,
  }
}

function codeOfThrow(fn: () => unknown): string {
  try {
    fn()
  } catch (error) {
    return (error as { code?: string }).code ?? `NON_CODED:${String(error)}`
  }
  return 'NO_THROW'
}

describe('MessagingService — meter + margin + bill', () => {
  let w: ReturnType<typeof makeWorld>
  let tenantId: string

  beforeEach(() => {
    w = makeWorld()
    tenantId = activeTenant(w, 'evergreen', 'studio')
  })

  it('a send meters once and bills the tenant price as one usage_charge (provider COGS never sets the bill)', () => {
    const result = w.service.send(tenantId, outbound({ channel: 'sms' }))
    expect(result.deduped).toBe(false)

    const expectedPrice = messagePriceCents('sms', 'studio') // 5
    const expectedCogs = SIMULATED_PROVIDER_COST_CENTS.sms // 2
    expect(result.usage.billed_cents).toBe(expectedPrice)
    expect(result.usage.provider_cost_cents).toBe(expectedCogs)
    expect(result.usage.billed_cents).not.toBe(result.usage.provider_cost_cents)

    // One usage_charge in the ledger, equal to the tenant price; it accrues the owed balance over the monthly.
    const usageCharges = w.billing.eventsFor(tenantId).filter((e) => e.kind === 'usage_charge')
    expect(usageCharges).toHaveLength(1)
    expect(usageCharges[0]?.amount_cents).toBe(expectedPrice)

    // The message_id is a platform id, NOT the provider's opaque ref.
    expect(result.usage.message_id).not.toBe(result.usage.provider_message_ref)
    expect(result.usage.message_id.startsWith('msg_')).toBe(true)
  })

  it('a replay with the same idempotency_key returns the original result and does NOT meter or bill again', () => {
    const first = w.service.send(tenantId, outbound({ idempotency_key: 'k1' }))
    const balanceAfterFirst = w.billing.balanceCents(tenantId)

    const replay = w.service.send(tenantId, outbound({ idempotency_key: 'k1' }))
    expect(replay.deduped).toBe(true)
    expect(replay.receipt).toEqual(first.receipt) // the ORIGINAL receipt, not a fresh provider ref
    expect(replay.usage).toEqual(first.usage)

    expect(w.billing.balanceCents(tenantId)).toBe(balanceAfterFirst) // no second charge
    expect(w.service.usageView(tenantId).message_count).toBe(1)
  })

  it('a missing/empty idempotency_key is a BAD_REQUEST and records nothing', () => {
    expect(codeOfThrow(() => w.service.send(tenantId, outbound({ idempotency_key: '' })))).toBe(
      'PRODUCT.BAD_REQUEST',
    )
    expect(w.service.usageView(tenantId).message_count).toBe(0)
    expect(w.billing.balanceCents(tenantId)).toBe(0)
  })

  it('an unknown tenant throws UNKNOWN_TENANT (masked at the edge) and meters nothing', () => {
    expect(codeOfThrow(() => w.service.send('tnt_ghost', outbound()))).toBe('PRODUCT.UNKNOWN_TENANT')
  })

  describe('the provider cost is untrusted — validated as a non-negative integer before the margin gate', () => {
    function serviceWithCost(cost_cents: number): { service: MessagingService; billing: BillingLedger; id: string } {
      const clock = new ManualClock('2026-06-26T00:00:00.000Z')
      const tenants = new TenantStore(clock, new SequentialIdGenerator('seedT'))
      const billing = new BillingLedger(clock, new SequentialIdGenerator('seedB'))
      const onboarding = new OnboardingService(tenants, billing)
      const tenant = onboarding.provision({ slug: 'co', display_name: 'Co', theme: THEME, plan_tier: 'studio' })
      onboarding.activate(tenant.tenant_id)
      const base = new SimulatedMessagingAdapter(clock, new SequentialIdGenerator('seedP'))
      const port: MessagingPort = {
        send: (message) => base.send(message),
        deliveryStatus: (ref) => base.deliveryStatus(ref),
        inbound: (payload) => base.inbound(payload),
        costReport: (channel: Channel): ProviderCostReport => ({ channel, cost_cents }),
      }
      const service = new MessagingService(port, tenants, billing, new SequentialIdGenerator('seedM'))
      return { service, billing, id: tenant.tenant_id }
    }

    it.each([
      ['negative', -1, 'PRODUCT.PROVIDER_COST_INVALID'],
      ['NaN', Number.NaN, 'PRODUCT.PROVIDER_COST_INVALID'],
      ['non-integer', 1.5, 'PRODUCT.PROVIDER_COST_INVALID'],
      ['above the price (margin)', 9_999, 'PRODUCT.MARGIN_VIOLATION'],
      ['equal to the price (break-even)', messagePriceCents('sms', 'studio'), 'PRODUCT.MARGIN_VIOLATION'],
    ])('rejects a %s cost fail-closed, recording nothing', (_label, cost, code) => {
      const { service, billing, id } = serviceWithCost(cost)
      expect(codeOfThrow(() => service.send(id, outbound()))).toBe(code)
      expect(service.usageView(id).message_count).toBe(0)
      expect(billing.balanceCents(id)).toBe(0)
    })
  })

  it('an adapter that echoes a DIFFERENT channel on the receipt does not change the billed amount', () => {
    const clock = new ManualClock('2026-06-26T00:00:00.000Z')
    const tenants = new TenantStore(clock, new SequentialIdGenerator('seedT'))
    const billing = new BillingLedger(clock, new SequentialIdGenerator('seedB'))
    const onboarding = new OnboardingService(tenants, billing)
    const tenant = onboarding.provision({ slug: 'co', display_name: 'Co', theme: THEME, plan_tier: 'studio' })
    onboarding.activate(tenant.tenant_id)
    const base = new SimulatedMessagingAdapter(clock, new SequentialIdGenerator('seedP'))
    // A hostile adapter: echoes the cheapest channel on the receipt regardless of the request.
    const port: MessagingPort = {
      send: (message) => ({ ...base.send(message), channel: 'email' }),
      deliveryStatus: (ref) => base.deliveryStatus(ref),
      inbound: (payload) => base.inbound(payload),
      costReport: (channel) => base.costReport(channel),
    }
    const service = new MessagingService(port, tenants, billing, new SequentialIdGenerator('seedM'))
    const result = service.send(tenant.tenant_id, outbound({ channel: 'postal' }))
    // Priced from the REQUEST channel (postal), NOT the receipt's echoed 'email'.
    expect(result.usage.billed_cents).toBe(messagePriceCents('postal', 'studio'))
  })

  it('idempotency is PER TENANT — two tenants reusing a key get independent receipts and independent charges', () => {
    const a = activeTenant(w, 'tenant-a', 'solo')
    const b = activeTenant(w, 'tenant-b', 'agency')
    const ra = w.service.send(a, outbound({ idempotency_key: 'shared-key', channel: 'sms' }))
    const rb = w.service.send(b, outbound({ idempotency_key: 'shared-key', channel: 'sms' }))

    expect(rb.deduped).toBe(false) // B is NOT deduped against A's key
    expect(rb.receipt.provider_message_ref).not.toBe(ra.receipt.provider_message_ref)
    expect(ra.usage.billed_cents).toBe(messagePriceCents('sms', 'solo'))
    expect(rb.usage.billed_cents).toBe(messagePriceCents('sms', 'agency'))
    expect(w.service.usageView(a).message_count).toBe(1)
    expect(w.service.usageView(b).message_count).toBe(1)
  })

  it('the meter billed-total reconciles exactly with the sum of the tenant usage_charge amounts', () => {
    w.service.send(tenantId, outbound({ idempotency_key: 'k1', channel: 'sms' }))
    w.service.send(tenantId, outbound({ idempotency_key: 'k2', channel: 'whatsapp' }))
    w.service.send(tenantId, outbound({ idempotency_key: 'k3', channel: 'phone' }))

    const view = w.service.usageView(tenantId)
    const usageSum = w.billing
      .eventsFor(tenantId)
      .filter((e) => e.kind === 'usage_charge')
      .reduce((acc, e) => acc + (e.amount_cents ?? 0), 0)
    expect(view.billed_total_cents).toBe(usageSum)
    expect(view.margin_total_cents).toBe(view.billed_total_cents - view.cogs_total_cents)
    expect(view.margin_total_cents).toBeGreaterThan(0)
  })

  it('deliveryStatus and inbound mutate NO billing or meter state (observational / unwired)', () => {
    w.service.send(tenantId, outbound())
    const balanceBefore = w.billing.balanceCents(tenantId)
    const countBefore = w.service.usageView(tenantId).message_count

    w.adapter.deliveryStatus('msgprov_seedP_1')
    w.adapter.inbound({ channel: 'sms', from_ref: 'g', text: 'hi', provider_message_ref: 'p' })

    expect(w.billing.balanceCents(tenantId)).toBe(balanceBefore)
    expect(w.service.usageView(tenantId).message_count).toBe(countBefore)
  })

  it('usage_charge accrues and is NOT settled by reactivate (which settles only the plan fee)', () => {
    w.service.send(tenantId, outbound({ channel: 'postal' })) // a pricey usage charge
    const usagePrice = messagePriceCents('postal', 'studio')
    expect(w.billing.balanceCents(tenantId)).toBe(usagePrice) // monthly was charge+payment (settled); usage owed

    w.onboarding.suspend(tenantId)
    w.onboarding.reactivate(tenantId) // charge+payment for the plan fee — settles the fee, NOT the usage
    expect(w.billing.balanceCents(tenantId)).toBe(usagePrice) // the accrued usage still stands
  })

  it('usageView guards existence (unknown tenant → UNKNOWN_TENANT) and does not leak via JSON', () => {
    expect(codeOfThrow(() => w.service.usageView('tnt_ghost'))).toBe('PRODUCT.UNKNOWN_TENANT')
    w.service.send(tenantId, outbound({ recipient_ref: 'secret-guest' }))
    expect(JSON.stringify(w.service)).not.toContain('secret-guest')
  })
})
