---
verdict: pass
must_fix: 0
---

# Plan Review: AgentRunBlock 重构

## 审查范围

| 文件 | 类型 |
|------|------|
| plan.md | 实施计划 |
| e2e-test-plan.md | E2E 测试计划 |
| test_cases_template.json | 测试用例模板 |
| use-cases.md | 业务用例 |
| non-functional-design.md | 非功能设计 |

交叉参考：spec.md、现有代码（message-layout.ts、AssistantContent.vue、ChatPanel.vue、shared/message.ts）

---

## 1. Plan 与 Spec 的一致性

### AC 覆盖矩阵

| AC | plan.md 覆盖 | e2e-test-plan 覆盖 | test_cases 覆盖 | 判定 |
|----|-------------|-------------------|----------------|------|
| AC-1 容器渲染 | T5 (AgentRunBlock) 完整定义 | E2E-1 | TC-1~3 | OK |
| AC-2 独立渲染 | T4 (StandaloneToolCard) | E2E-2 | TC-4~7 | OK |
| AC-3 MergeBlock 折叠 | T3 (MergeBlock) complete 状态 | E2E-3 | TC-8~9 | OK |
| AC-4 MergeBlock streaming | T3 streaming 状态 | E2E-4 | TC-10~11 | OK |
| AC-5 分组正确性 | T2 (message-layout) 含 4 组时序 | E2E-5 | TC-12~15 | 见 Issue #1 |
| AC-6 主题兼容 | plan 未详述 | E2E-6 | TC-16~17 | OK（约束 6 覆盖） |
| AC-7 旧消息兼容 | T2 保留 groupByLegacyFields | E2E-7 | TC-18~19 | OK |
| AC-8 Settings 配置 | T1 + T8 | E2E-8 | TC-20~22 | OK |

### Spec 约束遵守情况

| 约束 | 遵守情况 |
|------|---------|
| 不改共享类型 | OK — plan 无 shared/ 改动 |
| 不改 EventAdapter | OK |
| 不改 useChat.ts | OK — plan 未提及 |
| 复用 ThinkingBlock/ToolCallCard | OK — T3 明确复用 |
| 不新增 CSS 变量 | OK — T3/T4/T5 全用 Tailwind + CSS 变量 |
| compactStreaming 开关隔离 | OK — T6 用 v-if 分支 |

---

## 2. 依赖图与执行顺序

plan.md 的依赖图与 Task 描述一致，无循环依赖。执行顺序合理：T1 → T2 → T3+T4 → T5 → T6+T7 → T8。

T8 与 T2~T7 仅依赖 T1，标注为可并行，合理。

---

## 3. 技术可行性分析

### 3.1 message-layout.ts 改造（T2）

**可行性：高**。现有代码已是纯函数结构，plan 提出的改造路径清晰：

- 新增 `standaloneTools: Set<string>` 参数由调用方传入，保持纯函数特性
- `SectionType` 扩展为 `'merge' | 'text' | 'standalone' | 'customTool'` 语义明确
- spec FR-4 的 `isMergeBlock` 伪代码直接可落地

**一处细节需注意**：plan T2 说 `groupByLegacyFields` 不变，这是正确的——legacy 消息无 contentBlocks，不会进入新分组路径。

### 3.2 MergeBlock 组件（T3）

**可行性：高**。streaming 状态的操作描述逻辑（thinking → tool running → text delta）清晰，`setInterval(1000)` 用 `onUnmounted` 清理是标准 Vue 模式。

**注意点**：plan 说"不用 `<style scoped>`"，但 chip 的颜色条件渲染可能需要 `:style` 动态绑定而非 Tailwind 类。这不算 blocking，实现时可灵活处理。

### 3.3 AgentRunBlock 容器（T5）

**可行性：高**。三层结构（status bar → body → footer）简单直接。

### 3.4 AssistantContent 集成（T6）

**可行性：高**。现有代码已有 `useCompact` 分支逻辑，替换 CompactSummaryBar 为 AgentRunBlock 是 1:1 替换。spec FR-1 明确定义了三种渲染分支（compact+complete、compact+streaming、normal），与 T6 描述吻合。

### 3.5 ChatPanel streaming 集成（T7）

**可行性：中**。这是整个 plan 中最需要关注的 Task。

**现状分析**：ChatPanel 中 streaming 消息的渲染分两处：
1. `CompactStreamingBubble`（compactStreaming=true 时，位于 ChatPanel.vue L92-94）
2. `StreamingMessage`（compactStreaming=false 时，位于 L96-99）

而 `AssistantContent`（被 `MessageBubble` 内部使用）目前只处理 complete 消息的 compact 模式（`useCompact && !isStreaming`）。

plan T7 说"streaming 消息也走 AgentRunBlock（isStreaming=true），由 MessageList 内部处理"，但 T6 只改了 AssistantContent，没有说明如何消除 ChatPanel 中的 `CompactStreamingBubble` 分支。两条路径（ChatPanel 的 streaming 分支 vs AssistantContent 的 AgentRunBlock）需要明确谁来负责 streaming 消息的渲染。

**这不是 MUST_FIX**——实现时自然会面对这个问题并解决——但 plan 的描述不够精确，可能导致开发者困惑。建议在 T7 中明确：
- 删除 ChatPanel 中 `CompactStreamingBubble` 分支
- 统一由 AssistantContent 内的 AgentRunBlock 处理 streaming 消息

### 3.6 Footer 耗时计算

plan T5 说"complete 时用 message.timestamp 差值"计算耗时，但 Message 类型没有"complete timestamp"字段。spec FR-1 原文说"message.timestamp 到 status 变为 complete 的间隔"，但 `message.timestamp` 是消息创建时间，不是 complete 时间。

需要用 `toolCalls` 最后一个 endTime 或 thinking 最后一个 endTime 来计算。这不是 blocking 问题，实现时自然会修正，但 plan 描述与实际数据模型有出入。

---

## 4. E2E Test Plan 评估

### 优点
- 8 个场景覆盖 AC-1 ~ AC-8，一一对应
- E2E-5（分组正确性）直接验证 spec AC-5 的 4 组时序
- 前置条件明确（compactStreaming=true, standaloneTools 默认值）

### 不足

**Issue #1: E2E-5 第 4 组时序与 spec AC-5 不完全匹配**

spec AC-5 的第三组混合场景：`T tc S T tc O customTool O`
- 预期：MergeBlock + StandaloneBlock + MergeBlock + TextBlock + CustomToolBlock + TextBlock

E2E-5 第 4 组写的是：`[T, tc-read, subagent]` → MergeBlock + CustomToolBlock。这是 spec 第三组的简化版本，不是完整验证。

但 TC-14 在 test_cases_template 中给出了完整序列 `[thk, tc-read, write, thk, tc-bash, text, subagent, text]`，补上了 E2E-5 的简化。两者互补，**总体覆盖完整**。

---

## 5. Test Cases Template 评估

22 个测试用例，覆盖全部 8 个 AC。每个 TC 有明确的 id、name、acRef、precondition、steps、expected。

**优点**：
- TC-12~15 覆盖了 AC-5 的多种分组变体
- TC-15 验证 standaloneTools 变更的动态影响
- TC-19 验证 compactStreaming=false 的隔离性

**不足**：
- 缺少"空消息"（无 contentBlocks 且无 legacy 字段）的测试用例
- 缺少"只有一个 text block"（无 thinking/toolCall）的边界测试

这些是 SHOULD_FIX 级别，不阻塞。

---

## 6. Use Cases 评估

4 个业务用例，覆盖了主要用户场景。覆盖映射表清晰。

**UC-2 的替代路径"多个 toolCall 并发 → 显示最新的 running toolCall"**：这与 spec FR-5 一致（取 `status === 'running'` 的 toolCall），合理。

---

## 7. Non-Functional Design 评估

5 个维度分析（稳定性、数据一致性、性能、业务安全、数据安全），结论准确：

- **稳定性**：正确识别了 setInterval 泄漏风险，`onUnmounted` 清理方案标准
- **数据一致性**：分组逻辑为纯函数，无副作用——与现有代码结构一致
- **性能**：分析合理，50+ blocks 的极端场景无压力。预构建 toolCalls Map 的优化建议合理
- **业务安全/数据安全**：N/A，判断正确

---

## 8. 发现的问题汇总

### SHOULD_FIX（建议修复，不阻塞）

| # | 文件 | 问题 | 建议 |
|---|------|------|------|
| S1 | plan.md T7 | streaming 消息渲染路径描述不精确：未明确删除 ChatPanel 的 CompactStreamingBubble 分支 | T7 增加明确步骤：删除 ChatPanel 中 CompactStreamingBubble import 和渲染分支 |
| S2 | plan.md T5 | Footer 耗时说"用 message.timestamp 差值"，但 Message 类型无 complete timestamp | 改为"用最后一个 toolCall/thinking 的 endTime 减去第一个 block 的 startTime" |
| S3 | test_cases_template.json | 缺少空消息和纯 text 消息的边界测试 | 建议新增 TC-23（空 assistant 消息）和 TC-24（仅 text 无 toolCall） |
| S4 | plan.md T3 | chip 颜色用 `--accent-light`/`--success-light` 等 CSS 变量，但项目现有 CSS 变量中这些可能不存在（需验证） | 实现时确认 CSS 变量名，如不存在用 Tailwind 语义类替代 |

### OBSERVATION（观察，非问题）

| # | 描述 |
|---|------|
| O1 | plan T8 的 Settings 文件路径写"需确认具体文件路径"，实现时需定位实际 Settings 组件 |
| O2 | plan 未提及是否需要删除 CompactSummaryBar.vue 和 CompactStreamingBubble.vue。它们在 T6/T7 后变为 dead code |
| O3 | spec FR-4 定义了 4 种 section type（merge/text/write/customTool），plan T2 定义为 merge/text/standalone/customTool。"write" vs "standalone" 命名差异——plan 的命名更通用（涵盖所有 standaloneTools），更合理 |

---

## 9. 总结

plan.md 与 spec.md 高度一致，8 个 AC 全部有对应的 Task 和测试覆盖。依赖图正确，执行顺序合理。核心技术路径（纯函数分组 + Vue 组件渲染）与现有代码架构兼容。

4 个 SHOULD_FIX 均为描述精度问题，不影响实施可行性。T7（ChatPanel streaming 集成）是最需要开发者注意的 Task，因为涉及两个组件的渲染路径合并。

**verdict: pass**
**must_fix: 0**
