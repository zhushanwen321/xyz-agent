---
review:
  type: plan_review
  round: 2
  timestamp: "2026-05-29T23:30:00"
  target: ".xyz-harness/2026-05-29-plugin-remaining-phases/plan.md"
  verdict: fail
  summary: "计划评审完成，第2轮，1条MUST FIX（遗留重复 Task 7），7条v1 MUST FIX全部修复"

statistics:
  total_issues: 14
  must_fix: 1
  must_fix_resolved: 7
  low: 4
  info: 2

issues:
  - id: 1
    severity: MUST_FIX
    location: "plan.md:Wave Schedule"
    title: "Wave 1 并行文件冲突：BG1/BG2/BG4 同时修改 plugin-service.ts"
    status: resolved
    raised_in_round: 1
    resolved_in_round: 2
  - id: 2
    severity: MUST_FIX
    location: "plan.md:Task 1 Files + index.ts:L75"
    title: "PluginService 实例化调用点（index.ts）未纳入任何 Task"
    status: resolved
    raised_in_round: 1
    resolved_in_round: 2
  - id: 3
    severity: MUST_FIX
    location: "plan.md:File Structure + Task 9 Files"
    title: "File Structure 遗漏 SDK 包 3 个文件（types.ts/mock.ts/tsconfig.json）"
    status: resolved
    raised_in_round: 1
    resolved_in_round: 2
  - id: 4
    severity: MUST_FIX
    location: "plan.md:Task 5 + e2e-test-plan:TS-6"
    title: "findFiles 无独立测试文件，TS-6 测试场景无载体"
    status: resolved
    raised_in_round: 1
    resolved_in_round: 2
  - id: 5
    severity: MUST_FIX
    location: "plan.md:Task 7 Step 1 vs spec.md:FR-4"
    title: "UI 弹窗排队机制与 spec 不一致：plan 实现并发 pending，spec 要求串行排队"
    status: resolved
    raised_in_round: 1
    resolved_in_round: 2
  - id: 6
    severity: MUST_FIX
    location: "plan.md:File Structure BG2 + Task 3 Files"
    title: "plugin-storage.ts 在 File Structure 列为 BG2 modify，但无 Task 覆盖此文件"
    status: resolved
    raised_in_round: 1
    resolved_in_round: 2
  - id: 7
    severity: MUST_FIX
    location: "plan.md:Task 6 Steps 2-4 + event-adapter.ts"
    title: "EventAdapter 无 PluginService 引用也无 hook 回调，Task 6 引用的 onBridgeIntercept 方法不存在"
    status: resolved
    raised_in_round: 1
    resolved_in_round: 2
  - id: 8
    severity: LOW
    location: "plan.md:Task 4"
    title: "Task 4 合并功能无关的 FR-5（权限推送）和 FR-7（Worker crash 重建）"
    status: resolved
    raised_in_round: 1
    resolved_in_round: 2
  - id: 9
    severity: LOW
    location: "plan.md:Interface Contracts > PluginUIRequest"
    title: "PluginUIRequest 类型未指定在哪个文件定义"
    status: resolved
    raised_in_round: 1
    resolved_in_round: 2
  - id: 10
    severity: LOW
    location: "plan.md:Spec Metrics Traceability > AC-1"
    title: "AC-1 RPC 往返延迟 <50ms 无验证步骤"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 11
    severity: INFO
    location: "e2e-test-plan.md + use-cases.md"
    title: "E2E Test Plan 和 Use Cases 质量高，10 个 TS 与 AC 1:1 对应，5 个 UC 含 alternative paths"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 12
    severity: INFO
    location: "non-functional-design.md"
    title: "非功能设计完整覆盖稳定性、数据一致性、性能、安全四个维度"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 13
    severity: MUST_FIX
    location: "plan.md:Task List > Task 7 (UI 弹窗 Backend)"
    title: "重复 Task 7：UI 弹窗 Backend WS 路由与 Task 1 Step 7 完全重叠，且无 Execution Group 归属"
    status: open
    raised_in_round: 2
    resolved_in_round: null
  - id: 14
    severity: LOW
    location: "plan.md:Interface Contracts > PluginService"
    title: "handleUiResponse 方法未出现在 Interface Contracts 中"
    status: open
    raised_in_round: 2
    resolved_in_round: null
---

# 计划评审 v2

## 评审记录
- 评审时间：2026-05-29 23:30
- 评审类型：计划评审（增量审查模式）
- 评审对象：`.xyz-harness/2026-05-29-plugin-remaining-phases/plan.md`（v1 反馈后的修订版）
- 前序评审：`plan_review_v1.md`

## 一、v1 MUST FIX 逐条验证

### #1 Wave 1 并行冲突 → ✅ RESOLVED

**v1 问题**: BG1、BG2、BG4 并行修改 plugin-service.ts，后写者覆盖先写者。

**v2 修复验证**:

| Group | Wave | 修改 plugin-service.ts？ |
|-------|------|------------------------|
| BG1 (Task 1) | Wave 1 | ✅ 是（构造函数、Session/Agent/UI handlers、flush） |
| BG2 (Task 2) | Wave 1 | ❌ 否（仅 plugin-activator.ts + plugin-host.ts） |
| BG3 (Task 3+4) | Wave 2 | ✅ 是（workspace handler + 构造函数 hook） |
| FG1 (Task 5) | Wave 2 | ❌ 否（仅前端文件） |
| PG1 (Task 6+7) | Wave 3 | ❌ 否（SDK + Demo 新文件） |

Wave 1 中 BG1 是 plugin-service.ts 的唯一修改者。BG3 在 Wave 2 执行时 BG1 已完成，不冲突。BG3 内部 Task 3 和 Task 4 串行执行（Task 4 依赖 Task 1），共享 plugin-service.ts 无并行风险。✅

### #2 index.ts 实例化 → ✅ RESOLVED

**v1 问题**: PluginService 构造函数新增 deps 参数，但 index.ts 调用点无人更新。

**v2 修复验证**:

1. Task 1 Files 包含 `index.ts`（标注 `PluginService 实例化传入 deps`）✅
2. Task 1 Step 3 明确修改：
   ```typescript
   new PluginService(pluginRegistry, server, {
     sessionService,
     configService,
     broadcastFn: (type, payload) => server.broadcast({ type, payload }),
   })
   ```
3. Task 4 Files 也包含 `index.ts`（EventAdapter 工厂注入 hook 回调），BG3 Wave 2 执行，BG1 已完成 ✅

两处 index.ts 修改分属不同 Wave，串行执行。✅

### #3 File Structure SDK 文件 → ✅ RESOLVED

**v1 问题**: File Structure 遗漏 types.ts、mock.ts、tsconfig.json。

**v2 修复验证**: File Structure 表包含完整 5 行：

```
packages/plugin-sdk/package.json  | create | PG1 | SDK 包配置
packages/plugin-sdk/src/index.ts  | create | PG1 | 类型导出 + mock
packages/plugin-sdk/src/types.ts  | create | PG1 | 从 plugin-types.ts 提取的类型定义
packages/plugin-sdk/src/mock.ts   | create | PG1 | mock agentAPI 对象
packages/plugin-sdk/tsconfig.json | create | PG1 | TypeScript 配置
```

✅

### #4 findFiles 测试 → ✅ RESOLVED

**v1 问题**: findFiles 无独立测试文件。

**v2 修复验证**:
- Task 3 Files 包含 `Create: src-electron/runtime/test/plugin-findfiles.test.ts` ✅
- File Structure 表包含此文件（BG3）✅
- Task 3 Step 3 明确写测试 ✅

### #5 UI 弹窗排队 → ✅ RESOLVED

**v1 问题**: UI 弹窗允许多请求并发 pending，spec 要求串行排队。

**v2 修复验证**: Task 1 Step 7 实现了完整串行排队机制：
- `activeUiRequest: string | null` 标记当前活跃请求
- `uiRequestQueue: Array<{params, resolve}>` 排队队列
- `handleUiRequest` 检查 `activeUiRequest !== null` → 推入队列
- `finalizeUiRequest` 设置 `activeUiRequest = null` → 从队列取下一个执行

与 spec FR-4 "同一时刻只允许一个 pending UI request（后来的排队）"一致。✅

### #6 plugin-storage.ts 归属 → ✅ RESOLVED

**v1 问题**: plugin-storage.ts 列为 BG2 modify 但无 Task 覆盖。

**v2 修复验证**:
- plugin-storage.ts 现在归属 **BG1**（File Structure 表：`plugin-storage.ts | modify | BG1`）✅
- Task 1 Files 包含 `plugin-storage.ts` ✅
- Task 1 Step 6 明确描述新增 3 个辅助函数（persistSessionData、loadSessionData、deleteSessionData）✅

### #7 EventAdapter hook 注入 → ✅ RESOLVED

**v1 问题**: EventAdapter 无 PluginService 引用，onBridgeIntercept 方法不存在。

**v2 修复验证**: Task 4 Step 1 完整描述了注入机制：

1. EventAdapterOptions 新增 `onHookExecute` 回调：
   ```typescript
   onHookExecute?: (hookType: string, context: Record<string, unknown>) => Promise<{
     blocked?: boolean, reason?: string,
     transformedContent?: string, transformedParams?: unknown,
     transformedOutput?: unknown
   }>
   ```
2. index.ts EventAdapter 工厂函数注入回调：
   ```typescript
   onHookExecute: (hookType, context) => pluginService.executeHooks(hookType, { ...context, sessionId })
   ```
3. Task 4 Files 包含 `event-adapter.ts` 和 `index.ts` ✅

注入路径完整：EventAdapter → onHookExecute 回调 → PluginService.executeHooks → Worker RPC。✅

## 二、v1 LOW/INFO 状态更新

### #8 Task 4 合并 FR-5+FR-7 → ✅ RESOLVED

v2 中 Task 2（对应 v1 的 Task 4）明确说明了合并理由："FR-5 和 FR-7 合并在同一 Task 是因为二者共享插件状态管理基础设施（broadcastFn、状态标记），且都不修改 plugin-service.ts"。理由充分。

### #9 PluginUIRequest 定义位置 → ✅ RESOLVED

Task 1 Step 1 明确在 `plugin-types.ts` 中新增 PluginUIRequest 接口。

### #10 AC-1 性能指标 → 保持 OPEN

AC-1 的 "<50ms" 指标仍然没有对应验证步骤。不影响正确性，维持 LOW。

### #11 #12 INFO → 保持 OPEN

无需操作。

## 三、新发现问题

### #13 重复 Task 7：UI 弹窗 Backend WS 路由（MUST FIX）

**问题**: Task List 中存在两个编号为 "Task 7" 的 Task：

| Task | 标题 | 编号 |
|------|------|------|
| Task 7 | UI 弹窗 Backend WS 路由 (FR-4 backend) | 7（重复） |
| Task 7 | Demo 端到端样例插件 (FR-10) | 7（重复） |

更严重的是，**"Task 7: UI 弹窗 Backend WS 路由"与 Task 1 Step 7 完全重叠**：

| 维度 | Task 1 Step 7 | Task 7: UI 弹窗 Backend |
|------|--------------|------------------------|
| 修改 plugin-service.ts UI handlers | ✅ L236-264 | ✅ L236-264 |
| 修改 server.ts plugin.uiResponse | ✅ Step 7 内含 | ✅ Step 2 |
| 创建 plugin-ui-dialog.test.ts | ✅ Step 8 | ✅ Step 4 |
| 串行排队机制 | ✅ 完整实现 | ❌ 未包含排队逻辑 |

此外：
- **"Task 7: UI 弹窗 Backend WS 路由"不属于任何 Execution Group**。PG1 的 "Task 6, Task 7" 指的是 SDK + Demo 插件，不是 UI Backend。
- **Dependency Graph 中未出现此 Task**。
- 此 Task 的实现是**简化版本**（无串行排队），与 Task 1 Step 7 的完整版本矛盾。

**影响**: 如果执行者按 Task List 线性执行，会同时看到两份 UI 弹窗 Backend 实现方案，产生歧义。自动调度系统可能错误地将此 Task 分配给 subagent，导致与 Task 1 的实现冲突。

**修复建议**: 删除 "Task 7: UI 弹窗 Backend WS 路由" 整个 Task（其功能已完全被 Task 1 Step 7 覆盖）。将 "Task 7: Demo 端到端样例插件" 重新编号为 Task 7，使其与 PG1 的 Task 7 引用一致。

### #14 handleUiResponse 未列入 Interface Contracts（LOW）

**问题**: Task 1 Step 7 和 Task 5 都引用 `handleUiResponse(requestId, result)` 方法，但 Interface Contracts 的 PluginService 类只列了 `constructor`、`handleUiRequest`、`broadcastPluginEvent`，缺少 `handleUiResponse`。

**影响**: 接口契约不完整，但不影响功能正确性。执行者可以从 Task 1 Step 7 的代码推断出方法签名。

## 四、AC 覆盖矩阵（更新）

| AC | 场景 | 覆盖状态 | Task |
|----|------|---------|------|
| AC-1 | Session API 真实调用 | ✅ 完整覆盖 | Task 1 |
| AC-2 | SessionData 持久化 | ✅ 完整覆盖 | Task 1 |
| AC-3 | Agent API 可用性 | ✅ 完整覆盖 | Task 1 |
| AC-4 | UI 弹窗交互 | ✅ 完整覆盖 | Task 1 + Task 5 |
| AC-5 | 权限审批推送 | ✅ 完整覆盖 | Task 2 |
| AC-6 | findFiles 可用性 | ✅ 完整覆盖 | Task 3 |
| AC-7 | Worker Crash 恢复 | ✅ 完整覆盖 | Task 2 |
| AC-8 | Hook 桥接生效 | ✅ 完整覆盖 | Task 4 |
| AC-9 | SDK 类型包 | ✅ 完整覆盖 | Task 6 |
| AC-10 | 样例插件端到端 | ✅ 完整覆盖 | Task 7 (Demo) |

## 五、结论

v1 的 7 条 MUST FIX 全部修复，plan 质量显著提升。Wave 编排正确（无并行冲突），index.ts 调用点和 EventAdapter hook 注入机制均已明确。

剩余 1 条 MUST FIX（#13）：重复 Task 7 导致歧义。修复方式简单——删除与 Task 1 Step 7 重复的 "Task 7: UI 弹窗 Backend WS 路由" 即可。

### Summary

计划评审完成，第2轮，1条MUST FIX（重复 Task 7），需修改后重审。
