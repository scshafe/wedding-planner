import { CHANNELS, ManualClock, SequentialIdGenerator } from '@wedding-planner/shared'
import { beforeEach, describe, expect, it } from 'vitest'

import {
  SIMULATED_PROVIDER_COST_CENTS,
  SimulatedMessagingAdapter,
  type OutboundMessage,
  type RawInboundPayload,
} from '../../src/index'

const OUTBOUND: OutboundMessage = {
  channel: 'sms',
  recipient_ref: 'recipient-1',
  body: 'Your RSVP reminder',
  idempotency_key: 'idem-1',
}

describe('SimulatedMessagingAdapter', () => {
  let clock: ManualClock
  let ids: SequentialIdGenerator
  let adapter: SimulatedMessagingAdapter

  beforeEach(() => {
    clock = new ManualClock('2026-06-26T00:00:00.000Z')
    ids = new SequentialIdGenerator('seed')
    adapter = new SimulatedMessagingAdapter(clock, ids)
  })

  it('send accepts the message and mints an OPAQUE injected provider ref (no real-world read)', () => {
    const receipt = adapter.send(OUTBOUND)
    expect(receipt.provider_message_ref).toBe('msgprov_seed_1')
    expect(receipt.channel).toBe('sms')
    expect(receipt.accepted_at).toBe('2026-06-26T00:00:00.000Z')
    // Deterministic: a fresh adapter on the same seed replays identically.
    const replay = new SimulatedMessagingAdapter(
      new ManualClock('2026-06-26T00:00:00.000Z'),
      new SequentialIdGenerator('seed'),
    ).send(OUTBOUND)
    expect(replay).toEqual(receipt)
  })

  it('deliveryStatus is observational (returns happy delivery; no billing side effect to assert)', () => {
    const status = adapter.deliveryStatus('msgprov_seed_1')
    expect(status).toEqual({
      provider_message_ref: 'msgprov_seed_1',
      state: 'delivered',
      observed_at: '2026-06-26T00:00:00.000Z',
    })
    // It does not consume an id (no platform identity minted for an observation).
    expect(adapter.send(OUTBOUND).provider_message_ref).toBe('msgprov_seed_1')
  })

  it('inbound copies an untrusted payload through verbatim, stamping only the platform received_at', () => {
    const payload: RawInboundPayload = {
      channel: 'whatsapp',
      from_ref: 'guest-opaque-7',
      text: 'where do we park?',
      provider_message_ref: 'prov-in-42',
    }
    const inbound = adapter.inbound(payload)
    expect(inbound).toEqual({
      channel: 'whatsapp',
      sender_ref: 'guest-opaque-7',
      body: 'where do we park?',
      provider_message_ref: 'prov-in-42',
      received_at: '2026-06-26T00:00:00.000Z',
    })
    // No id consumed (no platform identity minted for inbound this rung).
    expect(adapter.send(OUTBOUND).provider_message_ref).toBe('msgprov_seed_1')
  })

  it('costReport returns a non-negative safe-integer COGS for every channel', () => {
    for (const channel of CHANNELS) {
      const report = adapter.costReport(channel)
      expect(report.channel).toBe(channel)
      expect(Number.isInteger(report.cost_cents)).toBe(true)
      expect(report.cost_cents).toBeGreaterThanOrEqual(0)
      expect(report.cost_cents).toBe(SIMULATED_PROVIDER_COST_CENTS[channel])
    }
  })
})
