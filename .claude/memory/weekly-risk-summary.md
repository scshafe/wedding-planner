---
name: weekly-risk-summary
description: Issue #62 / ADR 0060 — per-wedding weekly risk summary: pure signals (tasks, payments, RSVPs within 45 days, unseated within 21, unsigned contracts within 90) → a risk_summary job per ISO week, enqueued by reading a stale summary; the model picks a level + signal keys, the product words lines from the signals; the planner only
metadata:
  type: project
---

Since issue #62 (2026-10-20): `product/src/risk/`.

- **Reading enqueues:** a GET of a stale summary (wedding page, home page, JSON) enqueues the week's job. It is
  idempotent; keep it that way.
- **Honest levels:** `checkRiskSummary` keeps only computed signals, in `RISK_URGENCY` order, and `on_track` only
  when there are none. Lines come from `renderRiskLine`, never model text.
- **The model sees keys and counts only**, never labels (names). Keep it that way: a test pins the exact input.
- **A failed write cools down for an hour** (`RISK_RETRY_COOLDOWN_MS`, read from the failed job's `updated_at`):
  reads answer `unavailable` instead of enqueueing. No signals: no model call. Cancelled/completed: `untracked`.
- **The windows** (45/21/90 days, 7/14-day lookaheads) live in `computeRiskSignals`. Change them there, with tests.
- **Planner affordances on pages:** show a planner-only card when the planner-only read answers 200. Do not use the
  team read (simulated demo planners fail it).

Related: [[model-jobs-and-copilot]], [[model-port]], [[seating-plan]].
