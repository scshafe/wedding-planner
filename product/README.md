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

## The intra-tenant boundary (Phase 13) — planner vs couple

The Phase-12 boundary above is **inter-tenant**. Phase 13 stacks the **intra-tenant** boundary on top:
within one tenant, a `Principal` is either a `planner` (the tenant's staff — sees the whole tenant) or
a `couple` (bound to exactly one wedding — sees only their own). The request edge is a pure handler
(`ProductApi.handle: ApiRequest -> ApiResponse`) over a 5-stage pipeline — parse → resolve tenant (the
sole per-request `TenantContext` mint) → authenticate → **bind** the session to the resolved tenant
(`principal.tenant_id === context.tenant_id`, else `401` — a session for A presented on B's route is
rejected, never re-scoped) → authorize + dispatch — plus a thin Node `http` adapter
(`createProductApiServer`, the only socket-touching code). It mirrors Phase 12's discipline:

- **The `SessionStore` is the sole mint of a `Principal`** (← the resolver is the sole mint of a
  context), and the `Principal` is **branded + frozen** the same WeakSet way — a forged principal is
  rejected at the authorizer's entry (`PRODUCT.FORGED_PRINCIPAL`).
- **No intra-tenant existence oracle.** A couple addressing a wedding that is not theirs gets a `404`
  **byte-identical** to a missing one — ownership is decided structurally from the principal's bound
  `wedding_id`, *before* any repository lookup, so "exists but not yours" and "doesn't exist" are one
  path. A capability the role lacks entirely (a couple creating a wedding) is `403`.
- **Login is a labeled simulation, oracle-free.** It requires only a usable tenant; it does not verify
  a real credential and does not confirm the couple's `wedding_id` (that would be an oracle).

## Status

**Phase 12 — the multi-tenant domain core:** the `tenant` + `wedding` aggregates, the white-label
`theme`, and the tenant-isolation boundary above. **Phase 13 — the HTTP request edge + simulated
auth/session:** the 5-stage pipeline, the `Principal`/`SessionStore`/`WeddingAuthorizer` intra-tenant
boundary, and the Node `http` adapter, proven by an HTTP keystone. Pure in-memory + injected clock/ids,
offline; login/session simulated.

**Later phases (the arc):** Phase 14 — the web UI (planner console + couple view, themed per tenant);
Phase 15 — onboarding + billing simulation; Phase 16 — Docker packaging → the launch-ready image.

**Deferred (recorded, not faked):** field-level couple write policy (a couple may not `cancel`); real
credential verification, cryptographic tokens, and persistence beyond in-memory are hardening for when
going-live is on the table (human-reserved).
