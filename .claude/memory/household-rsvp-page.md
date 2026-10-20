---
name: household-rsvp-page
description: Issue #30 / ADR 0049 — public /t/<slug>/rsvp/<token>: per-household link stored as sha256 (two records, by hash and by household), shown once; a resolved link mints a WeakSet-branded HouseholdRsvpGrant (no Principal); answers via the one writer with answered_by household; RSVPs closed in its own collection
metadata:
  type: project
---

Since issue #30 (2026-10-19): `product/src/rsvp/rsvp_link_service.ts`, household methods on
`WeddingEventService` and `GuestListService.setDietaryAsHousehold`.

- The token is never stored: `rsvp_link` records live under the hash (resolve) and under
  `groupedKey(wedding, household)` (current link); a link resolves only if both agree and the household and wedding
  exist. New link = old one off. Household removal → `householdsRemoved` hook → links gone.
- `HouseholdRsvpGrant` is minted ONLY in rsvp_link_service.ts (module WeakSet). Anything that accepts a grant must
  call `assertHouseholdGrant`. Never mint a fake Principal for the household page.
- The household can't change invitations; an answer outside its household or for an event it isn't invited to
  refuses the whole submission. Closed RSVPs (own collection `wedding_rsvp_settings`) → 409.
- The public page goes through the API's `/t/<slug>/household-rsvp/<token>` route (transaction per submission);
  unknown/replaced/foreign token = generic not-found; `wp_pre` anti-forgery; `no-referrer`; 20 posts/link/10 min.
- The web POST resolves the token BEFORE touching the form (double-submit CSRF is no gate), indexes the form once,
  caps fields; only changed rows are sent (hidden originals) and unchanged answers write nothing.
- A household-written plus-one record follows the host's later invitation changes (recordAnswer cascades).
- `GuestListHooks` methods are optional; compose fans out with `fanOutGuestListHooks(events, rsvpLinks)`.

Related: [[events-and-rsvps]], [[guest-list]], [[real-planner-accounts]].
