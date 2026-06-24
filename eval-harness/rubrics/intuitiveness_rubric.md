# Rubric: Intuitiveness

Scores how effortless the product felt for the couple, judged from the run transcript (the
couple role-player's interactions, confusion, and corrections). Applies to scenarios listing
`intuitiveness` in `graded_axes`.

**Inputs:** the full couple-facing interaction trace; the couple persona's `decision_style`,
`effort_budget`, and `simulation_behavior.clarity`.

Score each dimension 0–4.

| Dimension | What 4 looks like |
|---|---|
| `intent_understood` | The product correctly grasped what the couple wanted, including from vague or contradictory input, without repeated re-explanation. |
| `clarification_efficiency` | It asked the *few right* questions, batched sensibly — neither interrogated the couple nor guessed wrong silently. |
| `recovery_from_misread` | When it did misread intent, it recovered gracefully on the couple's first correction. |
| `cognitive_load` | The couple was shown decisions at the right altitude and cadence — not a wall of options, not buried autonomy they wanted to control. Calibrated to `decision_style`. |
| `progress_legibility` | At any point the couple could tell what's done, what's pending, and what's next. |

**Calibration to persona:** a `wants_control` couple shown too much autonomy scores low on
`cognitive_load`; a `delegating` couple asked to decide trivia scores low on the same
dimension. Judge against what *this* couple wanted, not a universal ideal.

**Aggregation:** normalized score = sum / (4 × 5).

**Output (strict JSON):**
```json
{
  "rubric_code": "intuitiveness",
  "dimensions": [
    {"name": "intent_understood", "score": 0, "evidence": "..."},
    {"name": "clarification_efficiency", "score": 0, "evidence": "..."},
    {"name": "recovery_from_misread", "score": 0, "evidence": "..."},
    {"name": "cognitive_load", "score": 0, "evidence": "..."},
    {"name": "progress_legibility", "score": 0, "evidence": "..."}
  ],
  "score": 0.0,
  "max_score": 1.0,
  "rationale": "one paragraph",
  "judge_model": "<model id>"
}
```
