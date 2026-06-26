---
name: multi-tenant-isolation-boundary
description: "Phase 12 — the customer-facing product surface's fifth domain; tenant isolation enforced by construction (WeakSet-branded TenantContext, context-only partition key, no existence oracle, liveness at use) — the multi-tenancy analogue of the trusted-evidence firewall"
metadata:
  node_type: memory
  type: project
---

**Phase 12 opened the customer-facing product surface arc** ([[customer-facing-product-surface-is-a-first-class-goal]]):
the fifth domain `@wedding-planner/product` — the only outward-facing one. It is built offline-first,
toward a Docker-packaged, launch-ready white-label multi-tenant web app (HTTP→13, UI→14,
onboarding/billing sim→15, Docker→16). Phase 12 is the **domain core**: the `tenant` + `wedding`
aggregates (JSON Schema contracts 14 & 15; the manifest is now 15), the white-label `theme` (nested
value object), and the **tenant-isolation boundary**. ADR 0012. Pure in-memory + injected clock/ids.

**The load-bearing property — a `TenantContext` for tenant A can NEVER read/list/write tenant B's
data — is enforced by CONSTRUCTION, not convention.** It is the multi-tenancy analogue of the
trusted-evidence firewall ([[prod-trusted-evidence-channel]]): wall the channel, fail closed, no
oracle. The mechanisms (each pinned by `tenant_isolation_keystone.test.ts`):

- **Unforgeable context (the central, twice-found point).** `TenantContext` is branded by a
  module-private **WeakSet identity token** (`MINTED_CONTEXTS`), NOT a symbol property. The resolver
  (`resolveBySlug` — slug is the transport-survivable routing primitive) is the sole adder; the
  context is `Object.freeze`d; a compile-time `declare`d phantom `unique symbol` gives nominal typing.
  **Why WeakSet, not a symbol brand:** a `unique symbol` own property is reflectable via
  `Object.getOwnPropertySymbols` and copyable onto a forged object (the *re-stamp* attack — doddy
  found the built symbol-brand version was forgeable end-to-end). WeakSet membership lives OUTSIDE the
  object and is identity-based, so there is nothing to lift. `assertMintedContext` runs at every repo
  entry (BEFORE the liveness check, so a forged context can't drive a liveness lookup).
- **Partition key is `ctx.tenant_id` ONLY.** The record's own `tenant_id` is compare-only (vetoes a
  cross-tenant write, `PRODUCT.CROSS_TENANT_WRITE`); it never routes the partition. The lookup key is
  `(tenant_id, id)` — `id` alone is NEVER a key, so two tenants may share a `wedding_id` with zero
  collision. (Corrected a false early "ids are tenant-namespaced" claim — `SequentialIdGenerator` has
  a global per-prefix counter.)
- **No existence oracle.** `read` returns `T | undefined`; foreign-id and missing-id return the
  byte-identical `undefined` via one code path, no side effect.
- **Liveness at use, fail closed.** Every op re-checks `TenantStore.isUsable`; a context held past a
  suspension stops working. Usability derives from ONE constant `USABLE_LIFECYCLE_STATUSES = ['active']`
  (the resolver and the repo guard share it). A context is a short-lived single-request snapshot with
  no cached authority.
- **Global slug uniqueness on the normalized (lowercased) form**; `#`-private backing maps (no
  reflection/serialization leak); no unscoped accessor.

**Scope of the proof:** INTER-tenant isolation only. *Intra-tenant* authorization (planner vs couple)
is a distinct, finer-grained boundary landing with principals in Phase 13. **Bounded residual:** the
slug index is a deliberate global existence oracle (non-secret routing metadata; `resolveSlug` returns
routing-only data, never wedding payload).

**Process note that paid off:** the design review (architect + doddy) AND the built-code re-review
both flagged the same central risk (structural-TS forgeability of the context). The design fix
(symbol brand) was itself insufficient; only the built-code re-review's re-stamp trace forced the
WeakSet. Review the BUILT artifact, not just the design — the persona lenses run through
`general-purpose` agents here (the named sub-agents aren't provisioned).
