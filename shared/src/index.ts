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

// Determinism (injected clock + id generator; nothing reads an ambient clock/RNG)
export { type Clock, ManualClock } from './determinism/clock'
export { type IdGenerator, SequentialIdGenerator } from './determinism/id_generator'

// Serialization + crypto (deterministic; underpin the ledger hash chain + signatures)
export { canonicalJson } from './serialization/canonical_json'
export { sha256Hex, hmacSha256Hex, timingSafeEqualHex } from './crypto/hashing'

// Immutability
export { deepFreeze } from './deep_freeze'

// Domain values shared across workspaces. `Channel` is the single comms-channel enum (derived from the
// schema contracts, drift-guarded) — the messaging boundary and message pricing both reference it.
export { CHANNELS, type Channel } from './domain/channel'

// The single INWARD per-message money cost basis (integer cents per Channel) — the firewall-clean cost the
// eval/loop reads to price the comms strategy (Phase 20). Distinct from the product's retail price book.
export { MESSAGE_COST_CENTS, messageCostCents, isChannel } from './domain/message_cost'

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

// Strategy genome — content-address binding (the firewall over "the thing that actually runs")
export {
  GENOME_ARTIFACT_REF_PREFIX,
  assertValidGenome,
  canonicalGenomeHash,
  genomeArtifactRef,
  parseGenomeArtifactRef,
  classifyGenomeArtifactRef,
  genomeMatchesArtifactRef,
  type GenomeArtifactRefVerdict,
} from './strategy/genome'
export {
  SURFACE_TIER_FLOOR,
  GENOME_PARAMETER_SURFACES,
  UnmappedGenomeParameterError,
  deriveRiskTier,
  type SensitivitySurface,
  type ParameterSurface,
  type GenomeRiskDerivation,
} from './strategy/risk_tier'

// Generated contract types (clean-named surface over ./contracts/generated)
export type {
  StrategyGenome,
  EventEnvelope,
  CommitmentPayload,
  CommsFactAssertedPayload,
  GuestQuestionAnsweredPayload,
  IntegrationActionResultPayload,
  ConstraintEvaluatedPayload,
  CoupleDecisionPayload,
  CouplePersona,
  GuestPersona,
  Scenario,
  GradeReport,
  CandidateChange,
  LedgerEntry,
  RolloutStage,
  EscalationRecord,
  OversightRecord,
  TrustedFeed,
  Tenant,
  Wedding,
  BillingEvent,
  InboundWebhook,
  Guest,
} from './contracts/contract_types'
