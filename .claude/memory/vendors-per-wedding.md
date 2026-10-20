---
name: vendors-per-wedding
description: Issue #33 / ADR 0051 — wedding_vendor with installments in integer cents (never floats, no provider); stable installment ids keep paid state; couple sees only shared vendors without notes; can_manage drives forms; assertPlainText is the one typed-text check
metadata:
  type: project
---

Since issue #33 (2026-10-19): `product/src/vendors/vendor_service.ts`.

- Money: `amount_cents` safe integers 0..1e11; web input via `centsFromText` (refuses, never rounds). Money is
  tracked, never moved — no payment provider, ever (a real one is a human-reserved crossing).
- An edit resends the WHOLE schedule; an installment keeps its id/paid state only if the edit names its id (the form's
  hidden `i<n>_id`). A test caught this: resending without ids makes new installments.
- Couple: `view` filters to `shared_with_couple` and strips `notes`; `can_manage` (planner) decides whether the page
  renders forms. Management routes check the planner BEFORE parsing a body.
- `text/plain_text.ts assertPlainText` is the one typed-text check (C0/DEL/C1, U+2028/9, bidi); multiline for notes.
- #34 budget reads `vendorsOf` (no boundary check: callers establish reach first).

Related: [[wedding-checklist]], [[events-and-rsvps]], [[durable-storage-record-store]].
