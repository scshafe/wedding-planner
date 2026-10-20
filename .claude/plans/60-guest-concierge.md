# Plan — #60 guest concierge (M4)

Two PRs.

## PR A: the concierge through the job queue

- **The edge** (`handleInbound`): validate; dedupe (`receipts.seen`); resolve the binding and the wedding, as today.
  - A surprise or secret question is refused at once, deterministically and fact-independently: nothing is recorded or
    sent, and the model is not called.
  - Anything else is stored as a pending guest question (tenant-scoped, keyed by a hash of the provider's ref, since
    the ref has no length limit) and enqueued as a `guest_answer` job.
  - Always the uniform 202.
- **The job:**
  - `execute` re-reads the pending question and the binding, and builds the concierge facts: the guest-visible
    projection plus the published website (public events, travel, hotels, FAQ, registry; nothing while unpublished,
    never guest data). It asks the model `GUEST_ANSWER`.
  - The model only SELECTS fact keys (`event_date`, `venue_name`, `faq:2`, …) or escalates. The reply is composed
    from the trusted fact values, never from model text, so it never echoes the guest.
  - The second check: every key must exist in the projection; else escalate.
  - `complete` sends the reply (metered; commit-after-success semantics preserved) or files the escalation (the
    threading / auto-reopen logic moved out of `handleInbound` unchanged), then deletes the pending question.
- **Pruning.** Kind-keyed-per-message jobs are pruned when finished (`JobKind.ephemeral`).
- **The deterministic responder.** `GuestQaResponder` / `DeterministicGuestQaResponder` are replaced: the keyword
  topics move into the simulated `guest_answer` task, extended with hotels, travel, registry, schedule and FAQ matching.
- **Tests.** Every test that sends an inbound message drains the queue (`drainJobs`, or the helper's queue).

## PR B: the eval set

- **In `eval-harness/`:** concierge cases (facts, question, expected outcome: answered with which keys, escalated,
  refused) and a scorer (answer accuracy, refusal correctness), typed through a shared contract.
- **In `app/tests`** (the one place that may import both): the runner applies the product's concierge (refusal
  classifier, simulated task, second check) to the cases and gates on thresholds.
