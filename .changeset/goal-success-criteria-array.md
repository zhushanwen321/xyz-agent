---
'@zhushanwen/pi-goal': minor
---

**goal: successCriteria as a structured list with per-item status**

- `successCriteria` is now a `string[]` (previously a single free-form string), rendered as a numbered checklist with per-item completion status
- Legacy single-string goals migrate transparently: criteria are split by lines with defensive normalization, no user action needed
- Plan-initiated goals display one summary line plus numbered step previews instead of one long concatenated string
