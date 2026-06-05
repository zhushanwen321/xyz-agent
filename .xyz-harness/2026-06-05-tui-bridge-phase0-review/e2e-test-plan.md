---
verdict: pass
---

# E2E Test Plan — TUI Bridge Phase 0

## Test Scenarios

### Scenario 1: Extension editor method flows end-to-end
**Covers:** AC-1.1, AC-1.2, AC-1.14
**Steps:**
1. Spawn a pi subprocess in RPC mode
2. Trigger `ctx.ui.editor()` from an extension → verify `extension.ui_request` (method='editor') arrives at frontend
3. Trigger `ctx.ui.setEditorText('hello')` → verify `extension:setEditorText` arrives with text='hello'
4. Trigger `ctx.ui.setTitle('My Title')` → verify `extension:setTitle` arrives with title='My Title'

### Scenario 2: Role-based message routing
**Covers:** AC-1.4, AC-1.5, AC-1.6
**Steps:**
1. Send a message that triggers a bash execution → verify `message.bashExecution` arrives with command, output, exitCode
2. Trigger a context compaction → verify `message.compactionSummary` arrives with summary and tokensBefore
3. Trigger a branch/fork → verify `message.branchSummary` arrives with summary and fromId

### Scenario 3: Auto-retry and queue events
**Covers:** AC-1.7, AC-1.8
**Steps:**
1. Cause a transient API error that triggers auto-retry → verify `message.auto_retry_start` with attempt/maxAttempts, then `message.auto_retry_end` with success=true
2. Trigger a queue update with steering messages → verify `message.queue_update` with steering array

### Scenario 4: Session lifecycle events
**Covers:** AC-1.3, AC-1.12, AC-1.13
**Steps:**
1. Trigger an extension error → verify `extension.error` with correct extensionPath and errorEvent
2. Rename a session → verify `session.renamed` arrives with new name
3. Change thinking level → verify `session.thinkingLevelSet` arrives with level

### Scenario 5: Rich content preservation
**Covers:** AC-1.9, AC-1.10, AC-1.11
**Steps:**
1. Execute a tool that returns image content → verify `message.tool_call_end` payload contains images array
2. Complete an agent turn with responseModel → verify `message.complete` contains responseModel field
3. Trigger a stream error (abort mid-stream) → verify `message.stream_error` arrives with error content

### Scenario 6: Event-bus type safety
**Covers:** AC-2.1~AC-2.4
**Steps:**
1. Verify TypeScript compilation passes with typed event-bus (no `any` escapes)
2. Verify all existing event listeners in useChat compile without modification
3. Verify that passing a non-ServerMessageType string to `on()` causes a compile error

### Scenario 7: Frontend store state management
**Covers:** AC-3.1~AC-3.4, AC-4.1~AC-4.3
**Steps:**
1. Send auto_retry_start event → verify ChatStore.autoRetryState populated correctly
2. Send auto_retry_end event → verify autoRetryState cleared
3. Send queue_update event → verify queueState populated
4. Send event with wrong sessionId → verify target session unaffected (isolation)
5. Create new session → verify all 5 new fields are undefined
6. Remove session → verify all fields cleaned up

### Scenario 8: No regression
**Covers:** AC-5.1~AC-5.3
**Steps:**
1. Run full existing test suite → all 20 EventAdapter tests pass
2. Run full existing useChat tests → all 5 tests pass
3. Send existing event types (text_delta, tool_call_start/end) → behavior unchanged

## Test Environment

- **Runtime tests:** Vitest in `src-electron/runtime/` — mock RpcClient, real EventAdapter logic
- **Renderer tests:** Vitest + happy-dom in `src-electron/renderer/` — mock ws-client and stores, real event-bus + useChat logic
- **Type checking:** `tsc --noEmit` in both runtime and renderer directories
- **Full suite:** `npx vitest run` in each test directory
- **Prerequisites:** Node.js, dependencies installed (`npm install` in project root)
