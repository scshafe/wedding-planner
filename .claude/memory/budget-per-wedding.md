---
name: budget-per-wedding
description: Issue #34 / ADR 0052 — budget_category lines in integer cents; a line linked to a vendor takes actual/paid/due and next payments from the vendor schedule (computed, never copied); couple sees shared lines and totals only, never an unshared vendor's name/id
metadata:
  type: project
---

Since issue #34 (2026-10-19): `product/src/budget/budget_service.ts`.

- A linked line's amounts are COMPUTED from `VendorService.vendorsOf` on every read (never copied); manual amounts
  stay on the record so a removed vendor falls back (`vendor_missing`).
- Couple view: shared lines only; totals over those lines only; each line rebuilt from an ALLOW-LIST
  (`asTheCoupleSeesIt`: resolved amounts, no vendor id, no fallback amounts, vendor_missing false); `vendor_name` and
  installment labels only when the vendor itself is shared (else "Deposit"/"Payment"); no vendor list.
- One line per vendor (refused otherwise): a vendor followed twice would double every total.
- Planner check before body parse on management routes (honest 403 on own wedding).

Related: [[vendors-per-wedding]], [[wedding-checklist]].
