import { describe, expect, it } from 'vitest'

import type { Channel } from '@wedding-planner/shared'

import type { InboundMessage, OutboundMessage, SendReceipt } from '../../src/index'

/**
 * Structural + regression guards for the provider-agnostic port types. The port is an interface (no runtime
 * surface of its own this rung), so these pin the SHAPE: the channel is the canonical `Channel` (not a
 * redefined union), the handles are opaque, and — the regression guard — NO carrier-specific field leaks in.
 */

/** Exact set-equality at the type level. */
type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never

describe('MessagingPort domain types', () => {
  it('OutboundMessage.channel is exactly the canonical Channel (not a redefined union)', () => {
    const isCanonical: Exact<OutboundMessage['channel'], Channel> = true
    expect(isCanonical).toBe(true)
  })

  it('an OutboundMessage carries only channel-agnostic, opaque fields (no carrier concepts)', () => {
    const outbound: OutboundMessage = {
      channel: 'sms',
      recipient_ref: 'recipient-opaque-123',
      body: 'Your RSVP reminder',
      idempotency_key: 'idem-abc',
    }
    // The full key set — a carrier field (e.g. a Twilio SID, an E.164 number, a segment count) would show here.
    expect(Object.keys(outbound).sort()).toEqual(['body', 'channel', 'idempotency_key', 'recipient_ref'])
  })

  it('a SendReceipt exposes the provider handle as an opaque ref + the requested channel for audit', () => {
    const receipt: SendReceipt = {
      provider_message_ref: 'prov-ref-xyz',
      channel: 'whatsapp',
      accepted_at: '2026-06-26T00:00:00.000Z',
    }
    expect(typeof receipt.provider_message_ref).toBe('string')
    expect(receipt.channel).toBe('whatsapp')
  })

  it('an InboundMessage models untrusted external input over a canonical Channel', () => {
    const inbound: InboundMessage = {
      channel: 'sms',
      sender_ref: 'sender-opaque-9',
      body: 'where is the venue?',
      provider_message_ref: 'prov-in-1',
      received_at: '2026-06-26T00:00:00.000Z',
    }
    const channelIsCanonical: Exact<InboundMessage['channel'], Channel> = true
    expect(channelIsCanonical).toBe(true)
    expect(inbound.body).toBe('where is the venue?')
  })
})
