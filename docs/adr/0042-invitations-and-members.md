# ADR 0042 — Invitations and members

- **Status:** accepted
- **Date:** 2026-10-19
- **Decider:** the building agent (an agent-owned engineering decision per [[agents-own-buildout-decisions]]),
  for issue #11 (M1 "Real foundations")
- **Scope:** a planner invites teammates and a wedding's couple through single-use emailed links; accepting creates
  the account and signs it in; the workspace owner manages invitations and members; invited couples stay inside
  their own wedding.
- **Builds on** real accounts ([[real-planner-accounts]], ADR 0041), the email outbox (ADR 0040), and the
  intra-tenant boundary ([[http-edge-and-intra-tenant-auth]], ADR 0013; [[couple-scoped-guest-management]],
  ADR 0024).

## Context

After #10, an account exists only when the operator sets up a workspace owner. A planner works with teammates and
with each couple, and a couple used to "log in" by typing a wedding id into the role picker.

## Decision

### Invitations are pending records, and their links are one-time tokens

- `InvitationStore` keeps pending invitations only, tenant-scoped, keyed by invitation id. Each holds a
  normalized email, a role (`planner`, or `couple` with its `wedding_id`), the inviting principal, `created_at`
  and `expires_at`.
- The link token is in the `OneTimeTokenStore` (ADR 0041), with the new purpose `invitation` and the invitation id
  as its subject. So the invitation record holds nothing a reader could accept it with.
- Accepting deletes the invitation, and so does revoking. There is no history table: M1 needs pending invitations,
  and the outbox shows what was sent.

### Who may do what

| Action | Who |
| --- | --- |
| invite a teammate (`planner`) or a wedding's couple | any planner **member** (an owner or planner account) |
| read the team (members' public views, pending invitations, who sent each) | planner members (couples and simulated principals get 403) |
| resend or revoke an invitation | the workspace owner |
| remove a member | the workspace owner, never themselves |
| accept | the holder of the link (unauthenticated) |

"Owner" is an account role, not a principal role. A principal is the owner iff it is a planner whose
`principal_id` is an `owner` account of this tenant, which in practice means the owner's password session.
Principals keep the two roles the authorizers already understand (`planner`, `couple`), so no existing
authorization decision changed.

A simulated demo principal has no account, so it is not a member at all. It cannot invite or read the team. The
security review showed why that matters: with the demo tenant's picker open to anyone on the tailnet, member-less
invites let an anonymous visitor flood the shared outbox and read every member's email.

### Accept creates exactly what was invited

`MembershipService.accept`:
1. Checks the password length before using the link.
2. Consumes the token and loads the invitation.
3. Refuses an email that gained an account in the meantime (409).
4. Creates the account with the invitation's email, role and wedding, and the chosen scrypt password.
5. Deletes the invitation.
6. Asks the SessionStore, still the sole mint, for a `password` session.

The accepter cannot choose a different email, role or wedding: none of them is in the request.

### Couples inherit the existing boundary

A couple account's session principal is `{ role: 'couple', wedding_id }`. The existing authorizers do the rest:
- `WeddingAuthorizer`: other weddings are masked as 404, and creating a wedding is forbidden.
- Guest and escalation scopes are limited to the couple's wedding.
- Billing and team are planner-only.

Tests prove all of this through an invited, real couple account: weddings, guests and the escalation inbox are
scoped to the couple's wedding, billing and team are forbidden, and removing the couple ends their session.

### Bounded, because every invitation is an email

- Invites and resends are rate-limited: 20 per member per hour and 50 per workspace per hour, on the shared
  in-process limiter.
- A workspace holds at most 100 pending invitations.
- An expired invitation reads as absent everywhere and is deleted when seen. The same address can then be invited
  again, and the invitee's email does not linger.
- The token store's revoke pass also drops expired link tokens.
- **The outbox's retention is per tenant** (1000 each, with platform mail as its own group). One workspace sending a
  lot can never push another workspace's setup or reset links out. The operator can read one tenant's messages: a
  link on each tenant on the Tenants page opens `/admin/outbox?tenant=…`.

### Resend, revoke, remove

- **Resend** renews the expiry and re-issues the token. Issuing revokes the earlier token, so the old link dies.
- **Revoke** deletes the invitation and its token.
- **Remove member** deletes the account, ends every session of it (`revokeAllFor`) and revokes its outstanding
  links. It also revokes every invitation the member sent, along with its link, so a removed planner cannot get back
  in through an invitation they planted for a second address. The team page shows who sent each invitation.
- The owner cannot remove themselves, and no owner account can be removed here (409).

### Conflicts are honest to the inviter

Inviting an email that already belongs to a member, or already has a pending invitation, is a 409 to the planner
of the same workspace. That is trusted staff seeing their own workspace's state (the same reasoning as
`GUEST_ALREADY_REGISTERED`, ADR 0021). It is not an anonymous oracle.

### Pages

- `?view=team` shows members and invitations, an "Invite a planner" form for every planner, and the
  Resend/Revoke/Remove buttons for the owner.
- A wedding's page has "Invite the couple" for planners. The page learns the viewer is a planner from the team read
  answering 200, the same affordance pattern as the billing card on the home page.
- The home page shows a Team card to planners.
- `/t/:slug/invite?token=…` is the accept page. It uses the pre-session double-submit CSRF token (ADR 0041) and
  `Referrer-Policy: no-referrer`. On success it sets the session cookie and lands on the console.
- The team forms check the per-session CSRF token before anything else.

## Consequences

- Couples no longer need the role picker: a planner invites them by email. The picker remains on the demo tenant
  only (ADR 0041).
- The owner relays invitation links from the outbox while email is simulated.
- On the demo tenant, the team features need an owner account the operator sets up; the picker's anonymous
  planners cannot use them.
- Not done here:
  - ownership transfer;
  - a member changing their own role;
  - re-inviting a removed member (it works as a fresh invitation);
  - showing the invited email on the accept page.

## Alternatives considered

- **Make `owner` a principal role:** every authorizer branches on `role === 'planner'`, so a third principal role
  would ripple through every decision. Keeping owner as an account role, checked only where management happens,
  confines the change.
- **Keep accepted and revoked invitations as history:** it is not needed for M1, and it would keep more personal
  data (emails) around.
