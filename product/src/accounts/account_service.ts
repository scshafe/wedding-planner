import type { Session, SessionStore } from '../auth/session_store'
import type { EmailPort } from '../email/email_port'
import { ProductError } from '../product_error'
import type { TenantContext } from '../tenant/tenant_context'
import type { TenantStore } from '../tenant/tenant_store'
import { type AccountStore, normalizeEmail, type UserAccount } from './account_store'
import type { OneTimeTokenStore } from './one_time_token_store'
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
 *                             no password set yet): no account-existence oracle.
 *   requestPasswordReset      Always the same outcome to the caller. When the account exists, a single-use reset
 *                             token (1 hour) is minted and the link goes out through the EmailPort.
 *   completePasswordReset     Checks the new password's length FIRST (so a weak password never burns the link),
 *                             then consumes the token (reset or account setup), sets the scrypt hash, ends every
 *                             session of the account and revokes its other outstanding links.
 *   setUpOwner                The operator's bootstrap for a workspace: creates (or re-invites) the `owner`
 *                             account and emails a set-your-password link (3 days).
 *
 * Rate limits (in-process, fixed windows) apply per tenant + submitted email and per tenant, keyed on what was
 * SUBMITTED — never on whether an account exists — so PRODUCT.RATE_LIMITED is no oracle either.
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
  signInPerEmail: { limit: 5, windowSeconds: 15 * 60 },
  signInPerTenant: { limit: 100, windowSeconds: 15 * 60 },
  resetPerEmail: { limit: 3, windowSeconds: 60 * 60 },
  resetPerTenant: { limit: 30, windowSeconds: 60 * 60 },
} satisfies Record<string, RateLimitRule>)

export interface AccountServiceDeps {
  readonly accounts: AccountStore
  readonly hasher: PasswordHasher
  readonly tokens: OneTimeTokenStore
  readonly email: EmailPort
  readonly sessions: SessionStore
  readonly limiter: RateLimiter
  readonly tenants: Pick<TenantStore, 'findById'>
  /** The site's public base URL (no trailing slash) for links in emails; absent ⇒ site-relative links. */
  readonly publicUrl?: string
}

export class AccountService {
  constructor(private readonly deps: AccountServiceDeps) {}

  /** Sign in with email + password. Throws PRODUCT.INVALID_CREDENTIALS or PRODUCT.RATE_LIMITED. */
  signIn(context: TenantContext, email: string, password: string): Session {
    const key = normalizeEmail(email)
    this.#limit(`signin:${context.tenant_id}:${key}`, ACCOUNT_RATE_LIMITS.signInPerEmail)
    this.#limit(`signin:${context.tenant_id}`, ACCOUNT_RATE_LIMITS.signInPerTenant)
    // An over-long password fails without hashing (it says nothing about the account) — no CPU lever.
    const account = password.length > PASSWORD_LIMITS.max ? undefined : this.deps.accounts.findByEmail(context, key)
    const valid = password.length <= PASSWORD_LIMITS.max && this.deps.hasher.verify(password, account?.password)
    if (!valid || account === undefined) {
      throw new ProductError('PRODUCT.INVALID_CREDENTIALS', 'The email or password was not accepted.', {})
    }
    this.deps.limiter.reset(`signin:${context.tenant_id}:${key}`)
    return this.deps.sessions.startAuthenticated(context, {
      user_id: account.user_id,
      role: account.role === 'couple' ? 'couple' : 'planner',
      ...(account.wedding_id === undefined ? {} : { wedding_id: account.wedding_id }),
    })
  }

  /** Start a password reset. The caller sees the same outcome whether or not the account exists. */
  requestPasswordReset(context: TenantContext, email: string): void {
    const key = normalizeEmail(email)
    this.#limit(`reset:${context.tenant_id}:${key}`, ACCOUNT_RATE_LIMITS.resetPerEmail)
    this.#limit(`reset:${context.tenant_id}`, ACCOUNT_RATE_LIMITS.resetPerTenant)
    const account = this.deps.accounts.findByEmail(context, key)
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
    this.deps.email.send({
      to: account.email,
      subject: `Set up your ${brand} account`,
      text_body:
        `An account has been created for ${account.email} as the owner of the ${brand} workspace.\n\n` +
        `Choose your password here (the link works once and expires in 3 days):\n` +
        `${this.#link(context, `/reset?token=${encodeURIComponent(token)}`)}\n\n` +
        `Then sign in at ${this.#link(context, '/login')}.`,
      purpose: 'account_setup',
      tenant_id: context.tenant_id,
    })
    return account
  }

  #limit(key: string, rule: RateLimitRule): void {
    if (!this.deps.limiter.attempt(key, rule)) {
      throw new ProductError('PRODUCT.RATE_LIMITED', 'Too many attempts; try again later.', {})
    }
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
