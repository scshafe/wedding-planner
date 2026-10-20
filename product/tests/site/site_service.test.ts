import { ManualClock, SequentialIdGenerator, type Tenant } from '@wedding-planner/shared'
import { describe, expect, it } from 'vitest'

import {
  GuestDirectory,
  GuestListService,
  InMemoryRecordStore,
  SessionStore,
  SiteService,
  TenantContextResolver,
  TenantStore,
  WeddingAuthorizer,
  WeddingEventService,
  WeddingRepository,
} from '@wedding-planner/product'

/**
 * Issue #47 — a wedding's public website below the HTTP edge: unique site names, publishing, the public view's
 * allow-list (no guest data), https-only links, and the boundary for editing (planner and couple).
 */

const THEME: Tenant['theme'] = { brand_name: 'B', primary_color_hex: '#111111', accent_color_hex: '#222222', logo_ref: 'l' }

function world() {
  const clock = new ManualClock('2028-01-10T12:00:00.000Z')
  const store = new InMemoryRecordStore()
  const tenants = new TenantStore(clock, new SequentialIdGenerator('t'), store)
  tenants.create({ slug: 'alpha', display_name: 'Alpha', theme: THEME, plan_tier: 'solo', lifecycle_status: 'active' })
  tenants.create({ slug: 'beta', display_name: 'Beta', theme: THEME, plan_tier: 'solo', lifecycle_status: 'active' })
  const resolver = new TenantContextResolver(tenants)
  const ctx = resolver.resolveBySlug('alpha')
  const other = resolver.resolveBySlug('beta')
  const weddings = new WeddingRepository(tenants, clock, new SequentialIdGenerator('w'), store)
  const ours = weddings.create(ctx, { couple_display_name: 'Jo & Lee', event_date: '2028-06-10' }).wedding_id
  const theirs = weddings.create(ctx, { couple_display_name: 'Sam & Kit', event_date: '2028-07-10' }).wedding_id
  const sessions = new SessionStore(new SequentialIdGenerator('s'))
  const planner = sessions.login(ctx, { role: 'planner' }).principal
  const couple = sessions.login(ctx, { role: 'couple', wedding_id: ours }).principal
  const authorizer = new WeddingAuthorizer()
  const ids = new SequentialIdGenerator('x')
  const events = new WeddingEventService(tenants, weddings, authorizer, new GuestDirectory(tenants, store), clock, ids, store)
  const sites = new SiteService(tenants, weddings, authorizer, events, clock, ids, store)
  const guestList = new GuestListService(tenants, weddings, authorizer, clock, ids, store)
  return { tenants, ctx, other, ours, theirs, planner, couple, events, sites, guestList }
}

function codeOf(fn: () => unknown): string {
  try {
    fn()
  } catch (error) {
    return (error as { code?: string }).code ?? `NON_CODED:${String(error)}`
  }
  return 'NO_THROW'
}

describe('SiteService', () => {
  it('shows nothing until published; then only the allow-listed content, with the public events', () => {
    const w = world()
    const ceremony = w.events.addEvent(w.ctx, w.planner, w.ours, { name: 'Ceremony', starts_at: '2028-06-10T16:00', location: 'Garden' })
    w.events.addEvent(w.ctx, w.planner, w.ours, { name: 'Rehearsal (private)', starts_at: '2028-06-09T19:00' })
    const household = w.guestList.addHousehold(w.ctx, w.planner, w.ours, { name: 'Rivera' })
    w.guestList.addGuest(w.ctx, w.planner, w.ours, { household_id: household.household_id, first_name: 'Secret', last_name: 'Guest', side: 'both' })
    w.sites.save(w.ctx, w.couple, w.ours, {
      site_name: ' Jo-And-Lee ',
      welcome: 'Hello!\nWe are getting married.',
      travel: 'Fly to X.',
      public_event_ids: [ceremony.event_id],
      hotels: [{ name: 'Inn', address: '1 Road', booking_url: 'https://inn.example/book', block_code: 'JOLEE', book_by: '2028-05-01' }],
      faq: [{ question: 'Kids?', answer: 'Yes.' }],
      registry: [{ label: 'Shop', url: 'https://shop.example/list' }],
    })
    expect(w.sites.publicView(w.ctx, 'jo-and-lee')).toBeUndefined()
    w.sites.setPublished(w.ctx, w.planner, w.ours, true)
    const view = w.sites.publicView(w.ctx, 'jo-and-lee')
    expect(view).toEqual({
      couple_display_name: 'Jo & Lee',
      event_date: '2028-06-10',
      welcome: 'Hello!\nWe are getting married.',
      schedule: [{ name: 'Ceremony', starts_at: '2028-06-10T16:00', location: 'Garden' }],
      travel: 'Fly to X.',
      hotels: [{ name: 'Inn', address: '1 Road', booking_url: 'https://inn.example/book', block_code: 'JOLEE', book_by: '2028-05-01' }],
      faq: [{ question: 'Kids?', answer: 'Yes.' }],
      registry: [{ label: 'Shop', url: 'https://shop.example/list' }],
    })
    const text = JSON.stringify(view)
    for (const hidden of ['Secret', 'Rivera', 'Rehearsal', w.ours, 'tenant']) expect(text).not.toContain(hidden)
  })

  it('a site name is unique in the workspace, free again when renamed, and unknown elsewhere', () => {
    const w = world()
    w.sites.save(w.ctx, w.planner, w.ours, { site_name: 'our-day' })
    w.sites.setPublished(w.ctx, w.planner, w.ours, true)
    expect(codeOf(() => w.sites.save(w.ctx, w.planner, w.theirs, { site_name: 'our-day' }))).toBe('PRODUCT.SITE_NAME_TAKEN')
    w.sites.save(w.ctx, w.planner, w.ours, { site_name: 'jo-lee' })
    expect(w.sites.publicView(w.ctx, 'our-day')).toBeUndefined()
    expect(w.sites.publicView(w.ctx, 'jo-lee')).toBeDefined()
    expect(w.sites.save(w.ctx, w.planner, w.theirs, { site_name: 'our-day' }).site_name).toBe('our-day')
    // Another workspace, a malformed name, or a suspended workspace: nothing.
    expect(w.sites.publicView(w.other, 'jo-lee')).toBeUndefined()
    for (const bad of ['', 'ab', 'Jo-Lee', 'jo_lee', '-jo', 'jo-', 'a'.repeat(41), '../x']) expect(w.sites.publicView(w.ctx, bad)).toBeUndefined()
    w.tenants.setLifecycleStatus(w.ctx.tenant_id, 'suspended')
    expect(codeOf(() => w.sites.publicView(w.ctx, 'jo-lee'))).toBe('PRODUCT.TENANT_NOT_USABLE')
  })

  it('links are https only; text is plain; lists are bounded; events must be the wedding\'s', () => {
    const w = world()
    const save = (input: object) => () => w.sites.save(w.ctx, w.planner, w.ours, { site_name: 'our-day', ...input } as never)
    for (const url of ['http://x.example', 'javascript:alert(1)', 'https://user:pw@x.example', 'https://x.example/"onmouseover', 'data:text/html,hi', 'https://x.example/ a']) {
      expect(codeOf(save({ registry: [{ label: 'X', url }] }))).toBe('PRODUCT.BAD_REQUEST')
    }
    expect(codeOf(save({ hotels: [{ name: 'Inn', book_by: '2028-02-30' }] }))).toBe('PRODUCT.BAD_REQUEST')
    expect(codeOf(save({ faq: [{ question: 'A\nB', answer: 'x' }] }))).toBe('PRODUCT.BAD_REQUEST')
    expect(codeOf(save({ hotels: Array.from({ length: 11 }, () => ({ name: 'Inn' })) }))).toBe('PRODUCT.BAD_REQUEST')
    const theirEvent = w.events.addEvent(w.ctx, w.planner, w.theirs, { name: 'Theirs', starts_at: '2028-07-10T16:00' })
    expect(codeOf(save({ public_event_ids: [theirEvent.event_id] }))).toBe('PRODUCT.BAD_REQUEST')
    for (const name of ['wedding_w_1', 'x', 'Our Day']) expect(codeOf(() => w.sites.save(w.ctx, w.planner, w.ours, { site_name: name }))).toBe('PRODUCT.BAD_REQUEST')
  })

  it('the couple edits only its own wedding\'s site; publishing needs a site', () => {
    const w = world()
    expect(codeOf(() => w.sites.setPublished(w.ctx, w.couple, w.ours, true))).toBe('PRODUCT.BAD_REQUEST')
    expect(codeOf(() => w.sites.save(w.ctx, w.couple, w.theirs, { site_name: 'their-day' }))).toBe('PRODUCT.NOT_FOUND')
    expect(codeOf(() => w.sites.editView(w.ctx, w.couple, w.theirs))).toBe('PRODUCT.NOT_FOUND')
    expect(w.sites.editView(w.ctx, w.couple, w.ours).site).toBeUndefined()
  })
})
