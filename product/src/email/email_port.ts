import { ProductError } from '../product_error'

/**
 * @canonical email_port -- the provider-agnostic boundary for outbound email (issue #9, ADR 0040).
 *
 * Accounts (password reset) and invitations send email. Like the guest-messaging port (messaging_port.ts), the
 * domain sees only this port: `send` an {@link OutboundEmail}, read back a {@link EmailDeliveryStatus}. There are
 * no vendor concepts here — no template ids, no API keys, no provider message shapes — so a real provider is a new
 * adapter behind the same port (an owner crossing, M5), never a domain change.
 *
 * The first adapter is SIMULATED (simulated_email_adapter.ts): offline-first, every message is recorded in the
 * operator-visible outbox instead of leaving the system.
 *
 * What may go in a message (the callers' contract, pinned by their tests):
 *   - NEVER a session token, an operator credential, or a password. A link that must authenticate its holder
 *     (a password reset, an invitation) carries its OWN single-use, expiring token, minted for that one purpose.
 *   - Plain text only: there is no HTML body, so a message renders nothing executable anywhere it is shown.
 *
 * `assertValidOutboundEmail` is the shared shape check every adapter runs, so a header-injection attempt (a control
 * character or line separator in the subject or address) or an unbounded body is refused the same way whichever
 * provider is wired.
 *
 * related: simulated_email_adapter.ts (the offline adapter + outbox), messaging_port.ts (the pattern this mirrors).
 */

/** What a message is for. A short platform label (for the outbox and metrics), never a provider template id. */
export type EmailPurpose = 'operator_test' | 'password_reset' | 'account_setup' | 'invitation'

/** One outbound message. */
export interface OutboundEmail {
  /** The recipient address. */
  readonly to: string
  /** One line, no CR/LF. */
  readonly subject: string
  /** Plain text. */
  readonly text_body: string
  readonly purpose: EmailPurpose
  /** The tenant the mail is sent on behalf of; absent for a platform mail. */
  readonly tenant_id?: string
  /**
   * The single-use link token the body carries, and when it lapses (issue #10). An adapter that keeps messages (the
   * simulated outbox) redacts the token from the stored body once it has lapsed, so a database or backup does not
   * hold a usable link past its lifetime.
   */
  readonly secret?: { readonly value: string; readonly expires_at: string }
}

/** The adapter's acknowledgement of a send. `message_ref` is the adapter's opaque handle for status lookups. */
export interface EmailReceipt {
  readonly message_ref: string
  readonly accepted_at: string
}

/** Delivery state as the provider reports it. Observational: nothing gates on it. */
export type EmailDeliveryStatus = 'accepted' | 'delivered' | 'bounced' | 'unknown'

/** The email boundary. Synchronous like the rest of the request pipeline. */
export interface EmailPort {
  /** Send (or, simulated, record) a message. Throws PRODUCT.BAD_REQUEST for a malformed message. */
  send(message: OutboundEmail): EmailReceipt
  /** The delivery state of a sent message; 'unknown' for a ref this adapter never issued. */
  deliveryStatus(message_ref: string): EmailDeliveryStatus
}

/** Bounds on a message (hygiene: an outbox entry stays readable; a body is never unbounded). */
export const EMAIL_LIMITS = Object.freeze({ addressMax: 254, subjectMax: 200, bodyMax: 20_000 })

/** A deliberately simple address shape: one `@`, a dot in the domain, no whitespace or listed punctuation. */
const EMAIL_ADDRESS = /^[^\s@<>"'\\,;:]+@[^\s@<>"'\\,;:]+\.[^\s@<>"'\\,;:]+$/

/**
 * C0 and C1 control characters and the Unicode line/paragraph separators: line breaks or truncation points in some
 * mail libraries, so refused in addresses and subjects (a header-injection vector once a real adapter exists).
 */
// eslint-disable-next-line no-control-regex -- matching control characters is the point
const CONTROL_OR_LINE_BREAK = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/

/** Whether `value` has the shape of an email address (used by the forms that collect one, too). */
export function isEmailAddress(value: string): boolean {
  return value.length <= EMAIL_LIMITS.addressMax && !CONTROL_OR_LINE_BREAK.test(value) && EMAIL_ADDRESS.test(value)
}

/** The shared shape check every adapter runs before sending. */
export function assertValidOutboundEmail(message: OutboundEmail): void {
  const reasons: string[] = []
  if (!isEmailAddress(message.to)) reasons.push('to')
  if (
    message.subject.length === 0 ||
    message.subject.length > EMAIL_LIMITS.subjectMax ||
    CONTROL_OR_LINE_BREAK.test(message.subject)
  ) {
    reasons.push('subject')
  }
  if (message.text_body.length === 0 || message.text_body.length > EMAIL_LIMITS.bodyMax) reasons.push('text_body')
  if (reasons.length > 0) {
    throw new ProductError('PRODUCT.BAD_REQUEST', 'Malformed outbound email.', { context: { fields: reasons } })
  }
}
