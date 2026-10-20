import { type Clock, getSchemaRegistry, type IdGenerator, type SeatAssignment, type SeatingTable, type WeddingEvent, type WeddingGuest } from '@wedding-planner/shared'

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
import { assertPlainText } from '../text/plain_text'
import type { WeddingEventService } from '../wedding_events/wedding_event_service'
import { assertWeddingReach } from '../wedding/wedding_reach'
import type { WeddingRepository } from '../wedding/wedding_repository'

/**
 * @canonical seating_service -- a wedding's seating plan (issue #46, ADR 0054): tables with a capacity, and where each
 * guest sits (one seat assignment per guest, keyed by the guest).
 *
 * The boundary is the wedding's (`assertWeddingReach`); the planner and the couple both manage seating (couples
 * usually do it). Seating is for one event: the view is built against that event's answers (#29), so it lists the
 * attending guests not yet seated, and the seated guests who are no longer attending. Without a choice the event is
 * the reception (by name), else the last event of the wedding.
 *
 * Capacity is a hard rule: a table never seats more than its capacity, seating a household seats all of its guests or
 * none, and a table cannot shrink below the guests it seats. A removed guest is unseated through the guest list's
 * hook (this service is a `GuestListHooks`); a removed table unseats its guests.
 *
 * related: seating_table_schema.json and seat_assignment_schema.json (the contracts), wedding_event_service.ts.
 */

/** Bounds on one wedding's seating plan. */
export const SEATING_LIMITS = Object.freeze({ tables: 100 })

export interface TableInput {
  readonly name: string
  readonly capacity: number
}

/** A guest as the seating plan shows them. */
export interface SeatedGuest {
  readonly guest_id: string
  readonly household_id: string
  readonly name: string
  readonly dietary?: string
  /** Attending the plan's event. */
  readonly attending: boolean
}

export interface SeatingView {
  /** The event the plan is for, when the wedding has events. */
  readonly event?: { readonly event_id: string; readonly name: string }
  readonly events: readonly { readonly event_id: string; readonly name: string }[]
  /** Each table with its guests, alphabetically. */
  readonly tables: readonly { readonly table: SeatingTable; readonly guests: readonly SeatedGuest[]; readonly free: number }[]
  /** Attending (or, without events, every guest) and not seated, alphabetically. */
  readonly unseated: readonly SeatedGuest[]
  /** Seated, but no longer attending the plan's event. */
  readonly seated_not_attending: readonly SeatedGuest[]
  /** The households with someone unseated, for "seat the household". */
  readonly households: readonly { readonly household_id: string; readonly name: string }[]
}

export class SeatingService implements GuestListHooks {
  readonly #tables: TenantScopedRepository<SeatingTable>
  readonly #seats: TenantScopedRepository<SeatAssignment>

  constructor(
    liveness: TenantLivenessCheck,
    private readonly weddings: WeddingRepository,
    private readonly authorizer: WeddingAuthorizer,
    private readonly guests: GuestDirectory,
    private readonly events: Pick<WeddingEventService, 'eventsOf' | 'statusesFor'>,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
    store?: RecordStore,
    private readonly limits: { readonly tables: number } = SEATING_LIMITS,
  ) {
    this.#tables = new TenantScopedRepository<SeatingTable>(liveness, (t) => groupedKey(t.wedding_id, t.table_id), COLLECTIONS.seatingTable, store)
    this.#seats = new TenantScopedRepository<SeatAssignment>(liveness, (s) => groupedKey(s.wedding_id, s.guest_id), COLLECTIONS.seatAssignment, store)
  }

  /** The wedding's boundary alone (the HTTP edge calls it before parsing a body). */
  assertReach(context: TenantContext, principal: Principal, wedding_id: string): void {
    assertWeddingReach(this.authorizer, this.weddings, context, principal, wedding_id)
  }

  /** The plan for one event (`event_id`, or the default: the reception, else the last event). */
  view(context: TenantContext, principal: Principal, wedding_id: string, event_id?: string): SeatingView {
    this.assertReach(context, principal, wedding_id)
    const events = this.events.eventsOf(context, wedding_id)
    const event = pickEvent(events, event_id)
    const statuses = event === undefined ? undefined : this.events.statusesFor(context, wedding_id, event.event_id)
    const guests = this.guests.guestsOf(context, wedding_id)
    const households = new Map(this.guests.householdsOf(context, wedding_id).map((h) => [h.household_id, h.name]))
    const seats = new Map(this.#seatsOf(context, wedding_id).map((s) => [s.guest_id, s.table_id]))
    const shown = (g: WeddingGuest): SeatedGuest => ({
      guest_id: g.guest_id,
      household_id: g.household_id,
      name: `${g.first_name} ${g.last_name}`.trim(),
      ...(g.dietary === undefined ? {} : { dietary: g.dietary }),
      attending: statuses === undefined ? true : statuses.get(g.guest_id)?.status === 'attending',
    })
    const all = guests.map(shown).sort((a, b) => a.name.localeCompare(b.name))
    const tables = this.#tablesOf(context, wedding_id).map((table) => {
      const seated = all.filter((g) => seats.get(g.guest_id) === table.table_id)
      return { table, guests: seated, free: table.capacity - seated.length }
    })
    const unseated = all.filter((g) => g.attending && !seats.has(g.guest_id))
    return {
      ...(event === undefined ? {} : { event: { event_id: event.event_id, name: event.name } }),
      events: events.map((e) => ({ event_id: e.event_id, name: e.name })),
      tables,
      unseated,
      seated_not_attending: all.filter((g) => !g.attending && seats.has(g.guest_id)),
      households: [...new Set(unseated.map((g) => g.household_id))].map((household_id) => ({ household_id, name: households.get(household_id) ?? '' })),
    }
  }

  addTable(context: TenantContext, principal: Principal, wedding_id: string, input: TableInput): SeatingTable {
    this.assertReach(context, principal, wedding_id)
    if (this.#tablesOf(context, wedding_id).length >= this.limits.tables) {
      throw new ProductError('PRODUCT.LIMIT_REACHED', 'This wedding has reached the table limit.', {})
    }
    return this.#putTable(context, { table_id: this.ids.next('table'), tenant_id: context.tenant_id, wedding_id, ...tableFields(input), created_at: this.clock.now() })
  }

  /** Rename a table or change its capacity — never below the guests it seats (PRODUCT.SEATING_FULL). */
  updateTable(context: TenantContext, principal: Principal, wedding_id: string, table_id: string, input: TableInput): SeatingTable {
    this.assertReach(context, principal, wedding_id)
    const existing = this.#table(context, wedding_id, table_id)
    const fields = tableFields(input)
    const seated = this.#seatsOf(context, wedding_id).filter((s) => s.table_id === table_id).length
    if (fields.capacity < seated) throw new ProductError('PRODUCT.SEATING_FULL', 'That table seats more guests than that.', {})
    return this.#putTable(context, { ...existing, ...fields, updated_at: this.clock.now() })
  }

  /** Remove a table; its guests become unseated. Returns whether it existed. */
  removeTable(context: TenantContext, principal: Principal, wedding_id: string, table_id: string): boolean {
    this.assertReach(context, principal, wedding_id)
    if (table_id.length === 0 || this.#tables.read(context, groupedKey(wedding_id, table_id))?.wedding_id !== wedding_id) return false
    for (const seat of this.#seatsOf(context, wedding_id)) {
      if (seat.table_id === table_id) this.#seats.delete(context, groupedKey(wedding_id, seat.guest_id))
    }
    return this.#tables.delete(context, groupedKey(wedding_id, table_id))
  }

  /** Seat a guest at a table (moving them if seated elsewhere), or unseat them (`table_id` undefined). */
  seatGuest(context: TenantContext, principal: Principal, wedding_id: string, guest_id: string, table_id: string | undefined): void {
    this.assertReach(context, principal, wedding_id)
    if (this.guests.guest(context, wedding_id, guest_id) === undefined) throw new ProductError('PRODUCT.NOT_FOUND', 'No such guest on this wedding.', {})
    if (table_id === undefined) {
      this.#seats.delete(context, groupedKey(wedding_id, guest_id))
      return
    }
    this.#seatAll(context, wedding_id, [guest_id], table_id)
  }

  /** Seat every guest of a household at a table: all of them or none (capacity). */
  seatHousehold(context: TenantContext, principal: Principal, wedding_id: string, household_id: string, table_id: string): number {
    this.assertReach(context, principal, wedding_id)
    if (this.guests.household(context, wedding_id, household_id) === undefined) throw new ProductError('PRODUCT.NOT_FOUND', 'No such household on this wedding.', {})
    const members = this.guests.guestsOf(context, wedding_id).filter((g) => g.household_id === household_id).map((g) => g.guest_id)
    this.#seatAll(context, wedding_id, members, table_id)
    return members.length
  }

  /** The guest list's hook: removed guests lose their seats (same request, same transaction). */
  guestsRemoved(context: TenantContext, wedding_id: string, guest_ids: readonly string[]): void {
    for (const guest_id of guest_ids) this.#seats.delete(context, groupedKey(wedding_id, guest_id))
  }

  /** Seat these guests at one table if it has room for those not already there; otherwise refuse and seat none. */
  #seatAll(context: TenantContext, wedding_id: string, guest_ids: readonly string[], table_id: string): void {
    const table = this.#table(context, wedding_id, table_id)
    const seats = this.#seatsOf(context, wedding_id)
    const already = new Set(seats.filter((s) => s.table_id === table_id).map((s) => s.guest_id))
    const arriving = guest_ids.filter((g) => !already.has(g))
    if (already.size + arriving.length > table.capacity) {
      throw new ProductError('PRODUCT.SEATING_FULL', 'That table does not have room for them.', {})
    }
    for (const guest_id of arriving) {
      const seat: SeatAssignment = { tenant_id: context.tenant_id, wedding_id, guest_id, table_id, seated_at: this.clock.now() }
      getSchemaRegistry().assertValid<SeatAssignment>('seat_assignment', seat)
      this.#seats.put(context, seat)
    }
  }

  #tablesOf(context: TenantContext, wedding_id: string): SeatingTable[] {
    return this.#tables.listGroup(context, wedding_id).filter((t) => t.wedding_id === wedding_id)
  }

  #seatsOf(context: TenantContext, wedding_id: string): SeatAssignment[] {
    return this.#seats.listGroup(context, wedding_id).filter((s) => s.wedding_id === wedding_id)
  }

  #table(context: TenantContext, wedding_id: string, table_id: string): SeatingTable {
    const table = table_id.length === 0 ? undefined : this.#tables.read(context, groupedKey(wedding_id, table_id))
    if (table === undefined || table.wedding_id !== wedding_id) throw new ProductError('PRODUCT.NOT_FOUND', 'No such table on this wedding.', {})
    return table
  }

  #putTable(context: TenantContext, table: SeatingTable): SeatingTable {
    getSchemaRegistry().assertValid<SeatingTable>('seating_table', table)
    return this.#tables.put(context, table)
  }
}

function tableFields(input: TableInput): Pick<SeatingTable, 'name' | 'capacity'> {
  assertPlainText([input.name])
  if (!Number.isInteger(input.capacity) || input.capacity < 1 || input.capacity > 50) {
    throw new ProductError('PRODUCT.BAD_REQUEST', 'A table seats from 1 to 50 guests.', {})
  }
  return { name: input.name.trim(), capacity: input.capacity }
}

/** The event a plan is for: the one asked for, else the reception (by name), else the last event. */
function pickEvent(events: readonly WeddingEvent[], event_id: string | undefined): WeddingEvent | undefined {
  if (event_id !== undefined) {
    const chosen = events.find((e) => e.event_id === event_id)
    if (chosen !== undefined) return chosen
  }
  return events.find((e) => /reception/i.test(e.name)) ?? events[events.length - 1]
}
