---
verdict: pass
must_fix: 0
---

# Integration Review — TUI Bridge Phase 0

## Scope

Verification that all components integrate correctly across the event pipeline: pi RPC → EventAdapter → WebSocket → event-bus → useChat → ChatStore.

## Pipeline Integration

### EventAdapter → Protocol Types
- All 9 new `ServerMessageType` values are used correctly in EventAdapter output
- `ExtensionUIRequestPayload.method` union extended to include `'editor'`
- `ExtensionErrorPayload.errorEvent` added and populated from `event.event`
- `ToolCallUpdatePayload.detail` accepts `Record<string, unknown>` for structured updates

### EventAdapter → WebSocket
- `createAdapter()` helper pattern verified: mock WsSender collects `sent[]` array
- 17 new tests confirm each event type produces the correct `ServerMessage` shape
- Existing 20 tests pass (no regression)

### Event-bus Type Chain
- `on()` accepts `ServerMessageType` (compile-time)
- `emit()` accepts `ServerMessageType` + `ServerMessage` (compile-time)
- Internal `Map<string, Set<EventHandler>>` unchanged (runtime-safe)
- 11 event-bus tests confirm dispatch/subscribe/unsubscribe behavior

### useChat → ChatStore
- 11 new handlers registered in `createGlobalHandlers()` return object
- Each handler extracts `sessionId` and calls the appropriate store method
- `registerGlobalListeners()` iterates handlers and registers with event-bus
- 25 useChat handler tests confirm correct store method calls

### ChatStore → Vue Reactivity
- 5 new optional fields on `ChatSessionState` are reactive via Pinia
- Setter methods trigger Vue reactivity correctly (direct property assignment on reactive object)
- `removeSession()` uses `Map.delete()` which Pinia tracks

## Cross-Component Type Consistency

| Type | Protocol | EventAdapter Output | Event-bus API | useChat Handler | ChatStore |
|------|----------|--------------------|--------------|-----------------|-----------|
| ServerMessageType | 9 new values | Uses all 9 | Parameter type | Object key | N/A |
| ServerMessage.payload | Defined | Constructed | Passed through | Extracted | N/A |
| AutoRetryState | N/A | N/A | N/A | Constructed | Stored |
| QueueState | N/A | N/A | N/A | Constructed | Stored |

All types are consistent across layers. No type mismatches found.

## Backward Compatibility

- Existing 13 event types unchanged in behavior
- Event-bus API narrowed (string → ServerMessageType) but all existing call sites compile (tested with 120 renderer tests)
- ChatStore new fields are optional — existing sessions unaffected
- `removeSession()` behavior unchanged (still deletes entire Map entry)
