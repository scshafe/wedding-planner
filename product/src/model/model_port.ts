import type { ContractKey } from '@wedding-planner/shared'

/**
 * @canonical model_port -- the provider-agnostic boundary to a language model (issue #59, ADR 0057).
 *
 * The product asks a model for one structured thing at a time — a task — and gets back JSON that must satisfy a
 * contract. Nothing here names a vendor, a model family or a wire format: an adapter maps a {@link ModelRequest} to
 * whatever a provider speaks.
 *
 *   - A task is DEFINED ONCE, in code ({@link defineModelTask}): its name, its instructions and its output contract.
 *     So what the model is asked to do is fixed by the product, never assembled per request.
 *   - `input` is the facts the model may use, as JSON data — an allow-listed projection, since with a real provider it
 *     leaves the system. Text a user wrote (a guest's question) appears only here, as data.
 *   - The output contract is one of {@link MODEL_OUTPUT_CONTRACTS}: shapes made for model output, never a persisted
 *     record's.
 *   - The output is untrusted: `ModelService` validates it against the task's contract, and each feature then checks
 *     it against its own input (an answer cites only projected facts, a due date falls before the wedding). Model
 *     output never carries a tenant or record id the caller trusts, and is never persisted as-is: accepting it goes
 *     through the existing services.
 *   - The adapter reports what the call cost the provider (`cost_micro_cents`), as a messaging adapter reports its
 *     per-message cost: a provider's price is a fact about the adapter, never the domain.
 *
 * The port is asynchronous because every real provider is: callers run it OUTSIDE a request's store transaction
 * (deferred work), never holding the database lock across a model call.
 *
 * Owner decision (2026-10-19): only the simulated adapter is built (simulated_model_adapter.ts). A real provider costs
 * money, so wiring one is an owner crossing, not a code change an agent makes.
 *
 * related: simulated_model_adapter.ts (the only adapter), model_service.ts (validation and metering).
 */

/** The contracts a model's output may be validated against: model outputs only, never a persisted record's. */
export const MODEL_OUTPUT_CONTRACTS = ['copilot_draft_output', 'guest_answer_output', 'risk_summary_output'] as const satisfies readonly ContractKey[]
export type ModelOutputContract = (typeof MODEL_OUTPUT_CONTRACTS)[number]

/** One task the product asks a model for: defined once, in code. `T` is what its validated output is. */
export interface ModelTaskDefinition<T> {
  /** The task's name (`checklist_draft`, …): the simulated adapter's behaviour and the usage line. */
  readonly task: string
  /** Fixed instructions. */
  readonly instructions: string
  /** The contract the output must satisfy (a model-output contract). */
  readonly output_contract: ModelOutputContract
  /** Phantom marker tying the output type to the definition — never set at runtime. */
  readonly __output?: T
}

/** Define a task (a module constant in the feature that asks for it). */
export function defineModelTask<T>(definition: { readonly task: string; readonly instructions: string; readonly output_contract: ModelOutputContract }): ModelTaskDefinition<T> {
  return Object.freeze({ ...definition })
}

/** What an adapter is asked: a task's definition and this call's facts. */
export interface ModelRequest {
  readonly task: string
  readonly instructions: string
  /** The facts the model may use. User-written text appears only here, as data. */
  readonly input: Readonly<Record<string, unknown>>
  readonly output_contract: ModelOutputContract
}

/** How much a call used and cost, as the provider reports it. */
export interface ModelUsage {
  readonly input_tokens: number
  readonly output_tokens: number
  /** What the call cost the provider's customer (us), in millionths of a cent. */
  readonly cost_micro_cents: number
}

export interface ModelResult {
  /** The model's output — untrusted until validated. */
  readonly output: unknown
  readonly usage: ModelUsage
  /** Which model answered (`simulated` for the simulated adapter). */
  readonly model: string
}

export interface ModelPort {
  complete(request: ModelRequest): Promise<ModelResult>
}
