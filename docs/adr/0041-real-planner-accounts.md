# ADR 0041 — Real planner accounts: email and password sign-in

- **Status:** accepted
- **Date:** 2026-10-19
- **Decider:** the building agent (an agent-owned engineering decision per [[agents-own-buildout-decisions]]),
  for issue #10 (M1 "Real foundations")
- **Scope:** per-tenant accounts with email and password, sign-in and sign-out, persisted expiring sessions,
  password reset through the email outbox, rate limits, the role picker restricted to the demo, and the
  operator's bootstrap of a workspace's first account.
- **Builds on** the HTTP edge and intra-tenant auth ([[http-edge-and-intra-tenant-auth]], ADR 0013), CSRF
  ([[planner-guest-management-and-csrf]], ADR 0021), durable storage ([[durable-storage-record-store]],
  ADR 0039), and the email outbox and operator console ([[operator-console-and-email-outbox]], ADR 0040).

## Context

Sign-in was a role picker with no password: anyone who reached a tenant's page could act as its planner. Now
that data persists, a real workspace needs real accounts. Invitations (#11) build on this, adding teammates and
couples.

## Decision

### Accounts are tenant-scoped records

- `AccountStore` (`product/src/accounts/`) keeps `UserAccount` records with the fields `user_id`, normalized
  `email`, `role` (`owner` | `planner` | `couple`), the couple's `wedding_id`, an optional scrypt
  `password` hash, and timestamps. A second collection indexes the normalized email per tenant.
- Both collections sit behind `TenantScopedRepository`, so isolation is inherited. A person in two studios has
  two accounts.
- Callers outside the domain see `publicAccountView`, which drops the hash.

### Passwords: scrypt, constant work, nothing in plaintext

- `PasswordHasher` uses `node:crypto` scrypt (N=2^15, r=8, p=3, one of OWASP's settings; about 300 ms on the
  deploy host) with a salt from the injected id generator, which in production is a random UUID.
- The parameters are stored with each hash, so the cost can rise later without breaking old hashes. A hash below
  the current cost is re-hashed at the next successful sign-in.
- Unicode is normalized (NFKC). Passwords must be 10 to 128 characters; the upper bound keeps one request from
  being a CPU lever.
- `verify` checks an unknown account against a dummy hash at the same cost, so a missing account and a wrong
  password take the same time. The entrypoint computes the dummy hash before serving (`warmUp`), so even the
  first request is uniform.
- A password never appears in a record other than as the hash, nor in an error context, a response or an email.

### The SessionStore stays the sole mint

- `AccountService.signIn` verifies, then calls `SessionStore.startAuthenticated`. That mints a `password`
  session whose principal is the account (`principal_id` = `user_id`), with the role mapped as owner/planner →
  `planner` and couple → `couple`.
- Sessions keep the ADR 0039 lifecycle: a hashed key, a 7-day expiry and server-side revocation.
- `revokeAllFor(user)` ends every session of an account, which happens when its password changes and, in #11,
  when a member is removed.

### No account-existence oracle

- Sign-in failures are all the same `PRODUCT.INVALID_CREDENTIALS`, which is the constant 401: unknown email,
  wrong password, an account with no password yet, an over-long password, a malformed email.
- **A reset request does the same work for every well-formed email:** one row in a pending-reset queue (global
  partition), and the same 202. The account lookup, the link and the email run after the response has been
  written: the socket adapter calls `runDeferredWork()` on the next tick, with each step in its own transaction.
  A known and an unknown email therefore cost the same while the request is answered. Without this, the durable
  token and outbox writes for a known account were a measurable gap on disk (~22 ms vs 0.2 ms, found in review).
  A test pins it by counting store writes.
  - Residual risk: an attacker who floods concurrent requests could still notice the after-response work slowing
    the event loop. That needs racing on the tailnet, within 3 requests per email per hour.
- Rate limits are keyed on the submitted email, never on whether an account exists. So the 429 says nothing
  either.

### Rate limits (in-process)

`RateLimiter` uses fixed windows on the injected clock. Memory is bounded by construction:
- keys are sha256 digests, so a submitted email of any size costs 64 characters;
- each entry keeps its own window;
- the table is hard-capped at 50,000 entries, evicting the oldest first.

The rules:
- **Sign-in failures:** 10 per tenant and email per 15 minutes. The limit is checked before hashing, counted only
  on a failure, and cleared on success. A malformed email is refused outright and never creates a key.
- **Password verifications:** at most 120 per minute, process-wide. scrypt is the expensive part, so a flood
  degrades sign-in rather than the whole server.
- **Reset requests:** 3 per tenant and email per hour.

There is deliberately no tenant-wide hard cap. Without a trusted client identity (the app sees only tailscale
serve's loopback connection), any shared bucket lets one anonymous caller lock a whole workspace out. The
remaining lockout is per email: someone who knows an email can hold that one account back, 10 requests per
15 minutes.

Counters are memory only, so a restart clears them; the issue allows that for now. Because each request is one
transaction (ADR 0039), anything the limiter needs to remember must live outside the store, and it does.

### Single-use, expiring links

`OneTimeTokenStore` mints a token per purpose (`password_reset` 1 hour, `account_setup` 3 days):
- Each is stored by sha256, tenant-scoped, and deleted when consumed, so a link works exactly once.
- While email is simulated, the outbox keeps the emailed body, link included. Each message declares its link as
  a `secret` with an expiry; the outbox never shows a lapsed secret and rewrites stored bodies on the next send.
  So the database and its backups hold a usable link only for that link's lifetime, as any mailbox would.
- Issuing a new link revokes earlier ones of the same purpose.
- Setting a password revokes every outstanding link of the account.
- The new password's length is checked before the link is consumed, so a typo never burns it.

### Links come from a configured base, never the Host header

- Emails link to `${WP_PUBLIC_URL}/t/<slug>/reset?token=…`. `WP_PUBLIC_URL` is validated as an http(s) origin
  and fails closed otherwise. In the deployed stack it is an `[env] owner` value the owner sets in the host's
  `.env`; the compose file only passes it through (`${WP_PUBLIC_URL:-}`). It is never committed, because the
  repository is public and the node's origin names the tailnet.
- Without it, links are site-relative paths. Deriving them from the request's Host header would let a requester
  mail a victim a link to the requester's own host, carrying the victim's token.
- The reset page sends `Referrer-Policy: no-referrer` and `Cache-Control: no-store`.

### The role picker survives only on the demo tenant, in demo mode

- The SessionStore's `simulatedLogin` policy, wired as "demo mode and the demo tenant", gates both minting and
  resolving `simulated` sessions.
- "The demo tenant" is the tenant the seed **created**, recorded as the platform setting `demo_tenant`, never
  whichever tenant holds the demo slug.
- A database seeded before the setting existed adopts its demo tenant once, matched by the seed's exact display
  name and brand. A real tenant given the demo slug never gets the picker.
- A simulated session for any other tenant stops resolving, even one minted before this change, and a picker
  login there is refused (400).
- The demo tenant's sign-in page shows the picker in a separate card labeled "Demo workspace: simulated
  sign-in". Every other workspace shows only email and password.

### CSRF on the new forms: a pre-session double-submit token

The sign-in, forgot-password and reset forms run before any session exists, so they cannot use the per-session
CSRF token. Instead:
- Each render sets a `wp_pre` cookie (HttpOnly, SameSite=Strict, scoped to the tenant path, 1 hour) and embeds
  the same value in the form.
- A POST must present both, equal (constant-time compare), before anything else runs.
- A cross-site page can neither read the value nor make the browser send the cookie. This closes login CSRF,
  where a victim is signed into the attacker's account.
- The legacy picker form keeps its documented exemption, and it now exists only on the demo tenant.

### Bootstrapping a workspace

- `POST /admin/tenants/:id/owner {email}` (operator only) creates the `owner` account, or re-invites an existing
  owner, and emails a set-your-password link. A re-invite says the link replaces the current password. An email
  that belongs to a non-owner is refused with an honest 409.
- The operator console has a Tenants page listing every tenant (`GET /admin/tenants`) with that form per
  active tenant.
- This is the only way an account comes to exist until invitations (#11).

## Consequences

- Production stays in demo mode, so the demo tenant keeps its picker. Any workspace the operator provisions
  gets real accounts only.
- The operator relays setup and reset links from the outbox until a real email provider exists (an owner
  crossing in M5).
- Rate limits and their counters live in one process. A second replica would need a shared limiter.
- Rolling back to a build from before this change reopens the picker on every tenant. That is inherent in rolling
  back the feature.
- A password session is a snapshot of its account. Removing a member (#11) must end their sessions through
  `revokeAllFor`.
- The `wp_pre` cookie has no `Secure` attribute or `__Host-` prefix, because the local demo runs on plain HTTP.
  A hostile node on the owner's own tailnet is same-site and could plant one.
- Not done here: changing your password while signed in, sign-out everywhere for a tenant user, multi-factor
  sign-in, account lockout notifications. These are later issues if feedback asks for them.

## Alternatives considered

- **Argon2id:** not in `node:crypto`. It would mean a native dependency in the image, against ADR 0039's
  reasoning. scrypt is memory-hard and built in.
- **A signed (HMAC) pre-session token instead of double-submit:** it needs a persistent server secret for no gain
  here. The cookie is SameSite=Strict and HttpOnly, and a cookie-tossing sibling would have to be a hostile node
  on the owner's own tailnet.
- **Derive email links from the Host header:** this is the classic reset-poisoning bug, so it was rejected.
