---
name: model-port
description: Issue #59 / ADR 0057 — the model port is async and task-shaped (instructions from code, user text only in input, output validated against a contract); ModelService.run must run OUTSIDE request transactions (deferred work); metered per workspace/month; ONLY the simulated adapter exists (owner decision), pinned by an architecture test
metadata:
  type: project
---

Since issue #59 (2026-10-19): `product/src/model/`.

- **Owner decision:** only `SimulatedModelAdapter` may implement `ModelPort` (an architecture test checks it). Never
  add a real provider, an API key option or a network call. That is a `status:needs-owner` question.
- **Async port, synchronous pipeline:** never `await` the model inside `api.handle` / a store transaction. Run it in
  deferred work (the post-response hook) and write results in a fresh transaction.
- **Prompt boundary:** instructions come from code; user-written text goes only in `input`, as data.
- **Output:** untrusted until `ModelService.run` validates it against `output_contract`. A new task needs a contract
  under `*/schemas/` plus a deterministic function in `simulated_tasks.ts`.
- **Metering:** every call is counted (`model_usage`, per workspace per month), an invalid output too. The billing
  page shows a simulated cost; nothing is charged (pricing is owner track).

Related: [[guest-messaging-channel-is-a-roadmap-goal]], [[durable-storage-record-store]].
