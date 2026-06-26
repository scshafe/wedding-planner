---
name: guest-messaging-channel-is-a-roadmap-goal
description: "Human-set goal (2026-06-26): a guest-facing conversational messaging channel (SMS/WhatsApp/…) where wedding guests text the AI for info/updates/Q&A — built offline-first, with TWO hard design constraints: pricing/cost is a first-class factor, and the provider must be swappable (no vendor lock-in). Real sending stays human-reserved."
metadata:
  node_type: memory
  type: project
---

**Human-set goal (2026-06-26).** A **guest-facing conversational messaging channel**: wedding guests
text the AI over **SMS / WhatsApp / etc.** to get info, updates, and answers (RSVP status & changes,
logistics — time/place/parking/dress code, and free-form Q&A). This is a **named capability on the
customer-facing product-surface roadmap** ([[customer-facing-product-surface-is-a-first-class-goal]]) —
on the horizon, the loop owns timing and all engineering.

**It is already designed-for in the inward-facing layers (this is the strength of the idea).** The
guest↔AI Q&A loop is modeled and SCORED today — `guest.question.asked` → `guest.question.answered`
feeding `qa_accuracy_rate`/`escalation_correct` ([[qa-accuracy-trusted-reconciliation]]); guest personas
carry scripted questions with `expected_answer` + `answerable_by` ∈ {ai_from_known_facts,
requires_couple, must_refuse}; and **sms/whatsapp/phone are already first-class `channel` values** (the
telemetry `event_payloads` channel enum + the guest persona `preferred_channel`, with a `reachability`
postal/phone fallback). What is MISSING is the *product channel* (a guest-facing inbound/outbound
surface — guests are NOT yet a product persona; the product has only `planner`|`couple` today) and the
*provider boundary*.

**CONSTRAINT 1 — pricing/cost is a first-class factor (human-set).** Messaging is **metered** (real
per-message carrier cost), unlike everything priced so far. Two cost surfaces, both load-bearing:
- *Platform pricing/billing.* Today `product/src/billing/price_book.ts` (`@canonical price_book`) is a
  **flat monthly** plan-tier price with NO usage dimension. The channel must add **usage-metered
  pricing** — meter per-message usage per tenant, attribute carrier cost, and price it with margin
  (per-message charge events / included allotments / overage) so the business never loses money on
  messaging. Rides the Phase-15 billing ledger ([[onboarding-billing-operator-tier]]): a `charge`
  accrual per metered usage, balance still a fold; consider a usage/`metered` event kind.
- *The AI's comms strategy must be cost-aware.* Each message carries a **monetary** cost that feeds the
  North-Star denominator ([[north-star-objective]]), so the existing tier-1 cadence/spacing/**batching**
  knobs ([[third-tier1-knob-batching-3d-search]]) trade real money, not only guest attention. (Couples'
  own spend still follows [[spend-autonomy-model]].)

**CONSTRAINT 2 — avoid vendor lock-in (human-set, a DESIGN rail).** The messaging provider sits behind a
**provider-agnostic port** — `send` / receive-`inbound` / `delivery-status` / **per-message
`cost-report`** — with swappable adapters (Twilio / Vonage / AWS / MessageBird / Sinch / …), ALL
offline-**simulated** for now (a `SimulatedMessagingProvider`). No carrier-specific concept leaks into
the domain (internal message ids, never a vendor SID; no vendor enum in the core). Keep it
**channel-agnostic** (sms/whatsapp/rcs/email share the one abstraction — the schema already is). Making
**cost-report part of the port** is what lets you switch vendors *on price* — so the two constraints are
synergistic, not competing. Mirrors the repo's injected-port discipline (clock/ids as edge-only injected
primitives — [[deployable-image-composition-root]]); the provider is just another injected side-effect
boundary with a deterministic double.

**THE BOUNDARY (offline-first + human-reserved — unchanged).** Build the guest channel, the simulated
provider, the metered billing, and the cost-aware comms model **OFFLINE and demoable**. A **real**
messaging provider that actually sends/receives texts to/from real people is the **human-reserved
crossing** — guest-comms content is risk **tier 2** (human-approval-gated), and "real guest comms" is an
explicit offline-first exception. Build up to the line; the simulated adapter is in-scope; wiring a real
vendor + real numbers + real recipients is the human's to flip on (like the Docker image: built, never
pushed).

**SAFETY REUSE, not a new model.** A guest channel is a NEW SURFACE for EXISTING trusted-evidence
concerns, not a new safety model. Ride the comms-safety gates — `COMMS.SURPRISE_LEAK` (don't reveal a
surprise to the wrong guest), `COMMS.MIS_SEGMENTATION` (don't disclose other guests' data),
`COMMS.FALSE_FACT_TO_GUEST` — and the qa/escalation model. A **guest is a new, UNTRUSTED product
persona**: inbound text is attacker-controlled (prompt-injection, existence-oracle probing), so the same
no-existence-oracle + trusted-evidence + edge-validation discipline the product surface already enforces
([[http-edge-and-intra-tenant-auth]], [[multi-tenant-isolation-boundary]]) applies to the guest edge.

**How to apply:** when the loop takes this up, write a plan (`writing-plans`); own stack/structure/design.
Likely shape: a `MessagingProvider` port + `SimulatedMessagingProvider`, a guest-conversation surface
folded into the existing `api.handle` pipeline (NOT a parallel one), usage-metered billing extending
`price_book`/the ledger, and a per-message cost term wired to the North Star. Verify with doddy (the
untrusted guest edge + the new mutation/oracle surface) and keep the offline/human-reserved line.
