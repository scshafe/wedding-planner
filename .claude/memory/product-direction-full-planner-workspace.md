---
name: product-direction-full-planner-workspace
description: "Owner decision 2026-10-13: build a full planner workspace (M1 foundations → M5 launch readiness, ROADMAP.md), chosen over the recommended narrow AI-guest-concierge wedge; state of the product at that point"
metadata:
  type: project
---

**Decision (owner, 2026-10-13):** the MVP direction is a **full planner workspace** for
independent planners and small studios: guests, RSVPs, checklist/timeline, vendors, budget, run of
show, seating, wedding website, then an AI assistant. `ROADMAP.md` holds the milestones and is
canonical for *what* gets built next.

**Rejected alternative, kept for context:** the agent recommended a narrow wedge, an AI guest
concierge (guests text, grounded answers + RSVP, planners handle only escalations), because it
builds on what existed and avoids competing head-on with established planner suites. The owner
chose the broader workspace. Don't relitigate it. Raise it again only if feedback or pilot evidence
argues for a change, as a `status:needs-owner` proposal.

**The product at the decision point** (an honest baseline for judging progress): a secure
multi-tenant shell (1006 tests). It had in-memory state only (every deploy reset to the demo seed),
a role-picker login, a wedding of 7 fields, guests as bare phone handles, keyword-matching Q&A
with no LLM, and simulated billing. 13 of the 38 June phases deepened the guest-question inbox.
That is the failure mode of a loop with no roadmap or customer signal, and the reason for
[[engineering-loop-v2]]'s triage and synthetic-user roles.

**How to apply:** sequence inside milestones by dependency (storage before accounts before
invites). Keep the engine domains green but don't extend them except where a milestone needs them
(M4's eval set). Human crossings (real providers, Stripe, signup, legal, custom domains) are built
up to the line and handed to the owner. Related: [[customer-facing-product-surface-is-a-first-class-goal]].
