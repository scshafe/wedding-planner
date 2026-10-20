# ADR 0047 — Guest list CSV: export, and an all-or-nothing import

- **Status:** accepted
- **Date:** 2026-10-19
- **Decider:** the building agent (an agent-owned engineering decision per [[agents-own-buildout-decisions]]),
  for issue #28 (M2 "Planning core")
- **Scope:** download a wedding's guest list as CSV, and import a CSV into it. Couples arrive with spreadsheets.
- **Builds on** the guest list ([[guest-list]], ADR 0046).

## Decision

### One flat format, both ways

The columns are `household, address, first_name, last_name, side, tags, plus_one_allowed, plus_one_of, dietary,
email, phone`, with one row per guest and the household repeated on each row. A plus-one's `plus_one_of` is their
host's full name (`First Last`) in the same household. The export writes exactly this, so a downloaded file can be
edited in a spreadsheet and imported back. Import needs only `household` and `first_name`; columns may come in any
order and case; `side` and `plus_one_allowed` accept a few spellings (`partner_1`, `y`, `true`…).

### CSV injection: neutralize on export, undo on import

The file is opened in Excel or Sheets, so any cell starting with `=`, `+`, `-`, `@`, tab or CR is written with a
leading `'` (OWASP's advice). That includes phone numbers like `+1 555…`; a spreadsheet hides the apostrophe and
shows the text. Import strips that one `'` again, so an exported file round-trips. The download is
`text/csv; charset=utf-8` with a BOM and CRLF (what the spreadsheet programs expect), `attachment`, `no-store` and
`nosniff`. It is named by the wedding id, never by the couple's names.

### Import: plan everything, then apply all or nothing

`planGuestImport` is pure. It parses the CSV (RFC 4180), validates every row and plans what would change. Every
problem is reported with its line number, and nothing is written while there is one. The service applies a clean
plan inside the request's transaction, so a failure part-way also writes nothing.

- **Matching:** a row matches an existing guest by (household name, first name, last name), case-insensitively. A
  match updates the guest, so re-importing a file or an edited export never duplicates.
- **Plus-ones:** an import may create a plus-one. The host must be in the same household (in the file or already on
  the list), be allowed a plus-one, and end up with at most one. A row matching an existing guest must keep that
  guest's plus-one status and host; changing who is a plus-one is done on the list page, where the rules are
  visible. A row may not take away an allowance while the host's plus-one is listed.
- **Households:** a new household name creates one. An address on a row sets the household's address, and rows of
  one household must agree on it. A blank address leaves it as it was.
- **Bounds:** 500,000 characters and 2,000 rows per file, and the list's own limits apply to the result. Applying
  reads the list once and keeps working copies, so a 2,000-row import is one wedding's worth of work (about 0.1 s
  on SQLite), not a re-read per row.

### Routes and pages

- JSON: `POST …/weddings/:id/guest-list/import {csv, commit}` returns the plan summary and whether it was applied.
  The wedding boundary is checked before the body is parsed, as for every guest-list route.
- Web: `GET /t/<slug>/guest-list/export?wedding=<id>` downloads the file. The import page is
  `/t/<slug>?wedding=<id>&tab=guests&import=1`: paste the CSV and preview. A preview with problems lists them by row
  and keeps the text for fixing. A clean preview shows what will change, and an Import button that re-sends the
  same text. Both posts check the per-session CSRF token first.

## Consequences

- A planner can move a list in and out of spreadsheets without duplicates, and nothing half-imports.
- Not done: uploading a file (pasting the text needs no multipart parsing and no stored upload); removing guests
  who are missing from a file (an import only adds and updates); matching by a stable external id.
