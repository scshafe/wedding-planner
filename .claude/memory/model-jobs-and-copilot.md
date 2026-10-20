---
name: model-jobs-and-copilot
description: Issue #61 / ADR 0058 — JobQueue (generic outbox: row per kind+subject in the request's tx; index of tenant+key+due time with the invariant 'every live job has an entry'; per-entry savepoint claims; lease; complete only while the claim holds; only coded MODEL.UNAVAILABLE retried); the planner copilot is its first kind, checked against its input, kept via services, accept guarded by the draft's requested_at
metadata:
  type: project
---

Since issue #61 (2026-10-20): `product/src/jobs/job_queue.ts`, `product/src/copilot/`.

- **A new model feature** = a `JobKind` registered in compose, plus a task (ADR 0057).
  - `execute` runs outside a transaction; `wanted`, `complete` and `failed` run inside one.
  - Never await the model in a request.
- **Invariant:** every queued or running job has its `job_queue` entry. A suspended workspace's entries stay (skipped);
  only an unknown tenant's are removed.
- **Retries:** only a CODED `MODEL.UNAVAILABLE` is retried; uncoded errors fail at once (`JOB.INTERNAL_ERROR`).
- **Job rows** hold ids only; the facts are read fresh in `execute`. The global `job_queue` holds tenant + key
  only.
- **`complete` must tolerate a stale world:** the draft may have been discarded or replaced; write nothing then.
- **Tests:** `await surface.drainJobs()`. `api.handle` alone does not drain (the web adapter's deferred work does).
- **Model output never carries ids:** the copilot names vendors and events by position; `checkDraft` maps them back.
  Copy that pattern.

Related: [[model-port]], [[run-of-show]].
