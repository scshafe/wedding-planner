---
name: guest-list-csv
description: Issue #28 / ADR 0047 — guest list CSV export (formula-neutralized, BOM, CRLF) and an import that plans every row and applies all-or-nothing, matching existing guests by household + name
metadata:
  type: project
---

Since issue #28 (2026-10-19): `product/src/guests/guest_csv.ts` (pure) + `GuestListService.importGuests`.

- One flat format both ways: `GUEST_CSV_COLUMNS`; a plus-one's `plus_one_of` is the host's full name in the same
  household. Export → edit → import must round-trip: keep `toGuestCsv` and `planGuestImport` symmetric (the test
  "an exported list imports back as updates only" pins it).
- Export neutralizes formula cells (`'` before `= + - @ \t \r`, at the cell start AND after every `;`, for Excel in
  `;` locales); import strips exactly those. Never drop this: the file is opened in spreadsheets.
- `planGuestImport` must stay O(rows): index the list and the file in Maps up front, never `find`/`some` over the
  list inside the row loop (a crafted preview stalled the process 10 s; the "stays fast" test pins it).
- A missing column keeps the list's value on update; a blank free-text cell clears; ambiguous household names or
  host names are problems, never guesses.
- Import: `planGuestImport` validates EVERY row first; a plan with any problem is never applied (the request
  transaction also rolls back a mid-apply failure). Match key = (household, first, last), case-insensitive.
- An import never changes who is a plus-one for an existing guest (a problem tells the user to use the list page).
- Applying uses the service's private writers with one list read (`#addGuest(..., guests)` etc.); do not call the
  public methods per row (each re-reads the wedding).

Related: [[guest-list]], [[durable-storage-record-store]].
