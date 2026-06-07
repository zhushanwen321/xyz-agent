---
review:
  type: plan_review
  round: 1
  timestamp: "2026-06-07T22:30:00"
  target: ".xyz-harness/2026-06-07-chat-send-mode-design/plan.md"
  verdict: pass
  summary: "计划评审完成，第1轮通过，0条MUST FIX，6条LOW建议改进"

statistics:
  total_issues: 7
  must_fix: 0
  must_fix_resolved: 0
  low: 6
  info: 1

issues:
  - id: 1
    severity: LOW
    location: "spec.md > FR4 消息流转第4点"
    title: "queue.done banner 无 Task 覆盖"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 2
    severity: LOW
    location: "plan.md > FG4 文件数预估"
    title: "FG4 文件数预估 5 与实际 7 不符"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 3
    severity: LOW
    location: "plan.md > File Structure 表"
    title: "event-adapter.ts 列为 BG1 modify 但实际无需改动"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 4
    severity: LOW
    location: "spec.md > FR1 三种模式定义表 vs OQ3/Key Decisions"
    title: "spec FR1 表格 Steer 行为描述与 OQ3 结论矛盾"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 5
    severity: LOW
    location: "plan.md > Task 5 + Task 7"
    title: "队列消息 dequeue 后 sendMode 数据流未明确"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 6
    severity: LOW
    location: "plan.md > FG4 Subagent 配置"
    title: "FG4 单 subagent 配置涉及 7 文件，超出 5 文件推荐上限"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 7
    severity: INFO
    location: "spec.md > OQ3 vs plan.md > Task 1"
    title: "spec 标注 steer/follow_up 改造'本 spec 范围外'但 plan 正确纳入"
    status: open
    raised_in_round: 1
    resolved_in_round: null
---

# 计划评审 v1

## 评审记录
- 评审时间：2026-06-07 22:30
- 评审类型：计划评审
- 评审对象：`.xyz-harness/2026-06-07-chat-send-mode-design/plan.md`（含 spec.md、e2e-test-plan.md、use-cases.md、non-functional-design.md）

---

## 1. Spec 完整性

| 维度 | 评估 |
|------|------|
| 目标明确性 | ✅ 明确。三段式背景描述了三个缺口，Design Goals 5 条可对应到 5 个 FR |
| 范围合理性 | ✅ 有明确 Out of Scope，范围边界清晰 |
| 验收标准可量化 | ⚠️ 12 条 AC 以手动测试为主，无自动化验证指标。对 UI 功能可接受，但 AC9（队列消息端到端流转）涉及多步骤时序，建议至少有可复现的测试步骤（e2e-test-plan.md 已补充） |
| 待决议项 | ✅ 无 `[待决议]` 项。三个 OQ 都给出了明确结论 |
| FR 间一致性 | ⚠️ **#4 — FR1 表格 Steer 行为与 OQ3 矛盾**（详见问题列表） |

## 2. Plan 可行性

| 维度 | 评估 |
|------|------|
| 任务拆分 | ✅ 8 个 Task，粒度适中（单个 Task ≤ 5 步） |
| 依赖关系 | ✅ Wave 编排合理：Wave 1（BG1+FG1）→ Wave 2（FG2+FG3）→ Wave 3（FG4）。被依赖的组排在前面 |
| 工作量估算 | ✅ 总计约 12 个文件（3 modify 后端 + 9 前端），对照功能范围合理 |
| Task 覆盖 | ⚠️ **#1 — queue.done banner 未实现**，**#3 — event-adapter.ts 归属问题**（详见问题列表） |

## 3. Spec 与 Plan 一致性

逐条 AC 对照：

| AC | Spec 要求 | Plan Task | 覆盖状态 |
|----|----------|-----------|---------|
| AC1 | Mode Switcher popover 切换 | Task 3 | ✅ |
| AC1a | 窄面板 Mode Switcher 简化 | Task 7 | ✅ |
| AC1b | 窄面板 Queue badge | Task 7 | ✅ |
| AC2 | Ctrl+Enter steer 视觉高亮 | Task 3 | ✅ |
| AC3 | Alt+Enter follow-up 视觉高亮 | Task 3 | ✅ |
| AC4 | Steer 消息显示 chip | Task 6 | ✅ |
| AC5 | Follow-up 消息显示 chip | Task 6 | ✅ |
| AC6 | Abort 消息显示中断标记 | Task 2 + Task 6 | ✅ |
| AC7 | Queue 有消息时显示/空时隐藏 | Task 5 | ✅ |
| AC8 | Queue 正确标记 steer/follow-up | Task 5 | ✅ |
| AC9 | 队列消息处理后移到消息流 | Task 1 + Task 5 | ✅ |
| AC10 | Global Loading Bar 动画 | Task 4 | ✅ |
| AC11 | prefers-reduced-motion | Task 4 | ✅ |
| AC12 | i18n 支持 | Task 8 | ✅ |

**结论**：全部 12 条 AC 均有 adopted 状态和对应 Task，无遗漏。

**Plan 中超出 spec 范围的工作**：Task 1（steer/follow_up RPC 改造）在 spec OQ3 中标注"本 spec 范围外"，但 Key Decisions 又列为"前置依赖"。Plan 纳入是正确的——不纳入则 Queue Component 无数据源。详见 #7。

**FR 正文 vs AC 覆盖**：FR4 "队列全部处理完后显示绿色 队列已完成 banner"有 FR 正文描述和 i18n key（`queue.done`），但无对应 AC。Plan 也没有 Task 覆盖 banner 实现。详见 #1。

## 4. Execution Groups 合理性

### 分组与类型

| Group | Tasks | 文件数 | 类型 | 评估 |
|-------|-------|--------|------|------|
| BG1 | 1 | 3 (实际应为 3，非 File Structure 的 4) | backend | ✅ |
| FG1 | 2 | 4 | frontend | ✅ |
| FG2 | 2 | 2 | frontend | ✅ |
| FG3 | 1 | 1 | frontend | ✅ |
| FG4 | 2 | 7 (标为 5) | frontend | ⚠️ 文件数标注错误，见 #2 #6 |

### Wave 编排

```
Wave 1: BG1 + FG1（无互相依赖，可并行）
Wave 2: FG2 + FG3（依赖 FG1，可并行）
Wave 3: FG4（集成，依赖所有前置）
```

- Wave 1 内 BG1 和 FG1 无文件冲突、无数据竞争 ✅
- Wave 2 内 FG2 和 FG3 无文件冲突（各自独立创建/修改不同文件）✅
- BG1 → FG2 依赖合理（queue_update 事件需要 pi 原生 RPC 才触发）✅
- FG1 → FG3 依赖合理（Message 类型扩展）✅
- FG1 → FG2 依赖弱但安全（QueueState 已存在，FG2 实际不依赖 FG1 的改动，但不影响正确性）✅

### Subagent 配置

- 所有 Group 都包含 Agent、Model、注入上下文、读取文件、修改/创建文件 ✅
- FG4 的 7 文件超出单 subagent 5 文件推荐上限，建议拆为 Task 7 和 Task 8 两次 subagent 调度（见 #6）

## 5. Interface Contracts 审查

### AC 覆盖矩阵

spec 中 12 条 adopted AC 在 plan 的 Spec Coverage Matrix 中全部有对应行 ✅。无 postponed AC。

### 方法签名一致性

| Module | Method | plan 描述 | Task 代码片段 | 一致？ |
|--------|--------|----------|--------------|--------|
| RpcClient | steer | `sendCommand('steer', { message: content })` | Task 1 Step 1 | ✅ |
| RpcClient | followUp | `sendCommand('follow_up', { message: content })` | Task 1 Step 1 | ✅ |
| SessionService | steerMessage | `client.steer(content)` + 错误处理 | Task 1 Step 2 | ✅ |
| SessionService | followUpMessage | `client.followUp(content)` + 错误处理 | Task 1 Step 2 | ✅ |
| chatStore | completeStream | 新增 `stopReason?: string` 参数 | Task 2 Step 2 | ✅ |
| useChat | onComplete | 读取 `msg.payload.stopReason` | Task 2 Step 3 | ✅ |

### stopReason 数据流验证

通过代码确认完整链路：
1. **pi → event-adapter**：pi `agent_end` 事件含 `stopReason`（`event-adapter.ts` L189-204 已通过 `STOP_REASON_MAP` 映射并放入 `message.complete` payload）✅
2. **event-adapter → ws-client → event-bus → useChat**：`onComplete`（`useChat.ts` L168）当前只读 `usage`，Task 2 将新增读取 `stopReason` ✅
3. **useChat → chatStore**：`store.completeStream({ stopReason }, sid)` → `isInterrupted` 赋值 ✅

**关键确认**：`event-adapter.ts` **不需要改动**（已正确转发 stopReason）。File Structure 表将其列为 BG1 modify 是错误的（见 #3）。

## 6. 后端设计充分性（L1 检查清单）

| 维度 | 评估 |
|------|------|
| "为什么"这样实现 | ✅ Task 1 明确解释：当前 abort+resend 绕过 pi 队列，queue_update 不触发 |
| 存储变更选型理由 | ✅ 无存储变更（纯 RPC 层改造） |
| API 端点与业务对应 | ✅ steer/follow_up RPC 与 FR1 三种模式对应 |
| 边界条件/异常处理 | ✅ session 不活跃时 throw，server.ts 有 try/catch |
| 非功能要求 | ✅ non-functional-design.md 覆盖稳定性、一致性、性能、安全 |

---

## 发现的问题

| # | 优先级 | 文件/位置 | 描述 | 修改建议 |
|---|--------|----------|------|---------|
| 1 | LOW | spec.md > FR4 消息流转第4点 | **queue.done banner 无 Task 覆盖**。FR4 正文明确要求"队列全部处理完后显示绿色 队列已完成 banner，3 秒后自动消失"，i18n 表有 `queue.done` key。但无 AC 对应，plan 也无 Task 实现。banner 需要额外的状态追踪（检测队列从有→空的转换）和 3 秒 auto-dismiss 定时器 | 方案 A：在 Task 5 中补充 banner 实现步骤（检测 queueState 变化、渲染 banner、定时器）。方案 B：明确声明 banner 延后到后续迭代，并在 Key Decisions 中记录 |
| 2 | LOW | plan.md > FG4 header | **FG4 文件数预估错误**。FG4 头部标注"5 个文件（0 create + 5 modify）"，但 Task 7 涉及 3 文件 + Task 8 涉及 4 文件 = 共 7 文件（ChatInput.vue、WidgetDock.vue、style.css、SendModeStatusBar.vue、QueueComponent.vue、MessageBubble.vue、GlobalLoadingBar.vue） | 更正 FG4 文件数为 7（0 create + 7 modify） |
| 3 | LOW | plan.md > File Structure 表 | **event-adapter.ts 归属错误**。File Structure 表列出 `event-adapter.ts | modify | BG1 | message.complete 转发 stopReason`，但代码确认 event-adapter 已正确转发 stopReason（L201-204），无需改动。Task 1 也不包含此文件。这会让 subagent 困惑 | 从 File Structure 表移除 event-adapter.ts 行 |
| 4 | LOW | spec.md > FR1 表格 Steer 行 | **FR1 与 OQ3 对 Steer 行为描述矛盾**。FR1 表格写 Steer "先 abort 当前生成，再处理本条消息"，但 OQ3 调研结论是"改用 pi 原生 steer RPC 后不会 abort，在工具调用间隙注入"。Key Decisions 采用 OQ3 结论。plan 正确跟随 OQ3，但 spec 内部不一致可能误导 subagent | 更新 FR1 表格 Steer 行的"AI 忙碌时行为"为"排入 pi 的 steeringMessages[]，在当前 turn 的工具调用间隙注入"，与 OQ3/Key Decisions 一致 |
| 5 | LOW | plan.md > Task 5 + Task 7 | **队列消息 dequeue 后 sendMode 关联路径不清**。spec FR4 消息流转第3步："消息从队列移出后，出现在消息流中作为普通用户消息（带 Send Chip）"。但 pi 不感知 sendMode 概念，消息通过 pi 事件流返回时不携带 sendMode。plan Task 7 说"在 addMessage 时将 sendMode 写入消息数据"，但未说明对于 follow-up/steer 消息，如何在 pi 事件流回传时关联正确的 sendMode | 建议在 Task 5 或 Task 7 中明确策略：前端在发送 steer/follow-up 时本地缓存 `{ content → sendMode }` 映射，当 pi 事件流回传用户消息时匹配内容写入 sendMode；或者前端在发送时立即将用户消息（含 sendMode）添加到本地消息列表 |
| 6 | LOW | plan.md > FG4 Subagent 配置 | **FG4 单 subagent 配置涉及 7 文件**。CLAUDE.md subagent 约束为"每个子任务不超过 5 文件"。FG4 将 Task 7（3 文件）和 Task 8（4 文件）合为单次 subagent 调度 | 将 FG4 的 Subagent 配置拆为两行：Task 7 subagent（3 文件）+ Task 8 subagent（4 文件），串联执行 |
| 7 | INFO | spec.md > OQ3 vs plan.md > Task 1 | spec OQ3 标注 steer/follow_up 改造"本 spec 范围外"，但 Key Decisions 又列为"前置依赖"。plan 正确纳入了该改造，这是合理的工程判断（不改造则 Queue Component 无数据）。不影响实施，仅记录 spec 内部措辞矛盾 | — |

> 优先级定义：
> - **MUST FIX**：不修复则评审不通过，会阻塞流程
> - **LOW**：建议修复，但不阻塞
> - **INFO**：观察记录，无需操作

### 结论

**通过。**

Plan 整体质量高：8 个 Task 覆盖全部 12 条 AC，Execution Groups 划分合理，Wave 编排依赖正确，Interface Contracts 签名与 Task 代码片段一致，stopReason 数据流经代码验证已完整。6 条 LOW 问题均为精度/一致性改进，不影响核心实施路径。

### Summary

计划评审完成，第1轮通过，0条MUST FIX，6条LOW建议改进。
