---
"@zhushanwen/pi-subagent-workflow": major
---

reviewer agent renamed to code-reviewer (BREAKING). Enhanced review agents with adversarial stance, root-cause vs symptom check, and systematic side-effect auditing.

- **reviewer → code-reviewer** rename (breaking: `batch1=reviewer` / `agent: "reviewer"` no longer resolves). Major bump.
- **code-reviewer**: adversarial default-suspicion stance, core-logic-first prioritization over trivia, systematic side-effects & omissions checklist (callers / error-reset / async / blast radius).
- **oracle**: upgraded from checklist matcher to root-cause auditor — adversarial stance, root-cause vs symptom judgment (treats-symptom red flags), sibling-requirement drift check.
- **doc-reviewer**: adversarial stance (verify every claim against source), strengthened Pass 2 mechanism tracing.
- review-business-logic (project agent, not published): adversarial stance, root-cause category, systematic side-effects checklist.

Note: source version (5.0.2) lags behind published npm (6.0.0). Sync with main before running changeset:version so major bump resolves to 7.0.0, not 6.0.0.
