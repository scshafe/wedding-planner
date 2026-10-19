import type { Clock, IdGenerator } from '@wedding-planner/shared'

import { COLLECTIONS } from '../persistence/collections'
import type { RecordStore } from '../persistence/record_store'
import type { TenantContext } from '../tenant/tenant_context'
import { TenantScopedRepository } from '../tenant/tenant_scoped_repository'
import type { TenantLivenessCheck } from '../tenant/tenant_store'
import { normalizeEmail } from './account_store'

/**
 * @canonical invitation_store -- pending invitations to join a workspace (issue #11, ADR 0042).
 *
 * An invitation names who is invited (a normalized email), as what (`planner`, or `couple` bound to one
 * wedding), by whom, and until when. Its link token lives in the OneTimeTokenStore (purpose `invitation`, subject =
 * invitation id), so the invitation itself holds nothing a reader could accept it with. Only PENDING invitations
 * are kept: accepting creates the account and deletes the invitation; revoking deletes it; an EXPIRED invitation
 * reads as absent everywhere and is deleted when seen (so an invitee's email is not kept past its invitation).
 * Tenant-scoped through `TenantScopedRepository`, so isolation is inherited.
 *
 * related: membership_service.ts (the flows), one_time_token_store.ts (the link), account_store.ts.
 */

/** The roles an invitation can grant (owners are set up by the operator, never invited). */
export type InvitedRole = 'planner' | 'couple'

export interface Invitation {
  readonly invitation_id: string
  readonly tenant_id: string
  /** Normalized (trimmed, lowercase). */
  readonly email: string
  readonly role: InvitedRole
  /** Present iff role === 'couple'. */
  readonly wedding_id?: string
  /** The principal who sent it (a user id, or a demo principal id). */
  readonly invited_by: string
  readonly created_at: string
  readonly expires_at: string
}

export interface CreateInvitationInput {
  readonly email: string
  readonly role: InvitedRole
  readonly wedding_id?: string
  readonly invited_by: string
  readonly ttlSeconds: number
}

export class InvitationStore {
  readonly #repo: TenantScopedRepository<Invitation>

  constructor(
    liveness: TenantLivenessCheck,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
    store?: RecordStore,
  ) {
    this.#repo = new TenantScopedRepository<Invitation>(liveness, (i) => i.invitation_id, COLLECTIONS.invitation, store)
  }

  create(context: TenantContext, input: CreateInvitationInput): Invitation {
    const now = this.clock.now()
    const invitation: Invitation = {
      invitation_id: this.ids.next('invitation'),
      tenant_id: context.tenant_id,
      email: normalizeEmail(input.email),
      role: input.role,
      ...(input.role === 'couple' && input.wedding_id !== undefined ? { wedding_id: input.wedding_id } : {}),
      invited_by: input.invited_by,
      created_at: now,
      expires_at: new Date(Date.parse(now) + input.ttlSeconds * 1000).toISOString(),
    }
    return this.#repo.put(context, invitation)
  }

  get(context: TenantContext, invitation_id: string): Invitation | undefined {
    const invitation = this.#repo.read(context, invitation_id)
    if (invitation === undefined || !this.#expired(invitation)) return invitation
    this.#repo.delete(context, invitation_id)
    return undefined
  }

  /** The live pending invitations of the workspace, oldest first (expired ones are deleted on the way). */
  list(context: TenantContext): readonly Invitation[] {
    const live: Invitation[] = []
    for (const invitation of this.#repo.list(context)) {
      if (this.#expired(invitation)) this.#repo.delete(context, invitation.invitation_id)
      else live.push(invitation)
    }
    return live
  }

  /** The live pending invitation for an email, if any. */
  findByEmail(context: TenantContext, email: string): Invitation | undefined {
    const key = normalizeEmail(email)
    return this.list(context).find((invitation) => invitation.email === key)
  }

  #expired(invitation: Invitation): boolean {
    return !(Date.parse(invitation.expires_at) > Date.parse(this.clock.now()))
  }

  /** Extend an invitation's expiry (a resend). */
  renew(context: TenantContext, invitation: Invitation, ttlSeconds: number): Invitation {
    return this.#repo.put(context, {
      ...invitation,
      expires_at: new Date(Date.parse(this.clock.now()) + ttlSeconds * 1000).toISOString(),
    })
  }

  remove(context: TenantContext, invitation_id: string): boolean {
    return this.#repo.delete(context, invitation_id)
  }
}
