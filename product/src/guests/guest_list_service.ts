import { type Clock, getSchemaRegistry, type Household, type IdGenerator, type WeddingGuest } from '@wedding-planner/shared'

import type { Principal } from '../auth/principal'
import type { WeddingAuthorizer } from '../auth/wedding_authorizer'
import { isEmailAddress } from '../email/email_port'
import { type ImportProblem, planGuestImport } from './guest_csv'
import { COLLECTIONS } from '../persistence/collections'
import { groupedKey, type RecordStore } from '../persistence/record_store'
import { ProductError } from '../product_error'
import type { TenantContext } from '../tenant/tenant_context'
import { TenantScopedRepository } from '../tenant/tenant_scoped_repository'
import type { TenantLivenessCheck } from '../tenant/tenant_store'
import type { WeddingRepository } from '../wedding/wedding_repository'

/**
 * @canonical guest_list_service -- a wedding's guest list: households and the people in them (issue #27, ADR 0046).
 *
 * Who may touch it is the WEDDING's boundary, reused unchanged: a planner reaches every wedding of the tenant, a
 * couple only its own (`WeddingAuthorizer.authorizeRead/Update`). A couple addressing another wedding — and anyone
 * addressing a wedding that does not exist — gets the same PRODUCT.NOT_FOUND (the masked 404): no existence oracle.
 * Both collections sit behind `TenantScopedRepository` (tenant isolation inherited). Records are keyed
 * `groupedKey(wedding_id, id)` and a wedding's list is read with `listGroup` (ADR 0039 addendum), so a request costs
 * one wedding, never the whole tenant; an id from a sibling wedding addresses no record ("not found"), and the
 * stored wedding_id is compared on every read as well.
 *
 * The plus-one model: a plus-one is a guest record whose `plus_one_of` names the guest who brings them — same
 * wedding, same household, at most one per guest, and only for a guest with `plus_one_allowed` (a plus-one never
 * has its own). So a plus-one counts, and later gets an RSVP, like anyone else. Removing a guest removes their
 * plus-one; removing a household removes its guests and their plus-ones; moving a host to another household moves
 * their plus-one with them.
 *
 * Contact details (email, phone, address) are personal data: they live only in these records, reach the wedding's
 * planner and couple only, and — like everything else — never a log line or an error entry (ADR 0044). Every record
 * is validated against its JSON Schema contract (`household`, `wedding_guest`) before it is written, and a wedding's
 * list is bounded ({@link GUEST_LIST_LIMITS}).
 *
 * related: wedding_authorizer.ts (the boundary), household_schema.json / wedding_guest_schema.json (the contracts).
 */

/** Bounds on one wedding's list. */
export const GUEST_LIST_LIMITS = Object.freeze({ households: 1000, guests: 2000 })

/** The most tags a guest carries. */
const MAX_TAGS = 20

export type GuestSide = WeddingGuest['side']

export interface GuestListCounts {
  readonly guests: number
  readonly households: number
  readonly plus_ones: number
  readonly by_side: Readonly<Record<GuestSide, number>>
}

export interface GuestListView {
  readonly households: readonly Household[]
  readonly guests: readonly WeddingGuest[]
  readonly counts: GuestListCounts
}

export interface HouseholdInput {
  readonly name: string
  readonly address?: string
}

/** The outcome of an import (issue #28): a plan summary, and whether it was applied. */
export interface GuestImportResult {
  readonly applied: boolean
  readonly problems: readonly ImportProblem[]
  readonly creates: number
  readonly updates: number
  readonly households_created: number
}

export interface GuestInput {
  readonly household_id?: string
  readonly first_name: string
  readonly last_name?: string
  readonly side: GuestSide
  readonly tags?: readonly string[]
  readonly plus_one_allowed?: boolean
  readonly dietary?: string
  readonly email?: string
  readonly phone?: string
  /** Create this guest as the plus-one of another guest (creation only). */
  readonly plus_one_of?: string
}

export class GuestListService {
  readonly #households: TenantScopedRepository<Household>
  readonly #guests: TenantScopedRepository<WeddingGuest>

  constructor(
    liveness: TenantLivenessCheck,
    private readonly weddings: WeddingRepository,
    private readonly authorizer: WeddingAuthorizer,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
    store?: RecordStore,
    private readonly limits: { readonly households: number; readonly guests: number } = GUEST_LIST_LIMITS,
  ) {
    this.#households = new TenantScopedRepository<Household>(liveness, (h) => groupedKey(h.wedding_id, h.household_id), COLLECTIONS.household, store)
    this.#guests = new TenantScopedRepository<WeddingGuest>(liveness, (g) => groupedKey(g.wedding_id, g.guest_id), COLLECTIONS.weddingGuest, store)
  }

  /**
   * The wedding's boundary, alone: PRODUCT.NOT_FOUND for a wedding this principal may not reach or that does not
   * exist. The HTTP edge calls it before parsing a body; every method below checks it again.
   */
  assertReach(context: TenantContext, principal: Principal, wedding_id: string): void {
    this.#reach(context, principal, wedding_id)
  }

  /** The wedding's households, guests and counts. */
  view(context: TenantContext, principal: Principal, wedding_id: string): GuestListView {
    this.#reach(context, principal, wedding_id)
    const households = this.#householdsOf(context, wedding_id)
    const guests = this.#guestsOf(context, wedding_id)
    const by_side: Record<GuestSide, number> = { partner_one: 0, partner_two: 0, both: 0 }
    for (const guest of guests) by_side[guest.side] += 1
    return {
      households,
      guests,
      counts: {
        guests: guests.length,
        households: households.length,
        plus_ones: guests.filter((g) => g.plus_one_of !== undefined).length,
        by_side,
      },
    }
  }

  addHousehold(context: TenantContext, principal: Principal, wedding_id: string, input: HouseholdInput): Household {
    this.#reach(context, principal, wedding_id)
    return this.#addHousehold(context, wedding_id, input, this.#householdsOf(context, wedding_id))
  }

  /** Add to `households` (the wedding's current households, kept current here). */
  #addHousehold(context: TenantContext, wedding_id: string, input: HouseholdInput, households: Household[]): Household {
    if (households.length >= this.limits.households) this.#limit()
    refuseControlCharacters(input.name, input.address)
    const household: Household = {
      household_id: this.ids.next('household'),
      tenant_id: context.tenant_id,
      wedding_id,
      name: input.name.trim(),
      ...optional('address', input.address),
      created_at: this.clock.now(),
    }
    getSchemaRegistry().assertValid<Household>('household', household)
    households.push(household)
    return this.#households.put(context, household)
  }

  updateHousehold(
    context: TenantContext,
    principal: Principal,
    wedding_id: string,
    household_id: string,
    input: HouseholdInput,
  ): Household {
    this.#reach(context, principal, wedding_id)
    return this.#updateHousehold(context, this.#household(context, wedding_id, household_id), input)
  }

  #updateHousehold(context: TenantContext, existing: Household, input: HouseholdInput): Household {
    refuseControlCharacters(input.name, input.address)
    const updated: Household = {
      household_id: existing.household_id,
      tenant_id: existing.tenant_id,
      wedding_id: existing.wedding_id,
      name: input.name.trim(),
      ...optional('address', input.address),
      created_at: existing.created_at,
    }
    getSchemaRegistry().assertValid<Household>('household', updated)
    return this.#households.put(context, updated)
  }

  /** Remove a household and every guest in it. Returns whether it existed. */
  removeHousehold(context: TenantContext, principal: Principal, wedding_id: string, household_id: string): boolean {
    this.#reach(context, principal, wedding_id)
    const household = this.#households.read(context, groupedKey(wedding_id, household_id))
    if (household === undefined || household.wedding_id !== wedding_id) return false
    const guests = this.#guestsOf(context, wedding_id)
    const leaving = new Set(guests.filter((g) => g.household_id === household_id).map((g) => g.guest_id))
    for (const guest of guests) {
      // The household's guests, and the plus-one of any of them (who is in the same household unless a stale
      // record says otherwise: never leave a plus-one whose host is gone).
      if (leaving.has(guest.guest_id) || (guest.plus_one_of !== undefined && leaving.has(guest.plus_one_of))) {
        this.#guests.delete(context, groupedKey(wedding_id, guest.guest_id))
      }
    }
    return this.#households.delete(context, groupedKey(wedding_id, household_id))
  }

  addGuest(context: TenantContext, principal: Principal, wedding_id: string, input: GuestInput): WeddingGuest {
    this.#reach(context, principal, wedding_id)
    return this.#addGuest(context, wedding_id, input, this.#guestsOf(context, wedding_id))
  }

  /** Add to `guests` (the wedding's current guests, kept current here). */
  #addGuest(context: TenantContext, wedding_id: string, input: GuestInput, guests: WeddingGuest[]): WeddingGuest {
    if (guests.length >= this.limits.guests) this.#limit()
    let household_id = input.household_id ?? ''
    if (input.plus_one_of !== undefined) {
      const host = guests.find((g) => g.guest_id === input.plus_one_of)
      if (host === undefined || !host.plus_one_allowed || host.plus_one_of !== undefined) {
        throw new ProductError('PRODUCT.BAD_REQUEST', 'That guest cannot bring a plus-one.', {})
      }
      if (guests.some((g) => g.plus_one_of === host.guest_id)) {
        throw new ProductError('PRODUCT.PLUS_ONE_EXISTS', 'That guest already has a plus-one.', {})
      }
      household_id = host.household_id // a plus-one is in their host's household
    }
    this.#household(context, wedding_id, household_id, 'PRODUCT.BAD_REQUEST')
    const guest: WeddingGuest = {
      guest_id: this.ids.next('wguest'),
      tenant_id: context.tenant_id,
      wedding_id,
      household_id,
      ...this.#fields(input, input.plus_one_of !== undefined),
      ...(input.plus_one_of === undefined ? {} : { plus_one_of: input.plus_one_of }),
      created_at: this.clock.now(),
    }
    getSchemaRegistry().assertValid<WeddingGuest>('wedding_guest', guest)
    guests.push(guest)
    return this.#guests.put(context, guest)
  }

  updateGuest(
    context: TenantContext,
    principal: Principal,
    wedding_id: string,
    guest_id: string,
    input: GuestInput,
  ): WeddingGuest {
    this.#reach(context, principal, wedding_id)
    return this.#updateGuest(context, wedding_id, guest_id, input, this.#guestsOf(context, wedding_id))
  }

  /** Update one of `guests` (the wedding's current guests, kept current here). */
  #updateGuest(context: TenantContext, wedding_id: string, guest_id: string, input: GuestInput, guests: WeddingGuest[]): WeddingGuest {
    const at = guests.findIndex((g) => g.guest_id === guest_id)
    const existing = guests[at]
    if (existing === undefined) throw new ProductError('PRODUCT.NOT_FOUND', 'No such guest on this wedding.', {})
    const isPlusOne = existing.plus_one_of !== undefined
    // A plus-one stays in their host's household; anyone else may move to another household of the wedding.
    const household_id = isPlusOne ? existing.household_id : (input.household_id ?? existing.household_id)
    if (!isPlusOne) this.#household(context, wedding_id, household_id, 'PRODUCT.BAD_REQUEST')
    const fields = this.#fields(input, isPlusOne)
    const plusOneAt = isPlusOne ? -1 : guests.findIndex((g) => g.plus_one_of === guest_id)
    const plusOne = guests[plusOneAt]
    if (!fields.plus_one_allowed && plusOne !== undefined) {
      throw new ProductError('PRODUCT.PLUS_ONE_EXISTS', 'Remove the plus-one before taking the allowance away.', {})
    }
    // A host who moves takes their plus-one along (same transaction): a plus-one is always in their host's household.
    if (plusOne !== undefined && plusOne.household_id !== household_id) {
      const moved = { ...plusOne, household_id, updated_at: this.clock.now() }
      guests[plusOneAt] = moved
      this.#guests.put(context, moved)
    }
    const updated: WeddingGuest = {
      guest_id: existing.guest_id,
      tenant_id: existing.tenant_id,
      wedding_id: existing.wedding_id,
      household_id,
      ...fields,
      ...(existing.plus_one_of === undefined ? {} : { plus_one_of: existing.plus_one_of }),
      created_at: existing.created_at,
      updated_at: this.clock.now(),
    }
    getSchemaRegistry().assertValid<WeddingGuest>('wedding_guest', updated)
    guests[at] = updated
    return this.#guests.put(context, updated)
  }

  /** Remove a guest and their plus-one. Returns whether the guest existed. */
  removeGuest(context: TenantContext, principal: Principal, wedding_id: string, guest_id: string): boolean {
    this.#reach(context, principal, wedding_id)
    const guest = this.#guests.read(context, groupedKey(wedding_id, guest_id))
    if (guest === undefined || guest.wedding_id !== wedding_id) return false
    for (const other of this.#guestsOf(context, wedding_id)) {
      if (other.plus_one_of === guest_id) this.#guests.delete(context, groupedKey(wedding_id, other.guest_id))
    }
    return this.#guests.delete(context, groupedKey(wedding_id, guest_id))
  }

  /**
   * Import a CSV (issue #28): plan it against the current list and — only when `commit` is true and the plan has no
   * problems — apply every row. The request is one store transaction, so a failure part-way applies nothing.
   */
  importGuests(context: TenantContext, principal: Principal, wedding_id: string, text: string, commit: boolean): GuestImportResult {
    const view = this.view(context, principal, wedding_id)
    const plan = planGuestImport(view, text, this.limits)
    const summary = { problems: plan.problems, creates: plan.creates, updates: plan.updates, households_created: plan.households_created }
    if (!commit || plan.problems.length > 0) return { applied: false, ...summary }
    // One read of the list; the private writers keep these working copies current (no re-listing per row).
    const householdList = [...view.households]
    const guestList = [...view.guests]
    const households = new Map(view.households.map((h) => [h.name.toLowerCase(), h]))
    // The guests this import creates, by the row that creates them (a new plus-one's host may be one of them).
    const createdByRow = new Map<number, string>()
    // Hosts and everyone else first, then plus-ones (whose hosts may be created by the same import).
    const ordered = [...plan.rows.filter((r) => r.plus_one_of === undefined), ...plan.rows.filter((r) => r.plus_one_of !== undefined)]
    for (const row of ordered) {
      let household = households.get(row.household.toLowerCase())
      if (household === undefined) {
        household = this.#addHousehold(context, wedding_id, { name: row.household, ...(row.address === undefined ? {} : { address: row.address }) }, householdList)
        households.set(row.household.toLowerCase(), household)
      } else if (row.address !== undefined && row.address !== household.address) {
        household = this.#updateHousehold(context, household, { name: household.name, address: row.address })
        households.set(row.household.toLowerCase(), household)
      }
      const input: GuestInput = {
        household_id: household.household_id,
        first_name: row.first_name,
        last_name: row.last_name,
        side: row.side,
        tags: row.tags,
        plus_one_allowed: row.plus_one_allowed,
        ...(row.dietary === undefined ? {} : { dietary: row.dietary }),
        ...(row.email === undefined ? {} : { email: row.email }),
        ...(row.phone === undefined ? {} : { phone: row.phone }),
      }
      if (row.guest_id !== undefined) {
        this.#updateGuest(context, wedding_id, row.guest_id, input, guestList)
      } else {
        // The host the plan resolved: never a fresh name lookup, so the preview and the import agree.
        const host = row.host_guest_id ?? (row.host_row === undefined ? undefined : createdByRow.get(row.host_row))
        const created = this.#addGuest(context, wedding_id, { ...input, ...(host === undefined ? {} : { plus_one_of: host }) }, guestList)
        createdByRow.set(row.row, created.guest_id)
      }
    }
    return { applied: true, ...summary }
  }

  /** The editable fields of a guest, normalized. A plus-one never has their own allowance. */
  #fields(input: GuestInput, isPlusOne: boolean) {
    refuseControlCharacters(input.first_name, input.last_name, input.dietary, input.email, input.phone, ...(input.tags ?? []))
    if (input.email !== undefined && input.email.trim().length > 0 && !isEmailAddress(input.email.trim())) {
      throw new ProductError('PRODUCT.BAD_REQUEST', 'That email address is not valid.', {})
    }
    const tags = [...new Set((input.tags ?? []).map((t) => t.trim().toLowerCase()).filter((t) => t.length > 0))]
    if (tags.length > MAX_TAGS) throw new ProductError('PRODUCT.BAD_REQUEST', `A guest has at most ${MAX_TAGS} tags.`, {})
    return {
      first_name: input.first_name.trim(),
      last_name: (input.last_name ?? '').trim(),
      side: input.side,
      tags,
      plus_one_allowed: isPlusOne ? false : (input.plus_one_allowed ?? false),
      ...optional('dietary', input.dietary),
      ...optional('email', input.email),
      ...optional('phone', input.phone),
    }
  }

  /** The wedding's boundary: a couple's other wedding, or a wedding that does not exist, is the masked not-found. */
  #reach(context: TenantContext, principal: Principal, wedding_id: string): void {
    if (this.authorizer.authorizeRead(principal, wedding_id) !== 'allow' || this.weddings.get(context, wedding_id) === undefined) {
      throw new ProductError('PRODUCT.NOT_FOUND', 'No such wedding.', {})
    }
  }

  #householdsOf(context: TenantContext, wedding_id: string): Household[] {
    return [...this.#households.listGroup(context, wedding_id)].filter((h) => h.wedding_id === wedding_id)
  }

  #guestsOf(context: TenantContext, wedding_id: string): WeddingGuest[] {
    return [...this.#guests.listGroup(context, wedding_id)].filter((g) => g.wedding_id === wedding_id)
  }

  #household(context: TenantContext, wedding_id: string, household_id: string, code = 'PRODUCT.NOT_FOUND'): Household {
    const household = household_id.length === 0 ? undefined : this.#households.read(context, groupedKey(wedding_id, household_id))
    if (household === undefined || household.wedding_id !== wedding_id) {
      throw new ProductError(code, 'No such household on this wedding.', {})
    }
    return household
  }

  #limit(): never {
    throw new ProductError('PRODUCT.LIMIT_REACHED', 'This wedding has reached the guest list limit.', {})
  }
}

/** Names, notes and numbers never hold a line break or another control character (PRODUCT.BAD_REQUEST). */
function refuseControlCharacters(...values: readonly (string | undefined)[]): void {
  for (const value of values) {
    if (value !== undefined && [...value].some((c) => c.charCodeAt(0) < 0x20 || c.charCodeAt(0) === 0x7f)) {
      throw new ProductError('PRODUCT.BAD_REQUEST', 'A name, note or number may not hold a line break or control character.', {})
    }
  }
}


/** `{ [key]: value }` for a non-empty trimmed value, else `{}` (an optional field is absent, never empty). */
function optional<K extends string>(key: K, value: string | undefined): { [P in K]?: string } {
  const trimmed = value?.trim()
  return (trimmed === undefined || trimmed.length === 0 ? {} : { [key]: trimmed }) as { [P in K]?: string }
}
