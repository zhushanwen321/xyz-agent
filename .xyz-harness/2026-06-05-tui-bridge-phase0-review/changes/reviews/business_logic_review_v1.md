---
verdict: pass
must_fix: 0
---

# Business Logic Review — TUI Bridge Phase 0

## Scope

Review of the event translation logic and store state management for correctness against spec AC.

## EventAdapter Translation Correctness

| FR | pi Event | Output Type | Field Mapping | Verdict |
|----|----------|-------------|---------------|---------|
| FR-1 | extension_ui_request (editor) | extension.ui_request | method, title, prefill, requestId | ✅ Correct |
| FR-1 | extension_ui_request (set_editor_text) | extension:setEditorText | text, sessionId | ✅ Correct |
| FR-1 | extension_error | extension.error | extensionPath→extensionName, error, errorEvent | ✅ Fixed (was reading wrong field) |
| FR-2 | message_start (bashExecution) | message.bashExecution | command, output, exitCode, cancelled, truncated | ✅ Correct |
| FR-2 | message_start (compactionSummary) | message.compactionSummary | summary, tokensBefore | ✅ Correct |
| FR-2 | message_start (branchSummary) | message.branchSummary | summary, fromId | ✅ Correct |
| FR-3 | auto_retry_start | message.auto_retry_start | attempt, maxAttempts, delayMs, errorMessage | ✅ Correct |
| FR-3 | auto_retry_end | message.auto_retry_end | success, attempt, finalError | ✅ Correct |
| FR-3 | queue_update | message.queue_update | steering, followUp | ✅ Correct |
| FR-3 | session_info_changed | session.renamed | name | ✅ Correct |
| FR-3 | thinking_level_changed | session.thinkingLevelSet | level | ✅ Correct |
| FR-4 | tool_execution_end (images) | message.tool_call_end | toolCallId, output, images | ✅ Correct — extracts image blocks |
| FR-4 | tool_execution_update (object) | message.tool_call_update | toolCallId, detail (structured) | ✅ Correct |
| FR-4 | agent_end (responseModel) | message.complete | stopReason, usage, responseModel, diagnostics | ✅ Correct |
| FR-5 | message_update (error) | message.stream_error | reason, content | ✅ Correct |
| FR-6 | extension_ui_request (setTitle) | extension:setTitle | title | ✅ Correct |

## Store State Management

| Operation | Expected | Actual | Verdict |
|-----------|----------|--------|---------|
| New session defaults | All 5 new fields undefined | All undefined via createSessionState() | ✅ |
| setPendingEditorText | Sets text, undefined clears | Correct | ✅ |
| setAutoRetryState | Sets state, undefined clears | Correct | ✅ |
| setQueueState | Sets steering/followUp | Correct, defaults to empty arrays | ✅ |
| setThinkingLevel | Sets level | Correct | ✅ |
| setResponseModel | Sets model | Correct | ✅ |
| removeSession | All fields deleted | Map.delete() removes entire partition | ✅ |

## Session Isolation

All 11 new useChat handlers extract `sessionId` from `msg.payload` and return early if null. This matches the existing handler pattern and ensures per-session state isolation. Tested via `useChat-new-handlers.test.ts` (null sessionId test).

## Edge Cases

- **Missing optional fields:** Handlers use `?? ''` or `?? undefined` defaults when extracting payload fields. No crashes on malformed events.
- **Multiple rapid auto_retry_start:** Each call overwrites previous state — correct (only one retry active at a time).
- **auto_retry_end without prior start:** Sets to `undefined` — idempotent, no error.
