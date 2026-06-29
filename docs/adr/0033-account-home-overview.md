# ADR 0033 — Account home / overview (the front door)

- **Status:** accepted
- **Date:** 2026-06-28
- **Decider:** the building agent (an agent-owned engineering decision per
  [[agents-own-buildout-decisions]] and `.claude/plans/2026-06-28-phase-33-account-home-overview.md`)
- **Scope:** Phase 33 — give the product surface a **front door**. The feature-rich views built so far (weddings
  CRUD, guest CRUD, the guest-messaging channel, the escalation inbox, billing read/pay/history, strategy) lived
  as **siloed `?view=…` spokes** behind a flat link strip on a bare wedding list. This rung makes the default
  `/t/:slug` an **account home / overview**: an at-a-glance "what needs attention" hub — open guest questions,
  weddings/guests counts, and (for a planner) the owed balance — each a card linking into the matching view. The
  wedding list + create form relocates to `?view=weddings`.
- **Builds on** the themed web edge ([[web-ui-themed-edge]], ADR 0014), the intra-tenant auth pipeline
  ([[http-edge-and-intra-tenant-auth]], ADR 0013), the escalation inbox ([[guest-escalation-inbox]], ADR 0026),
  the planner billing view ([[planner-billing-view]], ADR 0030), and couple-scoped management
  ([[couple-scoped-guest-management]], ADR 0024). It is a **pure web-layer composition** — no JSON endpoint, no new
  schema, no new domain code (manifest stays 20).

## Context

The product had no coherent landing: a planner logging in saw a list of weddings and had to hunt across spokes to
learn the one thing that matters — how many guest questions are waiting, what they owe. A real white-label ops
console needs a hub. This was the highest-value *clean* lever available: every figure the home needs is already
exposed by an existing, individually-gated read, so the home is a composition, not a new disclosure surface.

An adversarial **design** review ran first (a `general-purpose` agent carrying the doddy + rigorous-architect lens
— the named specialists are not provisioned here): verdict **APPROVE-WITH-FIXES, no exploit**. A **built-code**
review of the committed home path followed: **APPROVE — no constructible exploit**, all six claimed properties
verified at file:line. 945 tests green (was 934 at phase start).

## Decisions

### 1. A web-layer composition of existing gated reads — NOT a new JSON `/overview` endpoint

The home (`#home` in `product_web_ui.ts`) issues the existing `api.handle()` reads — `GET /weddings`,
`/escalations`, `/guests`, `/billing` — and aggregates COUNTS at the edge. We deliberately did **not** add a JSON
`GET /t/:slug/overview` projection. A single aggregate endpoint would have to re-derive every per-read scope
decision (`listScope` / `manageScope` / `authorizeBillingView`) in one handler, concentrating four authz surfaces
that the narrow-deps convention keeps cleanly separated and adding cross-subsystem handler coupling. Composing at
the web edge keeps each figure riding its own already-verified gate — and preserves the load-bearing
**only-data-path-is-`api.handle`** invariant ([[web-ui-themed-edge]]). The home discloses strictly the union of
those four reads and nothing more; there is structurally no new oracle to analyze. (A contract-first overview
endpoint is a documented deferral, warranted only if a non-web consumer ever needs the aggregate.)

### 2. Billing is the ONE conditional read — `status === 200 ? card : omit`, NEVER fed to `#renderNonData` (the keystone)

`GET /billing` is planner-only: a couple gets a 403 (the `authorizeBillingView` capability denial, ADR 0030). The
home reads billing **last** and consults its status at exactly one site —
`const summary = billingRes.status === 200 ? readBilling(billingRes.body) : undefined` — and that status **never**
flows into `#renderNonData`. So a couple's 403 leaves the home a **200 with the billing card simply absent** (the
`...(summary === undefined ? {} : { billing })` spread omits it), an affordance — never a Forbidden wall.

This is the load-bearing fix from the design review (P1): if billing were ever folded into the page gate, every
couple's whole home would become a themed Forbidden, turning a planner-only capability into a couple-facing wall
and making the home's status role-dependent. The omission is not an oracle — a couple already knows it is not a
planner, and the absence reveals nothing about any tenant/wedding/resource (mirrors the create-form-as-affordance
precedent, ADR 0023/0024).

### 3. The page gate is EXACTLY the three dual-role reads — fail-closed, disclosure-equivalent

`weddings` + `escalations` + `guests` are all mounted in any real composition and readable by BOTH roles (couples
scoped to their wedding since Phases 24/26). The gate requires each to be 200; the first non-200 masks the WHOLE
page via `#renderNonData` (the established `#guestsPage` no-half-page pattern). Unknown / suspended / onboarding /
unauthenticated tenants all collapse to the JSON layer's masked outcome → the theme-independent frozen
`GENERIC_404` (or the themed login on 401) — byte-identical, no lifecycle oracle. An unwired `escalations`
subresource (it is `optional` in `ApiDeps`) 404s for a valid tenant and masks the whole home to `GENERIC_404`:
that is **intentional fail-closed**, NOT a partial render — pinned so no one "fixes" it into a half-page. (The
e2e for the home runs on the full compose surface, which always wires escalations; per-feature test fixtures that
omit it read the `?view=weddings` list page directly.)

### 4. The open-questions count folds BOTH arrays from the one scoped escalations body — single-sourced "open"

"Open" = an escalation with no resolution. `#home` passes
`countOpenEscalations(readEscalations(escRes.body), readResolutions(escRes.body))` — both arrays from the SAME
scoped `/escalations` 200 body (`handleEscalationList` scopes escalations AND resolutions through the same
`manageScope` branch, so for a couple both are filtered to their wedding by `principal.wedding_id`, never the
body). Counting `escalations.length` alone would over-count handled ones. The join lives in ONE place
(`resolutionIndex` in `pages.ts`), reused by both the home count and the inbox's Open/Handled split, so the two
definitions of "open" can never drift.

### 5. Default-landing swap, additive routing, retargeted create PRG

`#console`'s fallthrough (no `?wedding`, no `?view`) now renders `#home`; the wedding list moves to
`?view=weddings`. This is a pure web-edge routing change — the JSON API and every other view are untouched, the
CSRF seam is intact, slug validation is unchanged, and the masked-404 path is unchanged. `#weddingCreate`'s
success PRG retargets to `/t/:slug?view=weddings` (built from the validated slug) so a successful create returns to
the list it was submitted from. Navigation is now hub-and-spoke: the management spokes' back-link reads `← Home`
(→ `/t/:slug`); the wedding detail keeps `← All weddings` but points at `?view=weddings` (it is a sub-page of the
list); the home carries the spoke links.

## Consequences

- The product has a coherent front door; the siloed views become a console. A planner sees "N guest questions need
  attention" + the owed balance the moment they land.
- The home is a faithful pure composition disclosing **≤ the union** of four already-gated reads; the
  billing-omit-not-mask is structurally enforced at a single `=== 200` site; the three-read gate fails closed and
  disclosure-equivalently. The built-code review found no constructible exploit.
- The home requires three subresources mounted (true in every real compose). Minimal hand-built test fixtures that
  omit `escalations` will mask the home to 404 — intentional and consistent with the existing multi-read pages.
- **Deferred:** a JSON `/overview` endpoint (only if a non-web consumer needs it); a per-wedding planner overview;
  trend/time-series figures (need a period model the stores don't carry — same deferral as ADR 0032 per-period
  statements); configurable cards; real-time/push updates.
