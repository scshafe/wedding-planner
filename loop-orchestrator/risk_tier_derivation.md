# Risk-Tier Derivation

The deterministic function that assigns a candidate's `risk_tier`. This is the gate that keeps a
money/comms/booking change off the Tier-0 auto-promote path, so it must not trust anything the
proposer says about itself.

## Why the input is the diff, not the declaration

The proposer self-reports `capabilities_touched` and a `risk_tier` on the candidate
(`schemas/candidate_change_schema.json`). **Recomputing the tier from a field the proposer
controls is not independent verification — it relaunders the proposer's claim.** A candidate that
alters spend behavior can declare `capabilities_touched: ["orchestration"]` and ride the Tier-1
path past the human approval gate. So the tier is derived from **static analysis of the actual
diff at `artifact_ref`**, and the proposer's declarations are treated as *claims to be checked
against that derivation*.

## The function

```
tier(candidate) = max over s in touched_surfaces(diff(artifact_ref)) of floor(s)
```

### Step 1 — `touched_surfaces(diff)`
A deterministic mapping from changed files / paths / symbols to a set of **sensitivity surfaces**.
The path→surface map is **trusted config**: it lives outside the proposer's write scope and is
human-maintained, exactly like the graders (see `safety_and_governance.md` §1).

### Step 2 — surface tier floors (tripwires)

| sensitivity surface (detected in the diff) | tier floor |
|---|---|
| ranking / copy / cosmetic / UX presentation only | 0 |
| planning flow / orchestration / non-binding tools | 1 |
| guest-facing comms content, templates, or segmentation | 2 |
| binding integration / booking / payment call sites | 2 |
| commitment execution or autonomy-scope evaluation | 2 |
| PII handling / guest-record access | 2 |
| the spend-authorization **model** itself | 3 |
| objective / scoring / rubrics / graders / corpus thresholds | 3 |
| legal / contractual terms | 3 |

### Step 3 — `max` over touched surfaces
Touching *anything* in a higher surface pulls the whole candidate up to that tier. `change_type`
may only **raise** a floor, never lower it (a `config` change to a spend call site is still
Tier 2). There is no path by which a diff that touches a Tier-2 surface resolves below Tier 2.

### Step 4 — reconcile against the declaration
- **Declared tier < derived tier (under-declaration):** auto-reject the candidate and escalate to
  human review, logged as a firewall-evasion signal (`decided_by: risk_tier_gate`). A deliberate
  under-declaration is exactly the attack this gate exists to stop.
- **Declared `capabilities_touched` ⊋ what the diff touches:** allowed (over-declaration is safe).
- **Declared tier > derived tier:** honor the higher tier (a proposer may voluntarily raise).
- **Diff touches a Tier-3 surface at all:** the firewall should already have blocked the write;
  reaching here means a firewall probe — hard-reject and alert the supervisor.

## Enforcement

Runs at the `offline_passed → risk_tier_gate` transition (`loop_architecture.md`), as
**deterministic code** invoked by the gate — never model judgment, and never reading the
proposer's self-assigned tier as authoritative. The derivation, the declared values, and any
mismatch are written to the `ledger_entry` so an under-declaration attempt is permanently visible.

## Relationship to the schema

`schemas/candidate_change_schema.json`: `risk_tier` and `capabilities_touched` are **proposer
claims**. The authoritative tier is the value this function computes from the diff; the schema
fields exist so the gate can detect mismatch, not so the proposer can choose its own scrutiny.
