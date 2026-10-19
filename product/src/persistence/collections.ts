import type {
  BillingEvent,
  EscalationReply,
  EscalationResolution,
  Guest,
  GuestEscalation,
  Tenant,
  Wedding,
} from '@wedding-planner/shared'

import type { StoredSession } from '../auth/session_store'
import type { InboundReceipt } from '../messaging/inbound_receipt_log'
import type { SendResult } from '../messaging/messaging_service'
import { collection } from './record_store'

/**
 * @canonical collections -- the census of every persisted collection (ADR 0039).
 *
 * One handle per store, so the full persisted surface is readable in one place and a name cannot be reused by
 * two stores. The names are part of the on-disk format: renaming one is a migration (sqlite_migrations.ts).
 * The partition each uses is the store's concern; the comment says which.
 *
 * The compose-level restart test writes through every store and reads it back from a recomposed surface over the
 * same database, so a store left on its in-memory default in the composition root fails that test.
 */
export const COLLECTIONS = Object.freeze({
  /** Global partition, key tenant_id. */
  tenant: collection<Tenant>('tenant'),
  /** Global partition, key normalized slug -> the owning tenant_id (the slug-uniqueness index). */
  tenantSlug: collection<{ readonly tenant_id: string }>('tenant_slug'),
  /** Tenant partition, key wedding_id. */
  wedding: collection<Wedding>('wedding'),
  /** Tenant partition, key recipient_ref. */
  guest: collection<Guest>('guest'),
  /** Tenant partition, key provider_message_ref. */
  guestEscalation: collection<GuestEscalation>('guest_escalation'),
  /** Tenant partition, key `${escalation_id}:${seq}`. */
  escalationResolution: collection<EscalationResolution>('escalation_resolution'),
  /** Tenant partition, key `${escalation_id}:${seq}`. */
  escalationReply: collection<EscalationReply>('escalation_reply'),
  /** Tenant partition, key provider_message_ref. */
  inboundReceipt: collection<InboundReceipt>('inbound_receipt'),
  /** Partition tenant_id, key event_id (append-only). */
  billingEvent: collection<BillingEvent>('billing_event'),
  /** Partition tenant_id, key idempotency_key (the metered-send dedup record). */
  messageSend: collection<SendResult>('message_send'),
  /** Global partition, key sha256(session token): the raw token is never stored. */
  session: collection<StoredSession>('session'),
})
