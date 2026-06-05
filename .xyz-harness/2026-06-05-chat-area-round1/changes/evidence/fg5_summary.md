# FG5 Summary: Send Mode Status Bar & WS Protocol

## Execution Order & Commits

| Task | File | Commit | Status |
|------|------|--------|--------|
| 17 | `src-electron/shared/src/protocol.ts` | `d955e4f` | ✅ |
| 18 | `src-electron/runtime/src/server.ts` | `989f7b1` (revised in `de7f416`) | ✅ |
| 19 | `src-electron/renderer/src/components/chat/SendModeStatusBar.vue` | `b75b194` | ✅ |
| 20 | `src-electron/renderer/src/components/chat/ChatInput.vue` + `PanelSessionView.vue` | `de7f416` | ✅ |

## Changes Summary

### Task 17: Protocol Types
- Added `'message.steer' | 'message.follow_up'` to `ClientMessageType`
- Added payload types `{ sessionId: string; content: string }` for both in `ClientMessageMap`
- Added discriminated union variants in `ClientMessage`

### Task 18: Server Handler
- **`message.steer`**: Abort current AI processing (best-effort, session may not be active) then send new message via `sessionService.sendMessage()`
- **`message.follow_up`**: Queue message without interrupting — sends via `sessionService.sendMessage()` (pi queues internally)

### Task 19: SendModeStatusBar Component
- 20px height bar with 3 modes:
  - `send` → `Send · Enter 发送` (text-muted, gray)
  - `steer` → `Steer · 将中断当前 AI 处理` (text-accent)
  - `queue` → `Queue · Alt+Enter 排队` (text-warning)
- Props: `mode: SendMode`
- Exported `SendMode` type for consumers

### Task 20: ChatInput Integration
- **Alt key detection**: Global keydown/keyup listeners toggle `isAltPressed` ref
- **Send mode computed**: `isStreaming && isAltPressed → 'queue'`, `isStreaming → 'steer'`, `isAltPressed → 'queue'`, default → 'send'`
- **SendModeStatusBar** rendered above input area
- **canSend**: Updated to allow sending during streaming (steer/queue modes)
- **handleSend**: Emits `sendMode` in payload
- **PanelSessionView.handleSend**: Routes to correct WS message type:
  - `steer`: calls `abort()` then sends `message.steer`
  - `queue`: sends `message.follow_up`
  - `send`: uses existing `sendMessage()` flow

## Lint Results
- `npm run lint`: **0 errors, 0 new warnings** (4 pre-existing warnings in other files)

## AC11 Verification
- ✅ Streaming → send mode auto-switches to Steer (accent color status bar)
- ✅ Alt key press → switches to Queue (warning color status bar)
- ✅ Alt+Enter during streaming → sends with queue mode
- ✅ Enter during streaming → sends with steer mode
- ✅ Send button: idle ↑ accent / streaming ■ red (already implemented in InputToolbar)

## Files Modified/Created
| File | Action |
|------|--------|
| `src-electron/shared/src/protocol.ts` | Modified |
| `src-electron/runtime/src/server.ts` | Modified |
| `src-electron/renderer/src/components/chat/SendModeStatusBar.vue` | Created |
| `src-electron/renderer/src/components/chat/ChatInput.vue` | Modified |
| `src-electron/renderer/src/components/panel/PanelSessionView.vue` | Modified |
