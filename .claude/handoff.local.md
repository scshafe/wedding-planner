# Handoff

## Where things stand — Phase 21 (planner guest-management CRUD + the first browser-form CSRF) is COMPLETE ✅
`.claude/plans/2026-06-27-phase-21-planner-guest-management-and-csrf.md` is **complete — Step 0 design reviews +
Steps 1–9 ticked**, on branch **`build/phase-3-generalize-search`** (the open review artifact for `main`; Phases
3–21 build on it; the loop's merge-keeper advances `main` when green). Working tree clean.
`npm run build && npm test && npm run lint` all green (**749 tests**, up from 726 at the start of this run).

This rung makes the **guest-messaging channel operable by a real planner** ([[guest-messaging-channel-is-a-roadmap-goal]]).
Both human-set channel constraints were already DONE (no-lock-in: Phase 18; pricing+scoring: Phases 18+20), so
this added NO new channel safety machinery — it built the planner CRUD surface + the **first planner *mutation*
trust surface over a browser** (HTML forms + CSRF, the guard Phase 19 deferred). ADR 0021, memory
[[planner-guest-management-and-csrf]]. Verified end-to-end against the **composed** surface (login → ?view=guests
→ register via the browser form → redirect → guest shown).

## What changed this phase
- **18th schema `guest`** (`product/schemas/guest_schema.json`) — a guest binding is now an external write
  surface; `GuestBinding = Guest` (the generated type, single source). Manifest count 17 → 18 (+ gen:types).
- **`GuestRegistry`** gained `list` + idempotent `remove`; `register` now rejects a duplicate ref
  (`PRODUCT.GUEST_ALREADY_REGISTERED` → 409) and schema-validates. `TenantScopedRepository.delete` (context-keyed,
  idempotent, no oracle).
- **`GuestAuthorizer`** (planner-only capability; couple → 403). **JSON API** `GET/POST/DELETE /t/:slug/guests`
  (3-seg, ref in the body; register verifies the wedding exists in-tenant — referential integrity, not an oracle).
- **CSRF** — `auth/csrf_guard.ts` (`CsrfGuard` + length-safe constant-time `constantTimeEqual`); `SessionStore`
  implements it (a SEPARATE per-session `ids.next('csrf')` token, distinct from the session token).
- **Web UI** — themed `?view=guests` page (list + add-form with a wedding `<select>` + per-row remove forms);
  web form routes `POST /t/:slug/guests/{create,remove}` + retrofit `/logout`, each verifying `_csrf` before any
  cookie→Bearer translation; the narrow `csrf` dep wired at compose.

## The load-bearing insights (carry forward) — see [[planner-guest-management-and-csrf]] for the full set
- **CSRF at ONE layer (the web-owned handlers) because that is the sole cookie→Bearer seam.** `#delegate`
  forwards verbatim, so the JSON mutation API is structurally **not CSRF-reachable** (cookie-only delegated POST
  → 401, the missing-Bearer 401 not SameSite) and carries no token. Don't move CSRF into the JSON pipeline.
- **The CSRF token MUST be distinct from the session token** (reusing it defeats HttpOnly) and verified
  constant-time + fail-closed; the `sessionToken` you verify with MUST be the one you then forward as Bearer.
- **Slug normalized FIRST** so the CSRF outcome is never a tenant-existence oracle; the register-time
  wedding-existence check is referential integrity for the **trusted planner**, NOT an oracle (contrast login).
- **Tripwire:** couples managing their OWN wedding's guests reopens the couple-vs-planner resource-scoping in
  `GuestAuthorizer` (today it is a planner-only capability, no resource decision).

## Next action — your call. Pick the next high-value lever (ranked)
- **★ A richer wedding-facts model** (ceremony time / venue / parking / dress code) so the Phase-19
  `GuestQaResponder` answers real logistics, not just `event_date`. The `GuestQaResponder` seam +
  `projectGuestVisibleFacts` are built for it; this is where `'refused'` (surprise-classified facts) finally gets
  emitted. High demo value, and it makes the now-operable guest channel actually useful. **Recommended.**
- **★ Couples managing their own wedding's guests** — extend `GuestAuthorizer` to a couple-scoped resource
  decision (a couple manages only their bound wedding's guests). Smaller; folds naturally onto this phase.
- **Unify `product/price_book.ts` onto the shared cost basis** (retail = COGS × margin over `MESSAGE_COST_CENTS`)
  — the clean follow-up Phase 20 deferred; tidies the two-cents-tables seam.
- **Planner HTML wedding create/edit forms** — the SAME `CsrfGuard` seam now exists; a natural next browser
  mutation (today weddings are JSON-only; the couple PUT is JSON).
- **Period-batched usage billing / `deliveryStatus` consumption** — smaller billing/observability rungs (ADR 0019
  "Deferred"). Lower priority.

## Standing rails (unchanged — do not weaken)
Offline-first (no real money/booking/comms; no prod/credentials — don't simulate them). **A real messaging
provider sending real texts is the human crossing (guest-comms tier-2 / exception #4) — build up to the line,
never across it or simulate having.** Don't modify `ops/` or `CLAUDE.md` (human-reserved). Push only to this
repo's `origin`. The named specialist sub-agents (doddy/wolf/testineer/rigorous-architect) are **not
provisioned** here — route adversarial reviews through `general-purpose` agents carrying the persona lens (this
run did, at design AND on the built code — all APPROVE; the one stale-comment must-fix applied). **CI/exit-code
lesson:** never pipe `npm run build` to tail/grep when gating with `&&` (the pipe masks the non-zero exit); run
build standalone, check `$?`. `npm run build` runs from REPO ROOT. **Eval-harness/telemetry import ONLY
`@wedding-planner/shared`, never `product`** (the firewall, by reachability). **Schema change ⇒ `npm run
gen:types`** + bump the manifest count test + the gen-script header. **CSRF is a WEB-layer concern only** — the
JSON API is Bearer-only and not CSRF-reachable; a new browser mutation plugs into the `CsrfGuard` seam
(verify before any cookie→Bearer translation).
