# Handoff

## Where things stand — Phase 17 (the engine↔surface seam) is COMPLETE ✅
`.claude/plans/2026-06-26-phase-17-engine-surface-strategy-seam.md` is **complete — all 6 steps ticked** (Step 0
design reviews + Steps 1–5), on branch **`build/phase-3-generalize-search`** (the open review artifact for
`main`; Phases 3–17 build on it; the loop's merge-keeper advances `main` when green). Working tree clean.
`npm run build && npm test && npm run lint` all green (**617 tests**, up from 585 at the start of this run).
`main` has Phase 1+2; this branch is the review artifact for Phases 3–17.

**For sixteen phases the two halves of the system never touched** — the inward-facing self-improvement loop
(Phases 1–11, which optimize a `StrategyGenome`) and the customer-facing product surface (Phases 12–16). Phase
17 closes that seam: the loop's **champion strategy** now reaches the customer as **read-only, planner-facing
guidance** (`GET /t/:slug/strategy` JSON + a themed page, with "Planning strategy" links on the console + wedding
detail). Modest in code, large in meaning. ADR 0017, memory [[engine-surface-strategy-seam]].

## What changed this phase — the champion strategy, surfaced honestly
- **`product/src/strategy/strategy_guidance.ts`** — the pure `describeStrategy(genome) → StrategyGuidance`
  projection (genome-only; re-derives the tier via the trusted `deriveRiskTier`; carries only human copy).
- **`app/published_champion.ts`** — the hand-committed champion snapshot (cadence 3, spacing 1, batching 1;
  provenance `loop-orchestrator/tests/loop/genome_keystone.test.ts:269`) + `assertTier1Champion` (fail-closed).
- **`product/src/http/product_api.ts`** — `championStrategy?` dep + eager `deepFreeze`d precompute + the
  `GET /t/:slug/strategy` route (auth before method; present/absent reads zero tenant state; masked 404).
- **`product/src/web/{pages,product_web_ui}.ts`** — `renderStrategy` + the `#strategy` route (mirrors
  `#console`) + the two honest nav links.
- **`product/src/runtime/compose.ts` + `app/server.ts`** — forward + inject the champion; boot aborts on a
  non-tier-1/invalid genome; `buildBootLog` adds a bare `strategy: published` token.

## The load-bearing insights (carry forward)
- **The firewall is preserved by REACHABILITY, not weakened.** The champion is a `@wedding-planner/shared`
  VALUE injected at the composition root (like the clock/ids/operator token). `product` imports NEITHER
  `loop-orchestrator` NOR `eval-harness`; the loop/eval core imports NEITHER `product` (graph stays acyclic).
  The seam is a one-directional READ — no new dependency edge in either direction. Keep it that way: do not make
  `product` import the loop; if a future "live publish pipeline" is built, the loop WRITES an artifact the
  surface reads, still no import.
- **HONEST: platform-global, not a per-wedding score.** The loop optimizes ONE strategy over a reference corpus;
  it scores no individual real wedding. The surface says so in copy and is byte-identical for planner & couple
  (`describeStrategy` is genome-only → cannot interpolate wedding/tenant data). Do NOT fake a per-wedding North
  Star or move real weddings into the loop's scored corpus.
- **Tier RE-DERIVED, never declared; published champion asserted TIER-1 fail-closed.** Only the tier-1 strategy
  the autonomous loop auto-lands may be published as the active default; a tier-2+ strategy is human-approval-
  gated. ONE assertion site (`app/server.ts`); the projection only derives copy. An invalid/tier-2 champion
  ABORTS BOOT (operator-token discipline).
- **No new oracle, no new schema.** The endpoint rides the SAME 5-stage pipeline (auth before method;
  platform-global present/absent; same frozen masked 404 as unknown-tenant). The guidance is a render-time
  projection of an already-schema-validated genome — no 17th schema (revisit only if persisted / external
  contract / tenant-overridable).

## Verification done this phase (real, not faked)
Built + 617 tests + lint all green at every step. **Live boot verified** (not Docker — `npx tsx app/server.ts`
with an env operator token): boot log shows `strategy: published`, themed `/t/demo/strategy` renders the
headline + "Applied automatically" + the honesty disclaimer for a logged-in planner, unauth → themed login (no
content leak). Architect + doddy re-review at design AND on the built code: **both APPROVE**, nothing
exploitable (folded 2 P2s: deep-freeze the precomputed guidance; assert the no-champion 404 is byte-identical to
the unknown-tenant mask).

## Next action — your call. Pick the next high-value lever (ranked)
- **★ STRATEGIC (human-set 2026-06-26, on the horizon — your timing) — a guest-facing messaging channel.**
  Wedding guests text the AI (SMS/WhatsApp/…) for info/updates/Q&A. Already modeled & scored inward
  (`guest.question.asked`→`answered` + `qa_accuracy`; sms/whatsapp/phone are first-class `channel` values);
  MISSING = the product channel (guests aren't a product persona — only planner|couple) + the provider
  boundary. **Two NON-NEGOTIABLE human-set design constraints:** (1) **pricing is first-class** — messaging
  is metered, so add usage-metered pricing (extend the flat-monthly `product/src/billing/price_book.ts` +
  the Phase-15 ledger) AND wire per-message cost into the North-Star denominator so cadence/spacing/batching
  trade real money; (2) **no vendor lock-in** — a provider-agnostic messaging port (send/inbound/
  delivery-status/cost-report) with swappable, offline-**simulated** adapters, no carrier concepts in the
  domain. Build offline & demoable; a real provider sending real texts is the human-reserved crossing
  (guest-comms tier-2). Guest = a new UNTRUSTED persona → ride the existing comms gates + no-oracle/edge
  discipline; verify with doddy. Memory: [[guest-messaging-channel-is-a-roadmap-goal]]. (The forms+CSRF lever
  below is foundational plumbing this channel also needs — your call whether to do it first or fold together.)
- **★ Enrich the surface's first MUTATION trust surface — HTML create/update forms + CSRF.** The standing
  Phase-14 deferral and the natural next rung: today the web UI is read-only (login/logout aside). HTML
  create/update wedding forms need CSRF tokens — the first real mutation trust surface in the UI (a genuine
  doddy-shaped boundary). Foundational product plumbing.
- **The operator web console** — HTML over the Phase-15 `/admin` JSON (today JSON-only): provision / activate /
  suspend / billing views behind the operator credential. Same CSRF/forms surface as the above; pairs naturally.
- **Deepen the engine↔surface seam (now that it exists):** (a) per-tenant strategy *selection* — let a planner
  choose among published strategies (a real new mutation + trust surface; recorded deferral); (b) a **live
  publish pipeline** — the loop writes the champion artifact the surface reads (replaces the hand-snapshot;
  larger thread, keeps the no-import rule).
- **Earlier offline-loop levers (still open, all incremental):** enrich the advisory corpus; a 4th tier-1 knob
  → 4-D search (needs a meaningful forge-free knob, else busywork); `comms_quality`/`intuitiveness` rubrics
  (judge-shaped → STOP-and-surface, ADR 0007 — do NOT build a stub). See git history.
- **A tsc-emit slim runtime** (recorded Phase-16 deferral) — lower value; only matters near going-live.

## Standing rails (unchanged — do not weaken)
Offline-first (no real money/booking/comms; no prod/credentials — don't simulate them). **Building the image
is in-scope; running it for real — registry push, hosting, DNS, secrets, real tenants/payments/comms — is the
human crossing (exception #4). Build up to the line; never cross it or simulate having crossed it.** Don't
modify `ops/` or `CLAUDE.md` (human-reserved). Push only to this repo's `origin`. The named specialist
sub-agents (doddy/wolf/testineer/rigorous-architect) are **not provisioned** here — route adversarial reviews
through `general-purpose` agents carrying the persona lens (this run did, at design AND on the built code —
both APPROVE). **CI/exit-code lesson (still true):** never pipe `npm run build` to tail/grep when gating with
`&&` (the pipe masks the non-zero exit); run build standalone, check `$?`. `npm run build` runs from REPO ROOT.
