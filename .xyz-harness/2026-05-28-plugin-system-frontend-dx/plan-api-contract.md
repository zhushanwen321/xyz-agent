---
verdict: pass
---

# API Contract — Plugin System

> Sub-document of `plan.md`. Defines all WS protocol types, RPC method signatures, and data flow chains with precise TypeScript interfaces.

---

## §1 WS Protocol: Client → Server (plugin.*)

### 1.1 ClientMessageType Additions

Add to the existing `ClientMessageType` union in `src-electron/shared/src/protocol.ts`:

```typescript
// Existing (Phase 1):
| 'plugin.list' | 'plugin.toggle'

// New (Phase 3):
| 'plugin.install' | 'plugin.uninstall'
| 'plugin.approvePermissions' | 'plugin.revokePermissions'
| 'plugin.executeCommand'
| 'plugin.config.get' | 'plugin.config.set'
```

### 1.2 ClientMessageMap Additions

```typescript
// ── Existing (Phase 1) ──────────────────────────────────────────
'plugin.list': Record<string, never>
'plugin.toggle': { pluginId: string; enabled: boolean; trustLevel?: 'trusted' | 'sandbox' }

// ── New (Phase 3) ────────────────────────────────────────────────
'plugin.install': { packageSpec: string }
'plugin.uninstall': { pluginId: string }
'plugin.approvePermissions': { pluginId: string; permissions: string[] }
'plugin.revokePermissions': { pluginId: string }
'plugin.executeCommand': { pluginId: string; commandId: string; args?: Record<string, unknown> }
'plugin.config.get': { pluginId: string; key?: string }  // key 省略时返回全量 config
'plugin.config.set': { pluginId: string; key: string; value: unknown }
```

### 1.3 ClientMessage Discriminated Union Additions

```typescript
// Existing:
| { type: 'plugin.list'; id?: string; payload: Record<string, never> }
| { type: 'plugin.toggle'; id?: string; payload: ClientMessageMap['plugin.toggle'] }

// New:
| { type: 'plugin.install'; id?: string; payload: ClientMessageMap['plugin.install'] }
| { type: 'plugin.uninstall'; id?: string; payload: ClientMessageMap['plugin.uninstall'] }
| { type: 'plugin.approvePermissions'; id?: string; payload: ClientMessageMap['plugin.approvePermissions'] }
| { type: 'plugin.revokePermissions'; id?: string; payload: ClientMessageMap['plugin.revokePermissions'] }
| { type: 'plugin.executeCommand'; id?: string; payload: ClientMessageMap['plugin.executeCommand'] }
| { type: 'plugin.config.get'; id?: string; payload: ClientMessageMap['plugin.config.get'] }
| { type: 'plugin.config.set'; id?: string; payload: ClientMessageMap['plugin.config.set'] }
```

### 1.4 Complete plugin.* Message Table

| Type | Payload | Response Type | Timeout | Spec Ref |
|------|---------|---------------|---------|----------|
| `plugin.list` | `{}` | `config.plugins` | 5s | FR-B1 |
| `plugin.toggle` | `{ pluginId, enabled, trustLevel? }` | `config.plugins` | 10s | FR-B2 |
| `plugin.install` | `{ packageSpec }` | N/A (Phase 4) | N/A | FR-B1 |
| `plugin.uninstall` | `{ pluginId }` | `config.plugins` | 10s | FR-B2 |
| `plugin.approvePermissions` | `{ pluginId, permissions }` | `config.plugins` | 5s | FR-B5 |
| `plugin.revokePermissions` | `{ pluginId }` | `config.plugins` | 5s | FR-B5 |
| `plugin.executeCommand` | `{ pluginId, commandId, args? }` | ack (`pong`) | 10s | FR-B4 |
| `plugin.config.get` | `{ pluginId, key? }` | `plugin:config` | 5s | FR-B3 |
| `plugin.config.set` | `{ pluginId, key, value }` | `plugin:config` | 5s | FR-B3 |

---

## §2 WS Protocol: Server → Client (plugin:*)

### 2.1 ServerMessageType Additions

Add to the existing `ServerMessageType` union in `src-electron/shared/src/protocol.ts`:

```typescript
// Existing (Phase 1):
| 'config.plugins' | 'plugin:crashed' | 'plugin:notification'

// New (Phase 3):
| 'plugin:statusChange' | 'plugin:permissionRequest'
| 'plugin:statusBarUpdate' | 'plugin:messageDecoration' | 'plugin:config'
```

### 2.2 Server → Client Payload Interfaces

```typescript
// ── Existing (Phase 1) ──────────────────────────────────────────

export interface PluginInfo {
  pluginId: string
  version: string
  displayName: string
  description: string
  status: 'discovered' | 'loaded' | 'active' | 'inactive' | 'crashed'
  trustLevel: 'trusted' | 'sandbox'
  enabled: boolean
}

export interface PluginCrashedPayload {
  pluginId: string
  workerId: string
  error: string
}

export interface PluginNotificationPayload {
  pluginId: string
  level: 'info' | 'warning' | 'error'
  message: string
}

// ── New (Phase 3) ────────────────────────────────────────────────

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
  pluginName: string
  text: string
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

### 2.3 ServerMessage Payload Type Inference

`ServerMessage` uses `payload: Record<string, unknown>`. The concrete payload type is determined by `type` field:

| ServerMessageType | Payload Interface | Push/Reply | Spec Ref |
|-------------------|-------------------|------------|----------|
| `config.plugins` | `{ plugins: PluginInfo[] }` | Both | FR-B1 |
| `plugin:crashed` | `PluginCrashedPayload` | Push | AC-B1 |
| `plugin:notification` | `PluginNotificationPayload` | Push | AC-B1 |
| `plugin:statusChange` | `PluginStatusChangePayload` | Push | AC-C5 |
| `plugin:permissionRequest` | `PluginPermissionRequestPayload` | Push | AC-B7 |
| `plugin:statusBarUpdate` | `PluginStatusBarUpdatePayload` | Push | AC-B4 |
| `plugin:messageDecoration` | `PluginMessageDecorationPayload` | Push | AC-B6 |
| `plugin:config` | `PluginConfigPayload` | Reply | AC-B3 |

---

## §3 RPC Method Signatures: PluginService ↔ Worker

### 3.1 RPC Method Table

All RPC methods use JSON-RPC 2.0 over MessagePort between main thread (`PluginRpcServer`) and Worker (`PluginRpcClient`).

#### Tool RPC (registered in `tool-api.ts`)

| Method | Direction | Params | Returns | Timeout |
|--------|-----------|--------|---------|---------|
| `plugin.tools.register` | Worker → Main | `{ pluginId, name, description, parameters }` | `toolKey: string` | 10s |
| `plugin.tools.unregister` | Worker → Main | `{ pluginId, toolKey }` | `void` | 10s |
| `plugin.tool.execute` | Main → Worker | `{ pluginId, toolName, arguments, sessionId, toolCallId }` | `BridgeToolExecuteResponse` | 30s |

#### Hook RPC (registered in `hook-api.ts`)

| Method | Direction | Params | Returns | Timeout |
|--------|-----------|--------|---------|---------|
| `plugin.hooks.register` | Worker → Main | `{ pluginId, hookType, handlerId }` | `{ registered: boolean }` | 10s |
| `plugin.hooks.unregister` | Worker → Main | `{ pluginId, hookType, handlerId }` | `{ unregistered: boolean }` | 10s |
| `plugin.hooks.invoke` | Main → Worker | `{ handlerId, hookType, context }` | `InterceptorResult` | 5s |
| `plugin.hooks.invoke.result` | Worker → Main | `{ handlerId, result }` | `void` | 10s |

#### Storage RPC (registered in `plugin-service.ts`)

| Method | Direction | Params | Returns | Timeout |
|--------|-----------|--------|---------|---------|
| `plugin.storage.global.get` | Worker → Main | `{ pluginId, key }` | `unknown` | 10s |
| `plugin.storage.global.set` | Worker → Main | `{ pluginId, key, value }` | `void` | 10s |
| `plugin.storage.global.delete` | Worker → Main | `{ pluginId, key }` | `void` | 10s |
| `plugin.storage.global.keys` | Worker → Main | `{ pluginId }` | `string[]` | 10s |
| `plugin.storage.workspace.get` | Worker → Main | `{ pluginId, key }` | `unknown` | 10s |
| `plugin.storage.workspace.set` | Worker → Main | `{ pluginId, key, value }` | `void` | 10s |
| `plugin.storage.workspace.delete` | Worker → Main | `{ pluginId, key }` | `void` | 10s |
| `plugin.storage.workspace.keys` | Worker → Main | `{ pluginId }` | `string[]` | 10s |

#### SessionData RPC (registered in `session-data-api.ts`)

| Method | Direction | Params | Returns | Timeout |
|--------|-----------|--------|---------|---------|
| `plugin.sessionData.get` | Worker → Main | `{ pluginId, sessionId, key }` | `unknown` | 10s |
| `plugin.sessionData.set` | Worker → Main | `{ pluginId, sessionId, key, value }` | `void` | 10s |
| `plugin.sessionData.delete` | Worker → Main | `{ pluginId, sessionId, key }` | `void` | 10s |
| `plugin.sessionData.keys` | Worker → Main | `{ pluginId, sessionId }` | `string[]` | 10s |

#### Config RPC (registered in `config-api.ts`)

| Method | Direction | Params | Returns | Timeout |
|--------|-----------|--------|---------|---------|
| `plugin.config.get` | Worker → Main | `{ pluginId, key? }` | `unknown` | 10s |
| `plugin.config.getAll` | Worker → Main | `{ pluginId }` | `Record<string, unknown>` | 10s |
| `plugin.config.set` | Worker → Main | `{ pluginId, key, value }` | `void` | 10s |

#### Session RPC (registered in `session-api.ts`)

| Method | Direction | Params | Returns | Timeout |
|--------|-----------|--------|---------|---------|
| `plugin.session.list` | Worker → Main | `{ pluginId }` | `SessionInfo[]` | 10s |
| `plugin.session.get` | Worker → Main | `{ pluginId, sessionId }` | `SessionInfo \| undefined` | 10s |
| `plugin.session.getActive` | Worker → Main | `{ pluginId }` | `SessionInfo \| undefined` | 10s |
| `plugin.session.sendMessage` | Worker → Main | `{ pluginId, sessionId?, role, content }` | `void` | 10s |

#### UI RPC (registered in `ui-api.ts`)

| Method | Direction | Params | Returns | Timeout |
|--------|-----------|--------|---------|---------|
| `plugin.ui.showSelect` | Worker → Main | `{ pluginId, title, options }` | `string \| undefined` | 300s |
| `plugin.ui.showConfirm` | Worker → Main | `{ pluginId, title, message }` | `boolean` | 300s |
| `plugin.ui.showInput` | Worker → Main | `{ pluginId, title, default? }` | `string \| undefined` | 300s |
| `plugin.ui.notify` | Worker → Main | `{ pluginId, level, message }` | `void` | 10s |
| `plugin.ui.updateStatusBarItem` | Worker → Main | `{ pluginId, id, text }` | `void` | 10s |

#### Agent RPC (registered in `agent-api.ts`)

| Method | Direction | Params | Returns | Timeout |
|--------|-----------|--------|---------|---------|
| `plugin.agent.getModel` | Worker → Main | `{ pluginId }` | `string` | 10s |
| `plugin.agent.setModel` | Worker → Main | `{ pluginId, model }` | `void` | 10s |
| `plugin.agent.getThinkingLevel` | Worker → Main | `{ pluginId }` | `string` | 10s |
| `plugin.agent.setThinkingLevel` | Worker → Main | `{ pluginId, level }` | `void` | 10s |
| `plugin.agent.getActiveTools` | Worker → Main | `{ pluginId }` | `string[]` | 10s |

#### Workspace RPC (registered in `workspace-api.ts`)

| Method | Direction | Params | Returns | Timeout |
|--------|-----------|--------|---------|---------|
| `plugin.workspace.getRootPath` | Worker → Main | `{ pluginId }` | `string` | 10s |
| `plugin.workspace.getName` | Worker → Main | `{ pluginId }` | `string` | 10s |
| `plugin.workspace.findFiles` | Worker → Main | `{ pluginId, pattern }` | `string[]` | 10s |

#### Notify RPC (registered in `plugin-service.ts`)

| Method | Direction | Params | Returns | Timeout |
|--------|-----------|--------|---------|---------|
| `plugin.notify` | Worker → Main | `{ pluginId, level, message }` | `void` | 10s |

#### Command RPC (NEW — registered in T3)

| Method | Direction | Params | Returns | Timeout |
|--------|-----------|--------|---------|---------|
| `plugin.command.execute` | Main → Worker | `{ pluginId, commandId, args? }` | `void` | 10s |

### 3.2 New `PluginRpcServer.invoke()` Method Signature

```typescript
/**
 * Send an RPC request to a specific Worker and wait for response.
 * Used for main→Worker invocations (tool execution, hook invocation, command execution).
 *
 * @param workerId - Target Worker identifier
 * @param method - RPC method name (e.g., 'plugin.tool.execute')
 * @param params - Method parameters
 * @param timeoutMs - Timeout in milliseconds (default: 30000)
 * @returns Promise resolving to the Worker's response result
 * @throws On timeout, Worker crash, or Worker-side error
 */
invoke(
  workerId: string,
  method: string,
  params: Record<string, unknown>,
  timeoutMs?: number,
): Promise<unknown>
```

---

## §4 Data Flow Chains

### 4.1 Tool Execution (AC-A1)

```
Frontend                          Sidecar (server.ts)            PluginService              Worker (Goal)
   │                                   │                              │                         │
   │ user sends message                │                              │                         │
   │ → pi processes                    │                              │                         │
   │ → pi extension_ui_request         │                              │                         │
   │   { method: 'bridge:tool_execute' │                              │                         │
   │     toolName: 'goal_manager' }    │                              │                         │
   │──────────────────────────────────→│                              │                         │
   │                                   │ handleBridgeRequest()        │                         │
   │                                   │──────────────────────────────→│                         │
   │                                   │                              │ handleBridgeToolExecute()│
   │                                   │                              │ toolRegistry.find()      │
   │                                   │                              │ → entry { pluginId }     │
   │                                   │                              │ getWorkerHandle(pluginId)│
   │                                   │                              │─────────────────────────→│
   │                                   │                              │ invoke('plugin.tool      │
   │                                   │                              │  .execute', params, 30s) │
   │                                   │                              │                         │
   │                                   │                              │                         │ execute handler
   │                                   │                              │                         │ return result
   │                                   │                              │←─────────────────────────│
   │                                   │                              │ BridgeToolExecuteResponse│
   │                                   │←──────────────────────────────│                         │
   │                                   │ extension_ui_response        │                         │
   │←──────────────────────────────────│ { response: result }        │                         │
   │                                   │                              │                         │
   │ pi receives tool result           │                              │                         │
```

### 4.2 Hook Serialization (AC-A2, AC-A3)

```
server.ts / EventAdapter           PluginService                   Worker A (trusted)         Worker B (sandbox)
       │                                │                                │                         │
       │ handleBridgeIntercept()        │                                │                         │
       │ or handleBridgeEvent()         │                                │                         │
       │────────────────────────────────→│                                │                         │
       │                                │ executeHooks(hookType, ctx)     │                         │
       │                                │ hookRegistry.get(hookType)      │                         │
       │                                │ → sorted: [A(priority=100),     │                         │
       │                                │           B(priority=200)]      │                         │
       │                                │                                │                         │
       │                                │ invoke A: 'plugin.hooks.invoke' │                         │
       │                                │ { handlerId, context } 5s       │                         │
       │                                │────────────────────────────────→│                         │
       │                                │                                │ handler(context)         │
       │                                │                                │ return { proceed: true,  │
       │                                │                                │   modifiedData: 'MOD' }  │
       │                                │←────────────────────────────────│                         │
       │                                │                                │                         │
       │                                │ context.data = 'MOD'           │                         │
       │                                │                                │                         │
       │                                │ invoke B: 'plugin.hooks.invoke'│                         │
       │                                │ { handlerId, context(='MOD') } │                         │
       │                                │─────────────────────────────────────────────────────────→│
       │                                │                                │                         │ handler(ctx)
       │                                │                                │                         │ return { proceed: false }
       │                                │←─────────────────────────────────────────────────────────│
       │                                │                                │                         │
       │                                │ return { blocked: true,        │                         │
       │                                │   blockedBy: 'B' }             │                         │
       │←────────────────────────────────│                                │                         │
```

### 4.3 Plugin List (AC-B1)

```
Frontend (PluginStore)             Sidecar (server.ts)            PluginService
       │                                │                              │
       │ ws.send('plugin.list', {})     │                              │
       │───────────────────────────────→│                              │
       │                                │ handleMessage('plugin.list')  │
       │                                │──────────────────────────────→│
       │                                │                              │ getDiscoveredPlugins()
       │                                │                              │ → PluginDescriptor[]
       │                                │                              │   (status mapped to lowercase)
       │                                │←──────────────────────────────│
       │                                │ send('config.plugins',        │
       │                                │   { plugins: PluginInfo[] })  │
       │←───────────────────────────────│                              │
       │ PluginStore.installedPlugins   │                              │
       │   = plugins                    │                              │
```

### 4.4 Plugin Toggle (AC-B2)

```
Frontend (PluginStore)             Sidecar (server.ts)            PluginService
       │                                │                              │
       │ ws.send('plugin.toggle',       │                              │
       │   { pluginId, enabled })       │                              │
       │───────────────────────────────→│                              │
       │                                │ handleMessage('plugin.toggle')│
       │                                │──────────────────────────────→│
       │                                │                              │ togglePlugin(id, enabled)
       │                                │                              │   enabled: activatePlugin()
       │                                │                              │   disabled: deactivatePlugin()
       │                                │                              │   broadcastPluginList()
       │                                │←──────────────────────────────│
       │                                │ send('config.plugins',        │
       │                                │   { plugins: PluginInfo[] })  │
       │←───────────────────────────────│                              │
       │ PluginStore.installedPlugins   │                              │
       │   updated                      │                              │
```

### 4.5 Plugin Config Get/Set (AC-B3)

```
Frontend (PluginSettingsForm)      Sidecar (server.ts)            PluginService          Worker
       │                                │                              │                    │
       │ ws.send('plugin.config.get',   │                              │                    │
       │   { pluginId, key })           │                              │                    │
       │───────────────────────────────→│                              │                    │
       │                                │ handleMessage()              │                    │
       │                                │──────────────────────────────→│                    │
       │                                │                              │ getPluginConfig()  │
       │                                │                              │ storage.get(id,    │
       │                                │                              │   'config:'+key)   │
       │                                │←──────────────────────────────│                    │
       │                                │ send('plugin:config',        │                    │
       │                                │   { pluginId, config })      │                    │
       │←───────────────────────────────│                              │                    │
       │                                │                              │                    │
       │ ws.send('plugin.config.set',   │                              │                    │
       │   { pluginId, key, value })    │                              │                    │
       │───────────────────────────────→│                              │                    │
       │                                │──────────────────────────────→│                    │
       │                                │                              │ setPluginConfig()  │
       │                                │                              │ storage.set(id,    │
       │                                │                              │   'config:'+key, v)│
       │                                │                              │ notify Worker:     │
       │                                │                              │ config changed     │
       │                                │←──────────────────────────────│                    │
       │                                │ send('plugin:config', ...)   │                    │
       │←───────────────────────────────│                              │                    │
```

### 4.6 Permission Approval (AC-B7)

```
Worker                          PluginService              Sidecar (server.ts)     Frontend
   │                                │                          │                      │
   │ plugin requests permission     │                          │                      │
   │ (during activate)              │                          │                      │
   │────────────────────────────────→│                          │                      │
   │                                │ broker.broadcast(         │                      │
   │                                │   'plugin:permission      │                      │
   │                                │   Request',               │                      │
   │                                │   { pluginId, perms })    │                      │
   │                                │─────────────────────────→│                      │
   │                                │                          │ ws.send()            │
   │                                │                          │─────────────────────→│
   │                                │                          │                      │ PermissionDialog
   │                                │                          │                      │ shows
   │                                │                          │                      │
   │                                │                          │                      │ User approves
   │                                │                          │                      │ ws.send(
   │                                │                          │                      │  'plugin.approve
   │                                │                          │                      │   Permissions',
   │                                │                          │                      │  { id, perms })
   │                                │                          │←─────────────────────│
   │                                │←─────────────────────────│                      │
   │                                │ approvePermissions()      │                      │
   │                                │ permissionChecker.grant() │                      │
   │                                │ resume activation         │                      │
```

### 4.7 Hot Reload Status Push (AC-C5)

```
File System                      PluginActivator             PluginService           Sidecar          Frontend
   │                                │                          │                      │                │
   │ fs.watch triggers              │                          │                      │                │
   │ (plugin index.js changed)      │                          │                      │                │
   │───────────────────────────────→│                          │                      │                │
   │                                │ 300ms debounce           │                      │                │
   │                                │                          │                      │                │
   │                                │ performReload()           │                      │                │
   │                                │ deactivatePlugin()        │                      │                │
   │                                │ activatePlugin()          │                      │                │
   │                                │──────────────────────────→│                      │                │
   │                                │                          │ broker.broadcast(    │                │
   │                                │                          │  'plugin:status      │                │
   │                                │                          │  Change',            │                │
   │                                │                          │  { pluginId,         │                │
   │                                │                          │    oldStatus,        │                │
   │                                │                          │    newStatus })      │                │
   │                                │                          │────────────────────→│                │
   │                                │                          │                      │ ws.send()      │
   │                                │                          │                      │───────────────→│
   │                                │                          │                      │                │ PluginStore
   │                                │                          │                      │                │ updates status
```

### 4.8 SessionData Cache (AC-C4)

```
Worker (Goal)                   PluginService              sessionDataCache        Bridge (pi RPC)
   │                                │                          │                      │
   │ RPC: plugin.sessionData.set    │                          │                      │
   │ { sessionId, key, value }      │                          │                      │
   │───────────────────────────────→│                          │                      │
   │                                │ 1. Check capacity        │                      │
   │                                │    (10MB limit)          │                      │
   │                                │ 2. Update cache          │                      │
   │                                │─────────────────────────→│                      │
   │                                │    cache[sessionId][key] │                      │
   │                                │    = value               │                      │
   │                                │                          │                      │
   │                                │ 3. Mark dirty            │                      │
   │                                │    dirty[sessionId].add  │                      │
   │                                │    (key)                 │                      │
   │                                │                          │                      │
   │                                │ 4. Return (don't await)  │                      │
   │←───────────────────────────────│                          │                      │
   │                                │                          │                      │
   │                                │ [5s timer] flush          │                      │
   │                                │──────────────────────────────────────────────→│
   │                                │ bridge:append_entry       │                      │
   │                                │ { sessionId, entries }   │                      │
   │                                │                          │                      │
   │                                │←──────────────────────────────────────────────│
   │                                │ success → clear dirty     │                      │
   │                                │                          │                      │
   │                                │                          │                      │
   │ RPC: plugin.sessionData.get    │                          │                      │
   │ { sessionId, key }             │                          │                      │
   │───────────────────────────────→│                          │                      │
   │                                │ cache hit?               │                      │
   │                                │─────────────────────────→│                      │
   │                                │←─────────────────────────│                      │
   │                                │ return cached value      │                      │
   │←───────────────────────────────│ (no bridge call)         │                      │
```

---

## §5 Precise TypeScript Interfaces for protocol.ts

### 5.1 Updated PluginInfo (extended from Phase 1)

```typescript
export interface PluginInfo {
  pluginId: string
  version: string
  displayName: string
  description: string
  status: 'discovered' | 'loaded' | 'active' | 'inactive' | 'crashed'
  trustLevel: 'trusted' | 'sandbox'
  source: 'built-in' | 'external'
  enabled: boolean
  permissions: string[]
  contributes?: PluginContributes
}

export interface PluginContributes {
  slashCommands?: Array<{ name: string; description: string }>
  tools?: Array<{ name: string; description: string; parameters: Record<string, unknown> }>
  hooks?: string[]
  panels?: Array<{ id: string; title: string; view: string }>
  statusBarItems?: Array<{ id: string; text: string; priority: number }>
  settings?: Array<PluginSettingSchema>
}

export interface PluginSettingSchema {
  key: string
  type: 'string' | 'number' | 'boolean' | 'enum' | 'path'
  pluginName: string
  text: string
  description?: string
  default?: unknown
  enumValues?: Array<{ label: string; value: string }>
  requiresRestart?: boolean
}
```

### 5.2 New Server→Client Payload Types

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
  pluginName: string
  text: string
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

### 5.3 config.plugins Payload (Server→Client)

```typescript
// Used for both initial push and plugin.list/plugin.toggle responses
interface ConfigPluginsPayload {
  plugins: PluginInfo[]
}
```

---

## §6 Naming Conventions Summary

| Direction | Format | Example | Convention |
|-----------|--------|---------|------------|
| Client → Server | `plugin.xxx` (dot-separated) | `plugin.list`, `plugin.config.get` | Lowercase, dot-separated, matches existing `session.create` pattern |
| Server → Client (plugin) | `plugin:xxxYyy` (colon + camelCase) | `plugin:statusChange`, `plugin:messageDecoration` | Colon prefix + camelCase, matches existing `plugin:crashed` pattern |
| Server → Client (config) | `config.plugins` (dot-separated) | `config.plugins` | Matches existing `config.providers` pattern |
| RPC (Main ↔ Worker) | `plugin.xxx.yyy` (dot-separated) | `plugin.tools.register`, `plugin.tool.execute` | Fully qualified, dot-separated |
| Bridge (Pi ↔ Sidecar) | `bridge:xxx_yyy` (colon + snake_case) | `bridge:tool_execute`, `bridge:sync` | Pi extension protocol convention |

### Breaking Change: `plugin:status_bar_update` → `plugin:statusBarUpdate`

The existing `AppStatusbar.vue` uses `plugin:status_bar_update` which violates the camelCase convention. Must be renamed to `plugin:statusBarUpdate`. This is a breaking change for any code referencing the old name, but since this feature has no active consumers yet, it's safe.
