---
name: white-label-growth-and-agent-strategy-autonomy
description: "Candidate growth direction (white-label/multi-tenant for real wedding planners) + the user's intent that the agent team be allowed to ideate/implement growth ideas"
metadata: 
  node_type: memory
  type: project
  originSessionId: 8da949e0-569a-4b65-a730-9b06b67ba00c
---

**Candidate growth direction (user-floated, 2026-06-23):** turn the planner into a **white-labeled /
multi-tenant platform** — let *actual wedding planners* sign up and theme their own site. A possible
way to grow the business.

**The deeper intent (the load-bearing part):** the user wants the **eventual agent team to be allowed
to ideate AND implement growth ideas like this if they choose** — i.e., broader agent strategic/product
autonomy than a pure "improve the existing product within fixed surfaces" loop. This is an aspiration
about *scope of autonomy*, flagged for consideration, NOT yet a ratified design change.

**The tension it raises (a thread to resolve, not settled):** a white-label pivot needs pricing tiers,
planner contracts, brand/legal, and multi-tenant architecture. Under the current design, the technical
build (multi-tenancy, theming) is ordinary Tier-≤2 product work agents can do — but pricing / contracts
/ legal land in human-reserved **exception #4** (business billing/legal) and the loop's **Tier-3**
(objective / business-model). So "let agents ideate+ship growth" stretches today's boundary.

**Suggested reconciliation (my proposal, consistent with the one safety model — confirm before baking
in):** agents may **ideate, build, prototype, and *propose*** growth/strategy (Tier-≤2 product +
shadow/canary experiments), while the **irreversible business commitments** (signing planner contracts,
setting pricing, legal representations) stay human-reserved — the same "operate up to the line, a human
owns the crossing" rule applied to *strategy*, not just ops. This would likely need a new roster role or
an expanded loop mandate (a "growth/strategy proposer") whose proposals are gated exactly like product
candidates. See [[agent-run-operations-model]], [[north-star-objective]], [[spend-autonomy-model]].

**How to apply now:** design current specs to NOT preclude multi-tenancy (e.g., the production
trusted-evidence-channel spec is being written with per-tenant feed isolation in mind —
[[prod-trusted-evidence-channel]]). Treat the autonomy-scope expansion as its own future design thread.
