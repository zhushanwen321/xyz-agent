# Infrastructure Scan: Runtime + Renderer Architecture Quality

**Date**: 2026-05-22 | **Worktree**: refactor-system-impr | **Scope**: Runtime + Renderer + Shared

---

## 1. Project Structure

### Directory Layout

```
src-electron/
├── runtime/src/           (3,518 lines, 15 files) — Node.js sidecar
│   ├── index.ts           (51)   — Entry point, CLI arg parsing, graceful shutdown
│   ├── server.ts          (574)  — WS server, message routing, broadcast
│   ├── session-pool.ts    (600)  — Session lifecycle, WS client mgmt, history conversion
│   ├── rpc-client.ts      (344)  — pi subprocess IPC (JSON-RPC over stdio)
│   ├── event-adapter.ts   (271)  — pi event → ServerMessage translation
│   ├── process-manager.ts (237)  — pi process spawn/kill/lookup
│   ├── config-store.ts    (234)  — File-based config, skills, agents persistence
│   ├── pi-rpc-types.ts    (384)  — pi RPC type definitions (DEAD FILE)
│   ├── model-db.ts        (150)  — Model metadata lookup
│   ├── session-scanner.ts (133)  — Scan ~/.xyz-agent/sessions/ for .jsonl files
│   ├── session-label-store.ts (123) — Independent label store + pi migration
│   ├── skill-scanner.ts   (140)  — Scan SKILL.md from skill directories
│   ├── agent-scanner.ts   (149)  — Scan agent.md from agent directories
│   ├── provider-store.ts  (104)  — Provider list + validation cache
│   └── trash.ts           (24)   — macOS trash fallback
│
├── renderer/src/          (12,129 lines, ~100 files) — Vue 3 frontend
│   ├── App.vue            (248)  — Root component
│   ├── stores/            (6 stores)
│   ├── composables/       (8 composables, 4 test files)
│   ├── lib/               (event-bus, ws-client, markdown, tool-renderer-registry)
│   ├── components/        (~50 components)
│   ├── mock/              (data.ts + mock-ws.ts)
│   ├── design-system/     (~20 components + tokens + theme)
│   └── i18n/              (zh-CN, en-US)
│
└── shared/src/            (245 lines, 7 files) — Shared types
    ├── protocol.ts        (40)   — ClientMessage/ServerMessage + type unions
    ├── message.ts         (38)   — Message, ToolCall, ThinkingBlock, Usage
    ├── provider.ts        (86)   — ProviderInfo, ModelInfo, SkillInfo, AgentInfo, scan types
    ├── session.ts         (16)   — SessionSummary, SessionGroup, SessionStatus
    ├── panel.ts           (22)   — PanelTree, SplitNode, WindowState
    ├── settings.ts        (5)    — ToolPermission, ThemeMode, ThemePreset
    ├── errors.ts          (15)   — AppErrorCode, AppError
    └── index.ts           (23)   — Re-exports
```

### Key Entry Points

| Layer | Entry | Role |
|-------|-------|------|
| Runtime | `index.ts` → `SidecarServer` | CLI entry, starts HTTP+WS server |
| Renderer | `main.ts` → `App.vue` | Vue app mount, WS connect |
| Renderer | `settings-entry.ts` | Separate entry for settings window |

---

## 2. Runtime Layer

### 2.1 server.ts (574 lines)

**Class**: `SidecarServer` — God class handling all WS message routing.

**Dependencies** (directly instantiated/imported):
- `SessionPool` (instantiated inline, no DI)
- `provider-store` (module-level functions)
- `config-store` (module-level functions)
- `skill-scanner`, `agent-scanner` (module-level functions)
- `model-db` (module-level functions)

**Message types handled** (37 case branches):

| Category | Types |
|----------|-------|
| Session | `session.create`, `session.delete`, `session.list`, `session.switch`, `session.history`, `session.compact`, `session.clear`, `session.restore`, `session.rename` |
| Message | `message.send`, `message.abort` |
| Config | `config.getProviders`, `config.setProvider`, `config.deleteProvider`, `config.setToolPermissions`, `config.scanSkills`, `config.setSkill`, `config.deleteSkill`, `config.scanAgents`, `config.setAgent`, `config.deleteAgent`, `config.discoverModels` |
| Model | `model.list`, `model.switch` |
| Tool | `tool.approve`, `tool.deny`, `tool.always_allow` |
| System | `ping` |

**Broadcast methods** (5):

| Method | Recipients |
|--------|-----------|
| `broadcast()` | All connected WS clients |
| `broadcastSessionList()` | All |
| `broadcastProviderList()` | All |
| `broadcastSkillList()` | All |
| `broadcastAgentList()` | All |

**Quality indicators**:
- **Coupling**: HIGH — directly imports 6 modules, creates SessionPool inline
- **Cohesion**: LOW — handles settings, models, sessions, tool approvals, discovery, heartbeat
- **Testability**: POOR — no DI, hard to mock dependencies; constructor creates everything
- **Type safety**: MODERATE — uses discriminated union `ClientMessage.type` for routing, but `payload` is `Record<string, unknown>` requiring casts everywhere

### 2.2 session-pool.ts (600 lines) — Largest runtime file

**Class**: `SessionPool` — God class managing sessions, WS clients, history conversion, tool approval.

**Responsibilities** (12+):
1. Session create/delete/rename/restore/clear
2. Message send/abort
3. Model switching
4. Compact sessions
5. History retrieval (active + from-file)
6. Pi history format → `Message[]` conversion (100+ lines)
7. Session listing (active + persisted, grouped)
8. WS client registration (`addClient`/`removeClient`/`send`)
9. Tool approval routing (approve/deny/alwaysAllow)
10. EventAdapter lifecycle (attach/detach per session)
11. Usage tracking (via onEvent listener)
12. Skill path collection

**Direct dependencies**: ProcessManager, EventAdapter, config-store, session-scanner, session-label-store, model-db

**WS client management** — SessionPool maintains its own `clients: Set<WebSocket>`:
- `addClient(ws)` / `removeClient(ws)` — called by... **nobody** — SessionPool's client set is never connected to server.ts's client set
- `send(msg)` iterates `this.clients` — but **no clients are ever added** since `addClient` is never called

**Quality indicators**:
- **Coupling**: VERY HIGH — 8 direct imports
- **Cohesion**: VERY LOW — mixes session lifecycle, WS broadcast, history parsing, tool approval
- **Dead code**: `addClient()`, `removeClient()` are exported but never called; WS broadcast path is dead
- **Type safety**: POOR — `PiHistoryMessage` defined locally (duplicates pi-rpc-types.ts), casts throughout

### 2.3 event-adapter.ts (271 lines)

**Class**: `EventAdapter` — Translates pi subprocess events → `ServerMessage`.

**How it translates**:
- Defines `PiEvent = Record<string, any>` — **completely untyped** pi event representation
- Switch on `event.type` with 15+ branches
- Nested switch for `message_update` sub-types
- Manual property extraction with `?? ''` fallbacks

**Event mapping** (pi → frontend):

| pi event | Frontend event | Forwarded? |
|----------|---------------|------------|
| `message_update.text_delta` | `message.text_delta` | Yes |
| `message_update.thinking_start/delta/end` | `message.thinking_*` | Yes |
| `message_update.toolcall_*` | — | Skipped (use tool_execution instead) |
| `tool_execution_start/end` | `message.tool_call_start/end` | Yes |
| `agent_end` | `message.complete` | Yes (with stopReason mapping) |
| `extension_ui_request` (confirm/select) | `message.tool_call_pending` | Yes |
| `status` | `message.status` | Yes |
| `error` | `message.error` | Yes |
| `message_start` | `message.message_start` | Yes |
| `agent_start`, `turn_*`, `message_end`, `compaction_*`, `auto_retry_*` | — | Dropped |

**Helper methods** (5): `sendSessionCreated`, `sendSessionDeleted`, `sendSessionList`, `sendProviderList`, `sendModelList`, `sendError` — appear to be **dead code** (not called from any known consumer)

**Quality indicators**:
- **Type safety**: NONE — `Record<string, any>` for all pi events
- **Coupling**: LOW — only depends on shared `ServerMessage` type and `WsSender` callback
- **Cohesion**: HIGH — single responsibility (event translation)
- **Testability**: GOOD — pure translation logic, injectable sender

### 2.4 rpc-client.ts (344 lines)

**Class**: `RpcClient` — Spawns pi subprocess, communicates via JSON-RPC over stdio.

**Interface surface**:

| Method | Real or Stub | Notes |
|--------|-------------|-------|
| `start()` | Real | Spawns `pi --mode rpc` |
| `sendCommand(type, params, timeout)` | Real | Generic RPC, resolves by id |
| `prompt(content)` | Real | `sendCommand('prompt', {message})` |
| `abort()` | Real | `sendCommand('abort')` |
| `setModel(provider, modelId)` | Real | `sendCommand('set_model', ...)` |
| `getAvailableModels()` | Real | `sendCommand('get_available_models')` |
| `getModels()` | Real | **Alias for** `getAvailableModels()` — redundant |
| `getHistory()` | Real | `sendCommand('get_messages')` |
| `compact()` | Real | `sendCommand('compact')`, 120s timeout |
| `clear()` | Real | `sendCommand('new_session')` — **misleading**: creates new, doesn't clear |
| `approveTool(id)` | **STUB** | Returns hardcoded `{success: true}`, ignores id |
| `denyTool(id)` | **STUB** | Returns hardcoded `{success: true}`, ignores id |
| `alwaysAllowTool(name)` | **STUB** | Returns hardcoded `{success: true}`, ignores name |
| `kill()` | Real | SIGTERM → SIGKILL after timeout |
| `onEvent(listener)` | Real | Register event listener |
| `onExit(callback)` | Real | Register exit callback |

**Quality indicators**:
- **Coupling**: LOW — only depends on config-store for env vars
- **Type safety**: POOR — defines its own local `PiMessage` type (generic `{type: string, payload?: Record<string, unknown>}`), **ignores** all 384 lines of `pi-rpc-types.ts`
- **Dead code**: `getModels()` is a pure alias; 3 stub methods that do nothing

### 2.5 process-manager.ts (237 lines)

**Class**: `ProcessManager` — Manages pi subprocess lifecycles.

**Responsibilities**:
1. Find pi executable (PATH, nvm, common locations)
2. Create/destroy/rekey session processes
3. Reverse lookup (client → sessionId)
4. Provider validation (temporary pi process)
5. Exit callback registration

**Quality**: Clean, focused. Single responsibility. Only issue: `validateProvider` spawns a full pi process just to check connectivity — expensive.

### 2.6 config-store.ts (234 lines) vs provider-store.ts (104 lines)

**config-store.ts** — File-based JSON persistence:
- Persists to `~/.xyz-agent/config.json` + `~/.xyz-agent/.xyz-agent/skills.json` + `~/.xyz-agent/.xyz-agent/agents.json`
- Also reads `~/.pi/config.json` as fallback
- Functions: `loadConfig`, `saveConfig`, `updateProvider`, `removeProvider`, `updateToolPermissions`, `getToolPermissions`, `getProvider`, `updateDefaults`, `buildProviderEnv`, `loadSkills`, `saveSkills`, `loadAgents`, `saveAgents`, `getDefaultModel`
- **Problem**: Every call does `loadConfig()` → `readFileSync` → parse. No write-through cache. High I/O for hot paths.

**provider-store.ts** — Validation cache + provider listing:
- In-memory `validationCache` with TTL
- `listProviders()` → loads config → maps to `ProviderInfo[]` with status
- `setProvider()`, `deleteProvider()`, `setValidationResult()`, `reload()`, `refreshProviders()`
- **Overlap with config-store**: Both manage provider data. `provider-store.setProvider()` calls `config-store.updateProvider()`, but `provider-store.refreshProviders()` is an **alias** for `reload()` — redundant naming.

**What each persists**:

| Store | File | Data |
|-------|------|------|
| config-store | `~/.xyz-agent/config.json` | providers, defaults, toolPermissions |
| config-store | `<project>/.xyz-agent/skills.json` | enabled skills |
| config-store | `<project>/.xyz-agent/agents.json` | enabled agents |
| provider-store | (none, wraps config-store) | validation cache only |
| session-label-store | `~/.xyz-agent/session-labels.json` | sessionId → label map |

### 2.7 Scanner Duplication

| Pattern | session-scanner.ts (133) | skill-scanner.ts (140) | agent-scanner.ts (149) |
|---------|-------------------------|----------------------|----------------------|
| `expandHome()` | ✗ | ✓ (local) | ✓ (local, **identical**) |
| `inferSourceType()` | ✗ | ✓ (local) | ✓ (local, **identical**) |
| YAML frontmatter parsing | ✗ | ✓ (inline) | ✓ (inline, similar but different) |
| Directory iteration | ✓ | ✓ | ✓ (slightly different) |
| Caching | ✓ (TTL-based) | ✗ | ✗ |
| `readdirSync` + `statSync` pattern | ✓ | ✓ | ✓ (`withFileTypes` variant) |

**Duplicated code**: `expandHome()` and `inferSourceType()` are copy-pasted between skill-scanner and agent-scanner. Both share the same directory scanning + frontmatter extraction pattern but with slight variations.

### 2.8 pi-rpc-types.ts (384 lines) — **ENTIRELY DEAD**

**No file imports from `pi-rpc-types.ts`**. It defines 40+ interfaces and types but:
- `rpc-client.ts` defines its own local `PiMessage` type
- `event-adapter.ts` uses `Record<string, any>` for `PiEvent`
- `session-pool.ts` defines its own local `PiHistoryMessage`

**All 44 exported types are unused** outside the file itself. This is 384 lines of dead documentation.

---

## 3. Front-End Layer

### 3.1 Stores

| Store | Lines | State | Methods | Calls `send()` directly? |
|-------|-------|-------|---------|--------------------------|
| chat.ts | 250 | `chatSessions: Map<sid, ChatSessionState>` | 16 methods (all require sessionId) | No |
| panel.ts | 216 | `panelTree`, `focusedPanelId`, `panels[]` | 11 methods (split, bind, navigate, merge) | No |
| provider.ts | 115 | `providers`, `models`, `skills`, `agents`, `scannedSkills`, `scannedAgents` | 17 methods | **Yes** — 9 `send()` calls for skill/agent CRUD |
| session.ts | 48 | `sessions[]`, `currentSessionId` | 7 methods | No |
| settings.ts | 54 | `currentView`, `theme`, `panelGridVisible`, `inspectorOpen` | 7 methods | No |
| window.ts | 58 | `windowState`, `panelTree` sync | 6 methods | No |

**Key finding**: `provider.ts` is the only store that directly calls `send()`, violating the composable-layer boundary. All other stores are pure state; `send()` calls go through composables.

### 3.2 Composables

| Composable | Lines | Event registrations | refCount? | Imports `send`? |
|------------|-------|-------------------|-----------|-----------------|
| useChat.ts | 282 | 11 events (global handler pattern) | **Yes** (`globalListenerRefCount`) | Yes |
| useSession.ts | 164 | 4 events (`session.created/deleted/restored/renamed`) | No (uses `onMounted`/`onUnmounted` without dedup) | Yes |
| useProvider.ts | 85 | 5 events (config/model/provider updates) | No (uses `onMounted`/`onUnmounted` without dedup) | Yes |
| useConnection.ts | 76 | None | N/A | No (uses `connect`/`disconnect`) |
| useSlashCommands.ts | 126 | None | N/A | No (calls `sendMessage` from useChat) |
| useModel.ts | 17 | None | N/A | Yes |
| useContext.ts | 19 | None | N/A | No |
| useRafBatch.ts | 45 | None | N/A | No |

**refCount mechanism**: Only `useChat` implements the module-level `globalListenerRefCount` pattern to prevent duplicate event registration across multiple component instances. `useSession` and `useProvider` register events in `onMounted`/`onUnmounted` without dedup — **bug risk** with multiple component instances (split mode).

**Dead composables**: `useContext` (19 lines) and `useRafBatch` (45 lines) are **not imported by any component**. `useModel` (17 lines) is also not imported by any component.

### 3.3 lib/event-bus.ts (30 lines)

**Type safety**: **NONE**. Stringly-typed pub/sub:
```typescript
type EventHandler = (...args: any[]) => void
function on(event: string, handler: EventHandler): () => void
function emit(event: string, ...args: any[]): void
```
No compile-time checking that event names match `ServerMessageType` or that handler signatures match payloads.

### 3.4 lib/ws-client.ts (142 lines)

**Interface**:
- `connect(url)` — WebSocket connection with generation-based stale callback protection
- `disconnect()` — Increment generation, close
- `send(msg: ClientMessage)` — Send or enqueue
- `getState()` — Reactive connection state

**Quality**: Good. Generation counter prevents stale WS callbacks. Message queue with size limit (100). Heartbeat. Reconnection with exponential backoff.

### 3.5 PanelSessionView.vue (262 lines)

**Responsibilities** (too many):
1. Session state computation
2. Send message (with skill/subagent support)
3. Send command dispatch
4. Local action handling (clear, help)
5. Cancel/abort
6. Model selection
7. Tool approval (approve/deny/alwaysAllow)
8. Drawer open
9. Panel close
10. Agent switching
11. Compaction state management
12. Error handling
13. Event registration (4 events: `tool.approval_request`, `error`, `session.compacting`, `session.compacted`)
14. Direct `send()` calls (5) — bypasses composable layer

**Handler count**: 20 functions. Imports from **4 stores** + **1 composable** + `send()` + `event-bus`.

### 3.6 App.vue (248 lines)

**Responsibilities**:
1. WS connection lifecycle
2. Session loading on connect
3. Session creation (with directory picker)
4. Toast notifications
5. Keyboard shortcut handling (split, close)
6. URL params parsing (windowId, sessionId)
7. Window state sync

**Handler count**: 8 functions. Imports from **4 stores** + `useConnection` + `useSession` + ws-client.

### 3.7 MessageBubble.vue (293 lines)

**Responsibilities**:
1. Message rendering (user/assistant/system)
2. Mermaid diagram rendering
3. Markdown rendering
4. Theme detection for code blocks
5. Body click handling (expand/collapse)
6. Content size extraction + formatting

**Handler count**: 6 functions. Reasonable for a display component.

---

## 4. Shared Types (shared/src/, 245 lines)

### What's defined

| File | Types |
|------|-------|
| protocol.ts | `ClientMessageType` (37 values), `ClientMessage`, `ServerMessageType` (35 values), `ServerMessage` |
| message.ts | `Message`, `ToolCall`, `ThinkingBlock`, `Usage`, `MessageRole`, `MessageStatus`, `ToolCallStatus`, `ApprovalStatus` |
| provider.ts | `ProviderInfo`, `ModelInfo`, `SkillInfo`, `AgentInfo`, `ScanSourceType`, `ScannedSkillInfo`, `ScannedAgentInfo` |
| session.ts | `SessionSummary`, `SessionGroup`, `SessionStatus` |
| panel.ts | `PanelLeaf`, `SplitNode`, `PanelTree`, `WindowState` |
| settings.ts | `ToolPermission`, `ThemeMode`, `ThemePreset` |
| errors.ts | `AppErrorCode`, `AppError` |

### Usage in runtime vs renderer

| Type | Runtime | Renderer |
|------|---------|----------|
| `ClientMessage/ServerMessage` | ✓ (server.ts) | ✓ (ws-client.ts, everywhere) |
| `Message` | ✓ (session-pool.ts) | ✓ (chat.ts, components) |
| `ToolCall`, `ThinkingBlock` | ✓ (session-pool history) | ✓ (chat.ts) |
| `SessionSummary/Group` | ✓ (session-pool) | ✓ (session store, sidebar) |
| `ProviderInfo`, `ModelInfo` | ✓ (provider-store, server) | ✓ (provider store) |
| `SkillInfo/AgentInfo` | ✓ (config-store, scanner) | ✓ (provider store) |
| `PanelTree`, `WindowState` | ✗ | ✓ (panel store, window store) |
| `ApprovalStatus` | ✗ | ✗ — **Unused** |
| `AppErrorCode`, `AppError` | ✗ | ✗ — **Unused** |
| `ToolPermission` | ✗ | ✗ — **Unused** (runtime uses `Record<string, string>` instead) |
| `ThemeMode`, `ThemePreset` | ✗ | ✓ (settings store) |

---

## 5. Patterns in Use

### Dependency Injection: **None**

All runtime classes use direct instantiation:
```typescript
// server.ts
private pool = new SessionPool()        // no DI
private clients = new Set<WsType>()

// session-pool.ts
private pm = new ProcessManager()       // no DI
private clients = new Set<WebSocket>()  // dead set
```

No interfaces, no factory functions, no container. Hard to test in isolation.

### Event Registration Patterns

| Pattern | Used by | Dedup protection? |
|---------|---------|--------------------|
| Module-level global handlers with refCount | `useChat` | Yes |
| `onMounted`/`onUnmounted` per instance | `useSession`, `useProvider`, `PanelSessionView`, `ProviderModal` | **No** |
| Module-level function registration | `App.vue` (via useConnection) | N/A (single instance) |

**Bug risk**: `useSession` and `useProvider` register event handlers in `onMounted` without refCount. If two components mount the same composable (split view), handlers fire twice.

### Type Safety Patterns

| Area | Safety level | Issue |
|------|-------------|-------|
| Protocol (shared) | Good | Discriminated union on `type`, but `payload: Record<string, unknown>` |
| Event bus | None | `string` event names, `any` handler args |
| Pi event handling | None | `Record<string, any>` for all pi events |
| Pi message types | None | 384-line type file completely unused |
| Store methods | Good | Properly typed with generics |
| Composable returns | Good | Typed return objects |

---

## 6. Dead Code & Quality Issues

### Dead Code

| Item | Location | Lines | Evidence |
|------|----------|-------|----------|
| **pi-rpc-types.ts** | runtime/src/ | 384 | Zero imports from any other file |
| **useContext composable** | renderer/composables/ | 19 | Not imported by any component |
| **useRafBatch composable** | renderer/composables/ | 45 | Not imported by any component |
| **useModel composable** | renderer/composables/ | 17 | Not imported by any component |
| **EventAdapter helper methods** | runtime/event-adapter.ts | ~30 | `sendSessionCreated/List/...` not called |
| **SessionPool.addClient/removeClient** | runtime/session-pool.ts | ~10 | Never called; WS client set always empty |
| **SessionPool WS broadcast** | runtime/session-pool.ts | ~15 | `send()` iterates empty client set |
| **RpcClient.getModels()** | runtime/rpc-client.ts | 3 | Pure alias for `getAvailableModels()` |
| **ApprovalStatus type** | shared/message.ts | 1 | Not used anywhere |
| **AppError/AppErrorCode types** | shared/errors.ts | 15 | Not used anywhere |
| **ToolPermission type** | shared/settings.ts | 1 | Not used (runtime uses `Record<string, string>`) |

### Stub Methods (functional dead code)

| Method | Location | Behavior |
|--------|----------|----------|
| `RpcClient.approveTool()` | rpc-client.ts:284 | Returns hardcoded `{success: true}` |
| `RpcClient.denyTool()` | rpc-client.ts:294 | Returns hardcoded `{success: true}` |
| `RpcClient.alwaysAllowTool()` | rpc-client.ts:303 | Returns hardcoded `{success: true}` |

### Architecture Quality Summary

| Indicator | Runtime | Renderer |
|-----------|---------|----------|
| **Coupling** | Very High (god classes) | Moderate (store/composable/component layers) |
| **Cohesion** | Low (server + pool each do 10+ things) | Moderate (PanelSessionView too heavy) |
| **Testability** | Poor (no DI, module-level functions) | Moderate (stores testable, composables need event bus mock) |
| **Type safety** | Poor (pi events untyped, payload casts) | Moderate (event bus stringly-typed, stores well-typed) |
| **Dead code** | ~400 lines (pi-rpc-types) + 25 lines dead methods | ~80 lines unused composables |
| **Duplication** | Scanner patterns (expandHome, inferSourceType) | None significant |

### Top 5 Architecture Risks

1. **SessionPool dead WS broadcast** — `addClient()` never called, so all session events go through server.ts → clients, not through SessionPool's own broadcast mechanism. Dual broadcast path is confusing.
2. **No refCount in useSession/useProvider** — Split mode creates duplicate event handlers, causing double processing.
3. **384-line dead type file** — pi-rpc-types.ts is never imported. Two other files define their own incompatible versions of the same types locally.
4. **PanelSessionView responsibility bloat** — 20 handler functions, 4 store imports, 5 direct `send()` calls. Should be decomposed.
5. **provider store calls `send()` directly** — Breaks the composable-only-send convention used by all other stores.
