import type { Channel } from '@wedding-planner/shared'

/**
 * @canonical messaging_port -- the provider-agnostic boundary to a messaging provider (the no-lock-in port).
 *
 * The seam between the product and whatever sends/receives guest messages (SMS / WhatsApp / email / …). It
 * exists so a real provider can NEVER lock the domain in: the four operations the channel needs —
 * `send`, `deliveryStatus`, `inbound`, `costReport` — are declared here in PROVIDER-AGNOSTIC,
 * CHANNEL-AGNOSTIC terms, and a second adapter can be dropped in with zero domain change. That
 * substitutability IS the anti-lock-in property (CLAUDE.md: avoid vendor lock-in).
 *
 * NO CARRIER CONCEPTS cross this boundary. There is no Twilio SID, no E.164 parsing, no message-segment
 * count, no provider-proprietary field. A recipient is an OPAQUE `recipient_ref`; the provider's handle for
 * a message is an OPAQUE `provider_message_ref` used for RECONCILIATION ONLY — never a platform identity or
 * a dedupe key (all platform ids come from the injected `IdGenerator`). The medium is the single canonical
 * `Channel` (a domain value, never a provider concept).
 *
 * TRUST: the provider is an UNTRUSTED external system. Nothing it reports is authoritative for billing —
 * `costReport` is the platform's COGS (read by the MessagingService ONLY to assert margin + record
 * reconciliation, validated as a non-negative integer first), and `deliveryStatus` is OBSERVATIONAL ONLY
 * (it never creates, sizes, or reverses a charge). What a tenant is billed is metered from the platform's
 * OWN record of accepted sends (see messaging_service.ts), the messaging analogue of the trusted-evidence
 * firewall.
 *
 * OFFLINE-FIRST: the only adapter this rung ships is the deterministic offline simulator
 * (simulated_messaging_adapter.ts) — it sends nothing real. A real provider sending real texts is the
 * human-reserved crossing; this port is built UP TO that line, never across it.
 *
 * related: simulated_messaging_adapter.ts (the offline adapter), messaging_service.ts (the metered/billed
 * consumer of `send`), channel.ts (the canonical `Channel`).
 */

/** An OPAQUE, provider-agnostic handle to a message recipient/sender. No carrier semantics are parsed from it. */
export type RecipientRef = string

/** A message the platform asks the provider to deliver to one recipient over one channel. */
export interface OutboundMessage {
  /** The medium — the single canonical `Channel`. This (with the tenant's plan_tier) is the SOLE basis for pricing. */
  readonly channel: Channel
  /** Opaque recipient handle. */
  readonly recipient_ref: RecipientRef
  /** The message body. Opaque to the port; comms safety/segmentation are enforced by the comms gates, not here. */
  readonly body: string
  /**
   * Caller-supplied idempotency key — dedupes one logical send WITHIN a tenant. It is meaningless across
   * tenants; the service namespaces it by tenant, so it can never be a cross-tenant handle. Must be non-empty.
   */
  readonly idempotency_key: string
}

/** The provider's acknowledgement that it accepted a send. */
export interface SendReceipt {
  /** The provider's OWN handle for this message. OPAQUE — reconciliation only; never a platform id or dedupe key. */
  readonly provider_message_ref: string
  /**
   * The channel the platform requested, echoed for audit. NEVER the basis for pricing — the service prices
   * from the request `OutboundMessage.channel`, so a provider echoing a different channel cannot shift the bill.
   */
  readonly channel: Channel
  /** When the provider accepted the send (from the adapter's injected clock; ISO 8601). */
  readonly accepted_at: string
}

/** Provider-reported delivery state. OBSERVATIONAL ONLY — it never gates, sizes, or reverses a charge. */
export type DeliveryState = 'queued' | 'sent' | 'delivered' | 'failed'

/** A delivery-state observation for a previously-accepted message. */
export interface DeliveryStatus {
  readonly provider_message_ref: string
  readonly state: DeliveryState
  /** When the state was observed (injected clock; ISO 8601). */
  readonly observed_at: string
}

/**
 * A raw, provider-shaped inbound payload — whatever a provider's inbound webhook would POST. UNTRUSTED:
 * every field is opaque and NEVER authoritative. The HTTP edge that VALIDATES this (schema + CSRF) and the
 * guest persona that consumes it land with the guest-channel rung; here it only types the port's `inbound`.
 */
export interface RawInboundPayload {
  readonly channel: Channel
  readonly from_ref: RecipientRef
  readonly text: string
  readonly provider_message_ref: string
}

/** A guest message received from a recipient (a guest texting in). UNTRUSTED external input. */
export interface InboundMessage {
  readonly channel: Channel
  readonly sender_ref: RecipientRef
  /** The message content. Opaque, untrusted, never authoritative. */
  readonly body: string
  /** The provider's opaque handle (reconciliation only). */
  readonly provider_message_ref: string
  /** When the platform received it (injected clock; ISO 8601). */
  readonly received_at: string
}

/** The provider's reported per-message cost for a channel (the platform's COGS). UNTRUSTED; integer cents. */
export interface ProviderCostReport {
  readonly channel: Channel
  /** Integer cents the provider charges the platform per message on this channel. The service validates this. */
  readonly cost_cents: number
}

/**
 * The provider-agnostic messaging port. Synchronous (offline-first; the codebase has no ambient I/O) — a
 * real network adapter would be async and is part of the deferred real-provider crossing.
 */
export interface MessagingPort {
  /** Ask the provider to deliver one message; returns its acceptance receipt (does NOT meter or bill). */
  send(message: OutboundMessage): SendReceipt

  /** Poll the provider for a message's current delivery state. OBSERVATIONAL — no billing side effect. */
  deliveryStatus(provider_message_ref: string): DeliveryStatus

  /**
   * Normalize an UNTRUSTED provider inbound payload into a domain `InboundMessage`. No real-world read; the
   * content is opaque and never authoritative; NO path to the meter or ledger (receiving never bills). The
   * trust-validating HTTP edge is deferred to the guest-channel rung; nothing consumes this over the wire yet.
   */
  inbound(payload: RawInboundPayload): InboundMessage

  /**
   * Report the provider's per-message COGS for a channel (integer cents). UNTRUSTED — the service validates
   * it is a non-negative integer and uses it ONLY to assert margin / record reconciliation, never to set a bill.
   */
  costReport(channel: Channel): ProviderCostReport
}
