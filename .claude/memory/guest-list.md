---
name: guest-list
description: Issue #27 / ADR 0046 — households + wedding_guest contracts (separate from the messaging `guest`/guest_binding), the wedding boundary via WeddingAuthorizer with PRODUCT.NOT_FOUND masking, the plus-one model, personal data rules
metadata:
  type: project
---

Since issue #27 (2026-10-19): `product/src/guests/guest_list_service.ts`.

- Contracts `household` and `wedding_guest` (23 contracts now). NOT the messaging `guest` contract (whose collection
  is `guest_binding`). Collections `household` / `wedding_guest`, tenant-scoped, every record carries `wedding_id`.
- Boundary = the wedding's: `WeddingAuthorizer.authorizeRead` + the wedding exists; couple's other wedding, missing
  wedding, sibling-wedding ids → the same `PRODUCT.NOT_FOUND` (masked 404). Couples may create/edit/remove on their own.
- Plus-one = a guest with `plus_one_of` (same household, ≤1 per host, host needs `plus_one_allowed`, a plus-one never
  has its own). Cascades: guest → their plus-one; household → its guests.
- Bounds 1000 households / 2000 guests / 20 tags (tags bound in code: `maxItems` makes json-schema-to-typescript emit
  a tuple). New static route segments `guest-list`, `households` added to request_log's allow-list.

Related: [[durable-storage-record-store]], [[couple-scoped-guest-management]].
