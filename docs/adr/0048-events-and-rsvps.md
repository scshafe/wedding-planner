# ADR 0048 — Events and per-event RSVPs

- **Status:** accepted
- **Date:** 2026-10-19
- **Decider:** the building agent (an agent-owned engineering decision per [[agents-own-buildout-decisions]]),
  for issue #29 (M2 "Planning core")
- **Scope:** a wedding's events (ceremony, reception, rehearsal dinner) and each guest's answer per event, with a
  meal choice where the event has meals. The household RSVP page (#30) builds on it.
- **Builds on** the guest list ([[guest-list]], ADR 0046) and grouped keys (ADR 0039 addendum).

## Decision

### Two contracts

- `wedding_event`: name, `starts_at` (local `YYYY-MM-DDTHH:MM`, with no time zone: the time printed on the
  invitation, where the event is), optional location, and `meal_options` (`{option_id, label}`, at most 8).
- `wedding_rsvp`: one guest's answer for one event: `invited`, `status` (`pending`, `attending`, `declined`),
  optional `meal_option_id`, `answered_by` (`planner`, `couple`, `household`) and `updated_at`. The `household`
  value is in the enum now, so #30 needs no schema change. That matters because the host rolls back failed deploys,
  and an older build must still read the records.
- Contract count: 25.

### No record means "invited, pending"

An RSVP is stored under `groupedKey(wedding_id, `${event_id}:${guest_id}`)`. A missing record is the default
(invited, pending), so adding a guest or an event writes nothing. The counts go over the wedding's guests, never over
the stored records, so a record left behind by a removed guest can never be counted. Records are still removed:
- with their guest: the guest list's new `guestsRemoved` hook calls `EventService.forgetGuests` in the same request
  and transaction (the composition root binds the hook);
- with their event.

### Meals

A meal choice must be one of the event's options, and only an attending guest has one. A guest who is not invited
has no answer: their status is pending, with no meal. Options keep their ids when the labels are edited (matched by
label, case-insensitively), so renaming or reordering keeps the guests' choices. A dropped option clears the
choices that named it.

### The boundary, shared

`assertWeddingReach` (`wedding/wedding_reach.ts`) is now the one implementation of "may this principal reach this
wedding": `authorizeRead` plus the wedding exists, otherwise the masked `PRODUCT.NOT_FOUND`. The guest list and the
events both call it, and the HTTP edge calls it before parsing any body. The planner and the wedding's couple manage
events and record answers; `answered_by` is the principal's role.

### Counts

For each event, over the invited guests: attending, declined, pending (= invited − attending − declined), meals by
option, and attending guests with no meal chosen yet. They are computed on read, from one grouped read of the
wedding's RSVPs: at most 12 events × 2,000 guests, and realistically a few hundred records. The wedding page shows
them; the events page shows them with the forms.

### Routes and pages

- JSON: `GET|POST …/weddings/:id/events`, `PUT|DELETE …/events/:eid`, `PUT …/events/:eid/rsvps/:gid` and
  `GET …/guests/:gid/rsvps` (that guest's answer for each event, with the defaults filled in).
- Web: the events page `?wedding=<id>&tab=events` (add, edit, remove; meals one per line), RSVP forms on each
  guest's edit page, and an Events card with the counts on the wedding page. Every form posts to
  `/t/<slug>/events/<action>` and checks the per-session CSRF token first.

## Consequences

- #30 can let a household answer for its guests: it writes the same records with `answered_by: household`.
- Not done: answering for a whole household at once from the console; per-event invitations set from the guest list
  in bulk; the run of show (M3).
