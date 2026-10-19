---
name: invitations-and-members
description: Issue #11 / ADR 0042 — planners invite teammates and couples via single-use emailed links; accept creates exactly the invited account and signs in; owner (an ACCOUNT role, not a principal role) resends/revokes/removes; couples inherit the intra-tenant boundary
metadata:
  type: project
---

Since issue #11 (2026-10-19):

- `InvitationStore` keeps PENDING invitations only (tenant-scoped); the link is a `OneTimeTokenStore` token, purpose
  `invitation`, subject = invitation id. Accept and revoke delete the invitation.
- `MembershipService`: planner MEMBERS (owner/planner accounts — never simulated principals) invite (`planner`, or
  `couple` + a wedding of this tenant) and read the team; only the OWNER resends, revokes, removes (never themselves,
  never an owner; removal also revokes the member's sent invitations). Invites/resends rate-limited (20/member/h,
  50/tenant/h), max 100 pending; expired invitations read as absent and are deleted. Accept: password length first,
  consume token, refuse an email that gained an account, create exactly as invited, SessionStore mints.
- **Owner is an account role**: owner iff a planner principal whose `principal_id` is an `owner` account. Principals
  still have only `planner`/`couple`, so no authorizer changed.
- Outbox retention is PER TENANT (one workspace cannot push out another's links); `/admin/outbox?tenant=<id>`.
- Couples: principal `{ role: 'couple', wedding_id }` → the existing WeddingAuthorizer/guest/escalation scopes apply.
- Web: `?view=team`, "Invite the couple" on a wedding (shown iff the team read answers 200), `/t/:slug/invite`
  accept page (wp_pre CSRF, no-referrer); team forms use the per-session CSRF token.

Related: [[real-planner-accounts]], [[http-edge-and-intra-tenant-auth]], [[couple-scoped-guest-management]].
