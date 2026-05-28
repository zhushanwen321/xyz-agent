---
review:
  type: robustness_review
  round: 1
  timestamp: "2026-05-28T22:30:00"
  target: "plugin-system-phase2 全部代码变更"
  verdict: fail
  summary: "健壮性审查第1轮，3条MUST FIX（编译错误、bridge响应丢弃、bridgeRequestIds内存泄漏），7条LOW，需修改后重审"

statistics:
  total_issues: 10
  must_fix: 3
  must_fix_resolved: 0
  low: 5
  info: 2
  files_reviewed: 18
  issues_found: 10

issues:
  - id: 1
    severity: MUST_FIX
    location: "src-electron/runtime/src/services/plugin-service/plugin-service.ts:L333-336"
    title: "handleBridgeToolExecute 返回值类型与 BridgeToolExecuteResponse 接口不匹配（编译错误）"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 2
    severity: MUST_FIX
    location: "src-electron/runtime/src/services/plugin-service/plugin-sandbox.ts:L52,L62"
    title: "Error 转 Record<string, unknown> 类型断言编译错误"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 3
    severity: MUST_FIX
    location: "src-electron/runtime/src/server.ts:L320-322"
    title: "bridgeRequestIds 在 session 删除时未清理，存在内存泄漏"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 4
    severity: LOW
    location: "src-electron/runtime/src/services/plugin-service/hook-api.ts:L154"
    title: "hook handler 异常静默吞掉，无任何日志"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 5
    severity: LOW
    location: "src-electron/runtime/src/server.ts:L320-324"
    title: "bridge response 被丢弃，PluginService 无法感知 bridge 请求已完成"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 6
    severity: LOW
    location: "src-electron/runtime/src/services/plugin-service/plugin-service.ts:L300-308"
    title: "executeHooks broadcast 不等待 Worker 结果，hook 拦截功能实际无效"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 7
    severity: LOW
    location: "src-electron/runtime/src/services/plugin-service/plugin-service.ts:L247-252"
    title: "sendMessage hook 执行失败时阻止消息发送（fail-closed），但缺少用户可感知的错误信息"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 8
    severity: LOW
    location: "src-electron/runtime/src/services/plugin-service/plugin-permission.ts"
    title: "PluginPermissionChecker 已导出但未被任何代码实际调用"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 9
    severity: INFO
    location: "src-electron/runtime/src/services/plugin-service/plugin-activator.ts:L277-281"
    title: "activateWithDeps 内部调用 activatePlugin，后者失败时会设 CRASHED 但循环继续激活后续插件"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 10
    severity: INFO
    location: "src-electron/runtime/src/services/plugin-service/api/workspace-api.ts:L78-82"
    title: "rootPath/name getter 异步初始化，首次访问可能返回空字符串"
    status: open
    raised_in_round: 1
    resolved_in_round: null
---

# 健壮性审查 v1

## 评审记录
- 评审时间：2026-05-28 22:30
- 评审类型：编码健壮性审查
- 评审范围：plugin-system-phase2 全部代码变更（18 个文件，+837/-27 行）
- 评审维度：错误处理 / 异常管理 / 日志 / fail-fast / 测试友好 / 调试友好

## 审查范围

### 已跟踪文件（git diff）
- `src-electron/runtime/src/event-adapter.ts`
- `src-electron/runtime/src/server.ts`
- `src-electron/runtime/src/index.ts`
- `src-electron/runtime/src/services/plugin-service/plugin-service.ts`
- `src-electron/runtime/src/services/plugin-service/plugin-activator.ts`
- `src-electron/runtime/src/services/plugin-service/plugin-bootstrap.ts`
- `src-electron/runtime/src/services/plugin-service/plugin-host.ts`
- `src-electron/runtime/src/services/plugin-service/plugin-registry.ts`
- `src-electron/runtime/src/services/plugin-service/plugin-types.ts`
- `src-electron/runtime/src/services/session-service.ts`
- `src-electron/renderer/src/components/layout/AppStatusbar.vue`

### 未跟踪新文件（untracked）
- `plugin-sandbox.ts`, `plugin-permission.ts`, `plugin-permission-storage.ts`
- `tool-api.ts`, `hook-api.ts`
- `api/session-api.ts`, `api/config-api.ts`, `api/session-data-api.ts`, `api/ui-api.ts`, `api/agent-api.ts`, `api/workspace-api.ts`

### 发现的问题

| # | 优先级 | 文件/位置 | 描述 | 修改建议 |
|---|--------|----------|------|---------|
| 1 | MUST FIX | plugin-service.ts:L333-336 | `handleBridgeToolExecute` 返回 `{ content, isError }`，但 `BridgeToolExecuteResponse` 接口定义的是 `{ success, result, error? }`。TypeScript 编译错误。 | 将返回值改为 `{ success: false, error: '...' }` 和 `{ success: true, result: {} }` |
| 2 | MUST FIX | plugin-sandbox.ts:L52,L62 | `(err as Record<string, unknown>).code = 'PERMISSION_DENIED'` 编译失败。Error 不能直接 as Record。 | 改用 `(err as any).code` 或定义 `class PermissionError extends Error { code: string }` |
| 3 | MUST FIX | server.ts:L320-322 | `bridgeRequestIds` 在 `extension.ui_response` 时删除，但 `clearExtensionTimeoutsForSession`（session 删除时调用）不清理 `bridgeRequestIds`。如果 bridge 请求发出后 session 被删除，对应的 requestId 永远不会被清理。 | 在 `clearExtensionTimeoutsForSession` 中同步清理 `bridgeRequestIds` 中属于该 session 的请求 |
| 4 | LOW | hook-api.ts:L154 | hook handler 执行出错时 `.catch(() => {})` 完全静默。plugin 开发者无法知道自己的 hook 出错了，调试非常困难。 | 至少加 `console.error('[hook-api] handler error:', err)` |
| 5 | LOW | server.ts:L320-324 | bridge response 到达时直接 `return`，不通知 PluginService。如果后续需要 bridge 请求结果路由到具体插件（如 tool execute 返回），当前架构无法传递。 | 考虑调用 `this.pluginService?.handleBridgeResponse(requestId, extResult)` 或在 PluginService 中注册 requestId → callback 映射 |
| 6 | LOW | plugin-service.ts:L300-308 | `executeHooks` 注释说"按 priority 排序后依次执行"，但实际用 `broadcast` 广播给所有 Worker 后直接返回 `{ blocked: false }`，不等待任何 Worker 结果。拦截器形同虚设。 | Phase 2 已标注为简化实现。建议在注释中更明确标注"当前不等待结果，拦截不生效"，避免误导 |
| 7 | LOW | session-service.ts:L195-208 | sendMessage hook 异常时 fail-closed（阻止消息发送）。策略本身合理，但广播的错误信息 `"Plugin hook error: ..."` 对终端用户不够友好——用户不知道是哪个插件阻止了消息。 | 在错误消息中包含 pluginId（需要 hook 注册时记录来源） |
| 8 | LOW | plugin-permission.ts | `PluginPermissionChecker` 已实现并导出，但 `PluginService` 中没有任何地方实例化或调用它。所有 RPC handler 也不做权限检查。sandbox 插件可调用任何 API。 | 至少在关键 RPC handler（tools.register、hooks.register、sessions.sendMessage）中调用 `checker.check()` |
| 9 | INFO | plugin-activator.ts:L277-281 | `activateWithDeps` 循环中调用 `activatePlugin`，后者失败会设插件为 CRASHED 但不抛出。循环继续激活依赖它的后续插件，可能导致下游插件拿到不完整的依赖。 | 考虑在依赖插件 CRASHED 时跳过依赖它的插件（设 DEPS_MISSING），或至少记录 warning |
| 10 | INFO | workspace-api.ts:L78-82 | `rootPath`/`name` 使用异步 RPC 初始化但暴露为同步 getter。对象创建后立即访问可能得到空字符串。 | 当前使用模式下（插件 activate 后才访问）大概率安全，但 getter 语义暗示同步可用。考虑改为 `async getRootPath()` |

## 六维度评估

### 1. 错误处理
- **server.ts handleBridgeRequest**: 外层 try-catch 覆盖所有 case，catch 中尝试发送错误响应。catch 内部嵌套 try-catch 防止 sendCommand 失败。**合理**。
- **session-service.ts sendMessage hook**: hook 异常时 fail-closed + 广播错误。**合理**，但错误信息缺少 pluginId。
- **hook-api.ts invoke notification**: handler 错误被完全静默吞掉。**不合理**——至少需要 console.error。
- **session-data-api.ts appendEntry**: 持久化失败静默吞掉。**可接受**——注释已说明"bridge 未就绪时静默失败（缓存已更新）"。

### 2. 异常管理
- **PermissionStorage.load()**: JSON 损坏返回空 Map 而非抛出。**合理**——降级策略。
- **PluginActivator.activateWithDeps**: 缺失依赖/循环依赖直接 throw。**合理**——fail-fast。
- **sandbox require 拦截**: throw 带 PERMISSION_DENIED code，但 TS 编译错误。**需修复**（#2）。

### 3. 日志
- server.ts 的 bridge 请求有 `console.warn`（未知方法）和 `console.error`（请求失败）。**合理**。
- handleBridgeEvent 有 `console.error`。**合理**。
- hook-api.ts 的静默 catch 是最大问题。**缺失**（#4）。
- bridge:sync 在 EventAdapter 中被拦截后直接走 callback，无日志。建议加 debug 级别日志。

### 4. fail-fast
- `activateWithDeps` 在缺失依赖时立即 throw。**好**。
- PermissionChecker 对未知插件直接返回 false。**好**。
- sandbox require 对越界路径立即 throw。**好**。
- handleBridgeRequest 对不存在的 session 直接 return（不发送错误响应）。**可接受**——session 不存在时无 RPC client 可发。

### 5. 测试友好
- 各 API 模块使用依赖注入（ToolService、HookService、SessionHandlers 等）。**好**——可 mock。
- PluginPermissionChecker 注入 PluginRegistry。**好**。
- 但 PluginService 的 RPC handler 注册在 `registerRpcMethods()` 内部，无法从外部注入 mock handler。**中等**——测试需要 mock PluginRpcServer。

### 6. 调试友好
- bridge 请求有 `[server]` 前缀日志。
- sandbox 拦截有清晰的错误消息（`Sandbox: require('fs') is blocked`）。
- handleBridgeToolExecute 返回值类型不匹配（#1）会导致运行时 bridge response 解析异常——**难以调试**。

## 编译状态

```
src-electron/runtime/src/ 中 4 个 TypeScript 编译错误：
  - plugin-service.ts: BridgeToolExecuteResponse 类型不匹配（×2）
  - plugin-sandbox.ts: Error as Record<string, unknown>（×2）
```

## 结论

需修改后重审。3 条 MUST FIX 均为实际编译错误或运行时资源泄漏，必须修复。

### Summary

健壮性审查第1轮完成，3条MUST FIX（编译错误×2、内存泄漏×1），5条LOW，2条INFO，需修改后重审。
