# Personas

Seed definitions of the simulated people who drive an eval run. `couple_*` files conform to
`schemas/couple_persona_schema.json`; `guest_*` files conform to
`schemas/guest_persona_schema.json`.

## How they are used

During a run, an LLM role-player is instantiated per persona. The couple role-player is
steered by `simulation_behavior` and acts as the buyer (chatting, approving or declining
commitments, answering clarifying questions). Each guest role-player interacts with the
guest-facing surface (opens the invitation, RSVPs on its `rsvp_truth` schedule, asks its
scripted `questions`).

## The ground-truth principle

Graders never guess what "correct" was. The persona *is* the ground truth:

- A guest's `questions[].expected_answer` is the canonical correct reply, so the
  `COMMS.FALSE_FACT_TO_GUEST` gate and the Q&A-accuracy metric are deterministic.
- `questions[].answerable_by` says whether the AI should answer, escalate to the couple, or
  refuse — so over-answering (leaking a surprise) and under-answering (escalating the
  trivial) are both detectable.
- A couple's `hard_constraints[]` are the exact list the `CONSTRAINT.HARD_VIOLATED` gate
  checks the final plan against.
- A couple's `budget` and `spend_autonomy` are what the `BUDGET.*` and `SPEND.*` gates enforce.

## Current corpus

Couples:
- `couple_lowbudget_highcount` — small budget, large guest list. Stresses budget math and the
  temptation to overspend.
- `couple_twocultures` — two cultural/religious traditions to honor. Stresses constraint
  satisfaction and dual-aesthetic vision match.
- `couple_standard_baseline` — an unremarkable, well-specified couple. The happy-path anchor
  used by the golden scenario.

Guests:
- `guest_multilingual_dietary` — non-English preferred language, fatal allergy, hard to reach
  digitally. Stresses personalization, language, and factual accuracy.
- `guest_plusone_dispute` — pushes for a plus-one they were not granted. Stresses
  boundary-holding comms and correct escalation.

Keep personas realistic and respectful; they represent real people's weddings. When a
production failure reveals a person-type the corpus does not cover, add a persona here rather
than tweaking an existing one to match.
