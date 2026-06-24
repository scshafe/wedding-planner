import { WeddingPlannerError } from '@wedding-planner/shared'

/**
 * Errors raised by the eval-harness domain. Codes are EVAL.<FAILURE_MODE> /
 * TRUSTED_RECORDER.<FAILURE_MODE>.
 *
 * related: shared WeddingPlannerError (base type).
 */
export class EvalHarnessError extends WeddingPlannerError {}
