# ADR 0050 — A checklist per wedding

- **Status:** accepted
- **Date:** 2026-10-19
- **Decider:** the building agent (an agent-owned engineering decision per [[agents-own-buildout-decisions]]),
  for issue #31 (M2 "Planning core")
- **Scope:** planners run every wedding from a checklist that is roughly the same each time, scheduled backwards
  from the date. The cross-wedding "overdue and due this week" view (#32) builds on it.

## Decision

### One contract, one built-in template

- `wedding_task`: title, optional notes, `due_date` (a local date), `assignee` (`planner` or `couple`), `status`
  (`todo` or `done`), `completed_at` while done, and `template_key` when the task came from the template.
- **The template** (`checklist_template.ts`) is a code constant of 18 items at 12, 9, 6, 3 and 1 months and 2 and 1
  weeks before the date. Applying it creates the items that are not on the checklist yet (matched by
  `template_key`), so applying twice adds nothing twice, and a removed item can be added back.
- **Template keys are persisted:** never rename one; add a new item instead. Custom templates per workspace are
  later work.
- **Dates:** months keep the day of the month, clamped to a shorter month (31 March minus one month is 28 or 29
  February). The arithmetic is pure UTC date arithmetic, so no time zone moves a date.

### Who does what

The boundary is the wedding's (`assertWeddingReach`): its planner and its couple see its tasks; anything else is the
masked 404.
- The planner adds, edits, removes, applies the template and shifts tasks.
- The couple marks done, or not done, the tasks assigned to the couple.
- Anything else a couple asks is `PRODUCT.FORBIDDEN`: an honest 403 on its own wedding, not an existence signal. The
  page shows it as a notice.

### Today, overdue, upcoming

"Today" is the injected clock's UTC date. The page lists overdue tasks first (not done, due before today, oldest
first), then upcoming (not done, due today or later, soonest first), then done. A task due today is upcoming, not
overdue. The JSON view returns the same three lists and `today`.

### When the date moves

The web edit of a wedding compares the date before and after. If it moved, the wedding page offers to move the open
tasks by the same number of days (`moved=<days>` in the redirect). Accepting posts a shift: the planner moves every
task that is not done by a whole number of days, within ten years either way. Done tasks keep their dates.

### Routes and pages

- JSON: `GET|POST …/weddings/:id/tasks`, `PUT|DELETE …/tasks/:tid`, `PUT …/tasks/:tid/status`,
  `POST …/tasks/apply-template` and `POST …/tasks/shift {days}`. The wedding boundary is checked before any body is
  parsed.
- Web: the checklist page `?wedding=<id>&tab=checklist`, a summary line on the wedding page (open and overdue
  counts), and the shift offer there. Every form posts to `/t/<slug>/checklist/<action>` and checks the per-session
  CSRF token first.
- At most 300 tasks per wedding.

## Consequences

- #32's planner-only view across weddings reads each active wedding's tasks through `ChecklistService.tasksOf`,
  one wedding at a time, never a tenant-wide list.
- Not done: custom templates; email reminders (the outbox could carry them later); recurring tasks.
