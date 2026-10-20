import { type Clock, getSchemaRegistry, WeddingPlannerError } from '@wedding-planner/shared'

import { COLLECTIONS } from '../persistence/collections'
import { InMemoryRecordStore } from '../persistence/in_memory_record_store'
import type { RecordStore } from '../persistence/record_store'
import { ProductError } from '../product_error'
import type { TenantContext } from '../tenant/tenant_context'
import { TenantScopedRepository } from '../tenant/tenant_scoped_repository'
import type { TenantLivenessCheck } from '../tenant/tenant_store'
import type { ModelPort, ModelRequest, ModelUsage } from './model_port'

/**
 * @canonical model_service -- how the product calls a model (issue #59, ADR 0057): through the {@link ModelPort}, with
 * the output validated and every call metered per workspace.
 *
 *   - **Validation.** The output must satisfy the request's contract before anyone uses it; anything else is
 *     MODEL.INVALID_OUTPUT, and the caller writes nothing. The usage figures are checked too (whole, non-negative
 *     numbers): a provider's report is untrusted input, as a messaging provider's cost is (PRODUCT.PROVIDER_COST_INVALID).
 *   - **Metering.** Each call adds to the workspace's usage for the month (calls and tokens), whatever the output: a
 *     provider bills for an invalid answer too. The billing page shows it, with a simulated provider cost, so pricing
 *     can be decided from real numbers later (owner track). Nothing is charged to the ledger yet.
 *   - **Transactions.** `run` awaits the port OUTSIDE any store transaction and writes the usage in its own short one
 *     (`transact`), so a slow model never holds the database lock. Call it from deferred work, never from inside a
 *     request's transaction.
 *   - **Failures.** An adapter failure is MODEL.UNAVAILABLE (MODEL.UNKNOWN_TASK passes through: a programming error).
 *
 * related: model_port.ts (the boundary), simulated_model_adapter.ts (the only adapter), billing page (usage shown).
 */

/** One workspace's model usage in one month (collection `model_usage`, key `YYYY-MM`). */
export interface ModelUsageRecord {
  readonly tenant_id: string
  readonly month: string
  readonly calls: number
  readonly input_tokens: number
  readonly output_tokens: number
}

/**
 * What a provider would charge per million tokens, in cents — the simulated cost the billing page shows. A
 * placeholder for planning, not a quote: a real provider's price is part of the owner's decision to wire one.
 */
export const SIMULATED_PROVIDER_PRICE = Object.freeze({ input_cents_per_mtok: 300, output_cents_per_mtok: 1500 })

/** The usage a workspace sees for a month. */
export interface ModelUsageView {
  readonly month: string
  readonly calls: number
  readonly input_tokens: number
  readonly output_tokens: number
  /** What the calls would cost at {@link SIMULATED_PROVIDER_PRICE}, in whole cents (rounded up). */
  readonly simulated_cost_cents: number
}

export class ModelService {
  readonly #usage: TenantScopedRepository<ModelUsageRecord>

  constructor(
    liveness: TenantLivenessCheck,
    private readonly port: ModelPort,
    private readonly clock: Clock,
    private readonly transact: <R>(fn: () => R) => R,
    store: RecordStore = new InMemoryRecordStore(),
  ) {
    this.#usage = new TenantScopedRepository<ModelUsageRecord>(liveness, (u) => u.month, COLLECTIONS.modelUsage, store)
  }

  /** Ask the model for one task in a workspace; the validated output. Never call it inside a store transaction. */
  async run<T>(context: TenantContext, request: ModelRequest): Promise<T> {
    let result
    try {
      result = await this.port.complete(request)
    } catch (error) {
      if (error instanceof WeddingPlannerError && error.code === 'MODEL.UNKNOWN_TASK') throw error
      throw new ProductError('MODEL.UNAVAILABLE', 'The model did not answer.', { context: { task: request.task }, cause: error })
    }
    const usage = result.usage
    if (!isCount(usage.input_tokens) || !isCount(usage.output_tokens)) {
      throw new ProductError('MODEL.INVALID_USAGE', 'The model reported usage that is not a whole, non-negative number.', { context: { task: request.task } })
    }
    this.transact(() => this.#meter(context, usage))
    const checked = getSchemaRegistry().validate<T>(request.output_contract, result.output)
    if (!checked.valid) {
      throw new ProductError('MODEL.INVALID_OUTPUT', `The model's output does not satisfy '${request.output_contract}'.`, {
        context: { task: request.task, errors: checked.errors.length },
      })
    }
    return checked.data
  }

  /** A workspace's usage for a month (`YYYY-MM`; the current month by default). */
  usageFor(context: TenantContext, month: string = this.clock.now().slice(0, 7)): ModelUsageView {
    const record = this.#usage.read(context, month)
    const input_tokens = record?.input_tokens ?? 0
    const output_tokens = record?.output_tokens ?? 0
    return {
      month,
      calls: record?.calls ?? 0,
      input_tokens,
      output_tokens,
      simulated_cost_cents: Math.ceil((input_tokens * SIMULATED_PROVIDER_PRICE.input_cents_per_mtok + output_tokens * SIMULATED_PROVIDER_PRICE.output_cents_per_mtok) / 1_000_000),
    }
  }

  #meter(context: TenantContext, usage: ModelUsage): void {
    const month = this.clock.now().slice(0, 7)
    const current = this.#usage.read(context, month)
    this.#usage.put(context, {
      tenant_id: context.tenant_id,
      month,
      calls: (current?.calls ?? 0) + 1,
      input_tokens: (current?.input_tokens ?? 0) + usage.input_tokens,
      output_tokens: (current?.output_tokens ?? 0) + usage.output_tokens,
    })
  }
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}
