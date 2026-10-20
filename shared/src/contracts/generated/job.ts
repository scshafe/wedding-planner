/* eslint-disable */
/**
 * GENERATED from product/schemas/job_schema.json — DO NOT EDIT BY HAND.
 * The JSON Schema file is the source of truth. Regenerate with: npm run gen:types
 */

/**
 * A model call to make after the request that asked for it (issue #61, ADR 0058): the outbox row of ADR 0039's dispatcher. One per kind and subject, keyed groupedKey(kind, subject_id), so a second request while one is live returns the live one. It holds ids only: the facts are read again when the job runs.
 */
export interface Job {
job_id: string
/**
 * The owning tenant. Compared to the context's tenant only; never selects the partition.
 */
tenant_id: string
kind: string
/**
 * What the job is about: a wedding id, or a hash of a guest message's ref (per kind).
 */
subject_id: string
requested_by: string
status: ("queued" | "running" | "done" | "failed")
attempts: number
/**
 * A queued job waits until then (a retry's backoff).
 */
not_before?: string
/**
 * A running job's claim; after it, the job may run again (a restart mid-call).
 */
lease_until?: string
/**
 * The code of the last failure, when it failed.
 */
last_error?: string
created_at: string
updated_at?: string
}
