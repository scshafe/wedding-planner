/* eslint-disable */
/**
 * GENERATED from product/schemas/budget_category_schema.json — DO NOT EDIT BY HAND.
 * The JSON Schema file is the source of truth. Regenerate with: npm run gen:types
 */

/**
 * One line of a wedding's budget (issue #34): an estimate and what it actually costs, in integer cents. When it is linked to a vendor of the wedding, its actual, paid and still-due amounts come from that vendor's payment schedule instead of the manual amounts here. Money is tracked, never moved. The couple sees a category only when the planner shares it. Stored under groupedKey(wedding_id, category_id).
 */
export interface BudgetCategory {
/**
 * Identity within the owning tenant's partition, from the injected id generator.
 */
category_id: string
/**
 * The owning tenant. Compared to the context's tenant only; never selects the partition.
 */
tenant_id: string
wedding_id: string
name: string
/**
 * What it was expected to cost, in integer cents.
 */
estimated_cents: number
/**
 * What it costs, when not linked to a vendor (a linked category uses the vendor's schedule total).
 */
actual_cents: number
/**
 * What is paid so far, when not linked to a vendor (a linked category uses the vendor's paid installments).
 */
paid_cents: number
/**
 * A vendor of the same wedding whose payment schedule this line follows.
 */
vendor_id?: string
/**
 * Whether the wedding's couple sees this line (the planner's call).
 */
shared_with_couple: boolean
/**
 * ISO 8601 UTC creation time, from the injected clock.
 */
created_at: string
/**
 * ISO 8601 UTC time of the last change, when changed.
 */
updated_at?: string
}
