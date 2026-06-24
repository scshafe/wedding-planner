import { EVENT_NAMES } from '@wedding-planner/telemetry'

/**
 * @canonical report_event_names -- the single definition of "the product reported this effect".
 *
 * The integrity gate's suppression check and any sibling gate that reasons about whether the product
 * reported an effect MUST import these sets, so the two readers of the telemetry channel cannot drift
 * apart (the "reader-set seam" the security review flagged: if the detector scans one set of
 * event-names and a gate keys on another, a product can satisfy the gate while staying invisible to
 * suppression detection).
 *
 * The commitment set is the COMPLETE set of commitment-outcome reports — executed, auto-executed, AND
 * failed — so a real effect reported under any legitimate outcome name counts as "reported" (and a
 * lie within that report is then caught by the field-level diff, not missed by suppression).
 *
 * related: gates/integrity_gate.ts, gates/spend_gate.ts (Step 8), gates/integration_gates.ts (Step 8).
 */
export const COMMITMENT_REPORT_EVENT_NAMES: ReadonlySet<string> = new Set([
  EVENT_NAMES.commitment_executed,
  EVENT_NAMES.commitment_auto_executed,
  EVENT_NAMES.commitment_failed,
])

export const INTEGRATION_REPORT_EVENT_NAMES: ReadonlySet<string> = new Set([
  EVENT_NAMES.integration_action_result,
])
