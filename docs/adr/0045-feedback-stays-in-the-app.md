# ADR 0045 — In-app feedback stays in the app

- **Status:** accepted
- **Date:** 2026-10-19
- **Decider:** the owner (relayed through the owner session on 2026-10-19), recorded by the building agent
- **Scope:** how feedback that planners and couples send from inside the product (issue #12, ADR 0043) reaches the
  people and agents who build the product.
- **Settles** the question ADR 0043 left open.

## Context

Issue #12 built a "Send feedback" form. Submissions are stored in the production database and listed for the
operator at `/admin/feedback`. How feedback would leave production to reach the engineering loop was explicitly
out of scope, as an owner decision, for three reasons:

- **The repository and its issues are public.** Feedback text can contain anything a user types, including
  personal data about themselves, their couples or their guests.
- **The agents cannot reach production by design.** They run on a host with no route to the tailnet.
- **Text from users is untrusted.** Feeding it to an agent automatically opens a prompt-injection path into a loop
  that can change code and deploy.

## Decision

- **In-app feedback stays in the app.** It is stored in the production database and shown only in the operator
  console (`/admin/feedback`).
- **Issues are filed by hand.** When the owner (as operator) decides that feedback points at something worth
  building, they write a GitHub issue in their own words. The issue holds no copied user text and no personal data.
- **Nothing users write ever goes to GitHub or to an agent automatically.** No export, sync, digest, webhook or
  scheduled job carries feedback out of production. Agents never read the feedback store; they have no access to
  production.
- **The engineering loop's feedback role stays off.** That role turns untrusted GitHub issue text into sanitized
  issues. It is "off until you enable it" in `ops/AUTONOMOUS_OPERATION.md`, and enabling it is an owner action on
  the host. The owner has decided to keep it off. `ops/` is human-reserved, so this ADR changes nothing there; it
  records the decision.

## Consequences

- Building any path that carries feedback out of production (an export button, an API for agents, issue creation)
  is out of bounds without a new owner decision that supersedes this ADR.
- The loop's agents learn about user problems only through issues the owner writes.
- The product side of #12 is unchanged: storage, the operator page, retention per tenant, rate limits.

## Alternatives considered (by the owner)

- **A sanitized automatic export to issues:** it still moves user text into a public place and into an agent's
  input. Sanitizing reliably is hard, and a failure is permanent (public, indexed).
- **Enabling the feedback role:** it processes untrusted GitHub issue text. With no real users filing issues, it
  adds risk and spend for nothing.
