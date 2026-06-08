---
verdict: pass
must_fix: 0
---

# Plan Review v1: AgentRunBlock 重构

**审查日期**: 2026-06-08
**审查模式**: Mode 1 — Plan 可行性审查
**审查范围**: plan.md, e2e-test-plan.md, test_cases_template.json, use-cases.md, non-functional-design.md
**交叉验证**: spec.md + 源码（AssistantContent.vue, ChatPanel.vue, message-layout.ts, CompactStreamingBubble.vue, MessageBubble.vue, settings.ts, SystemPane.vue）

---

## 总体评价

Plan 质量较高。依赖图清晰、执行顺序合理、API 兼容策略（standaloneTools 可选参数）设计得当。与 spec 的 AC 覆盖完整，8 个 AC 均有对应的 task 和测试用例。以下是逐维度审查结果。

---

## 1. plan.md — 架构可行性

### 1.1 依赖图与执行顺序 ✅

依赖图 DAG 无环。T1 无依赖先做，T3+T4 可并行的判断正确（它们都只依赖 T2 的类型定义）。T6+T7 放在最后也合理——它们是集成层，依赖所有新组件就绪。

### 1.2 T2 API 兼容策略 ✅

`groupIntoSections(msg, standaloneTools?)` 的可选参数策略正确：
- 当前 `groupIntoSections` 只被 `AssistantContent.vue` 一处调用（已验证源码）
- `compactStreaming=false` 时 `standaloneTools` 为 `undefined`，走原有 `groupByContentBlocks`，行为不变
- 这满足 spec Constraint #6（false 时完全走现有路径）

### 1.3 T7 Streaming 路径统一 ✅

Plan 准确描述了当前架构的问题：
- 当前：ChatPanel 中 `CompactStreamingBubble` 在 streaming + compact 模式下独立渲染，**不经过** MessageBubble → AssistantContent
- 目标：移除 `CompactStreamingBubble`，streaming 统一走 `StreamingMessage → MessageBubble → AssistantContent → AgentRunBlock(isStreaming=true)`

源码验证：
- `StreamingMessage.vue` 已确认是 `MessageBubble` 的薄包装（仅 6 行）
- `MessageBubble.vue` 已确认将 `isStreaming` prop 传递给 `AssistantContent`
- 因此 `StreamingMessage → MessageBubble → AssistantContent → AgentRunBlock` 路径通畅

### 1.4 T6 AssistantContent 改动 ✅

Plan 中 `v-if="useCompact"` 同时处理 streaming 和 complete，替换了现有的 `v-if="useCompact && !isStreaming"`。这是正确的：
- 旧代码：compact 模式只处理 complete，streaming 走 CompactStreamingBubble
- 新代码：compact 模式统一由 AgentRunBlock 处理，通过 `isStreaming` prop 区分状态

### 1.5 发现的问题

#### ISSUE-1 [LOW]: T5 footer 文件修改数计算有误

**文件**: plan.md → T5

Plan 写道：
> 文件修改数 = message.toolCalls.filter(tc => standaloneTools.has(tc.toolName)).length

但 `standaloneTools` 是一个 `Set<string>`，而 `AgentRunBlock` 的 props 只有 `message` 和 `isStreaming`。组件内部需要从 settings store 读取 `standaloneTools`，而不是从 props 传入。Plan 没有说明这个数据的获取方式（直接 import settingsStore 还是 props 传递）。

建议：明确在 T5 中写 `const settingsStore = useSettingsStore()` 获取 `standaloneTools`。

**严重度**: Low — 实现时自然会处理，不影响可行性判断。

#### ISSUE-2 [LOW]: T2 SectionType 扩展与 spec FR-4 不完全一致

**文件**: plan.md → T2

Plan 的 SectionType 扩展为 `'merge' | 'text' | 'standalone' | 'customTool'`，但 spec FR-4 的 section 类型是 `'merge' | 'text' | 'write' | 'customTool'`。

两者语义等价（`standalone` = spec 中的 `write`），但命名差异可能导致实现时的困惑。建议统一为 spec 的命名或明确标注映射关系。

**严重度**: Low — 命名差异，实现时可对齐。

#### ISSUE-3 [LOW]: T5 缺少 compactStreaming=false 路径的回归保护描述

**文件**: plan.md → T5

Plan 未描述 compactStreaming=false 时 AgentRunBlock 的行为。根据架构，`AgentRunBlock` 只在 `useCompact=true` 时渲染，所以不会出现 compactStreaming=false + AgentRunBlock 的情况。但 T5 的 Props 定义中缺少这个约束说明。

**严重度**: Low — 架构上天然隔离，但文档完整性可改善。

#### ISSUE-4 [MEDIUM]: T7 删除 CompactStreamingBubble 后的过渡期

**文件**: plan.md → T7

Plan 说"删除 CompactStreamingBubble 的 import 和模板中的 v-if 分支"。但 CompactStreamingBubble.vue 文件本身是否需要删除？如果保留但不再 import，lint 可能报警（unused file）。建议明确是否删除该文件。

此外，CompactSummaryBar.vue 也被 AgentRunBlock 替代（T6），但 plan 只说"移除 import 和使用"，未提及文件删除。两个废弃组件应统一处理策略。

**严重度**: Medium — 不影响功能，但可能导致代码库残留死代码。

---

## 2. e2e-test-plan.md — 测试覆盖度

### 2.1 AC 覆盖 ✅

8 个 E2E 场景完整覆盖 spec AC-1 ~ AC-8，每个 AC 至少一个测试场景。

### 2.2 AC-5 分组场景覆盖 ✅

E2E-5 精确复现了 spec AC-5 的 4 个分组场景（A/B/C/D），时序和预期输出完全匹配。

### 2.3 发现的问题

#### ISSUE-5 [LOW]: E2E-4 缺少 MergeBlock streaming 的多 toolCall 快速切换场景

**文件**: e2e-test-plan.md → E2E-4

当前只测试了 thinking → tool running 的切换，未测试 tool A 完成 → tool B 开始的快速切换（如 read → bash 连续完成）。这是 MergeBlock streaming 的关键场景——操作描述需要从一个 tool 无缝切换到下一个。

建议增加子场景：连续 3 个 toolCall 快速完成时，MergeBlock 的操作描述是否正确更新。

**严重度**: Low — 边界场景，可后续补充。

---

## 3. test_cases_template.json — 测试用例结构

### 3.1 结构完整性 ✅

22 个测试用例，每个包含 id/name/acRef/precondition/steps/expected。与 E2E 测试场景一一对应。

### 3.2 AC-5 分组测试用例 ✅

TC-12 ~ TC-15 完整覆盖 spec AC-5 的 4 个场景，输入序列和预期输出与 spec 一致。

### 3.3 发现的问题

#### ISSUE-6 [LOW]: TC-3 footer 字段缺少可验证的数值

**文件**: test_cases_template.json → TC-3

Expected 写 "显示步骤数（MergeBlock+StandaloneToolCard 数量）、总耗时、文件修改数"，但没有给出具体数值。作为测试用例，应构造一个确定的输入（如 3 个 MergeBlock + 2 个 StandaloneToolCard），预期显示 "5 步 · Xs · 2 文件"。

**严重度**: Low — 测试模板而非最终测试，执行时可填充。

---

## 4. use-cases.md — 业务用例

### 4.1 UC 覆盖 ✅

4 个用例覆盖核心场景。覆盖映射表清晰，AC-6（主题）和 AC-7（兼容）合理地由测试覆盖而非用例。

### 4.2 模块边界标注 ✅

每个 UC 都标注了 Module Boundaries，标明了数据流向。与 plan 的依赖图一致。

### 4.3 发现的问题

无。用例文档简洁、覆盖合理。

---

## 5. non-functional-design.md — 非功能设计

### 5.1 稳定性 ✅

准确识别了 setInterval 泄漏风险点，提出 `onUnmounted` 清理方案。compactStreaming=false 隔离策略与 plan 一致。

### 5.2 性能 ✅

正确分析了分组算法复杂度。50+ contentBlocks 的极端场景评估合理。setInterval 只在 streaming 时存在，最多 1 个 timer 的判断正确。

### 5.3 数据安全 ✅

正确判断不涉及敏感数据处理。

### 5.4 发现的问题

#### ISSUE-7 [LOW]: 性能优化建议缺少实施时机

**文件**: non-functional-design.md → §3

提到"可在实现时预构建 toolCalls 的 Map（refId → ToolCall）优化为 O(1)"。这个优化建议合理但未标注是否属于本次 scope。建议明确标注：T2 实现时直接构建 Map，还是后续优化。

**严重度**: Low — 非功能建议，不影响功能。

---

## 6. 跨交付物一致性

### 6.1 plan ↔ spec 一致性 ✅

- 所有 spec FR（FR-1 ~ FR-6）均有对应 Task
- 所有 spec AC（AC-1 ~ AC-8）均有对应测试
- spec Constraint（不改共享类型/WS 协议/useChat）在 plan 中严格遵守

### 6.2 plan ↔ e2e-test-plan 一致性 ✅

E2E 测试场景与 plan 的 Task 映射清晰：
- T3（MergeBlock）→ E2E-3, E2E-4
- T4（StandaloneToolCard）→ E2E-2
- T5（AgentRunBlock）→ E2E-1
- T2（分组逻辑）→ E2E-5

### 6.3 plan ↔ use-cases 一致性 ✅

UC-4（配置 standaloneTools）对应 T1 + T8。

### 6.4 发现的不一致

#### ISSUE-8 [LOW]: spec FR-4 的 section 类型与 plan T2 命名不一致

已在 ISSUE-2 中描述。spec 用 `'write'`，plan 用 `'standalone'`。建议统一。

---

## 7. 源码交叉验证

| Plan 假设 | 源码验证 | 结果 |
|-----------|---------|------|
| CompactSummaryBar 在 AssistantContent 中使用 | `AssistantContent.vue` L8, L99 | ✅ 确认 |
| CompactStreamingBubble 在 ChatPanel 中使用 | `ChatPanel.vue` L92, L183 | ✅ 确认 |
| StreamingMessage 已走 MessageBubble 路径 | `StreamingMessage.vue` 全文 | ✅ 确认 |
| MessageBubble 传递 isStreaming 给 AssistantContent | `MessageBubble.vue` L16 | ✅ 确认 |
| groupIntoSections 只被 AssistantContent 调用 | grep 结果 | ✅ 确认 |
| compactStreaming 默认 false | `settings.ts` L18 | ✅ 确认 |
| compactStreaming 持久化 | `settings.ts` L59 | ✅ 确认 |
| Settings compactStreaming 在 SystemPane | `SystemPane.vue` L118 | ✅ 确认 |

---

## 审查总结

| 维度 | 评分 | 说明 |
|------|------|------|
| 架构可行性 | 9/10 | 路径通畅，依赖图正确，API 兼容策略合理 |
| Spec 覆盖度 | 10/10 | 所有 FR/AC/Constraint 完整覆盖 |
| 测试覆盖度 | 8/10 | AC-5 分组场景精确，streaming 边界场景可补充 |
| 跨文档一致性 | 8/10 | section 类型命名差异，废弃组件处理策略缺失 |
| 非功能设计 | 8/10 | 关键风险点已识别，性能优化时机可更明确 |

**结论**: Plan 可行，无阻塞性问题。建议实现时关注 ISSUE-4（废弃组件处理策略）和 ISSUE-2（section 类型命名对齐）。
