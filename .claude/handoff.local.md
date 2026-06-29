# Handoff

## Where things stand — Phase 33 (account home / overview) is COMPLETE ✅
`.claude/plans/2026-06-28-phase-33-account-home-overview.md` is **complete — Step 0 design review + Steps 1–4
ticked**, on branch **`build/phase-33-account-home-overview`** (off `build/phase-32-planner-billing-activity-log`,
the open review-artifact stack toward `main`; the loop's merge-keeper advances `main` when green). Working tree
clean. `npm run build && npm test && npm run lint` all green (**945 tests**, up from 934 at the start of this run).

This rung gives the product surface a **front door**. Until now the feature-rich views lived as siloed `?view=…`
spokes behind a flat link strip on a bare wedding list. Now the default **`/t/:slug` is an account home / overview**
— an at-a-glance "what needs attention" hub: open guest-question count, weddings/guests counts, and (for a planner)
the owed balance, each a card linking into its view. The wedding list + create form relocated to **`?view=weddings`**;
nav is now hub-and-spoke (`← Home`). doddy+architect APPROVE at BOTH design (APPROVE-WITH-FIXES, all folded) AND
built code (APPROVE — no constructible exploit, all 6 properties verified at file:line). ADR 0033, memory
[[account-home-overview]].

## What changed this phase
- **`pages.ts`** — new `renderHome(theme, slug, overview, csrf)` + `AccountOverview` (`{weddingsCount,
  openQuestionsCount, guestsCount, billing?:{balanceCents,planTier}}`); the planner-only billing card renders iff
  `overview.billing` present. New shared `resolutionIndex` + exported `countOpenEscalations(escalations,
  resolutions)`; `renderEscalations` refactored to use `resolutionIndex` (single-sourced "open" join). Back-links:
  management spokes → `← Home` (`/t/:slug`); wedding detail keeps `← All weddings` → `?view=weddings`;
  `renderConsole` nav gains a `← Home` link.
- **`product_web_ui.ts`** — new `#home(req, slug)`: composes `GET /weddings` + `/escalations` + `/guests` (the GATE,
  any non-200 → `#renderNonData`) then `GET /billing` (status consulted ONLY as `=== 200 ? card : omit`, NEVER fed
  to `#renderNonData`). `#console` fallthrough → `#home`; added `?view=weddings` → `#weddingList`; `#weddingCreate`
  PRG retargets `/t/:slug` → `/t/:slug?view=weddings`. `#weddingList` doc updated.
- **No new schema, no JSON endpoint, no domain code** — a pure web-layer composition (manifest stays 20).
- **Tests** — `pages.test.ts` +7 (renderHome counts/billing-card-present/omitted/highlight/escape, hub-and-spoke
  nav, `countOpenEscalations`); `billing_web.test.ts` +4 home e2e on the FULL compose surface (planner home with
  billing card; couple home 200 + card absent; open-count drops to 0 on resolve; unknown/unauth masking). Retargeted
  several pre-33 web tests to `?view=weddings` (their minimal fixtures omit escalations, so the home masks 404 there).

## The load-bearing insight (carry forward) — see [[account-home-overview]] for the full set
- **The home is a PURE web-layer COMPOSITION of the existing gated reads → no new oracle.** Aggregating counts at
  the edge (not a JSON `/overview` handler) keeps each figure riding its own already-verified gate, preserves
  only-data-path-is-`api.handle`, and discloses strictly the UNION of the four reads. A JSON `/overview` would
  concentrate 4 authz surfaces the narrow-deps convention keeps separate — deliberately deferred.
- **Billing is the ONE conditional read: `status===200 ? card : omit`, its status NEVER fed to `#renderNonData`
  (design-review P1).** A couple's `/billing` 403 keeps the home a 200 with the card ABSENT (affordance, not a
  Forbidden wall, not an oracle). Folding billing into the page gate would turn a planner-only capability into a
  couple-facing wall and make the home's status role-dependent.
- **The page GATE is EXACTLY the 3 dual-role reads (weddings+escalations+guests).** First non-200 masks the whole
  page (the `#guestsPage` no-half-page pattern → byte-identical `GENERIC_404`/themed-login). An unwired optional
  `escalations` 404s → fail-closed whole-page mask (intentional, NOT a half-page). The home e2e must run on the FULL
  compose surface; minimal per-feature fixtures omitting escalations read `?view=weddings` directly.
- **Open-count folds BOTH arrays from the one scoped escalations body via `resolutionIndex`** (the SAME join the
  inbox uses → single-sourced, can't drift; both arrays `manageScope`-scoped → a couple can't leak a sibling
  wedding's escalation).

## Next action — your call. Pick the next high-value lever (ranked)
- **Multi-turn reply thread** — the still-open inbox extension: a per-escalation message log so an operator can send
  follow-ups after the first reply (and a guest reply lands in the thread), decoupling reply from auto-resolve.
  Has TWO genuine design sub-problems: (a) guest-reply→thread correlation (the provider-agnostic port carries only
  opaque refs, no conversation id), and (b) per-message idempotency vs the current deterministic single-charge key
  (`reply:${escalation_id}` is a doddy-reviewed billing safety property — multi-message sends need a new
  double-submit story). Medium-large; scope carefully (the console-side multi-turn is tractable; defer
  guest-reply-inbound correlation). Most-cited open thread.
- **A couple-REGISTER design rung** — resolve the deferred Phase-24 oracle. THE TENSION (confirmed this run by
  reading `guest_registry.ts`): `recipient_ref` is the tenant-GLOBAL inbound-lookup partition key, so per-wedding
  namespacing would BREAK inbound segmentation (a guest texts in with only a from_ref, no wedding), AND a conflict
  can't be masked without a correctness cost. A real design pass on the tenant-global-key collision; not trivial.
- **Unify `product/price_book.ts` onto the shared cost basis** (retail = COGS × margin over `MESSAGE_COST_CENTS`) —
  the clean Phase-20 follow-up; tidies the two-cents-tables seam. Smaller, clean, lower product value.
- **Per-period billing windows / statements** — group the activity into billing periods/invoices (needs a period
  model the ledger doesn't carry yet). Medium; defer until a product reason.
- **Partial / arbitrary-amount payments** — the deferred Phase-31 extension (re-introduces client money input →
  own bounds/no-fraud pass). Defer until a product reason.
- **A JSON `GET /t/:slug/overview` endpoint** — the Phase-33 deferral: only if a non-web consumer (mobile/API
  client) ever needs the aggregate. Not yet warranted.
- **Return-to-the-engine threads** — the self-improvement loop (advisory tier-2 recs, live publish pipeline) has
  open deferrals if you want to swing back from the product surface.

## Standing rails (unchanged — do not weaken)
Offline-first (no real money/booking/comms; no prod/credentials — don't simulate them). **A real messaging provider
sending real texts is the human crossing (guest-comms tier-2 / exception #4) — build up to the line, never across it
or simulate having.** Don't modify `ops/` or `CLAUDE.md` (human-reserved). Push only to this repo's `origin`. The
named specialist sub-agents (doddy/wolf/testineer/rigorous-architect) are **not provisioned** here — route
adversarial reviews through `general-purpose` agents carrying the persona lens (this run did, at BOTH design AND
built-code — APPROVE, no exploit). **CI/exit-code lesson:** never pipe `npm run build`/`npm run lint` to tail/grep
when gating with `&&` (the pipe masks the non-zero exit; `$?` after a pipe is the LAST stage's — use
`${PIPESTATUS[0]}`); run them standalone and check the exit. `npm run build` runs from REPO ROOT. **Eval-harness/
telemetry import ONLY `@wedding-planner/shared`, never `product`** (the firewall, by reachability). **Schema change ⇒
`npm run gen:types`**; a NEW schema file additionally bumps the manifest count test (+ title prose) + the gen-script
header — **Phases 30–33 added NO schema** (render-time projections / an existing kind / a web composition), so the
manifest stays 20. **The guest responder's security boundary is `projectGuestVisibleFacts`'s allow-list.** **Web-form
mutations are CSRF-gated at the web layer ONLY** (the JSON API is Bearer-only / not CSRF-reachable). **The web UI's
ONLY data path is `api.handle()`** (Phase 33's home composes MULTIPLE `api.handle()` reads — still the sole data
path). **Guest/manage/billing scope comes from the MINTED principal/context, never the request body.** **A capability
the role lacks entirely (couple→register, couple→billing incl. pay) is a 403 checked FIRST; a customer-facing
PROJECTION/AGGREGATE of trusted records must disclose nothing the parts don't (Phase 32 financial-only; Phase 33 home
= union-of-gated-reads, billing card omitted-not-masked for couples).** **A coupled validation/price/balance constant
MUST be drift-guarded by a test** (Phase 33 single-sourced "open" join; Phase 32 activity↔summary reconciliation;
Phase 30 `summarize` vs canonical `balanceCents`).
