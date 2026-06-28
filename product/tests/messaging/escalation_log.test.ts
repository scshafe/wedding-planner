import { ManualClock, SequentialIdGenerator, type Tenant } from '@wedding-planner/shared'
import { describe, expect, it } from 'vitest'

import {
  EscalationLog,
  SimulatedMessagingAdapter,
  type TenantContext,
  TenantContextResolver,
  TenantStore,
} from '@wedding-planner/product'

/**
 * Phase 26 — the escalation log records guest questions the platform could not answer (`escalated`). It inherits
 * tenant isolation from the TenantScopedRepository (per-tenant partition, minted context, `#`-private), keys by
 * provider_message_ref (the receipt-log dedup pattern reused) so a re-delivery records exactly one escalation,
 * and exposes a planner `list` + a couple `listForWedding` partition filter (mirrors GuestRegistry).
 */

const THEME: Tenant['theme'] = {
  brand_name: 'Brand',
  primary_color_hex: '#111111',
  accent_color_hex: '#222222',
  logo_ref: 'asset_1',
}

interface World {
  log: EscalationLog
  /** A real port, used so received_at is the PLATFORM-stamped value (not a hand-written literal) — F2. */
  port: SimulatedMessagingAdapter
  store: TenantStore
  ctxA: TenantContext
  ctxB: TenantContext
}

function makeWorld(): World {
  const clock = new ManualClock('2027-03-01T00:00:00.000Z')
  const store = new TenantStore(clock, new SequentialIdGenerator('seedT'))
  store.create({ slug: 'alpha', display_name: 'Alpha', theme: THEME, plan_tier: 'solo', lifecycle_status: 'active' })
  store.create({ slug: 'beta', display_name: 'Beta', theme: THEME, plan_tier: 'solo', lifecycle_status: 'active' })
  const resolver = new TenantContextResolver(store)
  return {
    log: new EscalationLog(store, new SequentialIdGenerator('seedE')),
    port: new SimulatedMessagingAdapter(clock, new SequentialIdGenerator('seedP')),
    store,
    ctxA: resolver.resolveBySlug('alpha'),
    ctxB: resolver.resolveBySlug('beta'),
  }
}

/** Build a record input from a real inbound normalization, so received_at is the platform-stamped value (F2). */
function inputFrom(
  port: SimulatedMessagingAdapter,
  wedding_id: string,
  ref: string,
  text = 'where do I park?',
  from_ref = 'sms:+1555',
) {
  const message = port.inbound({ channel: 'sms', from_ref, text, provider_message_ref: ref })
  return {
    wedding_id,
    from_ref: message.sender_ref,
    text: message.body,
    received_at: message.received_at,
    provider_message_ref: message.provider_message_ref,
    channel: message.channel,
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

describe('EscalationLog', () => {
  it('records an escalation: mints an id, stamps tenant_id from the context, validates, persists', () => {
    const w = makeWorld()
    const rec = w.log.record(w.ctxA, inputFrom(w.port, 'wed_1', 'pm_1'))
    expect(rec).toMatchObject({
      tenant_id: w.ctxA.tenant_id,
      wedding_id: 'wed_1',
      from_ref: 'sms:+1555',
      text: 'where do I park?',
      provider_message_ref: 'pm_1',
    })
    expect(rec.escalation_id).toMatch(/^escalation/)
    // received_at is the real platform-stamped value — validates with no 500 (F2).
    expect(rec.received_at).toBe('2027-03-01T00:00:00.000Z')
    expect(w.log.list(w.ctxA)).toHaveLength(1)
  })

  it('is idempotent by provider_message_ref: a re-delivery returns the existing record, never a duplicate', () => {
    const w = makeWorld()
    const first = w.log.record(w.ctxA, inputFrom(w.port, 'wed_1', 'pm_dup'))
    // Same ref, even with a DIFFERENT text/wedding — read-first wins; the original record is returned unchanged.
    const second = w.log.record(w.ctxA, inputFrom(w.port, 'wed_OTHER', 'pm_dup', 'different text', 'sms:+9999'))
    expect(second.escalation_id).toBe(first.escalation_id)
    expect(second).toEqual(first)
    expect(w.log.list(w.ctxA)).toHaveLength(1)
  })

  it('list returns the whole tenant partition (planner); listForWedding filters to one wedding (couple)', () => {
    const w = makeWorld()
    w.log.record(w.ctxA, inputFrom(w.port, 'wed_1', 'pm_1', 'park?', 'sms:+1'))
    w.log.record(w.ctxA, inputFrom(w.port, 'wed_1', 'pm_2', 'dress?', 'sms:+2'))
    w.log.record(w.ctxA, inputFrom(w.port, 'wed_2', 'pm_3', 'venue?', 'sms:+3'))
    expect(w.log.list(w.ctxA)).toHaveLength(3)
    expect(w.log.listForWedding(w.ctxA, 'wed_1').map((e) => e.provider_message_ref)).toEqual(['pm_1', 'pm_2'])
    expect(w.log.listForWedding(w.ctxA, 'wed_2').map((e) => e.provider_message_ref)).toEqual(['pm_3'])
  })

  it('listForWedding collapses an undefined wedding_id to [] (a couple with no bound wedding)', () => {
    const w = makeWorld()
    w.log.record(w.ctxA, inputFrom(w.port, 'wed_1', 'pm_1'))
    expect(w.log.listForWedding(w.ctxA, undefined)).toEqual([])
  })

  it('getByEscalationId finds the escalation by its public id within the tenant; miss/foreign-tenant → undefined', () => {
    const w = makeWorld()
    const rec = w.log.record(w.ctxA, inputFrom(w.port, 'wed_1', 'pm_1'))
    // Hit: the minted escalation_id resolves to the record (the resolution path uses this to read wedding_id).
    expect(w.log.getByEscalationId(w.ctxA, rec.escalation_id)).toEqual(rec)
    // Miss: an unknown id → undefined.
    expect(w.log.getByEscalationId(w.ctxA, 'escalation_nope')).toBeUndefined()
    // Tenant-scoped: tenant B cannot reach tenant A's escalation by id (the scan is over B's empty partition).
    expect(w.log.getByEscalationId(w.ctxB, rec.escalation_id)).toBeUndefined()
  })

  it('is tenant-isolated: tenant B never sees tenant A escalations (no cross-tenant read)', () => {
    const w = makeWorld()
    w.log.record(w.ctxA, inputFrom(w.port, 'wed_1', 'pm_1'))
    expect(w.log.list(w.ctxB)).toEqual([])
    expect(w.log.listForWedding(w.ctxB, 'wed_1')).toEqual([])
  })

  it('fails closed on a suspended tenant: every op runs the inherited liveness guard', () => {
    const w = makeWorld()
    w.log.record(w.ctxA, inputFrom(w.port, 'wed_1', 'pm_1'))
    w.store.setLifecycleStatus(w.ctxA.tenant_id, 'suspended')
    expect(codeOfThrow(() => w.log.record(w.ctxA, inputFrom(w.port, 'wed_1', 'pm_2')))).toMatch(/TENANT/)
    expect(codeOfThrow(() => w.log.list(w.ctxA))).toMatch(/TENANT/)
    expect(codeOfThrow(() => w.log.listForWedding(w.ctxA, 'wed_1'))).toMatch(/TENANT/)
  })
})
