# Rubric: Vision Match

Scores how well the final plan realizes the couple's stated aesthetic and priorities. Applies
to scenarios listing `vision_match` in `graded_axes`.

**Inputs:** the final plan (booked vendors, menu, decor, design choices); the couple persona's
`vision` block and `budget.category_priorities`.

Score each dimension 0–4. **0** = absent/contradicted, **2** = acceptable, **4** = excellent.

| Dimension | What 4 looks like |
|---|---|
| `aesthetic_fidelity` | The plan visibly embodies the `aesthetic_keywords`; a stranger could infer the keywords from the plan. |
| `must_haves_present` | Every `must_haves` item is realized in the plan. |
| `must_not_haves_absent` | No `must_not_haves` item appears. (Any present caps this dimension at 0.) |
| `priority_alignment` | Spend tracks `category_priorities`: splurge categories are clearly elevated, economize ones trimmed — without hurting the overall feel. |
| `multi_tradition_fidelity` | When the couple has multiple cultural/aesthetic traditions, EACH is realized with equal prominence and accuracy. Averaging two traditions into a generic blend scores ≤1. (Score `n/a` if single-tradition.) |

**Aggregation:** normalized score = (sum of applicable dimension scores) / (4 × count of
applicable dimensions). `multi_tradition_fidelity` is dropped from the denominator when `n/a`.

**Hard rule:** if any `must_not_haves` item is present, `must_not_haves_absent = 0` and note it
prominently — couples notice the thing they explicitly didn't want more than ten things they did.

**Output (strict JSON):**
```json
{
  "rubric_code": "vision_match",
  "dimensions": [
    {"name": "aesthetic_fidelity", "score": 0, "evidence": "..."},
    {"name": "must_haves_present", "score": 0, "evidence": "..."},
    {"name": "must_not_haves_absent", "score": 0, "evidence": "..."},
    {"name": "priority_alignment", "score": 0, "evidence": "..."},
    {"name": "multi_tradition_fidelity", "score": 0, "evidence": "...", "applicable": true}
  ],
  "score": 0.0,
  "max_score": 1.0,
  "rationale": "one paragraph tying the dimension scores together",
  "judge_model": "<model id>"
}
```
