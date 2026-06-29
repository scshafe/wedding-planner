# Phase 33 — Account home / overview (the front door)

## Why (the lever)
The product surface is now feature-rich — weddings CRUD, guest CRUD (planner + couple), the guest-messaging
channel, the escalation inbox (read → resolve/dismiss → reply), billing (read → pay → itemized history), and
strategy guidance. But these live as **siloed views** behind a flat link strip at the bottom of a bare wedding
list (`?view=guests | escalations | billing`, `/strategy`). A planner logging in lands on a list of weddings and
has to go hunting to learn the one thing they actually need: **what needs attention right now** — how many guest
questions are waiting, what they owe. A real white-label ops console needs a **front door** that answers that at a
glance. This is the highest-value *clean* lever: pure read-time composition, no new schema, no new mutation, no new
domain coupling — and it turns the siloed views into a coherent console.

## Scope (one rung)
A new themed **overview** page that becomes the **default `/t/:slug` landing**, aggregating the principal's
already-authorized scoped reads into an at-a-glance hub with deep links into the existing views:

- **Guest questions** needing attention — the count of OPEN escalations (escalations with no resolution), scoped
  (planner: whole tenant; couple: their wedding) → links to `?view=escalations`.
- **Weddings** — the count the principal may see (planner: all; couple: their one) → links to a relocated
  `?view=weddings` (the existing wedding list + create form).
- **Guests** — the count, scoped → links to `?view=guests`.
- **Billing** (planner-only) — owed balance + plan tier → links to `?view=billing`. OMITTED for couples (they lack
  the billing capability; they get the existing 403 on `GET /billing`).
- A link to `/strategy` and the Sign-out form.

The existing wedding **list + create form** (today the default `/t/:slug`) moves to **`?view=weddings`**; the home
becomes the default. No JSON endpoint, no new schema, no new domain code — **pure web-layer composition** of the
existing `api.handle()` reads (the established `#guestsPage` multi-read pattern).

## Design (the load-bearing decisions)

- **A composition of EXISTING gated reads — no new disclosure, no new oracle (the keystone).** Every figure on the
  home is derived from a read the principal is ALREADY authorized for at exactly its existing scope: weddings via
  `GET /weddings`, open-questions via `GET /escalations` (scoped by `manageScope`), guests via `GET /guests`
  (scoped since Phase 24), billing via the planner-only `GET /billing`. The overview therefore discloses **exactly
  the union of those reads and nothing more**. There is NO new endpoint, NO new authorizer, NO new partition read —
  so there is structurally no new oracle to analyze: each figure inherits the no-oracle property of the read it
  rides. This is the dashboard analogue of the Phase-32 "financial-only / strict decomposition" keystone: the
  aggregate must not reveal anything the parts don't.
- **The only planner-only figure (billing) rides the existing 403 — card OMITTED for couples, not masked-with-a-
  value.** `GET /billing` returns 403 for a couple (the `authorizeBillingView` capability denial, Phase 30). The
  home includes the billing card **iff that read returns 200**; a couple's 403 → the card is simply absent. Absence
  is NOT an oracle: a couple already knows it is not a planner, and the absence reveals nothing about any tenant/
  wedding/resource. (Contrast `#billingPage`, which renders a themed *Forbidden* for a direct `?view=billing` hit —
  here billing is one card among many, so omission is the right composition, mirroring how create forms are shown/
  hidden as capability affordances.)
- **Default-landing swap, additive routing.** `#console`'s fallthrough (no `?wedding`, no `?view`) renders the new
  `#home`; the wedding list moves to `?view=weddings`. This is a pure routing change in the web edge — the JSON API
  and every other view are untouched. The wedding-create PRG redirect retargets to `/t/:slug?view=weddings` so a
  successful create returns to the list it was submitted from.
- **Status gated identically to the other multi-read pages (the `#guestsPage` precedent — no half-page).** `#home`
  issues several `api.handle()` reads; the gating reads (weddings, escalations, guests — all mounted in any real
  composition and readable by BOTH roles) must each be 200, else the WHOLE page takes the SAME `#renderNonData`
  masking as every other page (unknown / suspended / unauthenticated all mask identically; no distinguishable
  split, fail-closed). Billing is the ONE intentionally-conditional read (200 → card, anything else → omit).
- **Open-questions = the same join the inbox renders.** "Open" is an escalation with no resolution — exactly the
  `renderEscalations` join (`escalations.filter(e => !resolutionOf.has(e.escalation_id))`). The home reads the same
  scoped `{escalations, resolutions}` body and COUNTS the opens. A small shared helper (`countOpenEscalations`)
  computes it so the count and the inbox can never drift in how they define "open".
- **Issues the per-session CSRF token (the Sign-out form).** Like `#guestsPage`/`#escalationsPage`/`#billingPage`,
  the home carries the logout form, so it issues the CSRF token (a 200 means the session resolved ⇒ its token must
  exist in the same store; absent ⇒ invariant break ⇒ ERROR_500). No new mutation surface beyond the existing
  CSRF-gated logout.
- **All values through the `html` template.** Counts are numbers, the balance via `dollars`, the plan tier as
  escaped text, deep-links built from the validated slug. No untrusted free text enters the home (every figure is
  server-derived), but everything is escaped regardless. No new injection context.
- **Navigation is now hub-and-spoke.** The home is the hub; the spoke pages' "← All weddings" back-link (which
  pointed at `/t/:slug`, now the home) is relabeled "← Home", and a "View weddings →" link is added where the old
  default lived. The home itself carries the spoke links (questions/weddings/guests/billing/strategy).

## Steps

- [x] **Step 0 — Adversarial design review.** Routed through a `general-purpose` agent carrying the doddy
  (security / no-oracle) + rigorous-architect (design) lens (the named specialists are not provisioned here).
  Verdict **APPROVE-WITH-FIXES, no constructible exploit** — confirmed: the overview is a strict union of the
  existing per-view gated reads (a couple's scoped reads return only their wedding's rows; a phantom/foreign
  couple `wedding_id` yields 200+empty everywhere, never a 404/403 through the counts — so the counts leak
  nothing); the billing-card omission is a capability affordance, not an existence oracle (mirrors the
  create-form-as-affordance precedent); the default-landing swap + create-redirect retarget breaks no invariant
  (only-data-path-is-`api.handle` holds, CSRF seam untouched, `Location` built from the validated slug); and the
  web-layer-composition choice is the RIGHT call (a JSON `/overview` endpoint would concentrate four authz
  surfaces the narrow-deps convention deliberately separates). Folded fixes:
  - **P1 — `/billing` must NEVER enter the page gate; consulted ONLY as `status === 200 ? card : omit`, never fed
    to `#renderNonData`.** Billing 403s for a couple (403 is non-200); if it were ever folded into the gate, every
    couple's WHOLE home would become a themed Forbidden (a planner-only capability turned into a couple-facing
    wall, and the home's status made role-dependent). Pin this as load-bearing in Steps 1–2 AND add an e2e
    asserting a couple's home is **200** (the billing card simply absent), not 403.
  - **P2 — the gate is EXACTLY the three dual-role reads (weddings, escalations, guests).** `escalations` is an
    OPTIONAL subresource; when unwired it 404s for a valid tenant → the gate masks the WHOLE home to GENERIC_404.
    That is INTENTIONAL fail-closed / disclosure-equivalent (byte-identical to unknown-tenant), NOT a half-page —
    pin it so no one "fixes" it into a partial render. The e2e must use the real compose surface (which always
    wires escalations), not a hand-built fixture omitting it.
  - **P2 — the open-questions count folds BOTH arrays from the one `/escalations` 200 body.** An escalation WITH a
    resolution is *handled*; counting `escalations.length` alone over-counts. `#home` passes
    `countOpenEscalations(readEscalations(body), readResolutions(body))` (both from the SAME body, the inbox's
    single-read pattern); the e2e asserts the count drops to 0 after the escalation is resolved (exercising the
    resolutions array).

- [ ] **Step 1 — `renderHome` + the open-escalations count helper (pure render).**
  - In `pages.ts`, add `countOpenEscalations(escalations, resolutions)` (the same `escalation_id` join
    `renderEscalations` uses, exported so both reference ONE definition of "open") and `renderHome(theme, slug,
    overview, csrfToken)` where `overview = { weddingsCount, openQuestionsCount, guestsCount, billing? }` and
    `billing = { balanceCents, planTier }`. The page is the themed shell with: a "Guest questions" card
    (highlighted when `openQuestionsCount > 0`, "N need attention"), a "Weddings" card, a "Guests" card, the
    planner-only "Billing" card (rendered iff `overview.billing` present, `dollars(balanceCents)` + plan), a
    strategy link, and the Sign-out form (carries `csrfField`). Every value through `html`.
  - Refactor `renderEscalations` to use the new shared `countOpenEscalations`/the open/handled split helper so the
    "open" definition is single-sourced (no behavior change; pin with the existing escalation page tests).
  - Tests (`product/tests/web/pages.test.ts`): `renderHome` shows each count + the billing card when present;
    OMITS the billing card when `overview.billing` is absent (couple); the "N need attention" highlight appears iff
    `openQuestionsCount > 0`; deep-links point at `?view=escalations|weddings|guests|billing`; a hostile plan-tier
    string is escaped (defense-in-depth). `countOpenEscalations` counts only unresolved escalations.
  - Verify: `npm run build && npm test && npm run lint`. Commit.

- [ ] **Step 2 — `#home` + routing swap in the web UI.**
  - `product_web_ui.ts`: add `#home(req, slug)` — read `GET /weddings`, `GET /escalations`, `GET /guests`; the
    GATE is EXACTLY these three dual-role reads (any non-200 → `#renderNonData`, the `#guestsPage` pattern; an
    unwired-escalations 404 masks the whole page → GENERIC_404, intentional fail-closed). Read `GET /billing`
    LAST and consult its status ONLY as `=== 200 ? card-data : omit` — **billing's status NEVER flows into
    `#renderNonData`** (P1: a couple's 403 must leave the home a 200 with the card absent, never a Forbidden
    wall). The open-questions count folds BOTH arrays from the one escalations 200 body:
    `countOpenEscalations(readEscalations(escRes.body), readResolutions(escRes.body))` (P2). Resolve theme +
    issue CSRF (200 ⇒ both must exist; theme absent → GENERIC_404, csrf absent → ERROR_500). Render `renderHome`.
  - Routing: `#console`'s fallthrough → `#home`; add `?view=weddings` → `#weddingList`. Update the wedding-create
    PRG redirect (`#weddingCreate`) success target `/t/:slug` → `/t/:slug?view=weddings`.
  - Add tolerant body readers as needed (reuse `readWeddings`/`readEscalations`/`readResolutions`/`readGuests`/
    `readBilling`). The billing card reads `balance_cents` + `plan_tier` from the summary (already in
    `BillingSummary`).
  - Tests (`product/tests/web/*` — extend the e2e suite, using the REAL compose surface so escalations is wired):
    a planner GET `/t/:slug` shows the overview with the weddings/guests/open-questions counts AND the billing
    card; a **couple GET `/t/:slug` returns 200** (not 403) with the overview scoped to their wedding and the
    billing card ABSENT (P1); the open-questions count reflects an unresolved escalation and **drops to 0 once
    resolved** (P2, exercising the resolutions array); unknown/suspended/unauthenticated `/t/:slug` all mask
    identically (the gate); `?view=weddings` serves the wedding list + create form; create still PRG-redirects
    (now to `?view=weddings`) and the new wedding appears.
  - Verify; commit.

- [ ] **Step 3 — Navigation polish (hub-and-spoke).**
  - Relabel the spoke pages' `← All weddings` back-link to `← Home` (it already points at `/t/:slug`, now the
    home). Update `renderConsole`'s nav strip to add `← Home` and drop the redundant self-link; add a `View
    weddings →` entry to the home's spoke links (already in `renderHome` from Step 1).
  - Tests: pin that each spoke page links back to the home and that the home links to all spokes.
  - Verify; commit.

- [x] **Step 4 — ADR 0033 + memory + handoff + built-code review.** Wrote `docs/adr/0033-account-home-overview.md`
  (the decisions above), added `.claude/memory/account-home-overview.md` (+ index line in `MEMORY.md`, linking
  `[[planner-billing-view]]`, `[[guest-escalation-inbox]]`, `[[web-ui-themed-edge]]`,
  `[[html-wedding-create-edit-forms]]`, `[[planner-billing-activity-log]]`), and updated `.claude/handoff.local.md`.
  A **built-code** adversarial review (general-purpose, doddy lens) of the committed home path returned
  **APPROVE — no constructible exploit**, all 6 properties verified at file:line (no P1/P2): the billing-omit-not-mask
  is structurally enforced at a single `=== 200` site; the three-read gate fails closed and disclosure-equivalently;
  the open-count cannot leak a sibling wedding (both arrays `manageScope`-scoped); plan_tier is escaped trusted text.

## Out of scope (deferred, name them)
- **A JSON `GET /t/:slug/overview` projection endpoint.** Deliberately none — the overview is a web-layer
  composition of existing reads (keeps the only-data-path-is-`api.handle` invariant and adds no cross-subsystem
  handler coupling). Add a contract-first overview endpoint only if a non-web consumer (a mobile app, an API
  client) ever needs the aggregate.
- **Per-wedding overview for the planner.** The planner's home aggregates the whole tenant; a "drill into one
  wedding's status" view is the existing `?wedding=ID` detail page. A richer per-wedding dashboard is a later rung.
- **Trend / time-series figures** (questions-this-week, spend-over-time). The home is a point-in-time snapshot;
  trends need a period model the stores don't carry (same deferral as Phase-32 per-period statements).
- **Configurable / dismissable cards.** The card set is fixed. Personalization is post-launch polish.
- **Real-time / push updates.** The home is server-rendered per request (no client JS, the standing constraint);
  counts refresh on reload.
