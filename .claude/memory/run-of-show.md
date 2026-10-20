---
name: run-of-show
description: Issue #45 / ADR 0053 — run_of_show_item (owner planner|couple|vendor, vendor_call_time only for a vendor owner); the view interleaves "arrives" lines; couple sees no notes/owner_vendor_id and unshared vendors by category
metadata:
  type: project
---

Since issue #45 (2026-10-19): `product/src/run_of_show/run_of_show_service.ts`.

- The view is LINES (item at starts_at, plus an "arrival" line at vendor_call_time), sorted by time with arrivals
  first on ties. A call time is refused unless the owner is a vendor of the same wedding.
- Couple view strips notes and owner_vendor_id; the owner label uses the vendor's name only when it is shared, else
  "The <category> vendor". Compute labels from the STORED item (a bug once stripped the id first).
- `WeddingEventService.eventsOf` and `VendorService.vendorsOf` are the no-boundary reads for other services.

Related: [[vendors-per-wedding]], [[events-and-rsvps]].
