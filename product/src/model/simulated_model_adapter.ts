import { ProductError } from '../product_error'
import type { ModelPort, ModelRequest, ModelResult } from './model_port'

/**
 * @canonical simulated_model_adapter -- the only {@link ModelPort} adapter (issue #59, ADR 0057): deterministic, offline,
 * for tests and the demo.
 *
 * Each task the product asks for registers a pure function from the request's `input` to an output. The same request
 * always gives the same output, with no network, clock or randomness. Usage is an estimate from the text sizes (about
 * four characters per token), priced at {@link SIMULATED_PROVIDER_PRICE}, so metering behaves as it would with a real
 * provider.
 *
 * A task with no handler is MODEL.UNKNOWN_TASK: a programming error, surfaced loudly.
 *
 * related: model_port.ts (the boundary), model_service.ts (validation and metering), simulated_tasks.ts (the tasks).
 */

/** A simulated task: the output for a request's input. Pure and deterministic. */
export type SimulatedTask = (input: Readonly<Record<string, unknown>>) => unknown

/** The name the simulated adapter answers as. */
export const SIMULATED_MODEL = 'simulated'

/**
 * What the simulated provider charges per million tokens, in cents: a planning placeholder (a typical published price
 * at the time of writing), not a quote. A real provider's price is part of the owner's decision to wire one.
 */
export const SIMULATED_PROVIDER_PRICE = Object.freeze({ input_cents_per_mtok: 300, output_cents_per_mtok: 1500 })

/** Characters per token, for the usage estimate. */
const CHARS_PER_TOKEN = 4

export function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / CHARS_PER_TOKEN))
}

export class SimulatedModelAdapter implements ModelPort {
  readonly #tasks: ReadonlyMap<string, SimulatedTask>

  constructor(tasks: Readonly<Record<string, SimulatedTask>>) {
    this.#tasks = new Map(Object.entries(tasks))
  }

  async complete(request: ModelRequest): Promise<ModelResult> {
    const task = this.#tasks.get(request.task)
    if (task === undefined) throw new ProductError('MODEL.UNKNOWN_TASK', `The simulated model has no task '${request.task}'.`, { context: { task: request.task } })
    let output: unknown
    let outputText: string
    try {
      output = task(request.input)
      outputText = JSON.stringify(output) ?? ''
    } catch (error) {
      throw new ProductError('MODEL.UNAVAILABLE', 'The simulated model failed.', { context: { task: request.task }, cause: error })
    }
    const input_tokens = estimateTokens(request.instructions) + estimateTokens(JSON.stringify(request.input))
    const output_tokens = estimateTokens(outputText)
    return {
      output,
      usage: {
        input_tokens,
        output_tokens,
        // cents per million tokens × tokens = millionths of a cent, exactly.
        cost_micro_cents: input_tokens * SIMULATED_PROVIDER_PRICE.input_cents_per_mtok + output_tokens * SIMULATED_PROVIDER_PRICE.output_cents_per_mtok,
      },
      model: SIMULATED_MODEL,
    }
  }
}
