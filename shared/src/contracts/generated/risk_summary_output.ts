/* eslint-disable */
/**
 * GENERATED from product/schemas/risk_summary_output_schema.json — DO NOT EDIT BY HAND.
 * The JSON Schema file is the source of truth. Regenerate with: npm run gen:types
 */

/**
 * What the model returns for a wedding's weekly risk summary (issue #62, ADR 0060): a level and the signals to mention, most urgent first. Untrusted model output: it never carries text — each line is worded from the signal's own data — and only signals the job computed may be mentioned. The count is bounded in code.
 */
export interface RiskSummaryOutput {
level: ("on_track" | "watch" | "at_risk")
mention: ("overdue_tasks" | "tasks_due_soon" | "payments_overdue" | "payments_due_soon" | "rsvps_missing" | "guests_unseated" | "contracts_unsigned")[]
}
