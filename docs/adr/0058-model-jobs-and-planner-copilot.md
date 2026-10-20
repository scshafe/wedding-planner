# ADR 0058 — Model jobs, and the planner copilot

- **Status:** accepted
- **Date:** 2026-10-20
- **Decider:** the building agent (an agent-owned engineering decision per [[agents-own-buildout-decisions]]), for
  issue #61 (M4 "AI planning assistant"), within ADR 0057 (the model port, simulated adapter only).
- **Scope:**
  - The job queue every model call goes through. It is ADR 0039's outbox dispatcher, and ADR 0057 listed what it must
    get right.
  - Its first kind: the planner copilot, which drafts a first checklist and a run of show from what a wedding already
    knows.

## Decision

### The job queue (`job_queue.ts`)

The queue is named for jobs, not model calls: it is ADR 0039's outbox dispatcher for anything done after a request.
Model calls are its first use; M5's real email and SMS sends are meant to become kinds here. The collections are new,
so the name cost nothing now; it would have needed a migration later.

A request never awaits the slow part. It **enqueues** a job and returns; the drain runs the job afterwards.

- **The outbox row.** `job` is tenant-scoped and keyed `groupedKey(kind, subject_id)`, under the `job` contract. It is
  written in the request's own transaction.
  - It holds ids only (kind, subject, who asked, status, attempts, timing, last error code). The facts are read again
    when the job runs.
  - One row per kind and subject means one live job: a second request while one is queued or running returns it.
- **The index.** `job_queue` is global and holds each live job's tenant, key and **due time**, never tenant content.
  - Invariant: every queued or running job has its entry. `enqueue` puts it back whenever it returns a live job, so a
    job can never be orphaned.
- **Claim.** Each index entry is claimed in its own savepoint, so one entry that throws (say, a row a rolled-back build
  cannot write) is recorded, passed over for a lease period, and never stops the drain.
  - Only entries due now are looked at, so the scan reads no tenant data. The tenant that ran least recently goes first
    (fairness across tenants, in-process).
  - A queued job past its backoff, or a running one whose lease expired, becomes `running` with a lease (120 s, twice
    the deadline) and one more attempt.
  - A lease expiring on the last attempt is a final failure (`JOB.LEASE_EXPIRED`), not another call.
  - A suspended workspace's jobs stay and are passed over until it is usable again; a workspace that is gone loses
    them.
  - A kind this build does not know (a rollback) is left for a build that does.
- **Run, with no transaction.** The kind may say the job is no longer wanted (`wanted`), and then nothing is called.
  Otherwise `execute` reads fresh and awaits within a 60 s deadline (an injected timer).
- **Complete, in one fresh transaction,** only if the stored job is still the claim the run started under (same job,
  status and attempt), so a run that outlived its lease writes nothing.
- **Failures.**
  - Only a coded `MODEL.UNAVAILABLE` (an adapter failure, a missed deadline) is retried, with backoff on the injected
    clock (30 s, then 60 s), up to 3 attempts.
  - Anything else fails at once: an invalid output, or a programming error (`JOB.INTERNAL_ERROR`).
  - Every failure is recorded in the operator's error log (#13). A final one also tells the kind (`failed`, so the page
    can say "try again"), in a savepoint, so a throwing hook cannot keep the job alive.
- **One drain at a time.** `drain()` joins a running drain, starts on the next tick (never inside a caller's
  transaction), and never rejects. Jobs run one at a time. It starts:
  - after every response (`ProductApi.runDeferredWork`);
  - at boot (jobs left by a restart);
  - when the next job falls due: after a drain, the injected timer is armed for the earliest due time.

  Tests await `drainJobs()`.

### Departures from ADR 0057's list

- **No input fingerprint.** The dedupe key is the row key (kind and subject), and the facts are read fresh when the job
  runs, so nothing would compare a fingerprint.
- **Pruning by kind.** Finished rows are overwritten by the next request for the same subject, which is enough for kinds
  keyed by a long-lived subject (a wedding). A kind keyed per event (the concierge, #60, ADR 0059) is `ephemeral`: its
  rows are deleted when the job ends.
- **`MODEL.INVALID_OUTPUT` is never retried.** The queue cannot tell a deterministic adapter (where a retry repeats the
  same answer) from a real one; with a real provider, at most one retry could be added.

### Model output contracts are a closed set

`ModelOutputContract` is a union of contracts made for model output: `copilot_draft_output` so far. A task cannot
declare a persisted record's contract as its output.

### The planner copilot (`copilot_service.ts`)

- **Ask.** `POST …/weddings/:id/copilot` (planner only; 202) enqueues `copilot_draft` and marks the wedding's draft
  `drafting`.
- **Draft.**
  1. The job reads the wedding fresh: date, events (name and time), vendors (category only, no names: data
     minimization for a future real model), and the titles already on the checklist and run of show.
  2. It asks the model (`COPILOT_DRAFT`, defined once in code).
  3. It checks the answer against what it sent. This is the second check, after the contract:
     - a task must be due on a real date between today and the wedding;
     - an item must start at a real local time within a day of the wedding's events, and name a vendor or event only
       by its position in the lists the job sent, which the job maps back to ids (the model never supplies an id);
     - text must be plain, titles new, and each list at most 40.

     What fails is dropped.
- **The simulated model** (`copilot_simulation.ts`) drafts deterministically:
  - tasks: one well-known step per vendor category, confirming each event's timing, and a few steps every wedding
    needs, due a fixed number of days back from the date (never before today);
  - run-of-show items: a final walkthrough an hour before each event, and setup and arrival times for vendors.
- **Keep.** `POST …/copilot/accept {draft, task_ids, item_ids}` adds the picked ones through `ChecklistService.addTask` and
  `RunOfShowService.addItem`, so their limits, validation and boundaries apply. Kept items leave the draft; the rest
  stay. An item whose vendor or event was removed since the draft is skipped and counted.
  - `draft` is the draft's `requested_at`. Draft ids restart with each draft, so a form from an earlier draft (another
    tab, a teammate's "Draft again") is refused with a 409 (`draft_changed`) instead of keeping items the planner never
    saw.
- **Discard.** `DELETE …/copilot` removes the draft. The job is then no longer wanted, so the model is not called.
  - A job already running writes nothing, because completion only fills a draft that is still `drafting`.
  - If a new draft was asked for in the meantime, the running job fills it, with facts read moments before.
- **Pages.** `?wedding=<id>&tab=copilot`, linked for planners from the wedding page and the run of show. While a draft
  is drafting the page says so with a refresh link; there is no script. The forms are `/t/:slug/copilot/draft-request
  | draft-accept | draft-discard`, CSRF-checked first.

## Consequences

- **Later model features** (the concierge #60, the risk summary #62) register a kind and get durability, leases,
  retries, deadlines, fairness and metering for free. M5's real email and SMS sends can move onto the same queue.
- **The drafts are only as good as their rules.** With the simulated model they are deterministic and conservative; a
  real model would be judged by the same second check before the owner switches one on.
- **Not done:** drafting the budget, editing a draft item before keeping it, scheduled (weekly) jobs (#62's follow-up).
