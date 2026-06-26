# Product (the customer-facing surface)

The fifth domain — and the only **outward-facing** one. The four domains before it (`eval-harness/`,
`telemetry/`, `loop-orchestrator/`, `agent-operations/`) are the **engine**: how the system scores,
measures, improves, and operates *itself*. This domain is the **car**: a **white-label, multi-tenant**
web app that real wedding planners — and their couples — sign up for, theme, and use.

It is built **offline-first, as a deployable Docker container** (locally runnable, demoable,
launch-*ready*; onboarding, billing, and comms are offline simulations). **Going live stays
human-reserved** — real hosting, registry push, DNS, secrets, real tenants/payments/comms are the
human crossing (operations exception #4). Producing the image is in-scope; running it for real is not.

## The throughline: one safety model, a new surface

Multi-tenancy's load-bearing invariant is **tenant isolation** — a request carrying tenant A's
identity can never read, list, or write tenant B's data. That is the multi-tenancy analogue of the
trusted-evidence firewall (`../agent-operations/trusted_evidence_channel.md`): **wall the channel,
fail closed, no existence oracle**. It is enforced *structurally* (by construction), not by
convention:

- **The resolver is the sole mint of a `TenantContext`.** A `TenantContext` is an *unforgeable*,
  branded, frozen token. A hand-built `{ tenant_id }` object is rejected at the repository entry
  (`PRODUCT.FORGED_CONTEXT`) — "the resolver is the only mint" is a compile-time *and* runtime
  guarantee, not a code-review convention.
- **The partition key comes only from the context.** Every read/list/write is physically partitioned
  by `ctx.tenant_id`; a record's own `tenant_id` is only ever *compared* (to veto a cross-tenant
  write), never used to route.
- **No existence oracle.** A foreign-tenant id reads back the byte-identical not-found result as a
  never-existed id, via the same code path — a caller cannot distinguish "exists but not yours" from
  "doesn't exist."
- **Liveness is re-asserted at use.** A context minted while a tenant was active stops working the
  instant the tenant is suspended — liveness is checked on every operation and fails closed.

## Status

**Phase 12 — the multi-tenant domain core** (this phase): the `tenant` + `wedding` aggregates, the
white-label `theme`, and the tenant-isolation boundary above, proven by an adversarial keystone. Pure
in-memory domain + injected clock/ids, offline. No HTTP, no UI, no auth principals yet.

**Later phases (the arc):** Phase 13 — the HTTP API + simulated auth/session (tenant resolved from the
request); Phase 14 — the web UI (planner console + couple view, themed per tenant); Phase 15 —
onboarding + billing simulation; Phase 16 — Docker packaging → the launch-ready image.

Scope of the Phase-12 proof: **inter-tenant** isolation only. *Intra-tenant* authorization (planner
vs couple) is a distinct, finer-grained boundary that lands with principals in Phase 13.
