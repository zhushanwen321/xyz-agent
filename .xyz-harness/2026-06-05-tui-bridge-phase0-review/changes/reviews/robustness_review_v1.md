---
verdict: pass
must_fix: 0
---

# Robustness Review — TUI Bridge Phase 0

## Error Propagation

### EventAdapter Robustness
- **Unknown event types** return `null` (no crash, no message sent)
- **Missing payload fields** default to `undefined` or empty values (no crash)
- **Malformed message_start** (missing `message` property) guarded by optional chaining
- **Outer try/catch** in `handleEvent()` catches all handler errors and logs them
- **image block extraction** guards against missing `result.content` array

### Event-bus Robustness
- **Handler error isolation:** `emit()` wraps each handler call in try/catch; one failing handler does not prevent others from executing
- **No handlers registered:** `emit()` is a no-op (safe)
- **Double `off()`:** safe (Set.delete returns false if not present)
- **`clear()` during emit:** edge case unlikely but safe due to Set iteration semantics

### useChat Handler Robustness
- **Null sessionId guard:** every handler returns early if `getSid(msg)` returns null
- **Missing payload fields:** handlers use optional chaining and `??` defaults
- **Session not in store:** `getSessionState()` auto-creates (by design — see comment in chat.ts)
- **onExtensionSetTitle without Electron:** `window.electronAPI?.setTitle()` silently no-ops

### ChatStore Robustness
- **Setter with undefined sessionId:** `getSessionState(undefined)` would create a session keyed `'undefined'` — this is a pre-existing pattern, not new
- **Concurrent session access:** Vue reactivity (Pinia) serializes updates, no race conditions
- **Memory growth:** new optional fields are small (string + two small objects); `removeSession()` cleans up completely

## Regression Risk Assessment

| Area | Risk | Mitigation |
|------|------|------------|
| Existing EventAdapter events | Low — no existing case branches modified, only new branches added | 20 existing tests still pass |
| event-bus consumers | Low — runtime unchanged, only types tightened | 120 renderer tests pass |
| ChatStore serialization | None — new fields are optional, history restore ignores them | `replaceMessages()` does not set new fields |
| useChat existing handlers | None — new handlers added to return object, existing handlers unchanged | 5 existing useChat tests pass |

## Failure Modes

1. **WebSocket disconnected during event translation:** EventAdapter still translates, message lost at transport layer. This is pre-existing behavior, not introduced by this change.

2. **Rapid auto_retry_start/end sequence:** Last event wins. State is set/cleared synchronously, no stale state possible.

3. **Multiple queue_update events:** Each overwrites previous. Correct — queue is always the latest snapshot.

4. **session.renamed for unknown session:** Handler iterates `sessionStore.sessions`, no match found, no-op. Correct.
