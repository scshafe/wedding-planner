---
name: guest-concierge
description: Issue #60 / ADR 0059 — inbound guest messages: the edge refuses surprise probes (fact-independent, nothing recorded) and otherwise stores a pending question + enqueues a guest_answer job; the job answers from projectConciergeFacts (logistics + the PUBLISHED website only) with the model choosing fact KEYS and the product wording the reply, or files the escalation (fileGuestEscalation, unchanged threading)
metadata:
  type: project
---

Since issue #60 (2026-10-20): `product/src/concierge/`, `product/src/messaging/escalation_filing.ts`.

- **The edge never answers or escalates itself any more.** Tests that send an inbound message must drain the queue:
  `await surface.drainJobs()`, or `conciergeWorld(...).drain` from `product/tests/support/concierge_world.ts` for a
  hand-built ProductApi.
- **The projection is the security boundary** (`projectConciergeFacts`: explicit fields; the website only while
  published). Never add guest data, counts or ids.
- **The model returns keys, never text;** `renderConciergeAnswer` words replies from trusted values. Keep it that way
  even with a real model.
- **Refusal** (`isSurpriseProbe`) happens at the edge and reads no wedding data. Do not make it conditional on facts.
- **`guest_answer` is an ephemeral job kind:** finished rows are deleted (per-message pruning).

Related: [[model-jobs-and-copilot]], [[model-port]], [[wedding-website]].
