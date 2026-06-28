import { describe, expect, it } from 'vitest'

import { CHANNELS, type Channel } from '../../src/index'
import type { CommsFactAssertedPayload, GuestEscalation, GuestPersona, InboundWebhook } from '../../src/index'

/**
 * Drift guard for the single canonical `Channel`. The type is DERIVED from the `event_payloads` schema; this
 * pins it against (a) the runtime `CHANNELS` tuple and (b) the OTHER schema that inlines the same set
 * (`guest_persona`'s `preferred_channel`), so the two self-contained schema contracts can never silently
 * diverge — a change to either enum breaks compilation here, the intended CI signal.
 */

/** Exact set-equality at the type level: true iff A and B are mutually assignable. */
type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never

describe('Channel — the single canonical comms-channel enum', () => {
  it('CHANNELS is exhaustive over Channel and carries exactly the canonical values', () => {
    // Compile-time: the tuple's element union is exactly `Channel` (no missing/extra value).
    const tupleExhaustive: Exact<(typeof CHANNELS)[number], Channel> = true
    expect(tupleExhaustive).toBe(true)
    // Runtime: the canonical value set.
    expect([...CHANNELS].sort()).toEqual(['email', 'phone', 'postal', 'sms', 'whatsapp'])
  })

  it('matches the event_payloads schema channel union (the derivation source)', () => {
    const matches: Exact<Channel, NonNullable<CommsFactAssertedPayload['channel']>> = true
    expect(matches).toBe(true)
  })

  it('matches the guest_persona schema preferred_channel union (no cross-contract drift)', () => {
    const matches: Exact<Channel, GuestPersona['contact']['preferred_channel']> = true
    expect(matches).toBe(true)
  })

  it('matches the inbound_webhook schema channel union (Phase 19 — not a fourth uncoordinated copy)', () => {
    const matches: Exact<Channel, InboundWebhook['channel']> = true
    expect(matches).toBe(true)
  })

  it('matches the guest_escalation schema channel union (Phase 28 — the reply-routing snapshot, not a copy)', () => {
    const matches: Exact<Channel, GuestEscalation['channel']> = true
    expect(matches).toBe(true)
  })
})
