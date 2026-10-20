/* eslint-disable */
/**
 * GENERATED from product/schemas/wedding_task_schema.json — DO NOT EDIT BY HAND.
 * The JSON Schema file is the source of truth. Regenerate with: npm run gen:types
 */

/**
 * One task on a wedding's checklist (issue #31): what to do, by when, and whose job it is. Created by hand or from the built-in checklist template (then `template_key` names the template item, so applying the template twice adds nothing twice). Stored under groupedKey(wedding_id, task_id) and read one wedding at a time.
 */
export interface WeddingTask {
/**
 * Identity within the owning tenant's partition, from the injected id generator.
 */
task_id: string
/**
 * The owning tenant. Compared to the context's tenant only; never selects the partition.
 */
tenant_id: string
wedding_id: string
title: string
/**
 * Free text, when there is any.
 */
notes?: string
/**
 * The local date it is due (YYYY-MM-DD).
 */
due_date: string
/**
 * Whose job it is. The couple can complete the tasks assigned to them.
 */
assignee: ("planner" | "couple")
status: ("todo" | "done")
/**
 * The checklist template item this task came from, when it came from one.
 */
template_key?: string
/**
 * ISO 8601 UTC time it was marked done, while done.
 */
completed_at?: string
/**
 * ISO 8601 UTC creation time, from the injected clock.
 */
created_at: string
/**
 * ISO 8601 UTC time of the last change, when changed.
 */
updated_at?: string
}
