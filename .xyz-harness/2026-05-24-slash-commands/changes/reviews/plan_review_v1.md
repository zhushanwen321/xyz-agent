---
review:
  type: plan_review
  round: 1
  timestamp: "2026-05-24T10:00:00"
  target: ".xyz-harness/2026-05-24-slash-commands/spec.md + plan.md + e2e-test-plan.md"
  verdict: fail
  summary: "计划评审完成，第1轮，2条MUST FIX，需修改后重审"

statistics:
  total_issues: 5
  must_fix: 2
  must_fix_resolved: 0
  low: 2
  info: 1

issues:
  - id: 1
    severity: MUST_FIX
    location: "plan.md:EventAdapter 集成 (Task 2 Step 4) / src-electron/runtime/src/event-adapter.ts"
    title: "IEventAdapter 接口不支持 navigate-result 拦截回调注册"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 2
    severity: MUST_FIX
    location: "plan.md:Task 6 Step 3"
    title: "navigate 后使用 session.switch 重新加载消息不正确"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 3
    severity: LOW
    location: "plan.md:BG1 Execution Group"
    title: "BG1 文件数标注不准确（标注14文件，实际10个唯一文件）"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 4
    severity: LOW
    location: "plan.md:Task 2 Step 2 (navigateTree 实现)"
    title: "navigateTree 中 Promise.race 与 EventAdapter 回调的协作机制未完全说明"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 5
    severity: INFO
    location: "e2e-test-plan.md:Scenario 3"
    title: "navigate 超时场景的 E2E 验证方式不明确"
    status: open
    raised_in_round: 1
    resolved_in_round: null
---

# 计划评审 v1

## 评审记录
- 评审时间：2026-05-24 10:00
- 评审类型：计划评审
- 评审对象：spec.md + plan.md + e2e-test-plan.md (Session Tree 导航 + Fork/Clone)

---

## 1. Spec 完整性

| 检查项 | 结果 | 说明 |
|--------|------|------|
| 目标明确 | ✅ | "在 xyz-agent GUI 中实现 pi session tree 的可视化、navigate 和 fork 功能" |
| 范围合理 | ✅ | FR1-FR6 边界清晰，"不在范围"章节明确排除了 summarize/label/resume 等 |
| AC 可量化 | ✅ | AC1-AC6 共 34 条具体可验证标准，无模糊表述 |
| 待决议项 | ✅ | 无 `[待决议]` 标记，风险可控 |

**结论**: spec 完整度良好，无遗漏项。

---

## 2. Plan 可行性

### 任务拆分

| 检查项 | 结果 | 说明 |
|--------|------|------|
| 粒度适中 | ✅ | 7 个 Task，每个可由一个 subagent 独立完成 |
| 依赖正确 | ✅ | Task1→Task2, Task3→Task4, Task1/2→Task5→Task6，符合逻辑 |
| Wave 编排合理 | ✅ | Wave1 并行(1+3), Wave2 并行(2+4), Wave3(5), Wave4(6) |
| 工作量估算 | ⚠️ | 见 Issue #3（BG1 文件数标注不准确） |

### 文件路径验证

| 计划路径 | 实际存在 | 说明 |
|---------|---------|------|
| `src-electron/shared/src/protocol.ts` | ✅ | 精确匹配 |
| `src-electron/runtime/src/types.ts` | ✅ | 精确匹配 |
| `src-electron/runtime/src/server.ts` | ✅ | 精确匹配 |
| `src-electron/runtime/src/event-adapter.ts` | ✅ | 精确匹配 |
| `src-electron/runtime/src/interfaces.ts` | ✅ | 精确匹配 |
| `src-electron/runtime/src/process-manager.ts` | ✅ | 精确匹配 |
| `src-electron/runtime/src/services/session-service.ts` | ✅ | 精确匹配 |
| `src-electron/renderer/src/components/panel/PanelBar.vue` | ✅ | 精确匹配 |
| `src-electron/renderer/src/composables/useChat.ts` | ✅ | 精确匹配 |
| `src-electron/renderer/src/stores/chat.ts` | ✅ | 精确匹配 |

**结论**: 所有文件路径与实际代码库结构精确匹配。

---

## 3. Spec-Plan 一致性

### AC 覆盖矩阵

| AC | 覆盖状态 | 对应 Task | 说明 |
|----|---------|----------|------|
| AC1 (Tree 数据读取 - 5 条) | ✅ | Task 1 Step 3-4, Task 2 Step 1-2 | 每条都有对应实现步骤 |
| AC2 (Tree 展示 - 8 条) | ✅ | Task 5 Step 1-3 | flatNodes 算法覆盖缩进、高亮、脉冲点、label、filter、操作栏 |
| AC3 (Navigate - 9 条) | ✅ | Task 3 Step 1, Task 2 Step 2+4, Task 6 Step 2-3 | 含 no-op 检查、超时处理、user message 预填 |
| AC4 (Fork - 6 条) | ✅ | Task 2 Step 1-2, Task 6 Step 2+4 | 含 success 字段检查、失败场景、旧 session 不受影响 |
| AC5 (Clone - 2 条) | ✅ | Task 2 Step 1-2 | cloneSession 方法 + sidebar 更新 |
| AC6 (Extension 加载 - 4 条) | ✅ | Task 3 Step 1, Task 4 Step 1-2 | get_commands 检查 + navigateCapable 缓存 |

### 额外工作检查

| plan 中的工作 | spec 是否提及 | 判断 |
|-------------|------------|------|
| `VITE_MOCK mock 数据` postponed | 未提及 | ✅ 已明确标记为 postponed |
| `session.tree-capability` WS 消息 | 未在 WS 协议表中 | ⚠️ 这是一个合理的实现细节扩展，不需要 spec 提及 |
| `navigateCapable` 字段在 TreeData 中 | 未在 TreeNode 定义中 | ✅ 合理的实现细节 |

**结论**: spec 中的每个需求在 plan 中都有对应的 Task 和具体步骤，覆盖完整。

---

## 4. Execution Groups 合理性

### 分组检查

| 检查项 | BG1 (后端) | FG1 (前端) | 判定 |
|--------|-----------|-----------|------|
| 文件数 (唯一) | 10 | 5 | ✅ 均 ≤ 10 |
| Task 数 | 4 | 2 | ✅ 合理 |
| 类型划分 | 纯后端 | 纯前端 | ✅ 无混合 |
| 功能关联度 | JSONL读取+Service+Extension | Store+Composable+组件 | ✅ 组内关联紧密 |
| Wave 依赖 | Task1→2, Task3→4 正确 | Task5→6 正确 | ✅ |

### Subagent 配置检查

| 配置项 | BG1 | FG1 | 判定 |
|--------|-----|-----|------|
| Agent | general-purpose | general-purpose | ✅ |
| Model | 自动选择 | 自动选择 | ✅ |
| 读取文件列表 | 8 个文件，路径精确 | 5 个文件，路径精确 | ✅ |
| 注入上下文 | Spec FR1-FR6+AC+WS协议+CLAUDE.md规则 | Spec FR2+AC2-AC4+设计稿+编码规范 | ✅ |

**结论**: Execution Groups 编排合理，Wave 依赖正确，Subagent 配置完整。

---

## 5. 后端设计充分性 (L1)

由于 plan 标记为 L1（单文件 plan），按方法论进行后端设计检查：

| 检查项 | 结果 | 说明 |
|--------|------|------|
| 说明"为什么"而不只是"做什么" | ✅ | JSONL 只读不用 pi RPC、extension 替代改 pi 源码，都有明确理由 |
| 存储变更选型理由 | ✅ | JSONL 只读不写，leafId 从 RPC get_state 获取而非文件推导 |
| 边界条件处理 | ⚠️ | 见 Issue #1（EventAdapter 接口不支持 navigate-result 回调） |
| 异常处理 | ✅ | fork 的 success 检查、超时处理、try-catch 跳过坏行 |

---

## 发现的问题

| # | 优先级 | 文件/位置 | 描述 | 修改建议 |
|---|--------|----------|------|---------|
| **1** | **MUST FIX** | `plan.md:Task 2 Step 4` / `src-electron/runtime/src/event-adapter.ts` | **IEventAdapter 接口不支持 navigate-result 拦截回调注册。** plan 预期 EventAdapter 在 `translate()` 中检测到 `__xyz_type:"navigate-result"` 后能将结果路由到 SessionService 中 `navigateTree()` 的 pending Promise。但当前 EventAdapter 的构造器只接受 `(sessionId, WsSender)`，无任何回调注册机制——所有翻译结果都通过 `this.send()` 发送到 WS，没有出口将事件"劫持"回调用方。 | 方案 A（推荐）：在 EventAdapter 中新增 `navigateResultCallback?: (result: NavigateResult) => void` 构造参数 + 可选 `setNavigateResultCallback(fn)` 方法。当 `translate()` 检测到 `__xyz_type` 消息时，不走 `this.send()` 而是调用 callback。方案 B：不修改 EventAdapter，改由 SessionService 在 `navigateTree()` 中通过 `client.onEvent()` 注册独立的监听器，绕过 EventAdapter。需要评估哪种与现有架构更一致。 |
| **2** | **MUST FIX** | `plan.md:Task 6 Step 3` | **navigate 后使用 `session.switch` 重新加载消息不正确。** navigate 是在同一 session 内移动 leaf 指针，不切换 session。使用 `session.switch` 会触发 sidecar 的 session 切换逻辑（可能创建新连接、切换上下文），与 navigate 的语义矛盾。Spec FR3 "Navigate 后"明确写的是"从 pi 重新加载消息"而非"切换 session"。 | 应使用 `session.history`（已有实现）重新获取同 session 的消息，或定义新的消息类型如 `session.refresh`。不要使用 `session.switch`。确认 `session.history` 在 navigate 后是否能正确返回从 root 到新 leaf 的消息（已有 getHistory 方法）。 |
| **3** | **LOW** | `plan.md:BG1 Execution Group` | **BG1 文件数标注不准确。** plan 标注 BG1 为 "14 个文件（8 create + 6 modify）"，但实际统计：create 3 个（verify-*.cjs, session-tree-reader.ts, extension.js），modify 7 个（types.ts, protocol.ts, session-service.ts, interfaces.ts, server.ts, event-adapter.ts, process-manager.ts），共 10 个**唯一**文件。"14 个文件"可能包含了文件读取操作（8 个读文件），但 Execution Group 的 "文件数" 应只统计 create+modify 的文件，不包含 read-only 文件。 | 将 BG1 文件数修正为 10（3 create + 7 modify），明确为唯一文件数。 |
| **4** | **LOW** | `plan.md:Task 2 Step 2` | **navigateTree 中 Promise.race 与 EventAdapter 回调的协作机制未完全说明。** plan 说"结果由 EventAdapter 拦截后通过回调解析"但未说明回调 function 如何传递到 EventAdapter。如果使用 Issue #1 方案 A（EventAdapter 构造函数参数），则需要在 `SessionService.navigateTree()` 执行前就将 callback 注册到 EventAdapter，但 EventAdapter 在 session 创建时已构造，此时还没有 pending Promise 的 resolve/reject。 | 在 plan 中补充协作机制：SessionService 维护一个 `pendingNavigate: Map<string, {resolve, reject, timer}>`。EventAdapter 拦截到 `__xyz_type` 后调用 `sessionService.resolveNavigate(sessionId, result)` 来触发 map 中的 resolve。 |
| **5** | **INFO** | `e2e-test-plan.md:Scenario 3` | **navigate 超时场景的 E2E 验证方式不明确。** plan 中 define 了 5s 超时，e2e-test-plan 提到"验证超时场景"但没有说明如何在 E2E 测试中可靠地模拟超时。手动 E2E 测试需要等待 5 秒才能验证，且如何让 pi extension 不响应以触发超时没有被描述。 | 建议补充：① 单元测试层面 mock `client.prompt()` 让 Promise 永远不 resolve 来测试超时路径；② E2E 层面可以通过启动不带 extension 的 pi 进程来模拟 navigate 不可用状态（测试错误路径），而非真正等待超时。 |

> 优先级定义：
> - **MUST FIX**: 不修复则评审不通过，会阻塞流程
> - **LOW**: 建议修复，但不阻塞
> - **INFO**: 观察记录，无需操作

---

## 等级判定校准

以下检查确认 Issue #1 和 #2 的 MUST FIX 判定符合规则（不是我故意标高的）：

- **Issue #1（EventAdapter 接口缺失）**: 如果按现有 plan 实施，代码会因为 IEventAdapter/EventAdapter 没有回调接口而在执行期无法将 navigate-result 传回 SessionService，导致 navigate 永远 pending → **功能失效**，必须标 MUST FIX。
- **Issue #2（session.switch 误用）**: 使用 session.switch 来 reload 消息会导致 session 切换副作用（可能终止当前连接、刷新 session 列表等），实际效果与预期完全不一致 → **功能失效**，必须标 MUST FIX。

---

## 结论

需修改后重审。

### Summary

计划评审完成，第1轮，2条MUST FIX，需修改后重审。spec 质量良好无重大缺陷。主要问题集中在两个方面：EventAdapter 缺少 navigate-result 回调机制（架构级缺失），以及 navigate 后误用 session.switch（核心交互流程错误）。
