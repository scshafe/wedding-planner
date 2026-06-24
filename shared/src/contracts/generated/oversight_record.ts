/* eslint-disable */
/**
 * GENERATED from agent-operations/schemas/oversight_record_schema.json — DO NOT EDIT BY HAND.
 * The JSON Schema file is the source of truth. Regenerate with: npm run gen:types
 */

/**
 * The contract for one act of oversight in agent-operations: an inline pre-landing review of a consequential action, a continuous monitor/breaker trip, a periodic ledger sweep finding, or an out-of-band obligation violation. Chains into the same append-only hash-chained WORM ledger as escalation_record and loop-orchestrator's ledger_entry, so 'who reviewed what, on what trusted evidence, and what they were (and were NOT) allowed to decide' is tamper-evidently reconstructable. Pins the gameable properties of oversight_loops.md: additive-only verdicts for agent reviewers (cleared reachable only by the non-agent gate or the human), a mandatory floor-clearance reference under every agent inline review, substantiated + fresh + provenance-checked evidence, derived-vs-claimed tier, and out-of-band routing of obligation violations.
 */
export type OversightRecord = ({
[k: string]: unknown
} & {
/**
 * Stable id, injected (not ambient).
 */
review_id: string
/**
 * UTC, injected.
 */
at: string
/**
 * inline_pre_landing = the before-land review gate on a consequential action (oversight_loops.md 'The pre-landing review gate'). continuous_monitor = a real-time breaker/monitor trip. periodic_sweep = a manager ledger-sweep finding. obligation_violation = an out-of-band obligation monitor caught a missed duty (the collusion/missed-flag signature).
 */
review_kind: ("inline_pre_landing" | "continuous_monitor" | "periodic_sweep" | "obligation_violation")
/**
 * What is under review. Required for an inline_pre_landing review.
 */
subject?: {
/**
 * The roster role whose action is reviewed (agent_roster.md).
 */
acting_agent: ("operations_manager" | "build_release_agent" | "product_improvement_loop" | "support_agent" | "reliability_agent" | "security_agent")
/**
 * Id of the action / candidate / escalation under review (id only, no PII).
 */
action_ref: string
/**
 * The tier the acting agent self-assigned — a CLAIM, never authoritative (shared_operating_discipline.md §4; risk_tier_derivation.md).
 */
claimed_tier?: (number | null)
/**
 * The AUTHORITATIVE tier, derived deterministically from the action's actual blast radius via the action->surface map (trusted config, agent-unwritable), not the claim. claimed < derived is an under-declaration: auto-rejected and escalated (verdict tier_raised + escalated; INTEGRITY.UNDER_DECLARED_TIER).
 */
derived_tier?: (number | null)
}
/**
 * Who performed the oversight. deterministic_gate / obligation_monitor / circuit_breaker are non-agent L0 mechanisms (their signing keys live outside every agent's process boundary); human is L4 (the standing supervisor for sweeps/meta-review, or the approver named in human_gate for a Tier-2 gate). The six roster roles are L2/L3 agent reviewers — bound by the additive-only constraint below (they cannot emit verdict=cleared).
 */
reviewed_by: ("deterministic_gate" | "operations_manager" | "build_release_agent" | "product_improvement_loop" | "support_agent" | "reliability_agent" | "security_agent" | "obligation_monitor" | "circuit_breaker" | "human")
/**
 * Non-self-review: the reviewer is NEVER the acting agent (oversight_loops.md). Like escalation_record's reversible flags, this is recorded true for audit; a record with reviewed_by == subject.acting_agent is itself an INTEGRITY.REVIEWER_WAS_ACTOR violation. Required for an inline_pre_landing review.
 */
reviewer_distinct_from_actor?: true
/**
 * The review_id of the deterministic_gate oversight_record this agent review rode on top of. An agent inline review NEVER substitutes for the deterministic floor clearance — it adds recall above it. Required (and non-null — a present-null would defeat the floor) when review_kind=inline_pre_landing AND reviewed_by is an agent role (allOf below); omitted otherwise.
 */
floor_clearance_ref?: string
/**
 * The trusted/out-of-band evidence the review was decided on. A review that 'read the actor's self-report' is not a review (shared_operating_discipline.md §2) — there is intentionally no self_report option. For a live out-of-band feed, the read must be substantiated (a signed receipt) and confirmed fresh, else fail closed.
 */
evidence: {
/**
 * The trusted source — mirrors escalation_record.trigger.detected_from, never a component's self-report. static_diff_analysis backs deterministic tier-derivation; ledger_replay backs sweeps and obligation monitors; the out_of_band_* / independent_health_check feeds are live third-party sources reached over an agent-unwritable channel (oversight_loops.md 'Making the floor un-authorable in production').
 */
read_from: ("harness_trusted_record" | "out_of_band_payment_processor" | "out_of_band_vendor_confirmation" | "out_of_band_complaint_channel" | "independent_health_check" | "static_diff_analysis" | "ledger_replay")
/**
 * Pointer to the trusted record / readout / diff analysis backing the verdict.
 */
evidence_ref?: (string | null)
/**
 * Reference to a signed read-receipt from the trusted source proving the reviewer actually consulted it (not a self-asserted read). Unresolvable => INTEGRITY.EVIDENCE_UNSUBSTANTIATED. Required for a live out-of-band feed read.
 */
receipt_ref?: (string | null)
/**
 * The out-of-band feed was confirmed live within its harm-horizon (signed freshness/sequence assertion from the third party). A stale feed fails closed (INTEGRITY.TRUSTED_FEED_STALE) rather than reading silence as safety. Required (and true) for a live out-of-band feed read.
 */
feed_fresh?: (boolean | null)
/**
 * Content-addressed ancestry of the evidence. Two 'independent' reviews whose evidence shares a poisoned ancestor are not independent => INTEGRITY.SHARED_EVIDENCE_ANCESTOR.
 */
provenance_ref?: (string | null)
}
/**
 * The outcome. ADDITIVE-ONLY for agent reviewers: an agent may only raise scrutiny (flagged / blocked / tier_raised / escalated) and may NEVER clear. Only a deterministic_gate or human may emit cleared; only a circuit_breaker / obligation_monitor reverts or raises (rolled_back / flagged / escalated). Enforced by the allOf branches below.
 */
verdict: ("cleared" | "flagged" | "blocked" | "tier_raised" | "escalated" | "rolled_back")
/**
 * Set when review_kind = obligation_violation. The duty an out-of-band monitor found unmet — the operational analogue of INTEGRITY.SELF_REPORT_DIVERGENCE.
 */
obligation?: ({
/**
 * Which obligation was violated. INTEGRITY.SELF_REPORT_DIVERGENCE is the one code defined in eval-harness/rubrics/gate_checks.md; the rest are NEW ops-side codes defined in oversight_loops.md ('Keeping oversight honest') and trusted_evidence_channel.md ('Making the floor un-authorable'), modeled on it — they are NOT pre-existing in gate_checks.md. MISSED_ESCALATION covers effect-defined Tier-3 triggers only (judgment-defined triggers use a raise-only redundant classifier + human meta-review). MONITOR_DARK = a detector went dark and the guarded action halted (recursive liveness); CROSS_TENANT = cross-tenant evidence read/influence.
 */
code: ("INTEGRITY.MISSED_ESCALATION" | "INTEGRITY.UNLEDGERED_ACTION" | "INTEGRITY.SCOPE_EXCEEDED" | "INTEGRITY.REVIEWER_WAS_ACTOR" | "INTEGRITY.COOLDOWN_VIOLATION" | "INTEGRITY.UNDER_DECLARED_TIER" | "INTEGRITY.TRUSTED_FEED_STALE" | "INTEGRITY.FORGED_CLEAR" | "INTEGRITY.SAMPLING_BYPASS" | "INTEGRITY.SHARED_EVIDENCE_ANCESTOR" | "INTEGRITY.EVIDENCE_UNSUBSTANTIATED" | "INTEGRITY.UNVERIFIED_LAND" | "INTEGRITY.MONITOR_DARK" | "INTEGRITY.CROSS_TENANT" | "INTEGRITY.SELF_REPORT_DIVERGENCE")
/**
 * An obligation violation routes on a path that does NOT pass through the operations_manager — straight to the human (L4) — so a watcher going dark cannot suppress the alarm about itself.
 */
routed_out_of_band: true
} | null)
/**
 * For a Tier-2 action: the human approval that must precede land (shared_operating_discipline.md §4; safety_and_governance.md §5). Null for Tier 0/1. Tier-3 does not use this — it blocks and produces an escalation_record instead.
 */
human_gate?: ({
approved: boolean
/**
 * e.g. loop_supervisor, support_lead, on_call_sre, finance_legal_owner.
 */
approver_role: string
decided_at: string
/**
 * The content-addressed identity of the SINGLE landing this approval authorizes — one approval binds one landing, so a crash-retry cannot re-spend it and a stale approval cannot land a CHANGED plan. The composition is defined by the landing channel: the offline genome loop binds sha256(canonicalJson{landing_genome_hash, against_champion_hash}) so the approval authorizes exactly the reviewed genome against the reviewed champion baseline — a champion ratchet re-derives a different key and invalidates the approval (loop-orchestrator promotion_gate.ts / landing_approval.ts). A production effecting channel binds action_ref x intended-effect-hash instead (oversight_loops.md 'Crash and recovery'). Null when the gate carries no landing binding.
 */
binds_landing_key?: (string | null)
} | null)
/**
 * action_ref x intended-effect-hash. Lets a restart ask the out-of-band record 'did THIS effect already land?' so a re-driven turn cannot double-land a real deploy/charge/send.
 */
idempotency_key?: (string | null)
/**
 * References couples/guests by id only; sensitive free-text is [REDACTED] (telemetry PII discipline).
 */
pii_redacted: true
/**
 * Chains this record into the shared append-only WORM ledger — same fields as ledger_entry_schema.json state_transitions and escalation_record_schema.json ledger_chain.
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
 * Who recorded/decided this oversight act; must equal reviewed_by, and is bound by decided_by_signature, not trusted as a bare string. For deterministic_gate / obligation_monitor / circuit_breaker / human, the signing key lives outside every agent's process boundary — a 'cleared' whose signature does not verify against the L0/L4 keyring is INTEGRITY.FORGED_CLEAR (shared_operating_discipline.md §5; safety_and_governance.md §7).
 */
decided_by: ("deterministic_gate" | "operations_manager" | "build_release_agent" | "product_improvement_loop" | "support_agent" | "reliability_agent" | "security_agent" | "obligation_monitor" | "circuit_breaker" | "human")
/**
 * Signature binding the entry to the acting process's identity, so a forged record cannot spoof decided_by. The L0/L4 keys are not available to any agent process.
 */
decided_by_signature: string
}
})
