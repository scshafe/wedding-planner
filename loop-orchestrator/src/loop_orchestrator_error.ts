import { WeddingPlannerError } from '@wedding-planner/shared'

/**
 * Errors raised by the loop-orchestrator domain. Codes are LEDGER.<FAILURE_MODE> /
 * LOOP.<FAILURE_MODE>.
 *
 * related: shared WeddingPlannerError (base type).
 */
export class LoopOrchestratorError extends WeddingPlannerError {}
