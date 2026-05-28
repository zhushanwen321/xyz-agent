---
verdict: fail
must_fix: 2
---

# Robustness Review v1 — Plugin System (Phase 1)

**Reviewer**: Robustness Agent
**Date**: 2026-05-29
**Scope**: 6 files across runtime (sidecar) and renderer (frontend)
**Base Commit**: HEAD~4

---

## Summary

| Dimension | Score | Verdict |
|-----------|-------|---------|
| 1. Error Handling | ⚠️ 6/10 | 1 critical bug + 1 missing catch |
| 2. Abnormal Paths | ✅ 8/10 | Core paths covered, 2 gaps |
| 3. Logging | ⚠️ 5/10 | Too many silent failures |
| 4. Fail-fast | ✅ 7/10 | Good server-side, weak input validation in API |
| 5. Testable | ⚠️ 5/10 | Tight coupling in PluginService constructor |
| 6. Debug Friendly | ⚠️ 6/10 | Inconsistent context in error messages |

**Overall**: `fail` — must fix 2 critical issues before merge.

---

## ❌ Must Fix (2)

### M1 [CRITICAL] — `flushSessionData()` clear-dirty-before-flush (data loss)

**File**: `plugin-service.ts:274-277`
**Verdict**: `BLOCKING — WILL CAUSE DATA LOSS`

```typescript
try {
  // TODO: bridge flush when bridge is ready
  // await this.broker.sendBridgeFlush(sessionId, entries)
  dirtyKeys.clear()         // ← CLEARED HERE, before flush
} catch {
  // 失败 → 保留 dirty，下个周期重试   // ← comment says keep dirty, but it's already gone
}
```

`dirtyKeys.clear()` is called **before** the (future) `await this.broker.sendBridgeFlush()`. Once the TODO is implemented, if bridge flush throws, `dirtyKeys` will have already been cleared → **dirty data silently discarded** with no retry.

Contrast with `flushSessionDataForSession()` (line 289-303), which correctly places `dirtyKeys.clear()` **after** the `await`:

```typescript
try {
  await Promise.race([...])
  dirtyKeys.clear()   // ← correct: after flush
} catch { ... }
```

**Fix**: Move `dirtyKeys.clear()` out of the `try` block, to execute only after the flush succeeds:

```typescript
try {
  // await this.broker.sendBridgeFlush(sessionId, entries)
} catch {
  continue  // 失败 → 保留 dirty，下个周期重试
}
dirtyKeys.clear()
```

---

### M2 [HIGH] — `togglePlugin()` doesn't catch activation errors

**File**: `plugin-service.ts:111-122`
**Verdict**: `UNHANDLED REJECTION`

```typescript
async togglePlugin(pluginId: string, enabled: boolean): Promise<PluginDescriptor[]> {
  const descriptor = this.registry.getDescriptor(pluginId)
  if (!descriptor) throw new Error(`Plugin not found: ${pluginId}`)

  if (enabled) {
    await this.activator.handleEvent(             // ← no try/catch
      { type: 'onStartupFinished' },
      this.host,
    )
  } else {
    await this.activator.deactivatePlugin(pluginId, this.host)  // ← no try/catch
  }
  ...
}
```

If `handleEvent()` or `deactivatePlugin()` throws (e.g., Worker creation failure, RPC timeout), the rejection propagates unhandled to the WS handler, which has no `await` on `togglePlugin()` either (likely `.catch()` missing in server.ts routing).

**Additional concern**: `togglePlugin(pluginId, true)` fires `onStartupFinished` which **activates ALL pending plugins** registered for that event, not just the toggled one. This is likely not the caller's intent.

**Fix**: Wrap in try/catch, log the error, and re-throw with context. Fix the activation trigger to target only the specified plugin.

---

## ⚠️ Should Fix (8)

### S1 [MEDIUM] — Permission denials silently dropped (no server log)

**File**: `plugin-rpc-server.ts:133-138`
**Verdict**: `DEBUG NIGHTMARE`

```typescript
if (!this.permissionCheck(pluginId, message.method)) {
  worker.postMessage({ ... })  // sends PERMISSION_DENIED error response
  return                       // ← no console.warn or console.error
}
```

When a plugin's RPC call is denied, the Worker gets an error response, but there's **zero server-side log**. During development, a developer debugging "why does my plugin RPC not work" has no server-side breadcrumb to find the permission denial.

**Fix**: Add `console.warn('[rpc-server] permission denied', { pluginId, method })` before returning.

---

### S2 [MEDIUM] — `handleWorkerReply()` silently ignores unrecognised messages

**File**: `plugin-activator.ts:170-182`
**Verdict**: `STALE DEAD LETTERS`

```typescript
handleWorkerReply(msg: WorkerToHostMessage): void {
  if (!('pluginId' in msg) || typeof msg.pluginId !== 'string') return  // ← silent
  const pending = this.pendingReplies.get(msg.pluginId)
  if (!pending) return  // ← silent
  ...
}
```

If a stale/duplicate reply arrives (e.g., a delayed `activated` message from a previous activation cycle), or a message with the wrong structure, it's silently discarded. During debugging of activation issues, this makes it impossible to trace what's happening.

**Fix**: At minimum, add `console.warn` when `pendingReplies` doesn't contain the received `pluginId` and the message type is `activated`/`deactivated`/`error`.

---

### S3 [MEDIUM] — Session data params lack runtime validation

**File**: `session-data-api.ts:72-76`
**Verdict**: `SILENT UNDEFINED`

```typescript
rpcServer.registerMethod('plugin.sessionData.get', async (params) => {
  const sessionId = params.sessionId as string
  const key = params.key as string
  const cache = deps.getCache()
  const sessionCache = cache.get(sessionId)
  return sessionCache?.get(key)
})
```

If a Worker sends `plugin.sessionData.get` with `sessionId` undefined/null, `cache.get(undefined)` returns `undefined`, and the handler returns `undefined` without any error or log. The caller has no way to distinguish "key not found" from "malformed request".

Similarly for `set`, `delete`, `keys` handlers.

**Fix**: Add explicit validation at handler entry:

```typescript
if (typeof params.sessionId !== 'string' || !params.sessionId) {
  throw new RpcError(PluginRpcErrorCodes.INVALID_PARAMS, 'sessionId is required')
}
```

---

### S4 [LOW] — `RPC timeout` error message lacks context

**File**: `plugin-rpc-server.ts:105`
**Verdict**: `HARD TO DIAGNOSE`

```typescript
const timer = setTimeout(() => {
  this.pendingInvokes.delete(id)
  reject(new Error('RPC timeout'))    // ← which worker? which method?
}, timeoutMs)
```

The error message `'RPC timeout'` contains **no identifier** — no workerId, no method name, no timeout value. In a system with dozens of Worker threads and hundreds of RPC calls, this makes it impossible to figure out which call timed out.

**Fix**: Include `workerId` and `method` in the error message:

```typescript
reject(new Error(`RPC timeout: ${workerId}/${method} after ${timeoutMs}ms`))
```

---

### S5 [LOW] — `flushSessionData()` error log missing sessionId

**File**: `plugin-service.ts:266-268`

```typescript
this.flushSessionDataTimer = setInterval(() => {
  this.flushSessionData().catch((err: unknown) => {
    console.error('[plugin-service] sessionData flush error:', err)  // ← which session?
  })
}, 5_000)
```

If flushing fails, the log entry shows the error but **not which sessionId** caused it. In multi-session scenarios, this makes diagnosis much harder.

**Fix**: Move the log into `flushSessionData()` where `sessionId` is available per iteration.

---

### S6 [LOW] — Frontend `fetchPlugins()` has no timeout guard

**File**: `stores/plugin.ts:107`

```typescript
function fetchPlugins() {
  loading.value = true
  error.value = null
  send({ type: 'plugin.list', payload: {} })
}
```

If the WS connection is dead or the sidecar never responds, `loading.value` stays `true` forever. No timeout, no retry, no fallback.

**Fix**: Add a timeout (e.g., 10s) that resets `loading` and sets `error`:

```typescript
function fetchPlugins() {
  loading.value = true
  error.value = null
  send({ type: 'plugin.list', payload: {} })
  setTimeout(() => {
    if (loading.value) {
      loading.value = false
      error.value = 'Plugin list fetch timed out'
    }
  }, 10_000)
}
```

---

### S7 [LOW] — `error` code set via type cast instead of Error subclass

**Files**: `session-data-api.ts:105`, `plugin-rpc-server.ts:150`
**Verdict**: `FRAGILE PATTERN`

```typescript
const err = new Error(`Session data storage full for session ${sessionId} (${newTotal} > ${maxSize} bytes)`)
;(err as { code?: number }).code = PluginRpcErrorCodes.STORAGE_FULL
throw err
```

This TypeScript hack mutates a property that doesn't exist on `Error.prototype`. If the RPC handler inspects `err.code` via a different mechanism (instanceof, `hasOwnProperty`), it won't find it. The pattern is fragile and compiler-hostile.

**Fix**: Define a proper `RpcError` class:

```typescript
class RpcError extends Error {
  constructor(public code: number, message: string) { super(message) }
}
```

---

### S8 [LOW] — `togglePlugin` activates `onStartupFinished` unconditionally

**File**: `plugin-service.ts:112-118`

```typescript
if (enabled) {
  await this.activator.handleEvent(
    { type: 'onStartupFinished' },
    this.host,
  )
}
```

Calling `togglePlugin('my-plugin', true)` sends the `onStartupFinished` event, which resolves **all** plugins registered for that event, not just `my-plugin`. If the user has 5 plugins awaiting `onStartupFinished` and disables/re-enables one, the other 4 will be redundantly activated again.

**Fix**: Either (a) make a targeted activation call `this.activator.activatePlugin(pluginId, { type: 'manual' }, this.host)`, or (b) add a dedicated `ManualActivation` event type that only matches exact pluginId.

---

## ✅ Good (7 areas that pass)

### G1 — Worker crash handling chain (plugin-host → activator → broadcast)
The crash path is complete: `Worker.on('error')` and `Worker.on('exit', non-zero)` both call `handleWorkerCrash()` → `onCrash` callback → `activator.markCrashed()` + `broker.broadcast('plugin:crashed')`. **Double-crash guard** via `handle.status === 'crashed'` check. ✅

### G2 — RPC invoke timeout + dispose cleanup
`invoke()` sets a timeout timer that's properly cleaned in `handleResponse()` and `dispose()`. `dispose()` rejects all pending invokes with `'RPC server disposed'`. No orphaned promises on shutdown. ✅

### G3 — Hot reload deactivate timeout → force terminate
`performReload()` races `deactivatePlugin()` against a 5s timeout. If the Worker doesn't respond, it force-terminates via `terminateWorker()`. Edge case handled. ✅

### G4 — executeHooks() error isolation
Each hook handler runs in its own try/catch with a 5s timeout. A single faulty handler never blocks the chain — it's skipped and the next handler runs. ✅

### G5 — handleBridgeToolExecute() error granularity
Correctly distinguishes `RPC timeout` from other errors, returning structured `{ content, isError: true }` for both paths. ✅

### G6 — Frontend store optimistic update for toggle
`togglePlugin()` in the store optimistically updates status before sending the WS message, giving instant UI feedback. ✅

### G7 — RefCount listener pattern in usePlugin
Correctly guards against duplicate event listener registration via `_refCount`, preventing message amplification in split-view scenarios. ✅

---

## Detailed Dimension Analysis

### 1. Error Handling (6/10)

| Scenario | Status | Note |
|----------|--------|------|
| RPC handler throws | ✅ | Caught by `dispatch()`, error response sent |
| RPC invoke timeout | ✅ | Promise rejected, pending cleaned |
| Hook handler failure | ✅ | Per-handler catch, chain continues |
| Tool execute failure | ✅ | RPC timeout vs other errors distinguished |
| Worker crash | ✅ | Full chain: host → activator → broadcast |
| **flushSessionData()** | ❌ M1 | **Dirty cleared before flush — data loss** |
| togglePlugin error | ❌ M2 | Unhandled rejection |
| WS heartbeat timeout | ✅ | Connection closed, cleanup triggered |
| deactivate timeout | ✅ | `sendAndWaitReply` auto-resolves false |
| Shutdown sequence | ✅ | stopFlush → stopWatchers → deactivateAll → flush → shutdown → dispose |

### 2. Abnormal Paths (8/10)

| Scenario | Status | Note |
|----------|--------|------|
| Worker crashes | ✅ | Status → crashed, broadcast, activators notified |
| RPC timeout | ✅ | Structured error returned to bridge |
| WS disconnect | ✅ | Heartbeat timeout → closed → `.on('close')` cleanup |
| RPC server disposed mid-invoke | ✅ | All pending rejected |
| Circular dependency in plugins | ✅ | `detectCycle()` throws clear error |
| Missing plugin dependency | ✅ | `activateWithDeps()` throws clear error |
| Hot reload deactivate hang | ✅ | Force-terminates Worker after timeout |
| Stale Worker reply after restart | ⚠️ S2 | Silently ignored — could mask bugs |
| togglePlugin activates unintended plugins | ⚠️ S8 | `onStartupFinished` matches ALL not ONE |

### 3. Logging (5/10)

| Operation | Status | Note |
|-----------|--------|------|
| executeHooks handler failure | ✅ | `console.warn` with handlerId + error |
| activatePlugin failure | ✅ | `console.error` with pluginId + error |
| Worker crash | ✅ | `console.error` in host + broadcast |
| **RPC permission denied** | ❌ S1 | **No server-side log** |
| **handleWorkerReply stale reply** | ❌ S2 | **No log when pending not found** |
| dispatch handler not found | ❌ | Sends error response but no server log |
| Session data STORAGE_FULL | ⚠️ | Exception propagated but not logged server-side |
| flushSessionData error | ⚠️ S5 | Logged without sessionId |
| WS heartbeat timeout | ✅ | `console.warn` |
| togglePlugin activation failure | ❌ M2 | No try/catch → no log at all |

### 4. Fail-fast (7/10)

| Entry | Status | Note |
|-------|--------|------|
| invoke() worker existence | ✅ | Rejects immediately if worker not found |
| dispatch() handler existence | ✅ | Returns METHOD_NOT_FOUND |
| dispatch() permission | ✅ | Returns PERMISSION_DENIED |
| activatePlugin() idempotency | ✅ | Skips if already ACTIVE/ACTIVATING |
| deactivatePlugin() state check | ✅ | Skips if UNLOADED/DEACTIVATING |
| watchAndReload() source/double-watch | ✅ | Guards applied |
| **session-data-api params** | ❌ S3 | **No runtime type check — undefined silently accepted** |
| togglePlugin descriptor check | ✅ | Throws if not found |
| uninstallPlugin descriptor check | ✅ | Guards applied |
| handleBridgeToolExecute tool/worker | ✅ | Returns `isError` for both not-found paths |

### 5. Testability (5/10)

| Aspect | Status | Note |
|--------|--------|------|
| IPluginService interface | ✅ | Well-defined separation |
| PluginHost interface for Activator | ✅ | Clean abstraction |
| createSessionDataApi() | ✅ | Accepts rpcClient + pluginId |
| **PluginService constructor** | ❌ | **Creates all deps inline: PluginStorage, RpcServer, Host, Activator — impossible to mock individually** |
| **Dynamic imports in initialize()** | ❌ | `import('node:os')` etc. — can't mock in unit tests |
| **Private methods** | ❌ | `resolveCandidates()`, `sendAndWaitReply()`, `syncStatuses()` — can't test independently |
| **Frontend send() import** | ❌ | Module-level singleton — not injectable |
| Frontend store (Pinia) | ✅ | Testable via `setActivePinia(createPinia())` |

### 6. Debug Friendly (6/10)

| Aspect | Status | Note |
|--------|--------|------|
| Error messages include pluginId | ⚠️ | Most places yes, some missing |
| handleBridgeToolExecute context | ✅ | Includes toolName + error detail |
| activateWithDeps dep names | ✅ | Lists missing/circular deps by name |
| **RPC timeout message** | ❌ S4 | **'RPC timeout' only — no workerId, no method** |
| **flushSessionData error** | ⚠️ S5 | No sessionId in error log |
| **Error subclass pattern** | ❌ S7 | TypeScript hack `(err as {code?: number}).code` |
| executeHooks error | ✅ | Includes handlerId |
| handleBridgeEvent error | ⚠️ | Logged without eventName |

---

## Recommendations by File

### `plugin-service.ts` — 4 issues (M1, M2, S5, S8)
1. [M1] Fix flushSessionData() clear ordering
2. [M2] Add try/catch + focused activation in togglePlugin()
3. [S5] Include sessionId in flush error logs
4. [S8] Make togglePlugin activate only the target plugin

### `plugin-rpc-server.ts` — 2 issues (S1, S4)
1. [S1] Log permission denials server-side
2. [S4] Include workerId + method in RPC timeout message

### `plugin-activator.ts` — 1 issue (S2)
1. [S2] Log stale/unrecognised Worker replies

### `session-data-api.ts` — 2 issues (S3, S7)
1. [S3] Validate params.sessionId / params.key at handler entry
2. [S7] Replace type-cast `code` with proper RpcError class (also fix plugin-rpc-server.ts)

### `stores/plugin.ts` — 1 issue (S6)
1. [S6] Add timeout guard for fetchPlugins()

### `composables/usePlugin.ts` — 0 issues
Clean separation, correct refCount pattern, module-level fallback registration.

---

## Verdict

| Criteria | Count |
|----------|-------|
| ❌ Must Fix (critical/high) | **2** |
| ⚠️ Should Fix (medium/low) | **8** |
| ✅ Good | **7** |

**Verdict: `fail` until M1 and M2 are addressed.**

M1 is a data-loss bug (flushSessionData clears dirty before flush). M2 is an unhandled-rejection bug (togglePlugin doesn't catch activation errors). Both will manifest in production under normal error conditions.
