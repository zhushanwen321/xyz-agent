---
phase: pr
verdict: pass
---

# Overall Retrospect: TUI Bridge Phase 0

Covers all 5 phases: Spec → Plan → Dev → Test → PR.

## 1. Overall Phase Execution Review

### Summary

Delivered TUI Bridge Phase 0 (event translation layer) across 5 phases, producing 6 implementation commits, 53 new tests (643 total), and 27 executed integration TCs. PR #69 created, CI green after one fix.

### Phase-by-Phase Scorecard

| Phase | Duration Feel | Gate Retries | Key Problem |
|-------|--------------|-------------|-------------|
| Phase 1 (Spec) | Long | 5 | Skill symlink broken + YAML format trial |
| Phase 2 (Plan) | Medium | 1 | plan_review YAML format (complex → flat) |
| Phase 3 (Dev) | Long | 1 | Rate limit on ds-flash; pre-existing code not detected |
| Phase 4 (Test) | Short | 0 (after Phase 3 fix) | Review file `_v1` suffix missing |
| Phase 5 (PR) | Medium | 0 | CI TypeCheck failed → fixed event-bus overloads |

### What Went Well

1. **Plan quality was high.** The 4-task, 3-wave plan mapped cleanly to implementation. Task 1 (protocol types) was genuinely independent. Task 2 (EventAdapter) and Task 3 (event-bus) could be parallelized. Task 4 (useChat) depended on all prior tasks. No plan revision was needed during dev.

2. **Test-first co-development.** The test_cases_template.json (27 TCs) was written in Phase 2 and used to guide test writing in Phase 3. All 53 new tests were written alongside implementation, and all 27 TCs passed on first execution in Phase 4.

3. **Subagent dispatch for mechanical tasks.** Tasks 1–3 were dispatched to ds-flash subagents that returned correct implementations within 2–3 turns each. The implementer prompt template (read plan → implement → run tests → commit) is effective for well-scoped tasks.

4. **CI caught a real bug.** The TypeCheck CI step caught 13 TypeScript errors in downstream consumers that I had dismissed as "outside Phase 0 scope." The event-bus type hardening was too aggressive — it broke real consumers. The fix (adding `string` overloads with `any` handler type) was clean and backward-compatible.

### What Went Wrong

1. **Pre-existing implementation not detected (Phase 3).** Tasks 3–4 were already implemented from a prior coding session. I dispatched subagents that did redundant work (Task 3) or returned planning output instead of code (Task 4). A `git diff --stat` before dispatching would have saved 2 subagent calls and ~25% of dev phase time.

2. **Event-bus type hardening was a breaking change (Phase 3→5).** The strict `ServerMessageType` parameter on `on()/emit()/off()` looked correct in isolation but broke 11 consumer files. The Phase 3 dev retrospect noted "18 downstream TypeScript errors" as a risk for later phases, but I underestimated the severity — CI blocked the PR. The fix required adding string overloads, which partially defeats the type safety goal. A better approach: type-harden only the ServerMessage path, leave a `string` escape hatch from the start.

3. **Gate retries were dominated by format issues, not content issues.** Across all 5 phases, there were 7 gate failures total. Every single one was a format issue: YAML frontmatter type mismatch (`[]` vs `0`), missing field (`all_passing`), missing version suffix (`_v1`), complex YAML structure. None were content quality failures. This means the gates are effective format checkers but don't validate substance.

4. **Review writing overhead was high.** Phase 3 required 5 review files (taste, business_logic, integration, standards, robustness). Combined with test_results.md, that's 6 manually written documents. The content overlap between reviews was significant (e.g., business_logic and integration both discuss the same EventAdapter handlers). ~25% of dev phase time went to review writing.

### Risk Outcomes

| Risk (from dev retrospect) | Actual Outcome |
|---------------------------|---------------|
| 18 downstream TS errors | ✅ Confirmed — CI caught 13. Fixed in PR phase with string overloads + ToolCall.detail widening |
| Event-bus dual use issue | ✅ Confirmed — resolved by adding `string` overloads as escape hatch |
| No E2E test | ⚠ Still a gap. Acceptable for Phase 0 |

### Cumulative What Would You Do Differently

1. **Pre-flight `git log` + `tsc --noEmit` before dev dispatch.** Would have detected pre-existing implementation AND caught the downstream TS errors before committing.
2. **Use `_v1` suffix on ALL review files from Phase 3.** The convention was visible in Phase 1/2 outputs. Following it would have avoided the Phase 4 rename fix.
3. **Design backward-compatible type changes from the start.** Instead of strict `ServerMessageType` parameters, use overloaded signatures that accept both `ServerMessageType` (typed) and `string` (escape hatch). This prevents breaking downstream consumers while still providing type safety for new code.
4. **Consolidate dev review files from 5 to 2.** A single "code_review_v1.md" (combining business_logic + integration + robustness) and a single "style_review_v1.md" (combining taste + standards) would cover the same ground with less overhead.

## 2. Harness Usability Review (Overall)

### Cross-Cutting Issues

1. **YAML frontmatter requirements are undocumented per phase.** Each phase gate checks different YAML fields (`all_passing`, `pr_created`, `ci_passed`, `must_fix`), but the skill instructions don't list them. You learn by gate failure. A per-phase "YAML frontmatter required fields" table in each skill would eliminate this friction.

2. **Gate failures report one issue at a time.** When multiple format issues exist (e.g., missing field + wrong type + missing suffix), the gate fails on the first one found. Fix → retry → fail on next one. This multiplies the cost of format errors. Batching all issues into one error message would cut gate retries by ~60%.

3. **Review file naming convention (`_v1`) is implicit.** The convention appears in Phase 1/2 examples but isn't stated in Phase 3/4/5 skill instructions. Phase 3 wrote reviews without suffix; Phase 4 gate caught it. Should be documented in every phase that produces review files.

### What Worked

1. **Phase flow is logical.** Spec → Plan → Dev → Test → PR follows natural software development sequence. Each phase produces artifacts that the next phase consumes (spec → plan → code → tests → PR).

2. **Test template → execution traceability.** TCs defined in Phase 2 (`test_cases_template.json`) were executed in Phase 4 (`test_execution.json`) with 1:1 mapping. The cross-reference by `caseId` is clean and verifiable.

3. **CI integration.** The Phase 5 PR skill includes a CI pre-check step (check if CI is configured, run local lint) and a post-push CI monitoring step. This caught the TypeCheck failure before the PR was merged.

4. **Subagent-driven development for well-scoped tasks.** The implementer prompt template (read plan task → implement → run tests → commit) produced correct implementations for 3 of 4 tasks. The one failure (Task 4) was due to pre-existing code, not a prompt issue.

### What Needs Improvement

1. **Gate validates format, not substance.** Every gate failure was a format issue. No gate ever rejected content that was substantively incorrect. The review files could be empty (just YAML frontmatter) and pass. This is acceptable for L1 complexity but would be insufficient for L2/L3 where content quality matters more.

2. **No pre-existing code detection.** The harness assumes each task starts from a clean state. When code already exists (from a prior session, a previous branch, or a failed attempt), there's no mechanism to detect and skip completed work. A `git diff` pre-check would help.

3. **Review consolidation.** Five separate review files for Phase 3 is excessive for L1 complexity. The content overlap is significant (e.g., the EventAdapter handler analysis appears in business_logic, integration, and robustness reviews). Two review files would be sufficient.

4. **Model rate limit handling.** The ds-flash model hit its 5-hour token limit mid-dev phase. The harness has no built-in retry or fallback mechanism. Manual intervention (switch to glm-5.1, re-dispatch) was required. A model fallback config would help.

5. **Worktree + `gh pr create` incompatibility.** The git worktree setup (`feat-tui-bridge` is a worktree of the main bare repo) caused `gh pr create` to fail with "No commits between main and feat-tui-bridge." The fix was to push to the `github` remote explicitly and then create the PR. This is an environment-specific issue but worth documenting.

### Time Allocation (Overall)

| Phase | Estimated % |
|-------|------------|
| Phase 1 (Spec) | 10% |
| Phase 2 (Plan) | 20% |
| Phase 3 (Dev) | 35% |
| Phase 4 (Test) | 15% |
| Phase 5 (PR) | 20% |

The dev phase is the core value-add. The other 65% is documentation (spec review, plan, test template, 5 review files, test execution JSON, PR evidence, CI evidence). For L1 complexity, the documentation overhead is acceptable. For L2+, automation should reduce this ratio.

### Top 3 Recommendations for Harness Improvement

1. **Batch gate error reporting.** Report all format issues in one gate failure, not one at a time. This is the single highest-impact change.
2. **Per-phase YAML frontmatter spec.** Add a "Required YAML fields" table to each phase skill, listing exact field names, types, and allowed values.
3. **Automated test_execution.json generation.** Parse Vitest output and generate the JSON automatically. The manual transcription step is pure overhead with 27 TCs and would be unbearable with 100+.
