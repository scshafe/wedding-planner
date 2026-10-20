# ADR 0057 — The model port and its simulated adapter

- **Status:** accepted
- **Date:** 2026-10-19
- **Decider:** the building agent (an agent-owned engineering decision per [[agents-own-buildout-decisions]]), within
  the owner's decision of 2026-10-19: "M4 with the model port's SIMULATED adapter only (a real model costs money:
  that stays an owner decision)". For issue #59 (M4 "AI planning assistant").
- **Scope:** how the product asks a language model for anything. The guest concierge (#60), the planner copilot (#61)
  and the weekly risk summary (#62) all go through it.

## Decision

### Tasks defined once, in code; a provider-agnostic port

Each feature declares its task once, as a module constant:
`defineModelTask<T>({ task, instructions, output_contract })`.

- **The task's name** selects the adapter's behaviour and the usage line.
- **The instructions** are fixed text from code.
- **The output contract** is a JSON Schema under `*/schemas/`, the source of truth for the output's shape.

`ModelService.run(context, task, input)` returns that task's `T`. What the model is asked to do is therefore fixed by
the product, never assembled per request.

The port, `ModelPort.complete(request): Promise<ModelResult>`, takes the task's definition plus this call's `input`
(the facts, as JSON). It returns:
- the output (untrusted);
- the usage: input and output tokens, and the cost the provider reports (`cost_micro_cents`);
- the model's name.

Nothing names a vendor, a model family or a wire format.

### What may go in, and what comes out

- **Input.** An allow-listed projection of the facts the task needs, like `projectGuestVisibleFacts`. With a real
  provider, the input leaves the system. User-written text (a guest's question) appears only in the input, as data,
  never in the instructions.
- **Output: two checks.**
  1. `ModelService` validates the output against the task's contract.
  2. Each feature checks it against its own input:
     - #60: every fact an answer cites is in the projection;
     - #61: due dates fall on or before the wedding;
     - #62: every statement maps to a computed signal.
- **Never trusted, never persisted as-is.** Model output never carries a tenant or record id the caller trusts.
  Accepting it goes through the existing services, with their limits, validation and boundaries.
- **Output contracts.** A closed set of output contracts will come with the first real task's contract (#61). Until
  then, tests borrow an existing contract for a shape and say so.

### Asynchronous, and never inside a request's transaction

Every real provider is asynchronous and slow, while the request pipeline is synchronous, with one transaction per
request (ADR 0039).
- **The port returns a promise.**
- **`ModelService.run` awaits it outside any store transaction**, then writes the usage in its own short transaction.
- **Features call it from deferred work**, never while a request holds the database lock.

**Alternative rejected: a synchronous port.** It would be simpler today, but no real adapter could implement it, and
the owner's line is to build up to the crossing, not short of it.

### The job queue (built by whichever of #60 and #61 lands first)

The queue is ADR 0039's planned outbox dispatcher: one implementation, generic over job kinds. M5's real email and
SMS adapters will reuse it (their ports are synchronous today). It must get these right:

- **Durability: the outbox pattern.**
  - The job row is written inside the request's transaction.
  - It holds a kind, the tenant, subject ids, who asked, an input fingerprint and a dedupe key.
  - It holds no user text in the global partition: it refers to tenant-scoped rows by id.
- **Claiming: a lease, never take-and-delete.**
  - A job is claimed in one short transaction (status, `lease_until`, attempts).
  - A restart or deploy in the middle of a call re-runs the job when its lease expires.
  - The queue drains at boot as well as after requests.
- **Transactions: claim, then `await run`, then complete.** Completion happens in a fresh transaction, which first
  re-checks that the lease is still held.
- **Tenant contexts.** A context is re-minted when the job runs and never held across the boundary. A suspended or
  removed workspace ends the job without calling the model. The worker has no principal, so authorization happens
  when someone reads or accepts the result.
- **Single flight.**
  - One drain runs at a time, with bounded concurrency.
  - There is one live job per dedupe key, so a second "Draft" click returns the existing job.
  - Each call has a deadline, because a hung call must not wedge the drain.
- **Failures.**
  - `MODEL.UNAVAILABLE` retries with backoff, timed by the injected clock, then fails visibly.
  - `MODEL.INVALID_OUTPUT` is retried at most once (never for the deterministic adapter).
  - Programming errors fail at once.
  - Every failure goes to the operator's error log (#13).
  - The drain's promise has a terminal catch.
- **Side effects are idempotent.** For example, #60's reply uses the messaging idempotency key derived from the
  inbound message.
- **Housekeeping.** Finished jobs are pruned.
- **The hook changes.** `runDeferredWork` starts a drain, or joins the running one, and exposes a promise that tests
  can await.

### Checked before, validated after, metered always

`ModelService.run(context, task, input)`:
1. **Refuses a suspended or unknown workspace before the model is called**, so a job queued before a suspension never
   pays a provider. (A suspension during a call in flight refuses that call's usage row: the one remaining race.)
2. **Checks the usage report** (whole, non-negative, within `MODEL_LIMITS` per call). A provider's report is untrusted
   input, like a messaging provider's cost (`PRODUCT.PROVIDER_COST_INVALID`).
3. **Meters every call that answered** in `model_usage`, keyed `groupedKey(month, task)` per workspace:
   - calls, tokens and the provider's reported cost;
   - a refused report counts as a rejected call with no tokens;
   - an invalid output counts too, since a provider bills for it.
4. **Validates the output** against the task's contract (`MODEL.INVALID_OUTPUT`).

`MODEL.UNAVAILABLE` covers adapter failures. `MODEL.UNKNOWN_TASK` passes through: it is a programming error.

**The tenant sees usage, not cost.** The billing page shows the month's calls and tokens, the workspace's own usage
like `messages_sent`. The provider's cost is recorded per task, for the operator and for pricing, and never shown to
the tenant (billing_summary.ts's invariant: never the COGS or the margin). Nothing is charged yet.
- **The cost belongs to the adapter.** It is reported by the adapter, as `MessagingPort.costReport` reports a
  message's cost.
- **Pricing comes later.** Turning usage into ledger charges at a tenant price with margin (`price_book`) is a pricing
  decision on the owner track, as messaging's was (Phase 18).
- **Per task** is where the concierge's cost per guest message comes from, the denominator the messaging strategy
  needs.

**Alternative rejected: a ledger charge per call.** Integer cents round most calls to zero, and the price is the
owner's call.

### Only the simulated adapter

`SimulatedModelAdapter` maps each task name to a pure function of the input:
- **Deterministic:** no network, clock or randomness.
- **Usage:** estimated from the text sizes, about four characters per token.
- **Price:** its own placeholder price (`SIMULATED_PROVIDER_PRICE`).

Each feature registers its task in `simulated_tasks.ts`.

The composition root wires it and nothing else:
- `simulatedModelTasks` lets a test **add** a task, and a name that would replace a product task is refused;
- there is no option, environment variable or code path for a real model.

A test acts as a **tripwire** on that root:
- the model service is built only in compose.ts, over the simulated adapter;
- the config names no port;
- the entrypoint passes no tasks;
- no source under `product/src` or `app/` makes an outbound network call.

It does not prove every structural implementation away; the composition root is what holds the line.

**Wiring a real provider is an owner decision** (`status:needs-owner`): an account, a key in the stack's `.env`, a
price and data-handling terms. It would be one new adapter behind this port, plus a composition change. Two things
would come with it:
- a per-call output limit;
- a monthly spend quota per workspace, checked in `run` before the call, because guest traffic must not drive
  unbounded spend.

## Consequences

- **Offline and deterministic.** Every M4 feature is testable and demoable offline, and deterministic.
- **The eval set.** The simulated answers are only as good as their rules, so the eval set (#60) measures the
  concierge on them, and would measure a real model the same way before the owner switches one on.
  - eval-harness may import only `@wedding-planner/shared`, so the cases and the scorer live there, typed through a
    shared contract.
  - The runner lives in `app/tests`, the one place that may import both.
- **Usage months** are UTC calendar months: a usage view, not a billing period.
- **Not done:** streaming, tool use, conversation memory. Each task is one request and one structured answer.
