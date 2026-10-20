# ADR 0051 — Vendors per wedding

- **Status:** accepted
- **Date:** 2026-10-19
- **Decider:** the building agent (an agent-owned engineering decision per [[agents-own-buildout-decisions]]),
  for issue #33 (M2 "Planning core")
- **Scope:** every wedding's vendors (venue, caterer, photographer, ...): who they are, where the contract
  stands, and what is owed when. The budget (#34) builds on it.

## Decision

### One contract, money in integer cents

- **`wedding_vendor`:** a category from a fixed list (with `other` naming its own), business name, optional contact
  person, email and phone, `contract_status` (`none`, `sent`, `signed`, `cancelled`), a payment schedule,
  `shared_with_couple`, and the planner's notes.
- **The payment schedule:** a list of installments, at most 24. Each has a label, `amount_cents`, a due date, whether
  it is the deposit (at most one per vendor), and paid or not (with `paid_at`).
- **Money is tracked, never moved:** amounts are integers from 0 to one billion cents, never floats, and there is no
  payment provider.
- **Typed amounts:** in the web form, an amount is read with `centsFromText`: digits with up to two decimals and
  optional thousands commas. Anything else is refused, never rounded.

### Stable installments

An edit sends the whole schedule. An installment that names its id keeps it, along with whether it was paid and
when. An installment without an id is new, and one left out is removed. An id that is not on this vendor is
refused. Marking an installment paid records `paid_at` once; marking it paid again keeps that time.

### Who sees what

The boundary is the wedding's (`assertWeddingReach`).
- The planner manages vendors: add, edit, remove, and mark installments paid.
- The couple sees only the vendors the planner shares, without the planner's notes. An unshared vendor is simply
  not in the couple's view.
- A couple's management call is an honest 403 on its own wedding, checked before the body is parsed. The view tells
  the page whether the principal manages, so a couple's page has no forms.

### What is due next

The view lists every unpaid installment of the visible vendors, soonest first, flagging the overdue ones against the
injected clock's date. Each vendor shows its total, what is paid and what is still due.

### Routes and pages

- JSON: `GET|POST …/weddings/:id/vendors`, `PUT|DELETE …/vendors/:vid` and `PUT …/vendors/:vid/installments/:iid
  {paid}`.
- Web: the vendors page `?wedding=<id>&tab=vendors` and a link from the wedding page. Installment rows in the form
  are indexed fields (`i<n>_…`), so an unticked checkbox can never shift the pairing. Every form posts to
  `/t/<slug>/vendors/<action>` and checks the per-session CSRF token first.
- At most 100 vendors per wedding.

### Plain text, one check

`text/plain_text.ts` (`assertPlainText`) is now the one check for typed text: no control characters (C0, DEL, C1),
line separators, or direction overrides; a multiline field may break lines. The guest list, the checklist and the
vendors all use it.

## Consequences

- The budget (#34) links a category to a vendor and reads its schedule through `VendorService.vendorsOf`.
- Not done: contracts as files (M3 documents); reminders for due payments; currencies other than one per workspace.
