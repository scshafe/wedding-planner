---
name: real-planner-accounts
description: Issue #10 / ADR 0041 — tenant-scoped accounts with scrypt passwords, password sessions minted by the SessionStore, no existence oracle, in-process rate limits, single-use emailed links, role picker only on the demo tenant, pre-session double-submit CSRF
metadata:
  type: project
---

Since issue #10 (2026-10-19), `product/src/accounts/`:

- **Accounts** (`AccountStore`): tenant-scoped `user_account` + `user_email` index (normalized email), roles
  owner/planner/couple. `publicAccountView` drops the hash — never return a raw `UserAccount` from an API.
- **Passwords** (`PasswordHasher`): scrypt with params stored per hash, salt from the injected ids, NFKC, 10–128
  chars, dummy-hash verify for unknown accounts (constant work). Tests pass `passwordCost: { N: 16, r: 1, p: 1 }`
  to compose (the production cost is ~100 ms per hash).
- **Sessions**: `AccountService.signIn` verifies, `SessionStore.startAuthenticated` mints (`auth: 'password'`,
  `principal_id` = `user_id`) — the SessionStore is still the sole mint. `revokeAllFor` on password change.
- **No oracle**: every sign-in failure = `PRODUCT.INVALID_CREDENTIALS` (constant 401). A reset REQUEST only enqueues
  one identical `pending_reset` row (any well-formed email); lookup + link + email run AFTER the response
  (`runDeferredWork`, called by the socket adapters; tests call `api.runDeferredWork()` before reading the outbox).
  Never put existence-dependent work back into the request path — a test counts store writes.
- **Limiter**: sha256 keys, per-entry windows, hard cap 50k (oldest evicted); sign-in counts FAILURES per email (10/15m,
  checked before hashing), a process-wide verification budget (120/min); reset 3/email/hour; NO tenant-wide caps
  (anonymous lockout). In memory on purpose (store writes roll back on a throw; the limiter must not).
- **Outbox secrets**: senders pass `secret: {value, expires_at}`; the outbox redacts lapsed links.
- **Picker** is keyed on the recorded `demo_tenant` platform setting (the tenant the seed created), with a one-time
  adoption of a pre-#10 seeded demo tenant by its exact fingerprint.
- scrypt N=2^15 r=8 p=3; re-hash below current cost at sign-in; `surface.warmUp()` precomputes the dummy hash.
- **Links**: `OneTimeTokenStore` (sha256-keyed, tenant-scoped, purpose-bound, expiring, deleted on use; a new one
  revokes older). Built from `WP_PUBLIC_URL`, NEVER the Host header; else site-relative.
- **Role picker**: `simulatedLogin` policy = demo mode AND the recorded demo tenant, enforced at mint and at lookup.
- **Pre-session CSRF**: sign-in/forgot/reset forms use the `wp_pre` double-submit cookie (HttpOnly, SameSite=Strict,
  Path=/t/<slug>); the per-session CSRF token is for signed-in forms.
- **Bootstrap**: operator `POST /admin/tenants/:id/owner {email}` (console Tenants page) creates the owner + emails a
  setup link. Invitations (#11) add teammates and couples.

Related: [[durable-storage-record-store]], [[operator-console-and-email-outbox]], [[http-edge-and-intra-tenant-auth]].
