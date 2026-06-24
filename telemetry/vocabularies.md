# Vocabularies

The controlled string vocabularies used across telemetry events. This file is the **single
source of truth** — the reference-table pattern in place of scattered enums. Schemas and
catalogs reference these lists; when a value must be added, add it here first.

## phase
The wedding planning lifecycle. Every event is stamped with the phase it occurred in.

| value | meaning |
|---|---|
| `discovery` | Gathering vision, budget, constraints, guest list. |
| `shortlist` | Comparing options, holding candidates. |
| `booking` | Making binding commitments. |
| `invitations_sent` | Invitations designed and dispatched. |
| `rsvp_window` | Collecting RSVPs, answering guest questions. |
| `final_week` | Final logistics, last-minute changes. |
| `day_of` | The wedding day. |
| `post` | Thank-yous, vendor closeout. |

## capability
Which product capability emitted the event. Powers `per_capability_scorecard`.

`venue` · `catering` · `music` · `invitations` · `rsvp` · `guest_qa` · `seating` ·
`comms_personalization` · `budget_management` · `integration` · `orchestration`

## actor
`couple` · `guest` · `ai` · `vendor` · `system`

## source
`eval` (from an eval-harness run) · `production` (from the live product). Schema is identical.

## commitment_status
The lifecycle of a binding commitment (one `commitment_payload` covers all of these).

`proposed` → `escalated` → `approved` | `declined` → `executed` | `failed`; or
`proposed` → `auto_executed` → `executed` (the opted-in autonomy path).

## escalation_reason
Why a commitment was escalated to propose-confirm instead of auto-executing.

`out_of_scope` · `over_cap` · `non_refundable` · `over_budget` · `requires_couple` · `policy`

## fact_type
Categories of wedding fact asserted to guests (fact-checked for `COMMS.FALSE_FACT_TO_GUEST`).
These are wedding facts, not PII — stored verbatim.

`ceremony_time` · `ceremony_date` · `venue_address` · `reception_time` · `dress_code` ·
`menu_item` · `allergy_safety` · `accommodation` · `parking` · `accessibility` · `registry`

## boundary_type
A boundary a guest may test in communication.

`surprise` · `plus_one` · `privacy` · `guest_list`

## channel
`email` · `sms` · `whatsapp` · `postal` · `phone`

## answerable_by
Ground-truth handling for a guest question (mirrors the guest persona schema).

`ai_from_known_facts` (AI should answer) · `requires_couple` (AI should escalate) ·
`must_refuse` (AI should decline, e.g. surprise/privacy).

## action_taken
What the product actually did with a guest question: `answered` · `escalated` · `refused`.

## integration_result_status
`attempted` · `confirmed` · `failed`. A `claimed_status=confirmed` with
`verified_status!=confirmed` is a silent failure.

## rsvp_status
`pending` · `yes` · `no` · `maybe`

## constraint_type
`date` · `guest_count` · `budget` · `allergy` · `accessibility` · `cultural` · `religious` ·
`dietary` · `other`

## severity
`fatal` (could harm a guest, e.g. anaphylaxis) · `serious` · `moderate`
