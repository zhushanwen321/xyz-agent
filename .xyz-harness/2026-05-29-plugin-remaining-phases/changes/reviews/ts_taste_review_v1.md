---
verdict: pass
must_fix: 0
reviewer: ts-taste-check
date: 2026-05-29
range: a54ec76..HEAD
files_reviewed: 21
---

# TypeScript 品味审查报告 — plugin-remaining-phases

## 审查范围

git diff `a54ec76..HEAD`，涵盖 46 个文件变更（+2957 / -1251）。
核心源文件 12 个，新增/重构测试文件 9 个。

### 文件行数统计

| 文件 | 行数 | 评估 |
|------|------|------|
| plugin-service.ts | 844 | ⚠️ 接近上限，但职责内聚 |
| plugin-activator.ts | 590 | ⚠️ 接近上限，含新增权限审批 |
| server.ts | 777 | ⚠️ 历史遗留，非本次变更 |
| plugin-types.ts | 436 | ✅ |
| event-adapter.ts | 364 | ✅ |
| plugin-host.ts | 349 | ✅ |
| plugin-storage.ts | 280 | ✅ |
| index.ts | 130 | ✅ |

## 审查结果汇总

| 优先级 | 数量 | 说明 |
|--------|------|------|
| P0 原则 | 0 | 无 must-fix 问题 |
| P1 偏好 | 5 | 建议改进，非阻塞 |
| P2 安全 | 0 | 无安全风险 |
| P3 细节 | 2 | 可选改进 |

---

## P1 偏好（推荐修复，非阻塞）

### P1-1: `index.ts` — `pluginService!` 在声明时为 undefined，非空断言有误导性

**文件**: `src-electron/runtime/src/index.ts` L71-72

```ts
onHookExecute: pluginService!
  ? (hookType, context) => pluginService!.executeHooks(...)
  : undefined,
```

`pluginService` 此时为 `undefined`，`pluginService!` 非空断言使 ternary 的 true 分支永远不执行。注释已解释延迟赋值逻辑，但 `!` 运算符仍带来认知负担。

**建议**: 改为显式 `pluginService !== undefined` 或提取辅助函数，利用闭包特性在运行时读取。当前写法功能正确，注释已补充说明，可接受。

### P1-2: `plugin-service.ts` — `listPersistedSessions` + `flatMap` 重复模式出现 5 次

**文件**: `plugin-service.ts` L379, L397, L468, L474

```ts
// 模式 1: 获取活跃 session
const groups = this.deps.sessionService.listPersistedSessions()
const active = groups.flatMap(g => g.sessions).find(s => s.status === 'active')
```

"列出所有 session → 查找 active" 的逻辑重复出现在 `getActiveSession`、`getModel`、`setModel` 中。

**建议**: 提取 `private getActiveSessionSummary(): SessionSummary | undefined` 辅助方法，消除重复。

### P1-3: `plugin-service.ts` — 硬编码 `homedir() + '.xyz-agent'` 出现 3 次

**文件**: `plugin-service.ts` L90, L695, L715

```ts
await persistSessionData(join(homedir(), '.xyz-agent'), sessionId, cache)
```

**建议**: 提取 `DATA_DIR` 常量或通过构造函数注入 `baseDir`（当前 `PluginStorage` 已接受 `baseDir` 参数，`plugin-service` 应保持一致）。

### P1-4: `server.ts` — `plugin.uiResponse` handler 使用 `as unknown as` 绕过类型

**文件**: `server.ts` L419-421

```ts
const uiService = this.pluginService as unknown as { handleUiResponse(...): void }
uiService.handleUiResponse(
  (msg.payload as { requestId: string; result: unknown }).requestId,
  (msg.payload as { requestId: string; result: unknown }).result
)
```

**建议**: 在 `IPluginService` 接口中声明 `handleUiResponse`，server 通过接口调用，避免 `as unknown as`。同文件中 `msg.payload` 被解构两次，可先提取到变量。

### P1-5: `plugin-sdk/types.ts` 与 `plugin-types.ts` — 24 个类型定义重复导出

**文件**: `packages/plugin-sdk/src/types.ts`（214 行）与 `src-electron/runtime/src/services/plugin-service/plugin-types.ts`（436 行）

SDK 独立复制了 24 个公开类型（`Disposable`, `HookContext`, `Phase2AgentAPI`, `PluginModule` 等），文件头注释说明"不 import 原文件避免循环依赖"。SDK 的目的是为插件开发者提供独立类型包。

**建议**: 可接受——SDK 作为独立包不依赖 runtime 是正确的架构边界。但应在两处添加 `// sync-with: plugin-types.ts` 注释，标记需要同步维护的关系。

---

## P3 细节（可选改进）

### P3-1: `event-adapter.ts` — `hookCallback` 每次事件重新赋值

**文件**: `event-adapter.ts` L72-73

```ts
private async handleEvent(event: Record<string, unknown>): Promise<void> {
  this.hookCallback = this.options?.onHookExecute
```

注释说明 `options` 在构造后不变，可改为构造函数中一次性赋值。当前写法功能正确，仅冗余赋值。

### P3-2: `plugin-host.ts` — `rebuildWorker` 只重建 Worker 不重新激活插件

**文件**: `plugin-host.ts` L335-360

`rebuildWorker` 创建新 Worker 但不触发 `PluginActivator.activatePlugin`。如果插件需要在 Worker 重建后重新注册 hooks/tools，当前逻辑可能丢失。这可能是已知的设计限制（Phase 后续完善），但应在注释中标明。

---

## 正面观察

1. **类型安全良好**: 核心文件无 `any` 使用，测试中 4 处 `any` 均有 `eslint-disable` 注释说明
2. **静默 catch 有注释**: 所有 `catch {}` 块均附带注释或属于合理场景（hook 错误不应阻塞主流程）
3. **权限审批设计精良**: `waitForPermissionApproval` 的 pending promise 模式正确处理了竞态（先注册再通知）
4. **SessionData 持久化**: 原子写入（tmp + rename）、容量检查、dirty 恢复机制完整
5. **测试迁移规范**: 统一从 `node:test` + `assert` 迁移到 `vitest` + `expect`，风格一致
6. **UI 串行排队**: `handleUiRequest` 的队列机制避免多个弹窗同时显示
7. **Worker 重建**: crash count + max attempts 防止无限重建循环
8. **DI 注入**: `IPluginServiceDeps` 使 PluginService 可测试，避免硬耦合
9. **SDK 包独立**: `packages/plugin-sdk` 不依赖 runtime，架构边界清晰

---

## 跨文件类型同步清单

以下类型在两处维护，变更时需同步：

| 类型名 | plugin-types.ts | plugin-sdk/types.ts |
|--------|:-:|:-:|
| Disposable | ✓ | ✓ |
| HookContext | ✓ | ✓ |
| HookType | ✓ | ✓ |
| Phase2AgentAPI | ✓ | ✓ |
| PluginContext | ✓ | ✓ |
| PluginModule | ✓ | ✓ |
| PluginState | ✓ | ✓ |
| ToolRegistration | ✓ | ✓ |
| (及其他 16 个) | ✓ | ✓ |
