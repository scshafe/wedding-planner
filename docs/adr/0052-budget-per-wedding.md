# ADR 0052 — A budget per wedding

- **Status:** accepted
- **Date:** 2026-10-19
- **Decider:** the building agent (an agent-owned engineering decision per [[agents-own-buildout-decisions]]),
  for issue #34 (M2 "Planning core")
- **Scope:** "where are we against the budget?", answered from the product instead of a spreadsheet. Builds on the
  vendors and their payment schedules ([[vendors-per-wedding]], ADR 0051).

## Decision

### One contract: a budget line

- **`budget_category`:** a name and an estimate; manual actual and paid amounts; an optional `vendor_id` (a vendor of
  the same wedding); and `shared_with_couple`. Every amount is integer cents, from 0 to one billion.
- **Money is tracked, never moved.**

### A line can follow a vendor

- **Linked line:** its actual amount is the vendor's schedule total, its paid amount is the paid installments, and
  what is still due is the difference. Its next payments are the vendor's unpaid installments. Nothing is copied, so
  editing the vendor's schedule moves the budget at once.
- **Manual line:** it uses its own actual and paid amounts. Still due is actual minus paid, never below zero.
- **One line per vendor:** a vendor already followed by another line of the wedding is refused, so its schedule never
  counts twice in the totals.
- **Vendor removed:** the line falls back to its manual amounts and says its vendor was removed (to the planner). The manual amounts
  are kept while a line is linked for exactly this case.
- **Totals:** estimated, actual, paid and still due over the lines in view, plus the ten soonest unpaid installments
  (overdue ones flagged against the injected clock's date). The page also says when actual is over the estimate.

### Who sees what

The boundary is the wedding's (`assertWeddingReach`).
- The planner manages the budget: add, edit, remove, link a vendor. A couple's management call is an honest 403,
  checked before the body is parsed.
- The couple sees only the lines the planner shares, and totals over those lines only.
- A shared line that follows a vendor the couple may not see shows its amounts and next payments under the line's own
  name, with neutral installment labels ("Deposit" or "Payment": the vendor's own labels are the planner's free text
  and may name it). The couple's line is built from an allow-list, so nothing in it tells the couple that the line
  follows an unshared vendor: no vendor id, no fallback amounts, no "vendor removed". Once the planner shares the
  vendor as well, the couple sees which vendor the line follows and its labels.
- The list of vendors a line may link to is in the planner's view only.

### Routes and pages

- JSON: `GET|POST …/weddings/:id/budget` and `PUT|DELETE …/budget/:cid`.
- Web: the budget page `?wedding=<id>&tab=budget` and a link from the wedding page. Amounts are typed in dollars and
  read with `centsFromText`; an amount that is not one is refused, never rounded. Every form posts to
  `/t/<slug>/budget/<action>` and checks the per-session CSRF token first.
- At most 60 lines per wedding.

## Consequences

- M2's planning core is complete: guest list, CSV, events and RSVPs, the household RSVP page, the checklist and the
  cross-wedding view, vendors, and the budget.
- Not done: budget templates; currencies other than one per workspace; splitting a vendor across lines.
