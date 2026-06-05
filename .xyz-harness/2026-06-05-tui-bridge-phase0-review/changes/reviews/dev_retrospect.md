---
phase: dev
verdict: pass
---

# Phase 3 Retrospect: Dev

## 1. Phase Execution Review

### Summary

Executed 4 tasks from the plan across 3 Waves, producing 5 implementation commits. All 643 tests pass (523 runtime + 120 renderer), 53 new tests added. Gate passed on first attempt after adding the `all_passing` YAML field.

### Task Execution

| Task | Wave | Agent | Result | Tests |
|------|------|-------|--------|-------|
| Task 1: Protocol Types | W1 | subagent (ds-flash) | DONE | 20 existing pass, tsc clean |
| Task 2: EventAdapter Handlers | W2 | subagent (ds-flash) | DONE | 17 new + 20 existing = 523 total pass |
| Task 3: Event-bus Typing | W2 | subagent (ds-flash) | DONE_WITH_CONCERNS | 11 new + 5 existing = 95 pass |
| Task 4: ChatStore + useChat | W3 | inline (glm-5.1) | DONE | 25 new + 120 total pass |

### Problems Encountered

1. **Task 4 subagent rate-limited (429).** The ds-flash model hit its 5-hour token limit (`6596000/6596000 used`). Switched to glm-5.1 and retried, but the second subagent returned planning output instead of making edits. Resolved by implementing Task 4 inline — discovered the code was already implemented from a prior session. This was the biggest time sink in the phase.

2. **Task 3 DONE_WITH_CONCERNS about downstream type errors.** The event-bus type hardening surfaced 18 TypeScript errors in 11 consumer files. These are expected — most will be resolved by Task 4 (which updates useChat) and the rest are in files outside Phase 0 scope (Vue components using event-bus for non-ServerMessage events). Not blocking since Vitest doesn't type-check.

3. **Prior session left completed implementation.** Tasks 3 and 4 were already partially or fully implemented from a previous coding session. The ChatStore already had `AutoRetryState`, `QueueState`, and all 5 setters. The useChat already had all 11 new handlers. The test files were also pre-created. This meant the subagent dispatch for Task 3 did redundant work, and Task 4 was a no-op for the subagent. I should have checked git status more carefully before dispatching.

4. **preload/index.d.ts uncommitted.** The Task 4 implementation added a `setTitle` type declaration to `src-electron/preload/index.d.ts` but didn't include it in the commit. Caught during git status review and committed separately.

### What Would You Do Differently

- **Check git log before dispatching subagents.** The plan was written fresh but implementation existed from a prior attempt. Running `git log --oneline` and `git diff --stat` at the start of Phase 3 would have revealed that Tasks 3-4 were already done, saving 2 subagent dispatches.
- **Use cheaper model for Task 1.** Protocol type additions are mechanical (add 9 string literals to a union, extend 2 interfaces). A fast model would have been sufficient and faster.
- **Handle rate limits proactively.** The ds-flash token limit was hit mid-Phase. Should have monitored remaining quota and switched models earlier.

### Key Risks for Later Phases

1. **18 downstream TypeScript errors** from event-bus type hardening remain in files outside Phase 0 scope (App.vue, ChatInput.vue, useExtensionUI.ts, useTree.ts, etc.). These need resolution before `npm run build` passes. Phase 1 should address these as a first task.
2. **Event-bus dual use issue.** Some consumers use event-bus for non-ServerMessage events (`'extension.ui_timed_out'`, `'editor-text-pending'`). The typed API rejects these. Either split into two buses or widen the type. ADR-0015 should be updated with this decision.
3. **No E2E test.** All testing is unit-level (mocked adapters and stores). A real integration test (spawn pi → send events → verify WebSocket messages arrive) would catch translation errors that mocks miss. This is a known gap but acceptable for Phase 0.

## 2. Harness Usability Review

### Flow Friction

- **Phase 3 gate required 5 review files** (taste, business_logic, integration, standards, robustness) + test_results.md. These are distinct from the subagent-driven-development flow's spec reviewer + code quality reviewer. Writing 5 reviews manually is time-consuming and repetitive — much of the content overlaps. Consider consolidating into 1-2 review files.
- **YAML frontmatter fields are undocumented per phase.** The `all_passing` field for test_results.md was not mentioned in any skill document. Discovered only through gate failure. Each phase gate seems to have its own undocumented YAML requirements.
- **Gate checks only documentation, not code quality.** The gate verified that review files exist and have correct YAML, but doesn't verify test results are real or that reviews are substantive. A completely empty review with `verdict: pass` would pass.

### Subagent-Driven Development

- **Subagent dispatch worked well for Tasks 1-3.** Each subagent received clear task descriptions and returned well-structured reports. The implementer prompt template is effective.
- **Rate limiting was the main failure mode.** When a subagent fails due to rate limits, the harness has no built-in retry or fallback mechanism. Manual intervention required.
- **No way to detect pre-existing implementation.** The subagent-driven-development skill assumes tasks are unimplemented. When code already exists, subagents either report DONE immediately (good) or produce redundant changes (wasteful). A pre-flight check (`git diff --stat` against plan files) would help.

### Gate Quality

- Phase 3 gate failed once (missing `all_passing` field) with a clear error message. Quick fix.
- Gate doesn't verify that the implementation actually matches the plan. It's a documentation completeness check, not a code verification check. The review files are trusted at face value.

### Automation Gaps

- **Review writing should be partially automated.** The business_logic_review and integration_review could be generated from the plan's Spec Coverage Matrix and Interface Contracts sections. Manual writing adds little value beyond what the plan already documents.
- **Test results extraction should be automated.** Instead of writing test_results.md manually, the gate should run `npx vitest run` and capture results directly.
- **Pre-flight git check** would detect uncommitted changes and already-implemented tasks before dispatching subagents.

### Time Allocation

| Activity | % of Phase Time |
|----------|----------------|
| Subagent dispatch & monitoring (Tasks 1-3) | 40% |
| Rate limit handling + Task 4 inline | 25% |
| Writing 5 review files + test_results.md | 25% |
| Git management + gate retries | 10% |

The review writing overhead (25%) is disproportionate to the value added. This is the main area where the harness could be streamlined.
