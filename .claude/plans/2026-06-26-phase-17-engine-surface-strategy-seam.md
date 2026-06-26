# Phase 17 — The engine↔surface seam (the champion strategy reaches the customer)

**Status:** in progress
**Branch:** `build/phase-3-generalize-search` (the open review artifact for `main`; Phases 3–16 build on it)
**Predecessor:** Phase 16 (deployable Docker image) — complete, 585 tests green. The product arc (12→16) is done.

## Goal

Build the **first real connection between the two halves of the system**. For sixteen phases the
inward-facing self-improvement loop (Phases 1–11) and the customer-facing product surface (Phases 12–16)
have never touched: the loop optimizes a strategy genome it never shows anyone, and the surface serves
weddings with no link to the engine that is supposed to make them better. This phase closes that seam:
the loop's **champion strategy** becomes **planner-facing guidance** inside the product UI — a read-only
"Planning strategy" surface that shows a planner the data-optimized defaults (the converged champion's
knobs) that tune their workspace's automated planning, with the derived autonomy tier explained.

It is modest in code and large in meaning: the engine output finally reaches a customer.

## The hard rails (unchanged — CLAUDE.md)

Offline-first. No real money/booking/comms. The strategy surface is **read-only** and shows an **injected,
committed artifact** — it triggers nothing. **Honesty rail (load-bearing for this phase):** the champion is a
**platform-global** strategy the loop converges to on its reference scenario corpus — it is **NOT** a claim
that any specific real wedding was scored by the loop. The UI copy says exactly that (offline demo, simulated
comms, platform default). We do **not** fabricate a per-wedding North Star score. Don't modify `ops/` or
`CLAUDE.md`. Push only to `origin`.

## The crux design decisions (to be ratified by the Step-0 reviews)

1. **The seam is a one-directional READ of an injected artifact — the firewall is preserved by reachability.**
   The product surface consumes a champion `StrategyGenome` — a `@wedding-planner/shared` type the product
   workspace already imports — as **injected config**, entering at the composition root exactly like the
   clock / ids / operator token. `@wedding-planner/product` still imports **neither** `loop-orchestrator` nor
   `eval-harness`; the loop/eval core still imports **neither** `product` (verified: the dependency graph is
   acyclic). So the determinism rail and the acyclic-workspace invariant hold **unchanged**. The champion is a
   committed snapshot the loop *publishes*; the surface *consumes* a value, never imports the loop.

2. **Honest framing — the champion is platform-global, not a per-wedding score.** The loop optimizes ONE
   strategy over a reference corpus; the surface presents it as "the data-optimized planning strategy that
   tunes this workspace's automated planning," shown identically for every tenant/wedding. No fabricated
   per-wedding outcome. This is the offline-first honesty rail made concrete in customer-facing copy.

3. **The translation core is pure and RE-DERIVES the risk tier — never trusts a declared one.**
   `describeStrategy(genome) -> StrategyGuidance` (new, `product/src/strategy/`) `assertValidGenome`s the
   genome, derives its authoritative tier via the trusted `deriveRiskTier` (shared), and maps each knob's
   numeric value to planner-facing copy. The autonomy explanation ("applied autonomously" at tier-1 vs
   "requires human approval" at tier-2) is **derived**, mirroring the firewall's never-relaunder-a-declared-tier
   rule. The published champion is asserted **tier-1** at the inject boundary (fail-closed) — the only thing the
   autonomous loop ever auto-lands; a tier-2 strategy must never be silently presented as the active default.

4. **No new oracle — the strategy is served through the SAME 5-stage pipeline, authed but platform-global.**
   `GET /t/:slug/strategy` runs resolve-tenant (404 on unknown/suspended/onboarding) → authenticate → bind
   (cross-tenant veto) before serving, exactly like `/weddings`. Any authenticated principal in the tenant may
   read it (planner OR couple — it is platform config, not wedding-private data), so no new `WeddingAuthorizer`
   decision is introduced. Champion-absent → the masked constant 404 (and champion presence is platform-global,
   identical for every tenant, so it discloses nothing tenant-specific). The HTML page makes **no independent
   existence decision** — one `api.handle()` per page, themed strictly by status, exactly as `#console` does.

5. **No new JSON Schema — the guidance is a render-time projection (view model), not a persisted/cross-trust
   contract.** The genome is already schema-validated (`strategy_genome_schema.json`); `StrategyGuidance` is a
   pure deterministic function of it, never stored and never validated across a trust boundary. Adding a 17th
   schema for a view model would dilute the contracts-as-source-of-truth convention, not serve it. The genome
   contract IS the source of truth; the guidance is derived. (Decision recorded; revisit only if the guidance
   ever crosses a trust boundary or is persisted.)

## Step 0 — Design review (adversarial; both lenses must land before code)

Route two `general-purpose` agents carrying the persona lenses (the named sub-agents are not provisioned here):
- **rigorous-architect lens:** is the seam clean? Does injecting the champion at the composition root preserve
  the reachability-based determinism rail and the acyclic-workspace invariant? Is the platform-global framing
  the right altitude (vs per-wedding / per-tenant override)? Is "no new schema" defensible? Is the route
  placement consistent with the Phase-13/14 pipeline?
- **doddy lens:** does the strategy surface add any oracle (existence/lifecycle/cross-tenant)? Is re-deriving
  the tier (never trusting a declared one) correctly the firewall analogue? Is the tier-1 inject assertion
  fail-closed? Any injection/escaping gap in the new page? Does serving platform-global config to a couple
  principal leak anything?

Fold both into the steps below before ticking.

## Step 0 — Design review OUTCOME (both APPROVE-WITH-CHANGES; folded below)

**rigorous-architect: APPROVE-WITH-CHANGES.** The seam is sound — injecting a *value* (not importing a module)
keeps the graph acyclic and the determinism rail intact; platform-global altitude + the honesty framing are
right; "no new schema for a render-time view model" is defensible. Folds: **(AP0)** the committed champion must
be a FULL genome `{ genome_id: 'published_champion_v1', parameters: { rsvp_reminder_cadence: 3, reminder_spacing:
1, reminder_batching: 1 } }` — the bare parameters payload throws at `assertValidGenome` (boot fails closed on
the happy path). **(AP1)** pin auth-before-absence-404 precedence; a tier-2/invalid champion must ABORT BOOT
(hard throw at inject, like the operator-token policy), never degrade to a 404/500. **(AP1)** ONE tier-1
assertion site (`app/server.ts` inject) — `ProductApi`'s constructor only DERIVES the tier to render copy (it
does not re-assert tier-1), so the two sites can't drift. **(AP2)** record a no-schema "revisit trigger" in ADR
0017 (persist / stable external JSON / tenant override ⇒ needs a schema). **(AP2)** `published_champion.ts` doc
comment states "hand-committed snapshot, NOT a live read; a publish pipeline is deferred"; co-locate a
build-time drift-guard test re-deriving its tier == 1. **(AP2)** boot-log field is a bare token (`strategy=
published`), tested to carry no knob values.

**doddy: APPROVE-WITH-CHANGES.** Masking/firewall invariants preserved; re-deriving the tier (never trusting a
declared one) is the correct firewall analogue. Folds: **(DP1)** `StrategyGuidance` carries ONLY human knob copy
+ the derived tier/autonomy explanation — NEVER `genome_id`, raw `parameters`, the content hash,
`touchedSurfaces`/`perParameter` surface names, or any `PRODUCT.*`/`RISK.*` code; test the rendered page
contains none of a `genome:` hash, a surface name, an error code, or `tenant_id`. **(DP1)** the present/absent
decision reads ZERO `context`/`principal`/tenant state and returns the SAME frozen `RESP_NOT_FOUND` constant
(byte-identical to unknown-tenant) — comment + pin it. **(DP1)** auth-before-method tests: unknown/suspended
tenant → masked 404 regardless of header/method; valid tenant unauthed → 401 for ANY method (a `POST` probe →
401, not 405); cross-tenant session → 401. **(DP1)** the tier-1 inject assertion uses `deriveRiskTier(g).tier
=== 1` (the trusted derivation), never an `autonomy_threshold`-presence shortcut; test invalid → compose
throws, tier-2 → inject throws. **(DP2)** `describeStrategy(genome)` takes ONLY the genome (no context/principal/
repo in scope — structural purity); test planner-rendered and couple-rendered pages are byte-identical.
**(DP2)** web route mirrors `#console` exactly (`normalizeSlugForRoute` first, one `api.handle`, themed by
status, constant `GENERIC_404` fallthrough — no strategy-specific 404 page).

## Steps

- [x] **Step 0 — Design reviews (architect + doddy lenses); folded above.**
- [ ] **Step 1 — The translation core + the published champion artifact.**
  - `product/src/strategy/strategy_guidance.ts`: `StrategyGuidance` interface + pure `describeStrategy(genome)`
    (`assertValidGenome` → `deriveRiskTier` → per-knob human copy + tier/autonomy explanation). Reason-agnostic,
    deterministic, no I/O. Handles the optional `autonomy_threshold` honestly (tier-2 ⇒ "requires human
    approval"). Export from the product barrel.
  - `app/published_champion.ts`: the committed champion snapshot — a FULL genome `{ genome_id:
    'published_champion_v1', parameters: { rsvp_reminder_cadence: 3, reminder_spacing: 1, reminder_batching: 1 } }`
    (the tier-1 optimum the loop converges to on the reference landscape — provenance:
    `loop-orchestrator/tests/loop/genome_keystone.test.ts:269`). Doc comment: "hand-committed snapshot, NOT a
    live read of the loop's champion store; a publish pipeline is deferred." Co-locate a build-time drift-guard
    test re-deriving `deriveRiskTier(publishedChampion).tier === 1` (a hand-edit adding `autonomy_threshold`
    fails CI, not just boot).
  - Tests: `product/tests/strategy/strategy_guidance.test.ts` (per-knob mapping; tier-1 canonical; tier-2 when
    `autonomy_threshold` present; throws on invalid genome). Verify green.
- [ ] **Step 2 — The read-only JSON endpoint through the 5-stage pipeline.**
  - `ProductApiDeps.championStrategy?: StrategyGenome`; `ProductApi` precomputes `#strategyGuidance` in the
    constructor (eager, immutable; an invalid champion throws at compose → boot fails closed).
  - Route `GET /t/:slug/strategy` under the `/t/:slug` branch: `authenticate` (stages 3–4) BEFORE the method
    check (route shape is not a pre-auth oracle), GET-only, returns `{ strategy }` or the masked 404 when no
    champion is published.
  - Tests: 200 authed; 401 unauthed; 404 unknown/suspended tenant; cross-tenant session → 401; non-GET → 405;
    404 when champion absent. Verify green.
- [ ] **Step 3 — The themed web page + honest nav links.**
  - `pages.ts`: `renderStrategy(theme, slug, guidance)` (themed shell; knob guidance + derived-tier explanation;
    explicit platform-default / offline-demo copy). All values via the `html` template.
  - `product_web_ui.ts`: own `GET /t/:slug/strategy` (3-seg, like login/logout) → one `api.handle()`, themed by
    status (200 → page; 401 → login; else masked 404) — mirrors `#console`. Add a "Planning strategy" link on
    the console and a one-line honest "Active strategy" note (linking to the page) on the wedding detail.
  - Tests: 200 themed for authed; login for unauthed; masked 404 for unknown tenant; links present. Verify green.
- [ ] **Step 4 — Wire the entrypoint + compose.**
  - `compose.ts`: `ComposeProductSurfaceConfig.championStrategy?` forwarded to `ProductApiDeps`. `app/server.ts`:
    inject `publishedChampion` (asserted tier-1 before inject, fail-closed like the operator-token policy); add
    one allow-listed boot-log field (e.g. `strategy=published` — NEVER the genome internals beyond the safe
    knob summary). Update `server_config`/boot-log tests as needed.
  - Tests: compose wiring (champion injected → strategy reachable; absent → 404); boot policy (published champion
    is tier-1). Verify green. Run the full build+test+lint; optionally rebuild the image locally to confirm the
    demo serves `/t/demo/strategy`.
- [ ] **Step 5 — Built-code re-review + ADR 0017 + memory + handoff.**
  - Re-run both lenses on the BUILT code (architect + doddy); fold any P2s.
  - `docs/adr/0017-*.md`; `.claude/memory/engine-surface-strategy-seam.md` + MEMORY.md index; update
    `.claude/handoff.local.md`. Commit per verified step throughout.

## Verification gate (every step)

`npm run build && npm test && npm run lint` all green before ticking a box or committing (build standalone —
never piped — then check `$?`; `npm run build` runs from REPO ROOT). Commit per verified step on the branch.

## Recorded deferrals (honest scope edges, not stubs)

- **Per-tenant strategy selection / override** — a real product feature (a planner choosing among published
  strategies) but a genuine new mutation + trust surface; platform-global is the honest first rung.
- **A live publish pipeline** (the loop writing the champion artifact the surface reads) — today the snapshot is
  committed by hand with cited provenance; a publish step is a separate, larger thread.
- **HTML create/update forms + CSRF** (the Phase-14 deferral) and the **operator web console** remain open
  next levers, unaffected by this phase.
