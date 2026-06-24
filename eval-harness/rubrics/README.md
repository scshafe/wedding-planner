# Rubrics

Two kinds of grading live here:

- **Deterministic gates** (`gate_checks.md`) — pass/fail checks computed from the run trace
  and persona ground truth. No model judgment. These are the veto gates; a breach forces
  `verdict = fail`.
- **LLM-judge rubrics** (`vision_match_rubric.md`, `comms_quality_rubric.md`,
  `intuitiveness_rubric.md`) — score the subjective axes a gate cannot capture. Each produces
  a normalized score, an explicit rationale, and records the judge model id so results are
  auditable and the judges themselves can be calibrated against human ratings.

## Why gates run first

A run can produce gorgeous, warm, perfectly-toned comms that contain a wrong ceremony time.
The rubric might love it; the gate fails it. Gates run first and dominate: no amount of rubric
score buys back a breached veto gate. The rubrics only differentiate *among runs that already
passed the gates*.

## Judge discipline (applies to all three LLM rubrics)

- Score each named dimension separately, then aggregate — never emit a single holistic number.
- Quote evidence from the trace for every dimension score. No evidence → score it as missing.
- Be calibrated, not generous. The midpoint is "acceptable," not "good."
- Output strictly as the JSON object each rubric specifies, so the scoring model can consume it.
- Periodically, a human-rated sample is compared against judge output; drift means recalibrate
  the rubric or swap the judge model. A judge that can't track humans is not a valid grader.
