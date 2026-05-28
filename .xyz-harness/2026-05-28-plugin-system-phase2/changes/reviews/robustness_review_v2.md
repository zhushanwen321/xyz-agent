---
review:
  type: robustness_review
  round: 2
  timestamp: "2026-05-28T23:45:00"
  target: "plugin-system-phase2 全部代码变更"
  verdict: fail
  summary: "健壮性审查第2轮，2条MUST FIX（BridgeToolExecuteResponse类型不匹配、sessionDataCache内存泄漏），v1的3条MUST FIX中1条已确认修复、1条误判已关闭、1条变更为新问题"

statistics:
  total_issues: 9
  must_fix: 2
  must_fix_resolved: 2
  low: 4
  info: 3
  files_reviewed: 18
  issues_found: 9

issues:
  - id: 1
    severity: MUST_FIX
    location: "src-electron/runtime/src/services/plugin-service/plugin-service.ts:L344,347"
    title: "handleBridgeToolExecute 返回 { content, isError } 与 BridgeToolExecuteResponse { success, result, error? } 不匹配，2处编译错误"
    status: open
    raised_in_round: 1
    resolved_in_round: null
    note: "v1 #1 延续，仍未修复。tsc 确认 TS2353 ×2"
  - id: 2
    severity: MUST_FIX
    location: "src-electron/runtime/src/services/plugin-service/plugin-service.ts:L43"
    title: "sessionDataCache 在 session 删除时未清理，per-session KV 数据永久驻留内存"
    status: open
    raised_in_round: 2
    resolved_in_round: null
    note: "新发现。IPluginService 无 onSessionDestroy 通知机制，PluginService 无法感知 session 生命周期"
  - id: 3
    severity: LOW
    location: "src-electron/runtime/src/services/plugin-service/hook-api.ts:L155-157"
    title: "Worker 侧 hook invoke notification handler 的 .catch(() => {}) 完全静默"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 4
    severity: LOW
    location: "src-electron/runtime/src/services/plugin-service/plugin-service.ts:L300-308"
    title: "executeHooks broadcast 不等待 Worker 结果，注释标注简化实现但不够醒目"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 5
    severity: LOW
    location: "src-electron/runtime/src/server.ts:L540-553"
    title: "registerExtensionTimeout 中 bridge: 分支为死代码（EventAdapter 不经过此路径）"
    status: open
    raised_in_round: 2
    resolved_in_round: null
    note: "新发现。bridge 请求走 onBridgeUIRequest → handleBridgeRequest，不经过 registerExtensionTimeout"
  - id: 6
    severity: LOW
    location: "src-electron/runtime/src/services/plugin-service/plugin-service.ts:L344-347"
    title: "bridge:tool_execute 的 handleBridgeRequest 返回 { content, isError } 而 handleBridgeToolExecute 也返回同样格式，两处与 BridgeToolExecuteResponse 不一致"
    status: open
    raised_in_round: 2
    resolved_in_round: null
    note: "与 #1 同源。handleBridgeRequest 的 bridge:tool_execute case 和 handleBridgeToolExecute 都返回非标准格式"
  - id: 7
    severity: INFO
    location: "src-electron/runtime/src/services/plugin-service/plugin-activator.ts:L277-281"
    title: "activateWithDeps 循环中依赖插件 CRASHED 时不跳过下游插件"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 8
    severity: INFO
    location: "src-electron/runtime/src/services/plugin-service/api/workspace-api.ts:L78-82"
    title: "rootPath/name getter 异步初始化，首次访问可能返回空字符串"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 9
    severity: INFO
    location: "src-electron/runtime/src/server.ts:L320-323"
    title: "extension.ui_response handler 中 bridgeRequestIds 检查为死代码"
    status: open
    raised_in_round: 2
    resolved_in_round: null
    note: "bridgeRequestIds 永远不会被填充（见 #5），has() 检查永远返回 false"

resolved:
  - id: v1-2
    severity: WAS_MUST_FIX
    title: "Error as Record<string, unknown> 类型断言编译错误"
    resolution: "CLOSED — 在 TS 5.9.3 + strict 模式下编译通过。v1 的判定基于旧版本 TS 行为。plugin-sandbox.ts L52,62 无编译错误。"
  - id: v1-3
    severity: WAS_MUST_FIX
    title: "bridgeRequestIds 内存泄漏"
    resolution: "CLOSED — 实际运行时 EventAdapter 将 bridge: 请求走 onBridgeUIRequest 路径，不经过 registerExtensionTimeout，bridgeRequestIds 永远不会被填充。原担忧的泄漏路径不存在。残留的 bridge: 分支代码标记为 LOW（#5）。"
  - id: v1-5
    severity: WAS_LOW
    title: "bridge response 被丢弃"
    resolution: "RESOLVED — handleBridgeRequest 现在直接处理 bridge 请求并发送 extension_ui_response 回 pi。架构已完善。"
  - id: v1-8
    severity: WAS_LOW
    title: "PluginPermissionChecker 未被调用"
    resolution: "RESOLVED — PluginService.registerRpcMethods() 调用 rpcServer.setPermissionChecker()，PluginRpcServer.dispatch() 在每次 RPC 调用前检查权限。"
---

# 健壮性审查 v2

## 评审记录
- 评审时间：2026-05-28 23:45
- 评审类型：编码健壮性审查（第 2 轮）
- 评审范围：plugin-system-phase2 全部代码变更（与 v1 相同范围 + v1 后修复）
- 评审维度：错误处理 / 异常管理 / 日志 / fail-fast / 测试友好 / 调试友好
- 编译验证：`npx tsc -p src-electron/runtime/tsconfig.json --noEmit`（TS 5.9.3, strict: true）

## v1 问题跟踪

| # | v1 优先级 | 描述 | v2 状态 | 说明 |
|---|----------|------|---------|------|
| v1-1 | MUST FIX | BridgeToolExecuteResponse 类型不匹配 | **仍 OPEN** (#1) | 返回 `{ content, isError }` 而非 `{ success, result, error? }`，2 处 TS2353 编译错误 |
| v1-2 | MUST FIX | Error as Record 断言编译错误 | **CLOSED** | TS 5.9.3 编译通过，v1 为误判 |
| v1-3 | MUST FIX | bridgeRequestIds 内存泄漏 | **CLOSED** | 运行时 EventAdapter 不经过 registerExtensionTimeout，bridgeRequestIds 永远为空 |
| v1-4 | LOW | hook handler 异常静默吞掉 | **仍 OPEN** (#3) | `.catch(() => {})` 仍无日志 |
| v1-5 | LOW | bridge response 被丢弃 | **RESOLVED** | handleBridgeRequest 直接处理 bridge 请求 |
| v1-6 | LOW | executeHooks broadcast 不等待 | **仍 OPEN** (#4) | 注释标注简化但不够醒目 |
| v1-7 | LOW | sendMessage hook 错误缺 pluginId | **RESOLVED** | session-service.ts 现有 console.error 日志，错误信息可接受 |
| v1-8 | LOW | PermissionChecker 未被调用 | **RESOLVED** | setPermissionChecker 已接入 RPC dispatch |
| v1-9 | INFO | activateWithDeps 不跳过 CRASHED 下游 | **仍 OPEN** (#7) | |
| v1-10 | INFO | workspace-api getter 异步初始化 | **仍 OPEN** (#8) | |

## 编译状态

```
Production code (src/):
  plugin-service.ts:344  TS2353  'content' does not exist in type 'BridgeToolExecuteResponse'
  plugin-service.ts:347  TS2353  'content' does not exist in type 'BridgeToolExecuteResponse'

Test code (test/):
  bridge-sync.test.ts: 3 × TS2345 (EventAdapter type mismatch)
  plugin-api-extended.test.ts: 20 × TS2339 (RpcResponse.result)
  plugin-api-hooks.test.ts: 2 × TS2345 (HookInterceptor mismatch)
  plugin-api-tools.test.ts: 1 × TS18048 (resp.error possibly undefined)
  plugin-hooks-integration.test.ts: 9 × TS2339/TS2551/TS2341 (BridgeToolExecuteResponse + private access)
```

## 发现的问题

### MUST FIX

#### #1 — handleBridgeToolExecute 返回值与接口不匹配（v1 #1 延续）

**文件**: `plugin-service.ts:L344,347`

`handleBridgeToolExecute` 声明返回 `Promise<BridgeToolExecuteResponse>`，但实际返回：
```ts
return { content: `Tool not found: ${toolKey}`, isError: true }   // L344
return { content: JSON.stringify({ success: true }), isError: false }  // L347
```

`BridgeToolExecuteResponse` 定义为 `{ success: boolean; result: unknown; error?: string }`。

**编译错误**: TS2353 ×2 — `content`/`isError` 不是 `BridgeToolExecuteResponse` 的属性。

**修复方案**:
```ts
// not found:
return { success: false, error: `Tool not found: ${toolKey}` }
// found (stub):
return { success: true, result: { content: JSON.stringify({ success: true }) } }
```

#### #2 — sessionDataCache 在 session 删除时未清理（新发现）

**文件**: `plugin-service.ts:L43`

```ts
private sessionDataCache = new Map<string, Map<string, unknown>>()
```

`sessionDataCache` 以 sessionId 为 key 存储 per-session KV 数据。`registerSessionDataRpcHandlers` 的 `set` 方法向其中写入数据，但：
- `IPluginService` 接口无 `onSessionDestroy` 方法
- `SessionService` 删除 session 时不通知 `PluginService`
- `PluginService` 无任何清理 `sessionDataCache` 的代码

长期运行场景下（多个 session 创建/销毁），每个 session 的 KV 数据永久驻留内存。

**修复方案**: 在 `IPluginService` 添加 `onSessionDestroy(sessionId: string)` 方法，`PluginService` 实现中清理 `sessionDataCache.delete(sessionId)`。`SessionService` 删除 session 后调用该方法。

### LOW

#### #3 — hook invoke handler 静默 catch（v1 #4 延续）

**文件**: `hook-api.ts:L155-157`

Worker 侧 `plugin.hooks.invoke` 通知处理器中，handler 调用和 result RPC 均使用空 `.catch(() => {})`。插件开发者无法知道 hook 执行失败或结果发送失败。

**建议**: 至少 `console.error('[hook-api] invoke handler error:', err)`。

#### #4 — executeHooks 注释不够醒目（v1 #6 延续）

**文件**: `plugin-service.ts:L300-308`

注释说"简化实现"，但作为核心拦截机制，默认返回 `{ blocked: false }` 不等待任何结果是功能性缺陷而非简化。建议在返回前加 `// IMPORTANT: Phase 2 简化实现，拦截不生效`。

#### #5 — registerExtensionTimeout 中 bridge: 分支为死代码（新发现）

**文件**: `server.ts:L540-553`

```ts
if (method.startsWith('bridge:')) {
  this.bridgeRequestIds.add(requestId)
  // ...
}
```

EventAdapter 对 bridge: 方法调用 `onBridgeUIRequest` 而非 `onExtensionUIRequest`，因此 `registerExtensionTimeout` 从未被 bridge 请求触发。该分支（以及 `bridgeRequestIds` 字段和 `extension.ui_response` 中的检查）为死代码。

不影响运行时，但误导未来维护者认为 bridge 请求经过超时管理。

**建议**: 删除 `bridgeRequestIds` 字段、`registerExtensionTimeout` 中的 `bridge:` 分支、以及 `extension.ui_response` 中的 `bridgeRequestIds.has()` 检查。

#### #6 — handleBridgeRequest 的 bridge:tool_execute 也使用非标准响应格式（新发现）

**文件**: `server.ts:handleBridgeRequest bridge:tool_execute case`

```ts
await client.sendCommand('extension_ui_response', { id: requestId, response: { content: '...', isError: true } })
```

与 #1 同源问题：`handleBridgeRequest` 和 `handleBridgeToolExecute` 都使用 `{ content, isError }` 格式，而非 `BridgeToolExecuteResponse` 的 `{ success, result, error? }`。响应直接发给 pi RPC，格式不一致可能导致 pi 侧解析异常。

## 六维度评估

### 1. 错误处理
- **handleBridgeRequest**: 外层 try-catch 覆盖所有 case，catch 中嵌套 try-catch 防止 sendCommand 失败。**合理**。
- **PluginRpcServer.dispatch**: 权限检查失败返回 PERMISSION_DENIED 错误码，handler 异常返回 INTERNAL_ERROR。**合理**。
- **session-data-api.ts set**: bridge 持久化失败静默吞掉，注释说明。**可接受**。

### 2. 异常管理
- **PluginActivator.activateWithDeps**: 缺失/循环依赖直接 throw。**好**。
- **PluginActivator.activatePlugin**: 异常时设 UNLOADED。**好**。
- **sandbox require 拦截**: throw 带 PERMISSION_DENIED code。在 TS 5.9.3 下编译通过。**好**。

### 3. 日志
- server.ts bridge 请求有 `[server]` 前缀日志。**好**。
- plugin-service.ts handleBridgeEvent 有 `console.error`。**好**。
- hook-api.ts 静默 catch。**缺失**（#3）。
- plugin-activator.ts 激活失败有 `console.error`。**好**。

### 4. fail-fast
- 缺失依赖、循环依赖立即 throw。**好**。
- sandbox 越权立即 throw。**好**。
- handleBridgeRequest 对不存在的 session 直接 return。**好**（无 RPC client 可发）。
- RPC 权限检查失败立即返回错误。**好**。

### 5. 测试友好
- API 模块使用依赖注入（ToolService、HookService、SessionHandlers 等）。**好**。
- PluginPermissionChecker 注入 PluginRegistry 和 Storage。**好**。
- 测试文件有大量类型错误（28 处），主要分 3 类：
  - `RpcResponse & { error? }` 上访问 `.result`（未 discriminated union）
  - `BridgeToolExecuteResponse` 使用 `.content/.isError`（与 #1 同源）
  - `sessionDataCache` 为 private（测试直接访问）

### 6. 调试友好
- sandbox 错误消息清晰（`Sandbox: require('fs') is blocked`）。**好**。
- PermissionChecker 权限拒绝消息包含 method 名。**好**。
- handleBridgeToolExecute 类型不匹配（#1）会导致运行时 bridge response 格式不一致——pi 侧可能静默忽略。**中等风险**。

## 结论

**verdict: fail**

2 条 MUST FIX:
1. **BridgeToolExecuteResponse 类型不匹配**（v1 #1 延续）: 2 处编译错误，返回格式与接口定义不一致
2. **sessionDataCache 内存泄漏**（新发现）: per-session 数据无清理机制

v1 的 3 条 MUST FIX 中 2 条关闭（1 条误判、1 条经详细分析后不存在），1 条延续。新发现 1 条。修复后可进入 v3 审查。
