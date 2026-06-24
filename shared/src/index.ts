/**
 * @wedding-planner/shared — cross-domain capabilities.
 *
 * Public barrel for the shared domain. Capabilities are added here as they are built:
 * the schema registry/validator, generated contract types, determinism primitives,
 * structured logging, the base error type, and hash-chain/signing helpers.
 */

export const SHARED_PACKAGE_NAME = '@wedding-planner/shared'

// Errors
export { WeddingPlannerError, type WeddingPlannerErrorOptions } from './errors/wedding_planner_error'

// Path anchoring
export { REPO_ROOT, resolveFromRepoRoot } from './repo_root'

// Contracts (the 12 JSON Schema contracts as runtime validators)
export {
  CONTRACT_DEFINITIONS,
  CONTRACT_COUNT,
  getContractDefinition,
  type ContractDefinition,
  type ContractDomain,
  type ContractKey,
} from './contracts/contract_manifest'
export {
  SchemaRegistry,
  getSchemaRegistry,
  ContractValidationFailedError,
  type ContractValidationError,
  type ContractValidationResult,
} from './contracts/schema_registry'
