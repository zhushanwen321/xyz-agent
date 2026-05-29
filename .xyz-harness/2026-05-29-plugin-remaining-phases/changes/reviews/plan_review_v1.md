---
review:
  type: plan_review
  round: 1
  timestamp: "2026-05-29T22:00:00"
  target: ".xyz-harness/2026-05-29-plugin-remaining-phases/plan.md"
  verdict: fail
  summary: "计划评审完成，第1轮，7条MUST FIX，需修改后重审。核心问题：Wave 1 并行文件冲突、index.ts 实例化调用点缺失、EventAdapter hook 注入机制未描述"

statistics:
  total_issues: 12
  must_fix: 7
  must_fix_resolved: 0
  low: 3
  info: 2

issues:
  - id: 1
    severity: MUST_FIX
    location: "plan.md:Execution Groups > Wave Schedule"
    title: "Wave 1 并行文件冲突：BG1/BG2/BG4 同时修改 plugin-service.ts"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 2
    severity: MUST_FIX
    location: "plan.md:Task 1 Files + index.ts:L75"
    title: "PluginService 实例化调用点（index.ts）未纳入任何 Task"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 3
    severity: MUST_FIX
    location: "plan.md:File Structure + Task 9 Files"
    title: "File Structure 遗漏 SDK 包 3 个文件（types.ts/mock.ts/tsconfig.json）"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 4
    severity: MUST_FIX
    location: "plan.md:Task 5 + e2e-test-plan:TS-6"
    title: "findFiles 无独立测试文件，TS-6 测试场景无载体"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 5
    severity: MUST_FIX
    location: "plan.md:Task 7 Step 1 vs spec.md:FR-4"
    title: "UI 弹窗排队机制与 spec 不一致：plan 实现并发 pending，spec 要求串行排队"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 6
    severity: MUST_FIX
    location: "plan.md:File Structure BG2 + Task 3 Files"
    title: "plugin-storage.ts 在 File Structure 列为 BG2 modify，但无 Task 覆盖此文件"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 7
    severity: MUST_FIX
    location: "plan.md:Task 6 Steps 2-4 + event-adapter.ts"
    title: "EventAdapter 无 PluginService 引用也无 hook 回调，Task 6 引用的 onBridgeIntercept 方法不存在"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 8
    severity: LOW
    location: "plan.md:Task 4"
    title: "Task 4 合并功能无关的 FR-5（权限推送）和 FR-7（Worker crash 重建）"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 9
    severity: LOW
    location: "plan.md:Interface Contracts > PluginUIRequest"
    title: "PluginUIRequest 类型未指定在哪个文件定义"
    status: open
    raised_in_round: 1
    resolved_in_round: null
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
---

# 计划评审 v1

## 评审记录
- 评审时间：2026-05-29 22:00
- 评审类型：计划评审（spec.md + plan.md + e2e-test-plan.md + use-cases.md + non-functional-design.md）
- 评审对象：`.xyz-harness/2026-05-29-plugin-remaining-phases/plan.md`

## 一、Spec 完整性

### 目标明确性 ✅
目标清晰：将插件系统从"框架完整但能力断裂"变为"端到端可用"，补齐 10 项 stub/缺失功能。一句话可概括。

### 范围合理性 ✅
10 项 FR 分三档优先级（核心断裂修复 5 项、功能补全 3 项、开发者体验 2 项），边界清晰。Out of Scope 明确列出了 10 项不做功能。

### AC 可量化性 ✅
AC-1 至 AC-10 均可量化验证（返回类型、行为断言、状态标记）。无模糊描述。

### 待决议项 ✅
无 `[待决议]` 标记。

## 二、Plan 可行性

### 任务粒度 ✅
10 个 Task，每个 3-6 步，可由一个 subagent 独立完成。无超过 10 步的 Task。

### 依赖关系 ⚠️
基本正确，但存在以下问题：

1. **Wave 1 并行冲突**（见 #1）
2. **index.ts 调用点缺失**（见 #2）

### 工作量估算 ✅
~775 行新代码 + 1 个 npm 包，对照 10 个 FR 的复杂度评估表合理。

### 遗漏检查 ⚠️
发现 4 处遗漏（见 #3, #4, #6, #7）。

## 三、Spec-Plan 一致性

### FR 覆盖矩阵

| FR | Task | 覆盖状态 |
|----|------|---------|
| FR-1 Session API | Task 1 | ✅ |
| FR-2 SessionData 持久化 | Task 3 | ⚠️ plugin-storage.ts 未纳入（#6） |
| FR-3 Agent API | Task 2 | ✅ |
| FR-4 UI 弹窗 | Task 7 + Task 8 | ⚠️ 排队机制不一致（#5） |
| FR-5 权限推送 | Task 4 | ✅ |
| FR-6 findFiles | Task 5 | ⚠️ 测试文件缺失（#4） |
| FR-7 Worker crash | Task 4 | ✅ |
| FR-8 Hook 桥接 | Task 6 | ⚠️ 注入机制未描述（#7） |
| FR-9 SDK 类型包 | Task 9 | ⚠️ File Structure 不完整（#3） |
| FR-10 Demo 插件 | Task 10 | ✅ |

### AC 覆盖矩阵

| AC | Test Scenario | 对应测试文件 | 覆盖状态 |
|----|--------------|-------------|---------|
| AC-1 | TS-1 | plugin-session-real.test.ts | ✅ |
| AC-2 | TS-2 | plugin-sessiondata-persist.test.ts | ✅ |
| AC-3 | TS-3 | plugin-agent-real.test.ts | ✅ |
| AC-4 | TS-4 | plugin-ui-dialog.test.ts | ⚠️ 排队机制未覆盖 |
| AC-5 | TS-5 | plugin-permission-push.test.ts | ✅ |
| AC-6 | TS-6 | **缺失** | ❌ 无独立测试文件（#4） |
| AC-7 | TS-7 | plugin-worker-rebuild.test.ts | ✅ |
| AC-8 | TS-8 | plugin-hook-bridge.test.ts | ⚠️ 依赖 EventAdapter hook 注入（#7） |
| AC-9 | TS-10 | SDK 包内无测试 | ⚠️ TS-10 验证项过于粗略 |
| AC-10 | TS-9 | plugin-demo-e2e.test.ts | ✅ |

## 四、Execution Groups 合理性

### 分组合理性 ✅
每组文件数 ≤ 8，Task 数 ≤ 2。符合 ≤ 10 文件 / ≤ 4 Task 的建议。

### 类型划分 ⚠️
BG1-BG4 为后端、FG1 为前端、PG1 为混合（SDK + Demo 插件）。划分基本正确。

### 功能关联度 ⚠️
BG2 将 SessionData 持久化（FR-2）与权限推送（FR-5）+ Worker crash（FR-7）合组，理由是"插件生命周期管理"。但 FR-5 和 FR-7 之间无代码路径关联。LOW 问题（#8）。

### Wave 编排 ❌
Wave 1 安排 BG1 + BG2 + BG4 并行，但三者都修改 `plugin-service.ts`：

| Group | 修改 plugin-service.ts 区域 |
|-------|---------------------------|
| BG1 (Task 1+2) | 构造函数、Session handlers、Agent handlers |
| BG2 (Task 3) | flushSessionData/flushSessionDataForSession 方法 |
| BG4 (Task 7) | UI handlers (showSelect/showConfirm/showInput) |

三个 subagent 并行读取同一文件、各自修改不同区域、各自写回 → 后写者覆盖先写者的变更。**MUST FIX #1**。

### Subagent 配置完整性 ✅
每组包含 Agent、Model、注入上下文、读取文件、修改/创建文件。执行流程（TDD 三阶段）结构清晰。

### 上下文充分性 ⚠️
BG3 Task 6 注入上下文提到 "event-adapter.ts 精确行号" 但引用的方法 `onBridgeIntercept` 在代码中不存在（#7）。

## 五、Interface Contracts 审查

### 方法签名一致性 ⚠️
- `PluginService.constructor(registry, broker, deps: IPluginServiceDeps)` — 现有签名是 `constructor(registry: PluginRegistry, broker: IMessageBroker)`，无第三个参数。Task 1 添加 deps 但不更新 index.ts 调用点（#2）。
- `handleUiRequest` / `handleUiResponse` — Interface Contracts 只定义了 `handleUiRequest`，但 Task 7 Step 3 实现的是 `handleUiResponse`。两个方法应都出现在 Interface Contracts 中。

### AC 覆盖矩阵完整性 ✅
Spec Metrics Traceability 中 AC-1 至 AC-10 全部标注为 adopted，无遗漏。

---

## 发现的问题

| # | 优先级 | 文件/位置 | 描述 | 修改建议 |
|---|--------|----------|------|---------|
| 1 | MUST FIX | plan.md:Wave Schedule | **Wave 1 并行文件冲突**。BG1、BG2、BG4 并行执行，三者都修改 `plugin-service.ts`（构造函数 + Session/Agent handlers / flush methods / UI handlers）。subagent 并行写同一文件会丢失变更。 | 方案 A：将所有 plugin-service.ts 修改合并到一个 Group（如 BG1 扩大范围，BG2/BG4 仅处理其他文件）。方案 B：Wave 1 内串行化（BG1 → BG2 → BG4），但失去并行优势。方案 C：将 plugin-service.ts 按 handler 段拆分为独立文件（如 session-handlers.ts、agent-handlers.ts），各 Group 修改不同文件。推荐方案 A 或 C。 |
| 2 | MUST FIX | plan.md:Task 1 Files + index.ts:L75 | **index.ts 实例化调用点缺失**。当前 `new PluginService(pluginRegistry, server)`（index.ts L75）只传 2 个参数。Task 1 添加 deps 参数后，无人更新 index.ts 传入 `{ sessionService, configService, broadcastFn }`。此外 index.ts L58 是 EventAdapter 工厂函数，Task 6 需在此注入 hook 回调。index.ts 不在任何 Task 的 Files 列表中。 | (1) 将 `index.ts` 加入 Task 1 Files，Step 增加：修改 PluginService 实例化调用传入 deps（sessionService、configService 已在同文件 L76 前创建，broadcastFn 用 `server.broadcast.bind(server)` 或直接传 server）(2) 将 `index.ts` 加入 Task 6 Files，Step 增加：修改 EventAdapter 工厂函数，在 options 中传入 hook 执行回调。 |
| 3 | MUST FIX | plan.md:File Structure | **File Structure 遗漏 SDK 包 3 个文件**。Task 9 Files 列出 `packages/plugin-sdk/src/types.ts`、`packages/plugin-sdk/src/mock.ts`、`packages/plugin-sdk/tsconfig.json`，但 File Structure 表格只列了 `package.json` 和 `src/index.ts`。 | 在 File Structure 表中补充 3 行。 |
| 4 | MUST FIX | plan.md:Task 5 + e2e-test-plan:TS-6 | **findFiles 无独立测试文件**。E2E Test Plan TS-6 定义了 findFiles 专项测试（忽略 node_modules/.git、1000 条截断），但 plan 没有创建对应测试文件。Task 10 的 demo-e2e 测试只能间接覆盖。 | 在 Task 5 Files 中新增 `src-electron/runtime/test/plugin-findfiles.test.ts`，Step 3 写入此文件。同时在 File Structure 表中补充。 |
| 5 | MUST FIX | plan.md:Task 7 Step 1 vs spec.md:FR-4 | **UI 弹窗排队机制与 spec 不一致**。Spec FR-4 明确要求"同一时刻只允许一个 pending UI request（后来的排队）"，AC-4 要求"多个并发请求排队不丢失"。但 Task 7 Step 1 的 `handleUiRequest` 实现为每个请求独立创建 Promise 放入 `pendingUiRequests` Map，允许多个请求同时 pending。 | Task 7 需增加排队逻辑：(1) 维护 `activeUiRequest: string | null` 标记当前活跃请求 (2) 新请求到达时若 activeUiRequest 非空，推入 `pendingQueue: Array<{method, params, resolve}>` (3) 当前请求 resolve 后从 queue 取出下一个执行。 |
| 6 | MUST FIX | plan.md:File Structure BG2 + Task 3 Files | **plugin-storage.ts 归属不明**。File Structure 列出 `plugin-storage.ts | modify | BG2 | SessionData 文件持久化逻辑`，但 Task 3 的 Files 只列了 `plugin-service.ts` 和测试文件。6943 字节的现有文件需要修改却不被任何 Step 覆盖。 | 明确 SessionData 持久化逻辑放在 plugin-storage.ts 还是 plugin-service.ts 中。如果放在 plugin-storage.ts，Task 3 Files 需补充此文件，Steps 需说明修改内容。 |
| 7 | MUST FIX | plan.md:Task 6 Steps 2-4 + event-adapter.ts | **EventAdapter hook 注入机制未描述**。验证代码发现：(1) EventAdapter 无 PluginService 引用（无 import、无构造参数）(2) EventAdapterOptions 仅有 `onExtensionUIRequest` 和 `onBridgeUIRequest` 两个回调，无 hook 相关回调 (3) Task 6 Step 2 引用的 `onBridgeIntercept('onBeforeToolCall', ...)` 方法在 event-adapter.ts 中不存在（grep 确认零匹配）。Task 6 需要创建从 EventAdapter 到 PluginService.executeHooks 的完整调用路径，但 plan 未描述注入机制。 | Task 6 需新增 Step：在 EventAdapterOptions 中添加 hook 回调接口（参考现有 onExtensionUIRequest 模式），例如 `onHookExecute?: (hookType: string, context: Record<string, unknown>) => Promise<HookResult>`。同时 index.ts 的 EventAdapter 工厂函数需传入 `pluginService.executeHooks.bind(pluginService)` 作为回调。此 Step 与 #2 的 index.ts 修改可合并。 |
| 8 | LOW | plan.md:Task 4 | **Task 4 合并功能无关的 FR**。FR-5（权限推送，修改 plugin-activator.ts）和 FR-7（Worker crash 重建，修改 plugin-host.ts）共享 no code paths。合并在同一 Task 违反 Execution Groups 审查原则中的"功能关联度"。 | 拆分为 Task 4a（FR-5 权限推送）和 Task 4b（FR-7 Worker crash 重建），各自独立的 subagent 派遣。或者如果认为粒度太细，至少在 Task description 中说明合并理由。 |
| 9 | LOW | plan.md:Interface Contracts > PluginUIRequest | **PluginUIRequest 类型定义位置不明**。Interface Contracts 定义了 `PluginUIRequest` 数据接口（sessionId, requestId, method, title, message?, options?），但没有指定在哪个文件中定义。Task 1 修改 plugin-types.ts 添加 `IPluginServiceDeps`，PluginUIRequest 也应在此文件定义。 | 在 Task 7（UI handler 实现者）中明确 PluginUIRequest 的定义文件，建议 plugin-types.ts（由 Task 1 新增的接口文件）。或者 Task 7 Step 1 增加类型定义操作。 |
| 10 | LOW | plan.md:Spec Metrics Traceability | **AC-1 性能指标无验证步骤**。Spec AC-1 声明"Session API 的 RPC 往返延迟 < 50ms"，但 plan 无对应性能测试步骤，E2E Test Plan TS-1 也无性能断言。 | 如性能要求是硬指标，TS-1 应增加延迟断言（`expect(elapsed).toBeLessThan(50)`）。如是参考值，建议从 AC 中移除或标注为"参考指标"。 |
| 11 | INFO | e2e-test-plan.md + use-cases.md | E2E Test Plan 的 10 个 TS 与 AC 1:1 对应，每个 TS 包含正向 + 边界 + 异常场景。Use Cases 的 5 个 UC 均含 Main Flow + Alternative Paths + Preconditions + Postconditions + Module Boundaries。 | — |
| 12 | INFO | non-functional-design.md | 非功能设计覆盖稳定性（hook 超时放行、crash loop 防护）、数据一致性（atomic write、读己之写）、性能（fast-glob、批量 flush）、安全（权限模型、WS localhost、findFiles 范围限制）。 | — |

> 优先级定义：
> - **MUST FIX**：不修复则评审不通过，会阻塞流程
> - **LOW**：建议修复，但不阻塞
> - **INFO**：观察记录，无需操作

## 六、关键发现详述

### #1 Wave 1 并行文件冲突（MUST FIX）

plan.md 的 Wave Schedule 安排 Wave 1 = BG1 + BG2 + BG4 并行。代码验证确认三者都修改 `plugin-service.ts`：

- BG1 Task 1 Step 2: 构造函数新增 deps 参数（L55）
- BG1 Task 1 Step 3: Session handlers（L335 `registerSessionRpcHandlers`）
- BG1 Task 2 Step 1: Agent handlers（L408 `registerAgentRpcHandlers`）
- BG2 Task 3 Step 3: flushSessionData/flushSessionDataForSession（L602-640）
- BG4 Task 7 Step 1: UI handlers（L390 `registerUiRpcHandlers`）

subagent 并行执行时，各自读取文件原始版本、修改不同区域、写回结果。后写者覆盖先写者的变更。

**建议方案 C**（文件拆分）最优但改动大。方案 A（合并到一个 Group）最实际——将所有 plugin-service.ts 修改集中在 BG1（Task 1-3 + Task 7 的 plugin-service.ts 部分），BG2/BG4 仅处理 plugin-service.ts 以外的文件。

### #2 index.ts 实例化调用点缺失（MUST FIX）

代码验证：
```typescript
// index.ts L75 — 当前实例化
const pluginService = new PluginService(pluginRegistry, server)
```

Task 1 修改 PluginService 构造函数签名从 `(registry, broker)` 变为 `(registry, broker, deps)`，但没有 Task 负责更新 index.ts L75 传入 `{ sessionService, configService, broadcastFn }`。

同时 index.ts L58 是 EventAdapter 工厂函数：
```typescript
(sessionId, interceptor) => new EventAdapter(sessionId, interceptor.send, {
  onExtensionUIRequest: ...,
  onBridgeUIRequest: ...,
})
```

Task 6 需在此注入 hook 回调（#7），但 index.ts 不在任何 Task 的 Files 中。

**影响**：不修复此问题，所有 deps 始终为 undefined，Session API、Agent API、UI 弹窗、Hook 桥接的全部"真实对接"工作将成为死代码——handler 全部 fallback 到 stub。

### #7 EventAdapter hook 注入机制（MUST FIX）

代码验证确认：
1. `event-adapter.ts` 无 `handleBridgeIntercept` / `onBridgeIntercept` 方法（grep 零匹配）
2. `EventAdapterOptions` 只有 `onExtensionUIRequest` 和 `onBridgeUIRequest`，无 hook 相关接口
3. EventAdapter 构造函数不接受 PluginService 引用

Task 6 Steps 2-4 假设 hook 调用机制已存在，但实际上需要从零创建。这包括：
- 在 EventAdapterOptions 中定义 hook 回调类型
- 修改 EventAdapter 的 tool_execution_start/end case 调用回调
- 修改 index.ts 工厂函数传入回调实现

plan 高估了现有基础设施的完备性。Hook 桥接的实际工作量大于 Task 6 描述的"插入调用"。

## 七、结论

**需修改后重审**。7 条 MUST FIX 中，#1（并行冲突）和 #2（index.ts 缺失）是阻塞性最强的两条——不修复则 Wave 1 执行必然失败。#7（EventAdapter hook 注入）是 FR-8 实现的前提条件。其余 4 条（File Structure 不完整、测试文件缺失、排队机制不一致、plugin-storage.ts 归属）是 spec-plan 一致性问题。

### Summary

计划评审完成，第1轮，7条MUST FIX，需修改后重审。
