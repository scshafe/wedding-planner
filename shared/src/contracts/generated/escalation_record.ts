/* eslint-disable */
/**
 * GENERATED from agent-operations/schemas/escalation_record_schema.json — DO NOT EDIT BY HAND.
 * The JSON Schema file is the source of truth. Regenerate with: npm run gen:types
 */

/**
 * The contract for one escalation/incident at the human-reserved boundary: an ops agent took a situation up to one of the four human-reserved exceptions (human_reserved_boundary.md), contained what it could, froze the affected state, and handed off to a person. Chains into the same append-only hash-chained ledger as loop-orchestrator (ledger_entry_schema.json) so the boundary is auditable and tamper-evident.
 */
export interface EscalationRecord {
/**
 * Stable id, injected (not ambient).
 */
escalation_id: string
/**
 * UTC, injected.
 */
opened_at: string
/**
 * Which roster role raised it (agent_roster.md).
 */
raised_by_agent: ("operations_manager" | "build_release_agent" | "product_improvement_loop" | "support_agent" | "reliability_agent" | "security_agent")
/**
 * Which of the four human-reserved exceptions this crosses (human_reserved_boundary.md).
 */
exception: ("elevated_customer_support" | "total_system_failure" | "security_breach" | "business_billing_or_legal")
/**
 * The four exceptions are operational Tier 3 — human-owned (shared_operating_discipline.md §4). Tier-2 approval-gate handoffs reuse the ledger directly and do not require this record.
 */
operational_tier: 3
trigger: {
/**
 * Machine-readable trigger, e.g. SUPPORT.LEGAL_THREAT, SRE.RECOVERY_EXHAUSTED, SEC.SUSPECTED_EXFIL, BILLING.OVER_ENVELOPE.
 */
code: string
/**
 * One line; PII by id only, sensitive free-text [REDACTED].
 */
description: string
/**
 * The trusted/out-of-band source that raised it — never a component's self-report (shared_operating_discipline.md §2).
 */
detected_from: ("out_of_band_payment_processor" | "out_of_band_vendor_confirmation" | "out_of_band_complaint_channel" | "harness_trusted_record" | "independent_health_check" | "human_report")
severity: ("low" | "medium" | "high" | "critical")
/**
 * True for credibly-suspected (not yet confirmed) cases — security breaches escalate on suspicion.
 */
suspected_not_confirmed?: boolean
}
/**
 * What the agent did UP TO the line — reversible containment only (the MAY column of human_reserved_boundary.md).
 */
contained_actions?: {
/**
 * e.g. 'isolated comms channel', 'failed over to region B', 'rotated scoped credential', 'blocked outbound holds'.
 */
action: string
/**
 * Must be true; containment never destroys state without human sign-off.
 */
reversible: boolean
at: string
}[]
/**
 * What was frozen to stop ongoing harm before handoff.
 */
frozen_state?: {
frozen: boolean
targets: {
kind: ("booking" | "comms_channel" | "deploy" | "account" | "integration" | "infra_resource" | "other")
/**
 * Identifier of the frozen thing (id only, no PII).
 */
ref: string
/**
 * The freeze itself must be cleanly reversible.
 */
reversible: boolean
}[]
}
/**
 * For business_billing_or_legal: the business spend/commitment the agent would have needed to make and MAY NOT (the thing handed to the human). Null otherwise. Never a couple's wedding-budget amount — that is product spend, governed by SPEND.* (spend-autonomy-model).
 */
cost_cents?: (number | null)
human_handoff: {
handed_off_at: string
/**
 * e.g. on_call_sre, support_lead, security_lead, finance_legal_owner, loop_supervisor.
 */
to_human_role: string
/**
 * Pointer to the handoff packet (history, context, what was tried/contained).
 */
packet_ref: string
/**
 * When the human took ownership; null until acknowledged.
 */
acknowledged_at?: (string | null)
/**
 * Whether the agent keeps executing the human's instructions (e.g. during a total failure) — it executes, it no longer decides.
 */
agent_continues_under_direction?: boolean
}
/**
 * Filled on close; null while open.
 */
resolution?: ({
resolved_at?: string
disposition?: ("resolved_by_human" | "resolved_with_agent_execution" | "false_positive" | "ongoing")
notes?: string
} | null)
/**
 * This record references couples/guests by id only; sensitive free-text is [REDACTED] (telemetry PII discipline).
 */
pii_redacted?: true
/**
 * Chains this record into the shared append-only WORM ledger, same fields as ledger_entry_schema.json state_transitions.
 */
ledger_chain: {
/**
 * Hash of this record's content (incl. prev_entry_hash).
 */
entry_hash: string
/**
 * entry_hash of the prior ledger entry; null for the first.
 */
prev_entry_hash: (string | null)
/**
 * Who recorded/decided the escalation; bound by decided_by_signature, not trusted as a bare string.
 */
decided_by: ("operations_manager" | "build_release_agent" | "product_improvement_loop" | "support_agent" | "reliability_agent" | "security_agent" | "circuit_breaker" | "human")
/**
 * Signature binding the entry to the acting process's identity, so a forged record cannot spoof decided_by.
 */
decided_by_signature: string
}
}
