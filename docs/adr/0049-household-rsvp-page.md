# ADR 0049 — The household RSVP page

- **Status:** accepted
- **Date:** 2026-10-19
- **Decider:** the building agent (an agent-owned engineering decision per [[agents-own-buildout-decisions]]),
  for issue #30 (M2 "Planning core")
- **Scope:** guests answer themselves, without an account, from a link the planner or the couple sends to each
  household. The first public page that writes data.
- **Builds on** events and RSVPs ([[events-and-rsvps]], ADR 0048), the guest list (ADR 0046), and the sign-in
  page's pre-session anti-forgery (ADR 0041).

## Decision

### A link per household, stored only as its hash

- The planner or the couple makes a household's link from the guest list. The token is `ids.next('rsvp')`, a random
  UUID in production. Only its SHA-256 hash is stored.
- The link is shown once, on the page that made it. If it is lost, they make a new one, and the old one stops
  working. The page says so.
- The record is kept twice, in one shape (`rsvp_link`): under the hash, to resolve a link, and under
  `groupedKey(wedding_id, household_id)`, as the household's current link, so a new link can turn the old one off.
  A link resolves only while both records agree, the household exists and the wedding exists.
- Removing a household removes its link: the guest list's hook grows `householdsRemoved`, and the composition
  root fans the hook out to the events and the links.
- The guest list shows when each household's link was made, never the link itself.

### A resolved link is a grant, not a principal

`RsvpLinkService.resolve` returns a `HouseholdRsvpGrant`: the tenant context, the wedding and the household. It is
minted only there (a module-private WeakSet, like `TenantContext`). It is the household page's whole authority:
- `WeddingEventService.householdView` and `answerAsHousehold`, and `GuestListService.setDietaryAsHousehold`,
  accept it and check it with `assertHouseholdGrant`.
- There is no Principal, so nothing on that page can reach a console route or another household.

### What the page shows and accepts

- **It shows:** the household's name, its own guests (with their dietary notes), and only the events at least one of
  them is invited to (name, time, place, meals; the event's invitation default and plus-ones following their host
  apply). Nothing else about the wedding, and no other guest.
- **It accepts:** attending or declined per guest per event, a meal choice where the event has meals (kept only when
  attending), and a dietary note per guest (which updates the guest's note; blank clears it).
- **The invitation is never the household's to change:** answers go through the one answer writer with the invitation
  taken from the record or the default and `answered_by: household`. An answer for a guest outside the household, or
  for an event the guest is not invited to, refuses the whole submission (400).
- **Closing:** the planner closes or reopens a wedding's RSVPs on the events page (a couple gets 403). The setting is
  its own record (`wedding_rsvp_settings`), never a field on the wedding, so an older build's edit cannot drop it
  after a rollback. While closed, the page shows the answers without letting anyone change them, and a submission is
  a 409.

### The public route

- **Routes:** the browser page is `/t/<slug>/rsvp/<token>`. It goes through the pipeline's public
  `/t/<slug>/household-rsvp/<token>` route, so each submission is one transaction and its errors are recorded like
  any other request's.
- **No existence oracle:** an unknown, replaced or other tenant's token, a junk token, and an unknown or suspended
  workspace are all the generic not-found page.
- **Anti-forgery:** the pre-session double-submit (`wp_pre`), as on the sign-in page.
- **`no-referrer`:** the URL is the secret, so it must not leak in a Referer header.
- **Request log:** the token segment logs as `:id`.
- **Limits:**
  - 20 submissions per link per ten minutes (429);
  - at most 240 answers and 40 dietary notes per submission, checked before any per-item work;
  - a dietary note is at most 300 characters, with no control characters;
  - a token is at most 128 characters before it is hashed;
  - the body cap is 1 MiB.

## Consequences

- A household can answer and come back to change its answers until RSVPs close, and the counts move at once.
- Making a new link is the only way to replace a lost one, which also turns off the one already sent. The page
  that makes a link says so.
- Not done: sending the link by email (the outbox could carry it later); naming a plus-one from the page; a reminder
  for households that have not answered.
