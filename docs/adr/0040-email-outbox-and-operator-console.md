# ADR 0040 — Email port, simulated outbox and the operator console

- **Status:** accepted
- **Date:** 2026-10-19
- **Decider:** the building agent (an agent-owned engineering decision per [[agents-own-buildout-decisions]]),
  for issue #9 (M1 "Real foundations")
- **Scope:** an email boundary that accounts (#10) and invitations (#11) send through, an offline adapter that
  records every message, an operator-only page to read them, and the operator browser sign-in that page needs.
- **Builds on** the guest-messaging port ([[guest-messaging-port-and-meter]], ADR 0018) for the port style,
  the operator tier ([[onboarding-billing-operator-tier]], ADR 0015), and durable storage
  ([[durable-storage-record-store]], ADR 0039).

## Context

Password reset and invitations need email. The product is offline-first: no real provider until the owner
crosses that line in M5. The operator (the owner) therefore needs to see what would have been sent, for
example to hand a reset link to a planner. The operator tier was JSON-only behind a Bearer credential, so
there was no way to use it from a browser.

## Decision

### `EmailPort`, provider-agnostic

`product/src/email/email_port.ts`:
- `send(OutboundEmail) → EmailReceipt` and `deliveryStatus(message_ref) → 'accepted' | 'delivered' | 'bounced'
  | 'unknown'`.
- An `OutboundEmail` is `to`, a one-line `subject`, a plain-text `text_body`, a platform `purpose` label
  (`operator_test`, `password_reset`, `account_setup`, `invitation`) and an optional `tenant_id`.
- No template ids, no provider message shapes, no HTML bodies.
- `assertValidOutboundEmail` is the shared shape check every adapter runs: an address shape, a CR/LF in the
  subject (header injection), and bounds on all three fields. It lives with the port, so a future real
  adapter cannot skip it.

The message contract, binding on callers and tested by them in #10 and #11: a message never carries a session
token, an operator credential or a password. A link that authenticates its holder carries its own single-use,
expiring token, minted for that purpose.

### The simulated adapter is the outbox

`SimulatedEmailAdapter` validates, then records each message: to, subject, body, purpose, tenant,
`created_at` and status `delivered`. Ids and time come from the injected generator and clock, and records go
to the durable store's `email_outbox` collection.

The outbox is a platform log, not tenant data. It lives in the global partition, with the tenant as a field,
and only the operator tier reads it through `EmailOutboxReader.recent(limit)`, newest first. No tenant route
exposes it.

### Operator API

- `GET /admin/outbox` returns the newest 100 messages.
- `POST /admin/outbox {to}` sends a fixed `operator_test` message, so the email path can be checked end to end
  in production before any feature sends mail.

Both sit behind the existing first-statement operator gate, so an unauthenticated caller or a tenant session
gets the same constant 401 as anywhere under `/admin`.

### Operator console sessions, not a credential in a cookie

A browser cannot send a Bearer token, and the long-lived operator credential should not sit in a cookie jar. So
the console exchanges the credential for a session:
- `POST /admin/sessions` (Bearer = the static credential) returns `{token, csrf_token, expires_at}`. The session
  lasts 12 hours and is persisted keyed by `sha256(token)`.
- `OperatorCredentialStore.resolve` accepts the static credential or a live session.
- A session cannot mint another session (403), so stealing one never extends it.
- `DELETE /admin/sessions` revokes the presented session on the server.
- An expired session fails like an unknown token and is deleted when next seen.

The session code lives in `OperatorCredentialStore`, so that store stays the sole mint of an `Operator`. The
`/admin/sessions` handler sits in the pipeline next to the tenant login, because the `/admin` handlers
deliberately do not hold the operator store.

### The console (`OperatorConsole`, `admin_pages.ts`)

The browser routes:
- `GET /admin` and `GET /admin/login`
- `POST /admin/login`, which sets `wp_operator` (HttpOnly, SameSite=Strict, `Path=/admin`, Max-Age 12h)
- `POST /admin/logout`, which is CSRF-checked and revokes the session on the server
- `GET /admin/outbox`
- `POST /admin/outbox/send`, which is CSRF-checked and redirects back (PRG)

Rules the console follows:
- Its only data path is `api.handle()`. The cookie is forwarded as the Bearer, and the pipeline's gate decides.
- `GET /admin/outbox` with an `Authorization` header is a script and gets the JSON API at the same path; without
  one it is a browser and gets the page.
- Any path the console does not own falls through to the JSON API and its constant 401.
- The pages use a neutral shell, never tenant-themed. Everything is escaped, bodies render in `<pre>`, and the
  page runs under the strict CSP (no script).
- Sign-in is the CSRF exemption, as tenant login is: there is no session yet, the cookie is SameSite=Strict, and
  forging a sign-in would need the credential anyway.

Like `wp_session`, the cookie is not marked `Secure`, because the local demo runs on plain HTTP. The deployed
node is HTTPS-only through tailscale serve.

## Consequences

- #10 and #11 send reset and invitation links through `EmailPort` and can be tested end to end through the
  outbox.
- The outbox shows full bodies, one-time links included. That is the point while email is simulated: the
  operator relays the link. When a real provider replaces the adapter, the outbox goes away with it, or must
  redact link tokens.
- The outbox is unbounded, and `recent` reads the whole collection. That is fine at studio scale. Add a
  retention bound or a dedicated table if it ever matters.
- Two collections join the census: `operator_session` and `email_outbox`.

## Alternatives considered

- **Put the operator credential itself in the cookie:** simpler, but it parks the master credential in browser
  storage, gives it no expiry, and leaves sign-out unable to revoke anything.
- **A JSON-only outbox read with curl:** meets the letter of the issue but not "a page", and the same browser
  sign-in will serve `/admin/feedback` (#12) and `/admin/errors` (#13).
- **Store the outbox per tenant partition:** the operator must read across tenants, and the port deliberately
  has no cross-partition read. A platform log belongs in the global partition.
