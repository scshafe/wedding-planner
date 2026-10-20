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
  invitation, where the event is), optional location, `invitation` (`everyone`, or `selected` for an invite-only
  event such as a rehearsal dinner), and `meal_options` (`{option_id, label}`, at most 8).
- `wedding_rsvp`: one guest's answer for one event: `invited`, `status` (`pending`, `attending`, `declined`),
  optional `meal_option_id`, `answered_by` (`planner`, `couple`, `household`) and `updated_at`. Since issue #41 it
  also has `invitation_by` (`planner`, `couple`): who set the invitation themselves, kept apart from who answered.
  `invited` counts only when someone set it; otherwise the invitation is inherited (see ADR 0049).
- Contract count: 25.

### Rollback safety

The host rolls back a failed deploy, so an older build must keep working on newer records:
- `answered_by` already includes `household` for #30. `invitation` is required from the start, which costs
  nothing while the collection is new; adding it later would have needed an expand step.
- New state that #30 needs (per-household RSVP links; whether RSVPs are closed for a wedding) goes into NEW
  collections. Older builds never touch those, whereas an older build's edit of an existing record rebuilds it field
  by field and would silently drop a field it does not know (for example, the wedding update would reopen RSVPs).

### No record means "the event's default, pending"

An RSVP is stored under `groupedKey(wedding_id, rsvpId(event_id, guest_id))`. A missing record means the event's
`invitation` (a plus-one without a record follows their host's), with the status pending. So adding a guest or an
event writes nothing. The counts go over the wedding's guests, never over the stored records, so a record left
behind can never be counted. Records are still removed:
- with their guest: `WeddingEventService` implements the guest list's `GuestListHooks`, and the guest list calls
  `guestsRemoved` in the same request and transaction; the composition root passes the service as the hook, and a
  test through the composed API checks that it does;
- with their event.

### Guests are read through a directory

`GuestDirectory` (guests module) is the read side of a wedding's guest list: one wedding, or one guest or household
by a point read. It checks no boundary: its callers have already established who may reach the wedding. The
wedding events read guests through it, never through the guest list's principal-bound view. That gives a point
read instead of a whole-list read per answer, removes the guest list ↔ events cycle, and gives #30 a path that needs
no principal.

### Meals

A meal choice must be one of the event's options, and only an attending guest has one: a choice sent with another
answer is dropped. A guest who is not invited has no answer (pending, no meal).
- An edit renames an option in place when it carries the option's id (the web form sends every option as a row with
  its id), and an entry with no id matches an existing option by label. So guests' choices survive renaming and
  reordering. An unknown id is refused.
- A dropped option clears the choices that named it. The answer keeps who gave it and who set the invitation.
- The raw list an edit sends is capped at 32 entries before any per-item work. The security review showed that
  deduplicating an unbounded list held the process for minutes.

### The boundary, shared

`assertWeddingReach` (`wedding/wedding_reach.ts`) is the one implementation of "may this principal reach this
wedding": `authorizeRead` plus the wedding exists, otherwise the masked `PRODUCT.NOT_FOUND`. It returns the wedding.
The guest list and the events both call it, and the HTTP edge calls it before parsing any body. The planner and
the wedding's couple manage events and record answers; `answered_by` is the principal's role. The budget (#34)
will need a read/update distinction; it adds an access kind here rather than a second check.

### Counts

For each event, over the invited guests: attending, declined, pending (= invited − attending − declined), meals by
option, and attending guests with no meal chosen yet. They are computed on read, from one grouped read of the
wedding's RSVPs: at most 12 events × 2,000 guests, and realistically a few hundred records. Each event in the view
carries its own counts. The wedding page shows them; the events page shows them with the forms.

### Routes and pages

- JSON: `GET|POST …/weddings/:id/events`, `PUT|DELETE …/events/:eid`, `PUT …/events/:eid/rsvps/:gid` and
  `GET …/guests/:gid/rsvps` (that guest's answer for each event, defaults filled in).
- Web: the events page `?wedding=<id>&tab=events` (add, edit, remove; invitation; meal rows), RSVP forms on each
  guest's edit page, and an Events card with the counts on the wedding page. Every form posts to
  `/t/<slug>/events/<action>` and checks the per-session CSRF token first.

## Consequences

- #30 lets a household answer for its guests through a household entry point beside `recordAnswer`. It takes the
  invitation from the stored record or the default, never from input, refuses events the guest is not invited to,
  respects a wedding's closed RSVPs, and writes with `answered_by: household` through the same writer.
- The wedding's own logistics fields (`ceremony_time`, `venue_name`, ...) stay canonical for the guest Q&A until
  M3/M4 builds a guest-facing schedule from the events.
- Not done: answering for a whole household at once from the console; bulk invitations for an invite-only event; the
  run of show (M3).
