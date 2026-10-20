import { type Clock, getSchemaRegistry, type IdGenerator, type RsvpLink, sha256Hex } from '@wedding-planner/shared'

import type { Principal } from '../auth/principal'
import type { WeddingAuthorizer } from '../auth/wedding_authorizer'
import type { GuestDirectory } from '../guests/guest_directory'
import type { GuestListHooks } from '../guests/guest_list_service'
import { COLLECTIONS } from '../persistence/collections'
import { groupedKey, type RecordStore } from '../persistence/record_store'
import { ProductError } from '../product_error'
import type { TenantContext } from '../tenant/tenant_context'
import { TenantScopedRepository } from '../tenant/tenant_scoped_repository'
import type { TenantLivenessCheck } from '../tenant/tenant_store'
import { assertWeddingReach } from '../wedding/wedding_reach'
import type { WeddingRepository } from '../wedding/wedding_repository'

/**
 * @canonical rsvp_link_service -- households' RSVP links (issue #30, ADR 0049): who may answer on the public RSVP page.
 *
 * A link is a random token (`ids.next('rsvp')`, a UUID in production) that the planner or the couple makes for one
 * household and copies once: only its SHA-256 hash is stored, so the link cannot be shown again, and making a new one
 * turns the old one off. The record is kept under the hash (to resolve a link) and under the household (its current
 * link); a link resolves only while both agree, its household still exists and its wedding still exists.
 *
 * A resolved link is a {@link HouseholdRsvpGrant}: minted only here (a module-private WeakSet, like `TenantContext`),
 * carrying the tenant context, the wedding and the household. It is the household page's whole authority — there is
 * no Principal on that page — and the services that accept it (`WeddingEventService.answerAsHousehold`,
 * `GuestListService.setDietaryAsHousehold`) check it with {@link assertHouseholdGrant}. A token that is unknown,
 * replaced, or from another tenant resolves to nothing, and the page is the generic not-found.
 *
 * related: wedding_event_service.ts (the household's answers), guest_directory.ts (households), rsvp_link_schema.json.
 */

declare const HOUSEHOLD_GRANT_BRAND: unique symbol

/** The authority a resolved RSVP link carries: one household of one wedding, in one tenant. */
export interface HouseholdRsvpGrant {
  readonly context: TenantContext
  readonly wedding_id: string
  readonly household_id: string
  readonly [HOUSEHOLD_GRANT_BRAND]: true
}

const MINTED_GRANTS = new WeakSet<object>()

/** Refuse a grant this module did not mint (a hand-built object is a programming error, never a household). */
export function assertHouseholdGrant(grant: HouseholdRsvpGrant): void {
  if (!MINTED_GRANTS.has(grant)) {
    throw new ProductError('PRODUCT.FORGED_CONTEXT', 'An RSVP grant must come from a resolved RSVP link.', {})
  }
}

/** The longest token `resolve` looks up (minted tokens are about 41 characters). */
const MAX_TOKEN_LENGTH = 128

export class RsvpLinkService implements GuestListHooks {
  readonly #byHash: TenantScopedRepository<RsvpLink>
  readonly #byHousehold: TenantScopedRepository<RsvpLink>

  constructor(
    liveness: TenantLivenessCheck,
    private readonly weddings: WeddingRepository,
    private readonly authorizer: WeddingAuthorizer,
    private readonly guests: GuestDirectory,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
    store?: RecordStore,
    private readonly publicUrl?: string,
  ) {
    this.#byHash = new TenantScopedRepository<RsvpLink>(liveness, (l) => l.token_hash, COLLECTIONS.rsvpLink, store)
    this.#byHousehold = new TenantScopedRepository<RsvpLink>(liveness, (l) => groupedKey(l.wedding_id, l.household_id), COLLECTIONS.rsvpLinkByHousehold, store)
  }

  /**
   * Make the household's RSVP link, as the planner or the couple; an earlier link stops working. Returns the link once
   * (it is not stored), and when it was made.
   */
  issue(context: TenantContext, principal: Principal, wedding_id: string, household_id: string): { readonly url: string; readonly created_at: string } {
    assertWeddingReach(this.authorizer, this.weddings, context, principal, wedding_id)
    if (this.guests.household(context, wedding_id, household_id) === undefined) {
      throw new ProductError('PRODUCT.NOT_FOUND', 'No such household on this wedding.', {})
    }
    this.#forget(context, wedding_id, household_id)
    const token = this.ids.next('rsvp')
    const link: RsvpLink = { tenant_id: context.tenant_id, wedding_id, household_id, token_hash: sha256Hex(token), created_at: this.clock.now() }
    getSchemaRegistry().assertValid<RsvpLink>('rsvp_link', link)
    this.#byHash.put(context, link)
    this.#byHousehold.put(context, link)
    return { url: `${this.publicUrl ?? ''}/t/${context.slug}/rsvp/${encodeURIComponent(token)}`, created_at: link.created_at }
  }

  /** Which households of the wedding have a link, and since when (never the links themselves). */
  links(context: TenantContext, principal: Principal, wedding_id: string): { readonly household_id: string; readonly created_at: string }[] {
    assertWeddingReach(this.authorizer, this.weddings, context, principal, wedding_id)
    return this.#byHousehold
      .listGroup(context, wedding_id)
      .filter((l) => l.wedding_id === wedding_id)
      .map((l) => ({ household_id: l.household_id, created_at: l.created_at }))
  }

  /** The grant a token carries in this tenant, or undefined (unknown, replaced, or its household or wedding is gone). */
  resolve(context: TenantContext, token: string): HouseholdRsvpGrant | undefined {
    if (token.length === 0 || token.length > MAX_TOKEN_LENGTH) return undefined
    const token_hash = sha256Hex(token)
    const link = this.#byHash.read(context, token_hash)
    if (link === undefined) return undefined
    const current = this.#byHousehold.read(context, groupedKey(link.wedding_id, link.household_id))
    if (current?.token_hash !== token_hash) return undefined
    if (this.weddings.get(context, link.wedding_id) === undefined) return undefined
    if (this.guests.household(context, link.wedding_id, link.household_id) === undefined) return undefined
    const grant = Object.freeze({ context, wedding_id: link.wedding_id, household_id: link.household_id }) as HouseholdRsvpGrant
    MINTED_GRANTS.add(grant)
    return grant
  }

  /** The guest list's hook: a removed household's link stops working, and its records go. */
  householdsRemoved(context: TenantContext, wedding_id: string, household_ids: readonly string[]): void {
    for (const household_id of household_ids) this.#forget(context, wedding_id, household_id)
  }

  #forget(context: TenantContext, wedding_id: string, household_id: string): void {
    const current = this.#byHousehold.read(context, groupedKey(wedding_id, household_id))
    if (current === undefined) return
    this.#byHash.delete(context, current.token_hash)
    this.#byHousehold.delete(context, groupedKey(wedding_id, household_id))
  }
}
