---
name: in-app-feedback
description: Issue #12 / ADR 0043 + 0045 — "Send feedback" footer on signed-in pages, CSRF/length/rate-limited form, stores only typed text + tenant + role + page key, operator-only /admin/feedback; owner decided feedback STAYS IN THE APP (never exported to GitHub or agents)
metadata:
  type: project
---

Since issue #12 (2026-10-19): `FeedbackService` stores `{trying, happened, page?, tenant_id, tenant_slug, role,
created_at}` in the GLOBAL partition, bounded PER TENANT (500); no principal/user id and nothing copied from the
workspace. `page` is a KEY from the closed `FEEDBACK_PAGES` list — never a page title (a wedding page's title is the
couple's names). Signed-in pages use `signedInShell(…, pageKey)` (footer link `/t/<slug>/feedback?page=<key>`). Rate limits 10/person/hour,
100/tenant/hour on the shared in-process limiter. The operator reads it at `/admin/feedback` (console page or JSON).

**Owner decision (ADR 0045, 2026-10-19): feedback STAYS IN THE APP.** The operator reads it in `/admin/feedback` and
files issues by hand. Nothing users write ever goes to GitHub or to an agent automatically: never build an export,
API, digest or issue creation for it without a new owner decision. The loop's feedback role (which reads untrusted
GitHub issue text) stays off; enabling it is the owner's host action, and `ops/` is human-reserved.

Related: [[operator-console-and-email-outbox]], [[real-planner-accounts]].
