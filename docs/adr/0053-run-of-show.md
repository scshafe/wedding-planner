# ADR 0053 — The run of show

- **Status:** accepted
- **Date:** 2026-10-19
- **Decider:** the building agent (an agent-owned engineering decision per [[agents-own-buildout-decisions]]),
  for issue #45 (M3 "Event day and guest experience")
- **Scope:** the day-of timeline: what happens when, who owns it, and when each vendor must arrive.
- **Builds on** events ([[events-and-rsvps]], ADR 0048) and vendors ([[vendors-per-wedding]], ADR 0051).

## Decision

### One contract

- **`run_of_show_item`:** a local start date-time and an optional end (never before the start), a title, an optional
  location, an owner, an optional event of the wedding, and the planner's notes.
- **The owner** is `planner`, `couple` or `vendor`. A vendor owner names a vendor of the same wedding.
- **A vendor's item** may carry a `vendor_call_time`: when that vendor must arrive, at or before the item starts.
- At most 200 items per wedding.

### One timeline

The view is a list of lines in time order. Each item is a line at its start. A vendor's call time is a separate
"arrives" line at its own time, so the call times read in the same timeline. When an arrival and an item share a
minute, the arrival comes first. The page shows a time once per day, and the print view (`&print=1`) is the
timeline alone, with no forms.

### Who sees what

The boundary is the wedding's (`assertWeddingReach`).
- The planner manages the items. A couple's management call is an honest 403, checked before the body is parsed.
- The couple reads the whole run of show, since it is their day, but:
  - without the planner's notes;
  - without which vendor record owns an item;
  - a vendor it is not shared (#33) stays out of its view, as on the vendors page (ADR 0051). Its items show "A
    vendor" as the owner, its arrival lines and call times are left out, and its category is never shown. A vendor
    the planner shares appears by name, with its arrival. The add form says so.
  - The first version named an unshared vendor by its category and showed its arrival. The security review pointed
    out that this told the couple a vendor existed that the planner kept unshared.
- The lists of vendors and events an item may link to are in the planner's view only.

### Routes and pages

- JSON: `GET|POST …/weddings/:id/run-of-show` and `PUT|DELETE …/run-of-show/:iid`.
- Web: the page `?wedding=<id>&tab=run-of-show`, its print view, and a link from the wedding page. The page edits one
  item at a time (`&item=<id>`). A form per item repeated the vendor and event choices, so the page grew with items
  times vendors: the review measured 19 MB and about 0.3 s of rendering per load at the limits. Every form posts
  to `/t/<slug>/run-of-show/<action>` and checks the per-session CSRF token first.
- `WeddingEventService.eventsOf` is now public, like `VendorService.vendorsOf`: a read of one wedding with no boundary
  check, for services that have established reach.

## Consequences

- The run of show is the base for M4's planner copilot, which drafts a timeline from a wedding's details.
- Not done: sending the run of show to vendors (the outbox could carry it later); live updates on the day.
