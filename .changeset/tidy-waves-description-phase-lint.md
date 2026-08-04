---
"@zhushanwen/pi-subagent-workflow": major
---

Add workflow-script lint warnings: missing agent() description (nodes unnamed in TUI), meta.phases as object array (ignored by engine), declared phases vs phase() calls mismatch; document description + phase display conventions in workflow-script-format SKILL.md.

**Breaking change — review-fix-loop built-in workflow behavior (vs 4.0.0):**

1. **No default batch**: 4.0.0 defaulted to a single `["reviewer"]` batch when no `batch1..batchN`/`agents` args were passed. Now `batch1..batchN` or `agents` is **required** — invoking without them fails fast with `缺少批次参数`. Update existing invocations to pass an explicit batch.
2. **`recheckAfterFix` default flipped false → true**: after a fix round, all agents (including previously clean ones) are re-dispatched for regression protection. Pass `recheckAfterFix=false` to restore 4.0.0 behavior (skips clean-agent re-review — weaker regression protection, at your own risk).
3. `meta.phases` changed from object array to string array (`["Review", "Fix"]`) per the new lint rule.
4. Pure functions (arg validation / batch parsing / aggregation parsing / review-instruction building) extracted into `review-fix-loop-utils.cjs` with vitest coverage — no behavior change, internal refactor.

The implementation intentionally diverges from main's 4.0.0 version (branch version keeps the utils module + tests + `fallow-scan` support). The two versions conflict on merge (add/add); resolve keeping this branch's version.
