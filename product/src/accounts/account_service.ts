import type { Clock } from '@wedding-planner/shared'

import type { Session, SessionStore } from '../auth/session_store'
import { type EmailPort, isEmailAddress } from '../email/email_port'
import { ProductError } from '../product_error'
import type { TenantContext } from '../tenant/tenant_context'
import type { TenantStore } from '../tenant/tenant_store'
import { type AccountStore, normalizeEmail, type UserAccount } from './account_store'
import type { OneTimeTokenStore } from './one_time_token_store'
import type { PendingResetQueue } from './pending_reset_queue'
import { assertAcceptablePassword, PASSWORD_LIMITS, type PasswordHasher } from './password_hasher'
import type { RateLimiter, RateLimitRule } from './rate_limiter'

/**
 * @canonical account_service -- real sign-in, password reset and workspace-owner setup (issue #10, ADR 0041).
 *
 * The flows, and the properties each keeps:
 *
 *   signIn(email, password)   Verifies the password (constant work for unknown accounts — see PasswordHasher),
 *                             then asks the SessionStore — still the sole mint — for a `password` session. Every
 *                             failure is the same PRODUCT.INVALID_CREDENTIALS (unknown email, wrong password,
 *                             no password set yet, a malformed email): no account-existence oracle. A hash below
 *                             the current cost is re-hashed on a successful sign-in.
 *   requestPasswordReset      The SAME work for every well-formed email: one row in the pending-reset queue. The
 *                             account lookup, the single-use link (1 hour) and the email happen after the response
 *                             ({@link AccountService.processPendingResets}), so neither the answer nor its timing
 *                             says whether the account exists.
 *   completePasswordReset     Checks the new password's length FIRST (so a weak password never burns the link),
 *                             then consumes the token (reset or account setup), sets the scrypt hash, ends every
 *                             session of the account and revokes its other outstanding links.
 *   setUpOwner                The operator's bootstrap for a workspace: creates (or re-invites) the `owner`
 *                             account and emails a set-your-password link (3 days).
 *
 * Rate limits (in-process, fixed windows, keyed on what was SUBMITTED — never on whether an account exists — so
 * PRODUCT.RATE_LIMITED is no oracle either):
 *   - sign-in FAILURES per tenant + email: checked before hashing, counted only on failure, cleared on success;
 *   - a process-wide budget of password verifications (scrypt is the expensive part), so a flood degrades sign-in
 *     instead of the whole server;
 *   - reset requests per tenant + email.
 * There is deliberately no tenant-wide hard cap: without a trusted client identity, any shared bucket lets one
 * anonymous caller lock a whole workspace out.
 *
 * Email contract: messages carry only their own single-use link; never a session token or a password. Links are
 * built from the configured public URL (never the request's Host header, which a requester controls); without one
 * they are site-relative paths the reader opens on the planner site.
 *
 * related: password_hasher.ts, account_store.ts, one_time_token_store.ts, rate_limiter.ts, session_store.ts.
 */

/** How long a password-reset link works. */
export const RESET_TOKEN_TTL_SECONDS = 60 * 60
/** How long an account-setup link works. */
export const SETUP_TOKEN_TTL_SECONDS = 3 * 24 * 60 * 60

/** The rate limits applied to sign-in and reset requests. */
export const ACCOUNT_RATE_LIMITS = Object.freeze({
  signInFailuresPerEmail: { limit: 10, windowSeconds: 15 * 60 },
  passwordVerificationsPerMinute: { limit: 120, windowSeconds: 60 },
  resetPerEmail: { limit: 3, windowSeconds: 60 * 60 },
} satisfies Record<string, RateLimitRule>)

/** The process-wide key of the password-verification budget. */
const VERIFICATION_BUDGET_KEY = 'password-verifications'

export interface AccountServiceDeps {
  readonly accounts: AccountStore
  readonly hasher: PasswordHasher
  readonly tokens: OneTimeTokenStore
  readonly email: EmailPort
  readonly sessions: SessionStore
  readonly limiter: RateLimiter
  readonly tenants: Pick<TenantStore, 'findById'>
  /** Stamps link expiries for the outbox's redaction. */
  readonly clock: Clock
  /** Reset requests awaiting processing after the response. */
  readonly pendingResets: PendingResetQueue
  /** Mints a tenant's context when processing a queued reset (platform work, like the operator's). */
  readonly contexts: { resolveById(tenant_id: string): TenantContext }
  /** The site's public base URL (no trailing slash) for links in emails; absent ⇒ site-relative links. */
  readonly publicUrl?: string
}

export class AccountService {
  constructor(private readonly deps: AccountServiceDeps) {}

  /** Sign in with email + password. Throws PRODUCT.INVALID_CREDENTIALS or PRODUCT.RATE_LIMITED. */
  signIn(context: TenantContext, email: string, password: string): Session {
    // A malformed email or an over-long password cannot belong to an account: the same failure, no counter, no hash.
    if (!isEmailAddress(email.trim()) || password.length > PASSWORD_LIMITS.max) {
      throw new ProductError('PRODUCT.INVALID_CREDENTIALS', 'The email or password was not accepted.', {})
    }
    const key = `signin:${context.tenant_id}:${normalizeEmail(email)}`
    if (this.deps.limiter.blocked(key, ACCOUNT_RATE_LIMITS.signInFailuresPerEmail)) this.#rateLimited()
    if (!this.deps.limiter.attempt(VERIFICATION_BUDGET_KEY, ACCOUNT_RATE_LIMITS.passwordVerificationsPerMinute)) this.#rateLimited()
    const account = this.deps.accounts.findByEmail(context, email)
    if (!this.deps.hasher.verify(password, account?.password) || account === undefined) {
      this.deps.limiter.hit(key, ACCOUNT_RATE_LIMITS.signInFailuresPerEmail)
      throw new ProductError('PRODUCT.INVALID_CREDENTIALS', 'The email or password was not accepted.', {})
    }
    this.deps.limiter.reset(key)
    if (account.password !== undefined && this.deps.hasher.needsRehash(account.password)) {
      this.deps.accounts.setPassword(context, account.user_id, this.deps.hasher.hash(password))
    }
    return this.deps.sessions.startAuthenticated(context, {
      user_id: account.user_id,
      role: account.role === 'couple' ? 'couple' : 'planner',
      ...(account.wedding_id === undefined ? {} : { wedding_id: account.wedding_id }),
    })
  }

  /**
   * Request a password reset: one identical queued row for every well-formed email (a malformed one is ignored), so
   * the answer and its cost are the same whether or not the account exists. Throws PRODUCT.RATE_LIMITED.
   */
  requestPasswordReset(context: TenantContext, email: string): void {
    if (!isEmailAddress(email.trim())) return
    const key = normalizeEmail(email)
    if (!this.deps.limiter.attempt(`reset:${context.tenant_id}:${key}`, ACCOUNT_RATE_LIMITS.resetPerEmail)) this.#rateLimited()
    this.deps.pendingResets.enqueue(context, key)
  }

  /**
   * Handle the queued reset requests (run after a response has been sent): for each whose account exists, mint the
   * link and email it. A request for a tenant that is gone or suspended, or for an unknown email, ends silently.
   * Returns how many requests were taken. `transact` wraps each step (the composition root passes the store's
   * transaction); a failing request is dropped, never retried forever.
   */
  processPendingResets(transact: <R>(fn: () => R) => R = (fn) => fn()): number {
    let taken = 0
    for (;;) {
      const request = transact(() => this.deps.pendingResets.take())
      if (request === undefined) return taken
      taken += 1
      try {
        transact(() => this.#sendReset(request.tenant_id, request.email))
      } catch {
        // Dropped: the requester can ask again (an unreachable tenant or a send failure must not wedge the queue).
      }
    }
  }

  /** Compute the dummy hash before serving (so no request pays for it, and timing is uniform from the first one). */
  warm(): void {
    this.deps.hasher.warm()
  }

  #sendReset(tenant_id: string, email: string): void {
    let context: TenantContext
    try {
      context = this.deps.contexts.resolveById(tenant_id)
    } catch {
      return
    }
    const account = this.deps.accounts.findByEmail(context, email)
    if (account === undefined) return
    const token = this.deps.tokens.issue(context, 'password_reset', account.user_id, RESET_TOKEN_TTL_SECONDS)
    const brand = this.#brand(context)
    this.deps.email.send({
      to: account.email,
      subject: `Reset your ${brand} password`,
      text_body:
        `Someone asked to reset the password for ${account.email} on ${brand}.\n\n` +
        `If it was you, choose a new password here (the link works once and expires in 1 hour):\n` +
        `${this.#link(context, `/reset?token=${encodeURIComponent(token)}`)}\n\n` +
        `If it wasn't you, ignore this message: your password has not changed.`,
      purpose: 'password_reset',
      tenant_id: context.tenant_id,
      secret: { value: token, expires_at: this.#expiry(RESET_TOKEN_TTL_SECONDS) },
    })
  }

  /**
   * Finish a reset or an account setup: set the password the link's account will sign in with. Throws
   * PRODUCT.WEAK_PASSWORD (checked before the link is used) or PRODUCT.INVALID_LINK (unknown, used, expired, or
   * another tenant's link — one indistinguishable failure).
   */
  completePasswordReset(context: TenantContext, token: string, newPassword: string): void {
    assertAcceptablePassword(newPassword)
    const user_id =
      this.deps.tokens.consume(context, 'password_reset', token) ?? this.deps.tokens.consume(context, 'account_setup', token)
    const updated =
      user_id === undefined ? undefined : this.deps.accounts.setPassword(context, user_id, this.deps.hasher.hash(newPassword))
    if (updated === undefined) {
      throw new ProductError('PRODUCT.INVALID_LINK', 'That link is invalid or has expired.', {})
    }
    // A new password ends every existing session of the account and every other outstanding link.
    this.deps.sessions.revokeAllFor(context, updated.user_id)
    this.deps.tokens.revoke(context, undefined, updated.user_id)
  }

  /**
   * The operator's workspace bootstrap: create the `owner` account for `email` (or, if that owner already exists,
   * send a fresh setup link) and email the link. Throws PRODUCT.ACCOUNT_EXISTS when the email belongs to a
   * non-owner account.
   */
  setUpOwner(context: TenantContext, email: string): UserAccount {
    const existing = this.deps.accounts.findByEmail(context, email)
    if (existing !== undefined && existing.role !== 'owner') {
      throw new ProductError('PRODUCT.ACCOUNT_EXISTS', 'That email already belongs to a member of this workspace.', {})
    }
    const account = existing ?? this.deps.accounts.create(context, { email, role: 'owner' })
    const token = this.deps.tokens.issue(context, 'account_setup', account.user_id, SETUP_TOKEN_TTL_SECONDS)
    const brand = this.#brand(context)
    const opening =
      existing === undefined
        ? `An account has been created for ${account.email} as the owner of the ${brand} workspace.`
        : `Here is a new link to set the password of ${account.email}, the owner of the ${brand} workspace. ` +
          `Using it replaces your current password.`
    this.deps.email.send({
      to: account.email,
      subject: existing === undefined ? `Set up your ${brand} account` : `Set your ${brand} password`,
      text_body:
        `${opening}\n\n` +
        `Choose your password here (the link works once and expires in 3 days):\n` +
        `${this.#link(context, `/reset?token=${encodeURIComponent(token)}`)}\n\n` +
        `Then sign in at ${this.#link(context, '/login')}.`,
      purpose: 'account_setup',
      tenant_id: context.tenant_id,
      secret: { value: token, expires_at: this.#expiry(SETUP_TOKEN_TTL_SECONDS) },
    })
    return account
  }

  #rateLimited(): never {
    throw new ProductError('PRODUCT.RATE_LIMITED', 'Too many attempts; try again later.', {})
  }

  /** When a link minted now with this lifetime lapses (what the outbox redacts after). */
  #expiry(ttlSeconds: number): string {
    return new Date(Date.parse(this.deps.clock.now()) + ttlSeconds * 1000).toISOString()
  }

  /** The tenant's brand name, on one line (it goes into a subject). */
  #brand(context: TenantContext): string {
    const tenant = this.deps.tenants.findById(context.tenant_id)
    return (tenant?.theme.brand_name ?? tenant?.display_name ?? 'your wedding planner').replace(/[\r\n]+/g, ' ')
  }

  /** A link to a page of this tenant: absolute with a configured public URL, else site-relative. */
  #link(context: TenantContext, path: string): string {
    return `${this.deps.publicUrl ?? ''}/t/${context.slug}${path}`
  }
}
