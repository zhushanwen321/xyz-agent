---
review:
  type: spec_review
  round: 1
  timestamp: "2026-06-08T13:10:00"
  target: ".xyz-harness/2026-06-08-agent-run-block-refactor/spec.md"
  verdict: fail
  summary: "spec 评审第1轮，4条 MUST FIX，需补充关键定义后重审"

statistics:
  total_issues: 7
  must_fix: 4
  low: 2
  info: 1

issues:
  - id: 1
    severity: MUST_FIX
    location: "spec.md:FR-1 + Constraints§6"
    title: "AgentRunBlock 与 compactStreaming/现有组件的关系矛盾"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 2
    severity: MUST_FIX
    location: "spec.md:FR-1 (footer)"
    title: "footer '步骤数'和'文件修改数'定义缺失"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 3
    severity: MUST_FIX
    location: "spec.md:FR-2 + FR-4"
    title: "edit 被归入合并工具与 spec 目标矛盾"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 4
    severity: MUST_FIX
    location: "spec.md:FR-5"
    title: "streaming 状态判断使用 collapsed 字段语义错误"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 5
    severity: LOW
    location: "spec.md:AC-5"
    title: "测试用例符号映射未显式定义"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 6
    severity: LOW
    location: "spec.md:FR-3"
    title: "全部展开/折叠交互细节缺失"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 7
    severity: INFO
    location: "spec.md:FR-4"
    title: "isMergeBlock 中 toolCalls 线性查找可优化为 Map"
    status: open
    raised_in_round: 1
    resolved_in_round: null
---

# Spec 评审 v1

## 评审记录
- 评审时间：2026-06-08 13:10
- 评审类型：计划评审（spec 完整性专项）
- 评审对象：`.xyz-harness/2026-06-08-agent-run-block-refactor/spec.md`

## 现有架构对照

评审前阅读了以下现有文件，用于验证 spec 描述是否与代码实际一致：

| 文件 | 用途 |
|------|------|
| `shared/src/message.ts` | 确认 Message/ContentBlock/ThinkingBlock/ToolCall 类型定义 |
| `lib/message-layout.ts` | 确认当前 section 分组逻辑（`groupIntoSections`/`groupByContentBlocks`/`groupByLegacyFields`） |
| `AssistantContent.vue` | 确认当前渲染架构（compact mode / normal section mode 双路径） |
| `CompactSummaryBar.vue` | 确认 compact 模式已完成消息的渲染方式 |
| `CompactStreamingBubble.vue` | 确认 streaming 状态的 compact 渲染（ChatPanel 中独立使用） |
| `stores/settings.ts` | 确认 `compactStreaming` 默认值（false） |

---

### 发现的问题

| # | 优先级 | 文件/位置 | 描述 | 修改建议 |
|---|--------|----------|------|---------|
| 1 | MUST FIX | spec.md:FR-1 + Constraints§6 | **AgentRunBlock 与 compactStreaming 模式关系矛盾**。FR-1 说"将一条 assistant message 的渲染整体包装为 AgentRunBlock 容器"——无任何条件限定，暗示**所有** assistant 消息都用 AgentRunBlock。但 Constraints§6 说"compactStreaming=true 时启用新渲染，false 时保持原有 section 渲染"——两者矛盾。当前架构有两条独立路径：(1) CompactStreamingBubble（streaming，在 ChatPanel 中）+ CompactSummaryBar（complete，在 AssistantContent 中）；(2) Normal section 模式。spec 未说明 AgentRunBlock 是替代这两条路径，还是只替代其中一条，或是新增第三条路径 | 在 FR-1 开头明确：(a) AgentRunBlock 仅在 compactStreaming=true 时激活；(b) compactStreaming=false 时走现有 groupByContentBlocks 路径不变；(c) 说明与 CompactStreamingBubble/CompactSummaryBar 的替代关系 |
| 2 | MUST FIX | spec.md:FR-1 (footer) | **"步骤数"和"文件修改数"定义缺失**。FR-1 承诺 footer 显示"步骤数、总耗时、文件修改数"。"步骤数"——是 contentBlocks 总数？toolCall 数？section 数？"文件修改数"——只计 write toolCall？还是 write + edit？"总耗时"——起止时间点？第一个 block.startTime 到最后一个 block.endTime？Message.timestamp 到 status=complete？这些数值直接影响 AC-1 的可验证性 | 为每个 footer 字段给出明确定义：(1) 步骤数 = contentBlocks.length 或 toolCalls.length 或其他；(2) 文件修改数 = `{toolCalls 中 toolName 为 X 的数量}`，列出哪些 toolName；(3) 总耗时 = 起止计算公式 |
| 3 | MUST FIX | spec.md:FR-2 + FR-4 | **edit 被归入合并工具与 spec 核心目标矛盾**。spec 开篇说"用户的核心需求：只关心修改了哪些文件"，UC-1 说"用户看到 write 卡片（文件名+修改量）"。但 FR-4 的 `BUILTIN_MERGE_TOOLS` 包含 `edit`——在 pi 的实际工作流中，edit 是**最常用**的文件修改方式（远多于 write），将其折叠意味着大多数文件修改操作对用户不可见。Footer "文件修改数"也无法反映 edit 操作。这是一个设计层面的问题：如果 edit 被折叠，spec 声明的核心目标"只关心修改了哪些文件"将无法实现 | 二选一：(a) 将 edit 从 BUILTIN_MERGE_TOOLS 移出，作为独立渲染的文件修改卡片（与 write 同等待遇）；(b) 保持 edit 合并但在 MergeBlock complete 状态的 chip 条中增加"edit ×N"统计，并在 footer "文件修改数"中计入 edit。选择任何一种都需同步更新 AC-1/AC-3 的验收标准 |
| 4 | MUST FIX | spec.md:FR-5 | **streaming 状态判断使用 collapsed 字段语义错误**。FR-5 说"从 message.thinking 的最后一个 block 的 collapsed 字段判断是否在 thinking"。但 `ThinkingBlock.collapsed` 是 UI 折叠状态（用户是否展开了 thinking 内容），不是"是否正在 thinking"的语义标志。验证：当前 `CompactStreamingBubble.vue` 的 statusText 使用 `!lastThinking.collapsed` 判断——这段代码的含义是"最后一个 thinking block 已展开（未折叠）= 正在 streaming"，这依赖于一个隐含假设：新创建的 thinking block 的 collapsed 默认值为 false。但 collapsed 的语义是 UI 状态，不应作为业务逻辑判断依据 | 使用 `endTime` 判断：最后一个 ThinkingBlock 的 `endTime === undefined` 表示仍在 thinking。如果需要兼容无 endTime 的历史消息，可以回退到 `collapsed` 字段，但主逻辑应基于 endTime |
| 5 | LOW | spec.md:AC-5 | **测试用例符号映射未显式定义**。AC-5 使用 `TCC O TC TC O` 和 `T O W O` 符号，读者需要反推 T=thinking, C=toolCall(单), O=text, W=write。建议在 AC-5 前增加符号表 | 在 AC-5 前加一行映射表：T=thinking, tc=toolCall, O=text, W=write |
| 6 | LOW | spec.md:FR-3 | **"全部展开/折叠"交互细节缺失**。FR-3 提到支持"全部展开/折叠"但未定义：(1) 触发方式——按钮？chip 条点击？快捷键？(2) 位置——footer？chip 条右侧？(3) 当前 CompactSummaryBar 的 toggle-all 是点击 chip 条左侧"过程"标签，新设计是否延续？ | 补充交互方式描述，至少明确触发区域 |
| 7 | INFO | spec.md:FR-4 | **isMergeBlock 中 toolCalls 查找为 O(n) 线性扫描**。FR-4 代码 `msg.toolCalls?.find(t => t.id === block.refId)` 对每个 contentBlock 线性扫描 toolCalls 数组。contentBlocks 数量通常 ≤50，性能影响可忽略，但若后续扩展可考虑预构建 Map | 实现阶段可自行优化，spec 层面无需修改 |

---

### spec 完整性逐项检查

| 检查项 | 结果 | 说明 |
|--------|------|------|
| 目标明确 | ⚠️ | 目标描述清晰（折叠 Agent 操作过程），但 MUST_FIX #3 导致实现可能偏离目标 |
| 范围合理 | ✅ | 约束明确（不改共享类型、不改 WS 协议、不改 useChat），影响面可控 |
| 验收标准可量化 | ❌ | MUST_FIX #2 导致 AC-1 中 footer 字段无法量化验证 |
| [待决议] 项 | ❌ | 未标记 [待决议]，但至少 3 个关键设计决策未确定（见 MUST_FIX #1/#2/#3） |
| 与现有代码一致性 | ⚠️ | MUST_FIX #1 涉及与现有 compactStreaming 双路径的衔接未定义；MUST_FIX #4 依赖了 collapsed 字段的隐含语义 |

### 结论

需修改后重审。4 条 MUST FIX 均为 spec 层面的定义缺失或矛盾，不解决将导致 plan 和编码阶段产生歧义。

### Summary

spec 评审完成，第1轮需重审，4条 MUST FIX（AgentRunBlock 模式关系、footer 字段定义、edit 分类矛盾、streaming 判断语义错误）。
