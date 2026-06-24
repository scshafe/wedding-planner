---
name: agent-run-operations-model
description: The whole stack is run by a team of agents; humans are reserved for only four exceptions
metadata: 
  node_type: memory
  type: project
  originSessionId: 6516eb65-8633-4b90-8c13-798200fc27e6
---

The project is designed so a **team of agents runs the entire stack** — CI/CD, product-change
decisions, customer/guest support, monitoring/SRE/incident response, routine ops. Humans are NOT in
the operating loop; they sit on the exception path. There are exactly **four human-reserved
exceptions**:

1. **Elevated customer support** (abuse, legal, acute distress, a wedding-day emergency an agent
   can't resolve, remedies beyond standing policy)
2. **Total system failure** (production down / data integrity at risk, automated recovery exhausted)
3. **Security breaches** (confirmed or credibly-suspected compromise — agents detect/contain/freeze
   within policy but humans OWN breach response & disclosure)
4. **Billing — the BUSINESS's own finances/legal** (infra billing, contracts, pricing, payouts) —
   distinct from a couple's wedding budget, which the product handles via [[spend-autonomy-model]].

These four are the **operational analogue of the loop's `risk_tier: 3`**: an agent operates right up
to the line (detect/contain/freeze/recommend/draft handoff) and never crosses it.

**Why:** the user's explicit goal — maximize autonomy, minimize the human operating surface, while
keeping the genuinely irreversible/high-stakes calls with people.

**How to apply:** lives in `agent-operations/` (README, human_reserved_boundary.md, agent_roster.md
of 6 roles incl. the loop as one member, shared_operating_discipline.md, schemas/escalation_record).
It REUSES the loop's one safety model — see [[loop-trusted-evidence-boundary]] and
[[north-star-objective]]; do not invent a parallel one. The **oversight-loop mechanics** (how the
manager/oversight loops actually run) are now designed + hardened in `agent-operations/oversight_loops.md`
(+ schemas/oversight_record): oversight = the meta-gaming firewall turned sideways; the regress
terminates at a non-agent L0 floor; reviewer authority is **additive-only** (raise scrutiny, never
clear — only the deterministic gate or human clears); three tempos (inline / continuous / periodic);
obligations checked out-of-band route past the manager to the human. Reviewed by security + architecture
(P0/P1/P2 applied). The production extension is [[prod-trusted-evidence-channel]].
