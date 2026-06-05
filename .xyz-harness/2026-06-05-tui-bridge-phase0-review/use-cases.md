---
verdict: pass
---

# Use Cases — TUI Bridge Phase 0

## UC-1: Extension Editor Request

**Actor:** pi Extension (via ctx.ui.editor())
**Preconditions:** Extension is loaded and running in pi subprocess; EventAdapter is attached to RpcClient; WebSocket connection to renderer is active.

**Main Flow:**
1. Extension calls `ctx.ui.editor({ title: 'Edit File', prefill: 'current content' })`
2. pi subprocess emits `extension_ui_request` event with `method: 'editor'`, `title`, `prefill`, and `id`
3. EventAdapter receives event, matches `method === 'editor'`
4. EventAdapter constructs `ServerMessage` with `type: 'extension.ui_request'`, payload includes `method: 'editor'`, `title`, `prefill`, `requestId`
5. ServerMessage is sent via WebSocket to renderer
6. Renderer event-bus dispatches to registered handler
7. useChat handler routes to ChatStore

**Alternative Paths:**
- **AP-1:** WebSocket disconnected → EventAdapter still translates, message lost (consistent with existing behavior)
- **AP-2:** `title` or `prefill` missing → EventAdapter passes `undefined` for missing fields

**Postconditions:** ServerMessage of type `extension.ui_request` with method `editor` is delivered to renderer.

**Module Boundaries:** pi extension → RpcClient → EventAdapter → WsSender → WebSocket → event-bus → useChat → ChatStore

**AC Coverage:** AC-1.1

---

## UC-2: Extension Set Editor Text

**Actor:** pi Extension (via ctx.ui.setEditorText())
**Preconditions:** Extension is loaded; EventAdapter attached; WebSocket active.

**Main Flow:**
1. Extension calls `ctx.ui.setEditorText('new content')`
2. pi subprocess emits `extension_ui_request` with `method: 'set_editor_text'`, `text: 'new content'`
3. EventAdapter matches `method === 'set_editor_text'`
4. EventAdapter constructs `ServerMessage` with `type: 'extension:setEditorText'`, payload: `{ sessionId, text }`
5. Message delivered to renderer via WebSocket
6. useChat `onSetEditorText` handler stores text in `ChatStore.sessionState.pendingEditorText`

**Alternative Paths:**
- **AP-1:** Empty text → stores empty string (valid state)
- **AP-2:** Multiple rapid calls → last value wins (idempotent overwrite)

**Postconditions:** `ChatStore.sessionState.pendingEditorText` equals the text from the event.

**Module Boundaries:** pi extension → EventAdapter → WebSocket → event-bus → useChat → ChatStore

**AC Coverage:** AC-1.2

---

## UC-3: Extension Error with Correct Field Mapping

**Actor:** pi Extension (error during execution)
**Preconditions:** Extension throws an error while handling a pi event.

**Main Flow:**
1. pi extension encounters error during event handling
2. pi subprocess emits `extension_error` with `extensionPath: 'a/b/c.ts'`, `error: 'Something failed'`, `event: 'tool_execution'`
3. EventAdapter reads `event.extensionPath` (NOT `event.extensionName`) for the extension name
4. EventAdapter reads `event.event` for the triggering event name
5. Constructs `ServerMessage` with `type: 'extension.error'`, payload: `{ extensionName: 'a/b/c.ts', error: 'Something failed', errorEvent: 'tool_execution' }`
6. Message delivered to renderer
7. useChat `onExtensionError` handler creates system notification in ChatStore

**Alternative Paths:**
- **AP-1:** `extensionPath` missing → falls back to empty string
- **AP-2:** `event` field missing → `errorEvent` is `undefined`

**Postconditions:** Frontend receives error notification with correct extension name and triggering event.

**Module Boundaries:** pi extension → EventAdapter → WebSocket → event-bus → useChat → ChatStore

**AC Coverage:** AC-1.3

---

## UC-4: Bash Execution Message Routing

**Actor:** pi Agent (bash tool output)
**Preconditions:** Agent is executing a bash command; EventAdapter attached.

**Main Flow:**
1. pi agent completes bash execution
2. pi subprocess emits `message_start` with `message.role: 'bashExecution'` containing `command`, `output`, `exitCode`, `cancelled`, `truncated`, `fullOutputPath`, `excludeFromContext`
3. EventAdapter checks `msg.role === 'bashExecution'`
4. Constructs `ServerMessage` with `type: 'message.bashExecution'`, full payload from message object
5. Message delivered to renderer
6. useChat `onBashExecution` handler creates system notification showing command and output

**Alternative Paths:**
- **AP-1:** Command cancelled → `cancelled: true` in payload
- **AP-2:** Output truncated → `truncated: true`, `fullOutputPath` points to full output file

**Postconditions:** Bash execution details displayed as system message in chat.

**Module Boundaries:** pi agent → EventAdapter → WebSocket → event-bus → useChat → ChatStore

**AC Coverage:** AC-1.4

---

## UC-5: Auto-Retry State Management

**Actor:** pi Engine (API error retry mechanism)
**Preconditions:** Model API call fails with retryable error; max retries configured.

**Main Flow:**
1. API call fails, pi engine initiates auto-retry
2. pi emits `auto_retry_start` with `attempt: 1`, `maxAttempts: 3`, `delayMs: 2000`, `errorMessage: 'Rate limit exceeded'`
3. EventAdapter translates to `message.auto_retry_start` ServerMessage
4. Renderer receives event, useChat `onAutoRetryStart` sets `ChatStore.sessionState.autoRetryState = { active: true, attempt: 1, maxAttempts: 3, delayMs: 2000, errorMessage: 'Rate limit exceeded' }`
5. UI can display retry progress indicator
6. Retry succeeds, pi emits `auto_retry_end` with `success: true`, `attempt: 1`
7. useChat `onAutoRetryEnd` clears state: `store.setAutoRetryState(undefined, sid)`

**Alternative Paths:**
- **AP-1:** All retries fail → `auto_retry_end` with `success: false`, `finalError: '...'`
- **AP-2:** Multiple auto-retry cycles → each cycle clears and resets state

**Postconditions:** autoRetryState reflects current retry status or is cleared.

**Module Boundaries:** pi engine → EventAdapter → WebSocket → event-bus → useChat → ChatStore

**AC Coverage:** AC-1.7, AC-3.1

---

## UC-6: Queue Update State Sync

**Actor:** pi Engine (message queuing)
**Preconditions:** pi has steering messages or follow-up tasks queued.

**Main Flow:**
1. pi engine updates its internal message queue
2. pi emits `queue_update` with `steering: ['Process the file', 'Run tests']`, `followUp: ['Commit changes']`
3. EventAdapter translates to `message.queue_update` ServerMessage
4. Renderer receives event, useChat `onQueueUpdate` sets `ChatStore.sessionState.queueState = { steering: [...], followUp: [...] }`
5. UI can display pending queue items

**Alternative Paths:**
- **AP-1:** Empty queue → both arrays empty
- **AP-2:** Only steering or only followUp → one array populated, other empty

**Postconditions:** queueState in ChatStore matches pi engine's queue.

**Module Boundaries:** pi engine → EventAdapter → WebSocket → event-bus → useChat → ChatStore

**AC Coverage:** AC-1.8, AC-3.2

---

## UC-7: Session Rename Event

**Actor:** User (renaming a session)
**Preconditions:** Session exists; user triggers rename action.

**Main Flow:**
1. pi engine changes session name internally
2. pi emits `session_info_changed` with `name: 'New Session Name'`
3. EventAdapter translates to `session.renamed` ServerMessage with `{ name: 'New Session Name' }`
4. Renderer receives event
5. useChat `onSessionRenamed` finds matching session in SessionStore and updates its `name` field

**Alternative Paths:**
- **AP-1:** Session not found in SessionStore → silently ignored (session may not be loaded)

**Postconditions:** SessionStore reflects the new session name.

**Module Boundaries:** pi engine → EventAdapter → WebSocket → event-bus → useChat → SessionStore

**AC Coverage:** AC-1.12, AC-3.3

---

## UC-8: Thinking Level Change

**Actor:** User or pi Engine (changing reasoning depth)
**Preconditions:** Session is active; thinking level is configurable.

**Main Flow:**
1. Thinking level is changed (via user setting or automatic adjustment)
2. pi emits `thinking_level_changed` with `level: 'high'`
3. EventAdapter translates to `session.thinkingLevelSet` ServerMessage
4. Renderer receives event
5. useChat `onThinkingLevelSet` stores level in `ChatStore.sessionState.thinkingLevel`

**Postconditions:** thinkingLevel in ChatStore matches current pi setting.

**Module Boundaries:** pi engine → EventAdapter → WebSocket → event-bus → useChat → ChatStore

**AC Coverage:** AC-1.13

---

## UC-9: Image Content Preservation in Tool Results

**Actor:** pi Agent (tool returning image data)
**Preconditions:** Agent executes a tool that returns image content (e.g., screenshot, chart generation).

**Main Flow:**
1. Tool execution completes with result containing image blocks
2. pi emits `tool_execution_end` with `result.content: [{ type: 'text', text: 'Done' }, { type: 'image', data: 'base64...', mimeType: 'image/png' }]`
3. EventAdapter extracts text blocks into `output` field (existing behavior)
4. EventAdapter additionally extracts image blocks into `images: [{ data: 'base64...', mimeType: 'image/png' }]`
5. Both `output` and `images` included in `message.tool_call_end` payload
6. Renderer can render image content inline with tool results

**Alternative Paths:**
- **AP-1:** No image blocks → `images` field omitted from payload
- **AP-2:** Multiple images → `images` array contains all image blocks

**Postconditions:** Tool call result in frontend includes both text output and image data.

**Module Boundaries:** pi agent → EventAdapter → WebSocket → renderer

**AC Coverage:** AC-1.9

---

## UC-10: Stream Error Handling

**Actor:** pi Engine (stream abort or error)
**Preconditions:** Agent is actively streaming a response.

**Main Flow:**
1. Error occurs during streaming (API error, content filter, etc.)
2. pi emits `message_update` with `assistantMessageEvent.type: 'error'` and error content
3. EventAdapter detects error sub-type
4. Constructs `ServerMessage` with `type: 'message.stream_error'`, payload: `{ reason: 'error', content: '...' }`
5. Renderer receives event
6. useChat `onStreamError` creates system notification in ChatStore

**Alternative Paths:**
- **AP-1:** User-initiated abort → reason may be 'aborted'
- **AP-2:** Content filter → reason is 'content_filter'

**Postconditions:** Error notification appears in chat stream.

**Module Boundaries:** pi engine → EventAdapter → WebSocket → event-bus → useChat → ChatStore

**AC Coverage:** AC-1.11

---

## UC-11: Event-Bus Type Safety Enforcement

**Actor:** Developer (compile-time)
**Preconditions:** TypeScript compilation active.

**Main Flow:**
1. Developer writes `on('message.text_delta', (msg: ServerMessage) => { ... })` — compiles successfully
2. Developer writes `emit('message.text_delta', { type: 'message.text_delta', payload: { delta: 'hi' } })` — compiles successfully
3. Developer accidentally writes `on('message.typo_delta', handler)` — TypeScript reports error: `'message.typo_delta' is not assignable to parameter of type 'ServerMessageType'`
4. All existing 13 handlers in useChat compile without any code changes

**Postconditions:** Compile-time protection against event type typos and mismatches.

**Module Boundaries:** TypeScript compiler → event-bus API → useChat consumers

**AC Coverage:** AC-2.1, AC-2.2, AC-2.3, AC-2.4

---

## UC-12: ChatStore Field Lifecycle

**Actor:** useChat handlers
**Preconditions:** Session exists in ChatStore.

**Main Flow:**
1. New session created via `getSessionState('s1')`
2. All 5 new fields (`pendingEditorText`, `autoRetryState`, `queueState`, `thinkingLevel`, `responseModel`) are `undefined`
3. Events arrive and populate fields via setter methods
4. Fields can be read by UI components
5. Fields can be cleared by setting to `undefined`
6. `removeSession('s1')` deletes entire state partition including all fields

**Alternative Paths:**
- **AP-1:** Session restored from history → new fields remain `undefined` (not persisted in history)

**Postconditions:** All 5 optional fields follow create-read-clear-delete lifecycle correctly.

**Module Boundaries:** ChatStore (Pinia reactive state)

**AC Coverage:** AC-4.1, AC-4.2, AC-4.3

---

## UC Coverage Mapping to Spec AC

| UC | AC Covered |
|----|-----------|
| UC-1 | AC-1.1 |
| UC-2 | AC-1.2 |
| UC-3 | AC-1.3 |
| UC-4 | AC-1.4 |
| UC-5 | AC-1.7, AC-3.1 |
| UC-6 | AC-1.8, AC-3.2 |
| UC-7 | AC-1.12, AC-3.3 |
| UC-8 | AC-1.13 |
| UC-9 | AC-1.9 |
| UC-10 | AC-1.11 |
| UC-11 | AC-2.1, AC-2.2, AC-2.3, AC-2.4 |
| UC-12 | AC-4.1, AC-4.2, AC-4.3 |

**AC not directly covered by UC (covered by tasks):** AC-1.5 (compactionSummary), AC-1.6 (branchSummary), AC-1.10 (responseModel), AC-1.14 (setTitle), AC-3.4 (session isolation), AC-5.1~AC-5.3 (no regression). These are tested via unit tests in Task 2 and Task 4.
