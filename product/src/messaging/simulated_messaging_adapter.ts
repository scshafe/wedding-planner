import { type Channel, type Clock, type IdGenerator } from '@wedding-planner/shared'

import {
  type DeliveryStatus,
  type InboundMessage,
  type MessagingPort,
  type OutboundMessage,
  type ProviderCostReport,
  type RawInboundPayload,
  type SendReceipt,
} from './messaging_port'

/**
 * @canonical simulated_messaging_adapter -- the offline, deterministic `MessagingPort` (sends nothing real).
 *
 * The only adapter this rung ships. It is a deterministic DOUBLE, not an ambient edge: it takes an INJECTED
 * clock + id generator and fabricates nothing from the real world (no network, no `Date.now()`, no RNG), so
 * a run replays identically and the determinism rail holds. Because it is pure-given-its-inputs it can be
 * injected at the composition root like any other dep — unlike `SystemClock`/`RandomIdGenerator`, it is not a
 * real-reality edge that must be quarantined.
 *
 * It models a provider that always accepts a send and reports happy delivery, and quotes a fixed per-channel
 * COGS. Swapping in a real provider adapter is a drop-in (the no-lock-in property) AND the human-reserved
 * crossing — this adapter is the line we build up to, never across (CLAUDE.md: a real provider sending real
 * texts is tier-2 guest-comms).
 *
 * TRUST boundary it sits behind: nothing here is authoritative for billing. The `provider_message_ref` it
 * returns is an OPAQUE injected id (reconciliation only, never a platform identity/dedupe key — the service
 * mints its own ids and meters from its own record). `deliveryStatus` is OBSERVATIONAL. `inbound` treats its
 * payload as OPAQUE, UNTRUSTED data and has no path to the meter/ledger. `costReport` is the platform's COGS,
 * validated by the service before it is trusted even for the margin check.
 *
 * related: messaging_port.ts (the contract), messaging_service.ts (the metered/billed consumer of `send`).
 */

/**
 * The simulated provider's per-message COGS in INTEGER CENTS (what the provider charges the PLATFORM). These
 * are fictional but ordered like reality (a physical letter ≫ a voice call ≫ a text). The tenant PRICE
 * (price_book.ts) sits above each of these with a margin; the service asserts that margin fail-closed. Total
 * over `Channel`, so a new channel cannot silently default to a free/zero cost.
 */
export const SIMULATED_PROVIDER_COST_CENTS: Readonly<Record<Channel, number>> = {
  email: 1,
  sms: 2,
  whatsapp: 1,
  phone: 5,
  postal: 60,
}

export class SimulatedMessagingAdapter implements MessagingPort {
  constructor(
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
  ) {}

  /** Accept the send and acknowledge it. Mints an OPAQUE provider ref from the injected id generator. */
  send(message: OutboundMessage): SendReceipt {
    return {
      provider_message_ref: this.ids.next('msgprov'),
      channel: message.channel,
      accepted_at: this.clock.now(),
    }
  }

  /** The simulated provider reports happy delivery. OBSERVATIONAL — no billing side effect. */
  deliveryStatus(provider_message_ref: string): DeliveryStatus {
    return {
      provider_message_ref,
      state: 'delivered',
      observed_at: this.clock.now(),
    }
  }

  /**
   * Normalize an UNTRUSTED provider inbound payload into a domain `InboundMessage`. Every field is treated as
   * opaque, untrusted data — copied through verbatim, never parsed or trusted as authoritative — and only the
   * `received_at` timestamp is the platform's (from the injected clock). No real-world read; NO meter/ledger
   * path (receiving never bills). Unwired this rung: the trust-validating HTTP edge lands with the guest rung.
   */
  inbound(payload: RawInboundPayload): InboundMessage {
    return {
      channel: payload.channel,
      sender_ref: payload.from_ref,
      body: payload.text,
      provider_message_ref: payload.provider_message_ref,
      received_at: this.clock.now(),
    }
  }

  /** The provider's per-message COGS for a channel (non-negative integer cents). */
  costReport(channel: Channel): ProviderCostReport {
    return {
      channel,
      cost_cents: SIMULATED_PROVIDER_COST_CENTS[channel],
    }
  }
}
