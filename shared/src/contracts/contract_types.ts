/**
 * @canonical contract_types -- the public, clean-named surface for the generated contract types.
 *
 * The files under ./generated are produced by `npm run gen:types` from the JSON Schema contracts
 * and are not hand-edited. This module curates them into the names the team uses in conversation
 * ("an event envelope", "a candidate change", "a commitment payload"), aliasing the two roots that
 * took their schema title (Telemetry…) back to their plain capability name. If a schema's title
 * changes, the re-export below breaks at compile time — the intended drift signal.
 *
 * related: contract_manifest.ts (keys/paths), schema_registry.ts (runtime validation of these shapes).
 */

// Cross-domain contract: the strategy genome the proposer authors and the simulator interprets.
export type { StrategyGenome } from './generated/strategy_genome'

// The event stream contract.
export type { TelemetryEventEnvelope as EventEnvelope } from './generated/event_envelope'

// Safety-critical event payloads (the $defs of event_payloads_schema.json).
export type {
  CommitmentPayload,
  CommsFactAssertedPayload,
  GuestQuestionAnsweredPayload,
  IntegrationActionResultPayload,
  ConstraintEvaluatedPayload,
  CoupleDecisionAiDecisionAutonomousPayload as CoupleDecisionPayload,
} from './generated/event_payloads'

// Eval-harness contracts.
export type { CouplePersona } from './generated/couple_persona'
export type { GuestPersona } from './generated/guest_persona'
export type { Scenario } from './generated/scenario'
export type { GradeReport } from './generated/grade_report'

// Loop-orchestrator contracts.
export type { CandidateChange } from './generated/candidate_change'
export type { LedgerEntry } from './generated/ledger_entry'
export type { RolloutStage } from './generated/rollout_stage'

// Agent-operations contracts (skeleton domain in Phase 1, types available for later phases).
export type { EscalationRecord } from './generated/escalation_record'
export type { OversightRecord } from './generated/oversight_record'
export type { TrustedFeed } from './generated/trusted_feed'

// Product contracts (the customer-facing surface: the multi-tenant aggregates + the billing ledger).
export type { Tenant } from './generated/tenant'
export type { Wedding } from './generated/wedding'
export type { BillingEvent } from './generated/billing_event'
// The untrusted inbound-webhook wire payload (Phase 19): validated at the guest inbound edge before the
// messaging port normalizes it. Carries the canonical Channel (drift-guarded against shared/src/domain/channel).
export type { InboundWebhook } from './generated/inbound_webhook'
// The guest binding (Phase 21): a planner-managed (tenant_id, recipient_ref) → wedding segmentation record,
// validated at registration. A guest is NOT a session Principal — identity is the opaque recipient_ref alone.
export type { Guest } from './generated/guest'
// A recorded unanswerable guest question (Phase 26): the product-side trace of an `escalated` responder outcome,
// keyed (tenant_id, provider_message_ref), read by the couple (their wedding) / planner (whole tenant). Only
// `escalated` is recorded, never `refused`. See escalation_log.ts and ADR 0026.
export type { GuestEscalation } from './generated/guest_escalation'
// A handled-escalation record (Phase 27): the SEPARATE append-only resolution keyed (tenant_id, escalation_id)
// that marks a guest_escalation resolved/dismissed WITHOUT mutating it (ADR 0026 F6 / ADR 0027). First-writer-wins.
export type { EscalationResolution } from './generated/escalation_resolution'
