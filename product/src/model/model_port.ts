import type { ContractKey } from '@wedding-planner/shared'

/**
 * @canonical model_port -- the provider-agnostic boundary to a language model (issue #59, ADR 0057).
 *
 * The product asks a model for one structured thing at a time — a task — and gets back JSON that must satisfy a
 * contract. Nothing here names a vendor, a model family or a wire format: an adapter maps a {@link ModelRequest} to
 * whatever a provider speaks.
 *
 *   - `instructions` come from code, never from a user: what the model is asked to do is fixed by the product.
 *   - `input` is the facts the model may use, as JSON data. Text a user wrote (a guest's question) appears only here,
 *     as data — never spliced into the instructions.
 *   - `output_contract` names the JSON Schema contract the output must satisfy. The caller-side `ModelService`
 *     validates it before anyone uses it, so an adapter's output is untrusted until then.
 *
 * The port is asynchronous because every real provider is: callers run it OUTSIDE a request's store transaction
 * (deferred work), never holding the database lock across a model call.
 *
 * Owner decision (2026-10-19): only the simulated adapter is built (simulated_model_adapter.ts). A real provider costs
 * money, so wiring one is an owner crossing, not a code change an agent makes.
 *
 * related: simulated_model_adapter.ts (the only adapter), model_service.ts (validation and metering).
 */
export interface ModelRequest {
  /** What the product asks for (`checklist_draft`, …): names the adapter's behaviour and the usage line. */
  readonly task: string
  /** Fixed instructions, from code. */
  readonly instructions: string
  /** The facts the model may use. User-written text appears only here, as data. */
  readonly input: Readonly<Record<string, unknown>>
  /** The contract the output must satisfy. */
  readonly output_contract: ContractKey
}

/** How much a call used, in the provider's units (tokens). */
export interface ModelUsage {
  readonly input_tokens: number
  readonly output_tokens: number
}

export interface ModelResult {
  /** The model's output — untrusted until validated against the request's contract. */
  readonly output: unknown
  readonly usage: ModelUsage
  /** Which model answered (`simulated` for the simulated adapter). */
  readonly model: string
}

export interface ModelPort {
  complete(request: ModelRequest): Promise<ModelResult>
}
