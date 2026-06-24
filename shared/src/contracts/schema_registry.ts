import { readFileSync } from 'node:fs'

import Ajv2020, { type ErrorObject, type ValidateFunction } from 'ajv/dist/2020.js'
import addFormats from 'ajv-formats'

import { WeddingPlannerError } from '../errors/wedding_planner_error'
import { resolveFromRepoRoot } from '../repo_root'
import {
  CONTRACT_DEFINITIONS,
  getContractDefinition,
  type ContractKey,
} from './contract_manifest'

/**
 * @canonical schema_registry -- the one place data is validated against the JSON Schema contracts.
 *
 * Loads all 13 draft-2020-12 contracts (named in contract_manifest.ts) into a single Ajv 2020
 * instance — the schema files are the source of truth and are never copied or redefined. Every
 * domain validates through this registry; there is no second validator anywhere in the codebase.
 *
 * related: contract_manifest.ts, telemetry/src/events, eval-harness/src/corpus.
 */

/** A single validation failure, flattened from Ajv's error object for stable consumption. */
export interface ContractValidationError {
  readonly instancePath: string
  readonly schemaPath: string
  readonly keyword: string
  readonly message: string
  readonly params: Record<string, unknown>
}

/** Result of validating a value against a contract. `data` is the input, typed, when valid. */
export type ContractValidationResult<T> =
  | { readonly valid: true; readonly data: T; readonly errors: readonly [] }
  | { readonly valid: false; readonly data: null; readonly errors: readonly ContractValidationError[] }

/** Thrown by `assertValid` when a value does not conform to its contract. */
export class ContractValidationFailedError extends WeddingPlannerError {
  readonly contractKey: ContractKey
  readonly validationErrors: readonly ContractValidationError[]

  constructor(contractKey: ContractKey, validationErrors: readonly ContractValidationError[]) {
    super(
      'CONTRACT.VALIDATION_FAILED',
      `Value does not conform to the '${contractKey}' contract: ` +
        validationErrors.map((e) => `${e.instancePath || '<root>'} ${e.message}`).join('; '),
      { context: { contractKey, validationErrors } },
    )
    this.contractKey = contractKey
    this.validationErrors = validationErrors
  }
}

function toContractValidationError(error: ErrorObject): ContractValidationError {
  return {
    instancePath: error.instancePath,
    schemaPath: error.schemaPath,
    keyword: error.keyword,
    message: error.message ?? 'validation failed',
    params: error.params as Record<string, unknown>,
  }
}

export class SchemaRegistry {
  private readonly ajv: Ajv2020

  constructor() {
    // allErrors: report every failure, not just the first, so a grade report can show how far off.
    // strict: false — ajv strict mode audits *schema authoring style* (e.g. a conditional subschema
    //   using `required`/`properties` without an explicit `type: object`), NOT data-conformance
    //   rigor, which is identical regardless. The 13 contracts are canonical, already draft-2020-12
    //   meta-valid, must not be redefined here (plan Context §3), and legitimately use that terse
    //   conditional style (e.g. oversight_record's additive-only verdict rules). The registry is a
    //   consumer of these contracts, not their linter — strict false compiles them faithfully and
    //   still validates every instance with full force (additionalProperties:false, enums, formats).
    this.ajv = new Ajv2020({ allErrors: true, strict: false })
    addFormats(this.ajv)
    for (const definition of CONTRACT_DEFINITIONS) {
      const raw = readFileSync(resolveFromRepoRoot(definition.repoRelativePath), 'utf8')
      const schema = JSON.parse(raw) as Record<string, unknown>
      // Register by the schema's internal $id; do not pass an explicit key (would double-register).
      this.ajv.addSchema(schema)
    }
  }

  /** All registered contract keys. */
  contractKeys(): readonly ContractKey[] {
    return CONTRACT_DEFINITIONS.map((definition) => definition.key)
  }

  /**
   * Return the compiled validator for a contract. Compiling a contract that fails to compile
   * throws here, which is how the "all 13 compile" guarantee is exercised.
   */
  getValidateFunction<T = unknown>(key: ContractKey): ValidateFunction<T> {
    const definition = getContractDefinition(key)
    const validate = this.ajv.getSchema<T>(definition.schemaId)
    if (validate === undefined) {
      throw new WeddingPlannerError(
        'CONTRACT.SCHEMA_NOT_REGISTERED',
        `No schema registered for contract '${key}' (schemaId '${definition.schemaId}').`,
        { context: { contractKey: key, schemaId: definition.schemaId } },
      )
    }
    return validate
  }

  /** Validate a value against a contract, returning a structured result (never throws on invalid). */
  validate<T = unknown>(key: ContractKey, data: unknown): ContractValidationResult<T> {
    const validate = this.getValidateFunction<T>(key)
    if (validate(data)) {
      return { valid: true, data: data as T, errors: [] }
    }
    const errors = (validate.errors ?? []).map(toContractValidationError)
    return { valid: false, data: null, errors }
  }

  /** Validate and return the typed value, or throw ContractValidationFailedError. */
  assertValid<T = unknown>(key: ContractKey, data: unknown): T {
    const result = this.validate<T>(key, data)
    if (!result.valid) {
      throw new ContractValidationFailedError(key, result.errors)
    }
    return result.data
  }
}

let cachedRegistry: SchemaRegistry | undefined

/**
 * The process-wide schema registry. Built lazily on first use (reads + compiles the 13 contracts
 * once) so that importing the shared barrel does not perform filesystem work until validation is
 * actually needed.
 */
export function getSchemaRegistry(): SchemaRegistry {
  if (cachedRegistry === undefined) {
    cachedRegistry = new SchemaRegistry()
  }
  return cachedRegistry
}
