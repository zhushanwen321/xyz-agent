---
verdict: pass
must_fix: 0
---

# Spec Review — TUI Bridge Phase 0

**Spec**: `.xyz-harness/2026-06-05-tui-bridge-phase0/spec.md`
**Reviewer**: AI
**Date**: 2026-06-05

## 1. Spec Completeness

- FR coverage: All FR-1 through FR-9 map to concrete code changes in identified files
- AC mapping: Each AC item traces to specific FR requirements
- Constraints: C-1 through C-5 are well-scoped (no pi source changes, no GUI changes)
- File list: Spec estimates ~8 files (5 modify + 3 new tests) — matches codebase inspection

## 2. Codebase Alignment Verification

### 2.1 EventAdapter (src-electron/runtime/src/event-adapter.ts)

- FR-1: method editor not matched. Confirmed: only confirm/select/input/notify handled. editor/set_editor_text fall through to return null. Action: Add editor and set_editor_text matchers.
- FR-1: extension_error reads wrong field. Confirmed: event.extensionName used, pi sends extensionPath. Action: Fix to event.extensionPath.
- FR-2: message_start only checks customType. Confirmed: no role-based routing. Action: Add role-based routing for bashExecution/compactionSummary/branchSummary.
- FR-3: auto_retry/queue_update discarded. Confirmed: auto_retry_start/end explicitly return null; queue_update/session_info_changed/thinking_level_changed hit default warn. Action: Add handlers.
- FR-4: tool_execution_end doesn't extract images. Confirmed: only text content extracted. Action: Add image extraction.
- FR-4: tool_execution_update treats partialResult as string. Confirmed: detail uses string cast. Action: Extract details from object.
- FR-4: agent_end missing responseModel. Confirmed: only stopReason + usage forwarded. Action: Add responseModel/diagnostics fields.
- FR-5: message_update error sub-type discarded. Confirmed: default case logs warn. Action: Forward as message.stream_error.
- FR-6: setTitle not matched. Confirmed: not in extension_ui_request handler. Action: Add matcher.

### 2.2 Protocol (src-electron/shared/src/protocol.ts)

- ExtensionUIRequestPayload.method missing 'editor'. Current: 'confirm'/'select'/'input'/'notify'. Action: Add 'editor'.
- ServerMessageType missing 8 new types. Action: Add extension:setEditorText, message.bashExecution, message.compactionSummary, message.branchSummary, message.auto_retry_start, message.auto_retry_end, message.queue_update, message.stream_error, extension:setTitle.
- ExtensionErrorPayload missing errorEvent. Current: sessionId/extensionName/error. Action: Add errorEvent field.

### 2.3 Event Bus (src-electron/renderer/src/lib/event-bus.ts)

- on(event: string, handler) untyped. Confirmed: uses string. Action: Change to ServerMessageType + (msg: ServerMessage) => void.
- All handlers already (msg: ServerMessage) => void. Verified in useChat.ts. Migration is non-breaking.

### 2.4 useChat (src-electron/renderer/src/composables/useChat.ts)

- Missing 11 new handlers per FR-8. Current createGlobalHandlers() returns 13 handlers. Action: Add 11 new handlers.

### 2.5 ChatStore (src-electron/renderer/src/stores/chat.ts)

- Missing 5 optional fields per FR-9. Current ChatSessionState has no pendingEditorText/autoRetryState/queueState/thinkingLevel/responseModel. Action: Add fields + interfaces.

## 3. Risk Assessment

- EventAdapter regression: Medium — AC-5.1 requires all existing tests pass; comprehensive test coverage exists.
- event-bus type migration: Low — Handler signatures unchanged, type-only change.
- ChatStore field addition: Low — All fields optional, no serialization impact.
- New handler session isolation: Medium — AC-3.4 requires sessionId check; must test thoroughly.

## 4. Observations and Suggestions

1. FR-4 tool_execution_update details extraction: The spec says to extract partialResult.details but current code already extracts result.details in tool_execution_end. These are different fields (incremental vs final). Implementation should handle both correctly.

2. FR-2 message.message_start with display:false: The spec mentions adding details and display fields. The current message_start handler in onMessageStart() calls completeStreaming() but doesn't inspect customType/display from the payload. The handler should be extended to pass through these fields.

3. FR-8 onExtensionSetTitle uses window.electronAPI: This is renderer-specific API. Implementation needs to check if running in Electron context or gracefully degrade.

4. Test organization: New tests should follow the same createAdapter() + sent[] pattern for EventAdapter tests, and similar mock patterns for useChat tests.

## 5. Conclusion

The spec is well-structured, accurately describes the current codebase gaps, and provides clear acceptance criteria. The implementation is purely additive (no breaking changes) and well-scoped to Phase 0 constraints. Ready for implementation.
