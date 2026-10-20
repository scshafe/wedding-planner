# ADR 0043 — In-app feedback

- **Status:** accepted (the open routing question is settled by ADR 0045)
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
    `/t/<slug>/feedback?page=<key>`. The key comes from the closed list `FEEDBACK_PAGES` (home, weddings, wedding,
    guests, questions, conversation, billing, team, strategy, other).
  - It is never the page title. A wedding page's title is the couple's names, and the security review caught
    those being copied into stored feedback.
  - Sign-in, password and invitation pages have no such link.
- **The form** (`/t/<slug>/feedback`) asks "what were you trying to do?" and "what happened?", plus an optional page
  select from the same closed list, preselected from the link. The server refuses any other page value.
  - It checks the per-session CSRF token. The weddings read gates the page (both roles may read it), so an
    unauthenticated visit gets the sign-in page.
  - It posts to `/t/<slug>/feedback/send`, which calls the JSON `POST /t/<slug>/feedback`.
- **What is stored** (`FeedbackService`):
  - what the person typed, trimmed (at most 1,000 / 4,000 / 120 characters);
  - the tenant id and slug, the submitter's role and the time.
  - No principal or user id, and nothing copied from the workspace: no guest data, no wedding details. The issue
    asks for "tenant, role and page", and that is all that is kept.
  - Tenant and role together can still point to one person, in a workspace with a single planner or couple. That
    matters for the owner's export decision, along with prompt injection: feedback text is untrusted.
- **Rate limits:** 10 per person per hour and 100 per workspace per hour, on the shared in-process limiter. A
  rejected submission (empty, too long) does not count.
- **Where it lives:**
  - Feedback is a platform log in the global partition, with the tenant as a field, like the outbox.
  - It is bounded per tenant at the newest 500. With the demo tenant's role picker open to anyone on the tailnet
    (each login is a fresh principal), a global bound would let scripted demo submissions push out every real
    workspace's feedback.
  - The operator reads it at `GET /admin/feedback`: JSON with the credential, or the console page in a browser.
    Text is escaped and shown in `<pre>`.

## Consequences

- The owner can read feedback on the deployed node today. The routing question is settled by ADR 0045: feedback
  stays in the app, the operator files issues by hand, and nothing users write goes to GitHub or an agent
  automatically.
- Feedback text can contain anything a user types, including personal data they choose to write. It stays in
  production, in the backed-up database, behind the operator credential.
- Not done: replying to the submitter (there is no identity to reply to, by design), attachments, screenshots.
