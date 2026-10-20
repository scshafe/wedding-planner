---
name: model-port
description: Issue #59 / ADR 0057 — tasks defined once in code (defineModelTask); async port run OUTSIDE request transactions; workspace checked before the call; output validated (contract, then a feature check) and never trusted/persisted as-is; metered per workspace/month/task with the provider's cost recorded but never shown to the tenant; ONLY the simulated adapter (owner decision)
metadata:
  type: project
---

Since issue #59 (2026-10-19): `product/src/model/`.

- **Owner decision:** only `SimulatedModelAdapter` is composed. Never add a real provider, an API key option or a
  network call: that is a `status:needs-owner` question. The test on compose.ts is a tripwire, not a proof.
- **Async port, synchronous pipeline:** never `await` the model inside `api.handle` / a store transaction. Run it in
  deferred work and write results in a fresh transaction. ADR 0057 lists what the job queue must get right (outbox
  row, lease, re-minted context, single flight, deadline, retry rules, idempotent side effects).
- **A new task:**
  - a `defineModelTask` constant in the feature;
  - a contract under `product/schemas/`;
  - a deterministic function in `simulated_tasks.ts`;
  - a feature-side check of the output against the input.
- **Model output:** never carries a trusted id and is never persisted as-is: accept it through the services.
- **Metering:** `model_usage` is keyed `groupedKey(month, task)`. The tenant sees calls and tokens; the cost
  (`cost_micro_cents`, reported by the adapter) is never shown to the tenant (billing_summary.ts's invariant).

Related: [[guest-messaging-channel-is-a-roadmap-goal]], [[durable-storage-record-store]].
