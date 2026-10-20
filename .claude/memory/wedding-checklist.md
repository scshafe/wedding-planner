---
name: wedding-checklist
description: Issue #31 / ADR 0050 — wedding_task contract; built-in CHECKLIST_TEMPLATE applied idempotently by template_key (keys persisted, never rename); today = injected clock UTC date (due today = upcoming); planner manages, couple ticks its own (403 otherwise); date move offers a shift of open tasks
metadata:
  type: project
---

Since issue #31 (2026-10-19): `product/src/checklist/{checklist_service,checklist_template}.ts`.

- Template items carry a persisted `key` (stored as `template_key`): applying adds only missing keys. Never rename
  a key; add a new item.
- `dateBefore` clamps months to a shorter month's end; all date math is UTC on YYYY-MM-DD strings.
- "Today" = `clock.now().slice(0,10)`. Overdue = todo && due < today; due today is upcoming. #32 must use the same
  rule (and `tasksOf` per wedding, never a tenant-wide list).
- The planner does everything; the couple only `setStatus` on assignee=couple tasks. Other couple calls are
  PRODUCT.FORBIDDEN (honest 403 on its own wedding), shown as a notice on the page.
- #32 `dueAcrossWeddings` (GET /t/<slug>/due-tasks, ?view=due, home card): planning+active weddings only, overdue
  = due < today, due soon = today..today+7 inclusive; planner only (couple 403 for any method).
- A date move is SERVER state (`checklist_date_move`, noted by the API's wedding update): the offer and the shift use
  it, never a URL parameter (a crafted `moved=` link once let a couple trigger a 10-year shift). Shift = by the
  recorded move, then forget it; keep = forget it.
- Wedding dates are real calendar dates (`wedding/calendar_date.ts` isDate/assertDate in the wedding repository);
  never trust the YYYY-MM-DD pattern alone.

Related: [[events-and-rsvps]], [[guest-list]].
