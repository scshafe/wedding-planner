import { ManualClock, SequentialIdGenerator, type Tenant } from '@wedding-planner/shared'
import { describe, expect, it } from 'vitest'

import {
  GuestDirectory,
  InMemoryRecordStore,
  RunOfShowService,
  SessionStore,
  TenantContextResolver,
  TenantStore,
  VendorService,
  WeddingAuthorizer,
  WeddingEventService,
  WeddingRepository,
} from '@wedding-planner/product'

/**
 * Issue #45 — a wedding's run of show below the HTTP edge: time order with vendor call times as their own lines, the
 * couple reading it without notes and seeing an unshared vendor by category, the rules on owners, times and events.
 */

const THEME: Tenant['theme'] = { brand_name: 'B', primary_color_hex: '#111111', accent_color_hex: '#222222', logo_ref: 'l' }

function world() {
  const clock = new ManualClock('2028-01-10T12:00:00.000Z')
  const store = new InMemoryRecordStore()
  const tenants = new TenantStore(clock, new SequentialIdGenerator('t'), store)
  tenants.create({ slug: 'alpha', display_name: 'Alpha', theme: THEME, plan_tier: 'solo', lifecycle_status: 'active' })
  const ctx = new TenantContextResolver(tenants).resolveBySlug('alpha')
  const weddings = new WeddingRepository(tenants, clock, new SequentialIdGenerator('w'), store)
  const ours = weddings.create(ctx, { couple_display_name: 'Jo & Lee', event_date: '2028-06-10' }).wedding_id
  const theirs = weddings.create(ctx, { couple_display_name: 'Sam & Kit', event_date: '2028-07-10' }).wedding_id
  const sessions = new SessionStore(new SequentialIdGenerator('s'))
  const planner = sessions.login(ctx, { role: 'planner' }).principal
  const couple = sessions.login(ctx, { role: 'couple', wedding_id: ours }).principal
  const authorizer = new WeddingAuthorizer()
  const ids = new SequentialIdGenerator('r')
  const vendors = new VendorService(tenants, weddings, authorizer, clock, ids, store)
  const events = new WeddingEventService(tenants, weddings, authorizer, new GuestDirectory(tenants, store), clock, ids, store)
  const show = new RunOfShowService(tenants, weddings, authorizer, vendors, events, clock, ids, store)
  const photographer = vendors.addVendor(ctx, planner, ours, { category: 'photography', business_name: 'Snap Studio', contract_status: 'signed' })
  const band = vendors.addVendor(ctx, planner, ours, { category: 'music', business_name: 'The Band', contract_status: 'signed', shared_with_couple: true })
  const ceremony = events.addEvent(ctx, planner, ours, { name: 'Ceremony', starts_at: '2028-06-10T16:00' })
  return { ctx, ours, theirs, planner, couple, vendors, events, show, photographer, band, ceremony }
}

function codeOf(fn: () => unknown): string {
  try {
    fn()
  } catch (error) {
    return (error as { code?: string }).code ?? `NON_CODED:${String(error)}`
  }
  return 'NO_THROW'
}

describe('RunOfShowService', () => {
  it('orders the day by time, with a vendor\'s call time as its own line before its item', () => {
    const w = world()
    w.show.addItem(w.ctx, w.planner, w.ours, { starts_at: '2028-06-10T16:00', ends_at: '2028-06-10T16:30', title: 'Vows', location: 'Garden', owner: 'couple', event_id: w.ceremony.event_id })
    w.show.addItem(w.ctx, w.planner, w.ours, { starts_at: '2028-06-10T15:30', title: 'Portraits', owner: 'vendor', owner_vendor_id: w.photographer.vendor_id, vendor_call_time: '2028-06-10T14:00', notes: 'Bring the long lens' })
    w.show.addItem(w.ctx, w.planner, w.ours, { starts_at: '2028-06-10T19:00', title: 'First dance', owner: 'vendor', owner_vendor_id: w.band.vendor_id, vendor_call_time: '2028-06-10T19:00' })
    const view = w.show.view(w.ctx, w.planner, w.ours)
    expect(view.lines.map((l) => [l.at, l.kind, l.item.title, l.owner_label, l.event_name])).toEqual([
      ['2028-06-10T14:00', 'arrival', 'Portraits', 'Snap Studio', undefined],
      ['2028-06-10T15:30', 'item', 'Portraits', 'Snap Studio', undefined],
      ['2028-06-10T16:00', 'item', 'Vows', 'Couple', 'Ceremony'],
      ['2028-06-10T19:00', 'arrival', 'First dance', 'The Band', undefined],
      ['2028-06-10T19:00', 'item', 'First dance', 'The Band', undefined],
    ])
    expect(view.can_manage).toBe(true)
  })

  it('the couple reads it without notes, and sees a vendor it is not shared by its category, never by name or id', () => {
    const w = world()
    w.show.addItem(w.ctx, w.planner, w.ours, { starts_at: '2028-06-10T15:30', title: 'Portraits', owner: 'vendor', owner_vendor_id: w.photographer.vendor_id, vendor_call_time: '2028-06-10T14:00', notes: 'Bring the long lens' })
    const view = w.show.view(w.ctx, w.couple, w.ours)
    expect(view.lines.map((l) => l.owner_label)).toEqual(['The photography vendor', 'The photography vendor'])
    const text = JSON.stringify(view)
    for (const hidden of ['Snap Studio', 'long lens', w.photographer.vendor_id]) expect(text).not.toContain(hidden)
    expect(view).toMatchObject({ can_manage: false, vendors: [], events: [] })
  })

  it('refuses unreal times, an end before the start, a call time without a vendor, and a vendor or event of another wedding', () => {
    const w = world()
    const theirVendor = w.vendors.addVendor(w.ctx, w.planner, w.theirs, { category: 'cake', business_name: 'Cake', contract_status: 'none' })
    const theirEvent = w.events.addEvent(w.ctx, w.planner, w.theirs, { name: 'Theirs', starts_at: '2028-07-10T16:00' })
    const add = (input: object) => () => w.show.addItem(w.ctx, w.planner, w.ours, { starts_at: '2028-06-10T16:00', title: 'X', owner: 'planner', ...input } as never)
    expect(codeOf(add({ starts_at: '2028-06-31T16:00' }))).toBe('PRODUCT.BAD_REQUEST')
    expect(codeOf(add({ ends_at: '2028-06-10T15:00' }))).toBe('PRODUCT.BAD_REQUEST')
    expect(codeOf(add({ vendor_call_time: '2028-06-10T15:00' }))).toBe('PRODUCT.BAD_REQUEST')
    expect(codeOf(add({ owner: 'vendor' }))).toBe('PRODUCT.BAD_REQUEST')
    expect(codeOf(add({ owner: 'vendor', owner_vendor_id: theirVendor.vendor_id }))).toBe('PRODUCT.BAD_REQUEST')
    expect(codeOf(add({ event_id: theirEvent.event_id }))).toBe('PRODUCT.BAD_REQUEST')
    expect(codeOf(add({ title: 'A‮B' }))).toBe('PRODUCT.BAD_REQUEST')
  })

  it('is the planner\'s to change (403 for the couple); another wedding is the masked NOT_FOUND', () => {
    const w = world()
    const item = w.show.addItem(w.ctx, w.planner, w.ours, { starts_at: '2028-06-10T16:00', title: 'Vows', owner: 'couple' })
    expect(codeOf(() => w.show.addItem(w.ctx, w.couple, w.ours, { starts_at: '2028-06-10T16:00', title: 'X', owner: 'couple' }))).toBe('PRODUCT.FORBIDDEN')
    expect(codeOf(() => w.show.updateItem(w.ctx, w.couple, w.ours, item.item_id, { starts_at: '2028-06-10T16:00', title: 'X', owner: 'couple' }))).toBe('PRODUCT.FORBIDDEN')
    expect(codeOf(() => w.show.removeItem(w.ctx, w.couple, w.ours, item.item_id))).toBe('PRODUCT.FORBIDDEN')
    expect(codeOf(() => w.show.view(w.ctx, w.couple, w.theirs))).toBe('PRODUCT.NOT_FOUND')
    expect(codeOf(() => w.show.view(w.ctx, w.couple, 'wedding_missing'))).toBe('PRODUCT.NOT_FOUND')
    const theirs = w.show.addItem(w.ctx, w.planner, w.theirs, { starts_at: '2028-07-10T16:00', title: 'Theirs', owner: 'planner' })
    expect(codeOf(() => w.show.updateItem(w.ctx, w.planner, w.ours, theirs.item_id, { starts_at: '2028-06-10T16:00', title: 'X', owner: 'planner' }))).toBe('PRODUCT.NOT_FOUND')
    expect(w.show.removeItem(w.ctx, w.planner, w.ours, theirs.item_id)).toBe(false)
    expect(w.show.updateItem(w.ctx, w.planner, w.ours, item.item_id, { starts_at: '2028-06-10T16:15', title: 'Vows', owner: 'couple' }).starts_at).toBe('2028-06-10T16:15')
  })
})
