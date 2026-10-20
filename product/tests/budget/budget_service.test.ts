import { ManualClock, SequentialIdGenerator, type Tenant } from '@wedding-planner/shared'
import { describe, expect, it } from 'vitest'

import { BudgetService, InMemoryRecordStore, SessionStore, TenantContextResolver, TenantStore, VendorService, WeddingAuthorizer, WeddingRepository } from '@wedding-planner/product'

/**
 * Issue #34 — a wedding's budget below the HTTP edge: the totals, a line following its vendor's schedule (and falling
 * back when the vendor goes), the next payments, the couple seeing only shared lines (and never an unshared vendor's
 * name), the planner's capability and the wedding's boundary.
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
  const ids = new SequentialIdGenerator('b')
  const vendors = new VendorService(tenants, weddings, authorizer, clock, ids, store)
  const budget = new BudgetService(tenants, weddings, authorizer, vendors, clock, ids, store)
  const venue = vendors.addVendor(ctx, planner, ours, {
    category: 'venue',
    business_name: 'Secret Hall',
    contract_status: 'signed',
    shared_with_couple: false,
    installments: [
      { label: 'Deposit', amount_cents: 100_000, due_date: '2027-12-01', deposit: true, paid: true },
      { label: 'Balance', amount_cents: 400_000, due_date: '2028-05-01' },
      { label: 'Late fee', amount_cents: 5_000, due_date: '2028-01-05' },
    ],
  })
  return { ctx, ours, theirs, planner, couple, vendors, budget, venue }
}

function codeOf(fn: () => unknown): string {
  try {
    fn()
  } catch (error) {
    return (error as { code?: string }).code ?? `NON_CODED:${String(error)}`
  }
  return 'NO_THROW'
}

describe('BudgetService', () => {
  it("totals manual lines and lines that follow a vendor's schedule, with the next payments soonest first", () => {
    const w = world()
    w.budget.addCategory(w.ctx, w.planner, w.ours, { name: 'Venue', estimated_cents: 450_000, vendor_id: w.venue.vendor_id, actual_cents: 1, paid_cents: 1 })
    w.budget.addCategory(w.ctx, w.planner, w.ours, { name: 'Flowers', estimated_cents: 80_000, actual_cents: 90_000, paid_cents: 30_000 })
    const view = w.budget.view(w.ctx, w.planner, w.ours)
    expect(view.lines.map((l) => [l.category.name, l.actual_cents, l.paid_cents, l.due_cents, l.vendor_name])).toEqual([
      ['Venue', 505_000, 100_000, 405_000, 'Secret Hall'],
      ['Flowers', 90_000, 30_000, 60_000, undefined],
    ])
    expect(view.totals).toEqual({ estimated_cents: 530_000, actual_cents: 595_000, paid_cents: 130_000, due_cents: 465_000 })
    expect(view.next_payments.map((p) => [p.category_name, p.label, p.amount_cents, p.overdue])).toEqual([
      ['Venue', 'Late fee', 5_000, true],
      ['Venue', 'Balance', 400_000, false],
    ])
    expect(view.vendors).toEqual([{ vendor_id: w.venue.vendor_id, business_name: 'Secret Hall' }])
  })

  it("the couple sees shared lines and their totals only, and never the name of a vendor it may not see", () => {
    const w = world()
    w.budget.addCategory(w.ctx, w.planner, w.ours, { name: 'Venue', estimated_cents: 450_000, vendor_id: w.venue.vendor_id, shared_with_couple: true })
    w.budget.addCategory(w.ctx, w.planner, w.ours, { name: 'Planner fee', estimated_cents: 300_000, actual_cents: 300_000 })
    const view = w.budget.view(w.ctx, w.couple, w.ours)
    expect(view.lines.map((l) => l.category.name)).toEqual(['Venue'])
    expect(view.totals).toEqual({ estimated_cents: 450_000, actual_cents: 505_000, paid_cents: 100_000, due_cents: 405_000 })
    expect(view.next_payments.map((p) => p.category_name)).toEqual(['Venue', 'Venue'])
    expect(view.can_manage).toBe(false)
    expect(view.vendors).toEqual([])
    const text = JSON.stringify(view)
    expect(text).not.toContain('Secret Hall')
    expect(text).not.toContain(w.venue.vendor_id)
    expect(text).not.toContain('Planner fee')
    // Once the planner shares the vendor too, the couple sees whom the line follows.
    w.vendors.updateVendor(w.ctx, w.planner, w.ours, w.venue.vendor_id, { category: 'venue', business_name: 'Secret Hall', contract_status: 'signed', shared_with_couple: true, installments: w.venue.installments })
    expect(w.budget.view(w.ctx, w.couple, w.ours).lines[0]?.vendor_name).toBe('Secret Hall')
  })

  it("the couple never reads an unshared vendor's labels, fallback amounts or removal, nor can tell a line follows one", () => {
    const w = world()
    const secret = w.vendors.addVendor(w.ctx, w.planner, w.ours, {
      category: 'cake',
      business_name: 'Secret Bakery',
      contract_status: 'signed',
      installments: [{ label: 'Secret Bakery balance (ref 4711)', amount_cents: 50_000, due_date: '2028-04-01' }],
    })
    w.budget.addCategory(w.ctx, w.planner, w.ours, { name: 'Cake', estimated_cents: 40_000, vendor_id: secret.vendor_id, actual_cents: 777_777, paid_cents: 333_333, shared_with_couple: true })
    const view = w.budget.view(w.ctx, w.couple, w.ours)
    const text = JSON.stringify(view)
    for (const hidden of ['Secret Bakery', '4711', '777777', '333333', secret.vendor_id]) expect(text).not.toContain(hidden)
    expect(view.next_payments.map((p) => [p.category_name, p.label])).toEqual([['Cake', 'Payment']])
    expect(view.lines[0]?.category).toMatchObject({ actual_cents: 50_000, paid_cents: 0 })
    w.vendors.removeVendor(w.ctx, w.planner, w.ours, secret.vendor_id)
    expect(w.budget.view(w.ctx, w.couple, w.ours).lines[0]?.vendor_missing).toBe(false)
    expect(w.budget.view(w.ctx, w.planner, w.ours).lines[0]?.vendor_missing).toBe(true)
  })

  it("one line per vendor: a second line following the same vendor is refused (it would count twice)", () => {
    const w = world()
    const venue = w.budget.addCategory(w.ctx, w.planner, w.ours, { name: 'Venue', estimated_cents: 1, vendor_id: w.venue.vendor_id })
    expect(codeOf(() => w.budget.addCategory(w.ctx, w.planner, w.ours, { name: 'Venue again', estimated_cents: 1, vendor_id: w.venue.vendor_id }))).toBe('PRODUCT.BAD_REQUEST')
    expect(w.budget.updateCategory(w.ctx, w.planner, w.ours, venue.category_id, { name: 'Venue', estimated_cents: 2, vendor_id: w.venue.vendor_id }).estimated_cents).toBe(2)
  })

  it("a line whose vendor is removed falls back to its manual amounts, and says so", () => {
    const w = world()
    w.budget.addCategory(w.ctx, w.planner, w.ours, { name: 'Venue', estimated_cents: 450_000, vendor_id: w.venue.vendor_id, actual_cents: 420_000, paid_cents: 100_000 })
    w.vendors.removeVendor(w.ctx, w.planner, w.ours, w.venue.vendor_id)
    expect(w.budget.view(w.ctx, w.planner, w.ours).lines[0]).toMatchObject({ actual_cents: 420_000, paid_cents: 100_000, due_cents: 320_000, vendor_missing: true })
  })

  it("refuses a vendor of another wedding, bad amounts, and a couple's management (403); masks another wedding", () => {
    const w = world()
    const theirVendor = w.vendors.addVendor(w.ctx, w.planner, w.theirs, { category: 'cake', business_name: 'Cake', contract_status: 'none' })
    expect(codeOf(() => w.budget.addCategory(w.ctx, w.planner, w.ours, { name: 'Cake', estimated_cents: 1, vendor_id: theirVendor.vendor_id }))).toBe('PRODUCT.BAD_REQUEST')
    for (const estimated_cents of [1.5, -1, 100_000_000_001]) expect(codeOf(() => w.budget.addCategory(w.ctx, w.planner, w.ours, { name: 'X', estimated_cents }))).toBe('PRODUCT.BAD_REQUEST')
    expect(codeOf(() => w.budget.addCategory(w.ctx, w.planner, w.ours, { name: 'A\nB', estimated_cents: 1 }))).toBe('PRODUCT.BAD_REQUEST')
    const line = w.budget.addCategory(w.ctx, w.planner, w.ours, { name: 'Flowers', estimated_cents: 1, shared_with_couple: true })
    expect(codeOf(() => w.budget.addCategory(w.ctx, w.couple, w.ours, { name: 'X', estimated_cents: 1 }))).toBe('PRODUCT.FORBIDDEN')
    expect(codeOf(() => w.budget.updateCategory(w.ctx, w.couple, w.ours, line.category_id, { name: 'X', estimated_cents: 1 }))).toBe('PRODUCT.FORBIDDEN')
    expect(codeOf(() => w.budget.removeCategory(w.ctx, w.couple, w.ours, line.category_id))).toBe('PRODUCT.FORBIDDEN')
    expect(codeOf(() => w.budget.view(w.ctx, w.couple, w.theirs))).toBe('PRODUCT.NOT_FOUND')
    expect(codeOf(() => w.budget.view(w.ctx, w.couple, 'wedding_missing'))).toBe('PRODUCT.NOT_FOUND')
    const theirs = w.budget.addCategory(w.ctx, w.planner, w.theirs, { name: 'Theirs', estimated_cents: 1 })
    expect(codeOf(() => w.budget.updateCategory(w.ctx, w.planner, w.ours, theirs.category_id, { name: 'X', estimated_cents: 1 }))).toBe('PRODUCT.NOT_FOUND')
    expect(w.budget.removeCategory(w.ctx, w.planner, w.ours, theirs.category_id)).toBe(false)
  })
})
