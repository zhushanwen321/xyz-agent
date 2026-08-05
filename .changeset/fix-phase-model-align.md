---
"@zhushanwen/pi-subagent-workflow": patch
---

Fix-phase now consumes custom fixer.md `model` frontmatter field (was dropped — only global `--args model=` took effect). Aligns with review-phase semantics (`MODEL || def.model`). Also documents the `fixAgent` + convergence params (`maxFixAttempts`/`convergeNewIssues`/`convergeRounds`) in the workflow tool description so LLMs discover them.
