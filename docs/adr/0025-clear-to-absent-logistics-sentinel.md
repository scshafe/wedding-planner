# ADR 0025 — Clear-to-absent sentinel for the optional logistics fields

- **Status:** accepted
- **Date:** 2026-06-27
- **Decider:** the building agent (an agent-owned engineering decision per
  [[agents-own-buildout-decisions]] and `.claude/plans/2026-06-27-phase-25-clear-to-absent-logistics-sentinel.md`)
- **Scope:** Phase 25 — let a planner **clear** one of the four optional guest-visible logistics fields
  (`ceremony_time` / `venue_name` / `parking_info` / `dress_code`) back to **absent**, from the browser edit
  form and the JSON `PUT`. The top-ranked, most-cited open product deferral from Phase 23. **No new schema, no
  new route, no new safety machinery, no authz change.**
- **Builds on** the Phase-23 HTML wedding forms ([[html-wedding-create-edit-forms]]) and the Phase-22 logistics
  fact model ([[richer-guest-visible-facts]]). Reuses the one safety model.

## Context

After Phase 23 the HTML edit form (and JSON `PUT /t/:slug/weddings/:id`) could **set** and **preserve** the four
optional logistics fields but could not **clear** one: an omitted optional field PRESERVES the stored value, and
the web body builder OMITTED an empty input. So a planner who set a wrong dress code could not blank it from the
browser. These fields each carry a JSON-Schema `minLength:1`/pattern that rejects the empty string `""`, so `""`
carried no prior valid meaning to collide with.

Two adversarial reviews ran on the DESIGN (via `general-purpose` agents carrying the persona lens — the named
specialists are not provisioned here): **doddy APPROVE** (no new oracle; reduce-only disclosure; three-way rule
well-defined for hostile bodies), **rigorous-architect APPROVE-WITH-FIXES** (all applied — see below). 798 tests
green (was 793).

## Decisions

### 1. The wire sentinel for "clear" is the EMPTY STRING, meaningful ONLY on the optional logistics fields of `PUT`

On `PUT`, each of the four optional fields is now **three-way**:

- key **absent** ⇒ PRESERVE the stored value (a direct JSON caller omitting a key is unchanged);
- key present as **`""`** ⇒ CLEAR to absent;
- key present as a **non-empty string** ⇒ validate (contract) + set.

Empty-string is the natural HTML-form representation (a cleared `<input>` submits `key=`), needs no new wire
concept, and the four fields already reject `""` at the contract — so the sentinel collides with nothing.

### 2. CLEAR is an UPDATE-only concept; the CREATE (`POST`) path is unchanged byte-for-byte

A `POST` asserts a brand-new resource — there is nothing to clear, so an empty optional is malformed: a direct
JSON create sending `dress_code:""` still 400s (the contract's `minLength`/pattern rejects it), and the web
create form keeps OMITTING empty optionals. The create/update asymmetry is **per-operation-correct**, not an
inconsistency (POST sets initial values; PUT patches). It is also safe: both the create 400 and the update
behavior are observable ONLY to an already-authorized planner on their own tenant — no status difference reaches
an unauthorized party, so the asymmetry is not a confusion-based oracle. (architect MUST-FIX: a corrected
load-bearing comment now sits on BOTH `handleCreate` and `handleUpdate` so the asymmetry can't rot.)

### 3. The clear path reuses the EXISTING absent-key mechanism — no second codepath

`patchOptional` returns `undefined` for the `""` case, which flows through the same conditional spread
(`...(x === undefined ? {} : { x })`) that an omitted/preserved-as-absent field already uses, so the key is simply
dropped from the reconstructed record. There is **one** way to produce an absent key. (architect MUST-FIX: branch
on `""` *before* `requireString` — which rejects `""` — and return `undefined` into the existing spread, rather
than adding a separate clear write.)

### 4. The match is RAW + strict, recognized only in `handleUpdate` — hostile bodies fall through to 400

The sentinel is matched on the raw body value with strict `=== ''`. A non-string (`[""]`, `0`, `null`, `{}`) is
neither absent nor `""`, so it falls to the existing `requireString` ⇒ 400 — it can neither reach a clear nor
persist an invalid record (the full record is re-validated against the contract on every update). `requireString`
/ `optionalString` are **untouched**, which is exactly what keeps the create path byte-for-byte. (architect
MUST-FIX.)

### 5. The web form diverges on exactly one axis — `weddingBodyFromForm(form, { clearable })`

One shared builder, one boolean: when `clearable` (update), every optional field is sent even when empty (so `""`
reaches the PUT clear sentinel); when not (create, the default), empty optionals are omitted. Only the four
optional fields are gated by `clearable` — the required name/date/status stay always-sent so an empty required
input still 400s downstream (it can never silently no-op). (doddy build-guardrail + architect finding 4: keep the
flag scoped to the optionals; one builder, not two — two would let the required-field block drift.)

### 6. One shared `WEDDING_LOGISTICS_FIELDS` const — no drift between the two field-set copies

The field set lived as two hand-maintained copies (the web `WEDDING_OPTIONAL_FIELDS` and the `patchOptional` key
union). They are now one exported `WEDDING_LOGISTICS_FIELDS` (+ a `WeddingLogisticsField` type) in
`wedding_repository.ts`, referenced by both the web builder loop and the `patchOptional` key type. (architect
finding 6 — the cheap hedge; a deeper `logistics` sub-aggregate is **premature** at four flat fields with no
cross-field invariant and is explicitly NOT done here.)

### 7. The affordance note lives on the EDIT form only, not the shared input set

The "blank an optional field to clear it" note is rendered in `renderDetail`'s edit card, NOT inside the shared
`weddingFormFields` helper (which the create console reuses, where blank ≠ clear). The shared helper stays free of
mode knowledge so it cannot surface the wrong affordance. (architect finding 5.)

## Consequences

- A planner can blank a wrong logistics fact from the browser. Clearing strictly **reduces** guest disclosure:
  the guest-messaging responder flips from `answered` (a metered reply) to `escalated` (no send, no meter) — the
  Phase-22 unset behavior. This is the only direction the change can move disclosure (doddy "reduce-only" claim,
  verified): there is no field whose absence triggers a *more*-revealing reply, and `escalated`/`refused` are both
  wire-silent (uniform 202), so a clear emits no new guest-visible signal.
- No new oracle: clearing operates only on the planner's already-authorized own wedding (ownership decided BEFORE
  body parse, unchanged); identity (`wedding_id` from route, `tenant_id` from context) is stamped LAST, so a body
  `dress_code:""` cannot re-target.
- No schema change (manifest stays 18); no JSON contract change; no new route; the one safety model is reused.
- 798 tests green (was 793): new JSON-API clear cases (three-way per field; raw-strict 400s; POST-`""`-still-400
  locks the create contract); web-flow cases (edit-form blank CLEARS; resend-prefilled PRESERVES; create-blank
  is just unset); the compose e2e gained a third leg (planner clears `dress_code` via the browser ⇒ the same
  guest question escalates again ⇒ meter stays at 1).

## Alternatives considered

- **An explicit `_clear` field list or a typed PATCH verb** — rejected as over-engineering for four flat fields
  whose clear path collapses cleanly into the existing absent-key spread. Revisit only if a future field's empty
  string becomes a legitimate value (then the empty-string sentinel would be ambiguous).
- **A `null` sentinel** — rejected: `null` is not the native HTML-form empty representation; a cleared input
  submits `""`, not `null`. Using `null` would force the web layer to translate, adding a seam for no gain.
- **Symmetric empty-as-clear on POST too** — rejected: nothing to clear on create; an empty optional on a new
  resource is malformed, and accepting it would relax the create contract for direct JSON callers with no benefit.
- **Extract a `logistics` sub-aggregate** — deferred: premature at four flat fields with no cross-field rule; the
  shared `WEDDING_LOGISTICS_FIELDS` const is the proportionate consolidation and the natural seed if it ever does.
