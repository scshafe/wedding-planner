---
name: invitations-and-members
description: Issue #11 / ADR 0042 — planners invite teammates and couples via single-use emailed links; accept creates exactly the invited account and signs in; owner (an ACCOUNT role, not a principal role) resends/revokes/removes; couples inherit the intra-tenant boundary
metadata:
  type: project
---

Since issue #11 (2026-10-19):

- `InvitationStore` keeps PENDING invitations only (tenant-scoped); the link is a `OneTimeTokenStore` token, purpose
  `invitation`, subject = invitation id. Accept and revoke delete the invitation.
- `MembershipService`: any planner invites (`planner`, or `couple` + a wedding of this tenant) and reads the team;
  only the OWNER resends, revokes, removes (never themselves). Accept: password length first, consume token, refuse
  an email that gained an account, create the account exactly as invited, delete invitation, SessionStore mints.
- **Owner is an account role**: owner iff a planner principal whose `principal_id` is an `owner` account. Principals
  still have only `planner`/`couple`, so no authorizer changed. Simulated demo planners can invite, never manage.
- Couples: principal `{ role: 'couple', wedding_id }` → the existing WeddingAuthorizer/guest/escalation scopes apply.
- Web: `?view=team`, "Invite the couple" on a wedding (shown iff the team read answers 200), `/t/:slug/invite`
  accept page (wp_pre CSRF, no-referrer); team forms use the per-session CSRF token.

Related: [[real-planner-accounts]], [[http-edge-and-intra-tenant-auth]], [[couple-scoped-guest-management]].
