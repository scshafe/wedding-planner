import { type Clock, getSchemaRegistry, type IdGenerator, type WeddingVendor } from '@wedding-planner/shared'

import type { Principal } from '../auth/principal'
import type { WeddingAuthorizer } from '../auth/wedding_authorizer'
import { isEmailAddress } from '../email/email_port'
import { COLLECTIONS } from '../persistence/collections'
import { groupedKey, type RecordStore } from '../persistence/record_store'
import { ProductError } from '../product_error'
import type { TenantContext } from '../tenant/tenant_context'
import { TenantScopedRepository } from '../tenant/tenant_scoped_repository'
import type { TenantLivenessCheck } from '../tenant/tenant_store'
import { assertPlainText } from '../text/plain_text'
import { isDate } from '../wedding/calendar_date'
import { assertWeddingReach } from '../wedding/wedding_reach'
import type { WeddingRepository } from '../wedding/wedding_repository'

/**
 * @canonical vendor_service -- a wedding's vendors and their payment schedules (issue #33, ADR 0051).
 *
 * Money is tracked, never moved: amounts are integer cents (never floats), and there is no payment provider. A
 * payment schedule is a list of installments (a label, an amount, a due date, paid or not), one of which may be the
 * deposit. Installments keep their ids across edits, so "paid" survives renaming or rescheduling one.
 *
 * The boundary is the wedding's (`assertWeddingReach`). The planner manages vendors; the couple sees only the vendors
 * the planner shares, without the planner's notes, and nothing else — an unshared vendor is not in the couple's view
 * at all. A couple's management call is PRODUCT.FORBIDDEN (an honest 403 on its own wedding).
 *
 * related: wedding_vendor_schema.json (the contract), the budget (issue #34) reads `vendorsOf`.
 */

/** Bounds on one wedding's vendors; the raw installment list is capped before any per-item work. */
export const VENDOR_LIMITS = Object.freeze({ vendors: 100, installments: 24 })

/** The vendor categories, from the contract (the web form's choices; `other` names its own). */
export const VENDOR_CATEGORIES = Object.freeze([
  'venue',
  'catering',
  'photography',
  'videography',
  'music',
  'flowers',
  'attire',
  'beauty',
  'cake',
  'transport',
  'officiant',
  'stationery',
  'rentals',
  'other',
] as const satisfies readonly WeddingVendor['category'][])

/** The largest amount one installment may carry: one billion (in cents), far past any wedding. */
export const MAX_AMOUNT_CENTS = 100_000_000_000

export type VendorCategory = WeddingVendor['category']
export type ContractStatus = WeddingVendor['contract_status']
export type Installment = WeddingVendor['installments'][number]

export interface InstallmentInput {
  /** An existing installment of this vendor (an edit keeps it, and whether it was paid); absent for a new one. */
  readonly installment_id?: string
  readonly label: string
  readonly amount_cents: number
  /** YYYY-MM-DD. */
  readonly due_date: string
  readonly deposit?: boolean
  readonly paid?: boolean
}

export interface VendorInput {
  readonly category: VendorCategory
  readonly category_other?: string
  readonly business_name: string
  readonly contact_name?: string
  readonly email?: string
  readonly phone?: string
  readonly contract_status: ContractStatus
  /** The whole schedule, in order: an installment left out is removed. */
  readonly installments?: readonly InstallmentInput[]
  readonly shared_with_couple?: boolean
  readonly notes?: string
}

/** One unpaid installment, with its vendor, for "what is due next". */
export interface DueInstallment {
  readonly vendor_id: string
  readonly business_name: string
  readonly installment: Installment
  readonly overdue: boolean
}

export interface VendorsView {
  /** Today, by the injected clock (YYYY-MM-DD). */
  readonly today: string
  /** The vendors this principal sees (the couple: shared ones only, without notes). */
  readonly vendors: readonly WeddingVendor[]
  /** Every unpaid installment of those vendors, soonest first. */
  readonly due_next: readonly DueInstallment[]
  /** Whether this principal manages the vendors (the planner). */
  readonly can_manage: boolean
}

export class VendorService {
  readonly #vendors: TenantScopedRepository<WeddingVendor>

  constructor(
    liveness: TenantLivenessCheck,
    private readonly weddings: WeddingRepository,
    private readonly authorizer: WeddingAuthorizer,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
    store?: RecordStore,
    private readonly limits: { readonly vendors: number; readonly installments: number } = VENDOR_LIMITS,
  ) {
    this.#vendors = new TenantScopedRepository<WeddingVendor>(liveness, (v) => groupedKey(v.wedding_id, v.vendor_id), COLLECTIONS.weddingVendor, store)
  }

  /** The wedding's boundary alone (the HTTP edge calls it before parsing a body). */
  assertReach(context: TenantContext, principal: Principal, wedding_id: string): void {
    assertWeddingReach(this.authorizer, this.weddings, context, principal, wedding_id)
  }

  view(context: TenantContext, principal: Principal, wedding_id: string): VendorsView {
    this.assertReach(context, principal, wedding_id)
    const today = this.clock.now().slice(0, 10)
    const planner = principal.role === 'planner'
    const vendors = this.vendorsOf(context, wedding_id)
      .filter((v) => planner || v.shared_with_couple)
      .map((v) => (planner ? v : withoutNotes(v)))
    const due_next = vendors
      .flatMap((v) => v.installments.filter((i) => !i.paid).map((installment) => ({ vendor_id: v.vendor_id, business_name: v.business_name, installment, overdue: installment.due_date < today })))
      .sort((a, b) => (a.installment.due_date < b.installment.due_date ? -1 : a.installment.due_date > b.installment.due_date ? 1 : 0))
    return { today, vendors, due_next, can_manage: planner }
  }

  /** Every vendor of the wedding, in the order they were added. No boundary check: callers have established reach. */
  vendorsOf(context: TenantContext, wedding_id: string): WeddingVendor[] {
    return this.#vendors.listGroup(context, wedding_id).filter((v) => v.wedding_id === wedding_id)
  }

  addVendor(context: TenantContext, principal: Principal, wedding_id: string, input: VendorInput): WeddingVendor {
    this.assertReach(context, principal, wedding_id)
    this.#planner(principal)
    if (this.vendorsOf(context, wedding_id).length >= this.limits.vendors) {
      throw new ProductError('PRODUCT.LIMIT_REACHED', 'This wedding has reached the vendor limit.', {})
    }
    return this.#put(context, {
      vendor_id: this.ids.next('vendor'),
      tenant_id: context.tenant_id,
      wedding_id,
      ...this.#fields(input, []),
      created_at: this.clock.now(),
    })
  }

  updateVendor(context: TenantContext, principal: Principal, wedding_id: string, vendor_id: string, input: VendorInput): WeddingVendor {
    this.assertReach(context, principal, wedding_id)
    this.#planner(principal)
    const existing = this.#vendor(context, wedding_id, vendor_id)
    return this.#put(context, {
      vendor_id: existing.vendor_id,
      tenant_id: existing.tenant_id,
      wedding_id: existing.wedding_id,
      ...this.#fields(input, existing.installments),
      created_at: existing.created_at,
      updated_at: this.clock.now(),
    })
  }

  /** Mark one installment paid or unpaid (the planner records it; no money moves). */
  setInstallmentPaid(context: TenantContext, principal: Principal, wedding_id: string, vendor_id: string, installment_id: string, paid: boolean): WeddingVendor {
    this.assertReach(context, principal, wedding_id)
    this.#planner(principal)
    const existing = this.#vendor(context, wedding_id, vendor_id)
    if (!existing.installments.some((i) => i.installment_id === installment_id)) {
      throw new ProductError('PRODUCT.NOT_FOUND', 'No such installment on this vendor.', {})
    }
    const installments = existing.installments.map((i) => (i.installment_id === installment_id ? paidAs(i, paid, this.clock.now()) : i))
    return this.#put(context, { ...existing, installments, updated_at: this.clock.now() })
  }

  /** Remove a vendor. Returns whether it existed. */
  removeVendor(context: TenantContext, principal: Principal, wedding_id: string, vendor_id: string): boolean {
    this.assertReach(context, principal, wedding_id)
    this.#planner(principal)
    if (vendor_id.length === 0 || this.#vendors.read(context, groupedKey(wedding_id, vendor_id))?.wedding_id !== wedding_id) return false
    return this.#vendors.delete(context, groupedKey(wedding_id, vendor_id))
  }

  /** The editable fields, normalized and checked; installments keep their ids (and paid state) across edits. */
  #fields(input: VendorInput, previous: readonly Installment[]): Omit<WeddingVendor, 'vendor_id' | 'tenant_id' | 'wedding_id' | 'created_at' | 'updated_at'> {
    const raw = input.installments ?? []
    if (raw.length > this.limits.installments) {
      throw new ProductError('PRODUCT.BAD_REQUEST', `A vendor has at most ${this.limits.installments} installments.`, {})
    }
    assertPlainText([input.category_other, input.business_name, input.contact_name, input.email, input.phone, ...raw.map((i) => i.label)])
    assertPlainText([input.notes], { multiline: true })
    const email = input.email?.trim()
    if (email !== undefined && email.length > 0 && !isEmailAddress(email)) throw new ProductError('PRODUCT.BAD_REQUEST', 'That email address is not valid.', {})
    const categoryOther = input.category_other?.trim()
    if (input.category === 'other' && (categoryOther === undefined || categoryOther.length === 0)) {
      throw new ProductError('PRODUCT.BAD_REQUEST', 'Name the category when it is "other".', {})
    }
    const byId = new Map(previous.map((i) => [i.installment_id, i]))
    const seen = new Set<string>()
    const now = this.clock.now()
    const installments = raw.map((entry): Installment => {
      if (!Number.isSafeInteger(entry.amount_cents) || entry.amount_cents < 0 || entry.amount_cents > MAX_AMOUNT_CENTS) {
        throw new ProductError('PRODUCT.BAD_REQUEST', 'An amount is a whole number of cents, from 0 to one billion.', {})
      }
      if (!isDate(entry.due_date)) throw new ProductError('PRODUCT.BAD_REQUEST', 'An installment is due on a real date (YYYY-MM-DD).', {})
      const id = entry.installment_id !== undefined && entry.installment_id.length > 0 ? entry.installment_id : undefined
      if (id !== undefined && (!byId.has(id) || seen.has(id))) throw new ProductError('PRODUCT.BAD_REQUEST', 'That installment is not on this vendor.', {})
      if (id !== undefined) seen.add(id)
      const before = id === undefined ? undefined : byId.get(id)
      const base: Installment = {
        installment_id: id ?? this.ids.next('inst'),
        label: entry.label.trim(),
        amount_cents: entry.amount_cents,
        due_date: entry.due_date,
        deposit: entry.deposit === true,
        paid: false,
      }
      return paidAs({ ...base, ...(before?.paid === true && before.paid_at !== undefined ? { paid: true, paid_at: before.paid_at } : {}) }, entry.paid ?? before?.paid ?? false, now)
    })
    if (installments.filter((i) => i.deposit).length > 1) throw new ProductError('PRODUCT.BAD_REQUEST', 'A vendor has at most one deposit.', {})
    const optional = (value: string | undefined) => {
      const trimmed = value?.trim()
      return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed
    }
    const contact_name = optional(input.contact_name)
    const phone = optional(input.phone)
    const notes = optional(input.notes)
    return {
      category: input.category,
      ...(input.category === 'other' ? { category_other: categoryOther as string } : {}),
      business_name: input.business_name.trim(),
      ...(contact_name === undefined ? {} : { contact_name }),
      ...(email === undefined || email.length === 0 ? {} : { email }),
      ...(phone === undefined ? {} : { phone }),
      contract_status: input.contract_status,
      installments,
      shared_with_couple: input.shared_with_couple === true,
      ...(notes === undefined ? {} : { notes }),
    }
  }

  #put(context: TenantContext, vendor: WeddingVendor): WeddingVendor {
    getSchemaRegistry().assertValid<WeddingVendor>('wedding_vendor', vendor)
    return this.#vendors.put(context, vendor)
  }

  #vendor(context: TenantContext, wedding_id: string, vendor_id: string): WeddingVendor {
    const vendor = vendor_id.length === 0 ? undefined : this.#vendors.read(context, groupedKey(wedding_id, vendor_id))
    if (vendor === undefined || vendor.wedding_id !== wedding_id) throw new ProductError('PRODUCT.NOT_FOUND', 'No such vendor on this wedding.', {})
    return vendor
  }

  #planner(principal: Principal): void {
    if (principal.role !== 'planner') throw new ProductError('PRODUCT.FORBIDDEN', 'Only the planner manages vendors.', {})
  }
}

/** An installment marked paid (keeping when it first was) or unpaid. */
function paidAs(installment: Installment, paid: boolean, now: string): Installment {
  const { paid_at: when, ...rest } = installment
  if (!paid) return { ...rest, paid: false }
  return { ...rest, paid: true, paid_at: installment.paid ? (when ?? now) : now }
}

/** A vendor as the couple sees it: the planner's notes stay with the planner. */
function withoutNotes(vendor: WeddingVendor): WeddingVendor {
  const shared: WeddingVendor = { ...vendor }
  delete shared.notes
  return shared
}

/** Whole cents from what a person types as money ("1234.5", "1,234.56"); undefined when it is not an amount. */
export function centsFromText(text: string): number | undefined {
  const plain = text.trim().replace(/,/g, '')
  if (!/^\d{1,9}(\.\d{1,2})?$/.test(plain)) return undefined
  const [whole, fraction = ''] = plain.split('.') as [string, string?]
  return Number(whole) * 100 + Number(fraction.padEnd(2, '0'))
}
