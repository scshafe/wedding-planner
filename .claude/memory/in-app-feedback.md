---
name: in-app-feedback
description: Issue #12 / ADR 0043 — "Send feedback" footer on signed-in pages, CSRF/length/rate-limited form, stores only typed text + tenant + role + page (no identity), operator-only /admin/feedback; exporting feedback to the agents is an OWNER decision
metadata:
  type: project
---

Since issue #12 (2026-10-19): `FeedbackService` stores `{trying, happened, page?, tenant_id, tenant_slug, role,
created_at}` in the GLOBAL partition, bounded PER TENANT (500); no principal/user id and nothing copied from the
workspace. `page` is a KEY from the closed `FEEDBACK_PAGES` list — never a page title (a wedding page's title is the
couple's names). Signed-in pages use `signedInShell(…, pageKey)` (footer link `/t/<slug>/feedback?page=<key>`). Rate limits 10/person/hour,
100/tenant/hour on the shared in-process limiter. The operator reads it at `/admin/feedback` (console page or JSON).

**How feedback reaches the agents is an owner decision** (public repo; agents cannot reach production) — do not build
an export, issue creation or digest without the owner saying how.

Related: [[operator-console-and-email-outbox]], [[real-planner-accounts]].
