---
name: events-and-rsvps
description: Issue #29 / ADR 0048 — wedding_event + wedding_rsvp; no RSVP record = invited+pending; counts iterate guests not records; guest removal cascades via GuestListHooks; assertWeddingReach is the one wedding boundary
metadata:
  type: project
---

Since issue #29 (2026-10-19): `product/src/events/event_service.ts`.

- RSVP key `groupedKey(wedding_id, `${event_id}:${guest_id}`)`; NO record = invited + pending. Never pre-create
  records for new guests/events; counts iterate the wedding's GUESTS and look records up (stale records can't count).
- Guest removal → `GuestListHooks.guestsRemoved` → `EventService.forgetGuests` (bound in compose.ts with a closure,
  because EventService reads guests through GuestListService). A new per-guest store must hook in the same way.
- `answered_by` enum already includes `household` (for #30): adding enum values later is an expand step, since the
  host rolls back failed deploys and older builds re-validate records.
- Meal option ids are stable across label edits (matched by label, case-insensitive); a dropped option clears
  choices. A meal choice only with attending; not invited → pending, no meal.
- `assertWeddingReach` (wedding/wedding_reach.ts) is the ONE "may this principal reach this wedding" check (masked
  NOT_FOUND). Every per-wedding service and route uses it, and routes call it before parsing a body.

Related: [[guest-list]], [[guest-list-csv]], [[durable-storage-record-store]].
