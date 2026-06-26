---
name: customer-facing-product-surface-is-a-first-class-goal
description: "The business needs a customer-facing product (white-label, multi-tenant web app); building it is now a first-class goal — offline-first + Docker-packaged + launch-ready, going live human-reserved, loop owns timing"
metadata:
  node_type: memory
  type: project
---

**Human-set course-correction (2026-06-25).** The four domains built so far — `eval-harness/`,
`telemetry/`, `loop-orchestrator/`, `agent-operations/` — are **all inward-facing**: how the system
scores, measures, improves, and operates *itself*. There is **no customer-facing product surface** —
nothing a paying customer signs up for and uses. For this to be the **business** it is meant to be,
that surface is the missing piece. Everything built so far is the *engine*; this is the *car*.

**The goal (now first-class, co-equal with the self-improvement loop):** a **white-label,
multi-tenant** web app that real wedding planners — and their couples — sign up for, theme, and use.
This is the concrete product realization of the long-floated white-label direction
([[white-label-growth-and-agent-strategy-autonomy]]); what was a "candidate, not ratified" is now a
ratified **build** goal.

**The boundary — this KEEPS the offline-first safety model intact, it does not weaken it:**
- **Build it offline-first, packaged as a deployable Docker container.** A real, locally-runnable,
  demoable, launch-*ready* app. Onboarding, billing, and guest/planner comms are **offline
  simulations** (no real money, tenants, or messages). The deliverable is an image a human can deploy.
- **Going live stays human-reserved.** Producing the container is in-scope; *running it in
  production* — real hosting, registry push, DNS, secrets, real tenants/payments/comms — is the human
  crossing (operations exception #4, business billing/contracts; see [[agent-run-operations-model]]).
  Build right up to the line; never cross it. Do not provision real infra or simulate having gone live.

**Why:** the user realized the initial layout had no product surface at all — an oversight for
something meant to be a business. They want this on the roadmap as a real goal while the loop keeps
full engineering + sequencing autonomy.

**How to apply:** this is **on the horizon, loop owns timing** — not a forced next phase. Sequence it
yourself (finish in-flight offline-loop threads or pivot when you judge it's the higher-value move).
When you take it up, write a plan (`writing-plans`) and own the stack/structure/design as always; the
North Star ([[north-star-objective]]) and the one safety model still govern. Design for multi-tenancy
from the start (per-tenant isolation — mirrors [[prod-trusted-evidence-channel]]). Couples' wedding
spend inside the product still follows [[spend-autonomy-model]]. The distinct, still-unsettled thread
is *strategy autonomy* (agents *deciding* pricing/contracts/growth commitments) — that stays
human-reserved; only the technical BUILD is ratified here.
