---
name: seating-plan
description: Issue #46 / ADR 0054 — seating_table + seat_assignment keyed by guest (one seat per guest); capacity is hard (household all-or-none, no shrinking below seated, PRODUCT.SEATING_FULL 409); plan per event via statusesFor; guest-list hook fans out to events, RSVP links and seating
metadata:
  type: project
---

Since issue #46 (2026-10-19): `product/src/seating/seating_service.ts`.

- seat_assignment is keyed groupedKey(wedding, guest_id): at most one table per guest by construction.
- Capacity: refuse overflow, seat households all-or-none, refuse shrinking a table below its seated count →
  PRODUCT.SEATING_FULL (409).
- The plan is per event (query param, default "reception" by name else the last event) using
  `WeddingEventService.statusesFor` (no-boundary read). No events → every guest offered.
- compose: `fanOutGuestListHooks(events, rsvpLinks, seating)` — every per-guest store hooks in there.
- Planner AND couple manage seating (unlike vendors/budget/run of show).

Related: [[events-and-rsvps]], [[guest-list]], [[run-of-show]].
