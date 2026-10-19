import { assertMintedPrincipal, type Principal } from '../auth/principal'
import type { Session, SessionStore } from '../auth/session_store'
import type { EmailPort } from '../email/email_port'
import { ProductError } from '../product_error'
import type { TenantContext } from '../tenant/tenant_context'
import type { TenantStore } from '../tenant/tenant_store'
import type { WeddingRepository } from '../wedding/wedding_repository'
import { type AccountStore, normalizeEmail, type PublicAccountView, publicAccountView } from './account_store'
import type { Invitation, InvitationStore, InvitedRole } from './invitation_store'
import type { OneTimeTokenStore } from './one_time_token_store'
import { assertAcceptablePassword, type PasswordHasher } from './password_hasher'
import type { RateLimiter, RateLimitRule } from './rate_limiter'

/**
 * @canonical membership_service -- who belongs to a workspace: invitations and members (issue #11, ADR 0042).
 *
 *   invite        Any planner MEMBER (an owner or planner account — never a simulated demo principal) may invite a
 *                 teammate (role planner) or, for a wedding of this workspace, its couple (role couple, bound to that
 *                 wedding). The link is a single-use, 7-day invitation token sent through the EmailPort. Invites
 *                 and resends are rate-limited per member and per workspace, and a workspace holds at most
 *                 {@link MAX_PENDING_INVITATIONS} pending invitations. An email that already has an account, or a
 *                 pending invitation, is an honest 409 to the trusted inviter.
 *   team          Planner members see the members (public views — never a password hash) and the pending
 *                 invitations with who sent each; couples and simulated principals are refused (403).
 *                 `viewer_is_owner` tells the page whether to offer management.
 *   resend/revoke The workspace OWNER re-sends a pending invitation (a fresh link; the old one stops working) or
 *                 revokes it (the link dies with it).
 *   removeMember  The OWNER removes a member (never themselves, never an owner): the account, every session of it,
 *                 every outstanding link of it, AND every invitation it sent (with its link) go — a removed member
 *                 cannot get back in through an invitation they planted.
 *   accept        Unauthenticated, through the link: checks the password first (a typo never burns the link), then
 *                 consumes the token, creates the account exactly as invited (email, role, wedding) with that
 *                 password, deletes the invitation, and has the SessionStore — still the sole mint — sign the new
 *                 member in.
 *
 * "Owner" is an ACCOUNT role: a principal is the owner iff it is a planner whose principal id is an `owner` account
 * of this tenant (a password session). A simulated demo principal is never the owner. A couple account's principal
 * carries its wedding id, so the existing intra-tenant boundary (WeddingAuthorizer, guest/escalation scopes) applies
 * to invited couples unchanged.
 *
 * related: invitation_store.ts, account_service.ts (the sign-in and link patterns), session_store.ts.
 */

/** How long an invitation link works. */
export const INVITATION_TTL_SECONDS = 7 * 24 * 60 * 60

/** The most pending invitations a workspace may hold. */
export const MAX_PENDING_INVITATIONS = 100

/** Invite and resend rate limits (each send is an email). */
export const INVITATION_RATE_LIMITS = Object.freeze({
  perMember: { limit: 20, windowSeconds: 60 * 60 },
  perTenant: { limit: 50, windowSeconds: 60 * 60 },
} satisfies Record<string, RateLimitRule>)

/** An invitation as the team page shows it (no token: there is none on the record), with who sent it. */
export type InvitationView = Invitation & { readonly invited_by_email?: string }

export interface TeamView {
  readonly members: readonly PublicAccountView[]
  readonly invitations: readonly InvitationView[]
  readonly viewer_is_owner: boolean
  /** The viewer's principal id (the page hides "Remove" on yourself). */
  readonly viewer_id: string
}

export interface InviteInput {
  readonly email: string
  readonly role: InvitedRole
  readonly wedding_id?: string
}

export interface MembershipServiceDeps {
  readonly accounts: AccountStore
  readonly invitations: InvitationStore
  readonly tokens: OneTimeTokenStore
  readonly email: EmailPort
  readonly sessions: SessionStore
  readonly hasher: PasswordHasher
  readonly weddings: WeddingRepository
  readonly tenants: Pick<TenantStore, 'findById'>
  readonly limiter: RateLimiter
  readonly publicUrl?: string
}

export class MembershipService {
  constructor(private readonly deps: MembershipServiceDeps) {}

  /** Invite a teammate or a wedding's couple. Planner members only. */
  invite(context: TenantContext, principal: Principal, input: InviteInput): Invitation {
    this.#requireMember(context, principal)
    this.#limitSends(context, principal)
    if (this.deps.invitations.list(context).length >= MAX_PENDING_INVITATIONS) {
      throw new ProductError('PRODUCT.RATE_LIMITED', 'This workspace has too many pending invitations.', {})
    }
    const email = normalizeEmail(input.email)
    let weddingName: string | undefined
    if (input.role === 'couple') {
      const wedding = input.wedding_id === undefined ? undefined : this.deps.weddings.get(context, input.wedding_id)
      if (wedding === undefined) {
        throw new ProductError('PRODUCT.BAD_REQUEST', 'A couple invitation needs a wedding of this workspace.', {})
      }
      weddingName = wedding.couple_display_name
    }
    if (this.deps.accounts.findByEmail(context, email) !== undefined) {
      throw new ProductError('PRODUCT.MEMBER_EXISTS', 'That email already belongs to a member of this workspace.', {})
    }
    if (this.deps.invitations.findByEmail(context, email) !== undefined) {
      throw new ProductError('PRODUCT.INVITATION_EXISTS', 'That email already has a pending invitation.', {})
    }
    const invitation = this.deps.invitations.create(context, {
      email,
      role: input.role,
      ...(input.role === 'couple' && input.wedding_id !== undefined ? { wedding_id: input.wedding_id } : {}),
      invited_by: principal.principal_id,
      ttlSeconds: INVITATION_TTL_SECONDS,
    })
    this.#send(context, invitation, weddingName)
    return invitation
  }

  /** The workspace's members and pending invitations. Planner members only. */
  team(context: TenantContext, principal: Principal): TeamView {
    this.#requireMember(context, principal)
    const members = this.deps.accounts.list(context)
    const emailOf = new Map(members.map((m) => [m.user_id, m.email]))
    return {
      members: members.map(publicAccountView),
      invitations: this.deps.invitations.list(context).map((invitation) => {
        const by = emailOf.get(invitation.invited_by)
        return by === undefined ? invitation : { ...invitation, invited_by_email: by }
      }),
      viewer_is_owner: this.#isOwner(context, principal),
      viewer_id: principal.principal_id,
    }
  }

  /** Send a fresh link for a pending invitation (the old link stops working). Owner only. */
  resend(context: TenantContext, principal: Principal, invitation_id: string): boolean {
    this.#requireOwner(context, principal)
    const invitation = this.deps.invitations.get(context, invitation_id)
    if (invitation === undefined) return false
    this.#limitSends(context, principal)
    const renewed = this.deps.invitations.renew(context, invitation, INVITATION_TTL_SECONDS)
    const wedding = renewed.wedding_id === undefined ? undefined : this.deps.weddings.get(context, renewed.wedding_id)
    this.#send(context, renewed, wedding?.couple_display_name)
    return true
  }

  /** Revoke a pending invitation and its link. Owner only. */
  revoke(context: TenantContext, principal: Principal, invitation_id: string): boolean {
    this.#requireOwner(context, principal)
    this.deps.tokens.revoke(context, 'invitation', invitation_id)
    return this.deps.invitations.remove(context, invitation_id)
  }

  /**
   * Remove a member: the account, its sessions, its links, and every invitation it sent. Owner only; never the owner
   * themselves, never another owner.
   */
  removeMember(context: TenantContext, principal: Principal, user_id: string): boolean {
    this.#requireOwner(context, principal)
    if (user_id === principal.principal_id) {
      throw new ProductError('PRODUCT.CANNOT_REMOVE_SELF', 'The workspace owner cannot remove themselves.', {})
    }
    const target = this.deps.accounts.get(context, user_id)
    if (target === undefined) return false
    if (target.role === 'owner') {
      throw new ProductError('PRODUCT.CANNOT_REMOVE_OWNER', 'A workspace owner cannot be removed here.', {})
    }
    this.deps.sessions.revokeAllFor(context, user_id)
    this.deps.tokens.revoke(context, undefined, user_id)
    for (const sent of this.deps.invitations.list(context).filter((i) => i.invited_by === user_id)) {
      this.deps.tokens.revoke(context, 'invitation', sent.invitation_id)
      this.deps.invitations.remove(context, sent.invitation_id)
    }
    return this.deps.accounts.remove(context, user_id)
  }

  /**
   * Accept an invitation through its link: create the account as invited, with this password, and sign in. Throws
   * PRODUCT.WEAK_PASSWORD (before the link is used), PRODUCT.INVALID_LINK, or PRODUCT.MEMBER_EXISTS (the email got
   * an account meanwhile).
   */
  accept(context: TenantContext, token: string, password: string): Session {
    assertAcceptablePassword(password)
    const invitation_id = this.deps.tokens.consume(context, 'invitation', token)
    const invitation = invitation_id === undefined ? undefined : this.deps.invitations.get(context, invitation_id)
    if (invitation === undefined) {
      throw new ProductError('PRODUCT.INVALID_LINK', 'That invitation link is invalid or has expired.', {})
    }
    if (this.deps.accounts.findByEmail(context, invitation.email) !== undefined) {
      throw new ProductError('PRODUCT.MEMBER_EXISTS', 'That email already belongs to a member of this workspace.', {})
    }
    const created = this.deps.accounts.create(context, {
      email: invitation.email,
      role: invitation.role,
      ...(invitation.wedding_id === undefined ? {} : { wedding_id: invitation.wedding_id }),
    })
    this.deps.accounts.setPassword(context, created.user_id, this.deps.hasher.hash(password))
    this.deps.invitations.remove(context, invitation.invitation_id)
    return this.deps.sessions.startAuthenticated(context, {
      user_id: created.user_id,
      role: invitation.role,
      ...(invitation.wedding_id === undefined ? {} : { wedding_id: invitation.wedding_id }),
    })
  }

  /** Whether the principal is this workspace's owner (an owner account's password session). */
  #isOwner(context: TenantContext, principal: Principal): boolean {
    assertMintedPrincipal(principal)
    if (principal.role !== 'planner') return false
    return this.deps.accounts.get(context, principal.principal_id)?.role === 'owner'
  }

  /** A planner principal whose principal id is an owner or planner ACCOUNT of this workspace (a password session). */
  #requireMember(context: TenantContext, principal: Principal): void {
    assertMintedPrincipal(principal)
    const role = principal.role === 'planner' ? this.deps.accounts.get(context, principal.principal_id)?.role : undefined
    if (role !== 'owner' && role !== 'planner') {
      throw new ProductError('PRODUCT.FORBIDDEN', 'Only planner members of the workspace manage the team.', {})
    }
  }

  /** Each invite or resend sends an email: limited per member and per workspace. */
  #limitSends(context: TenantContext, principal: Principal): void {
    if (
      !this.deps.limiter.attempt(`invite:${context.tenant_id}:${principal.principal_id}`, INVITATION_RATE_LIMITS.perMember) ||
      !this.deps.limiter.attempt(`invite:${context.tenant_id}`, INVITATION_RATE_LIMITS.perTenant)
    ) {
      throw new ProductError('PRODUCT.RATE_LIMITED', 'Too many invitations at once; try again later.', {})
    }
  }

  #requireOwner(context: TenantContext, principal: Principal): void {
    if (!this.#isOwner(context, principal)) {
      throw new ProductError('PRODUCT.FORBIDDEN', 'Only the workspace owner manages invitations and members.', {})
    }
  }

  /** Mint the invitation's link (revoking any earlier one) and email it. */
  #send(context: TenantContext, invitation: Invitation, weddingName: string | undefined): void {
    const token = this.deps.tokens.issue(context, 'invitation', invitation.invitation_id, INVITATION_TTL_SECONDS)
    const tenant = this.deps.tenants.findById(context.tenant_id)
    const brand = (tenant?.theme.brand_name ?? tenant?.display_name ?? 'your wedding planner').replace(/[\r\n]+/g, ' ')
    const as =
      invitation.role === 'couple'
        ? `to plan ${(weddingName ?? 'your wedding').replace(/[\r\n]+/g, ' ')}'s wedding with ${brand}`
        : `to join the ${brand} workspace as a planner`
    this.deps.email.send({
      to: invitation.email,
      subject: `You're invited to ${brand}`,
      text_body:
        `You have been invited ${as}.\n\n` +
        `Accept and choose your password here (the link works once and expires in 7 days):\n` +
        `${this.deps.publicUrl ?? ''}/t/${context.slug}/invite?token=${encodeURIComponent(token)}\n\n` +
        `If you were not expecting this, you can ignore it.`,
      purpose: 'invitation',
      tenant_id: context.tenant_id,
      // The link lapses with the invitation; the outbox redacts it then.
      secret: { value: token, expires_at: invitation.expires_at },
    })
  }
}
