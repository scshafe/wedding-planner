# ADR 0017 — The engine↔surface seam: the champion strategy reaches the customer

- **Status:** accepted
- **Date:** 2026-06-26
- **Decider:** the building agent (an agent-owned engineering decision per
  [[agents-own-buildout-decisions]] and `.claude/plans/2026-06-26-phase-17-engine-surface-strategy-seam.md`)
- **Scope:** Phase 17 — the first connection between the two halves of the system. For sixteen phases the
  inward-facing self-improvement loop (Phases 1–11, which optimize a `StrategyGenome`) and the customer-facing
  product surface (Phases 12–16) never touched. This phase surfaces the loop's **champion strategy** as
  **read-only, planner-facing guidance** in the product UI (`GET /t/:slug/strategy` + a themed page).
- **Builds on** ADR 0012 (inter-tenant isolation), 0013 (request edge + intra-tenant auth + the 5-stage
  pipeline), 0014 (themed web UI + the disclosure mask), 0015 (operator tier), 0016 (composition root +
  imperative shell), and the firewall's tier derivation (`shared/src/strategy/risk_tier.ts`). It weakens none
  and adds **no parallel safety model**: the surface is a thin read over the already-proven pipeline, and the
  genome's risk tier is **derived** (never declared), exactly as the trusted-evidence firewall requires.

## Context

The product surface served weddings with no link to the engine meant to make them better; the loop optimized a
strategy genome it showed no one. The two were architecturally severed by design — the determinism/replay rail
keeps the eval/loop core importing only `@wedding-planner/shared` and never `product`, and `product` imports
neither `loop-orchestrator` nor `eval-harness` (the dependency graph is acyclic). Connecting them must not
erode that.

The honest framing matters as much as the wiring. The loop optimizes **one** strategy over a reference scenario
corpus; it does **not** score any individual real wedding. So the surface presents the champion as a
**platform-global** default ("the data-optimized planning strategy that tunes this workspace's automated
planning"), identical for every tenant and every role — never a fabricated per-wedding outcome. This is the
offline-first honesty rail made concrete in customer-facing copy.

## Decision

**1. The seam is a one-directional READ of an injected VALUE — the firewall is preserved by reachability.**
The champion is a `@wedding-planner/shared` `StrategyGenome`, which `product` already imports. It enters as
**injected config** at the composition root (`composeProductSurface({ …, championStrategy })`), exactly like the
clock / ids / operator token — `product` imports no loop/eval code, so the acyclic-workspace and
reachability-determinism invariants hold **unchanged**. The committed snapshot lives in `app/published_champion.ts`
(the impure entrypoint layer that names what to inject), not in `product/` (which would imply the surface owns
the champion) and not in `shared/` (which would imply the loop publishes it as a contract — it does not, yet).

**2. The translation core is a pure projection that RE-DERIVES the tier — never trusts a declared one.**
`describeStrategy(genome) → StrategyGuidance` (`product/src/strategy/`) takes ONLY the genome (no context,
principal, or repo in scope — structural purity), `assertValidGenome`s it, derives the authoritative risk tier
via the trusted `deriveRiskTier`, and maps each knob to human copy. The autonomy explanation ("Applied
automatically" at tier ≤ 1 vs "Requires human approval" at tier ≥ 2) is **derived**, mirroring the firewall's
never-relaunder-a-declared-tier rule. The guidance carries ONLY human copy + the derived posture — never
`genome_id`, the raw `parameters`, the content hash, the sensitivity-surface names, or any error code.

**3. The published champion is asserted TIER-1 at the inject boundary, fail-closed.** `assertTier1Champion`
re-derives via `deriveRiskTier(g).tier === 1` (not an `autonomy_threshold`-presence shortcut) and throws on any
non-tier-1 / invalid genome, aborting boot before any socket opens (identical discipline to the operator-token
policy). Only the tier-1 strategy the autonomous loop auto-lands may be published as the active default; a
tier-2+ strategy is human-approval-gated and must never be silently presented as applied. There is exactly ONE
tier-1 assertion site (`app/server.ts`); `ProductApi`'s constructor only *derives* the tier for copy, so the
two can't drift. `describeStrategy` is invoked **eagerly** in the constructor, so an invalid champion throws at
compose → boot aborts, never a partial render at request time.

**4. The endpoint rides the SAME 5-stage pipeline and adds no oracle.** `GET /t/:slug/strategy` runs
tenant-resolve (404 on unknown/suspended/onboarding) → authenticate → bind (cross-tenant veto) **before** the
GET method check, so route shape is not a pre-auth oracle (an unauth `POST` probe → 401, not 405). Any
authenticated in-tenant principal may read it (planner OR couple — it is platform config, not wedding-private
data), so no new `WeddingAuthorizer` decision is introduced. The present/absent (200 vs 404) answer is a **pure
function of the injected champion** — it reads zero tenant/principal state, so it is platform-global (identical
across tenants) and manufactures no existence/lifecycle signal; a missing champion returns the SAME frozen
masked `RESP_NOT_FOUND`. The themed page mirrors `#console` exactly (one `api.handle()`, themed strictly by
status), making no independent existence decision.

**5. No new JSON Schema for the guidance.** `StrategyGuidance` is a render-time projection of an
already-schema-validated genome — never persisted, never crossing a trust boundary. The genome contract
remains the single source of truth. **Revisit trigger:** if a later phase persists the guidance, serves it as a
stable external JSON contract other code consumes, or lets a tenant override the strategy, it crosses a boundary
and needs its own schema.

## Consequences

- The engine's output finally reaches a customer — modest in code, large in meaning. The product surface and
  the self-improvement loop now touch for the first time, without a new dependency edge in either direction.
- The honesty rail is structural: the projection is genome-only (so it cannot interpolate wedding/tenant data),
  it is byte-identical for planner and couple, and the copy states it is a platform default and not a
  per-wedding score.
- **Recorded notes (from the built-code re-reviews; both lenses APPROVE, nothing exploitable):**
  - `composeProductSurface` is a reusable root that accepts an any-tier champion; the tier-1 gate lives only at
    the entrypoint (`app/server.ts`) — by design (one assertion site). The honesty rail still holds if bypassed:
    `describeStrategy` renders a tier-2 genome as "Requires human approval", so it is never *silently*
    auto-applied. A non-`app` caller that wants the gate calls `assertTier1Champion` itself.
  - The `strategy: published` boot-log token is honest because `app/server.ts` injects the champion
    unconditionally (a committed constant, not env-gated). If champion injection ever becomes conditional, the
    token should be threaded from injection state rather than asserted, so the log cannot drift out of truth.

## Recorded deferrals (honest scope edges, not stubs)

- **Per-tenant strategy selection / override** — a real product feature (a planner choosing among published
  strategies) but a genuine new mutation + trust surface; platform-global is the honest first rung.
- **A live publish pipeline** — the loop writing the champion artifact the surface reads; today the snapshot is
  hand-committed with cited provenance (`loop-orchestrator/tests/loop/genome_keystone.test.ts:269`).
- **HTML create/update forms + CSRF** (the Phase-14 deferral) and the **operator web console** remain open next
  levers, unaffected by this phase.
