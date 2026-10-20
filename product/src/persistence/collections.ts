import type {
  BillingEvent,
  EscalationReply,
  EscalationResolution,
  Guest,
  GuestEscalation,
  Household,
  Tenant,
  Wedding,
  WeddingEvent,
  WeddingGuest,
  WeddingRsvp,
  WeddingRsvpSettings,
  RsvpLink,
  WeddingTask,
  ChecklistDateMove,
  WeddingVendor,
  BudgetCategory,
} from '@wedding-planner/shared'

import type { AccountEmailIndex, UserAccount } from '../accounts/account_store'
import type { Invitation } from '../accounts/invitation_store'
import type { StoredOneTimeToken } from '../accounts/one_time_token_store'
import type { PendingReset } from '../accounts/pending_reset_queue'
import type { StoredOperatorSession } from '../auth/operator_credential'
import type { StoredSession } from '../auth/session_store'
import type { StoredOutboxMessage } from '../email/simulated_email_adapter'
import type { FeedbackSubmission } from '../feedback/feedback_service'
import type { ServerError } from '../operability/error_log'
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
  emailOutbox: collection<StoredOutboxMessage>('email_outbox', 'global'),
  /** Key user_id: a person who can sign in to the workspace (issue #10). The password is a scrypt hash only. */
  userAccount: collection<UserAccount>('user_account', 'tenant'),
  /** Key normalized email -> user_id (email uniqueness per workspace) (issue #10). */
  userEmail: collection<AccountEmailIndex>('user_email', 'tenant'),
  /** Key sha256(token): single-use, expiring links sent by email (issue #10). */
  oneTimeToken: collection<StoredOneTimeToken>('one_time_token', 'tenant'),
  /** Key request_id: password-reset requests awaiting processing after the response (issue #10). */
  pendingReset: collection<PendingReset>('pending_reset', 'global'),
  /** Key setting name: platform settings, e.g. `demo_tenant` -> the tenant the demo seed created (issue #10). */
  platformSetting: collection<{ readonly value: string }>('platform_setting', 'global'),
  /** Key invitation_id: pending invitations to join the workspace (issue #11). */
  invitation: collection<Invitation>('invitation', 'tenant'),
  /** Key feedback_id: in-app feedback, a platform log only the operator reads (issue #12). */
  feedback: collection<FeedbackSubmission>('feedback', 'global'),
  /** Key error_id: the server errors the operator lists at /admin/errors (issue #13). */
  serverError: collection<ServerError>('server_error', 'global'),
  /** Key groupedKey(wedding_id, household_id): a wedding's households (issue #27). */
  household: collection<Household>('household', 'tenant', 'household'),
  /** Key groupedKey(wedding_id, guest_id): the people on a wedding's guest list (issue #27). Not `guest_binding`. */
  weddingGuest: collection<WeddingGuest>('wedding_guest', 'tenant', 'wedding_guest'),
  /** Key groupedKey(wedding_id, event_id): a wedding's events (issue #29). */
  weddingEvent: collection<WeddingEvent>('wedding_event', 'tenant', 'wedding_event'),
  /** Key groupedKey(wedding_id, `${event_id}:${guest_id}`): one guest's answer for one event (issue #29). */
  weddingRsvp: collection<WeddingRsvp>('wedding_rsvp', 'tenant', 'wedding_rsvp'),
  /** Key token_hash: a household's RSVP link, to resolve it (issue #30). */
  rsvpLink: collection<RsvpLink>('rsvp_link', 'tenant', 'rsvp_link'),
  /** Key groupedKey(wedding_id, household_id): the household's current RSVP link (issue #30). */
  rsvpLinkByHousehold: collection<RsvpLink>('rsvp_link_household', 'tenant', 'rsvp_link'),
  /** Key wedding_id: whether a wedding's RSVPs are closed (issue #30). */
  weddingRsvpSettings: collection<WeddingRsvpSettings>('wedding_rsvp_settings', 'tenant', 'wedding_rsvp_settings'),
  /** Key groupedKey(wedding_id, task_id): a wedding's checklist (issue #31). */
  weddingTask: collection<WeddingTask>('wedding_task', 'tenant', 'wedding_task'),
  /** Key wedding_id: a wedding date that moved, pending the planner's shift-or-keep (issue #31). */
  checklistDateMove: collection<ChecklistDateMove>('checklist_date_move', 'tenant', 'checklist_date_move'),
  /** Key groupedKey(wedding_id, vendor_id): a wedding's vendors and their payment schedules (issue #33). */
  weddingVendor: collection<WeddingVendor>('wedding_vendor', 'tenant', 'wedding_vendor'),
  /** Key groupedKey(wedding_id, category_id): a wedding's budget lines (issue #34). */
  budgetCategory: collection<BudgetCategory>('budget_category', 'tenant', 'budget_category'),
})
