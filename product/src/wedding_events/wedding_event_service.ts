import {
  type Clock,
  getSchemaRegistry,
  type IdGenerator,
  type WeddingEvent,
  type WeddingGuest,
  type WeddingRsvp,
  type WeddingRsvpSettings,
} from '@wedding-planner/shared'

import type { Principal } from '../auth/principal'
import type { WeddingAuthorizer } from '../auth/wedding_authorizer'
import type { GuestDirectory } from '../guests/guest_directory'
import type { GuestListHooks } from '../guests/guest_list_service'
import { COLLECTIONS } from '../persistence/collections'
import { groupedKey, type RecordStore } from '../persistence/record_store'
import { ProductError } from '../product_error'
import { assertHouseholdGrant, type HouseholdRsvpGrant } from '../rsvp/rsvp_link_service'
import type { TenantContext } from '../tenant/tenant_context'
import { TenantScopedRepository } from '../tenant/tenant_scoped_repository'
import type { TenantLivenessCheck } from '../tenant/tenant_store'
import { assertWeddingReach } from '../wedding/wedding_reach'
import type { WeddingRepository } from '../wedding/wedding_repository'

/**
 * @canonical wedding_event_service -- a wedding's events and the guests' RSVPs per event (issue #29, ADR 0048).
 *
 * The boundary is the wedding's (`assertWeddingReach`, the guest list's own): the planner and the wedding's couple
 * manage events and record answers; anything else is the masked PRODUCT.NOT_FOUND. Guests are read through the
 * `GuestDirectory` (one wedding, or one guest by a point read), never through the guest list's principal-bound view.
 *
 * An RSVP is one guest's answer for one event, stored under `groupedKey(wedding_id, rsvpId(event_id, guest_id))`.
 * NO RECORD IS THE DEFAULT: the event's `invitation` (`everyone`, or `selected` for an invite-only event; a plus-one
 * without a record follows their host), and pending. So a new guest or a new event needs no writes, and the counts
 * iterate the wedding's guests (never the stored records), so a record whose guest is gone can never count. Records
 * still go with their guest (this service is the guest list's `GuestListHooks`, in the same transaction) and with
 * their event.
 *
 * A meal choice is one of the event's options, and only an attending guest has one (it is dropped otherwise). An
 * option keeps its id when an edit names that id (a rename in place) or repeats its label; a removed option clears
 * the choices that named it, recorded as the editor's change.
 *
 * related: guest_directory.ts (the guests), guest_list_service.ts (the removal hook), wedding_event_schema.json and
 * wedding_rsvp_schema.json (the contracts), wedding_reach.ts (the boundary).
 */

/** Bounds on one wedding's events; `meal_inputs` caps the raw list an edit may send, before any per-item work. */
export const WEDDING_EVENT_LIMITS = Object.freeze({ events: 12, meal_options: 8, meal_inputs: 32 })

export type RsvpStatus = WeddingRsvp['status']
export type RsvpAnsweredBy = WeddingRsvp['answered_by']
export type EventInvitation = WeddingEvent['invitation']

/** A meal option in an edit: an existing `option_id` renames that option; without one it is new (or matches by label). */
export interface MealOptionInput {
  readonly option_id?: string
  readonly label: string
}

export interface WeddingEventInput {
  readonly name: string
  /** Local `YYYY-MM-DDTHH:MM`. */
  readonly starts_at: string
  readonly location?: string
  /** Default `everyone` on a new event; unchanged on an edit when absent. */
  readonly invitation?: EventInvitation
  /** The options in order; an option left out is removed. Absent or empty: no meal choice. */
  readonly meal_options?: readonly MealOptionInput[]
}

/** What the planner or the couple records for one guest at one event: the invitation and the answer. */
export interface RsvpInput {
  readonly invited: boolean
  readonly status: RsvpStatus
  readonly meal_option_id?: string
}

/** Live counts for one event, over the guests invited to it. */
export interface WeddingEventCounts {
  readonly invited: number
  readonly attending: number
  readonly declined: number
  readonly pending: number
  /** Attending guests by meal option id (every option present, possibly 0). */
  readonly meals: Readonly<Record<string, number>>
  /** Attending guests who have not chosen a meal, at an event with meal options. */
  readonly meal_unchosen: number
}

export interface WeddingEventsView {
  /** By start time, then name; each with its counts. */
  readonly events: readonly { readonly event: WeddingEvent; readonly counts: WeddingEventCounts }[]
  /** Whether households may no longer answer on their RSVP page (issue #30). */
  readonly rsvps_closed: boolean
}

/** The bounds of one household submission (raw lists, checked before any per-item work). */
export const HOUSEHOLD_ANSWER_LIMITS = Object.freeze({ answers: 240 })

/** One answer a household gives on its RSVP page: attending or declined, with a meal when attending. */
export interface HouseholdAnswer {
  readonly guest_id: string
  readonly event_id: string
  readonly status: 'attending' | 'declined'
  readonly meal_option_id?: string
}

/**
 * What the household RSVP page shows (issue #30): the household's own guests, and only the events at least one of
 * them is invited to — names, times, places and meals, nothing else about the wedding.
 */
export interface HouseholdRsvpView {
  readonly household_name: string
  readonly guests: readonly { readonly guest_id: string; readonly first_name: string; readonly last_name: string; readonly dietary?: string }[]
  readonly events: readonly {
    readonly event_id: string
    readonly name: string
    readonly starts_at: string
    readonly location?: string
    readonly meal_options: WeddingEvent['meal_options']
    /** One per invited guest of the household. */
    readonly answers: readonly { readonly guest_id: string; readonly status: RsvpStatus; readonly meal_option_id?: string }[]
  }[]
  readonly closed: boolean
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

export class WeddingEventService implements GuestListHooks {
  readonly #events: TenantScopedRepository<WeddingEvent>
  readonly #rsvps: TenantScopedRepository<WeddingRsvp>
  readonly #settings: TenantScopedRepository<WeddingRsvpSettings>

  constructor(
    liveness: TenantLivenessCheck,
    private readonly weddings: WeddingRepository,
    private readonly authorizer: WeddingAuthorizer,
    private readonly guests: GuestDirectory,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
    store?: RecordStore,
    private readonly limits: { readonly events: number; readonly meal_options: number; readonly meal_inputs: number } = WEDDING_EVENT_LIMITS,
  ) {
    this.#events = new TenantScopedRepository<WeddingEvent>(liveness, (e) => groupedKey(e.wedding_id, e.event_id), COLLECTIONS.weddingEvent, store)
    this.#rsvps = new TenantScopedRepository<WeddingRsvp>(liveness, (r) => groupedKey(r.wedding_id, rsvpId(r.event_id, r.guest_id)), COLLECTIONS.weddingRsvp, store)
    this.#settings = new TenantScopedRepository<WeddingRsvpSettings>(liveness, (r) => r.wedding_id, COLLECTIONS.weddingRsvpSettings, store)
  }

  /** The wedding's boundary alone (the HTTP edge calls it before parsing a body). */
  assertReach(context: TenantContext, principal: Principal, wedding_id: string): void {
    assertWeddingReach(this.authorizer, this.weddings, context, principal, wedding_id)
  }

  /** The wedding's events and their live counts. */
  view(context: TenantContext, principal: Principal, wedding_id: string): WeddingEventsView {
    this.assertReach(context, principal, wedding_id)
    const guests = this.guests.guestsOf(context, wedding_id)
    const rsvps = new Map(this.#rsvps.listGroup(context, wedding_id).map((r) => [rsvpId(r.event_id, r.guest_id), r]))
    const answers = new Answers(guests, rsvps)
    return {
      events: this.#eventsOf(context, wedding_id).map((event) => ({ event, counts: answers.countsFor(event) })),
      rsvps_closed: this.#closed(context, wedding_id),
    }
  }

  /** Close or reopen the household RSVP pages of a wedding: the planner's call (a couple gets PRODUCT.FORBIDDEN). */
  setRsvpsClosed(context: TenantContext, principal: Principal, wedding_id: string, closed: boolean): WeddingRsvpSettings {
    this.assertReach(context, principal, wedding_id)
    if (principal.role !== 'planner') throw new ProductError('PRODUCT.FORBIDDEN', 'Only the planner closes or reopens RSVPs.', {})
    const settings: WeddingRsvpSettings = { tenant_id: context.tenant_id, wedding_id, closed, updated_at: this.clock.now() }
    getSchemaRegistry().assertValid<WeddingRsvpSettings>('wedding_rsvp_settings', settings)
    return this.#settings.put(context, settings)
  }

  /** The household's RSVP page, from a resolved link (issue #30). */
  householdView(grant: HouseholdRsvpGrant): HouseholdRsvpView {
    assertHouseholdGrant(grant)
    const { context, wedding_id, household_id } = grant
    const household = this.guests.household(context, wedding_id, household_id)
    if (household === undefined) throw new ProductError('PRODUCT.NOT_FOUND', 'No such household on this wedding.', {})
    const all = this.guests.guestsOf(context, wedding_id)
    const members = all.filter((g) => g.household_id === household_id)
    const answers = this.#answersOf(context, wedding_id, all, members)
    return {
      household_name: household.name,
      guests: members.map((g) => ({ guest_id: g.guest_id, first_name: g.first_name, last_name: g.last_name, ...(g.dietary === undefined ? {} : { dietary: g.dietary }) })),
      events: this.#eventsOf(context, wedding_id).flatMap((event) => {
        const invited = members.filter((g) => answers.invited(event, g))
        if (invited.length === 0) return []
        return [
          {
            event_id: event.event_id,
            name: event.name,
            starts_at: event.starts_at,
            ...(event.location === undefined ? {} : { location: event.location }),
            meal_options: event.meal_options,
            answers: invited.map((g) => {
              const rsvp = answers.rsvp(event, g)
              return { guest_id: g.guest_id, status: rsvp?.status ?? 'pending', ...(rsvp?.meal_option_id === undefined ? {} : { meal_option_id: rsvp.meal_option_id }) }
            }),
          },
        ]
      }),
      closed: this.#closed(context, wedding_id),
    }
  }

  /**
   * The household answers for its own guests (issue #30), all or nothing. Refused while RSVPs are closed
   * (PRODUCT.RSVPS_CLOSED), for a guest outside the household or an event the guest is not invited to
   * (PRODUCT.BAD_REQUEST). The invitation is never the household's to change: it comes from the record or the default.
   */
  answerAsHousehold(grant: HouseholdRsvpGrant, input: readonly HouseholdAnswer[]): void {
    assertHouseholdGrant(grant)
    if (input.length > HOUSEHOLD_ANSWER_LIMITS.answers) throw new ProductError('PRODUCT.BAD_REQUEST', 'Too many answers.', {})
    const { context, wedding_id, household_id } = grant
    if (this.#closed(context, wedding_id)) throw new ProductError('PRODUCT.RSVPS_CLOSED', 'RSVPs are closed for this wedding.', {})
    const all = this.guests.guestsOf(context, wedding_id)
    const members = new Map(all.filter((g) => g.household_id === household_id).map((g) => [g.guest_id, g]))
    const events = new Map(this.#eventsOf(context, wedding_id).map((e) => [e.event_id, e]))
    const answers = this.#answersOf(context, wedding_id, all, [...members.values()])
    for (const answer of input) {
      const guest = members.get(answer.guest_id)
      const event = events.get(answer.event_id)
      if (guest === undefined || event === undefined || !answers.invited(event, guest)) {
        throw new ProductError('PRODUCT.BAD_REQUEST', 'That answer is not for a guest of this household at an event they are invited to.', {})
      }
      this.#write(context, event, guest.guest_id, true, answer.status, answer.meal_option_id, 'household')
    }
  }

  /** Whether a wedding's RSVPs are closed (no record: open). */
  #closed(context: TenantContext, wedding_id: string): boolean {
    const settings = this.#settings.read(context, wedding_id)
    return settings?.wedding_id === wedding_id && settings.closed
  }

  /** The stored answers of `members` (and their hosts), indexed for the invitation rules. */
  #answersOf(context: TenantContext, wedding_id: string, all: readonly WeddingGuest[], members: readonly WeddingGuest[]): Answers {
    const wanted = new Set(members.flatMap((g) => (g.plus_one_of === undefined ? [g.guest_id] : [g.guest_id, g.plus_one_of])))
    const rsvps = new Map<string, WeddingRsvp>()
    for (const r of this.#rsvps.listGroup(context, wedding_id)) {
      if (wanted.has(r.guest_id)) rsvps.set(rsvpId(r.event_id, r.guest_id), r)
    }
    return new Answers(all, rsvps)
  }

  addEvent(context: TenantContext, principal: Principal, wedding_id: string, input: WeddingEventInput): WeddingEvent {
    this.assertReach(context, principal, wedding_id)
    if (this.#eventsOf(context, wedding_id).length >= this.limits.events) {
      throw new ProductError('PRODUCT.LIMIT_REACHED', 'This wedding has reached the event limit.', {})
    }
    const event: WeddingEvent = {
      event_id: this.ids.next('event'),
      tenant_id: context.tenant_id,
      wedding_id,
      ...this.#fields(input, undefined),
      created_at: this.clock.now(),
    }
    getSchemaRegistry().assertValid<WeddingEvent>('wedding_event', event)
    return this.#events.put(context, event)
  }

  /** Edit an event. A meal option removed by the edit clears the choices that named it. */
  updateEvent(context: TenantContext, principal: Principal, wedding_id: string, event_id: string, input: WeddingEventInput): WeddingEvent {
    this.assertReach(context, principal, wedding_id)
    const existing = this.#event(context, wedding_id, event_id)
    const updated: WeddingEvent = {
      event_id: existing.event_id,
      tenant_id: existing.tenant_id,
      wedding_id: existing.wedding_id,
      ...this.#fields(input, existing),
      created_at: existing.created_at,
      updated_at: this.clock.now(),
    }
    getSchemaRegistry().assertValid<WeddingEvent>('wedding_event', updated)
    const kept = new Set(updated.meal_options.map((o) => o.option_id))
    for (const rsvp of this.#rsvps.listGroup(context, wedding_id)) {
      if (rsvp.event_id === event_id && rsvp.meal_option_id !== undefined && !kept.has(rsvp.meal_option_id)) {
        // The editor changed this answer (its meal is gone): record it as theirs.
        this.#write(context, updated, rsvp.guest_id, rsvp.invited, rsvp.status, undefined, principal.role)
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
      if (rsvp.event_id === event_id) this.#rsvps.delete(context, groupedKey(wedding_id, rsvpId(rsvp.event_id, rsvp.guest_id)))
    }
    return this.#events.delete(context, groupedKey(wedding_id, event_id))
  }

  /** One guest's answers, one per event of the wedding (by start time), defaults included. */
  guestRsvps(context: TenantContext, principal: Principal, wedding_id: string, guest_id: string): GuestEventRsvp[] {
    this.assertReach(context, principal, wedding_id)
    const guest = this.#guest(context, wedding_id, guest_id)
    const host = guest.plus_one_of === undefined ? undefined : this.guests.guest(context, wedding_id, guest.plus_one_of)
    return this.#eventsOf(context, wedding_id).map((event) => {
      const rsvp = this.#rsvp(context, wedding_id, event.event_id, guest_id)
      const invited = rsvp?.invited ?? invitedByDefault(event, host === undefined ? undefined : this.#rsvp(context, wedding_id, event.event_id, host.guest_id))
      if (rsvp === undefined) return { event, invited, status: 'pending' }
      return {
        event,
        invited,
        status: rsvp.status,
        ...(rsvp.meal_option_id === undefined ? {} : { meal_option_id: rsvp.meal_option_id }),
        answered_by: rsvp.answered_by,
        updated_at: rsvp.updated_at,
      }
    })
  }

  /**
   * Record one guest's invitation and answer for one event, as the planner or the couple. A guest not invited has no
   * answer (pending); a meal choice goes only with attending (dropped otherwise) and must be one of the event's meals.
   */
  recordAnswer(context: TenantContext, principal: Principal, wedding_id: string, event_id: string, guest_id: string, input: RsvpInput): WeddingRsvp {
    this.assertReach(context, principal, wedding_id)
    const event = this.#event(context, wedding_id, event_id)
    this.#guest(context, wedding_id, guest_id)
    return this.#write(context, event, guest_id, input.invited, input.status, input.meal_option_id, principal.role)
  }

  /** The guest list's hook: these guests were removed, so forget their answers (same request, same transaction). */
  guestsRemoved(context: TenantContext, wedding_id: string, guest_ids: readonly string[]): void {
    for (const event of this.#events.listGroup(context, wedding_id)) {
      for (const guest_id of guest_ids) this.#rsvps.delete(context, groupedKey(wedding_id, rsvpId(event.event_id, guest_id)))
    }
  }

  /** The one writer of an answer: the rules every entry point shares. */
  #write(
    context: TenantContext,
    event: WeddingEvent,
    guest_id: string,
    invited: boolean,
    status: RsvpStatus,
    meal_option_id: string | undefined,
    answered_by: RsvpAnsweredBy,
  ): WeddingRsvp {
    const attending = invited && status === 'attending'
    if (attending && meal_option_id !== undefined && !event.meal_options.some((o) => o.option_id === meal_option_id)) {
      throw new ProductError('PRODUCT.BAD_REQUEST', 'A meal choice must be one of the event\'s meals.', {})
    }
    const rsvp: WeddingRsvp = {
      tenant_id: context.tenant_id,
      wedding_id: event.wedding_id,
      event_id: event.event_id,
      guest_id,
      invited,
      status: invited ? status : 'pending',
      ...(attending && meal_option_id !== undefined ? { meal_option_id } : {}),
      answered_by,
      updated_at: this.clock.now(),
    }
    getSchemaRegistry().assertValid<WeddingRsvp>('wedding_rsvp', rsvp)
    return this.#rsvps.put(context, rsvp)
  }

  /** The editable fields, normalized. Meal options keep their ids (by id, else by label); the raw list is capped first. */
  #fields(input: WeddingEventInput, existing: WeddingEvent | undefined) {
    if (!isLocalDateTime(input.starts_at)) {
      throw new ProductError('PRODUCT.BAD_REQUEST', 'starts_at must be a date and time (YYYY-MM-DDTHH:MM).', {})
    }
    const raw = input.meal_options ?? []
    if (raw.length > this.limits.meal_inputs) {
      throw new ProductError('PRODUCT.BAD_REQUEST', `An event has at most ${this.limits.meal_options} meal options.`, {})
    }
    const previous = new Set((existing?.meal_options ?? []).map((o) => o.option_id))
    const previousByLabel = new Map((existing?.meal_options ?? []).map((o) => [o.label.toLowerCase(), o.option_id]))
    const claimed = new Set<string>()
    const labels = new Set<string>()
    const meal_options: { option_id: string; label: string }[] = []
    for (const entry of raw) {
      const named = entry.option_id !== undefined && entry.option_id.length > 0 ? entry.option_id : undefined
      if (named !== undefined && !previous.has(named)) {
        throw new ProductError('PRODUCT.BAD_REQUEST', 'That meal option is not on this event.', {})
      }
      const label = entry.label.trim()
      if (label.length === 0 || labels.has(label.toLowerCase())) continue // a blank label removes the option
      const byLabel = previousByLabel.get(label.toLowerCase())
      const option_id = named ?? (byLabel !== undefined && !claimed.has(byLabel) ? byLabel : this.ids.next('meal'))
      if (claimed.has(option_id)) continue
      claimed.add(option_id)
      labels.add(label.toLowerCase())
      meal_options.push({ option_id, label })
    }
    if (meal_options.length > this.limits.meal_options) {
      throw new ProductError('PRODUCT.BAD_REQUEST', `An event has at most ${this.limits.meal_options} meal options.`, {})
    }
    const location = input.location?.trim()
    return {
      name: input.name.trim(),
      starts_at: input.starts_at,
      ...(location === undefined || location.length === 0 ? {} : { location }),
      invitation: input.invitation ?? existing?.invitation ?? 'everyone',
      meal_options,
    }
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

  #guest(context: TenantContext, wedding_id: string, guest_id: string): WeddingGuest {
    const guest = this.guests.guest(context, wedding_id, guest_id)
    if (guest === undefined) throw new ProductError('PRODUCT.NOT_FOUND', 'No such guest on this wedding.', {})
    return guest
  }

  /** The stored answer for (event, guest), checked against its address (defence in depth on the composite id). */
  #rsvp(context: TenantContext, wedding_id: string, event_id: string, guest_id: string): WeddingRsvp | undefined {
    const rsvp = this.#rsvps.read(context, groupedKey(wedding_id, rsvpId(event_id, guest_id)))
    return rsvp !== undefined && rsvp.wedding_id === wedding_id && rsvp.event_id === event_id && rsvp.guest_id === guest_id ? rsvp : undefined
  }
}

/** An answer's id within its wedding's group: one per (event, guest). Minted ids never contain `:`. */
function rsvpId(event_id: string, guest_id: string): string {
  return `${event_id}:${guest_id}`
}

/** Whether a guest with no record of their own is invited: their host's answer for a plus-one, else the event's default. */
function invitedByDefault(event: WeddingEvent, hostRsvp: WeddingRsvp | undefined): boolean {
  return hostRsvp?.invited ?? event.invitation === 'everyone'
}

/** Whether `value` is a real local date and time, `YYYY-MM-DDTHH:MM`. */
export function isLocalDateTime(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) return false
  const parsed = new Date(`${value}:00.000Z`)
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 16) === value
}

/** A wedding's guests and stored answers, indexed once, for the counts of each event. */
class Answers {
  readonly #byId: ReadonlyMap<string, WeddingGuest>

  constructor(
    private readonly guests: readonly WeddingGuest[],
    private readonly rsvps: ReadonlyMap<string, WeddingRsvp>,
  ) {
    this.#byId = new Map(guests.map((g) => [g.guest_id, g]))
  }

  rsvp(event: WeddingEvent, guest: WeddingGuest): WeddingRsvp | undefined {
    return this.rsvps.get(rsvpId(event.event_id, guest.guest_id))
  }

  invited(event: WeddingEvent, guest: WeddingGuest): boolean {
    const own = this.rsvps.get(rsvpId(event.event_id, guest.guest_id))
    if (own !== undefined) return own.invited
    const host = guest.plus_one_of === undefined ? undefined : this.#byId.get(guest.plus_one_of)
    return invitedByDefault(event, host === undefined ? undefined : this.rsvps.get(rsvpId(event.event_id, host.guest_id)))
  }

  countsFor(event: WeddingEvent): WeddingEventCounts {
    const meals: Record<string, number> = Object.fromEntries(event.meal_options.map((o) => [o.option_id, 0]))
    let invited = 0
    let attending = 0
    let declined = 0
    let meal_unchosen = 0
    for (const guest of this.guests) {
      if (!this.invited(event, guest)) continue
      invited += 1
      const rsvp = this.rsvps.get(rsvpId(event.event_id, guest.guest_id))
      if (rsvp?.status === 'declined') declined += 1
      if (rsvp?.status !== 'attending') continue
      attending += 1
      const choice = rsvp.meal_option_id
      if (choice !== undefined && Object.hasOwn(meals, choice)) meals[choice] = (meals[choice] ?? 0) + 1
      else if (event.meal_options.length > 0) meal_unchosen += 1
    }
    return { invited, attending, declined, pending: invited - attending - declined, meals, meal_unchosen }
  }
}
