import type { Clock, IdGenerator } from '@wedding-planner/shared'

import { COLLECTIONS } from '../persistence/collections'
import { InMemoryRecordStore } from '../persistence/in_memory_record_store'
import { GLOBAL_PARTITION, type RecordStore } from '../persistence/record_store'
import {
  assertValidOutboundEmail,
  type EmailDeliveryStatus,
  type EmailPort,
  type EmailPurpose,
  type EmailReceipt,
  type OutboundEmail,
} from './email_port'

/**
 * @canonical simulated_email_adapter -- the offline {@link EmailPort}: every message lands in the outbox (issue #9).
 *
 * Nothing leaves the system. `send` validates the message (the shared port check), then records it as an
 * {@link OutboxMessage} — to, subject, text body, purpose, tenant, created_at — in the durable store, and reports
 * it `delivered` (the simulation's honest stand-in: the message is exactly as readable as it will ever be). The
 * operator reads the outbox at `/admin/outbox`; that is how a reset link or an invitation reaches a person while
 * the product is offline.
 *
 * The outbox is a PLATFORM log, not tenant data: it lives in the global partition (the tenant is a field on each
 * message) and only the operator tier reads it. No tenant route exposes it.
 *
 * Deterministic: message ids and timestamps come from the injected generator and clock.
 *
 * related: email_port.ts (the port and its message contract), product_api.ts (GET/POST /admin/outbox).
 */

/** A recorded message, as the operator sees it. */
export interface OutboxMessage {
  readonly message_id: string
  readonly to: string
  readonly subject: string
  readonly text_body: string
  readonly purpose: EmailPurpose
  readonly tenant_id?: string
  readonly created_at: string
  readonly status: EmailDeliveryStatus
}

/** The operator's read of the outbox (the simulated adapter provides it; a real provider would not). */
export interface EmailOutboxReader {
  /** The most recent messages, newest first, at most `limit`. */
  recent(limit: number): readonly OutboxMessage[]
}

export class SimulatedEmailAdapter implements EmailPort, EmailOutboxReader {
  readonly #store: RecordStore

  constructor(
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
    store: RecordStore = new InMemoryRecordStore(),
  ) {
    this.#store = store
  }

  send(message: OutboundEmail): EmailReceipt {
    assertValidOutboundEmail(message)
    const recorded: OutboxMessage = {
      message_id: this.ids.next('email'),
      to: message.to,
      subject: message.subject,
      text_body: message.text_body,
      purpose: message.purpose,
      ...(message.tenant_id === undefined ? {} : { tenant_id: message.tenant_id }),
      created_at: this.clock.now(),
      status: 'delivered',
    }
    this.#store.put(COLLECTIONS.emailOutbox, GLOBAL_PARTITION, recorded.message_id, recorded)
    return { message_ref: recorded.message_id, accepted_at: recorded.created_at }
  }

  deliveryStatus(message_ref: string): EmailDeliveryStatus {
    return this.#store.get(COLLECTIONS.emailOutbox, GLOBAL_PARTITION, message_ref)?.status ?? 'unknown'
  }

  recent(limit: number): readonly OutboxMessage[] {
    return this.#store.list(COLLECTIONS.emailOutbox, GLOBAL_PARTITION).reverse().slice(0, Math.max(0, limit))
  }
}
