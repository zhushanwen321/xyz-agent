---
verdict: pass
---

# Backend Implementation Plan

> Sub-document of `plan.md`. Covers BG1/BG2/BG3 backend tasks.

---

## §1 Task 1: Fix handleBridgeToolExecute — RPC Route to Worker

### Current State (Stub)

`plugin-service.ts` L268-276: `handleBridgeToolExecute` finds the tool entry by `schema.name` but returns a hardcoded `{ content: JSON.stringify({ success: true }), isError: false }` without executing anything.

### Modification Plan

**File:** `src-electron/runtime/src/services/plugin-service/plugin-service.ts`

Replace the stub body with a Worker RPC invocation:

```
async handleBridgeToolExecute(request: BridgeToolExecuteRequest): Promise<BridgeToolExecuteResponse> {
  // 1. Find tool entry by schema.name
  const entry = Array.from(this.toolRegistry.values())
    .find(e => e.schema.name === request.toolName)
  if (!entry) {
    return { content: `Tool not found: ${request.toolName}`, isError: true }
  }

  // 2. Get Worker handle for the plugin that registered this tool
  const handle = this.host.getWorkerHandle(entry.pluginId)
  if (!handle) {
    return { content: 'Plugin worker crashed', isError: true }
  }

  // 3. Send RPC request to Worker and await result (timeout 30s)
  try {
    const result = await this.rpcServer.invoke(
      handle.workerId,
      'plugin.tool.execute',
      {
        pluginId: entry.pluginId,
        toolName: request.toolName,
        arguments: request.params,
        sessionId: request.sessionId,
        toolCallId: request.toolCallId,
      },
      30_000, // 30s timeout
    )
    return result as BridgeToolExecuteResponse
  } catch (err: unknown) {
    // Timeout → isError
    if (err instanceof Error && err.message.includes('RPC timeout')) {
      return { content: 'Plugin tool execution timed out', isError: true }
    }
    // Worker crash / other error
    const msg = err instanceof Error ? err.message : String(err)
    return { content: `Plugin tool execution failed: ${msg}`, isError: true }
  }
}
```

### PluginRpcServer.invoke — New Method Required

**File:** `src-electron/runtime/src/services/plugin-service/plugin-rpc-server.ts`

Add an `invoke` method that sends an RPC request to a specific Worker and returns a promise for the response:

```
invoke(workerId: string, method: string, params: Record<string, unknown>, timeoutMs: number): Promise<unknown>
```

Implementation:
1. Create a new `RpcRequest` with auto-incremented ID
2. Store a pending `{ resolve, reject, timer }` entry keyed by request ID
3. Post `{ type: 'rpc', ...request }` to the Worker's port
4. On response (routed through PluginHost's message handler), resolve/reject the pending entry
5. Timeout → reject with RPC_TIMEOUT error code

**Design notes:**
- The current `PluginRpcServer` only handles *incoming* requests from Workers (`dispatch`). We need to add *outgoing* request capability (invoke → Worker, wait for response).
- The response routing: PluginHost's `worker.on('message')` handler already intercepts `type: 'rpc'` messages and calls `this.rpcServer.dispatch()`. We need a parallel path for responses to *our* outgoing requests — the Worker will send back `RpcResponse` with matching `id`.
- Add a `pendingInvokes: Map<number, { resolve, reject, timer }>` field to `PluginRpcServer`.
- Extend PluginHost's message handler: when `m.type === 'rpc'` and the message has `result` or `error` (i.e., it's a `RpcResponse`) AND its `id` exists in `pendingInvokes`, route it there instead of `dispatch()`.

### Worker Side: plugin.tool.execute Handler

**File:** `src-electron/runtime/src/services/plugin-service/tool-api.ts` (Worker-side extension)

The Worker already stores tool handlers locally. When `plugin.tool.execute` RPC request arrives, the Worker needs to:
1. Look up the handler by `toolName` from its local handler map
2. Execute `handler(arguments, sessionId)`
3. Return `{ content: string, isError?: boolean }`

The Worker-side handler map already exists in `tool-api.ts`'s `createToolApi()` — the `register()` function stores the schema. We need to also store the **execution handler** (a `params → Promise<ToolResult>` function) alongside the schema.

**Updated Worker-side tool registration:**
- `createToolApi()` accepts an `onToolExecute: (toolName: string, args: Record<string, unknown>) => Promise<BridgeToolExecuteResponse>` callback
- OR: add a `registerToolHandler(toolKey: string, handler)` method to the tool API
- The `plugin.tool.execute` RPC handler calls the stored handler

### Error Handling Matrix

| Scenario | Detection | Response |
|----------|-----------|----------|
| Tool not found | `toolRegistry` lookup returns undefined | `{ content: 'Tool not found: xxx', isError: true }` |
| Worker crashed | `getWorkerHandle` returns undefined | `{ content: 'Plugin worker crashed', isError: true }` |
| RPC timeout (30s) | `invoke` promise rejects with timeout | `{ content: 'Plugin tool execution timed out', isError: true }` |
| Worker throws | `invoke` promise rejects with error | `{ content: error.message, isError: true }` |
| Worker returns error result | Response has `isError: true` | Forward as-is |

### Data Flow Chain

```
pi extension → bridge:tool_execute → EventAdapter → server.handleBridgeRequest
  → PluginService.handleBridgeToolExecute(request)
    → toolRegistry.find(schema.name === request.toolName) → ToolEntry
    → PluginHost.getWorkerHandle(entry.pluginId) → WorkerHandle
    → PluginRpcServer.invoke(workerId, 'plugin.tool.execute', params, 30_000)
      → Worker receives RPC request → tool handler execution
      → Worker sends RpcResponse → PluginRpcServer resolves pending invoke
    → BridgeToolExecuteResponse
  → server sends extension_ui_response back to pi
```

### Test File: `src-electron/runtime/test/plugin-tool-execution.test.ts`

Test scenarios:
1. **Happy path**: Mock tool registry with entry, mock Worker handle, mock `rpcServer.invoke` returning success → verify response is forwarded
2. **Tool not found**: Empty toolRegistry → verify `{ content: 'Tool not found: xxx', isError: true }`
3. **Worker crashed**: `getWorkerHandle` returns undefined → verify `{ content: 'Plugin worker crashed', isError: true }`
4. **RPC timeout**: `invoke` rejects with timeout error → verify `{ content: 'Plugin tool execution timed out', isError: true }`
5. **Worker execution error**: `invoke` rejects with generic error → verify `{ content: 'Plugin tool execution failed: ...', isError: true }`
6. **Worker returns error result**: `invoke` resolves with `{ content: 'something went wrong', isError: true }` → verify forwarded as-is

---

## §2 Task 2: Fix executeHooks — Serial Await with Block/Transform

### Current State (Stub)

`plugin-service.ts` L226-253: `executeHooks` sorts entries by priority but then calls `this.rpcServer.broadcast('plugin.hooks.invoke', ...)` (fire-and-forget) and immediately returns `{ blocked: false }`.

### Modification Plan

**File:** `src-electron/runtime/src/services/plugin-service/plugin-service.ts`

Replace the broadcast+return stub with serial invocation:

```
async executeHooks(hookType: string, context: HookContext): Promise<HookResult> {
  const entries = this.hookRegistry.get(hookType)
  if (!entries || entries.length === 0) return { blocked: false }

  // Sort by priority: built-in (0) → trusted (100) → sandbox (200)
  const sorted = [...entries].sort((a, b) => a.priority - b.priority)

  // Serial invocation: await each handler in order
  for (const entry of sorted) {
    const handle = this.host.getWorkerHandle(entry.pluginId)
    if (!handle) continue // Worker crashed — skip (treated as pass-through)

    try {
      const result = await this.rpcServer.invoke(
        handle.workerId,
        'plugin.hooks.invoke',
        {
          handlerId: entry.handlerId,
          hookType,
          context,
        },
        5_000, // 5s per-handler timeout
      ) as InterceptorResult

      // Check blocked
      if (result && typeof result === 'object' && 'proceed' in result && result.proceed === false) {
        return {
          blocked: true,
          reason: result.reason ?? `Blocked by plugin ${entry.pluginId}`,
          blockedBy: entry.pluginId,
        }
      }

      // Check transformed content
      if (result && typeof result === 'object' && 'modifiedData' in result && result.modifiedData !== undefined) {
        // Merge transformed data into context for next handler
        context = {
          ...context,
          data: result.modifiedData,
        }
      }
    } catch (err: unknown) {
      // Timeout or error → treat as pass-through (do NOT block the chain)
      console.warn(`[plugin-service] hook handler ${entry.handlerId} failed/timed out:`, err instanceof Error ? err.message : String(err))
    }
  }

  return { blocked: false }
}
```

### Key Design Decisions

1. **Serial, not parallel**: Each handler sees the potentially-transformed context from the previous handler. This is essential for content modification chains.

2. **Priority ordering**: `computePriority()` from `hook-api.ts` — built-in=0, trusted=100, sandbox=200. Already sorted in `hookRegistry` at registration time, but we re-sort defensively.

3. **Blocked detection**: If any handler returns `{ proceed: false }`, the chain terminates immediately. The `blockedBy` field identifies which plugin blocked.

4. **Transform passing**: If handler returns `modifiedData`, it replaces `context.data` for subsequent handlers. The final context is available to the caller.

5. **Timeout=5s per handler**: A single slow handler doesn't block the entire chain indefinitely. On timeout, that handler is skipped (treated as pass-through), and the chain continues.

6. **Worker crash → skip**: If `getWorkerHandle` returns undefined for a handler's plugin, that handler is skipped silently.

### Updated HookResult Type

**File:** `src-electron/runtime/src/services/plugin-service/plugin-types.ts`

Extend `HookResult` to support blocked and transform:

```typescript
export interface HookResult {
  blocked: boolean
  blockedBy?: string
  reason?: string
  transformedData?: unknown
}
```

### Data Flow Chain

```
server.ts / EventAdapter → PluginService.executeHooks(hookType, context)
  → hookRegistry.get(hookType) → sorted HookEntry[]
  → for each entry:
    → PluginHost.getWorkerHandle(entry.pluginId)
    → PluginRpcServer.invoke(workerId, 'plugin.hooks.invoke', { handlerId, hookType, context }, 5_000)
      → Worker receives RPC request → looks up handlerId in local map → executes handler(context)
      → Worker sends RpcResponse with InterceptorResult
    → PluginRpcServer resolves pending invoke
    → if result.proceed === false → return { blocked: true, blockedBy: entry.pluginId }
    → if result.modifiedData → context.data = result.modifiedData
  → return { blocked: false }
```

### Test File: `src-electron/runtime/test/plugin-hooks-serial.test.ts`

Test scenarios:
1. **No handlers**: Empty hookRegistry → returns `{ blocked: false }` immediately
2. **Single handler passes**: One handler returns `{ proceed: true }` → returns `{ blocked: false }`
3. **Single handler blocks**: Handler returns `{ proceed: false, reason: 'API key detected' }` → returns `{ blocked: true, blockedBy: 'plugin-id', reason: '...' }`
4. **Priority ordering**: Two handlers (sandbox priority=200, trusted priority=100) → trusted executes first
5. **Blocked stops chain**: Two handlers — first blocks → second handler's invoke is never called
6. **Transform passes**: First handler returns `{ proceed: true, modifiedData: 'MODIFIED' }` → second handler receives context with `data: 'MODIFIED'`
7. **Worker timeout**: `invoke` rejects with timeout → handler skipped, chain continues, returns `{ blocked: false }`
8. **Worker crashed**: `getWorkerHandle` returns undefined → handler skipped, chain continues
9. **Mixed scenario**: Trusted handler transforms content, sandbox handler blocks → chain stops, returns `{ blocked: true, blockedBy: 'sandbox-plugin' }`

---

## §3 Task 3: Expand WS Protocol Types + Server Handlers

### 3.1 Protocol Type Additions

**File:** `src-electron/shared/src/protocol.ts`

#### Client → Server: New message types added to `ClientMessageType`

```typescript
// Add to ClientMessageType union:
| 'plugin.install' | 'plugin.uninstall'
| 'plugin.approvePermissions' | 'plugin.revokePermissions'
| 'plugin.executeCommand'
| 'plugin.config.get' | 'plugin.config.set'
```

#### Client → Server: New payload types in `ClientMessageMap`

```typescript
'plugin.install': { packageSpec: string }
'plugin.uninstall': { pluginId: string }
'plugin.approvePermissions': { pluginId: string; permissions: string[] }
'plugin.revokePermissions': { pluginId: string }
'plugin.executeCommand': { pluginId: string; commandId: string; args?: Record<string, unknown> }
'plugin.config.get': { pluginId: string; key: string }
'plugin.config.set': { pluginId: string; key: string; value: unknown }
```

#### Client → Server: New discriminated union members in `ClientMessage`

```typescript
| { type: 'plugin.install'; id?: string; payload: ClientMessageMap['plugin.install'] }
| { type: 'plugin.uninstall'; id?: string; payload: ClientMessageMap['plugin.uninstall'] }
| { type: 'plugin.approvePermissions'; id?: string; payload: ClientMessageMap['plugin.approvePermissions'] }
| { type: 'plugin.revokePermissions'; id?: string; payload: ClientMessageMap['plugin.revokePermissions'] }
| { type: 'plugin.executeCommand'; id?: string; payload: ClientMessageMap['plugin.executeCommand'] }
| { type: 'plugin.config.get'; id?: string; payload: ClientMessageMap['plugin.config.get'] }
| { type: 'plugin.config.set'; id?: string; payload: ClientMessageMap['plugin.config.set'] }
```

#### Server → Client: New types added to `ServerMessageType`

```typescript
// Add to ServerMessageType union:
| 'plugin:statusChange' | 'plugin:permissionRequest'
| 'plugin:statusBarUpdate' | 'plugin:messageDecoration' | 'plugin:config'
```

#### Server → Client: New payload interfaces

```typescript
export interface PluginStatusChangePayload {
  pluginId: string
  oldStatus: string
  newStatus: string
}

export interface PluginPermissionRequestPayload {
  pluginId: string
  permissions: string[]
}

export interface StatusBarItem {
  id: string
  pluginId: string
  text: string
  tooltip?: string
  commandId?: string
  priority: number
}

export interface PluginStatusBarUpdatePayload {
  items: StatusBarItem[]
}

export interface MessageDecoration {
  type: string
  pluginId: string
  label: string
  color?: string
  commandId?: string
}

export interface PluginMessageDecorationPayload {
  sessionId: string
  messageId: string
  decorations: MessageDecoration[]
}

export interface PluginConfigPayload {
  pluginId: string
  config: Record<string, unknown>
}
```

### 3.2 IPluginService Interface Update

**File:** `src-electron/runtime/src/interfaces.ts`

Add new methods to `IPluginService`:

```typescript
export interface IPluginService {
  // Existing
  initialize(): Promise<void>
  shutdown(): Promise<void>
  getDiscoveredPlugins(): PluginDescriptor[]
  togglePlugin(pluginId: string, enabled: boolean): Promise<PluginDescriptor[]>

  // New
  uninstallPlugin(pluginId: string): Promise<PluginDescriptor[]>
  approvePermissions(pluginId: string, permissions: string[]): Promise<void>
  revokePermissions(pluginId: string): Promise<void>
  executeCommand(pluginId: string, commandId: string, args?: Record<string, unknown>): Promise<void>
  getPluginConfig(pluginId: string, key: string): Promise<unknown>
  setPluginConfig(pluginId: string, key: string, value: unknown): Promise<void>
  clearSessionData(sessionId: string): void
}
```

### 3.3 Server Handler Additions

**File:** `src-electron/runtime/src/server.ts`

Add new cases to the `handleMessage` switch:

```typescript
case 'plugin.uninstall': {
  if (!this.pluginService) return this.sendError(ws, ...)
  const plugins = await this.pluginService.uninstallPlugin(msg.payload.pluginId)
  return this.send(ws, { type: 'config.plugins', id: msg.id, payload: { plugins } })
}

case 'plugin.approvePermissions': {
  if (!this.pluginService) return this.sendError(ws, ...)
  await this.pluginService.approvePermissions(msg.payload.pluginId, msg.payload.permissions)
  return this.send(ws, { type: 'config.plugins', id: msg.id, payload: { plugins: this.pluginService.getDiscoveredPlugins() } })
}

case 'plugin.revokePermissions': {
  if (!this.pluginService) return this.sendError(ws, ...)
  await this.pluginService.revokePermissions(msg.payload.pluginId)
  return this.send(ws, { type: 'config.plugins', id: msg.id, payload: { plugins: this.pluginService.getDiscoveredPlugins() } })
}

case 'plugin.executeCommand': {
  if (!this.pluginService) return this.sendError(ws, ...)
  await this.pluginService.executeCommand(msg.payload.pluginId, msg.payload.commandId, msg.payload.args)
  return this.send(ws, { type: 'pong', id: msg.id, payload: {} }) // ack only
}

case 'plugin.config.get': {
  if (!this.pluginService) return this.sendError(ws, ...)
  const value = await this.pluginService.getPluginConfig(msg.payload.pluginId, msg.payload.key)
  return this.send(ws, { type: 'plugin:config', id: msg.id, payload: { pluginId: msg.payload.pluginId, config: { [msg.payload.key]: value } } })
}

case 'plugin.config.set': {
  if (!this.pluginService) return this.sendError(ws, ...)
  await this.pluginService.setPluginConfig(msg.payload.pluginId, msg.payload.key, msg.payload.value)
  const allConfig = await this.pluginService.getPluginConfig(msg.payload.pluginId, '__all__')
  return this.send(ws, { type: 'plugin:config', id: msg.id, payload: { pluginId: msg.payload.pluginId, config: allConfig as Record<string, unknown> } })
}

case 'plugin.install': {
  // Phase 4: npm install integration
  return this.sendError(ws, 'not_implemented', 'Plugin install requires Phase 4 npm integration', msg.id)
}
```

### PluginService Implementation Stubs (for T3)

**File:** `src-electron/runtime/src/services/plugin-service/plugin-service.ts`

Add method implementations that route to Worker RPC or storage:

- `uninstallPlugin(pluginId)`: deactivates plugin, removes files, rescans registry
- `approvePermissions(pluginId, permissions)`: updates permission store, re-checks activation
- `revokePermissions(pluginId)`: clears permissions, may deactivate if required permissions removed
- `executeCommand(pluginId, commandId, args)`: routes to Worker via `rpcServer.invoke` with method `plugin.command.execute`
- `getPluginConfig(pluginId, key)`: reads from `PluginStorage` (config: namespace)
- `setPluginConfig(pluginId, key, value)`: writes to `PluginStorage`, notifies Worker if active

---

## §4 Task 4: sessionData Local Cache + Flush

### Current State

`session-data-api.ts`: `plugin.sessionData.set` updates an in-memory cache Map and fires `deps.appendEntry()` async (currently stubbed). `plugin.sessionData.get` reads directly from cache. No flush strategy, no capacity limits.

### Modification Plan

**File:** `src-electron/runtime/src/services/plugin-service/api/session-data-api.ts`

#### Enhanced Cache Structure

The existing `sessionDataCache: Map<string, Map<string, unknown>>` in `plugin-service.ts` already serves as the read cache. We enhance it with:

1. **Dirty tracking**: `sessionDataDirty: Map<string, Set<string>>` — tracks which session+keys have been modified but not flushed
2. **Size tracking**: `sessionDataSize: Map<string, number>` — per-session byte count for capacity enforcement

#### Flush Strategy

**Timer-based flush (every 5s):**
- `setInterval` in `PluginService.initialize()` calls `flushSessionData()` every 5 seconds
- `flushSessionData()` iterates `sessionDataDirty`, collects dirty entries, sends batched `bridge:append_entry` for each session
- On success, clears dirty flags for flushed entries
- On failure, keeps dirty flags (will retry next cycle)

**Deactivate forced flush:**
- When a plugin is deactivated, `deactivatePlugin()` calls `flushSessionDataForSession(sessionId)`
- This is a synchronous-like flush that awaits all pending bridge writes before completing deactivation
- Timeout: 3s — if bridge is unresponsive, log warning and proceed

**Capacity limit (10MB per plugin):**
- On each `set`, estimate value size: `JSON.stringify(value).length`
- If `sessionDataSize.get(sessionId)` exceeds 10MB, reject the set with `STORAGE_FULL` error
- Eviction policy: none (reject writes, not auto-evict — user data safety)

#### Updated SessionDataHandlers

```typescript
export interface SessionDataHandlers {
  getCache(): Map<string, Map<string, unknown>>
  getDirty(): Map<string, Set<string>>
  getSizeTracker(): Map<string, number>
  appendEntry(sessionId: string, key: string, value: unknown): Promise<void>
  /** Bridge client for flush — sends extension_ui_request */
  getBridgeClient(): { sendCommand(method: string, params: unknown): Promise<unknown> } | null
}
```

#### Updated `plugin.sessionData.set` RPC Handler

```
1. Check capacity: estimate size of new value
   - If sessionId total > 10MB → throw STORAGE_FULL error
2. Update cache: sessionDataCache[sessionId][key] = value
3. Track dirty: sessionDataDirty[sessionId].add(key)
4. Update size: sessionDataSize[sessionId] += delta
5. DO NOT await bridge flush (async, will be flushed by timer)
```

#### Updated `plugin.sessionData.get` RPC Handler

```
1. Read from cache: sessionDataCache[sessionId][key]
2. If cache hit → return value directly (no bridge call)
3. If cache miss → return undefined (bridge is write-only for sessionData)
```

#### Flush Implementation in PluginService

```
async flushSessionData(): Promise<void> {
  for (const [sessionId, dirtyKeys] of this.sessionDataDirty) {
    if (dirtyKeys.size === 0) continue
    const cache = this.sessionDataCache.get(sessionId)
    if (!cache) continue

    const entries: Array<{ key: string; value: unknown }> = []
    for (const key of dirtyKeys) {
      entries.push({ key, value: cache.get(key) })
    }

    try {
      // Send batched flush to bridge
      await this.broker?.sendBridgeFlush(sessionId, entries)
      dirtyKeys.clear() // Success → clear dirty
    } catch {
      // Failure → keep dirty, retry next cycle
    }
  }
}

async flushSessionDataForSession(sessionId: string): Promise<void> {
  const dirtyKeys = this.sessionDataDirty.get(sessionId)
  if (!dirtyKeys || dirtyKeys.size === 0) return

  const cache = this.sessionDataCache.get(sessionId)
  if (!cache) return

  const entries = [...dirtyKeys].map(key => ({ key, value: cache.get(key) }))
  try {
    await Promise.race([
      this.broker?.sendBridgeFlush(sessionId, entries),
      new Promise((_, reject) => setTimeout(() => reject(new Error('flush timeout')), 3_000)),
    ])
    dirtyKeys.clear()
  } catch {
    console.warn(`[plugin-service] sessionData flush failed for ${sessionId}`)
  }
}
```

### Cleanup

- `clearSessionData(sessionId)`: clears cache, dirty set, and size tracker for the session
- Called when a session is destroyed

### Test File: `src-electron/runtime/test/plugin-session-data-cache.test.ts`

Test scenarios:
1. **Cache write + read**: `set` writes to cache, `get` reads from cache without bridge call
2. **Dirty tracking**: After `set`, dirty set contains the key; after flush, dirty set is empty
3. **Bridge down → cache still works**: `appendEntry` throws, but cache read returns value
4. **Capacity limit**: Set values until >10MB → verify STORAGE_FULL error
5. **Deactivate flush**: Deactivate plugin → verify flush is called with dirty entries
6. **Timer flush**: Advance fake timer 5s → verify flush called
7. **Clear session**: `clearSessionData` removes all entries for that session

---

## §5 Task 5: Plugin Hot Reload (fs.watch + Debounce)

### Modification Plan

**File:** `src-electron/runtime/src/services/plugin-service/plugin-activator.ts`

Add a `watchAndReload()` method:

```typescript
import { watch, type FSWatcher } from 'node:fs'
import { dirname, resolve } from 'node:path'

// Track active watchers: pluginId → FSWatcher
private watchers = new Map<string, FSWatcher>()
// Debounce timers: pluginId → timeout handle
private reloadTimers = new Map<string, ReturnType<typeof setTimeout>>()

/**
 * Watch an external plugin's directory for changes and auto-reload.
 * Built-in plugins (source === 'built-in') are excluded.
 */
watchAndReload(
  pluginId: string,
  pluginPath: string,
  source: PluginSource,
  host: PluginHost,
  broker: IMessageBroker,
): void {
  // Built-in plugins: never watch
  if (source === 'built-in') return

  // Don't double-watch
  if (this.watchers.has(pluginId)) return

  const watchDir = dirname(pluginPath)

  const watcher = watch(watchDir, { recursive: true }, (eventType, filename) => {
    if (!filename) return

    // Only watch for JS/TS file changes
    if (!filename.endsWith('.js') && !filename.endsWith('.ts')) return

    // Debounce: 300ms
    const existing = this.reloadTimers.get(pluginId)
    if (existing) clearTimeout(existing)

    this.reloadTimers.set(pluginId, setTimeout(async () => {
      this.reloadTimers.delete(pluginId)
      await this.performReload(pluginId, host, broker)
    }, 300))
  })

  this.watchers.set(pluginId, watcher)
}
```

### Reload Logic

```
async performReload(pluginId: string, host: PluginHost, broker: IMessageBroker): Promise<void> {
  const currentState = this.pluginStates.get(pluginId)
  if (currentState !== 'ACTIVE') return // Only reload active plugins

  const oldStatus = 'active'

  // 1. Deactivate (timeout 5s)
  try {
    await Promise.race([
      this.deactivatePlugin(pluginId, host),
      new Promise((_, reject) => setTimeout(() => reject(new Error('deactivate timeout')), 5_000)),
    ])
  } catch {
    // Deactivate timeout → force terminate Worker
    console.warn(`[plugin-activator] hot reload: force terminate for ${pluginId}`)
    const handle = host.getWorkerHandle(pluginId)
    if (handle) await host.terminateWorker(handle.workerId)
    this.disposeContext(pluginId)
    this.pluginStates.set(pluginId, 'UNLOADED')
  }

  // 2. Re-activate
  await this.activatePlugin(pluginId, { type: 'onStartupFinished' }, host)

  // 3. Notify frontend of status change
  const newStatus = this.pluginStates.get(pluginId) === 'ACTIVE' ? 'active' : 'crashed'
  broker.broadcast({
    type: 'plugin:statusChange',
    id: `reload_${pluginId}_${Date.now()}`,
    payload: { pluginId, oldStatus, newStatus },
  })
}
```

### Stop Watching

```typescript
stopWatching(pluginId: string): void {
  const watcher = this.watchers.get(pluginId)
  if (watcher) {
    watcher.close()
    this.watchers.delete(pluginId)
  }
  const timer = this.reloadTimers.get(pluginId)
  if (timer) {
    clearTimeout(timer)
    this.reloadTimers.delete(pluginId)
  }
}
```

### Integration in PluginService.initialize()

After plugin activation, start watchers for external plugins:

```typescript
for (const desc of this.registry.getAllDescriptors()) {
  if (desc.source === 'external' && this.activator.getState(desc.pluginId) === 'ACTIVE') {
    this.activator.watchAndReload(
      desc.pluginId,
      desc.pluginPath,
      desc.source,
      this.host,
      this.broker,
    )
  }
}
```

### Shutdown Cleanup

In `PluginService.shutdown()`:
```typescript
for (const pluginId of this.activator.getActivePlugins()) {
  this.activator.stopWatching(pluginId)
}
```

### Test File: `src-electron/runtime/test/plugin-hot-reload.test.ts`

Test scenarios:
1. **File change triggers reload**: Mock `fs.watch` callback → verify deactivate + activate called
2. **Debounce**: Two rapid file changes (50ms apart) → only one reload triggered after 300ms
3. **Built-in exclusion**: `watchAndReload` with source='built-in' → no watcher created
4. **Deactivate timeout**: Mock deactivate hanging >5s → force terminate called
5. **Status change broadcast**: After reload → verify `plugin:statusChange` broadcast with correct old/new status
6. **Non-JS/TS file ignored**: Watch callback with `.json` file → no reload triggered
7. **Stop watching**: `stopWatching()` closes watcher and clears debounce timer

---

## §6 Task 6: Bridge Reconnect Tests

### Test File: `src-electron/runtime/test/bridge-reconnect.test.ts`

### Test Strategy

Mock the pi process's `extension_ui_request/response` protocol to simulate bridge connection lifecycle. Use the existing `bridge-sync.test.ts` pattern (mock SessionService, PluginService, etc.).

### Test Scenarios

| # | Scenario | Setup | Expected |
|---|----------|-------|----------|
| 1 | Disconnected → Syncing → Ready | Create bridge, initial sync fails, then succeeds | Bridge reaches Ready state |
| 2 | Sidecar restart → auto-reconnect | Simulate sidecar restart, verify bridge re-registers tools | Tool list re-synced via `bridge:sync` |
| 3 | Sync timeout (30 retries) | Mock `extension_ui_response` never arriving for 30 attempts | Bridge gives up, tools unregistered |
| 4 | Bridge tool execute during reconnect | Send `bridge:tool_execute` while bridge is Syncing | Returns error (not ready) |
| 5 | Bridge event during reconnect | Send `bridge:event` while bridge is Syncing | Accepted (fire-and-forget) |
| 6 | Bridge reconnect after pi crash | Simulate pi exit + restart | Bridge auto-reconnects |

### Mock Strategy

- Mock `SessionService.getRpcClient()` to return a controllable RPC client
- Mock `sendCommand` to simulate `extension_ui_response` arrival
- Use `vi.useFakeTimers()` for timeout testing
- Reference: `bridge-sync.test.ts` mock pattern

---

## §7 Task 7: Goal/Todo Plugin Unit Tests

### 7.1 Goal Plugin Tests

**File:** `resources/plugins/goal/__tests__/goal.test.ts`

### Source Files to Cover

- `resources/plugins/goal/src/goal-tool.ts` — `createGoalTool()` registers `goal_manager` tool with action handlers
- `resources/plugins/goal/src/goal-hooks.ts` — `createGoalHooks()` registers pi event hooks
- `resources/plugins/goal/src/goal-state.ts` — State management using sessionData

### Test Scenarios

| # | Scenario | Mock | Expected |
|---|----------|------|----------|
| 1 | `create_tasks` — valid task list | Mock `api.sessionData.set/get` | Tasks stored, result returned |
| 2 | `update_tasks` — mark completed | Mock with existing tasks | Task status updated |
| 3 | `list_tasks` — show progress | Mock with 3 tasks (1 completed) | Correct progress returned |
| 4 | `complete_goal` — all done | Mock all tasks completed | Goal marked complete |
| 5 | `add_tasks` — append new task | Mock with existing tasks | New task appended |
| 6 | `cancel_goal` — abort | Mock active goal | Goal cancelled |
| 7 | `report_blocked` — error state | Mock active goal | Blocked status recorded |
| 8 | `sessionData.read` on empty | Mock `sessionData.get` returns undefined | Empty state returned |
| 9 | Hooks registration | Mock `api.hooks.onPiEvent` | Hooks registered for `session_start`, `session_end` |
| 10 | State restore from sessionData | Mock sessionData with saved state | State correctly restored |

### Mock Strategy

- Mock `PluginRpcClient` (sessionData operations are RPC calls)
- Mock `Phase2AgentAPI` with stub implementations
- Test pure logic: no real Worker, no real RPC

### 7.2 Todo Plugin Tests

**File:** `resources/plugins/todo/__tests__/todo.test.ts`

### Source Files to Cover

- `resources/plugins/todo/src/todo-tool.ts` — `registerTodoTool()` registers `todo` tool with action handlers
- `resources/plugins/todo/src/todo-state.ts` — State management using sessionData

### Test Scenarios

| # | Scenario | Mock | Expected |
|---|----------|------|----------|
| 1 | `add` — add items | Mock `api.sessionData` | Items stored |
| 2 | `update` — change status | Mock with existing items | Status changed |
| 3 | `delete` — remove items | Mock with items | Items removed |
| 4 | `clear` — empty list | Mock with items | All items cleared |
| 5 | `list` — view all | Mock with items | All items returned |
| 6 | Auto-increment ID | Add 3 items | IDs are 1, 2, 3 |
| 7 | `update` — non-existent ID | Mock with items | Error returned |
| 8 | State restore from sessionData | Mock with saved state | State correctly restored |
| 9 | `session_start` hook restores state | Mock `onPiEvent` callback | Restore called on session start |

### Mock Strategy

Same as Goal tests: mock `PluginRpcClient` and `Phase2AgentAPI`.
