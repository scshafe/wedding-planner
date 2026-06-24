# Telemetry

The instrumentation contract for the AI wedding planner. It defines the canonical **events**
the system emits and the **metrics** derived from them. Every `metric_code` referenced by the
eval harness, and every deterministic gate, is a pure function over a stream of these events.

## The central principle: one event schema, two sources

The eval harness (`source: eval`) and production (`source: production`) emit the **identical
event envelope**. A metric is computed the same way in both. This is what makes the recursive
loop trustworthy: an offline score improvement is only believed once the *same* metric, over
*production* events, confirms it. If the two diverge, the gap itself is a missing eval case.

```
                 ┌─────────────────────┐
 eval run  ──►   │   event stream      │  ──►  metrics + gates  ──►  grade_report
 production ──►  │  (one schema)       │  ──►  metrics + gates  ──►  dashboards / A-B
                 └─────────────────────┘
```

Consequences:

- **Metrics own no state.** A metric is `f(events filtered by wedding_id)`. It is replayable:
  re-run it over an old event stream and get the identical number. No metric reads ambient
  clocks or counters.
- **Gates compute from the same events.** The deterministic gates in
  `../eval-harness/rubrics/gate_checks.md` are also pure functions over this stream — but over the
  *trusted* portion of it (see the integrity principle below), not the product's self-report.
- **Capability attribution is free.** Every event carries a `capability`; the
  `per_capability_scorecard` in the grade report is just metrics grouped by that field.

## Integrity: the product is an untrusted author of its own events

"A metric is a pure function over events" is a **determinism** guarantee, not an **integrity**
guarantee. The product emits these events, and in the recursive loop the product is exactly what
the proposer rewrites — so a candidate can ship a change that forges or suppresses the events a
gate reads (emit a synthetic `commitment.approved`, stamp `verified: true` on a booking that never
confirmed, omit a `comms.fact_asserted` to dodge the false-fact check). Trusting the gradee's
account of itself makes every "untouchable" veto gate defeatable by a product-only change.

So **security-relevant ground truth is authored by channels the product cannot forge:**

- **The trusted recorder.** The harness intercepts the product's *actual* (sandboxed) effects —
  the real money-movement / booking / send calls — and records them out-of-band. Fields that
  decide a veto gate (`verified`, `verified_status`, `approved_by_event_id`, committed totals) are
  written from this trusted record, **not** from the product's payload.
- **The grader.** Correctness determinations (`satisfied`, `correct`) are computed grader-side
  from persona/scenario ground truth, **not** set by the product.
- **Cross-check, fail closed.** The product's self-reported events are kept as *claims* and
  diffed against the trusted record. Any divergence is itself a veto failure
  (`INTEGRITY.SELF_REPORT_DIVERGENCE` in `../eval-harness/rubrics/gate_checks.md`).

In production the same principle holds via out-of-band signals (payment-processor charge ledger,
vendor confirmations, chargeback/complaint feeds) — see `../loop-orchestrator/experiment_design.md`.
Per-event annotations of which fields are trusted-authored live in `schemas/event_payloads_schema.json`.

## What this domain owns

- `schemas/event_envelope_schema.json` — the common envelope every event conforms to.
- `schemas/event_payloads_schema.json` — `$defs` for the safety-critical event payloads (the
  pattern to follow; the rest are specified in the catalog and materialized as built).
- `vocabularies.md` — the controlled string vocabularies (phases, capabilities, actors, fact
  types, escalation reasons, …). Single source of truth; the "reference table" in place of enums.
- `event_catalog.md` — every event: when emitted, payload fields, and which metrics/gates consume it.
- `metric_catalog.md` — every `metric_code`: operational definition, formula over events, unit /
  range / direction, pillar, capability, eval/telem availability, and its paired Goodhart guard.

## Privacy & PII discipline (non-negotiable)

Guest data here is sensitive — names, contacts, dietary/medical facts, RSVP status. Events carry
**identifiers, not raw PII**:

- Reference people by `guest_id` / `wedding_id`, never by name/email/phone in the payload.
- Sensitive attributes (allergy detail, contact info) live in the access-controlled guest
  record, referenced by id — not copied into the event stream.
- Any free-text field that could contain PII is stored `[REDACTED]` in the event; the grader
  reads ground truth from the persona/guest record, not from event text.
- Wedding *facts* asserted to guests (ceremony time, venue address, dress code) are **not** PII
  and are stored verbatim — they must be, so `COMMS.FALSE_FACT_TO_GUEST` can fact-check them.

## Determinism

Every event's `event_id`, `occurred_at`, `trace_id`, and the run `seed` are **injected**, never
read from an ambient clock or RNG. This is what makes an eval run reproducible and a metric
delta attributable to a product change rather than noise.

## Directory layout

```
telemetry/
  README.md            ← you are here
  schemas/
    event_envelope_schema.json
    event_payloads_schema.json
  vocabularies.md      ← controlled value lists (single source of truth)
  event_catalog.md     ← events → payloads → consumers
  metric_catalog.md    ← metric_code → formula → guard
```

## Related domains

- `../eval-harness/` consumes these metrics: `scenarios/*` reference `metric_code`s defined in
  `metric_catalog.md`; `rubrics/gate_checks.md` computes gates from these events;
  `schemas/grade_report_schema.json` (`metric_results`, `gate_results`, `per_capability_scorecard`)
  is populated by functions defined here.
- `../loop-orchestrator/` reads `grade_report`s and the production mirror of these metrics to make
  its accept/reject decision per `../eval-harness/scoring/scoring_model.md`.
- `../agent-operations/` consumes the **trusted** portion of this signal stream for its operational
  decisions (build/release, support, SRE, security) — never a component's self-report, same
  Integrity discipline as the gates.
