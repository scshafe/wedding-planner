# ADR 0054 — The seating plan

- **Status:** accepted
- **Date:** 2026-10-19
- **Decider:** the building agent (an agent-owned engineering decision per [[agents-own-buildout-decisions]]),
  for issue #46 (M3 "Event day and guest experience")
- **Scope:** tables, who sits where, and a printable table list. Builds on the guest list (ADR 0046) and the
  events' answers (ADR 0048).

## Decision

### Two contracts

- **`seating_table`:** a name and a capacity (1 to 50). At most 100 tables per wedding.
- **`seat_assignment`:** where one guest sits, keyed by the guest (`groupedKey(wedding_id, guest_id)`), so a guest is
  at most at one table by construction.

### Capacity is a hard rule

- A table never seats more than its capacity.
- Seating a household seats all of its guests or none.
- A table cannot shrink below the guests it seats.
- Every refusal is `PRODUCT.SEATING_FULL` (a 409).
- Moving a guest frees their old seat.

### A plan for one event

Seating is for one event, read through the events' answers (`WeddingEventService.statusesFor`, a no-boundary read
like `eventsOf`). The view lists:
- the tables with their guests, alphabetically, with dietary notes;
- the attending guests not yet seated, and their households, to seat together;
- the seated guests no longer attending.

Without a choice the event is the reception (by name), else the last event of the wedding. A wedding with no events
offers every guest. The choice is a query parameter, not stored.

### Who manages it

The boundary is the wedding's (`assertWeddingReach`). The planner and the couple both manage seating: couples
usually do it.

### Removals

- A removed guest or household is unseated through the guest list's hook, which now fans out to the events, the
  RSVP links and the seating, in the same transaction.
- A removed table unseats its guests.

### Routes and pages

- JSON: `GET …/weddings/:id/seating[?event=<id>]`, `POST …/seating/tables`, `PUT|DELETE …/seating/tables/:tid`,
  `PUT …/seating/seats/:gid {table_id | null}` and `PUT …/seating/households/:hid {table_id}`.
- Web: the seating page `?wedding=<id>&tab=seating[&event=<id>]`, the printable table list (`&print=1`), and a link
  from the wedding page. Every form posts to `/t/<slug>/seating/<action>` and checks the per-session CSRF token
  first.

## Consequences

- Not done: drag-and-drop floor plans (a floor plan can be a document, #48), and seat numbers within a table.
