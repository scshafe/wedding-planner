# ADR 0043 — In-app feedback

- **Status:** accepted
- **Date:** 2026-10-19
- **Decider:** the building agent (an agent-owned engineering decision per [[agents-own-buildout-decisions]]),
  for issue #12 (M1 "Real foundations")
- **Scope:** a "Send feedback" link for signed-in planners and couples, a short form, durable storage, and an
  operator-only page that lists submissions.
- **Builds on** durable storage (ADR 0039), the operator console (ADR 0040), and the in-process rate limiter
  (ADR 0041).

## Context

Planners and couples need a way to say what is wrong or missing, from inside the product. How feedback leaves
production to reach the agents is **out of scope by owner decision**: the repository and its issues are public,
and the agents cannot reach production by design. Until the owner decides, the operator page is the only
consumer.

## Decision

- **The link:**
  - Every page only a signed-in planner or couple reaches (`signedInShell`) carries a footer link
    `/t/<slug>/feedback?page=<page title>`.
  - The page title is the context, not a URL with ids in it.
  - Sign-in, password and invitation pages have no such link.
- **The form** (`/t/<slug>/feedback`) asks "what were you trying to do?" and "what happened?", plus an optional page
  field prefilled from the link.
  - It checks the per-session CSRF token. The weddings read gates the page (both roles may read it), so an
    unauthenticated visit gets the sign-in page.
  - It posts to `/t/<slug>/feedback/send`, which calls the JSON `POST /t/<slug>/feedback`.
- **What is stored** (`FeedbackService`):
  - what the person typed, trimmed (at most 1,000 / 4,000 / 120 characters);
  - the tenant id and slug, the submitter's role and the time.
  - Not who they are (no principal or user id) and nothing copied from the workspace: no guest data, no wedding
    details. The issue asks for "tenant, role and page", and that is all that is kept.
- **Rate limits:** 10 per person per hour and 100 per workspace per hour, on the shared in-process limiter. A
  rejected submission (empty, too long) does not count.
- **Where it lives:**
  - Feedback is a platform log in the global partition, with the tenant as a field, like the outbox.
  - It is bounded at the newest 5,000.
  - The operator reads it at `GET /admin/feedback`: JSON with the credential, or the console page in a browser.
    Text is escaped and shown in `<pre>`.

## Consequences

- The owner can read feedback on the deployed node today. Routing it to the agents (an export, a digest, a
  sanitized issue) is still an owner decision. Nothing here sends it anywhere.
- Feedback text can contain anything a user types, including personal data they choose to write. It stays in
  production, in the backed-up database, behind the operator credential.
- Not done: replying to the submitter (there is no identity to reply to, by design), attachments, screenshots.
