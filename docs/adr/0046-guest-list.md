# ADR 0046 — The guest list: households and guests per wedding

- **Status:** accepted
- **Date:** 2026-10-19
- **Decider:** the building agent (an agent-owned engineering decision per [[agents-own-buildout-decisions]]),
  for issue #27 (M2 "Planning core")
- **Scope:** a real guest list per wedding (households, guests, plus-ones, contact details), managed by the planner
  and the wedding's couple. It is the base for RSVPs (#29, #30), and later seating and the wedding website.
- **Builds on** durable storage ([[durable-storage-record-store]], ADR 0039) and the intra-tenant boundary
  ([[http-edge-and-intra-tenant-auth]], ADR 0013).

## Context

In the product a "guest" was only an opaque messaging handle bound to a wedding (the `guest` contract, stored as
`guest_binding`). Planners need people: names, the party they come with, whose side, dietary needs, how to reach
them.

## Decision

### Two new contracts, separate from the messaging binding

- `household`: a party invited together. Fields: id, tenant, wedding, name, optional mailing address.
- `wedding_guest`: a person in one household of the wedding. Fields: first and last name, side (`partner_one`,
  `partner_two`, `both`), tags, `plus_one_allowed`, optional `plus_one_of`, dietary needs, email, phone.
- The messaging `guest` contract and its `guest_binding` collection are unchanged. Linking a guest's phone to a
  messaging binding is a later step.
- Both collections are tenant-scoped, with every record carrying its `wedding_id`. Contract count: 23.

### The wedding's boundary, reused

`GuestListService` checks `WeddingAuthorizer.authorizeRead` and that the wedding exists, before any read or write:
- A planner reaches every wedding of the tenant.
- A couple reaches only its own wedding.
- A couple's other wedding, a wedding that does not exist, and an id belonging to a sibling wedding all get the same
  masked 404 (`PRODUCT.NOT_FOUND`, new and mapped with the other masked codes).
- The couple may create, edit and remove on its own wedding. The issue asks for that, and it matches how couples
  arrive with their own lists.

### The plus-one model

A plus-one is a guest record whose `plus_one_of` names the guest who brings them:
- same household, one per guest at most;
- only for a guest with `plus_one_allowed`;
- a plus-one never has their own allowance.

So a plus-one counts and later gets an RSVP like anyone else. Removing a guest removes their plus-one; removing a
household removes its guests. Taking an allowance away while the plus-one exists is refused (409).

### Personal data

- Address, email and phone live only in these records.
- They are shown only on the wedding's guest list, to its planner and couple.
- They never reach a log line or an error entry: route patterns mask ids, and errors never record messages
  (ADR 0044).
- Every record is validated against its contract before it is written.
- A wedding's list is bounded (1,000 households, 2,000 guests, 20 tags per guest), so no one can grow it without
  limit.

### Routes and pages

- JSON, under the wedding: `GET …/guest-list` returns the list and its counts. `POST …/households`, `PUT|DELETE
  …/households/:id`, `POST …/guests` and `PUT|DELETE …/guests/:id` change it.
- The page is `/t/<slug>?wedding=<id>&tab=guests`, linked from the wedding page. Its forms are collapsible (no
  script) and post to `/t/<slug>/guest-list/<action>`; each checks the per-session CSRF token first.
- A guest's edit page is `…&guest=<id>`.

## Consequences

- RSVPs can key on households (the RSVP link goes to a household) and guests (one answer per guest per event).
- The tag bound lives in the service rather than the schema (`maxItems` makes the type generator emit a tuple).
- Not done: CSV import and export (#28); merging duplicates; a guest in two weddings of the same workspace (they
  are two records, by design).
