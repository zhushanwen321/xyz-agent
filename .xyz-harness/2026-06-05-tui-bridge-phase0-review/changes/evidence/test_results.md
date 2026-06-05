---
phase: test
verdict: pass
all_passing: true
---

# Test Results — TUI Bridge Phase 0

## Phase 3 Results (Unit Tests)

### Runtime Tests
**Command:** `cd src-electron/runtime && npx vitest run`
**Result:** 50 test files, 523 tests passed, 0 failed

### Renderer Tests
**Command:** `cd src-electron/renderer && npx vitest run`
**Result:** 13 test files, 120 tests passed, 0 failed

## Phase 4 Results (Integration/Functional Test Execution)

**Test Template:** 27 test cases in test_cases_template.json
**Execution Record:** 27/27 passed, round 1, 0 failures

### TC Coverage by FR

| FR | TCs | Result |
|----|-----|--------|
| FR-1 (extension UI) | TC-1-01, TC-1-02, TC-1-03 | 3/3 pass |
| FR-2 (message_start roles) | TC-1-04, TC-1-05, TC-1-06 | 3/3 pass |
| FR-3 (retry/queue/session) | TC-1-07, TC-1-08, TC-1-12, TC-1-13 | 4/4 pass |
| FR-4 (tool call enrichments) | TC-1-09, TC-1-10 | 2/2 pass |
| FR-5 (stream error) | TC-1-11 | 1/1 pass |
| FR-6 (setTitle) | TC-1-14 | 1/1 pass |
| FR-7 (event-bus typing) | TC-2-01, TC-2-02, TC-2-03 | 3/3 pass |
| FR-8 (ChatStore fields) | TC-3-01~04, TC-4-01~03 | 7/7 pass |
| FR-9 (useChat handlers) | TC-3-01~04 | 4/4 pass |
| Regression | TC-5-01, TC-5-02, TC-5-03 | 3/3 pass |

### Total Summary
- **Total automated tests:** 643 (523 runtime + 120 renderer)
- **Total TCs executed:** 27/27 passed
- **Zero failures, zero regressions**
