/* eslint-disable */
/**
 * GENERATED from product/schemas/checklist_date_move_schema.json — DO NOT EDIT BY HAND.
 * The JSON Schema file is the source of truth. Regenerate with: npm run gen:types
 */

/**
 * A wedding date that moved while its checklist had tasks (issue #31): recorded by the server when the wedding's date changes, so the offer to move the open tasks is built from server data, never from a URL. Keyed by wedding_id; removed when the planner moves the tasks or keeps their dates, or when the date moves back.
 */
export interface ChecklistDateMove {
/**
 * The owning tenant. Compared to the context's tenant only; never selects the partition.
 */
tenant_id: string
wedding_id: string
/**
 * The wedding date the open tasks were scheduled against.
 */
from_date: string
/**
 * The wedding date now.
 */
to_date: string
/**
 * ISO 8601 UTC time of the latest move, from the injected clock.
 */
noted_at: string
}
