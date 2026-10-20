import { type Clock, getSchemaRegistry, WeddingPlannerError } from '@wedding-planner/shared'

import { COLLECTIONS } from '../persistence/collections'
import { InMemoryRecordStore } from '../persistence/in_memory_record_store'
import { groupedKey, type RecordStore } from '../persistence/record_store'
import { ProductError } from '../product_error'
import { assertMintedContext, type TenantContext } from '../tenant/tenant_context'
import { TenantScopedRepository } from '../tenant/tenant_scoped_repository'
import type { TenantLivenessCheck } from '../tenant/tenant_store'
import type { ModelPort, ModelTaskDefinition, ModelUsage } from './model_port'

/**
 * @canonical model_service -- how the product calls a model (issue #59, ADR 0057): through the {@link ModelPort}, for a
 * task defined in code, with the output validated and every call metered per workspace, month and task.
 *
 *   - **The workspace first.** A suspended or unknown workspace is refused BEFORE the model is called, so a job
 *     queued before a suspension never pays a provider. (A suspension during a call in flight refuses that call's
 *     usage row: the one remaining race.)
 *   - **Validation.** The output must satisfy the task's contract before anyone uses it; anything else is
 *     MODEL.INVALID_OUTPUT, and the caller writes nothing. This is the first of two checks: each feature then checks
 *     the output against its own input. The usage report is untrusted too (whole, non-negative, at most
 *     {@link MODEL_LIMITS}), as a messaging provider's cost is (PRODUCT.PROVIDER_COST_INVALID).
 *   - **Metering.** Every call that answers is counted, per month and task: tokens and the provider's reported cost
 *     for a valid report, a rejected-usage count otherwise. An invalid output counts too: a provider bills for it. The
 *     workspace sees calls and tokens (its own usage, like `messages_sent`); the provider's cost is recorded for the
 *     operator and pricing, never shown to the tenant (billing_summary.ts's invariant). Nothing is charged yet.
 *   - **Transactions.** `run` awaits the port OUTSIDE any store transaction and writes the usage in its own short one,
 *     so a slow model never holds the database lock. Call it from deferred work, never inside a request's transaction.
 *   - **Failures.** An adapter failure is MODEL.UNAVAILABLE (MODEL.UNKNOWN_TASK passes through: a programming error).
 *
 * related: model_port.ts (the boundary), simulated_model_adapter.ts (the only adapter), billing page (usage shown).
 */

/** Bounds on one call's usage report: anything above is not a real report. */
export const MODEL_LIMITS = Object.freeze({ tokens_per_call: 2_000_000, cost_micro_cents_per_call: 100_000_000_000 })

/** One workspace's model usage for one task in one month (collection `model_usage`, key `groupedKey(month, task)`). */
export interface ModelUsageRecord {
  readonly tenant_id: string
  readonly month: string
  readonly task: string
  /** Calls that answered (a valid usage report or not). */
  readonly calls: number
  /** Of those, calls whose usage report was refused (no tokens or cost recorded for them). */
  readonly rejected_usage_calls: number
  readonly input_tokens: number
  readonly output_tokens: number
  /** What the calls cost the provider's customer (us), in millionths of a cent. Never shown to the tenant. */
  readonly cost_micro_cents: number
}

/** The usage a workspace sees for a month: its own calls and tokens, never the provider's cost. */
export interface ModelUsageView {
  readonly month: string
  readonly calls: number
  readonly input_tokens: number
  readonly output_tokens: number
  readonly tasks: readonly { readonly task: string; readonly calls: number; readonly input_tokens: number; readonly output_tokens: number }[]
}

export class ModelService {
  readonly #usage: TenantScopedRepository<ModelUsageRecord>

  constructor(
    private readonly liveness: TenantLivenessCheck,
    private readonly port: ModelPort,
    private readonly clock: Clock,
    private readonly store: RecordStore = new InMemoryRecordStore(),
  ) {
    this.#usage = new TenantScopedRepository<ModelUsageRecord>(liveness, (u) => groupedKey(u.month, u.task), COLLECTIONS.modelUsage, store)
  }

  /** Ask the model for one task in a workspace; the validated output. Never call it inside a store transaction. */
  async run<T>(context: TenantContext, task: ModelTaskDefinition<T>, input: Readonly<Record<string, unknown>>): Promise<T> {
    assertMintedContext(context)
    if (!this.liveness.isUsable(context.tenant_id)) {
      throw new ProductError('PRODUCT.TENANT_NOT_USABLE', 'This workspace cannot use the model.', { context: { tenant_id: context.tenant_id } })
    }
    let result
    try {
      result = await this.port.complete({ task: task.task, instructions: task.instructions, input, output_contract: task.output_contract })
    } catch (error) {
      if (error instanceof WeddingPlannerError && error.code === 'MODEL.UNKNOWN_TASK') throw error
      throw new ProductError('MODEL.UNAVAILABLE', 'The model did not answer.', { context: { task: task.task }, cause: error })
    }
    const usage = result.usage
    const valid =
      isCount(usage.input_tokens, MODEL_LIMITS.tokens_per_call) &&
      isCount(usage.output_tokens, MODEL_LIMITS.tokens_per_call) &&
      isCount(usage.cost_micro_cents, MODEL_LIMITS.cost_micro_cents_per_call)
    this.store.transaction(() => this.#meter(context, task.task, valid ? usage : undefined))
    if (!valid) throw new ProductError('MODEL.INVALID_USAGE', 'The model reported usage that is not a whole number within bounds.', { context: { task: task.task } })
    const checked = getSchemaRegistry().validate<T>(task.output_contract, result.output)
    if (!checked.valid) {
      throw new ProductError('MODEL.INVALID_OUTPUT', `The model's output does not satisfy '${task.output_contract}'.`, {
        context: { task: task.task, errors: checked.errors.length },
      })
    }
    return checked.data
  }

  /** A workspace's usage for a month (`YYYY-MM`; the current month by default): calls and tokens, per task. */
  usageFor(context: TenantContext, month: string = this.clock.now().slice(0, 7)): ModelUsageView {
    const records = this.#usage.listGroup(context, month).filter((u) => u.month === month)
    const sum = (key: 'calls' | 'input_tokens' | 'output_tokens') => records.reduce((n, u) => n + u[key], 0)
    return {
      month,
      calls: sum('calls'),
      input_tokens: sum('input_tokens'),
      output_tokens: sum('output_tokens'),
      tasks: records.map((u) => ({ task: u.task, calls: u.calls, input_tokens: u.input_tokens, output_tokens: u.output_tokens })),
    }
  }

  /** Count one call: its tokens and cost when its usage report is valid, a rejected report otherwise. */
  #meter(context: TenantContext, task: string, usage: ModelUsage | undefined): void {
    const month = this.clock.now().slice(0, 7)
    const current = this.#usage.read(context, groupedKey(month, task))
    this.#usage.put(context, {
      tenant_id: context.tenant_id,
      month,
      task,
      calls: (current?.calls ?? 0) + 1,
      rejected_usage_calls: (current?.rejected_usage_calls ?? 0) + (usage === undefined ? 1 : 0),
      input_tokens: (current?.input_tokens ?? 0) + (usage?.input_tokens ?? 0),
      output_tokens: (current?.output_tokens ?? 0) + (usage?.output_tokens ?? 0),
      cost_micro_cents: (current?.cost_micro_cents ?? 0) + (usage?.cost_micro_cents ?? 0),
    })
  }
}

function isCount(value: unknown, max: number): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= max
}
