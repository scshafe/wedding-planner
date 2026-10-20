# ADR 0059 — The guest concierge

- **Status:** accepted
- **Date:** 2026-10-20
- **Decider:** the building agent (an agent-owned engineering decision per [[agents-own-buildout-decisions]]), for
  issue #60 (M4 "AI planning assistant"), within ADR 0057 (the model port, simulated adapter only) and ADR 0058 (the
  job queue).
- **Scope:** guests text a question; the platform answers from what guests may see, or hands the question to the couple
  and planner. This replaces the deterministic keyword responder (Phase 19–22).

## Decision

### The edge refuses or queues; a job answers

ADR 0057 keeps model calls out of requests, so the inbound webhook (`handleInbound`) keeps everything that must be
synchronous and moves the rest into a job:
1. **Unchanged checks:** validate, dedupe (`receipts.seen`), resolve the guest's binding, and check the bound wedding
   exists. The edge always answers the uniform 202.
   - The only residual signal is timing. A queued message takes measurably longer than a refused or unbound one. It
     depends only on the caller's own text and the sender's registration (as before), never on a wedding fact.
2. **A surprise or secret question is refused here** (`isSurpriseProbe`): nothing is recorded, queued, asked or sent,
   for every wedding alike. The refusal reads no wedding data, so it can never say whether a surprise exists
   (COMMS.SURPRISE_LEAK), and it costs nothing.
3. **Anything else is stored and queued.** The edge writes a pending guest question and a `guest_answer` job, and
   returns.
   - The question is tenant-scoped, keyed by a hash of the provider's ref (which has no length limit), and its text is
     capped at 4000 characters.
   - **Bounds:** at most 5 questions per guest and 200 per workspace wait at once. A message over either bound goes
     straight to the inbox, with no job and no model call. Neither a guest nor a holder of the webhook token can grow
     the queue without bound.

The job (`ConciergeService`):
- **Runs fresh, against the binding the message came in under.**
  - `execute` re-reads the question.
  - A message already replied to or already filed (a re-delivery) is skipped before any model call.
  - A guest unbound or re-bound since the message arrived is neither answered nor filed. A question written for one
    wedding never reaches another's inbox.
  - A cancelled wedding answers nothing automatically: the question is escalated.
- **Asks the model.** It builds the facts and asks `GUEST_ANSWER` (defined once in code).
- **Checks the answer.** Every key must be one the projection holds, else the question is escalated.
- **`complete` (one transaction)** re-checks the binding, because the model call took time, then:
  - **either sends the reply** through the metered service, commit-after-success. A structured send failure files the
    question instead: the provider has had its 202 and will not deliver the message again;
  - **or files the question** in the inbox through `fileGuestEscalation`: the Phase 26/35/37 threading and auto-reopen,
    moved out of the edge unchanged, still process-once by the message's ref.

  Then it deletes the pending question.
- **Escalates if the model fails for good.** `failed` files the question (under the same binding rule), so nothing a
  guest asks is lost. The pending question is deleted even if filing throws, so guest text is never orphaned.
- **Prunes per-message jobs.** The kind is `ephemeral`: its job row goes when the job ends, which is the pruning ADR
  0058 deferred to the first per-event kind.

### What guests may be told: an allow-list

`projectConciergeFacts(wedding, site)` copies named fields only:
- **The wedding's guest-shareable logistics:** the couple's name, the date, ceremony time, venue, parking, dress code.
- **The website's public content, only while it is published** (`SiteService.publishedSiteOf`, the same allow-list as
  the public page): the public events (name, time, place), travel notes, hotel blocks, the FAQ and registry links.

Never a guest, a count, an RSVP, a planner note or an id. What the projection does not hold cannot reach a guest.

### The model points; the product speaks

The model's output (`guest_answer_output`, a model-output contract) is `{action: answer | escalate, facts: [keys]}`.
- **Keys only.** The keys are `event_date`, `venue_name`, `travel`, `schedule:N`, `hotel:N`, `faq:N` and so on: at most
  three, and never text.
- **The reply is worded by the product** (`renderConciergeAnswer`) from the trusted values of held keys (duplicate keys
  dropped). It is capped at 480 characters, about three text messages, and cut with ASCII dots, because a non-GSM
  character would force the dearer SMS encoding. So a reply only ever says what the projection says, and never echoes the guest's message; a
  prompt injected in a question can at most choose among facts a guest may see anyway.
- **The question is data.** It is shortened to 500 characters and sent as input, never as instructions.

The simulated model (`simulateGuestAnswer`) picks deterministically:
1. a close FAQ match;
2. otherwise the logistics topics in priority order (hotels, parking, dress, registry, travel, schedule with named
   events, timing, place);
3. otherwise any FAQ sharing a word;
4. otherwise it escalates.

A topic whose fact the wedding does not hold escalates rather than guessing.

## Consequences

- **More answers.** A guest can now ask about hotels, travel, the schedule, the registry and the FAQ once the couple
  publishes the website.
- **Asynchronous replies.** A reply arrives a moment after the webhook's 202, not inside it. That is expected for text
  messages, and the job queue makes it durable across restarts.
- **The eval set** (the second PR of #60) measures the concierge's answers and refusals on a corpus, and would measure
  a real model the same way before the owner switches one on.
- **Not done:** conversation memory across messages, multilingual matching, and answers composed from a real model's
  text (it would still only point at keys).
