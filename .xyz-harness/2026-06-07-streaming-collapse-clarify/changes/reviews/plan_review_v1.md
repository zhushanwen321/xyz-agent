---
review:
  type: plan_review
  round: 1
  timestamp: "2026-06-07T21:57:00"
  target: ".xyz-harness/2026-06-07-streaming-collapse-clarify/plan.md"
  verdict: fail
  summary: "计划评审完成，第1轮，1条MUST FIX（FR-5 chip 类型 overflow 未覆盖），需修改后重审"

statistics:
  total_issues: 4
  must_fix: 1
  must_fix_resolved: 0
  low: 2
  info: 1

issues:
  - id: 1
    severity: MUST_FIX
    location: "plan.md → Task 1 / Spec Metrics Traceability"
    title: "FR-5 chip 类型 overflow（>4 种 chip → '+N more'）未被任何 Task 覆盖"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 2
    severity: LOW
    location: "plan.md → File Structure 表 vs Task 2 Step 2"
    title: "File Structure 表声称修改 ChatPanel.vue（3 files），但 Task 2 Step 2 明确说'无需修改 ChatPanel'"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 3
    severity: LOW
    location: "plan.md → Task 1 Step 3 代码片段"
    title: "CompactChipItem 代码片段仍创建 body 字段，但 Interface Contracts 未定义 body，且 Step 2 替换渲染后 body 成为死代码"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 4
    severity: INFO
    location: "plan.md → Task 2 依赖声明"
    title: "Task 2 声明依赖 Task 1，但两者修改不同文件（CompactSummaryBar vs CompactStreamingBubble），无代码依赖"
    status: open
    raised_in_round: 1
    resolved_in_round: null
---

# 计划评审 v1

## 评审记录
- 评审时间：2026-06-07 21:57
- 评审类型：计划评审
- 评审对象：`.xyz-harness/2026-06-07-streaming-collapse-clarify/plan.md`
- 参考文件：spec.md, e2e-test-plan.md, use-cases.md, non-functional-design.md, CLAUDE.md

---

## 逐维度审查结果

### 1. spec 完整性 ✅

- **目标明确**：将 Thinking/ToolCall 合并为摘要标签，一段话可说清。Pass。
- **范围合理**：5 文件修改量，核心逻辑为 chip 聚合 + 两层展开交互，不过大不过小。Pass。
- **验收标准可量化**：AC-1 至 AC-9 均可通过手动或 lint 验证。Pass。
- **[待决议] 项**：Open Questions 为空，Resolved Ambiguities 6 项全部已解决。Pass。
- **Constraints 合理**：`compactStreaming` 开关控制回归、不修改数据类型、不修改 useChat.ts，边界清晰。

**结论**：spec 本身无遗漏。

### 2. plan 可行性 ✅（附条件）

- **任务拆分**：3 个 Task，粒度适中，每个可由单个 subagent 独立完成。Pass。
- **依赖关系**：Task 1 → Task 2 → Task 3 串行。Task 2 对 Task 1 的依赖实际无代码关联（见 issue #4），但不造成风险。Pass。
- **工作量估算**：3 文件 + lint 验证，合理。Pass。
- **遗漏检查**：FR-5 chip 类型 overflow 未覆盖（见 issue #1）。**Fail。**

### 3. spec 与 plan 一致性 ❌

逐条对照 spec 需求与 plan 覆盖情况：

| Spec 需求 | Plan 覆盖 | 状态 |
|-----------|----------|------|
| FR-1 设置开关 | Done（已实现） | ✅ |
| FR-2 Completed 消息折叠 | Task 1 | ✅ |
| FR-3 Streaming 消息折叠 | Task 2 | ✅ |
| FR-4 交互模型（chip/行/bar） | Task 1 + Task 2 | ✅ |
| FR-5 item overflow（>8 条） | Task 1 Step 3 | ✅ |
| FR-5 **chip 类型 overflow（>4 种）** | **无对应 step** | ❌ |
| AC-1 ~ AC-9 | Spec Coverage Matrix 全覆盖 | ✅ |
| Resolved #2 "+N more" overflow 在 v1 | **未实现** | ❌ |

**问题详情**：FR-5 明确要求"操作类型过多时（chip 数量超过 4 种），自动截断展示前 4 个 chip + '+N more' overflow chip"。Resolved Ambiguities #2 也确认"+N more" overflow 在 v1 实现。但 plan 的 Task 1 只实现了 item 级别的 overflow（同类型 >8 条），**chip 类型级别的 overflow（>4 种 chip）没有任何 step 覆盖**。Spec Metrics Traceability 表声称 FR-5 adopted + Task 1，但实际只覆盖了 FR-5 的一半。

### 4. Execution Groups 合理性 ✅

- **分组**：FG1 含 3 Tasks / 3 files（实际 2 modify，见 issue #2），在限制内。Pass。
- **类型划分**：全部前端 Task，无混合。Pass。
- **功能关联度**：SummaryBar + StreamingBubble + Lint 验证，同属 compact streaming 功能。Pass。
- **Wave 编排**：单 Wave，无并行冲突。Pass。
- **Subagent 配置**：Agent/Model/上下文/读取文件/修改文件均列出。Pass。
- **上下文充分性**：注入 spec FR-2/FR-4/FR-5 + 组件 props 接口，subagent 可独立完成。Pass。

### 5. Interface Contracts ⚠️

- **CompactChipItem**：Interface Contract 定义了 refId/path/timeDisplay/expanded，但 Task 1 Step 3 代码仍创建 `body` 字段（见 issue #3）。Step 2 替换渲染后 body 变为死代码。
- **CompactChip**：含 allExpanded 字段，与 Task 1 Step 3 的 `chipAllExpanded` reactive Map 有设计冲突——CompactChip 接口定义了 `allExpanded: boolean`，但实现用的是独立 reactive Map 而非 chip 内部字段。不影响功能，但接口定义与实现不一致。
- **AC 覆盖矩阵**：全部 9 个 AC 有对应行。Pass。

---

### 发现的问题

| # | 优先级 | 文件/位置 | 描述 | 修改建议 |
|---|--------|----------|------|---------|
| 1 | MUST_FIX | plan.md → Task 1 / Spec Metrics Traceability | **FR-5 chip 类型 overflow 未覆盖**。spec FR-5 要求 chip 数量 >4 种时截断为 4 + "+N more" overflow chip。Resolved #2 确认 v1 实现。但 plan Task 1 仅有 item 级别 overflow（>8 条操作行），chip 类型级别 overflow 无任何 step。Spec Metrics Traceability 声称 FR-5 adopted 覆盖 Task 1，实际只覆盖一半 | Task 1 新增 Step（或在现有 Step 中补充）：实现 chip 类型 overflow 逻辑——`chipData()` 返回的 chips 数组 >4 时截断前 4 + 生成 overflow chip，点击 overflow chip 切换 `chipAllExpanded` 显示全部。同步修正 Spec Metrics Traceability 表描述，区分 item overflow 和 chip type overflow |
| 2 | LOW | plan.md → File Structure 表 vs Task 2 Step 2 | File Structure 表列出 ChatPanel.vue 为 modify（共 3 files），但 Task 2 Step 2 明确说"无需修改 ChatPanel"。文件数预估 "3 个文件（0 create + 3 modify）" 与实际不符 | 若确认 ChatPanel 无需修改，File Structure 表和文件数预估改为 2 files（2 modify）。若不确定，保留 ChatPanel 但在 Step 2 中给出需要修改的条件 |
| 3 | LOW | plan.md → Task 1 Step 3 代码片段 | Step 3 代码仍创建 `body` 字段，但 Interface Contract 的 CompactChipItem 未定义 body。Step 2 替换渲染为 ToolCallCard/ThinkingBlock 后 body 不再被消费，成为死代码 | Step 3 的 `allItems` 创建代码中删除 `body` 字段（因为渲染已改为组件方式，不需要预提取文本） |
| 4 | INFO | plan.md → Dependency Graph | Task 2 声明 depends on Task 1，但两者修改完全不同的文件（CompactSummaryBar.vue vs CompactStreamingBubble.vue），无代码依赖 | 可保持串行（降低风险），也可改为并行（缩短耗时）。不阻塞 |

> 优先级定义：
> - **MUST FIX**：不修复则评审不通过，会阻塞流程
> - **LOW**：建议修复，但不阻塞
> - **INFO**：观察记录，无需操作

---

### 结论

需修改后重审。FR-5 chip 类型 overflow 是 spec 明确要求且 Resolved Ambiguities 确认 v1 实现的功能，plan 遗漏了实现步骤，Spec Metrics Traceability 的 adopted 标记有误导性。

### Summary

计划评审完成，第1轮，1条MUST FIX，需修改后重审。
