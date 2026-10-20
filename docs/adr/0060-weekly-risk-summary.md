# ADR 0060 — The weekly "what is at risk" summary

- **Status:** accepted
- **Date:** 2026-10-20
- **Decider:** the building agent (an agent-owned engineering decision per [[agents-own-buildout-decisions]]), for
  issue #62 (M4 "AI planning assistant"), within ADR 0057 (the model port) and ADR 0058 (the job queue).
- **Scope:** a planner with many weddings sees, once a week, what is slipping in each: on the wedding page, and across
  weddings on the home page. The planner's only.

## Decision

### Signals from what the app already holds (`risk_signals.ts`, pure)

Seven signals, each present only when it counts something, each with a count and at most three labels:

| Signal | What it counts | When |
| --- | --- | --- |
| `overdue_tasks` | Open checklist tasks due before today | Always |
| `tasks_due_soon` | Open checklist tasks due in the next 7 days | Always |
| `payments_overdue` | Unpaid vendor installments due before today (cancelled vendors aside) | Always |
| `payments_due_soon` | Unpaid vendor installments due in the next 14 days | Always |
| `rsvps_missing` | Households with an invited guest still pending | RSVPs open and 45 days or less to go (the app has no RSVP deadline, so "as the deadline nears" is the last 45 days before the wedding) |
| `guests_unseated` | Attending guests without a seat (the seating plan's own count) | 21 days or less to go |
| `contracts_unsigned` | Vendors whose contract is neither signed nor cancelled | 90 days or less to go |

A wedding whose day has passed has no signals. The labels are task titles, vendor names and household names: the
planner's own data, shown only to the planner.

### Written weekly, through the model, from the signals only

The summary belongs to an ISO week (`YYYY-Www`). When the planner reads a wedding (or the home page) and that week has
no summary, a `risk_summary` job is enqueued. Reading a stale summary asks for this week's; the request is
idempotent, with one live job per wedding.

The job:
1. computes the signals fresh;
2. asks the model `RISK_SUMMARY` (output contract `risk_summary_output`: a level and the signal keys to mention);
3. applies the second check (`checkRiskSummary`):
   - mention only signals the job computed (at most four);
   - the level is honest: `on_track` exactly when there is no signal, and a model's `on_track` beside a signal becomes
     `watch`;
4. words each line from its signal's own data (`renderRiskLine`).

So the summary states no fact the signals do not hold. The stored `risk_summary` (one per wedding, replaced each week)
holds the week, the level and the lines.

The simulated model:
- `at_risk` when something is late (an overdue task or payment) or close to the day (households not answered with
  three weeks or less to go, guests without a seat with two weeks or less);
- `watch` when any other signal is present;
- most urgent first.

### Where it shows

- **The wedding page:** a "This week" card for the planner, while the summary is being prepared or once written.
- **The home page:** "This week across your weddings" lists the upcoming weddings (at most 50, the soonest first) that
  are worth a look, at-risk first, with their first line, plus how many are on track and how many are still being
  summarized.
- **JSON:** `GET …/weddings/:id/risk-summary` and `GET /t/:slug/risk-summaries`, the planner only. The couple gets a 403
  before anything is enqueued, and its pages show no card.

## Consequences

- The planner's week starts with what is slipping, from data the app already holds, at no extra input.
- **Model use is bounded:** at most one model call per wedding per week, plus re-tries for a failed write (the next
  read asks again).
- **Not done:** sending it by email on a schedule (it needs a scheduler and the outbox; a follow-up), and custom
  windows per workspace.
