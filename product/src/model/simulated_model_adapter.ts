import { ProductError } from '../product_error'
import type { ModelPort, ModelRequest, ModelResult } from './model_port'

/**
 * @canonical simulated_model_adapter -- the only {@link ModelPort} adapter (issue #59, ADR 0057): deterministic, offline,
 * for tests and the demo.
 *
 * Each task the product asks for registers a pure function from the request's `input` to an output. The same request
 * always gives the same output, with no network, clock or randomness. Usage is an estimate from the text sizes (about
 * four characters per token), so metering and the billing page behave as they would with a real provider.
 *
 * A task with no handler is MODEL.UNKNOWN_TASK: a programming error, surfaced loudly.
 *
 * related: model_port.ts (the boundary), model_service.ts (validation and metering).
 */

/** A simulated task: the output for a request's input. Pure and deterministic. */
export type SimulatedTask = (input: Readonly<Record<string, unknown>>) => unknown

/** The name the simulated adapter answers as. */
export const SIMULATED_MODEL = 'simulated'

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

  complete(request: ModelRequest): Promise<ModelResult> {
    const task = this.#tasks.get(request.task)
    if (task === undefined) {
      return Promise.reject(new ProductError('MODEL.UNKNOWN_TASK', `The simulated model has no task '${request.task}'.`, { context: { task: request.task } }))
    }
    let output: unknown
    try {
      output = task(request.input)
    } catch (error) {
      return Promise.reject(new ProductError('MODEL.UNAVAILABLE', 'The simulated model failed.', { context: { task: request.task }, cause: error }))
    }
    return Promise.resolve({
      output,
      usage: {
        input_tokens: estimateTokens(request.instructions) + estimateTokens(JSON.stringify(request.input)),
        output_tokens: estimateTokens(JSON.stringify(output) ?? ''),
      },
      model: SIMULATED_MODEL,
    })
  }
}
