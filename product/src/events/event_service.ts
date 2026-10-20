import { type Clock, getSchemaRegistry, type IdGenerator, type WeddingEvent, type WeddingGuest, type WeddingRsvp } from '@wedding-planner/shared'

import type { Principal } from '../auth/principal'
import type { WeddingAuthorizer } from '../auth/wedding_authorizer'
import type { GuestListService } from '../guests/guest_list_service'
import { COLLECTIONS } from '../persistence/collections'
import { groupedKey, type RecordStore } from '../persistence/record_store'
import { ProductError } from '../product_error'
import type { TenantContext } from '../tenant/tenant_context'
import { TenantScopedRepository } from '../tenant/tenant_scoped_repository'
import type { TenantLivenessCheck } from '../tenant/tenant_store'
import { assertWeddingReach } from '../wedding/wedding_reach'
import type { WeddingRepository } from '../wedding/wedding_repository'

/**
 * @canonical event_service -- a wedding's events and the guests' RSVPs per event (issue #29, ADR 0048).
 *
 * The boundary is the wedding's (`assertWeddingReach`, the guest list's own): the planner and the wedding's couple
 * manage events and record answers; anything else is the masked PRODUCT.NOT_FOUND.
 *
 * An RSVP is one guest's answer for one event, stored under `groupedKey(wedding_id, `${event_id}:${guest_id}`)`.
 * NO RECORD IS THE DEFAULT — invited, pending — so a new guest or a new event needs no writes, and the counts
 * iterate the wedding's guests (never the stored records), so a record whose guest is gone can never count. Records
 * still go with their guest (the guest list's `guestsRemoved` hook, in the same transaction) and with their event.
 *
 * A meal choice is one of the event's options, only while attending. Options keep their ids across label edits, so a
 * renamed meal keeps its choices; a removed option clears the choices that named it.
 *
 * related: guest_list_service.ts (the guests, and the removal hook), wedding_event_schema.json and
 * wedding_rsvp_schema.json (the contracts), wedding_reach.ts (the boundary).
 */

/** Bounds on one wedding's events. */
export const EVENT_LIMITS = Object.freeze({ events: 12, meal_options: 8 })

export type RsvpStatus = WeddingRsvp['status']
export type RsvpAnsweredBy = WeddingRsvp['answered_by']

export interface EventInput {
  readonly name: string
  /** Local `YYYY-MM-DDTHH:MM`. */
  readonly starts_at: string
  readonly location?: string
  /** Meal labels, in order; empty or absent for no meal choice. */
  readonly meal_options?: readonly string[]
}

export interface RsvpInput {
  readonly invited: boolean
  readonly status: RsvpStatus
  readonly meal_option_id?: string
}

/** Live counts for one event, over the guests invited to it. */
export interface EventCounts {
  readonly event_id: string
  readonly invited: number
  readonly attending: number
  readonly declined: number
  readonly pending: number
  /** Attending guests by meal option id (every option present, possibly 0). */
  readonly meals: Readonly<Record<string, number>>
  /** Attending guests who have not chosen a meal, at an event with meal options. */
  readonly meal_unchosen: number
}

export interface EventsView {
  /** By start time, then name. */
  readonly events: readonly WeddingEvent[]
  readonly counts: readonly EventCounts[]
}

/** One guest's effective answer for one event (the default when nothing was recorded). */
export interface GuestEventRsvp {
  readonly event: WeddingEvent
  readonly invited: boolean
  readonly status: RsvpStatus
  readonly meal_option_id?: string
  readonly answered_by?: RsvpAnsweredBy
  readonly updated_at?: string
}

export class EventService {
  readonly #events: TenantScopedRepository<WeddingEvent>
  readonly #rsvps: TenantScopedRepository<WeddingRsvp>

  constructor(
    liveness: TenantLivenessCheck,
    private readonly weddings: WeddingRepository,
    private readonly authorizer: WeddingAuthorizer,
    private readonly guestList: Pick<GuestListService, 'view'>,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
    store?: RecordStore,
    private readonly limits: { readonly events: number; readonly meal_options: number } = EVENT_LIMITS,
  ) {
    this.#events = new TenantScopedRepository<WeddingEvent>(liveness, (e) => groupedKey(e.wedding_id, e.event_id), COLLECTIONS.weddingEvent, store)
    this.#rsvps = new TenantScopedRepository<WeddingRsvp>(liveness, (r) => rsvpKey(r.wedding_id, r.event_id, r.guest_id), COLLECTIONS.weddingRsvp, store)
  }

  /** The wedding's boundary alone (the HTTP edge calls it before parsing a body). */
  assertReach(context: TenantContext, principal: Principal, wedding_id: string): void {
    assertWeddingReach(this.authorizer, this.weddings, context, principal, wedding_id)
  }

  /** The wedding's events and their live counts. */
  view(context: TenantContext, principal: Principal, wedding_id: string): EventsView {
    this.assertReach(context, principal, wedding_id)
    const events = this.#eventsOf(context, wedding_id)
    const guests = this.guestList.view(context, principal, wedding_id).guests
    const rsvps = new Map(this.#rsvps.listGroup(context, wedding_id).map((r) => [`${r.event_id}:${r.guest_id}`, r]))
    return { events, counts: events.map((event) => countsFor(event, guests, rsvps)) }
  }

  addEvent(context: TenantContext, principal: Principal, wedding_id: string, input: EventInput): WeddingEvent {
    this.assertReach(context, principal, wedding_id)
    if (this.#eventsOf(context, wedding_id).length >= this.limits.events) {
      throw new ProductError('PRODUCT.LIMIT_REACHED', 'This wedding has reached the event limit.', {})
    }
    const event: WeddingEvent = {
      event_id: this.ids.next('event'),
      tenant_id: context.tenant_id,
      wedding_id,
      ...this.#fields(input, []),
      created_at: this.clock.now(),
    }
    getSchemaRegistry().assertValid<WeddingEvent>('wedding_event', event)
    return this.#events.put(context, event)
  }

  /** Edit an event. A meal option keeps its id when its label stays (case-insensitively); a dropped one clears its choices. */
  updateEvent(context: TenantContext, principal: Principal, wedding_id: string, event_id: string, input: EventInput): WeddingEvent {
    this.assertReach(context, principal, wedding_id)
    const existing = this.#event(context, wedding_id, event_id)
    const updated: WeddingEvent = {
      event_id: existing.event_id,
      tenant_id: existing.tenant_id,
      wedding_id: existing.wedding_id,
      ...this.#fields(input, existing.meal_options),
      created_at: existing.created_at,
      updated_at: this.clock.now(),
    }
    getSchemaRegistry().assertValid<WeddingEvent>('wedding_event', updated)
    const kept = new Set(updated.meal_options.map((o) => o.option_id))
    for (const rsvp of this.#rsvps.listGroup(context, wedding_id)) {
      if (rsvp.event_id === event_id && rsvp.meal_option_id !== undefined && !kept.has(rsvp.meal_option_id)) {
        this.#rsvps.put(context, {
          tenant_id: rsvp.tenant_id,
          wedding_id: rsvp.wedding_id,
          event_id: rsvp.event_id,
          guest_id: rsvp.guest_id,
          invited: rsvp.invited,
          status: rsvp.status,
          answered_by: rsvp.answered_by,
          updated_at: this.clock.now(),
        })
      }
    }
    return this.#events.put(context, updated)
  }

  /** Remove an event and every answer for it. Returns whether it existed. */
  removeEvent(context: TenantContext, principal: Principal, wedding_id: string, event_id: string): boolean {
    this.assertReach(context, principal, wedding_id)
    const event = this.#events.read(context, groupedKey(wedding_id, event_id))
    if (event === undefined || event.wedding_id !== wedding_id) return false
    for (const rsvp of this.#rsvps.listGroup(context, wedding_id)) {
      if (rsvp.event_id === event_id) this.#rsvps.delete(context, rsvpKey(wedding_id, rsvp.event_id, rsvp.guest_id))
    }
    return this.#events.delete(context, groupedKey(wedding_id, event_id))
  }

  /** One guest's answers, one per event of the wedding (by start time), defaults included. */
  guestRsvps(context: TenantContext, principal: Principal, wedding_id: string, guest_id: string): GuestEventRsvp[] {
    this.assertReach(context, principal, wedding_id)
    this.#guest(context, principal, wedding_id, guest_id)
    return this.#eventsOf(context, wedding_id).map((event) => {
      const rsvp = this.#rsvps.read(context, rsvpKey(wedding_id, event.event_id, guest_id))
      return rsvp === undefined || rsvp.wedding_id !== wedding_id
        ? { event, invited: true, status: 'pending' }
        : {
            event,
            invited: rsvp.invited,
            status: rsvp.status,
            ...(rsvp.meal_option_id === undefined ? {} : { meal_option_id: rsvp.meal_option_id }),
            answered_by: rsvp.answered_by,
            updated_at: rsvp.updated_at,
          }
    })
  }

  /**
   * Record one guest's answer for one event, as the planner or the couple. A guest not invited has no answer
   * (pending, no meal); a meal choice must be one of the event's options and only goes with attending.
   */
  setRsvp(context: TenantContext, principal: Principal, wedding_id: string, event_id: string, guest_id: string, input: RsvpInput): WeddingRsvp {
    this.assertReach(context, principal, wedding_id)
    const event = this.#event(context, wedding_id, event_id)
    this.#guest(context, principal, wedding_id, guest_id)
    const attending = input.invited && input.status === 'attending'
    if (input.meal_option_id !== undefined && (!attending || !event.meal_options.some((o) => o.option_id === input.meal_option_id))) {
      throw new ProductError('PRODUCT.BAD_REQUEST', 'A meal choice must be one of the event\'s meals, for a guest who is attending.', {})
    }
    const rsvp: WeddingRsvp = {
      tenant_id: context.tenant_id,
      wedding_id,
      event_id,
      guest_id,
      invited: input.invited,
      status: input.invited ? input.status : 'pending',
      ...(attending && input.meal_option_id !== undefined ? { meal_option_id: input.meal_option_id } : {}),
      answered_by: principal.role,
      updated_at: this.clock.now(),
    }
    getSchemaRegistry().assertValid<WeddingRsvp>('wedding_rsvp', rsvp)
    return this.#rsvps.put(context, rsvp)
  }

  /**
   * Forget every answer of these guests (they were removed from the list). Called by the guest list's
   * `guestsRemoved` hook, inside its own reach-checked removal and transaction; never from a route.
   */
  forgetGuests(context: TenantContext, wedding_id: string, guest_ids: readonly string[]): void {
    for (const event of this.#events.listGroup(context, wedding_id)) {
      for (const guest_id of guest_ids) this.#rsvps.delete(context, rsvpKey(wedding_id, event.event_id, guest_id))
    }
  }

  /** The editable fields, normalized; meal options reuse `previous` ids by label. */
  #fields(input: EventInput, previous: WeddingEvent['meal_options']) {
    const name = input.name.trim()
    if (!isLocalDateTime(input.starts_at)) {
      throw new ProductError('PRODUCT.BAD_REQUEST', 'starts_at must be a date and time (YYYY-MM-DDTHH:MM).', {})
    }
    const labels: string[] = []
    for (const raw of input.meal_options ?? []) {
      const label = raw.trim()
      if (label.length > 0 && !labels.some((l) => l.toLowerCase() === label.toLowerCase())) labels.push(label)
    }
    if (labels.length > this.limits.meal_options) {
      throw new ProductError('PRODUCT.BAD_REQUEST', `An event has at most ${this.limits.meal_options} meal options.`, {})
    }
    const meal_options = labels.map((label) => ({
      option_id: previous.find((o) => o.label.toLowerCase() === label.toLowerCase())?.option_id ?? this.ids.next('meal'),
      label,
    }))
    const location = input.location?.trim()
    return { name, starts_at: input.starts_at, ...(location === undefined || location.length === 0 ? {} : { location }), meal_options }
  }

  #eventsOf(context: TenantContext, wedding_id: string): WeddingEvent[] {
    return this.#events
      .listGroup(context, wedding_id)
      .filter((e) => e.wedding_id === wedding_id)
      .sort((a, b) => (a.starts_at === b.starts_at ? a.name.localeCompare(b.name) : a.starts_at < b.starts_at ? -1 : 1))
  }

  #event(context: TenantContext, wedding_id: string, event_id: string): WeddingEvent {
    const event = event_id.length === 0 ? undefined : this.#events.read(context, groupedKey(wedding_id, event_id))
    if (event === undefined || event.wedding_id !== wedding_id) throw new ProductError('PRODUCT.NOT_FOUND', 'No such event on this wedding.', {})
    return event
  }

  #guest(context: TenantContext, principal: Principal, wedding_id: string, guest_id: string): WeddingGuest {
    const guest = this.guestList.view(context, principal, wedding_id).guests.find((g) => g.guest_id === guest_id)
    if (guest === undefined) throw new ProductError('PRODUCT.NOT_FOUND', 'No such guest on this wedding.', {})
    return guest
  }
}

/** An RSVP's key: one per (event, guest), grouped by wedding. */
function rsvpKey(wedding_id: string, event_id: string, guest_id: string): string {
  return groupedKey(wedding_id, `${event_id}:${guest_id}`)
}

/** Whether `value` is a real local date and time, `YYYY-MM-DDTHH:MM`. */
export function isLocalDateTime(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) return false
  const parsed = new Date(`${value}:00.000Z`)
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 16) === value
}

function countsFor(event: WeddingEvent, guests: readonly WeddingGuest[], rsvps: ReadonlyMap<string, WeddingRsvp>): EventCounts {
  const meals: Record<string, number> = Object.fromEntries(event.meal_options.map((o) => [o.option_id, 0]))
  let invited = 0
  let attending = 0
  let declined = 0
  let meal_unchosen = 0
  for (const guest of guests) {
    const rsvp = rsvps.get(`${event.event_id}:${guest.guest_id}`)
    if (rsvp?.invited === false) continue
    invited += 1
    if (rsvp?.status === 'declined') declined += 1
    if (rsvp?.status !== 'attending') continue
    attending += 1
    const choice = rsvp.meal_option_id
    if (choice !== undefined && Object.hasOwn(meals, choice)) meals[choice] = (meals[choice] ?? 0) + 1
    else if (event.meal_options.length > 0) meal_unchosen += 1
  }
  return { event_id: event.event_id, invited, attending, declined, pending: invited - attending - declined, meals, meal_unchosen }
}
