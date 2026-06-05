---
review:
  type: plan_review
  round: 1
  timestamp: "2026-06-05T14:55:00"
  target: ".xyz-harness/2026-06-05-chat-area-round1/plan.md"
  verdict: fail
  summary: "计划评审完成，第1轮，1条MUST FIX（tree-message-handler.ts 修改遗漏），需修改后重审"

statistics:
  total_issues: 7
  must_fix: 1
  must_fix_resolved: 0
  low: 4
  info: 2

issues:
  - id: 1
    severity: MUST_FIX
    location: "plan.md: File Structure + Task List (FG6)"
    title: "tree-message-handler.ts 修改遗漏 — Fork/Clone label 编排层缺失"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 2
    severity: LOW
    location: "plan.md: Task List #13, #19 vs FG4/FG5 Execution Flow"
    title: "Task List 与 Execution Flow 依赖关系不一致"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 3
    severity: LOW
    location: "plan.md: FG4, FG5 Execution Groups"
    title: "FG4/FG5 混合前后端任务类型"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 4
    severity: LOW
    location: "plan.md: Interface Contracts + FG1 Task 23 Subagent 配置"
    title: "Fork/Clone 现有 WS 协议类型未引用，Task 23 上下文不充分"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 5
    severity: LOW
    location: "plan.md: FG3 File Structure (sidebar/index.ts)"
    title: "sidebar/index.ts 标注为 FG3 modify 但无 Task 显式负责"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 6
    severity: INFO
    location: "plan.md: FG1 Files (预估)"
    title: "FG1 文件数标注 11 vs 唯一文件 10（MessageActionMenu.vue 重复计数）"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 7
    severity: INFO
    location: "plan.md: Task 20"
    title: "Send button 视觉变化（流式时红色 stop 图标）未在 Task 20 显式追踪"
    status: open
    raised_in_round: 1
    resolved_in_round: null
---

# 计划评审 v1

## 评审记录
- 评审时间：2026-06-05 14:55
- 评审类型：计划评审
- 评审对象：`.xyz-harness/2026-06-05-chat-area-round1/plan.md`（含 spec.md / e2e-test-plan.md / use-cases.md / non-functional-design.md）
- 评审轮次：1

## 评审维度

### 1. Spec 完整性

| 检查项 | 结果 | 说明 |
|--------|------|------|
| 目标是否明确 | ✅ 通过 | 一段话可概括："为聊天区域实现 9 项高价值改进（消息操作菜单、批量选择、分支指示、Utility Rail、侧边栏折叠、macOS 全屏布局、发送模式状态栏、Fork/Clone 命名）" |
| 范围是否合理 | ✅ 通过 | 9 项功能彼此独立，单功能复杂度低至中。Out of Scope 边界清晰（8 项排除） |
| 验收标准可量化 | ⚠️ 基本通过 | 12 条 AC 均可人工验证，但验证方式以"手动测试/视觉检查"为主，无法自动化回归。对于 UI 功能可接受 |
| `[待决议]` 标记 | ✅ 无 | 无未决议项 |

### 2. Plan 可行性

| 检查项 | 结果 | 说明 |
|--------|------|------|
| 任务拆分合理性 | ⚠️ 有缺口 | 23 个 Task 粒度适中，但 FR9（Fork/Clone 命名）缺少对编排层 `tree-message-handler.ts` 的修改任务（详见 Issue #1） |
| 依赖关系正确性 | ⚠️ 部分不一致 | Task List 与 Execution Flow 存在 2 处依赖不一致（详见 Issue #2） |
| 工作量估算 | ✅ 合理 | L1 复杂度，8/9 前端为主 + 1 项 WS 协议扩展 + 1 项后端命名修改 |
| 遗漏检查 | ❌ 有遗漏 | `tree-message-handler.ts` 未出现在 File Structure 或 Task List 中（详见 Issue #1） |

### 3. Spec 与 Plan 一致性

| 检查项 | 结果 | 说明 |
|--------|------|------|
| FR 逐条覆盖 | ✅ 通过 | FR1-FR9 均有对应 Task 覆盖（Spec Coverage Matrix 完整） |
| AC 逐条覆盖 | ✅ 通过 | AC1-AC12 均在 Spec Coverage Matrix 中有对应行 |
| 额外工作 | ✅ 无 | 无 spec 未提及的额外工作 |
| 接口契约与实际代码一致性 | ⚠️ 有风险 | plan 的 Interface Contracts 未引用已有的 `session.tree-fork` / `session.tree-clone` 协议类型，且新定义的 `rebindAfterFork` label 参数的调用方缺失（详见 Issue #1, #4） |

### 4. Execution Groups 合理性

| 检查项 | 结果 | 说明 |
|--------|------|------|
| 分组大小 | ✅ 通过 | FG1 唯一文件 10 个（标注 11 为重复计数，实际合规），其余组 ≤ 5 |
| 类型划分 | ⚠️ 不完全合规 | FG4、FG5 混合前端/后端 Task（详见 Issue #3） |
| 功能关联度 | ✅ 通过 | 各组内 Task 功能关联紧密 |
| 依赖关系 | ✅ 通过 | FG6 → FG1.Task23 的跨组依赖已标注 |
| Wave 编排 | ✅ 通过 | Wave 1 内分两批并行（Semaphore 3 限制），Task 23 追加在 FG6 完成后 |
| Subagent 配置完整性 | ⚠️ 部分不足 | Task 23 的读取文件缺少 `protocol.ts`（详见 Issue #4） |
| 上下文充分性 | ⚠️ 部分不足 | FG1 注入上下文未涵盖 fork/clone WS 协议类型（详见 Issue #4） |

---

## 发现的问题

| # | 优先级 | 文件/位置 | 描述 | 修改建议 |
|---|--------|----------|------|---------|
| 1 | MUST FIX | plan.md: File Structure + Task List (FG6) | **`tree-message-handler.ts` 修改遗漏 — Fork/Clone label 编排层缺失。** 经验证源码，`runtime/src/tree-message-handler.ts` 是 fork/clone 的实际编排者：fork 路径（第 57-59 行）调用 `treeService.forkFromEntry()` 后调用 `sessionService.rebindAfterFork(sid, newSid, sessionFile)`，其中 `rebindAfterFork` 使用 `old.label`（第 462 行）。Plan 修改了 `session-service.ts`（Task 21）的 `rebindAfterFork` 签名以接受 label 参数，修改了 `tree-service.ts`（Task 22）添加 labelSuffix 参数，但**未修改调用方** `tree-message-handler.ts`。同时，clone 路径（第 82 行）完全不调用 `rebindAfterFork`（clone 创建新进程而非 rebind），需要额外通过 `session.rename` 或在 `cloneSession` 内部处理 label 修改。此文件未出现在 File Structure 表中。 | 1. File Structure 新增 `runtime/src/tree-message-handler.ts | modify | FG6`；2. 新增 Task（如 Task 24）"修改 tree-message-handler.ts：fork 路径获取原 session label + '-fork' 后缀传递给 rebindAfterFork；clone 路径在 cloneSession 成功后调用 session rename 修改 label"；3. Task 24 depends on Task 21, 22；4. 更新 FG6 Subagent 配置的读取文件列表加入 `tree-message-handler.ts` |
| 2 | LOW | plan.md: Task List #13, #19 vs FG4/FG5 Execution Flow | **Task List 与 Execution Flow 依赖关系不一致。** Task List 中 Task 13（style.css）和 Task 19（SendModeStatusBar）标记为无依赖（`—`），但 FG4/FG5 的 Execution Flow 分别标记为 `depends on 16` 和 `depends on 18`。两处应一致。 | 统一到 Task List 的定义：Task 13（纯 CSS）和 Task 19（纯 UI 组件）确实不依赖后端任务。在 Execution Flow 中移除这些虚假依赖，或改为"建议顺序"说明 |
| 3 | LOW | plan.md: FG4, FG5 Execution Groups | **FG4/FG5 混合前后端任务类型。** FG4 含 Task 15-16（backend）和 Task 13-14（frontend）；FG5 含 Task 17（shared）、18（backend）和 19-20（frontend）。方法论要求"无混合类型 Group"。 | 这两组是紧密耦合的 IPC 链路（main → preload → renderer），拆分会增加协调成本。建议保留但在 Execution Group 描述中显式说明混合原因，或将后端 task 拆为独立 sub-group |
| 4 | LOW | plan.md: Interface Contracts + FG1 Task 23 Subagent 配置 | **Fork/Clone 现有 WS 协议类型未引用，Task 23 上下文不充分。** `shared/protocol.ts` 中已存在 `session.tree-fork: { sessionId: string; entryId: string }` 和 `session.tree-clone: { sessionId: string }` 类型，但 Interface Contracts 仅列了 `message.steer` / `message.follow_up` 新增类型。FG1 Task 23 的 subagent 读取文件列表不含 `protocol.ts`，subagent 无法知道前端应发送哪个 WS 消息触发 fork/clone。 | 1. Interface Contracts 新增 `shared/protocol` 下 `session.tree-fork` / `session.tree-clone` 的引用（标记为 existing）；2. FG1 Task 23 subagent 的读取文件加入 `shared/src/protocol.ts` |
| 5 | LOW | plan.md: FG3 File Structure | **sidebar/index.ts 标注为 FG3 modify 但无 Task 显式负责。** 此文件是 sidebar barrel export，新增 `SidebarCollapseHandle` 和 `SidebarHeader` 组件后需要更新 export。 | Task 11 或 12 的描述中显式提及"更新 sidebar/index.ts 导出新组件" |
| 6 | INFO | plan.md: FG1 Files (预估) | **FG1 文件数标注 11 vs 唯一文件 10。** `MessageActionMenu.vue` 在 File Structure 中出现两次（create + modify），实际是同一文件。唯一文件数为 10，符合 ≤10 规则。 | 将 FG1 描述改为"10 个文件（6 create + 4 modify，其中 MessageActionMenu.vue create+modify）" |
| 7 | INFO | plan.md: Task 20 | **Send button 视觉变化未显式追踪。** Spec FR8 明确"发送按钮始终一个：空闲时 accent 背景 ↑ 图标，流式时红色背景 ■ 图标（stop）"。Task 20 描述为"集成状态栏 + Alt 键检测"，未提及 send button 状态切换。虽然 ChatInput 修改自然会包含，但显式追踪更利于验收。 | Task 20 描述补充"+ send button 状态视觉切换（idle ↑ accent / streaming ■ red）" |

> 优先级定义：
> - **MUST FIX**：不修复则评审不通过，会阻塞流程
> - **LOW**：建议修复，但不阻塞
> - **INFO**：观察记录，无需操作

---

## Issue #1 详细分析（MUST FIX）

### 问题根因

Plan 修改了 FR9（Fork/Clone 命名）的**服务层接口**（Task 21: `session-service.ts` + Task 22: `tree-service.ts`），但遗漏了**编排层** `tree-message-handler.ts`。

### 源码证据

**Fork 路径**（`tree-message-handler.ts:54-62`）：
```
case 'session.tree-fork': {
  const result = await this.ctx.treeService.forkFromEntry(sid, entryId)  // ← 无 labelSuffix
  if (result.success && result.newSessionId) {
    await this.ctx.sessionService.rebindAfterFork(sid, result.newSessionId, result.sessionFile)  // ← 无 label
    this.ctx.broadcastSessionList()
  }
}
```

**Clone 路径**（`tree-message-handler.ts:80-89`）：
```
case 'session.tree-clone': {
  const result = await this.ctx.treeService.cloneSession(sid)  // ← 无 labelSuffix
  if (result.success) {
    this.ctx.broadcastSessionList()  // ← 无 rename，新 session label = 原 label
  }
}
```

**rebindAfterFork 使用 old.label**（`session-service.ts:462`）：
```
await this.initializeManagedSession(newSessionId, client, old.cwd, old.label, sessionFilePath)
//                                                      ^^^^^^^^ ← 始终用原 label，不会变成 "原名称-fork"
```

### 后果

如果不修改 `tree-message-handler.ts`：
- **Fork**: `rebindAfterFork` 仍使用 `old.label`（Task 21 的签名改了但调用方没传），新 session 名字与原 session 相同 → **AC10 失败**
- **Clone**: 新 session label 来自 pi 状态（= 原 label），无 rename 操作 → **AC10 失败**

### 建议修复方案

1. File Structure 新增：
   ```
   runtime/src/tree-message-handler.ts | modify | FG6
   ```

2. 新增 Task 24：
   ```
   | 24 | 修改 tree-message-handler.ts fork/clone 路径传递 label | backend | 21, 22 | FG6 |
   ```
   - Fork 路径：获取 `sessionService.getSummary(sid)?.label`，拼接 `-fork`，传递给 `rebindAfterFork`
   - Clone 路径：`cloneSession` 成功后，调用 `sessionService.rename(newSessionId, oldLabel + '-clone')`

3. 更新 FG6 Subagent 配置的读取文件加入 `tree-message-handler.ts`

4. 更新 Spec Coverage Matrix 中 AC10 的 Data Flow

---

## 结论

**需修改后重审。** 1 条 MUST FIX 涉及 FR9（Fork/Clone 命名）的编排层遗漏，不修复将导致 AC10 两条验收标准失败。

### Summary

计划评审完成，第1轮，1条MUST FIX（`tree-message-handler.ts` 修改遗漏导致 Fork/Clone 命名功能无法实现），需修改后重审。
