import type {
  BillingEvent,
  EscalationReply,
  EscalationResolution,
  Guest,
  GuestEscalation,
  Tenant,
  Wedding,
} from '@wedding-planner/shared'

import type { StoredOperatorSession } from '../auth/operator_credential'
import type { StoredSession } from '../auth/session_store'
import type { OutboxMessage } from '../email/simulated_email_adapter'
import type { InboundReceipt } from '../messaging/inbound_receipt_log'
import type { SendResult } from '../messaging/messaging_service'
import { collection } from './record_store'

/**
 * @canonical collections -- the census of every persisted collection (ADR 0039).
 *
 * One handle per store, so the full persisted surface is readable in one place and a name cannot be reused by
 * two stores: `collection()` is called nowhere else (an architecture test enforces it). The names are part of
 * the on-disk format: renaming one is a migration (sqlite_migrations.ts). Each handle declares its partition
 * scope (tenant / global) and, when there is one, the JSON Schema its records satisfy.
 *
 * The compose-level restart test writes through every store, reads it back from a recomposed surface over the
 * same database, and checks every collection here has rows in the file and every row honors its scope, so a
 * store left on its in-memory default in the composition root fails that test.
 */
export const COLLECTIONS = Object.freeze({
  /** Key tenant_id. */
  tenant: collection<Tenant>('tenant', 'global', 'tenant'),
  /** Key normalized slug -> the owning tenant_id (the slug-uniqueness index). */
  tenantSlug: collection<{ readonly tenant_id: string }>('tenant_slug', 'global'),
  /** Key wedding_id. */
  wedding: collection<Wedding>('wedding', 'tenant', 'wedding'),
  /**
   * Key recipient_ref: the messaging binding of an opaque sender to one wedding (NOT the M2 guest-list entity,
   * which will get its own collection).
   */
  guestBinding: collection<Guest>('guest_binding', 'tenant', 'guest'),
  /** Key provider_message_ref. */
  guestEscalation: collection<GuestEscalation>('guest_escalation', 'tenant', 'guest_escalation'),
  /** Key `${escalation_id}:${seq}`. */
  escalationResolution: collection<EscalationResolution>('escalation_resolution', 'tenant', 'escalation_resolution'),
  /** Key `${escalation_id}:${seq}`. */
  escalationReply: collection<EscalationReply>('escalation_reply', 'tenant', 'escalation_reply'),
  /** Key provider_message_ref. */
  inboundReceipt: collection<InboundReceipt>('inbound_receipt', 'tenant'),
  /** Key event_id (append-only). */
  billingEvent: collection<BillingEvent>('billing_event', 'tenant', 'billing_event'),
  /** Key idempotency_key (the metered-send dedup record). */
  messageSend: collection<SendResult>('message_send', 'tenant'),
  /** Key sha256(session token): the raw token is never stored. */
  session: collection<StoredSession>('session', 'global'),
  /** Key sha256(operator console session token) (issue #9). */
  operatorSession: collection<StoredOperatorSession>('operator_session', 'global'),
  /** Key message_id: the simulated email outbox, a platform log only the operator reads (issue #9). */
  emailOutbox: collection<OutboxMessage>('email_outbox', 'global'),
})
