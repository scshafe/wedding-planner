# The Production Trusted-Evidence Channel

The whole safety model rests on deciding over **evidence the actor cannot author**
(`../loop-orchestrator/safety_and_governance.md` §1; `../telemetry/README.md` "Integrity"). In the
eval harness that is true *by construction* — the trusted recorder is an out-of-band interceptor of
the product's **sandboxed** effects, with no reach-around. **Production has no sandbox.** The
out-of-band signals are *real* third-party systems reached over network channels, credentials, and
config — and that infrastructure is administered by agents on the roster (`security_agent` owns
secrets/rotation/traffic; `reliability_agent` owns health/failover — `agent_roster.md`). So the slogan
does not transfer for free, and the central honesty of this spec is that production evidence is
**defended, not constructed**: walled where we can wall it, corroborated where we cannot, and bounded
by a small, named, human-established root of trust (§ "Residual"). This is how the L0 floor of
`oversight_loops.md` (§ "Making the floor un-authorable in production") is *defended* in production.
It owns the **channel discipline** by which a production monitor reads a third-party source — not the
trusted event stream (telemetry's), nor the breakers that consume it
(`../loop-orchestrator/safety_and_governance.md` §3); it serves both those consumers and the ops
breakers / obligation monitors / inline gate of `oversight_loops.md`.

## The crux: the verifying path — and verifying *principal* — is not the acting path

The idea everything follows from: **what an agent uses to *act* is separate, by construction, from
what a monitor uses to *verify*** — and "separate" must hold at three layers, because closing only
the first leaves the wall standing on sand:

1. **Credentials/config in our system.** The endpoints, keys, and webhook config the monitor reads
   from are **trusted config outside every agent's write scope** (including `operations_manager`,
   `security_agent`, `reliability_agent`) — the production analogue of "graders live outside the
   proposer's write scope" (`safety_and_governance.md` §1). The acting path's keys *are* rotatable by
   `security_agent` within scope; the verifying path's are not.
2. **The principal at the third party.** The verifying path authenticates to the third party as a
   **distinct, least-privilege principal** (a read-only verification account), *not* the acting
   account. Otherwise an agent holding the legitimate acting credential can reach the vendor's *own*
   config plane — change the webhook target, mute a notification, alter a forwarding rule — and degrade
   the verifying feed without ever touching our config. Separating creds-in-our-system but sharing the
   third-party principal is the wall on sand.
3. **The network substrate.** The verifying read traverses **DNS resolution, TLS trust, and egress
   that live in the L0 trust domain** — pinned resolvers, pinned/cert-validated source identity,
   dedicated egress — *not* the agent-administered network. Otherwise an agent that controls resolution
   or egress redirects "the processor's ledger" to a replica it serves.

A source that cannot offer a separable verifying principal (some third parties don't) is **downgraded**:
it may corroborate, but it may not be the *sole* ground for a high-severity determination (§ "Corroboration").

## The trusted sources, and what each feeds

Production ground truth comes from these out-of-band sources (the same set the schemas name —
`schemas/escalation_record_schema.json` `detected_from`, `schemas/oversight_record_schema.json`
`read_from`), each classified by the decisions it grounds and whether it grounds a **high-severity**
determination (money committed, booking verified) that triggers the stricter requirements below:

| trusted source | grounds | high-severity? |
|---|---|---|
| `out_of_band_payment_processor` (charge ledger + signed settlement total) | spend committed, unauthorized-commit breakers, `SPEND.*` | **yes** |
| `out_of_band_vendor_confirmation` (booking APIs' actual state + reconciliation) | booking verified vs. claimed, double-book detection | **yes** |
| `out_of_band_complaint_channel` (chargebacks/complaints) | guest-harm signals, distress/legal-threat tripwires | no |
| `independent_health_check` (out-of-process probes) | service health vs. self-reported "healthy" | no |
| `harness_trusted_record` (eval only) | the sandboxed-effect interceptor | n/a (not a production feed) |

A decision reads a source only as a **classified trusted feed** conforming to
`schemas/trusted_feed_schema.json`; reading a raw agent-reachable endpoint as if trusted is itself a
misconfiguration the obligation monitors flag.

## Liveness *and* completeness: silence is not safety, and a fresh feed can still lie by omission

A monitor that reads a silent feed must not conclude "no harm" (silence = the feed was cut). But
liveness is not enough: a feed can heartbeat fresh, gap-free, and signed while **selectively
suppressing the one event that matters upstream of where sequence numbers are assigned**. So two
distinct guarantees:

- **Liveness.** Each feed carries a **signed, sequenced freshness assertion** from the third party (a
  heartbeat + monotonic sequence) and a **freshness horizon** tied to the harm's doubling time
  (`safety_and_governance.md` §3). Stale beyond horizon → **fail closed**: the dependent decision is
  treated as *harm/uncertain*, not *clean* (`INTEGRITY.TRUSTED_FEED_STALE`).
- **Completeness.** A high-severity feed also carries a **signed aggregate** — a running total /
  balance / Merkle root the third party attests independent of the event stream (e.g. the processor's
  signed settlement total, the vendor's booking count). The monitor **reconciles the stream against the
  aggregate**; a selectively-suppressed event makes the reconciled total diverge even when the stream
  looks consistent. Completeness is what catches the "fresh but lying by omission" attack that liveness
  alone passes.

A breaker fed by a source it cannot confirm *live and complete* is not a breaker — the safe default is
revert/withhold, the same discipline as "a wedding never waits for an on-call response" (§3).

## Serving is gated on a source-signed handshake, not an agent's word

`reliability_agent` may fail over to a new region; `security_agent` may rotate acting credentials —
both legitimate, both potential evidence-blinding moves. The discipline:

- **A region/component may not *serve* until the third party signs a "now delivering to monitor M for
  region R" handshake**, verified against the L0 keyring. "Provisioned and live" is therefore the
  *source's* attestation, not `reliability_agent`'s self-report — closing "fail over to a region whose
  feed isn't wired" *and* "declare provision-complete falsely." An un-handshaked region fails closed
  (not "healthy") until the source attests.
- **Rotating an *acting* credential never rotates a *verifying* one.** A rotation request touching the
  verifying path is an under-scoped write rejected as `INTEGRITY.SCOPE_EXCEEDED` — though note that
  *mechanizing* that rejection depends on the action→scope map (a named, unbuilt dependency —
  `oversight_loops.md`, root README); until it exists, the boundary is held **structurally** by
  `writable_by_agent: false`, not by scope derivation.

## Corroboration: ≥2 sources with *verifiably distinct* trust roots, for every high-severity call

A lone feed is a lone thing to capture; two feeds that share a poisonable upstream are one feed wearing
two hats. So for every high-severity determination (schema-enforced, not optional):

- Cross-check **≥2 sources whose independence is *attested*, not assumed** — verifiably distinct trust
  roots (distinct signing authorities and distinct upstreams), not two reads of the same processor. The
  earlier draft's "the processor's webhook *and* its settlement pull" was **not** independent (one
  upstream); a sound pair is the *processor's* charge record cross-checked against the *card
  network's / bank's* settlement, or an independent reconciliation service.
- **At least one corroborator is the completeness aggregate** above, so the pair catches suppression,
  not just disagreement. **Divergence between trusted roots is itself an incident**
  (`INTEGRITY.SELF_REPORT_DIVERGENCE` at the source layer), never a coin-flip resolved silently.

## Key custody — and the root-of-trust bootstrap, named honestly

`decided_by` is only as trustworthy as the key that signs it (`safety_and_governance.md` §7;
`shared_operating_discipline.md` §5). So:

- **L0 mechanism keys** (`deterministic_gate`, `circuit_breaker`, `obligation_monitor`) live in the L0
  substrate **outside every agent's process boundary**; the **L4 (`human`) key** is human-held. A
  `verdict: cleared` whose signature does not verify against the L0/L4 keyring is `INTEGRITY.FORGED_CLEAR`.
- **Source signing keys** (the third party's freshness/aggregate/handshake signatures) are pinned, and
  **rotation is signed by the prior key** (no silent re-pin); the monitor rejects an unsigned re-pin.
- **The bootstrap is the irreducible human-established root of trust.** Establishing the initial L0/L4
  keys and the initial source-key pins is a **human-reserved ceremony** (a Tier-3 setup, like standing
  up the firewall) — not an agent action, and the one place "trust on first use" is resolved by a
  person, once, out of band. This spec does not pretend to bootstrap trust from nothing; it names the
  small root a human plants and builds everything else on it.

## The monitors are themselves monitored, and fail closed to *containment* (not to a page)

This is the load-bearing correction, and it follows from the project's own model. The oversight design
routes violations "to L4 (the human supervisor)" and leans on "human-maintained config" — but humans
are **not in the operating loop**; they sit on four narrow exceptions (`human_reserved_boundary.md`).
So "route to L4" **cannot** mean "page and wait for someone watching a dashboard." Therefore:

- **Apply this spec's liveness discipline recursively to the monitors.** A monitor / breaker / gate is
  itself liveness-asserted; a detector that goes dark is `INTEGRITY.MONITOR_DARK`, and **the action it
  guards halts/reverts by default** — there is no silently-unmonitored window. The verifier of
  `FORGED_CLEAR` is itself monitored; turtles do *not* go all the way down — they bottom out at the L0
  substrate's own attested liveness, the same fixed point as the keys.
- **Every fail-closed path reaches a safe state automatically.** Stale feed, reconciliation mismatch,
  missing handshake, dark monitor → **contain/withhold first, surface for recovery second** — the
  breaker discipline (`safety_and_governance.md` §3), now stated for the evidence layer. The human is
  woken for *recovery and ratification* (and only when the containment itself crosses an exception,
  e.g. a total-failure or breach trigger), never as the thing that *causes* the safe state. "Detected
  whenever the human next looks" is the wrong default for an autonomous stack; "detected and halted" is
  the right one.

## Multi-tenancy (forward-compatible; the deep choice deferred to the white-label thread)

If the product becomes a white-labeled platform (each wedding planner a tenant —
[[white-label-growth-and-agent-strategy-autonomy]]), the floor must partition by tenant. This spec
fixes the *trust-boundary* requirements (in its lane) and defers the *architecture* (not in its lane):

- A feed is **tenant-scoped** (`tenant_id`); one tenant's agents can neither read nor reconfigure
  another tenant's verifying path. **Cross-tenant evidence flow is `INTEGRITY.CROSS_TENANT`** — a
  detectable violation, not merely discouraged.
- **A shared platform feed (`tenant_id: null`) is not influenceable by any single tenant** — it is
  read-only to tenant agents and writable only via the human-reserved Tier-3 config path; otherwise it
  is a cross-tenant capture surface masquerading as shared infrastructure.
- **The platform operator's status is an open question, flagged not decided**: is the operator a human
  (then it is the Tier-3 config owner) or an agent (then it is bound by the same L0 floor and is *not*
  a cross-tenant superuser)? And **whether L0 is fully per-tenant or a shared substrate with
  tenant-partitioned keys** is the architectural choice deferred to the white-label/autonomy thread.
  This spec requires only that, whichever is chosen, cross-tenant evidence flow is detectable.

## Residual: what is *not* defended, and why that is acceptable

Honesty about the limit is part of the design (it is why production evidence is *defended, not
constructed*):

- **A fully-compromised third party** (one that lies in both its event stream *and* its signed
  aggregate, with valid keys) is beyond detection from outside it. Mitigation: corroboration across
  *distinct* trust roots makes this require compromising *several* independent parties at once; a
  single captured source diverges from its corroborators and is caught.
- **Substrate the organization does not own** (a shared cloud network path, a third party's internal
  config plane that offers no separable principal) cannot be fully walled. Mitigation: pin what is
  pinnable, **downgrade** inseparable sources to corroborators-only, and never let one ground a
  high-severity call alone.
- **The bootstrap root** (initial keys/pins) is a human-established trust assumption, not a derived
  fact. This is the one place the regress genuinely stops at a person — by design, once, out of band.

These residuals are deliberately small and named, so a reviewer can see the exact size of the trusted
base rather than discovering it as a surprise.

## How this addresses the eval→prod attacks

| attack | status | mechanism |
|---|---|---|
| point the monitor at a **stale replica** | closed | verifying config Tier-3; substrate (DNS/TLS/egress) in L0 trust domain |
| change the **vendor's own webhook/config** via the acting account | closed | verifying *principal* ≠ acting principal (least-privilege read-only) |
| **silently drop** the complaint webhook | closed | liveness heartbeat: a quiet feed that should heartbeat reads as dark |
| **fresh feed, suppress the one bad event** upstream of sequencing | closed | completeness: signed aggregate reconciliation diverges |
| **fail over to an un-wired region** / declare provision-complete falsely | closed | serve gated on the *source's* signed handshake, not the agent's word |
| **sign `cleared`** as a non-agent decider | closed | L0/L4 keys outside every agent process; `FORGED_CLEAR` |
| **rubber-stamp** a review, label evidence trusted | closed | substantiated reads (`receipt_ref` resolves to a source receipt) |
| degrade **one** feed | closed | ≥2 *verifiably-independent* roots for high-severity; divergence = incident |
| **monitor goes dark**, leaving an unwatched window | closed | recursive liveness: `MONITOR_DARK` halts the guarded action |
| **cross-tenant** read/influence via a shared feed | closed | tenant-scoped feeds; shared feeds tenant-unwritable; `CROSS_TENANT` |
| third party **fully compromised** (stream + aggregate + keys) | **residual** | bounded by distinct-root corroboration; named trust assumption |
| substrate the org **doesn't own**; inseparable third-party principal | **residual** | pin what's pinnable; downgrade to corroborator-only |
| **bootstrap** root of trust | **residual** | human-established ceremony, once, out of band |

## The contract

`schemas/trusted_feed_schema.json` pins the gameable properties: `writable_by_agent: false`,
`verifying_principal_distinct_from_acting: true`, `substrate_in_l0_trust_domain: true`,
`signed_by_source: true`, `fail_mode: "closed"`, the freshness horizon + completeness aggregate,
corroboration (required and `independence_attested` for high-severity sources), `read_receipts_signed:
true`, key custody (`available_to_agent: false`) + signed rotation, the source-signed provisioning
handshake, recursive monitor liveness (`fail_closed_on_monitor_dark: true`), and tenant scope. A feed
that cannot satisfy these is not eligible to ground a decision.

## The property this protects

In eval, "evidence no agent can author" was free — a gift of the sandbox. In production it is *earned*,
and only *partially*: the verifying path, principal, and substrate are walled; liveness and
completeness are signed; the floor's keys live where no agent can reach them; the monitors watch each
other and fail closed to containment, not to a page; and the irreducible residual is a small, named,
human-planted root of trust. This is the strongest the property can be outside a sandbox — evidence
that is *defended, not constructed* — and it is the precondition for the regress argument of
`oversight_loops.md` to hold in the real world rather than only in eval.
