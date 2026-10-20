/* eslint-disable */
/**
 * GENERATED from product/schemas/risk_summary_schema.json — DO NOT EDIT BY HAND.
 * The JSON Schema file is the source of truth. Regenerate with: npm run gen:types
 */

/**
 * A wedding's risk summary for one ISO week (issue #62, ADR 0060): the level and the lines worded from that week's signals. One per wedding, keyed by wedding_id, replaced each week. The planner's only.
 */
export interface RiskSummary {
/**
 * The owning tenant. Compared to the context's tenant only; never selects the partition.
 */
tenant_id: string
wedding_id: string
week: string
level: ("on_track" | "watch" | "at_risk")
lines: string[]
generated_at: string
}
