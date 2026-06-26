---
name: engine-surface-strategy-seam
description: "Phase 17: the FIRST connection between the two halves — the loop's champion StrategyGenome reaches the customer as read-only planner guidance, injected at the composition root (firewall preserved by reachability), platform-global + honest (not a per-wedding score), tier RE-DERIVED never declared"
metadata:
  node_type: memory
  type: project
---

**Phase 17 — the engine↔surface seam.** For sixteen phases the inward-facing self-improvement loop
(Phases 1–11, which optimize a `StrategyGenome`) and the customer-facing product surface (Phases 12–16)
**never touched**. This phase closes that seam: the loop's **champion strategy** becomes **read-only,
planner-facing guidance** in the product UI (`GET /t/:slug/strategy` JSON + a themed HTML page, with
"Planning strategy" links on the console + wedding detail). Modest in code, large in meaning — the engine's
output finally reaches a customer. ADR 0017; plan `.claude/plans/2026-06-26-phase-17-engine-surface-strategy-seam.md`.

**THE CRUX — the firewall is preserved by REACHABILITY, not weakened.** The champion is a
`@wedding-planner/shared` `StrategyGenome` (a type `product` already imports), injected as **config** at the
composition root (`composeProductSurface({ …, championStrategy })`) exactly like the clock/ids/operator token.
`product` imports **neither** `loop-orchestrator` nor `eval-harness`; the loop/eval core imports **neither**
`product` (the graph stays acyclic). The seam is a one-directional READ of an injected VALUE — no new
dependency edge in either direction. The committed snapshot lives in `app/published_champion.ts` (the impure
entrypoint that names what to inject), NOT in `product/` (would imply the surface owns it) or `shared/` (would
imply the loop publishes it as a contract — it does not, yet). Provenance: the tier-1 optimum the loop converges
to on its reference landscape (`loop-orchestrator/tests/loop/genome_keystone.test.ts:269` — cadence 3, spacing
1, batching 1); a **live publish pipeline is deferred** (hand-committed snapshot today).

**HONESTY rail (load-bearing).** The loop optimizes ONE strategy over a reference corpus — it does NOT score
any individual real wedding. So the surface presents the champion as a **platform-global** default ("the
data-optimized planning strategy that tunes this workspace's automated planning"), **identical for every tenant
and every role**, with copy that says it is a platform default and **not a per-wedding score**. `describeStrategy`
is **genome-only** (no context/principal/repo in scope — structural purity), so it physically cannot interpolate
wedding/tenant data, and the page is **byte-identical for planner and couple** (tested).

**TIER RE-DERIVED, never declared (the firewall analogue).** `describeStrategy(genome) → StrategyGuidance`
`assertValidGenome`s then derives the tier via the trusted `deriveRiskTier`; the autonomy copy ("Applied
automatically" tier ≤ 1 vs "Requires human approval" tier ≥ 2) is DERIVED. The published champion is asserted
**tier-1** at the inject boundary (`assertTier1Champion`: `deriveRiskTier(g).tier === 1`, NOT an
`autonomy_threshold`-presence shortcut), **fail-closed** — a non-tier-1/invalid genome throws and ABORTS BOOT
before any socket (operator-token discipline). Only the tier-1 strategy the autonomous loop auto-lands may be
published as the active default. ONE assertion site (`app/server.ts`); `ProductApi`'s constructor only DERIVES
the tier for copy (no drift). The projection is computed EAGERLY + `deepFreeze`d in the constructor, so an
invalid champion throws at compose → boot aborts (never a partial render).

**NO new oracle.** `GET /t/:slug/strategy` rides the SAME 5-stage pipeline: resolve (404 unknown/suspended) →
authenticate → bind (cross-tenant veto) BEFORE the GET method check (an unauth POST probe → 401, not 405 —
route shape is not a pre-auth oracle). Any authed in-tenant principal may read it (no new `WeddingAuthorizer`
decision). The present/absent answer reads ZERO tenant/principal state (platform-global), and a missing champion
returns the SAME frozen masked `RESP_NOT_FOUND` (byte-identical to unknown-tenant — tested). The themed page
mirrors `#console` (one `api.handle()`, themed by status, no independent existence decision). `StrategyGuidance`
leaks NONE of: `genome_id`, raw `parameters`, content hash, surface names, error codes, `tenant_id` (tested on
both the JSON body and the rendered HTML). Boot-log adds only a bare `strategy: published` token (no genome
internals).

**NO new JSON Schema** — the guidance is a render-time projection of an already-schema-validated genome (never
persisted, never crosses a trust boundary); the genome contract stays the source of truth. Revisit only if the
guidance is persisted / served as a stable external contract / made tenant-overridable.

Architect + doddy re-review (design AND built code): both **APPROVE**, nothing exploitable (only P2 folds:
deep-freeze the precomputed guidance; assert the no-champion 404 is byte-identical to the unknown-tenant mask).
617 tests green (up from 585). Live boot verified: themed `/t/demo/strategy` renders, boot log shows
`strategy: published`. Related: [[deployable-image-composition-root]] (the inject point),
[[web-ui-themed-edge]] (the disclosure mask the page inherits), [[customer-facing-product-surface-is-a-first-class-goal]].
