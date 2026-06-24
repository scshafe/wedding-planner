---
name: prod-trusted-evidence-channel
description: "In production, 'trusted evidence' must wall the evidence CHANNEL/keys/liveness, not just inputs — the eval→prod boundary"
metadata: 
  node_type: memory
  type: project
  originSessionId: 8da949e0-569a-4b65-a730-9b06b67ba00c
---

The loop's safety rests on deciding over **evidence the actor cannot author** — but that property is
true *by construction* only in the eval harness, where the trusted recorder is an out-of-band
interceptor of the product's **sandboxed** effects (no reach-around possible). **In production there
is no sandbox.** The "out-of-band" signals (real payment processor, vendor API, health endpoint,
complaint channel) arrive over network connections, credentials, and webhook configs — and those are
administered by two of the watched agents (`security_agent` owns secrets/rotation/traffic; `reliability_agent`
owns health/failover). So an agent need not forge the payment ledger (it can't); it can degrade *what
the monitor receives as* the ledger: stale replica, dropped webhook, un-provisioned feed after failover.
This is [[loop-trusted-evidence-boundary]] pushed one level deeper — protect the inputs' **channel,
provenance, and liveness**, not just the grader code or even the input fields.

Three mechanisms (each a production twin of an existing rule, in `agent-operations/oversight_loops.md`
"Making the floor un-authorable in production"): (1) the **evidence channel is a Tier-3 surface** —
feed config/endpoints/credentials human-maintained, outside agent write scope, like the graders; (2)
**liveness asserted, absence fails closed** — signed freshness from the third party, stale-feed =
`INTEGRITY.TRUSTED_FEED_STALE`, cross-check 2 independent sources where feasible; (3) **L0/L4 signing
keys outside every agent process** — else a captured manager signs `cleared` as the deterministic_gate
and the additive-only schema is decorative (`INTEGRITY.FORGED_CLEAR`). Honest residual: prod evidence
is *defended*, not *constructed* — you can't sandbox the real processor.

**Why:** the #1 finding of the security (`doddy`) adversarial review of the oversight-loop design;
all three of doddy's P0s were variants of "a safety property proven in a sandbox is asserted to
transfer to prod, but the prod 'trusted' source travels over attacker-administered infra."

**Now specified + hardened** in `agent-operations/trusted_evidence_channel.md` +
`schemas/trusted_feed_schema.json`, after a 2nd doddy review (4 P0 + 3 P1, applied). The mechanisms:
verifying **path AND principal AND network substrate** all separated from acting (a separate principal
at the third party, so an acting credential can't reach the vendor's own config plane; DNS/TLS/egress
in the L0 trust domain); **liveness ≠ completeness** (a signed aggregate/reconciliation catches
suppression a fresh feed hides); serve gated on a **source-signed handshake** (not the agent's word);
**verifiably-independent** corroboration for high-severity; L0/L4 keys outside every agent process with
a **human-established bootstrap ceremony** as the named irreducible root of trust. Production evidence
is **defended, not constructed** — the spec has an explicit *Residual* section (a fully-compromised
third party / un-owned substrate / the bootstrap root are bounded, named trust assumptions).

**Transferable principle worth carrying everywhere:** humans are NOT in the loop (4 exceptions only),
so "route to the human / L4" can't mean page-and-wait. Detection must **contain-first** (reach a safe
state automatically, breaker-style) and monitors must be **recursively liveness-checked** — a detector
going dark (`INTEGRITY.MONITOR_DARK`) halts what it guards; the recursion bottoms out at L0's attested
liveness. Applies to ANY monitor/escalation in the design, not just the evidence channel.

Still-open follow-on: the **action→surface/scope map** (ops analogue of `risk_tier_derivation.md`).
Governs [[agent-run-operations-model]]; multi-tenancy ties to [[white-label-growth-and-agent-strategy-autonomy]].
