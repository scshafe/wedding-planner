# ADR 0057 — The model port and its simulated adapter

- **Status:** accepted
- **Date:** 2026-10-19
- **Decider:** the building agent (an agent-owned engineering decision per [[agents-own-buildout-decisions]]), within
  the owner's decision of 2026-10-19: "M4 with the model port's SIMULATED adapter only (a real model costs money:
  that stays an owner decision)". For issue #59 (M4 "AI planning assistant").
- **Scope:** how the product asks a language model for anything: the guest concierge (#60), the planner copilot (#61)
  and the weekly risk summary (#62) all go through it.

## Decision

### A task-shaped, provider-agnostic port

`ModelPort.complete(request): Promise<ModelResult>`. A request is one task:
- **`task`:** what is asked, by name.
- **`instructions`:** fixed text from code.
- **`input`:** the facts the model may use, as JSON.
- **`output_contract`:** the JSON Schema contract the output must satisfy.

The result is the output (untrusted), the token usage and the model's name. Nothing names a vendor, a model family or
a wire format.

User-written text (a guest's question) appears only in `input`, as data, never in the instructions. The product
decides what the model is asked to do. The contracts under `*/schemas/` stay the source of truth for every output
shape.

### Asynchronous, and never inside a request's transaction

Every real provider is asynchronous and slow, and the request pipeline is synchronous, with one transaction per
request (ADR 0039). So:
- **The port returns a promise.**
- **The caller-side `ModelService.run` awaits it outside any store transaction**, then writes the usage in its own
  short transaction.
- **Features call it from deferred work** (the post-response hook password resets already use), never while a
  request holds the database lock.

The first feature that needs this, the copilot (#61), adds a small durable job queue on that hook. A synchronous
port would have been simpler today, but no real adapter could implement it, and the owner's line is to build up to
the crossing, not short of it.

### Validated before use, metered always

`ModelService.run(context, request)`:
- **Output:** validates the output against `output_contract`. A failure is `MODEL.INVALID_OUTPUT`, and the caller writes
  nothing.
- **Usage report:** checks it is whole, non-negative numbers (`MODEL.INVALID_USAGE`). A provider's report is untrusted
  input, like a messaging provider's cost (`PRODUCT.PROVIDER_COST_INVALID`).
- **Metering:** counts the call in the workspace's usage for the month (`model_usage`, key `YYYY-MM`: calls, input and
  output tokens). An invalid output counts too, since a provider bills for it.
- **Adapter failures:** become `MODEL.UNAVAILABLE`. `MODEL.UNKNOWN_TASK` passes through: it is a programming error.

**Shown, not charged.** The billing page shows the month's calls and tokens with a simulated provider cost
(`SIMULATED_PROVIDER_PRICE`, a planning placeholder). Turning usage into ledger charges, and at what price, is a
pricing decision on the owner track, like messaging's margin (Phase 18).

### Only the simulated adapter

`SimulatedModelAdapter` maps each task name to a pure function of the input:
- **Deterministic:** no network, clock or randomness.
- **Usage:** estimated from the text sizes (about four characters per token).
- **Tasks:** each feature registers its own task in `simulated_tasks.ts`, next to its output contract.

The composition root wires it and nothing else:
- `simulatedModelTasks` lets a test add a task;
- there is no option, environment variable or code path for a real model;
- an architecture test pins that the simulated adapter is the only class implementing the port, and that the model
  code reads no environment and makes no network call.

Wiring a real provider is an owner decision (`status:needs-owner`): an account, a key in the stack's `.env`, a price.
It would be one new adapter behind this port, plus a composition change.

## Consequences

- Every M4 feature is testable and demoable offline, and deterministic.
- The simulated answers are only as good as their rules, so the eval set (#60) measures the concierge on them. A real
  model would be measured by the same eval set before the owner switches it on.
- Not done: streaming, tool use, conversation memory. Each task is one request and one structured answer.
