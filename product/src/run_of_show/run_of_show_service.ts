import { type Clock, getSchemaRegistry, type IdGenerator, type RunOfShowItem, type WeddingVendor } from '@wedding-planner/shared'

import type { Principal } from '../auth/principal'
import type { WeddingAuthorizer } from '../auth/wedding_authorizer'
import { COLLECTIONS } from '../persistence/collections'
import { groupedKey, type RecordStore } from '../persistence/record_store'
import { ProductError } from '../product_error'
import type { TenantContext } from '../tenant/tenant_context'
import { TenantScopedRepository } from '../tenant/tenant_scoped_repository'
import type { TenantLivenessCheck } from '../tenant/tenant_store'
import { assertPlainText } from '../text/plain_text'
import type { VendorService } from '../vendors/vendor_service'
import { isLocalDateTime, type WeddingEventService } from '../wedding_events/wedding_event_service'
import { assertWeddingReach } from '../wedding/wedding_reach'
import type { WeddingRepository } from '../wedding/wedding_repository'

/**
 * @canonical run_of_show_service -- a wedding's run of show (issue #45, ADR 0053): the day-of timeline of what
 * happens when, who owns it, and when each vendor must arrive.
 *
 * The boundary is the wedding's (`assertWeddingReach`). The planner manages the items; the couple reads the run of
 * show, without the planner's notes. A vendor the couple is not shared (#33) stays out of its view as on the vendors
 * page: its items show "A vendor" as the owner, and its arrival lines are not in the couple's timeline.
 *
 * The view is a list of lines in time order: each item at its start, and — for a vendor's item with a call time — a
 * separate "arrives" line at that time, so the call times read in the same timeline.
 *
 * related: run_of_show_item_schema.json (the contract), vendor_service.ts (owners), wedding_event_service.ts (events).
 */

/** Bounds on one wedding's run of show. */
export const RUN_OF_SHOW_LIMITS = Object.freeze({ items: 200 })

export type RunOfShowOwner = RunOfShowItem['owner']

export interface RunOfShowInput {
  /** Local `YYYY-MM-DDTHH:MM`. */
  readonly starts_at: string
  readonly ends_at?: string
  readonly title: string
  readonly location?: string
  readonly owner: RunOfShowOwner
  /** The vendor who owns it, when `owner` is `vendor`. */
  readonly owner_vendor_id?: string
  /** When that vendor must arrive (a vendor's item only). */
  readonly vendor_call_time?: string
  readonly event_id?: string
  readonly notes?: string
}

/** One line of the timeline: an item at its start, or a vendor's arrival at its call time. */
export interface RunOfShowLine {
  readonly kind: 'item' | 'arrival'
  /** Local `YYYY-MM-DDTHH:MM`. */
  readonly at: string
  readonly item: RunOfShowItem
  /** Who owns it, as this principal may see it: "Planner", "Couple", a vendor's name, or an unshared vendor's category. */
  readonly owner_label: string
  /** The event it belongs to, by name. */
  readonly event_name?: string
}

export interface RunOfShowView {
  readonly lines: readonly RunOfShowLine[]
  readonly can_manage: boolean
  /** What an item may link to (the planner's view only). */
  readonly vendors: readonly { readonly vendor_id: string; readonly business_name: string }[]
  readonly events: readonly { readonly event_id: string; readonly name: string }[]
}

export class RunOfShowService {
  readonly #items: TenantScopedRepository<RunOfShowItem>

  constructor(
    liveness: TenantLivenessCheck,
    private readonly weddings: WeddingRepository,
    private readonly authorizer: WeddingAuthorizer,
    private readonly vendors: Pick<VendorService, 'vendorsOf'>,
    private readonly events: Pick<WeddingEventService, 'eventsOf'>,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
    store?: RecordStore,
    private readonly limits: { readonly items: number } = RUN_OF_SHOW_LIMITS,
  ) {
    this.#items = new TenantScopedRepository<RunOfShowItem>(liveness, (i) => groupedKey(i.wedding_id, i.item_id), COLLECTIONS.runOfShowItem, store)
  }

  /** The wedding's boundary alone (the HTTP edge calls it before parsing a body). */
  assertReach(context: TenantContext, principal: Principal, wedding_id: string): void {
    assertWeddingReach(this.authorizer, this.weddings, context, principal, wedding_id)
  }

  view(context: TenantContext, principal: Principal, wedding_id: string): RunOfShowView {
    this.assertReach(context, principal, wedding_id)
    const planner = principal.role === 'planner'
    const vendors = new Map(this.vendors.vendorsOf(context, wedding_id).map((v) => [v.vendor_id, v]))
    const events = this.events.eventsOf(context, wedding_id)
    const eventNames = new Map(events.map((e) => [e.event_id, e.name]))
    const lines: RunOfShowLine[] = []
    for (const stored of this.#itemsOf(context, wedding_id)) {
      const vendor = stored.owner_vendor_id === undefined ? undefined : vendors.get(stored.owner_vendor_id)
      const item = planner ? stored : asTheCoupleSeesIt(stored, vendor?.shared_with_couple === true)
      const owner_label = ownerLabel(item, vendor, planner)
      const event_name = item.event_id === undefined ? undefined : eventNames.get(item.event_id)
      const extra = event_name === undefined ? {} : { event_name }
      lines.push({ kind: 'item', at: item.starts_at, item, owner_label, ...extra })
      // An arrival line names when a vendor comes: the couple sees it only for a vendor it is shared.
      const arrivalShown = planner || vendor?.shared_with_couple === true
      if (item.vendor_call_time !== undefined && arrivalShown) lines.push({ kind: 'arrival', at: item.vendor_call_time, item, owner_label, ...extra })
    }
    lines.sort((a, b) => (a.at === b.at ? (a.kind === b.kind ? 0 : a.kind === 'arrival' ? -1 : 1) : a.at < b.at ? -1 : 1))
    return {
      lines,
      can_manage: planner,
      vendors: planner ? [...vendors.values()].map((v) => ({ vendor_id: v.vendor_id, business_name: v.business_name })) : [],
      events: planner ? events.map((e) => ({ event_id: e.event_id, name: e.name })) : [],
    }
  }

  addItem(context: TenantContext, principal: Principal, wedding_id: string, input: RunOfShowInput): RunOfShowItem {
    this.assertReach(context, principal, wedding_id)
    this.#planner(principal)
    if (this.#itemsOf(context, wedding_id).length >= this.limits.items) {
      throw new ProductError('PRODUCT.LIMIT_REACHED', 'This wedding has reached the run-of-show limit.', {})
    }
    return this.#put(context, {
      item_id: this.ids.next('show'),
      tenant_id: context.tenant_id,
      wedding_id,
      ...this.#fields(context, wedding_id, input),
      created_at: this.clock.now(),
    })
  }

  updateItem(context: TenantContext, principal: Principal, wedding_id: string, item_id: string, input: RunOfShowInput): RunOfShowItem {
    this.assertReach(context, principal, wedding_id)
    this.#planner(principal)
    const existing = this.#item(context, wedding_id, item_id)
    return this.#put(context, {
      item_id: existing.item_id,
      tenant_id: existing.tenant_id,
      wedding_id: existing.wedding_id,
      ...this.#fields(context, wedding_id, input),
      created_at: existing.created_at,
      updated_at: this.clock.now(),
    })
  }

  /** Remove an item. Returns whether it existed. */
  removeItem(context: TenantContext, principal: Principal, wedding_id: string, item_id: string): boolean {
    this.assertReach(context, principal, wedding_id)
    this.#planner(principal)
    if (item_id.length === 0 || this.#items.read(context, groupedKey(wedding_id, item_id))?.wedding_id !== wedding_id) return false
    return this.#items.delete(context, groupedKey(wedding_id, item_id))
  }

  #fields(context: TenantContext, wedding_id: string, input: RunOfShowInput): Omit<RunOfShowItem, 'item_id' | 'tenant_id' | 'wedding_id' | 'created_at' | 'updated_at'> {
    assertPlainText([input.title, input.location])
    assertPlainText([input.notes], { multiline: true })
    for (const [field, value] of [['starts_at', input.starts_at], ['ends_at', input.ends_at], ['vendor_call_time', input.vendor_call_time]] as const) {
      if (value !== undefined && !isLocalDateTime(value)) throw new ProductError('PRODUCT.BAD_REQUEST', `${field} must be a date and time (YYYY-MM-DDTHH:MM).`, {})
    }
    if (input.ends_at !== undefined && input.ends_at < input.starts_at) throw new ProductError('PRODUCT.BAD_REQUEST', 'An item cannot end before it starts.', {})
    const vendor = input.owner === 'vendor' ? input.owner_vendor_id : undefined
    if (input.owner === 'vendor' && (vendor === undefined || !this.vendors.vendorsOf(context, wedding_id).some((v) => v.vendor_id === vendor))) {
      throw new ProductError('PRODUCT.BAD_REQUEST', 'A vendor-owned item names a vendor of this wedding.', {})
    }
    if (input.vendor_call_time !== undefined && input.owner !== 'vendor') {
      throw new ProductError('PRODUCT.BAD_REQUEST', 'A call time is for an item a vendor owns.', {})
    }
    if (input.vendor_call_time !== undefined && input.vendor_call_time > input.starts_at) {
      throw new ProductError('PRODUCT.BAD_REQUEST', 'A vendor arrives at or before the item starts.', {})
    }
    if (input.event_id !== undefined && !this.events.eventsOf(context, wedding_id).some((e) => e.event_id === input.event_id)) {
      throw new ProductError('PRODUCT.BAD_REQUEST', 'That event is not on this wedding.', {})
    }
    const location = input.location?.trim()
    const notes = input.notes?.trim()
    return {
      starts_at: input.starts_at,
      ...(input.ends_at === undefined ? {} : { ends_at: input.ends_at }),
      title: input.title.trim(),
      ...(location === undefined || location.length === 0 ? {} : { location }),
      owner: input.owner,
      ...(vendor === undefined ? {} : { owner_vendor_id: vendor }),
      ...(input.vendor_call_time === undefined ? {} : { vendor_call_time: input.vendor_call_time }),
      ...(input.event_id === undefined ? {} : { event_id: input.event_id }),
      ...(notes === undefined || notes.length === 0 ? {} : { notes }),
    }
  }

  /** The wedding's items with no boundary check: for a caller that has already established reach (the copilot's job). */
  itemsOf(context: TenantContext, wedding_id: string): RunOfShowItem[] {
    return this.#itemsOf(context, wedding_id)
  }

  #itemsOf(context: TenantContext, wedding_id: string): RunOfShowItem[] {
    return this.#items.listGroup(context, wedding_id).filter((i) => i.wedding_id === wedding_id)
  }

  #item(context: TenantContext, wedding_id: string, item_id: string): RunOfShowItem {
    const item = item_id.length === 0 ? undefined : this.#items.read(context, groupedKey(wedding_id, item_id))
    if (item === undefined || item.wedding_id !== wedding_id) throw new ProductError('PRODUCT.NOT_FOUND', 'No such run-of-show item on this wedding.', {})
    return item
  }

  #put(context: TenantContext, item: RunOfShowItem): RunOfShowItem {
    getSchemaRegistry().assertValid<RunOfShowItem>('run_of_show_item', item)
    return this.#items.put(context, item)
  }

  #planner(principal: Principal): void {
    if (principal.role !== 'planner') throw new ProductError('PRODUCT.FORBIDDEN', 'Only the planner manages the run of show.', {})
  }
}

/** Who owns an item, as this principal may see it. A vendor the couple is not shared is just "A vendor". */
function ownerLabel(item: RunOfShowItem, vendor: WeddingVendor | undefined, planner: boolean): string {
  if (item.owner === 'planner') return 'Planner'
  if (item.owner === 'couple') return 'Couple'
  if (vendor === undefined || !(planner || vendor.shared_with_couple)) return 'A vendor'
  return vendor.business_name
}

/**
 * An item as the couple sees it: the planner's notes and which vendor record owns it stay with the planner, and so
 * does an unshared vendor's call time.
 */
function asTheCoupleSeesIt(item: RunOfShowItem, vendorShared: boolean): RunOfShowItem {
  const shared: RunOfShowItem = { ...item }
  delete shared.notes
  delete shared.owner_vendor_id
  if (!vendorShared) delete shared.vendor_call_time
  return shared
}
