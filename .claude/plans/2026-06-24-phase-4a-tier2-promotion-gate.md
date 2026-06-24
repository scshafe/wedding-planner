# Phase 4a — Make the tier-2 human-gate load-bearing (the promotion gate)

**Status:** PLANNED — not started. **Branch:** continue on `build/phase-3-generalize-search` (Phase 3 is
the open review artifact for `main`; 4a builds on it) or a fresh `build/phase-4a-tier2-gate` if 3 has
merged. **Predecessor:** Phase 3 (generalized 2-D search) — complete.

## Why this phase (and why it is SPLIT from escalation)
The handoff's recommended next work was "the tier-2 escalate-to-couple knob as its own gated phase —
the deferred work that makes the firewall's tier-2 human-gate + integrity forge-detection load-bearing."
Two adversarial design reviews (a security/trust-boundary reviewer and an architecture/search reviewer —
the repo's real specialists are not provisioned here, see commit b1201fa; substituted `general-purpose`
reviewers, findings folded in as **[R-…]** below) **converged hard on splitting that into two phases**:

- The tier-2 **promotion gate** is a *loop/safety* concern. It needs **zero** new search dimensions,
  **zero** new simulator dynamics, and **zero** forge surface to be made load-bearing. [R-arch-P1]
- Folding escalation into the genome as a 3rd search knob **contradicts committed memory**
  (`second-genome-knob-must-stay-tier1.md:40-42`: escalation is built "as its own gated phase, **never
  folded into the autonomous search**"), and would waste ~75% of autonomous iterations proposing
  candidates the loop is structurally forbidden to promote. [R-arch-P0]

So **Phase 4a (this plan) = the gate**, proven with an *injected* tier-2 candidate. It makes the dormant
`oversight_record.human_gate` contract its **first live code consumer** and makes the promotion seam
tier-aware. **Phase 4b (next) = the escalate-to-couple knob + forge-detection**, the sanctioned
escalation phase, with the integrity/Stage-B forge work as its centerpiece (not an afterthought).

Today the gate is asserted-by-absence: the only promotion seam (`offline_loop.ts` `onAccepted` →
`championStore.promote`) is **unconditional** — a tier-2 genome whose declared tier honestly equals 2
passes the pre-score under-declaration gate, gets scored, gets accepted, and **auto-ratchets the
champion**. That is the exact rail breach `second-genome-knob-must-stay-tier1.md` warns about. This phase
mechanizes the gate instead of relying on the absence of a tier-2 knob.

## Design decisions (locked, with the review that forced them)

**D1 — SPLIT: 4a is the gate only; escalation + forge-detection is 4b.** [R-arch-P0, R-arch-P1-recommendation]
Respects `second-genome-knob-must-stay-tier1.md`. 4a touches no simulator dynamics, no oracle, no
integrity-gate code. An ADR (0003) records the split and supersedes nothing — it sequences the
memory-sanctioned escalation work.

**D2 — the tier-2 vehicle is an OPTIONAL, presently-UNWIRED genome knob `autonomy_threshold`
(int 1..3), mapped to `commitment_autonomy` (tier-2).** [R-sec-design, R-arch-P1-vehicle]
- It is **optional** (NOT in the schema's `required` set) and absent from every genome the autonomous
  search emits, so the search box stays the tier-1 2-D box (cadence × spacing) and `deriveRiskTier`
  returns 1 for all searched genomes (`deriveRiskTier` iterates only *present* parameters,
  `risk_tier.ts:121`). A genome that *includes* `autonomy_threshold` derives to tier-2.
- **Range is 1..3, not 0..3** — there is no "0 = off" value, so a genome either omits the knob (tier-1)
  or carries an elevated-autonomy value (tier-2). This avoids the behavior-equal/hash-distinct alias
  (`{c,s}` vs `{c,s,autonomy:0}`) that Phase-3 D2 outlawed: presence is meaningful, absence is canonical.
- Its **Stage-A behavioral wiring and forge-detection are explicitly deferred to 4b** — the
  "decide the tier before the knob is wired" pattern the reserved-surface comments already endorse
  (`risk_tier.ts:78-79`). The autonomous search never varies it, so the deferred-wiring no-op never
  appears as wasted search. The knob exists in 4a *only* so a tier-2 genome is constructible for the
  keystone. The metamorphic oracle's anti-no-op battery is **not** extended to it (documented exemption:
  unwired in 4a). This is honest and visibly marked, not hidden dead weight.

**D3 — the gate decision reads the INDEPENDENTLY DERIVED tier at the promotion seam, never the
candidate's self-declared `risk_tier`.** [R-sec-P0-1, R-sec-P1-2]
The promote/park discriminator re-resolves the genome from `artifact_ref` and calls
`deriveRiskTier(genome).tier` *inside the promotion path*. The existing pre-score under-declaration
reject (`risk_tier_reconciliation.ts:72`) stays, but it is necessary-not-sufficient: the seam re-derives
independently so a candidate whose `risk_tier` field is forged to 1 over a tier-2 genome still parks.
Two independent derivations, fail-closed.

**D4 — approvals are EXOGENOUS, read-only injected input; the loop has no method that constructs an
approval.** [R-sec-P0-3] This is what makes "absent ⇒ park" an honest model of a human gate in an
offline system with no humans/production. The loop receives `approvals: readonly OversightRecord[]`
(or a read-only `ApprovalStore`) as config; the promotion code **consume-matches only, never creates**.
- In real autonomous operation **no approvals are supplied → every tier-2 candidate parks → safe.** We
  do not fake a human; we correctly model "no human approved, so it does not land."
- A test asserts there is **no code path from loop state to an approval record** (the non-self-approval
  rail). Hard key-custody (a separate signing key the loop cannot hold, so a loop-forged `decided_by:
  human` record fails `INTEGRITY.FORGED_CLEAR`) is the production form; offline we use the read-only
  injected list + the no-constructor invariant and record key-custody as the prod hardening in memory
  (consistent with `prod-trusted-evidence-channel`). The signer is NOT given a `human` key path here.

**D5 — the landing key binds `(genome_hash, champion_hash_at_promotion)`, re-derived at spend time.**
[R-sec-P1-1] `human_gate.binds_landing_key = sha256(canonicalGenomeHash ‖ championHashAtApproval)`.
At the seam we re-derive the key from the *current* champion + the content-addressed candidate genome
and require equality. Consequences, all asserted:
- **Champion-ratchet staleness:** an approval reviewed against champion A does not promote after the
  champion ratchets to B (keys differ ⇒ park ⇒ must be re-reviewed against the new baseline). `candidate_id`
  is the WRONG key (per-proposal, content-free) — it loses *which genome* and *which baseline* the human
  reviewed.
- **One-shot:** an approval is marked spent on use; it cannot promote a second distinct candidate.
- **Crash-retry idempotency:** a re-driven `human_review → promoted` transition with identical content
  (incl. the bound approval id in `evidence_ref`) is absorbed by the ledger's `(candidate_id, from, to)`
  idempotency (`ledger.ts:79-94`); a *different* candidate reusing the same approval produces different
  transition content and is caught.

**D6 — the loop outcome is THREE-WAY: `promoted` / `parked` / `rejected`; `approved:false` is a distinct
rejection, not park.** [R-sec-P1-4, R-arch-P0-park]
- `approved:true` + matching key ⇒ **promote** (`human_review → promoted`, decided_by `human`).
- `approved:false` + matching key ⇒ **reject** (`human_review → human_rejected`, disposition
  `rejected_human`) — terminal, NOT parked-for-retry (so a later stray approval can't resurrect it).
- no matching approval ⇒ **park** (`offline_passed → human_review → parked`, disposition `parked`,
  reason `awaiting_oversight`) — decided_by `deterministic_selector` (the *decision to park* is a
  deterministic tier check; the human only appears on a later promote/reject transition).
- A parked accept **does not ratchet** the champion and **does not** misreport progress: it leaves
  `championStore.current()` unchanged and its terminal reason is the new `awaiting_oversight`, never a
  false `converged`/`dry`. (The convergence *certificate* is untouched in 4a because the autonomous
  search stays on the tier-1 box and never parks mid-sweep; **4b MUST redefine `converged` as "no
  PROMOTABLE point" before putting tier-2 in the search** — recorded as the deferred fix.) [R-arch-P0-cert]

## Steps (each: `npm run build && npm test && npm run lint` green before ticking + committing)

- [ ] **Step 1 — the tier-2 genome knob (optional, unwired) + risk derivation (D2, D3).**
  - `strategy_genome_schema.json`: add `autonomy_threshold` (integer, min 1, max 3) to
    `parameters.properties` (keep `additionalProperties:false`; do **NOT** add it to `required`). Pin its
    meaning in the description: tier-2 `commitment_autonomy`; presence elevates the whole genome to
    tier-2; Stage-A wiring + forge-detection deferred to Phase 4b.
  - `risk_tier.ts`: promote the reserved comment at line 79 to a live entry
    `autonomy_threshold: 'commitment_autonomy'`, with a precedent-guard comment (autonomy threshold = the
    AI deciding how much to act without asking the couple → tier-2; must NOT be re-laundered to tier-1).
  - Regenerate the contract TS type (`autonomy_threshold?` optional). Verify the drift-guard test (schema
    params ⊆ surface map) passes with the optional param.
  - Tests (`risk_tier.test.ts`, `genome.test.ts`): a genome WITHOUT the knob derives tier-1 (search box
    unchanged); a genome WITH `autonomy_threshold ∈ {1,2,3}` derives tier-2; the `perParameter` stays
    sorted; range 1..3 enforced (0 and 4 are schema-invalid). Confirm every existing fixture (tier-1)
    still validates unchanged — **no genome hash re-baseline** (optional absent param ⇒ identical hashes).

- [ ] **Step 2 — the promotion seam goes tier-aware with a three-way outcome (D3, D6).**
  - In `offline_loop.ts`, replace the binary `accepted → onAccepted` with a three-way result. On an
    accepted candidate, re-resolve the genome from `artifact_ref` and re-derive tier via
    `deriveRiskTier` **at the seam** (never `candidate.risk_tier`). `tier ≤ 1` → promote path (today's
    behavior). `tier ≥ 2` → gated path (Step 3).
  - Define `PromotionOutcome = 'promoted' | 'parked' | 'rejected'`. `parked`/`rejected`: do NOT call
    `championStore.promote`; do NOT reset `consecutiveDry` as progress; surface the new terminal reason
    `awaiting_oversight` when a run ends with a parked candidate and no promotion.
  - Assert: a tier-2 accept with no approvals leaves the champion unchanged (the rail).

- [ ] **Step 3 — the `human_gate` consumer: exogenous approval + landing-key binding + idempotency
    (D4, D5, D6).**
  - Add a read-only approval source to the loop config: `approvals?: readonly OversightRecord[]` (or a
    small `ApprovalStore` with only `find(landingKey)` + `markSpent`). The loop NEVER constructs an
    `OversightRecord`.
  - Landing key: `landingKey(genome, championHash) = sha256(canonicalGenomeHash(genome) ‖ championHash)`
    (reuse `shared` hashing + canonical-json; no ambient values). Re-derive at the seam from the current
    champion.
  - Gated path on a tier-2 accept: ledger `offline_passed → human_review` (decided_by
    `deterministic_selector`, rationale carries derived tier + missing-approval reason). Then match an
    approval whose `binds_landing_key` equals the re-derived key:
    - `approved:true` ⇒ promote; ledger `human_review → promoted` (decided_by `human`,
      `evidence_ref` = approval id); mark approval spent (one-shot).
    - `approved:false` ⇒ ledger `human_review → human_rejected`; disposition `rejected_human`.
    - no match ⇒ ledger `→ parked`; disposition `parked`; reason `awaiting_oversight`.
  - Validate every constructed/consumed `OversightRecord` against `oversight_record_schema.json` (use the
    schema registry; never redefine the shape).

- [ ] **Step 4 — wire the gate through `genome_offline_loop.ts` + the non-self-approval guard (D4).**
  - Thread the `approvals` config through `genome_offline_loop.ts`; `onAccepted` becomes the tier-aware
    seam from Step 2 (re-derive + branch), not a direct `promote`.
  - A structural test asserts there is no loop code path that constructs an approval (the approval type is
    consumed read-only; e.g. the loop module exports no approval constructor and the gate only calls
    `find`/`markSpent`). Document key-custody as the prod hardening (memory).

- [ ] **Step 5 — THE KEYSTONE (the gate is load-bearing).**
  - **(a) no-approval parks:** an INJECTED tier-2 candidate (genome = optimal tier-1 knobs +
    `autonomy_threshold`) that PASSES the accept rule against a *suboptimal* champion is NOT promoted;
    champion unchanged; a `parked` transition is ledgered; terminal reason `awaiting_oversight`.
    *RED on a naive unconditional-promote loop; GREEN on the gated loop.* [R-arch keystone]
  - **(b) approval promotes:** same candidate + an injected `human_gate{approved:true}` whose
    `binds_landing_key == landingKey(genome, currentChampionHash)` ⇒ promotes; human-approved transition
    ledgered; approval marked spent.
  - **(c) rejection is distinct:** `approved:false` bound to the key ⇒ `human_rejected`, terminal; the
    candidate is not parked-for-retry and a later stray approval does not resurrect it.
  - **(d) champion-ratchet staleness:** an approval minted against champion A does NOT promote after the
    champion has ratcheted to B (re-derived key mismatch ⇒ park). [R-sec-P1-1]
  - **(e) replay / crash-retry:** one approval cannot promote two distinct candidates; a re-driven
    identical promotion is absorbed by ledger idempotency (no double-promote). [R-sec-P1-1]
  - **(f) derived-tier integrity:** a candidate whose `risk_tier` field is hand-forged to 1 over a
    tier-2-deriving genome still PARKS (the seam re-derives). [R-sec-P0-1, P1-2]
  - **(g) non-self-approval rail:** a full loop run on a tier-2-accepting setup with the approvals input
    EMPTY ⇒ the champion never becomes the tier-2 genome; the run terminates honestly (parked /
    `awaiting_oversight`), never `promoted`/`converged`-as-if-landed. [R-sec invariant 1]

- [ ] **Step 6 — ADR + memory + handoff.**
  - `docs/adr/0003-tier2-promotion-gate.md`: D1–D6 (the split, derived-tier-at-seam, exogenous approval,
    landing-key = genome‖champion, three-way outcome, certificate-stays-tier-1).
  - Memory: **tier-2-promotion-gate-is-load-bearing** (exogenous read-only approval; absent⇒park,
    approved:false⇒reject; landing key binds genome‖champion and is re-derived at spend; derived tier at
    the seam, never declared); and the **deferred-certificate-fix** note (4b must redefine `converged` as
    "no PROMOTABLE point"). Update `second-genome-knob-must-stay-tier1` to point at 4a (gate) / 4b
    (escalation). Index in `MEMORY.md`.
  - Update `.claude/handoff.local.md`: 4a done; **4b = escalate-to-couple + forge-detection** is next,
    with the security reviewer's **metric-reads-claims seam** (`offline_scorer.ts:111` scores the CLAIMED
    event stream — a forged resolution must be tied back to a trusted record, not just an escalation
    effect-kind) as the headline P0 for 4b.

## Invariants this phase must not break
- Offline-first; no real side effects; one safety model; `ops/` and `CLAUDE.md` untouched.
- The content-address firewall: validate-before-bind, derive tier from content (never the declared
  number), refuse/park-and-halt rather than assume-harmless.
- **The autonomous loop cannot self-grant tier-2 autonomy** (the rail): approvals are exogenous, the loop
  has no approval constructor, and absent approval ⇒ park.
- No genome hash re-baseline (the tier-2 knob is optional/absent in all existing + searched genomes).
- The Phase-3 convergence certificate semantics are unchanged in 4a (tier-1 search box only); the
  "promotable" redefinition is explicitly deferred to 4b and recorded.
