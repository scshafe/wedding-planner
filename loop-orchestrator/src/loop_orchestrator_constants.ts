/**
 * @canonical loop_orchestrator_constants -- the stage machine vocabulary.
 *
 * Single source of truth for the candidate stage names, the decision mechanisms, and the final
 * dispositions (loop_architecture.md, candidate_change_schema.json, ledger_entry_schema.json).
 * Phase 1 implements only the offline portion of the stage machine; the production stages
 * (shadow/canary/ramp/promoted/rolled_back) are named here but exercised in a later phase.
 */

/** Candidate stage-machine states (candidate_change.status). */
export const STAGES = {
  proposed: 'proposed',
  implemented: 'implemented',
  offline_scoring: 'offline_scoring',
  offline_rejected: 'offline_rejected',
  offline_passed: 'offline_passed',
  human_review: 'human_review',
  human_rejected: 'human_rejected',
  shadow: 'shadow',
  canary: 'canary',
  ramp: 'ramp',
  promoted: 'promoted',
  rolled_back: 'rolled_back',
  parked: 'parked',
} as const

export type Stage = (typeof STAGES)[keyof typeof STAGES]

/**
 * The mechanisms that may decide a transition (ledger_entry.state_transitions[].decided_by).
 * Only deterministic mechanisms advance a candidate; ai_proposer appears solely on
 * proposed -> implemented (loop_architecture.md).
 */
export const DECIDED_BY = {
  ai_proposer: 'ai_proposer',
  deterministic_selector: 'deterministic_selector',
  risk_tier_gate: 'risk_tier_gate',
  experiment_engine: 'experiment_engine',
  circuit_breaker: 'circuit_breaker',
  human: 'human',
} as const

export type DecidedBy = (typeof DECIDED_BY)[keyof typeof DECIDED_BY]

/** Final dispositions (ledger_entry.final_disposition). */
export const FINAL_DISPOSITIONS = {
  promoted: 'promoted',
  rejected_offline: 'rejected_offline',
  rejected_human: 'rejected_human',
  rolled_back: 'rolled_back',
  parked: 'parked',
} as const

export type FinalDisposition = (typeof FINAL_DISPOSITIONS)[keyof typeof FINAL_DISPOSITIONS]
