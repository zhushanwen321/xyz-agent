---
'@zhushanwen/pi-plan': patch
---

**plan: successCriteria built as summary plus numbered step previews**

- `buildPlanSuccessCriteria` now returns a structured list — one summary line (`All N steps of <plan> executed and verified`) plus up to 3 numbered step previews — instead of a single concatenated string
- Each preview is truncated to 80 chars and collapsed to a single line, matching the goal-side schema and handler constraints
