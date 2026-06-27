# Clear-to-absent sentinel for the optional logistics fields (Phase 25)

The four optional guest-visible logistics fields (`ceremony_time` / `venue_name` / `parking_info` /
`dress_code`) can now be **cleared back to absent** from the browser edit form and the JSON `PUT` — closing the
Phase-23 deferral ([[html-wedding-create-edit-forms]]). Builds on the Phase-22 logistics model
([[richer-guest-visible-facts]]). No new schema/route/authz; one safety model reused. ADR 0025. 798 tests.

## The load-bearing decisions (carry forward)

- **The clear sentinel is the EMPTY STRING `""`, meaningful ONLY on the optional logistics fields of `PUT`.**
  It's the native HTML-form empty representation (a cleared `<input>` submits `key=`), and the four fields'
  contract `minLength:1`/pattern already rejects `""`, so the sentinel collides with no prior valid meaning.

- **`PUT` is now THREE-WAY per optional field** (the only handler change, in `handleUpdate`'s `patchOptional`):
  key **absent** ⇒ PRESERVE existing; key **`""`** ⇒ CLEAR to absent; key **non-empty** ⇒ validate + set.
  Critically: branch on `""` **before** `requireString` (which rejects `""`) and return `undefined`, so the
  clear flows through the EXISTING `...(x===undefined?{}:{x})` conditional spread — **one** way to produce an
  absent key, no second codepath. The match is on the RAW body value with strict `=== ''`, so a non-string
  (`[""]`/`0`/`null`/`{}`) is neither absent nor `""` ⇒ falls to `requireString` ⇒ 400 (can't reach a clear,
  can't persist an invalid record; the full record is re-validated on every update).

- **CLEAR is UPDATE-only; CREATE (`POST`) is byte-for-byte unchanged.** A `POST` with an optional `""` still
  400s (the contract rejects it) — nothing to clear on a new resource, so omit it to leave unset. `requireString`
  / `optionalString` are untouched (that's what keeps create unchanged). The asymmetry (empty=400 on POST,
  empty=clear on PUT) is per-operation-correct (POST sets; PUT patches) and SAFE: both outcomes are observable
  only to an already-authorized planner on their own tenant — no unauthorized party sees a status difference, so
  it's not a confusion oracle. A corrected load-bearing comment now sits on BOTH handlers so it can't rot.

- **The web form diverges on ONE axis: `weddingBodyFromForm(form, { clearable })`.** Update passes
  `clearable:true` (sends every optional even when empty ⇒ `""` reaches the PUT sentinel); create omits empties
  (default). `clearable` gates ONLY the four optionals — required name/date/status stay always-sent (an empty
  required input still 400s downstream; it can never silently no-op). One builder, not two (two would let the
  required-field block drift).

- **One shared `WEDDING_LOGISTICS_FIELDS` const** (+ `WeddingLogisticsField` type) in `wedding_repository.ts`,
  referenced by both the web builder loop and the `patchOptional` key type — the two hand-maintained field-set
  copies are now one source of truth. A deeper `logistics` sub-aggregate is **premature** at four flat fields
  with no cross-field invariant; this const is the proportionate hedge and the natural seed if one ever emerges.

- **The "blank to clear" affordance note lives in `renderDetail`'s edit card, NOT the shared
  `weddingFormFields`** (which the create console reuses, where blank ≠ clear). The shared helper stays free of
  mode knowledge so it can't surface the wrong affordance.

## Security framing (why it's oracle-free — doddy APPROVE)

- Clearing operates ONLY on the planner's already-authorized own wedding (ownership decided BEFORE body parse,
  unchanged); identity (`wedding_id` from route, `tenant_id` from context) is stamped LAST, so a body
  `dress_code:""` can't re-target.
- **Reduce-only disclosure:** clearing a guest-visible fact flips the responder from `answered` (metered send) to
  `escalated` (no send, no meter) — strictly LESS disclosure. There is no field whose absence triggers a
  more-revealing reply, and `escalated`/`refused` are both wire-silent (uniform 202), so a clear emits no new
  guest-visible signal. The clear can only move disclosure in the safe direction.
