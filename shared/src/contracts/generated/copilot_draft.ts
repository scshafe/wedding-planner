/* eslint-disable */
/**
 * GENERATED from product/schemas/copilot_draft_schema.json — DO NOT EDIT BY HAND.
 * The JSON Schema file is the source of truth. Regenerate with: npm run gen:types
 */

/**
 * A wedding's planner-copilot draft (issue #61, ADR 0058): proposed tasks and run-of-show items, checked against the wedding, waiting for the planner to keep some, all or none. One per wedding, keyed by wedding_id. Nothing here is on the checklist or the run of show until the planner accepts it through those services.
 */
export interface CopilotDraft {
/**
 * The owning tenant. Compared to the context's tenant only; never selects the partition.
 */
tenant_id: string
wedding_id: string
status: ("drafting" | "ready" | "failed")
/**
 * ISO 8601 UTC time the draft was asked for, from the injected clock.
 */
requested_at: string
/**
 * The principal who asked (a planner).
 */
requested_by: string
updated_at?: string
tasks: {
draft_id: string
title: string
due_date: string
assignee: ("planner" | "couple")
}[]
run_of_show: {
draft_id: string
title: string
starts_at: string
owner: ("planner" | "couple" | "vendor")
vendor_id?: string
event_id?: string
}[]
}
