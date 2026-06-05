---
verdict: pass
complexity: L1
---

# TUI Bridge Phase 0 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use xyz-harness-subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix EventAdapter event translation gaps and harden event-bus type safety so all pi RPC events are correctly forwarded to the GUI via WebSocket.

**Architecture:** The data flow is unidirectional: pi subprocess emits JSON-RPC events → `EventAdapter.translate()` maps each event to a typed `ServerMessage` → WebSocket sends to renderer → `event-bus` dispatches to `useChat` handlers → `ChatStore` stores state. This plan touches every layer of that pipe except the GUI components.

**Tech Stack:** TypeScript, Vitest, Vue 3 (composables + Pinia store), Node.js WebSocket

---

## Complexity Assessment

| Dimension | Assessment | Reason |
|-----------|-----------|--------|
| Domain impact | L1 | Extending existing event mapping, no new domain concepts |
| Storage impact | L1 | Adding optional fields to existing Pinia store, no persistence |
| Data flow | L1 | Simple synchronous translation, single-process |
| API impact | L1 | No REST API, just WS event type additions |
| Non-functional | L1 | No special perf/security requirements |

**Overall: L1** — single plan.md, no sub-document split needed.

---

## File Structure

| File | Type | Group | Description |
|------|------|-------|-------------|
| `src-electron/shared/src/protocol.ts` | modify | BG1 | Add 9 ServerMessageType values, update ExtensionUIRequestPayload, ExtensionErrorPayload |
| `src-electron/runtime/src/event-adapter.ts` | modify | BG1 | Add FR-1~FR-6 event handlers |
| `src-electron/runtime/test/event-adapter-new-events.test.ts` | create | BG1 | Tests for all new EventAdapter handlers (FR-1~FR-6) |
| `src-electron/renderer/src/lib/event-bus.ts` | modify | FG1 | FR-7: type signatures from `string` to `ServerMessageType` |
| `src-electron/renderer/src/stores/chat.ts` | modify | FG1 | FR-9: add optional fields + setter methods |
| `src-electron/renderer/src/composables/useChat.ts` | modify | FG1 | FR-8: add 11 new event handlers |
| `src-electron/renderer/src/lib/__tests__/event-bus.test.ts` | create | FG1 | Event-bus type safety tests |
| `src-electron/renderer/src/composables/__tests__/useChat-new-handlers.test.ts` | create | FG1 | Tests for new useChat handlers |

---

## Interface Contracts

### Module: shared/protocol

#### Type: ServerMessageType (union extension)

| Value Added | Purpose | Spec Ref |
|-------------|---------|----------|
| `'extension:setEditorText'` | Forward setEditorText from pi extension | FR-1 |
| `'extension:setTitle'` | Forward setTitle from pi extension | FR-6 |
| `'message.bashExecution'` | Forward bash execution message | FR-2 |
| `'message.compactionSummary'` | Forward compaction summary | FR-2 |
| `'message.branchSummary'` | Forward branch summary | FR-2 |
| `'message.auto_retry_start'` | Forward auto-retry start | FR-3 |
| `'message.auto_retry_end'` | Forward auto-retry end | FR-3 |
| `'message.queue_update'` | Forward queue update | FR-3 |
| `'message.stream_error'` | Forward stream error | FR-5 |

#### Interface: ExtensionUIRequestPayload

| Field | Change | Type | Spec Ref |
|-------|--------|------|----------|
| `method` | extend union | add `'editor'` to existing union | FR-1 |

#### Interface: ExtensionErrorPayload

| Field | Change | Type | Spec Ref |
|-------|--------|------|----------|
| `errorEvent` | add | `string \| undefined` | FR-1 |

#### Interface: ToolCallUpdatePayload

| Field | Change | Type | Spec Ref |
|-------|--------|------|----------|
| `detail` | extend | `string \| Record<string, unknown> \| undefined` | FR-4 |

### Module: runtime/event-adapter

#### Class: EventAdapter

| Method | Signature | Returns | Edge Cases | Spec Ref |
|--------|-----------|---------|------------|----------|
| translate | `(event: Record<string, unknown>) -> Promise<ServerMessage \| null>` | Translated message or null | Unknown event type returns null; missing fields use defaults | FR-1~FR-6 |

**New case branches in `translate()` switch:**

| pi event type | Output WS type | Key payload fields | Spec Ref |
|---------------|---------------|-------------------|----------|
| `extension_ui_request` (method='editor') | `extension.ui_request` | sessionId, requestId, method='editor', title, prefill | FR-1 |
| `extension_ui_request` (method='set_editor_text') | `extension:setEditorText` | sessionId, text | FR-1 |
| `extension_ui_request` (method='setTitle') | `extension:setTitle` | sessionId, title | FR-6 |
| `extension_error` | `extension.error` | sessionId, extensionName (from extensionPath), error, errorEvent | FR-1 |
| `message_start` (role='bashExecution') | `message.bashExecution` | sessionId, command, output, exitCode, ... | FR-2 |
| `message_start` (role='compactionSummary') | `message.compactionSummary` | sessionId, summary, tokensBefore | FR-2 |
| `message_start` (role='branchSummary') | `message.branchSummary` | sessionId, summary, fromId | FR-2 |
| `message_start` (with details/display) | `message.message_start` | sessionId, customType, content, details, display | FR-2 |
| `auto_retry_start` | `message.auto_retry_start` | sessionId, attempt, maxAttempts, delayMs, errorMessage | FR-3 |
| `auto_retry_end` | `message.auto_retry_end` | sessionId, success, attempt, finalError | FR-3 |
| `queue_update` | `message.queue_update` | sessionId, steering[], followUp[] | FR-3 |
| `session_info_changed` | `session.renamed` | sessionId, name | FR-3 |
| `thinking_level_changed` | `session.thinkingLevelSet` | sessionId, level | FR-3 |
| `tool_execution_end` (with images) | `message.tool_call_end` | sessionId, toolCallId, output, details, images | FR-4 |
| `tool_execution_update` (object partialResult) | `message.tool_call_update` | sessionId, toolCallId, detail (structured) | FR-4 |
| `agent_end` (with responseModel) | `message.complete` | sessionId, stopReason, usage, responseModel, diagnostics | FR-4 |
| `message_update` (type='error') | `message.stream_error` | sessionId, reason, content | FR-5 |

### Module: renderer/event-bus

#### Function signatures (FR-7)

| Function | Old Signature | New Signature |
|----------|---------------|---------------|
| on | `(event: string, handler: (...args: any[]) => void) => () => void` | `(event: ServerMessageType, handler: (msg: ServerMessage) => void) => () => void` |
| off | `(event: string, handler: (...args: any[]) => void) => void` | `(event: ServerMessageType, handler: (msg: ServerMessage) => void) => void` |
| emit | `(event: string, ...args: any[]) => void` | `(event: ServerMessageType, msg: ServerMessage) => void` |
| clear | `() => void` | `() => void` (unchanged) |

### Module: renderer/chat-store

#### Data: AutoRetryState

| Field | Type | Description |
|-------|------|-------------|
| active | `boolean` | Whether auto-retry is currently running |
| attempt | `number` | Current attempt number |
| maxAttempts | `number` | Maximum retry attempts |
| delayMs | `number` | Delay before next retry |
| errorMessage | `string \| undefined` | Error that triggered retry |

#### Data: QueueState

| Field | Type | Description |
|-------|------|-------------|
| steering | `string[]` | Steering messages in queue |
| followUp | `string[]` | Follow-up messages in queue |

#### Interface: ChatSessionState (extensions)

| Field | Type | Default | Spec Ref |
|-------|------|---------|----------|
| pendingEditorText | `string \| undefined` | undefined | FR-9 |
| autoRetryState | `AutoRetryState \| undefined` | undefined | FR-9 |
| queueState | `QueueState \| undefined` | undefined | FR-9 |
| thinkingLevel | `string \| undefined` | undefined | FR-9 |
| responseModel | `string \| undefined` | undefined | FR-9 |

#### Class: useChatStore (new methods)

| Method | Signature | Returns | Spec Ref |
|--------|-----------|---------|----------|
| setPendingEditorText | `(text: string \| undefined, sid: string) => void` | void | FR-9 |
| setAutoRetryState | `(state: AutoRetryState \| undefined, sid: string) => void` | void | FR-9 |
| setQueueState | `(state: QueueState \| undefined, sid: string) => void` | void | FR-9 |
| setThinkingLevel | `(level: string \| undefined, sid: string) => void` | void | FR-9 |
| setResponseModel | `(model: string \| undefined, sid: string) => void` | void | FR-9 |

### Module: renderer/useChat

#### Function: createGlobalHandlers (11 new entries)

| Handler Key | Handler Name | Store Operation | Spec Ref |
|-------------|-------------|-----------------|----------|
| `extension:setEditorText` | onSetEditorText | `store.setPendingEditorText(payload.text, sid)` | FR-8 |
| `message.bashExecution` | onBashExecution | `store.addMessage(systemNotification(...), sid)` | FR-8 |
| `message.compactionSummary` | onCompactionSummary | `store.addMessage(systemNotification(...), sid)` | FR-8 |
| `message.branchSummary` | onBranchSummary | `store.addMessage(systemNotification(...), sid)` | FR-8 |
| `message.auto_retry_start` | onAutoRetryStart | `store.setAutoRetryState({...}, sid)` | FR-8 |
| `message.auto_retry_end` | onAutoRetryEnd | `store.setAutoRetryState(undefined, sid)` | FR-8 |
| `message.queue_update` | onQueueUpdate | `store.setQueueState({...}, sid)` | FR-8 |
| `session.renamed` | onSessionRenamed | `sessionStore.renameSession(sid, payload.name)` | FR-8 |
| `session.thinkingLevelSet` | onThinkingLevelSet | `store.setThinkingLevel(payload.level, sid)` | FR-8 |
| `extension:setTitle` | onExtensionSetTitle | `window.electronAPI?.setTitle(payload.title)` | FR-8 |
| `message.stream_error` | onStreamError | `store.addMessage(systemNotification('alert', ...), sid)` | FR-8 |

---

## Spec Coverage Matrix

| Spec AC | Interface Method | Data Flow | Task |
|---------|-----------------|-----------|------|
| AC-1.1 | EventAdapter.translate (editor) | pi extension_ui_request → extension.ui_request | Task 2 |
| AC-1.2 | EventAdapter.translate (setEditorText) | pi extension_ui_request → extension:setEditorText | Task 2 |
| AC-1.3 | EventAdapter.translate (extension_error) | pi extension_error → extension.error (fixed field) | Task 2 |
| AC-1.4 | EventAdapter.translate (bashExecution) | pi message_start → message.bashExecution | Task 2 |
| AC-1.5 | EventAdapter.translate (compactionSummary) | pi message_start → message.compactionSummary | Task 2 |
| AC-1.6 | EventAdapter.translate (branchSummary) | pi message_start → message.branchSummary | Task 2 |
| AC-1.7 | EventAdapter.translate (auto_retry_start) | pi auto_retry_start → message.auto_retry_start | Task 2 |
| AC-1.8 | EventAdapter.translate (queue_update) | pi queue_update → message.queue_update | Task 2 |
| AC-1.9 | EventAdapter.translate (tool_execution_end images) | pi tool_execution_end → message.tool_call_end (images) | Task 2 |
| AC-1.10 | EventAdapter.translate (agent_end responseModel) | pi agent_end → message.complete (responseModel) | Task 2 |
| AC-1.11 | EventAdapter.translate (message_update error) | pi message_update → message.stream_error | Task 2 |
| AC-1.12 | EventAdapter.translate (session_info_changed) | pi session_info_changed → session.renamed | Task 2 |
| AC-1.13 | EventAdapter.translate (thinking_level_changed) | pi thinking_level_changed → session.thinkingLevelSet | Task 2 |
| AC-1.14 | EventAdapter.translate (setTitle) | pi extension_ui_request → extension:setTitle | Task 2 |
| AC-2.1 | event-bus.on | on(ServerMessageType, handler) compiles | Task 3 |
| AC-2.2 | event-bus.emit | emit(ServerMessageType, msg) compiles | Task 3 |
| AC-2.3 | event-bus.on | Invalid event type fails compilation | Task 3 |
| AC-2.4 | event-bus.on | All existing on() calls compile unchanged | Task 3 |
| AC-3.1 | useChat.onAutoRetryStart | ServerMessage → store.setAutoRetryState | Task 4 |
| AC-3.2 | useChat.onQueueUpdate | ServerMessage → store.setQueueState | Task 4 |
| AC-3.3 | useChat.onSessionRenamed | ServerMessage → sessionStore rename | Task 4 |
| AC-3.4 | useChat.* handlers | Missing sessionId → silent ignore | Task 4 |
| AC-4.1 | ChatStore.getSessionState | New fields absent on creation | Task 4 |
| AC-4.2 | ChatStore set* methods | Set/read/clear works | Task 4 |
| AC-4.3 | ChatStore.removeSession | Fields deleted with session | Task 4 |
| AC-5.1 | Existing EventAdapter tests | All 20 tests pass | Task 2 |
| AC-5.2 | Existing useChat tests | All 5 tests pass | Task 4 |
| AC-5.3 | Existing event flow | text_delta/tool_call etc. unaffected | Task 2, Task 4 |

---

## Spec Metrics Traceability

| Spec AC | 采纳状态 | 对应 Task |
|---------|---------|----------|
| AC-1.1 ~ AC-1.14 (EventAdapter translation) | adopted | Task 1 (types), Task 2 (handlers) |
| AC-2.1 ~ AC-2.4 (event-bus type safety) | adopted | Task 3 |
| AC-3.1 ~ AC-3.4 (useChat handler routing) | adopted | Task 4 |
| AC-4.1 ~ AC-4.3 (ChatStore new fields) | adopted | Task 4 |
| AC-5.1 ~ AC-5.3 (no regression) | adopted | Task 2, Task 3, Task 4 |

---

## Tasks

### Task 1: Protocol Type Extensions

**Type:** backend

**Files:**
- Modify: `src-electron/shared/src/protocol.ts`

**Description:** Add 9 new `ServerMessageType` values, extend `ExtensionUIRequestPayload.method` union to include `'editor'`, add `errorEvent` field to `ExtensionErrorPayload`, extend `ToolCallUpdatePayload.detail` type to support structured data.

**What changes in `src-electron/shared/src/protocol.ts`:**

1. **ServerMessageType** — add 9 values to the union type:
   - `'extension:setEditorText'`, `'extension:setTitle'`
   - `'message.bashExecution'`, `'message.compactionSummary'`, `'message.branchSummary'`
   - `'message.auto_retry_start'`, `'message.auto_retry_end'`, `'message.queue_update'`
   - `'message.stream_error'`

2. **ExtensionUIRequestPayload.method** — extend from `'confirm' | 'select' | 'input' | 'notify'` to `'confirm' | 'select' | 'input' | 'notify' | 'editor'`

3. **ExtensionErrorPayload** — add field: `errorEvent?: string`

4. **ToolCallUpdatePayload.detail** — change type from `string | undefined` to `string | Record<string, unknown> | undefined`

- [ ] **Step 1: Modify ServerMessageType union**

In `src-electron/shared/src/protocol.ts`, add the 9 new type literals to the `ServerMessageType` union. Insert after `'extension:widget' | 'extension:status'`:
```
'extension:setEditorText' | 'extension:setTitle' | 'message.bashExecution' | 'message.compactionSummary' | 'message.branchSummary' | 'message.auto_retry_start' | 'message.auto_retry_end' | 'message.queue_update' | 'message.stream_error'
```

- [ ] **Step 2: Extend ExtensionUIRequestPayload.method**

Change the method type in `ExtensionUIRequestPayload`:
```typescript
method: 'confirm' | 'select' | 'input' | 'notify' | 'editor'
```

- [ ] **Step 3: Add errorEvent to ExtensionErrorPayload**

```typescript
export interface ExtensionErrorPayload {
  sessionId: string
  extensionName: string
  error: string
  errorEvent?: string
}
```

- [ ] **Step 4: Extend ToolCallUpdatePayload.detail**

```typescript
export interface ToolCallUpdatePayload {
  sessionId: string
  toolCallId: string
  progress?: number
  detail?: string | Record<string, unknown>
}
```

- [ ] **Step 5: Verify compilation**

Run: `cd src-electron/runtime && npx tsc --noEmit`
Expected: PASS (no type errors)

- [ ] **Step 6: Verify existing tests still pass**

Run: `cd src-electron/runtime && npx vitest run test/event-adapter-bridge.test.ts test/event-adapter-extension.test.ts`
Expected: 20 tests pass

- [ ] **Step 7: Commit**

```bash
git add src-electron/shared/src/protocol.ts
git commit -m "feat(protocol): add ServerMessageType values for TUI Bridge Phase 0"
```

---

### Task 2: EventAdapter New Handlers (FR-1 through FR-6)

**Type:** backend

**Depends on:** Task 1

**Files:**
- Modify: `src-electron/runtime/src/event-adapter.ts`
- Create: `src-electron/runtime/test/event-adapter-new-events.test.ts`

**Description:** Implement all new event translation cases in EventAdapter's `translate()` method. Each new case reads specific fields from the pi RPC event and maps them to the corresponding `ServerMessage` type.

**Test expectations (in `event-adapter-new-events.test.ts`):**

The test file uses the same `createAdapter()` helper pattern from existing tests. Each test sends a pi event to the adapter and asserts the output `ServerMessage`.

| Test Name | Input Event | Expected Output |
|-----------|------------|-----------------|
| FR-1: editor method | `{type:'extension_ui_request', method:'editor', id:'r1', title:'Edit', prefill:'hello'}` | `{type:'extension.ui_request', payload:{method:'editor', title:'Edit', prefill:'hello'}}` |
| FR-1: setEditorText | `{type:'extension_ui_request', method:'set_editor_text', text:'new text'}` | `{type:'extension:setEditorText', payload:{text:'new text'}}` |
| FR-1: extension_error fixed field | `{type:'extension_error', extensionPath:'a/b/c.ts', error:'fail', event:'tool_execution'}` | `{type:'extension.error', payload:{extensionName:'a/b/c.ts', error:'fail', errorEvent:'tool_execution'}}` |
| FR-2: bashExecution role | `{type:'message_start', message:{role:'bashExecution', command:'ls', output:'file.txt', exitCode:0}}` | `{type:'message.bashExecution', payload:{command:'ls', output:'file.txt', exitCode:0}}` |
| FR-2: compactionSummary role | `{type:'message_start', message:{role:'compactionSummary', summary:'compacted', tokensBefore:50000}}` | `{type:'message.compactionSummary', payload:{summary:'compacted', tokensBefore:50000}}` |
| FR-2: branchSummary role | `{type:'message_start', message:{role:'branchSummary', summary:'branched', fromId:'e1'}}` | `{type:'message.branchSummary', payload:{summary:'branched', fromId:'e1'}}` |
| FR-2: customType with details/display | `{type:'message_start', message:{customType:'info', content:'hi', details:{k:'v'}, display:false}}` | `{type:'message.message_start', payload:{customType:'info', content:'hi', details:{k:'v'}, display:false}}` |
| FR-3: auto_retry_start | `{type:'auto_retry_start', attempt:2, maxAttempts:3, delayMs:1000, errorMessage:'timeout'}` | `{type:'message.auto_retry_start', payload:{attempt:2, maxAttempts:3, delayMs:1000, errorMessage:'timeout'}}` |
| FR-3: auto_retry_end | `{type:'auto_retry_end', success:true, attempt:3}` | `{type:'message.auto_retry_end', payload:{success:true, attempt:3}}` |
| FR-3: queue_update | `{type:'queue_update', steering:['s1'], followUp:['f1']}` | `{type:'message.queue_update', payload:{steering:['s1'], followUp:['f1']}}` |
| FR-3: session_info_changed | `{type:'session_info_changed', name:'new-name'}` | `{type:'session.renamed', payload:{name:'new-name'}}` |
| FR-3: thinking_level_changed | `{type:'thinking_level_changed', level:'high'}` | `{type:'session.thinkingLevelSet', payload:{level:'high'}}` |
| FR-4: tool_execution_end with images | `{type:'tool_execution_end', toolCallId:'tc1', result:{content:[{type:'text',text:'ok'},{type:'image',data:'base64',mimeType:'image/png'}]}}` | `{type:'message.tool_call_end', payload:{toolCallId:'tc1', output:'ok', images:[{data:'base64',mimeType:'image/png'}]}}` |
| FR-4: tool_execution_update structured | `{type:'tool_execution_update', toolCallId:'tc1', partialResult:{content:'running',details:{truncated:true}}}` | `{type:'message.tool_call_update', payload:{toolCallId:'tc1', detail:{content:'running',details:{truncated:true}}}}` |
| FR-4: agent_end responseModel | `{type:'agent_end', messages:[{stopReason:'stop',usage:{input:100,output:50},responseModel:'gpt-4o',diagnostics:{latency:1.2}}]}` | `{type:'message.complete', payload:{stopReason:'end_turn', usage:{inputTokens:100,outputTokens:50}, responseModel:'gpt-4o', diagnostics:{latency:1.2}}}` |
| FR-5: message_update error | `{type:'message_update', assistantMessageEvent:{type:'error', content:'aborted by user'}}` | `{type:'message.stream_error', payload:{reason:'error', content:'aborted by user'}}` |
| FR-6: setTitle | `{type:'extension_ui_request', method:'setTitle', title:'My Window'}` | `{type:'extension:setTitle', payload:{title:'My Window'}}` |

**Implementation changes in `src-electron/runtime/src/event-adapter.ts`:**

FR-1 (extension_ui_request additions): Add `'editor'` to the interactive methods if-chain, add `set_editor_text` match before the interactive methods block, add `setTitle` match.

FR-1 (extension_error): Change `event.extensionName` to `event.extensionPath`, add `errorEvent: event.event as string | undefined`.

FR-2 (message_start): Replace the current handler with role-based routing — check `msg.role` for bashExecution/compactionSummary/branchSummary before the existing customType check. Pass through `details` and `display` fields on custom messages.

FR-3 (new event types): Remove `auto_retry_start`/`auto_retry_end` from the null-return block. Add handlers for `auto_retry_start`, `auto_retry_end`, `queue_update`, `session_info_changed`, `thinking_level_changed`.

FR-4 (image extraction): In `tool_execution_end`, after text extraction, also extract `type:'image'` blocks into `images` array. In `tool_execution_update`, check if `partialResult` is an object and pass through. In `agent_end`, extract `lastMsg.responseModel` and `lastMsg.diagnostics`.

FR-5 (message_update error): Add `'error'` case to the `sub.type` switch in message_update handler.

FR-6 (setTitle): Add match in extension_ui_request handler.

- [ ] **Step 1: Write tests in `event-adapter-new-events.test.ts`**

Create test file following the `createAdapter()` + `piEvent()` pattern from existing tests. Each test sends a pi event, awaits flush, and asserts the sent `ServerMessage`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd src-electron/runtime && npx vitest run test/event-adapter-new-events.test.ts`
Expected: FAIL (handlers not implemented yet)

- [ ] **Step 3: Implement FR-1~FR-6 in event-adapter.ts**

Apply all changes described above to the `translate()` method.

- [ ] **Step 4: Run new tests to verify they pass**

Run: `cd src-electron/runtime && npx vitest run test/event-adapter-new-events.test.ts`
Expected: All 17 tests PASS

- [ ] **Step 5: Verify existing tests still pass (AC-5.1)**

Run: `cd src-electron/runtime && npx vitest run test/event-adapter-bridge.test.ts test/event-adapter-extension.test.ts`
Expected: 20 tests PASS

- [ ] **Step 6: Run all runtime tests**

Run: `cd src-electron/runtime && npx vitest run`
Expected: All tests PASS

- [ ] **Step 7: Commit**

```bash
git add src-electron/runtime/src/event-adapter.ts src-electron/runtime/test/event-adapter-new-events.test.ts
git commit -m "feat(event-adapter): add FR-1~FR-6 event handlers for TUI Bridge Phase 0"
```

---

### Task 3: Event-Bus Type Hardening (FR-7)

**Type:** frontend

**Depends on:** Task 1

**Files:**
- Modify: `src-electron/renderer/src/lib/event-bus.ts`
- Create: `src-electron/renderer/src/lib/__tests__/event-bus.test.ts`

**Description:** Replace `string` event types with `ServerMessageType` and `(...args: any[])` handler with `(msg: ServerMessage) => void`. Internal storage remains `Map<string, Set<EventHandler>>` for backward compatibility.

**Test expectations (in `event-bus.test.ts`):**

| Test Name | Behavior | AC Ref |
|-----------|----------|--------|
| on() accepts valid ServerMessageType | `on('message.text_delta', handler)` compiles and registers | AC-2.1 |
| emit() accepts valid ServerMessageType | `emit('message.text_delta', msg)` dispatches to handler | AC-2.2 |
| Invalid event type causes TS error | Compile-time verification (manual) | AC-2.3 |
| All existing on() calls unchanged | Existing useChat.ts listeners work without modification | AC-2.4 |
| off() removes handler | `off(type, handler)` removes from map | — |
| clear() removes all | `clear()` empties map | — |
| Multiple handlers on same event | Both handlers fire on emit | — |
| Handler error does not break others | Throwing handler → other handlers still execute | — |

**Implementation changes in `src-electron/renderer/src/lib/event-bus.ts`:**

1. Import `ServerMessageType` and `ServerMessage` from `@xyz-agent/shared`
2. Change `EventHandler` type from `(...args: any[]) => void` to `(msg: ServerMessage) => void`
3. Change `on(event: string, ...)` to `on(event: ServerMessageType, handler: (msg: ServerMessage) => void)`
4. Change `off(event: string, ...)` to `off(event: ServerMessageType, handler: (msg: ServerMessage) => void)`
5. Change `emit(event: string, ...args: any[])` to `emit(event: ServerMessageType, msg: ServerMessage)`
6. Internal `Map<string, Set<EventHandler>>` stays as `string` keys (avoid runtime breakage)
7. In `emit`, cast `event` to `string` for map lookup

- [ ] **Step 1: Write tests in `event-bus.test.ts`**

Test file mocks nothing — tests the real event-bus module. Use `on()`, `emit()`, `off()`, `clear()` with typed `ServerMessage` objects.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd src-electron/renderer && npx vitest run src/lib/__tests__/event-bus.test.ts`
Expected: FAIL (types not updated yet)

- [ ] **Step 3: Update event-bus.ts type signatures**

Apply the type changes described above. Keep internal implementation identical — only change public API type constraints.

- [ ] **Step 4: Run new tests**

Run: `cd src-electron/renderer && npx vitest run src/lib/__tests__/event-bus.test.ts`
Expected: PASS

- [ ] **Step 5: Verify existing renderer tests pass (AC-5.2)**

Run: `cd src-electron/renderer && npx vitest run src/composables/useChat.test.ts`
Expected: 5 tests PASS

- [ ] **Step 6: Commit**

```bash
git add src-electron/renderer/src/lib/event-bus.ts src-electron/renderer/src/lib/__tests__/event-bus.test.ts
git commit -m "feat(event-bus): type-harden on/emit/off with ServerMessageType (FR-7)"
```

---

### Task 4: ChatStore Fields + useChat Handlers (FR-8, FR-9)

**Type:** frontend

**Depends on:** Task 1, Task 3

**Files:**
- Modify: `src-electron/renderer/src/stores/chat.ts`
- Modify: `src-electron/renderer/src/composables/useChat.ts`
- Create: `src-electron/renderer/src/composables/__tests__/useChat-new-handlers.test.ts`

**Description:** Add 5 optional fields to `ChatSessionState` with setter methods. Add 11 new event handlers to `createGlobalHandlers()` in useChat.ts.

**ChatStore changes in `src-electron/renderer/src/stores/chat.ts`:**

1. Define `AutoRetryState` interface: `{ active: boolean; attempt: number; maxAttempts: number; delayMs: number; errorMessage?: string }`
2. Define `QueueState` interface: `{ steering: string[]; followUp: string[] }`
3. Add 5 optional fields to `ChatSessionState`: `pendingEditorText`, `autoRetryState`, `queueState`, `thinkingLevel`, `responseModel`
4. Default values in `createSessionState()`: all `undefined`
5. Add 5 setter methods: `setPendingEditorText`, `setAutoRetryState`, `setQueueState`, `setThinkingLevel`, `setResponseModel`
6. Export new interfaces from the store module
7. `removeSession()` already deletes entire state partition — no changes needed (AC-4.3 satisfied)

**useChat changes in `src-electron/renderer/src/composables/useChat.ts`:**

1. Import `AutoRetryState`, `QueueState` from chat store
2. Import `useSessionStore` (already imported)
3. Add 11 new handler functions in `createGlobalHandlers()`
4. Return extended handler map

Key handler behaviors:
- All handlers extract `sessionId` from `msg.payload` and call `store.getSessionState(sid)` — session isolation (AC-3.4)
- `onSessionRenamed` needs to update `sessionStore` — iterate `sessions` array to find matching session and update `name` field
- `onExtensionSetTitle` calls `window.electronAPI?.setTitle(payload.title)` with optional chaining for non-Electron environments
- `onAutoRetryStart` creates `AutoRetryState` object; `onAutoRetryEnd` sets it to `undefined`
- System message handlers (`onBashExecution`, `onCompactionSummary`, `onBranchSummary`, `onStreamError`) use `createSystemNotification()` pattern

**Test expectations (in `useChat-new-handlers.test.ts`):**

Uses the same mock pattern as existing `useChat.test.ts`: mock `ws-client`, `event-bus`, `chat` store, `session` store.

| Test Name | Event | Expected Store Effect |
|-----------|-------|----------------------|
| onSetEditorText routes to store | `{type:'extension:setEditorText', payload:{sessionId:'s1',text:'hi'}}` | `store.setPendingEditorText('hi', 's1')` called |
| onAutoRetryStart sets state | `{type:'message.auto_retry_start', payload:{sessionId:'s1',attempt:2,maxAttempts:3,delayMs:1000}}` | `store.setAutoRetryState({active:true,attempt:2,...})` called |
| onAutoRetryEnd clears state | `{type:'message.auto_retry_end', payload:{sessionId:'s1'}}` | `store.setAutoRetryState(undefined, 's1')` called |
| onQueueUpdate sets state | `{type:'message.queue_update', payload:{sessionId:'s1',steering:['m1']}}` | `store.setQueueState({steering:['m1'],followUp:[]})` called |
| onSessionRenamed updates store | `{type:'session.renamed', payload:{sessionId:'s1',name:'new'}}` | sessionStore session name updated |
| onThinkingLevelSet sets level | `{type:'session.thinkingLevelSet', payload:{sessionId:'s1',level:'high'}}` | `store.setThinkingLevel('high', 's1')` called |
| onExtensionSetTitle calls API | `{type:'extension:setTitle', payload:{title:'Win'}}` | `window.electronAPI.setTitle('Win')` called |
| onStreamError adds message | `{type:'message.stream_error', payload:{sessionId:'s1',content:'fail'}}` | `store.addMessage(...)` called with error notification |
| Session isolation: null sessionId | `{type:'message.auto_retry_start', payload:{}}` | No store methods called |
| Session isolation: wrong sessionId | `{type:'message.auto_retry_start', payload:{sessionId:'other'}}` | Only 'other' session affected |
| ChatStore: new fields default undefined | `store.getSessionState('new')` | All 5 fields are undefined |
| ChatStore: set/clear round-trip | `store.setAutoRetryState(...)` then `store.setAutoRetryState(undefined)` | Field goes from value to undefined |
| ChatStore: removeSession cleans up | `store.removeSession('s1')` after setting fields | Session gone, fields gone |

- [ ] **Step 1: Write tests in `useChat-new-handlers.test.ts`**

Create test file with mocked stores following existing pattern. Test all 11 handlers + ChatStore field operations.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd src-electron/renderer && npx vitest run src/composables/__tests__/useChat-new-handlers.test.ts`
Expected: FAIL (handlers not implemented yet)

- [ ] **Step 3: Add AutoRetryState, QueueState interfaces and ChatStore fields**

Edit `src-electron/renderer/src/stores/chat.ts` to add interfaces and optional fields.

- [ ] **Step 4: Add setter methods to ChatStore**

Add `setPendingEditorText`, `setAutoRetryState`, `setQueueState`, `setThinkingLevel`, `setResponseModel` to the store return object.

- [ ] **Step 5: Add 11 new handlers in useChat.ts**

Extend `createGlobalHandlers()` return object with all new handler functions.

- [ ] **Step 6: Run new tests**

Run: `cd src-electron/renderer && npx vitest run src/composables/__tests__/useChat-new-handlers.test.ts`
Expected: All 13 tests PASS

- [ ] **Step 7: Verify existing useChat tests pass (AC-5.2)**

Run: `cd src-electron/renderer && npx vitest run src/composables/useChat.test.ts`
Expected: 5 tests PASS

- [ ] **Step 8: Run all renderer tests**

Run: `cd src-electron/renderer && npx vitest run`
Expected: All tests PASS

- [ ] **Step 9: Commit**

```bash
git add src-electron/renderer/src/stores/chat.ts src-electron/renderer/src/composables/useChat.ts src-electron/renderer/src/composables/__tests__/useChat-new-handlers.test.ts
git commit -m "feat(renderer): add ChatStore fields + useChat handlers for TUI Bridge Phase 0 (FR-8, FR-9)"
```

---

## Execution Groups

#### BG1: EventAdapter Layer

**Description:** Protocol type definitions and EventAdapter translation handlers. These are the backend side — the sidecar process that translates pi RPC events into WebSocket ServerMessages. Tasks 1 and 2 are tightly coupled: Task 1 defines the types Task 2 consumes.

**Tasks:** Task 1, Task 2

**Files (预估):** 3 个文件（1 modify protocol + 1 modify event-adapter + 1 create test）

**Subagent 配置:**

| 配置项 | 值 |
|--------|---|
| Agent | general-purpose → general-purpose → general-purpose |
| Model | 按 taskComplexity 自动选择 |
| 注入上下文 | Task 1 + Task 2 描述、spec FR-1~FR-6、CONTEXT.md 术语（EventAdapter/RpcClient 定义） |
| 读取文件 | `src-electron/shared/src/protocol.ts`, `src-electron/runtime/src/event-adapter.ts`, `src-electron/runtime/test/event-adapter-bridge.test.ts`, `src-electron/runtime/test/event-adapter-extension.test.ts` |
| 修改/创建文件 | `src-electron/shared/src/protocol.ts`, `src-electron/runtime/src/event-adapter.ts`, `src-electron/runtime/test/event-adapter-new-events.test.ts` |

**Execution Flow (BG1 内部):** 串行派遣

  Task 1:
    1. general-purpose → 修改 protocol.ts 类型定义
    2. general-purpose → spec 合规检查（类型是否覆盖全部 9 个新值）

  Task 2 (depends on Task 1):
    1. general-purpose → 写测试文件 event-adapter-new-events.test.ts
    2. general-purpose → 实现 event-adapter.ts 所有 handler
    3. general-purpose → spec 合规检查（AC-1.1~AC-1.14 + AC-5.1）

**Dependencies:** 无

**设计细节:** 直接写在此处（L1）

#### FG1: Renderer Event Layer

**Description:** Frontend event bus type hardening and all new useChat handlers with ChatStore fields. These are the renderer-side changes. Task 3 (event-bus typing) must complete before Task 4 because useChat registers handlers via the typed `on()` function.

**Tasks:** Task 3, Task 4

**Files (预估):** 5 个文件（2 modify event-bus/useChat + 1 modify chat + 1 create event-bus test + 1 create useChat test）

**Subagent 配置:**

| 配置项 | 值 |
|--------|---|
| Agent | general-purpose → general-purpose |
| Model | 按 taskComplexity 自动选择 |
| 注入上下文 | Task 3 + Task 4 描述、spec FR-7~FR-9、ADR-0015（event-bus 类型加固决策） |
| 读取文件 | `src-electron/renderer/src/lib/event-bus.ts`, `src-electron/renderer/src/stores/chat.ts`, `src-electron/renderer/src/composables/useChat.ts`, `src-electron/renderer/src/stores/session.ts`, `docs/adr/0015-event-bus-typed-severmessagetype.md` |
| 修改/创建文件 | `src-electron/renderer/src/lib/event-bus.ts`, `src-electron/renderer/src/stores/chat.ts`, `src-electron/renderer/src/composables/useChat.ts`, `src-electron/renderer/src/lib/__tests__/event-bus.test.ts`, `src-electron/renderer/src/composables/__tests__/useChat-new-handlers.test.ts` |

**Execution Flow (FG1 内部):** 串行派遣

  Task 3:
    1. general-purpose → 写 event-bus 测试 + 修改 event-bus 类型
    2. general-purpose → spec 合规检查（AC-2.1~AC-2.4）

  Task 4 (depends on Task 3):
    1. general-purpose → 写 useChat-new-handlers 测试 + ChatStore 字段 + useChat handlers
    2. general-purpose → spec 合规检查（AC-3.1~AC-3.4 + AC-4.1~AC-4.3 + AC-5.2 + AC-5.3）

**Dependencies:** BG1 Task 1（需要 protocol.ts 的新类型定义）

**设计细节:** 直接写在此处（L1）

---

## Dependency Graph & Wave Schedule

```
  BG1.Task1 (protocol types)
       │
       ├──→ BG1.Task2 (EventAdapter handlers)
       │
       └──→ FG1.Task3 (event-bus typing) ──→ FG1.Task4 (ChatStore + useChat)
```

| Wave | Groups | 说明 |
|------|--------|------|
| Wave 1 | BG1 (Task 1) | Protocol 类型定义，无依赖 |
| Wave 2 | BG1 (Task 2), FG1 (Task 3) | BG1.Task2 依赖 Task 1 类型；FG1.Task3 依赖 Task 1 类型 |
| Wave 3 | FG1 (Task 4) | 依赖 FG1.Task3 (event-bus 类型就绪) |

---

## Self-Review Checklist

### Scope Coverage
- [x] AC-1.1~AC-1.14 → Task 1 (types) + Task 2 (handlers)
- [x] AC-2.1~AC-2.4 → Task 3
- [x] AC-3.1~AC-3.4 → Task 4
- [x] AC-4.1~AC-4.3 → Task 4
- [x] AC-5.1~AC-5.3 → Task 2, Task 3, Task 4
- [x] FR-1~FR-9 全部覆盖
- [x] C-1~C-5 约束全部遵守

### Placeholder Scan
- No "TBD", "TODO", "implement later"
- No "add validation" / "handle edge cases" without specifics
- All test expectations have concrete input/output

### Type Consistency
- `ServerMessageType` values match between protocol.ts additions and EventAdapter output types
- `AutoRetryState` / `QueueState` interfaces match between ChatStore definition and useChat handler construction
- `ExtensionErrorPayload.errorEvent` type matches what EventAdapter sets
- `ToolCallUpdatePayload.detail` extended type matches EventAdapter's structured output
