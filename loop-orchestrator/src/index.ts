/**
 * @wedding-planner/loop-orchestrator — the recursive product-improvement loop.
 *
 * Public barrel. Phase 1 builds the offline portion: the append-only hash-chained ledger, and
 * (in later steps) the deterministic selector, the offline pipeline, and the stub-first proposer.
 */

export const LOOP_ORCHESTRATOR_PACKAGE_NAME = '@wedding-planner/loop-orchestrator'

// Stage-machine vocabulary
export {
  STAGES,
  DECIDED_BY,
  FINAL_DISPOSITIONS,
  type Stage,
  type DecidedBy,
  type FinalDisposition,
} from './loop_orchestrator_constants'

// Errors
export { LoopOrchestratorError } from './loop_orchestrator_error'

// Ledger
export {
  Ledger,
  type StateTransition,
  type OfflineResult,
  type AppendTransitionInput,
  type AppendResult,
} from './ledger/ledger'
export {
  computeEntryHash,
  decisionFingerprint,
  verifyLedgerChain,
  type TransitionContent,
  type ChainVerification,
} from './ledger/ledger_hashing'
export { type TransitionSigner, HmacTransitionSigner } from './ledger/transition_signer'

// Offline pipeline (the deterministic selector — recorder -> gates -> scoring -> ledger)
export {
  runOfflineSelection,
  computeSurpriseCheck,
  type OfflineSelectionResult,
  type SurpriseCheck,
} from './pipeline/deterministic_selector'

// Proposer (the one model-authored step) + the offline loop (loop-until-dry)
export {
  StubProposer,
  type Proposer,
  type ProposerContext,
  type StubProposerSpec,
} from './proposer/proposer'
export {
  runOfflineLoop,
  type OfflineLoopConfig,
  type OfflineLoopSummary,
  type LoopTerminationReason,
  type PreScoreGateVerdict,
  type PromotionOutcome,
} from './loop/offline_loop'

// Strategy substrate (Phase 2): the champion (the standard a candidate must beat) + the
// content-addressed registry that resolves a candidate's artifact_ref to its genome.
export { ChampionStore } from './genome/champion_store'
export { GenomeRegistry } from './genome/genome_registry'
export {
  SearchProposer,
  type SearchProposerSpec,
} from './proposer/search_proposer'
export {
  reconcileCandidateRiskTier,
  type RiskTierReconciliation,
} from './pipeline/risk_tier_reconciliation'
export {
  runPromotionGate,
  type PromotionGateConfig,
  MAX_AUTONOMOUS_PROMOTION_TIER,
} from './pipeline/promotion_gate'
export {
  runGenomeOfflineLoop,
  type GenomeOfflineLoopConfig,
} from './loop/genome_offline_loop'
