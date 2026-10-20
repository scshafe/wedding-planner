import { type BudgetCategory, type Clock, getSchemaRegistry, type IdGenerator, type WeddingVendor } from '@wedding-planner/shared'

import type { Principal } from '../auth/principal'
import type { WeddingAuthorizer } from '../auth/wedding_authorizer'
import { COLLECTIONS } from '../persistence/collections'
import { groupedKey, type RecordStore } from '../persistence/record_store'
import { ProductError } from '../product_error'
import type { TenantContext } from '../tenant/tenant_context'
import { TenantScopedRepository } from '../tenant/tenant_scoped_repository'
import type { TenantLivenessCheck } from '../tenant/tenant_store'
import { assertPlainText } from '../text/plain_text'
import { MAX_AMOUNT_CENTS, type VendorService } from '../vendors/vendor_service'
import { assertWeddingReach } from '../wedding/wedding_reach'
import type { WeddingRepository } from '../wedding/wedding_repository'

/**
 * @canonical budget_service -- a wedding's budget (issue #34, ADR 0052): lines with an estimate and an actual amount,
 * in integer cents; a line linked to one of the wedding's vendors takes its actual, paid and still-due amounts from
 * that vendor's payment schedule (`VendorService.vendorsOf`), and its next payments from the unpaid installments.
 * Money is tracked, never moved.
 *
 * The boundary is the wedding's (`assertWeddingReach`). The planner manages the budget; the couple sees the lines the
 * planner shares and the totals of those lines only. A shared line linked to a vendor the couple may not see shows
 * its amounts under the line's own name — never the vendor's. A couple's management call is PRODUCT.FORBIDDEN.
 *
 * related: vendor_service.ts (the schedules), budget_category_schema.json (the contract).
 */

/** Bounds on one wedding's budget. */
export const BUDGET_LIMITS = Object.freeze({ categories: 60 })

/** How many next payments the view lists. */
export const NEXT_PAYMENTS_LISTED = 10

export interface BudgetCategoryInput {
  readonly name: string
  readonly estimated_cents: number
  /** Ignored for amounts while linked to a vendor (kept for when the link goes). */
  readonly actual_cents?: number
  readonly paid_cents?: number
  /** A vendor of the same wedding, or absent for a manual line. */
  readonly vendor_id?: string
  readonly shared_with_couple?: boolean
}

/** One line as the view shows it: its amounts resolved (from the vendor when linked). */
export interface BudgetLine {
  readonly category: BudgetCategory
  readonly actual_cents: number
  readonly paid_cents: number
  readonly due_cents: number
  /** The linked vendor's name, when this principal may see that vendor. */
  readonly vendor_name?: string
  /** Linked to a vendor that no longer exists: the manual amounts apply. */
  readonly vendor_missing: boolean
}

export interface BudgetTotals {
  readonly estimated_cents: number
  readonly actual_cents: number
  readonly paid_cents: number
  readonly due_cents: number
}

export interface NextPayment {
  /** The line's name (never a vendor the principal may not see). */
  readonly category_name: string
  readonly label: string
  readonly amount_cents: number
  readonly due_date: string
  readonly overdue: boolean
}

export interface BudgetView {
  readonly today: string
  readonly lines: readonly BudgetLine[]
  /** Over the lines in this view (the couple's: the shared ones only). */
  readonly totals: BudgetTotals
  /** The soonest unpaid installments of the linked vendors, at most {@link NEXT_PAYMENTS_LISTED}. */
  readonly next_payments: readonly NextPayment[]
  readonly can_manage: boolean
  /** The wedding's vendors a line may link to (the planner's view only). */
  readonly vendors: readonly { readonly vendor_id: string; readonly business_name: string }[]
}

export class BudgetService {
  readonly #categories: TenantScopedRepository<BudgetCategory>

  constructor(
    liveness: TenantLivenessCheck,
    private readonly weddings: WeddingRepository,
    private readonly authorizer: WeddingAuthorizer,
    private readonly vendors: Pick<VendorService, 'vendorsOf'>,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
    store?: RecordStore,
    private readonly limits: { readonly categories: number } = BUDGET_LIMITS,
  ) {
    this.#categories = new TenantScopedRepository<BudgetCategory>(liveness, (c) => groupedKey(c.wedding_id, c.category_id), COLLECTIONS.budgetCategory, store)
  }

  /** The wedding's boundary alone (the HTTP edge calls it before parsing a body). */
  assertReach(context: TenantContext, principal: Principal, wedding_id: string): void {
    assertWeddingReach(this.authorizer, this.weddings, context, principal, wedding_id)
  }

  view(context: TenantContext, principal: Principal, wedding_id: string): BudgetView {
    this.assertReach(context, principal, wedding_id)
    const planner = principal.role === 'planner'
    const today = this.clock.now().slice(0, 10)
    const vendors = new Map(this.vendors.vendorsOf(context, wedding_id).map((v) => [v.vendor_id, v]))
    const lines = this.#categoriesOf(context, wedding_id)
      .filter((c) => planner || c.shared_with_couple)
      .map((category) => lineOf(category, category.vendor_id === undefined ? undefined : vendors.get(category.vendor_id), planner))
    const totals = lines.reduce<BudgetTotals>(
      (t, l) => ({
        estimated_cents: t.estimated_cents + l.category.estimated_cents,
        actual_cents: t.actual_cents + l.actual_cents,
        paid_cents: t.paid_cents + l.paid_cents,
        due_cents: t.due_cents + l.due_cents,
      }),
      { estimated_cents: 0, actual_cents: 0, paid_cents: 0, due_cents: 0 },
    )
    const next_payments = lines
      .flatMap((l) => {
        const vendor = l.category.vendor_id === undefined ? undefined : vendors.get(l.category.vendor_id)
        // An installment's label is the planner's free text on the vendor: the couple reads it only for a vendor it
        // may see; otherwise a neutral label from the structured fields.
        const labelled = planner || vendor?.shared_with_couple === true
        return (vendor?.installments ?? [])
          .filter((i) => !i.paid)
          .map((i) => ({
            category_name: l.category.name,
            label: labelled ? i.label : i.deposit ? 'Deposit' : 'Payment',
            amount_cents: i.amount_cents,
            due_date: i.due_date,
            overdue: i.due_date < today,
          }))
      })
      .sort((a, b) => (a.due_date < b.due_date ? -1 : a.due_date > b.due_date ? 1 : 0))
      .slice(0, NEXT_PAYMENTS_LISTED)
    return {
      today,
      lines: planner ? lines : lines.map(asTheCoupleSeesIt),
      totals,
      next_payments,
      can_manage: planner,
      vendors: planner ? [...vendors.values()].map((v) => ({ vendor_id: v.vendor_id, business_name: v.business_name })) : [],
    }
  }

  addCategory(context: TenantContext, principal: Principal, wedding_id: string, input: BudgetCategoryInput): BudgetCategory {
    this.assertReach(context, principal, wedding_id)
    this.#planner(principal)
    if (this.#categoriesOf(context, wedding_id).length >= this.limits.categories) {
      throw new ProductError('PRODUCT.LIMIT_REACHED', 'This wedding has reached the budget limit.', {})
    }
    return this.#put(context, {
      category_id: this.ids.next('budget'),
      tenant_id: context.tenant_id,
      wedding_id,
      ...this.#fields(context, wedding_id, input),
      created_at: this.clock.now(),
    })
  }

  updateCategory(context: TenantContext, principal: Principal, wedding_id: string, category_id: string, input: BudgetCategoryInput): BudgetCategory {
    this.assertReach(context, principal, wedding_id)
    this.#planner(principal)
    const existing = this.#category(context, wedding_id, category_id)
    return this.#put(context, {
      category_id: existing.category_id,
      tenant_id: existing.tenant_id,
      wedding_id: existing.wedding_id,
      ...this.#fields(context, wedding_id, input, existing.category_id),
      created_at: existing.created_at,
      updated_at: this.clock.now(),
    })
  }

  /** Remove a line. Returns whether it existed. */
  removeCategory(context: TenantContext, principal: Principal, wedding_id: string, category_id: string): boolean {
    this.assertReach(context, principal, wedding_id)
    this.#planner(principal)
    if (category_id.length === 0 || this.#categories.read(context, groupedKey(wedding_id, category_id))?.wedding_id !== wedding_id) return false
    return this.#categories.delete(context, groupedKey(wedding_id, category_id))
  }

  #fields(
    context: TenantContext,
    wedding_id: string,
    input: BudgetCategoryInput,
    editing?: string,
  ): Omit<BudgetCategory, 'category_id' | 'tenant_id' | 'wedding_id' | 'created_at' | 'updated_at'> {
    assertPlainText([input.name])
    for (const amount of [input.estimated_cents, input.actual_cents ?? 0, input.paid_cents ?? 0]) {
      if (!Number.isSafeInteger(amount) || amount < 0 || amount > MAX_AMOUNT_CENTS) {
        throw new ProductError('PRODUCT.BAD_REQUEST', 'An amount is a whole number of cents, from 0 to one billion.', {})
      }
    }
    const vendor_id = input.vendor_id !== undefined && input.vendor_id.length > 0 ? input.vendor_id : undefined
    if (vendor_id !== undefined && !this.vendors.vendorsOf(context, wedding_id).some((v) => v.vendor_id === vendor_id)) {
      throw new ProductError('PRODUCT.BAD_REQUEST', 'That vendor is not on this wedding.', {})
    }
    // One line per vendor: a vendor followed by two lines would count its schedule twice in every total.
    if (vendor_id !== undefined && this.#categoriesOf(context, wedding_id).some((c) => c.vendor_id === vendor_id && c.category_id !== editing)) {
      throw new ProductError('PRODUCT.BAD_REQUEST', 'Another budget line already follows that vendor.', {})
    }
    return {
      name: input.name.trim(),
      estimated_cents: input.estimated_cents,
      actual_cents: input.actual_cents ?? 0,
      paid_cents: input.paid_cents ?? 0,
      ...(vendor_id === undefined ? {} : { vendor_id }),
      shared_with_couple: input.shared_with_couple === true,
    }
  }

  #categoriesOf(context: TenantContext, wedding_id: string): BudgetCategory[] {
    return this.#categories.listGroup(context, wedding_id).filter((c) => c.wedding_id === wedding_id)
  }

  #category(context: TenantContext, wedding_id: string, category_id: string): BudgetCategory {
    const category = category_id.length === 0 ? undefined : this.#categories.read(context, groupedKey(wedding_id, category_id))
    if (category === undefined || category.wedding_id !== wedding_id) throw new ProductError('PRODUCT.NOT_FOUND', 'No such budget line on this wedding.', {})
    return category
  }

  #put(context: TenantContext, category: BudgetCategory): BudgetCategory {
    getSchemaRegistry().assertValid<BudgetCategory>('budget_category', category)
    return this.#categories.put(context, category)
  }

  #planner(principal: Principal): void {
    if (principal.role !== 'planner') throw new ProductError('PRODUCT.FORBIDDEN', 'Only the planner manages the budget.', {})
  }
}

/** A line's amounts: from the linked vendor's schedule when there is one, else the manual amounts. */
function lineOf(category: BudgetCategory, vendor: WeddingVendor | undefined, planner: boolean): BudgetLine {
  const linked = category.vendor_id !== undefined
  if (vendor === undefined) {
    return {
      category,
      actual_cents: category.actual_cents,
      paid_cents: category.paid_cents,
      due_cents: Math.max(0, category.actual_cents - category.paid_cents),
      vendor_missing: linked,
    }
  }
  const actual = vendor.installments.reduce((n, i) => n + i.amount_cents, 0)
  const paid = vendor.installments.filter((i) => i.paid).reduce((n, i) => n + i.amount_cents, 0)
  return {
    category,
    actual_cents: actual,
    paid_cents: paid,
    due_cents: actual - paid,
    ...(planner || vendor.shared_with_couple ? { vendor_name: vendor.business_name } : {}),
    vendor_missing: false,
  }
}

/**
 * A line as the couple sees it, from an allow-list: its name, estimate and resolved amounts, and the vendor's name
 * only when that vendor is shared. Whether it follows an unshared vendor — the vendor id, the planner's fallback
 * amounts that would differ from the resolved ones, a vendor that was removed — stays with the planner.
 */
function asTheCoupleSeesIt(line: BudgetLine): BudgetLine {
  const c = line.category
  return {
    category: {
      category_id: c.category_id,
      tenant_id: c.tenant_id,
      wedding_id: c.wedding_id,
      name: c.name,
      estimated_cents: c.estimated_cents,
      actual_cents: line.actual_cents,
      paid_cents: line.paid_cents,
      shared_with_couple: c.shared_with_couple,
      created_at: c.created_at,
    },
    actual_cents: line.actual_cents,
    paid_cents: line.paid_cents,
    due_cents: line.due_cents,
    ...(line.vendor_name === undefined ? {} : { vendor_name: line.vendor_name }),
    vendor_missing: false,
  }
}
