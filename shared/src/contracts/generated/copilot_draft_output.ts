/* eslint-disable */
/**
 * GENERATED from product/schemas/copilot_draft_output_schema.json — DO NOT EDIT BY HAND.
 * The JSON Schema file is the source of truth. Regenerate with: npm run gen:types
 */

/**
 * What the model returns for the planner copilot's draft (issue #61, ADR 0058): proposed checklist tasks and run-of-show items. Untrusted model output: it names vendors and events only by their index in the request's input, never by an id, and is checked against that input before it is shown. List sizes are bounded in code.
 */
export interface CopilotDraftOutput {
tasks: {
title: string
due_date: string
assignee: ("planner" | "couple")
}[]
run_of_show: {
title: string
starts_at: string
owner: ("planner" | "couple" | "vendor")
/**
 * The vendor, by its position in the request's vendor list (a vendor's item).
 */
vendor_index?: number
/**
 * The event it belongs to, by its position in the request's event list.
 */
event_index?: number
}[]
}
