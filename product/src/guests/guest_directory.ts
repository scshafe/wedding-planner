import type { Household, WeddingGuest } from '@wedding-planner/shared'

import { COLLECTIONS } from '../persistence/collections'
import { groupedKey, type RecordStore } from '../persistence/record_store'
import type { TenantContext } from '../tenant/tenant_context'
import { TenantScopedRepository } from '../tenant/tenant_scoped_repository'
import type { TenantLivenessCheck } from '../tenant/tenant_store'

/**
 * @canonical guest_directory -- READ access to one wedding's households and guests (issues #27, #29): one wedding at a
 * time (`listGroup`), or one record by a point read under `groupedKey(wedding_id, id)`. Records whose stored
 * wedding_id differs are treated as absent.
 *
 * It checks no boundary: its callers are services that have already established who may reach the wedding — the
 * guest list and the wedding events through `assertWeddingReach`, and (issue #30) the household RSVP page through
 * a resolved RSVP link. It is never handed to a route. Writes stay in `GuestListService`, which owns the list's rules.
 *
 * related: guest_list_service.ts (the writes and their rules), wedding_event_service.ts (reads guests through this).
 */
export class GuestDirectory {
  readonly #households: TenantScopedRepository<Household>
  readonly #guests: TenantScopedRepository<WeddingGuest>

  constructor(liveness: TenantLivenessCheck, store?: RecordStore) {
    this.#households = new TenantScopedRepository<Household>(liveness, (h) => groupedKey(h.wedding_id, h.household_id), COLLECTIONS.household, store)
    this.#guests = new TenantScopedRepository<WeddingGuest>(liveness, (g) => groupedKey(g.wedding_id, g.guest_id), COLLECTIONS.weddingGuest, store)
  }

  householdsOf(context: TenantContext, wedding_id: string): Household[] {
    return this.#households.listGroup(context, wedding_id).filter((h) => h.wedding_id === wedding_id)
  }

  guestsOf(context: TenantContext, wedding_id: string): WeddingGuest[] {
    return this.#guests.listGroup(context, wedding_id).filter((g) => g.wedding_id === wedding_id)
  }

  household(context: TenantContext, wedding_id: string, household_id: string): Household | undefined {
    const household = household_id.length === 0 ? undefined : this.#households.read(context, groupedKey(wedding_id, household_id))
    return household?.wedding_id === wedding_id ? household : undefined
  }

  guest(context: TenantContext, wedding_id: string, guest_id: string): WeddingGuest | undefined {
    const guest = guest_id.length === 0 ? undefined : this.#guests.read(context, groupedKey(wedding_id, guest_id))
    return guest?.wedding_id === wedding_id ? guest : undefined
  }
}
