import { ManualClock, SequentialIdGenerator, type Tenant } from '@wedding-planner/shared'
import { describe, expect, it } from 'vitest'

import {
  centsFromText,
  InMemoryRecordStore,
  SessionStore,
  TenantContextResolver,
  TenantStore,
  type VendorInput,
  VendorService,
  WeddingAuthorizer,
  WeddingRepository,
} from '@wedding-planner/product'

/**
 * Issue #33 — a wedding's vendors below the HTTP edge: integer cents only, the payment schedule's stable ids and paid
 * state, what is due next, the couple seeing only shared vendors (without notes), and the planner's capability.
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
  const vendors = new VendorService(tenants, weddings, new WeddingAuthorizer(), clock, new SequentialIdGenerator('v'), store)
  return { clock, ctx, ours, theirs, planner, couple, vendors }
}

const hall: VendorInput = {
  category: 'venue',
  business_name: ' The Hall ',
  contact_name: 'Pat',
  email: 'pat@hall.example',
  contract_status: 'signed',
  shared_with_couple: true,
  notes: 'Owner is difficult',
  installments: [
    { label: 'Deposit', amount_cents: 150_000, due_date: '2027-12-01', deposit: true, paid: true },
    { label: 'Final payment', amount_cents: 350_050, due_date: '2028-05-10' },
  ],
}

function codeOf(fn: () => unknown): string {
  try {
    fn()
  } catch (error) {
    return (error as { code?: string }).code ?? `NON_CODED:${String(error)}`
  }
  return 'NO_THROW'
}

describe('VendorService', () => {
  it('keeps vendors with a payment schedule in integer cents, and lists the unpaid installments soonest first', () => {
    const w = world()
    const added = w.vendors.addVendor(w.ctx, w.planner, w.ours, hall)
    expect(added).toMatchObject({ business_name: 'The Hall', contract_status: 'signed', shared_with_couple: true })
    expect(added.installments.map((i) => [i.label, i.amount_cents, i.deposit, i.paid, i.paid_at])).toEqual([
      ['Deposit', 150_000, true, true, '2028-01-10T12:00:00.000Z'],
      ['Final payment', 350_050, false, false, undefined],
    ])
    w.vendors.addVendor(w.ctx, w.planner, w.ours, { category: 'other', category_other: 'Fireworks', business_name: 'Boom', contract_status: 'sent', installments: [{ label: 'All', amount_cents: 99, due_date: '2028-01-05' }] })
    const view = w.vendors.view(w.ctx, w.planner, w.ours)
    expect(view.due_next.map((d) => [d.business_name, d.installment.label, d.overdue])).toEqual([
      ['Boom', 'All', true],
      ['The Hall', 'Final payment', false],
    ])
    expect(view.can_manage).toBe(true)
  })

  it('installments keep their ids and paid state across edits; marking paid records when, once', () => {
    const w = world()
    const v = w.vendors.addVendor(w.ctx, w.planner, w.ours, hall)
    const [deposit, final] = v.installments
    const edited = w.vendors.updateVendor(w.ctx, w.planner, w.ours, v.vendor_id, {
      ...hall,
      installments: [
        { installment_id: deposit?.installment_id, label: 'Booking deposit', amount_cents: 150_000, due_date: '2027-12-02', deposit: true },
        { installment_id: final?.installment_id, label: 'Balance', amount_cents: 350_050, due_date: '2028-05-10' },
        { label: 'Extra hour', amount_cents: 20_000, due_date: '2028-06-10' },
      ],
    })
    expect(edited.installments.map((i) => [i.installment_id === deposit?.installment_id, i.label, i.paid, i.paid_at])).toEqual([
      [true, 'Booking deposit', true, '2028-01-10T12:00:00.000Z'],
      [false, 'Balance', false, undefined],
      [false, 'Extra hour', false, undefined],
    ])
    w.clock.advance(3_600_000)
    const paid = w.vendors.setInstallmentPaid(w.ctx, w.planner, w.ours, v.vendor_id, final?.installment_id as string, true)
    expect(paid.installments[1]).toMatchObject({ paid: true, paid_at: '2028-01-10T13:00:00.000Z' })
    w.clock.advance(3_600_000)
    expect(w.vendors.setInstallmentPaid(w.ctx, w.planner, w.ours, v.vendor_id, final?.installment_id as string, true).installments[1]?.paid_at).toBe('2028-01-10T13:00:00.000Z')
    expect(w.vendors.setInstallmentPaid(w.ctx, w.planner, w.ours, v.vendor_id, final?.installment_id as string, false).installments[1]?.paid_at).toBeUndefined()
    expect(codeOf(() => w.vendors.setInstallmentPaid(w.ctx, w.planner, w.ours, v.vendor_id, 'inst_other', true))).toBe('PRODUCT.NOT_FOUND')
  })

  it('refuses floats, negatives, huge amounts, unreal dates, two deposits, foreign installment ids, and a bad email', () => {
    const w = world()
    const one = (installment: object) => () => w.vendors.addVendor(w.ctx, w.planner, w.ours, { ...hall, installments: [installment as never] })
    for (const amount_cents of [10.5, -1, 100_000_000_001, Number.NaN]) expect(codeOf(one({ label: 'X', amount_cents, due_date: '2028-01-01' }))).toBe('PRODUCT.BAD_REQUEST')
    expect(codeOf(one({ label: 'X', amount_cents: 1, due_date: '2028-02-30' }))).toBe('PRODUCT.BAD_REQUEST')
    expect(codeOf(one({ label: 'X', amount_cents: 1, due_date: '2028-01-01', installment_id: 'inst_forged' }))).toBe('PRODUCT.BAD_REQUEST')
    expect(codeOf(() => w.vendors.addVendor(w.ctx, w.planner, w.ours, { ...hall, installments: [{ label: 'A', amount_cents: 1, due_date: '2028-01-01', deposit: true }, { label: 'B', amount_cents: 1, due_date: '2028-01-02', deposit: true }] }))).toBe('PRODUCT.BAD_REQUEST')
    expect(codeOf(() => w.vendors.addVendor(w.ctx, w.planner, w.ours, { ...hall, email: 'nope' }))).toBe('PRODUCT.BAD_REQUEST')
    expect(codeOf(() => w.vendors.addVendor(w.ctx, w.planner, w.ours, { ...hall, category: 'other' }))).toBe('PRODUCT.BAD_REQUEST')
    expect(codeOf(() => w.vendors.addVendor(w.ctx, w.planner, w.ours, { ...hall, business_name: 'A‮B' }))).toBe('PRODUCT.BAD_REQUEST')
    const many = Array.from({ length: 25 }, (_, i) => ({ label: `#${i}`, amount_cents: 1, due_date: '2028-01-01' }))
    expect(codeOf(() => w.vendors.addVendor(w.ctx, w.planner, w.ours, { ...hall, installments: many }))).toBe('PRODUCT.BAD_REQUEST')
  })

  it("the couple sees only shared vendors, without the planner's notes, and manages nothing (403)", () => {
    const w = world()
    w.vendors.addVendor(w.ctx, w.planner, w.ours, hall)
    const hidden = w.vendors.addVendor(w.ctx, w.planner, w.ours, { ...hall, business_name: 'Secret Caterer', shared_with_couple: false })
    const view = w.vendors.view(w.ctx, w.couple, w.ours)
    expect(view.vendors.map((v) => v.business_name)).toEqual(['The Hall'])
    expect(view.vendors[0]?.notes).toBeUndefined()
    expect(view.due_next.map((d) => d.business_name)).toEqual(['The Hall'])
    expect(view.can_manage).toBe(false)
    expect(JSON.stringify(view)).not.toContain('Secret Caterer')
    expect(codeOf(() => w.vendors.addVendor(w.ctx, w.couple, w.ours, hall))).toBe('PRODUCT.FORBIDDEN')
    expect(codeOf(() => w.vendors.updateVendor(w.ctx, w.couple, w.ours, hidden.vendor_id, hall))).toBe('PRODUCT.FORBIDDEN')
    expect(codeOf(() => w.vendors.removeVendor(w.ctx, w.couple, w.ours, hidden.vendor_id))).toBe('PRODUCT.FORBIDDEN')
  })

  it("another wedding is the masked NOT_FOUND for the couple; a sibling wedding's vendor is not found here", () => {
    const w = world()
    const theirs = w.vendors.addVendor(w.ctx, w.planner, w.theirs, hall)
    expect(codeOf(() => w.vendors.view(w.ctx, w.couple, w.theirs))).toBe('PRODUCT.NOT_FOUND')
    expect(codeOf(() => w.vendors.view(w.ctx, w.couple, 'wedding_missing'))).toBe('PRODUCT.NOT_FOUND')
    expect(codeOf(() => w.vendors.updateVendor(w.ctx, w.planner, w.ours, theirs.vendor_id, hall))).toBe('PRODUCT.NOT_FOUND')
    expect(w.vendors.removeVendor(w.ctx, w.planner, w.ours, theirs.vendor_id)).toBe(false)
  })

  it('reads money typed by people as whole cents, and refuses anything else', () => {
    expect(centsFromText('1250')).toBe(125_000)
    expect(centsFromText(' 1,250.5 ')).toBe(125_050)
    expect(centsFromText('0.07')).toBe(7)
    expect(centsFromText('1,234,567.89')).toBe(123_456_789)
    for (const bad of ['', '12.345', '-5', '1e3', 'abc', '1234567890', '12,34', '1,5', ',1', '1,,000', '12,3456', '1,000,00']) expect(centsFromText(bad)).toBeUndefined()
  })
})
