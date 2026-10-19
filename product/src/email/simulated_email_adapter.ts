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
 * message) and only the operator tier reads it. No tenant route exposes it. It is BOUNDED: past
 * {@link OUTBOX_RETENTION} messages the oldest are deleted, so recipient addresses and one-time links do not pile
 * up in the database and its backups. A message that carries a link secret keeps it only until the link lapses: on
 * every send, lapsed secrets are redacted from the stored bodies, and a read never shows one.
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

/** A message as stored: the view plus the link secret it carries until that lapses. */
export interface StoredOutboxMessage extends OutboxMessage {
  readonly secret?: { readonly value: string; readonly expires_at: string }
}

/** What replaces a lapsed link token in a stored body. */
export const REDACTED_LINK = '[expired link removed]'

/** The operator's read of the outbox (the simulated adapter provides it; a real provider would not). */
export interface EmailOutboxReader {
  /** The most recent messages, newest first, at most `limit`. */
  recent(limit: number): readonly OutboxMessage[]
}

/** How many messages the outbox keeps (the oldest beyond this are deleted on send). */
export const OUTBOX_RETENTION = 1000

export class SimulatedEmailAdapter implements EmailPort, EmailOutboxReader {
  readonly #store: RecordStore

  constructor(
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
    store: RecordStore = new InMemoryRecordStore(),
    private readonly retention: number = OUTBOX_RETENTION,
  ) {
    this.#store = store
  }

  send(message: OutboundEmail): EmailReceipt {
    assertValidOutboundEmail(message)
    const recorded: StoredOutboxMessage = {
      message_id: this.ids.next('email'),
      to: message.to,
      subject: message.subject,
      text_body: message.text_body,
      purpose: message.purpose,
      ...(message.tenant_id === undefined ? {} : { tenant_id: message.tenant_id }),
      created_at: this.clock.now(),
      status: 'delivered',
      ...(message.secret === undefined ? {} : { secret: message.secret }),
    }
    this.#store.put(COLLECTIONS.emailOutbox, GLOBAL_PARTITION, recorded.message_id, recorded)
    const all = this.#store.list(COLLECTIONS.emailOutbox, GLOBAL_PARTITION)
    const excess = Math.max(0, all.length - this.retention)
    all.forEach((old, index) => {
      if (index < excess) this.#store.delete(COLLECTIONS.emailOutbox, GLOBAL_PARTITION, old.message_id)
      else if (this.#lapsed(old)) this.#store.put(COLLECTIONS.emailOutbox, GLOBAL_PARTITION, old.message_id, redact(old))
    })
    return { message_ref: recorded.message_id, accepted_at: recorded.created_at }
  }

  deliveryStatus(message_ref: string): EmailDeliveryStatus {
    return this.#store.get(COLLECTIONS.emailOutbox, GLOBAL_PARTITION, message_ref)?.status ?? 'unknown'
  }

  recent(limit: number): readonly OutboxMessage[] {
    return this.#store
      .list(COLLECTIONS.emailOutbox, GLOBAL_PARTITION)
      .reverse()
      .slice(0, Math.max(0, limit))
      .map((message) => view(this.#lapsed(message) ? redact(message) : message))
  }

  #lapsed(message: StoredOutboxMessage): boolean {
    return message.secret !== undefined && !(Date.parse(message.secret.expires_at) > Date.parse(this.clock.now()))
  }
}

/** The stored message with its lapsed secret removed from the body and the record. */
function redact(message: StoredOutboxMessage): StoredOutboxMessage {
  if (message.secret === undefined) return message
  const { secret, ...rest } = message
  return { ...rest, text_body: rest.text_body.split(secret.value).join(REDACTED_LINK) }
}

/** The operator's view: never the secret field. */
function view(message: StoredOutboxMessage): OutboxMessage {
  return {
    message_id: message.message_id,
    to: message.to,
    subject: message.subject,
    text_body: message.text_body,
    purpose: message.purpose,
    ...(message.tenant_id === undefined ? {} : { tenant_id: message.tenant_id }),
    created_at: message.created_at,
    status: message.status,
  }
}
