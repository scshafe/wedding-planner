---
name: account-home-overview
description: Phase 33 — the account home/overview is the default /t/:slug; a pure web-layer composition of existing gated reads (no new oracle), billing card omitted (never masked) for couples
metadata:
  type: project
---

Phase 33 gave the product surface a **front door**: the default `/t/:slug` is now an account **home / overview**
(the customer-facing console hub for [[web-ui-themed-edge]]), not the bare wedding list. The siloed `?view=…`
spokes (guests/escalations/billing/strategy) are tied together by an at-a-glance "what needs attention" page —
open guest-question count, weddings/guests counts, and a planner-only owed-balance card — each linking into its
view. The wedding list + create form relocated to **`?view=weddings`**.

**The load-bearing decisions (carry forward):**

- **The home is a PURE web-layer COMPOSITION of the existing gated reads — no new endpoint, no new schema, no new
  domain code (manifest stays 20).** `#home` issues `api.handle()` for `GET /weddings`, `/escalations`, `/guests`,
  `/billing` and aggregates COUNTS at the edge. We deliberately did NOT add a JSON `/overview` projection: one
  aggregate handler would concentrate four authz surfaces (`listScope`/`manageScope`/`authorizeBillingView`) the
  narrow-deps convention keeps separate. Composing at the web edge keeps each figure riding its OWN already-verified
  gate AND preserves the **only-data-path-is-`api.handle`** invariant. The home discloses strictly the UNION of
  those four reads → structurally no new oracle. This is the dashboard analogue of the Phase-32
  [[planner-billing-activity-log]] "aggregate must not reveal more than the parts" keystone.

- **Billing is the ONE conditional read: `status === 200 ? card : omit`, and its status MUST NEVER flow into
  `#renderNonData` (the keystone, design-review P1).** A couple's `GET /billing` is a 403 (the planner-only
  capability, [[planner-billing-view]]); the home keeps a **200 with the billing card simply ABSENT** (the
  `...(summary === undefined ? {} : {billing})` spread). If billing were folded into the page gate, every couple's
  whole home would become a Forbidden wall — a planner-only capability turned into a couple-facing wall, and the
  home's status made role-dependent. The omission is NOT an oracle (a couple already knows it is not a planner;
  absence reveals nothing about any resource) — same affordance pattern as the create form ([[html-wedding-create-edit-forms]]).

- **The page GATE is EXACTLY the three dual-role reads (weddings + escalations + guests).** Both roles read all
  three (couples scoped to their wedding since Phases 24/26). First non-200 masks the WHOLE page via
  `#renderNonData` (the `#guestsPage` no-half-page pattern): unknown/suspended/onboarding/unauthenticated all
  collapse to the theme-independent frozen `GENERIC_404` (or themed login on 401) — byte-identical, no lifecycle
  oracle. `escalations` is OPTIONAL in `ApiDeps`; if unwired it 404s → the home masks to `GENERIC_404`. That is
  **intentional fail-closed, NOT a half-page** — pinned. The home e2e runs on the FULL compose surface (always
  wires escalations); minimal per-feature test fixtures that omit escalations must read `?view=weddings` directly
  for CSRF/list content (this is why several Phase-pre-33 web tests were retargeted to `?view=weddings`).

- **Open-questions count folds BOTH arrays from the ONE scoped escalations body.** "Open" = an escalation with no
  resolution; counting `escalations.length` alone over-counts handled ones. `countOpenEscalations(escalations,
  resolutions)` uses `resolutionIndex` (the SAME join the inbox's Open/Handled split uses → single-sourced, can't
  drift). Both arrays come scoped by the same `manageScope` branch, so a couple's count can't include a sibling
  wedding's escalation.

- **Default-landing swap is a pure web-edge routing change.** `#console` fallthrough → `#home`; list → `?view=weddings`;
  `#weddingCreate` PRG retargets to `/t/:slug?view=weddings` (from the validated slug). JSON API, CSRF seam, slug
  validation, masked-404 all untouched. Nav is hub-and-spoke: spokes' back-link `← Home` → `/t/:slug`; the wedding
  detail keeps `← All weddings` → `?view=weddings` (it is a sub-page of the list).

doddy+architect APPROVE design (APPROVE-WITH-FIXES, all folded) AND built code (APPROVE — no constructible exploit,
all 6 properties verified at file:line). ADR 0033. 945 tests.
