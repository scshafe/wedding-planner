---
name: operator-console-and-email-outbox
description: Issue #9 / ADR 0040 — the provider-agnostic EmailPort, the simulated outbox (global partition, bounded), and the operator browser console with credential-bound, hashed, expiring console sessions
metadata:
  type: project
---

Since issue #9 (2026-10-19):

- **EmailPort** (`product/src/email/email_port.ts`): `send` + `deliveryStatus`, plain text only. Every adapter runs
  `assertValidOutboundEmail` (address shape, no control chars / line separators in address or subject, bounds).
  Message contract: never a session token, credential or password; a link that authenticates carries its own
  single-use token (#10/#11 tests pin it).
- **SimulatedEmailAdapter** is the outbox: every message recorded in `email_outbox` (GLOBAL partition, tenant is a
  field), newest-first reads, bounded at 1000 (oldest deleted on send). Only the operator reads it.
- **Operator console** (`web/operator_console.ts`): the credential is exchanged for a console session
  (`POST /admin/sessions`), cookie `wp_operator` (HttpOnly, SameSite=Strict, Path=/admin, 12h). Sessions are
  stored by sha256(token) and BOUND to the credential (sha256(token NUL credential)); rotating `WP_OPERATOR_TOKEN`
  ends them. `DELETE /admin/sessions` with the static credential = sign out everywhere. A session cannot mint a
  session. Console mutations check the session's own CSRF token. `GET /admin/<page>` with an Authorization header
  is the JSON API; without, the page.
- All HTML and JSON responses are `Cache-Control: no-store`; CSP has `frame-ancestors 'none'`.

Related: [[onboarding-billing-operator-tier]], [[durable-storage-record-store]].
