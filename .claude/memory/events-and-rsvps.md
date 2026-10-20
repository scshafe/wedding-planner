---
name: events-and-rsvps
description: Issue #29 / ADR 0048 — wedding_event (+invitation everyone|selected) and wedding_rsvp; no RSVP record = event default (plus-one follows host) + pending; counts iterate guests; GuestDirectory read side; WeddingEventService is the guest list's hook; meal ids stable; raw input caps
metadata:
  type: project
---

Since issue #29 (2026-10-19): `product/src/wedding_events/wedding_event_service.ts`.

- RSVP key `groupedKey(wedding_id, rsvpId(event_id, guest_id))`. NO record = the event's `invitation` default (a
  plus-one without a record follows their host) + pending.
- `invited` counts only when someone SET it: `invitation_by` (planner|couple), or a pre-#41 record answered by the
  planner/couple (`invitationSetBy`). Household answers carry `invitation_by` over and never set one. Use
  `effectiveInvitation` everywhere; never read `rsvp.invited` directly. Never pre-create records; counts iterate the wedding's
  GUESTS and look records up (stale records can't count).
- Guests are read through `GuestDirectory` (guests/guest_directory.ts): a read side with no boundary check, for
  services that already checked reach (and #30's resolved link). Never route it.
- `WeddingEventService implements GuestListHooks`; compose passes it as the guest list's hook. A test through the
  composed API checks the cascade. A new per-guest store hooks in the same way (grow the interface).
- One writer (`#write`) for answers; console entry `recordAnswer`; #30 adds a household entry that takes the
  invitation from the stored record or the default, never from input.
- Meal options: an edit naming the `option_id` renames in place (the form sends id + label rows); a label alone
  matches; an unknown id → 400; a dropped option clears choices as the editor's change. A meal choice only with
  attending (dropped otherwise).
- Cap raw arrays before per-item work (meal list: 32): two reviews found event-loop DoS from unbounded dedupe loops.
- `assertWeddingReach` (wedding/wedding_reach.ts) is the ONE "may this principal reach this wedding" check (masked
  NOT_FOUND, returns the wedding). Routes call it before parsing a body.

Related: [[guest-list]], [[guest-list-csv]], [[durable-storage-record-store]].
