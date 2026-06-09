---
verdict: fail
must_fix: 3
---

# Plan Review v4

**审查日期**: 2026-06-08
**审查模式**: Mode 1 — Plan review（验证 plan 可行性）
**Phase**: Phase 2 — Plan
**前置审查**: v1/v2/v3（均 fail，v1-v3 为交付物缺失审查，本次为内容实质审查）

---

## 总评

Phase 2 五个交付物现已齐全。Plan 整体结构清晰，依赖图合理，Task 粒度适中。但存在 **3 个 MUST_FIX** 问题——均涉及 plan 与代码库现状的偏差，不解决会导致实施时走入死胡同或产出无法工作。

---

## FR 覆盖检查

| Spec FR | Plan Task | 覆盖状态 | 备注 |
|---------|-----------|---------|------|
| FR-1 AgentRunBlock 容器 | T5 + T6 + T7 | ⚠️ 部分 | T7 streaming 集成不具体（见 MUST_FIX-1） |
| FR-2 ContentBlock 分类渲染 | T2 + T4 + T5 | ✅ | |
| FR-2.1 Settings standaloneTools | T1 + T8 | ✅ | |
| FR-3 MergeBlock 折叠渲染 | T3 | ✅ | |
| FR-4 分组规则 | T2 | ✅ | |
| FR-5 Streaming MergeBlock | T3 | ✅ | |
| FR-6 历史消息兼容 | T2 | ✅ | groupByLegacyFields 不变，明确保留 |

**未覆盖风险**: FR-1 的 streaming 路径（见 MUST_FIX-1）

---

## Task 依赖合理性

```
T1 (settings store)          — 无依赖，先做
 ├── T2 (message-layout)     — 依赖 T1 类型定义 ✅
 │    ├── T3 (MergeBlock)    — 依赖 T2 section 类型 ✅
 │    ├── T4 (StandaloneToolCard) — 依赖 T2 section 类型 ✅
 │    └── T5 (AgentRunBlock) — 依赖 T3 + T4 ✅
 │         ├── T6 (AssistantContent) — 依赖 T5 ✅
 │         └── T7 (ChatPanel streaming) — 依赖 T5 ✅
 └── T8 (Settings UI)        — 仅依赖 T1 ✅
```

依赖链清晰，T3/T4 可并行合理。**T6 和 T7 的依赖关系存在问题**（见 MUST_FIX-1）。

---

## MUST_FIX-1: T7 Streaming 架构不具体，与代码库现状冲突

**严重度**: 高 — 不解决会导致实施返工

### 现状

代码库中 streaming 消息的渲染路径是：

```
ChatPanel.vue (line 92)
  ├─ compactStreaming=true  → CompactStreamingBubble（独立组件，ChatPanel 直接渲染）
  └─ compactStreaming=false → StreamingMessage（独立组件，ChatPanel 直接渲染）
```

**关键事实**: streaming 消息**不经过** `AssistantContent.vue`。`AssistantContent` 只处理已完成的 assistant 消息（通过 `MessageBubble → AssistantContent` 路径）。

### Plan 的问题

Plan T7 说：
> compactStreaming=true 时，streaming 消息不再单独渲染 CompactStreamingBubble
> streaming 消息也走 AgentRunBlock（isStreaming=true），由 MessageList 内部处理
> **可能需要调整** MessageList 或 ChatPanel 中 streaming 消息的渲染位置逻辑

"可能需要调整"不是 plan，是待决定。这个架构决策直接影响 T6 和 T7 的实现方式：

**方案 A**: AgentRunBlock 全部放在 `AssistantContent.vue` — 需要把 streaming 消息的渲染路径从 ChatPanel 下沉到 AssistantContent，改动 ChatPanel 的 streaming 渲染逻辑（移除 CompactStreamingBubble 分支，让 streaming 消息走 MessageBubble → AssistantContent 路径）。

**方案 B**: AgentRunBlock 分别放在两处 — complete 走 AssistantContent，streaming 仍留在 ChatPanel（替换 CompactStreamingBubble 为 AgentRunBlock）。但这样 AgentRunBlock 会被实例化两次（不同父组件），props 传入方式不同。

**方案 C**: AgentRunBlock 只放在 AssistantContent，ChatPanel 的 streaming 分支改为直接渲染 `<MessageBubble :message="streamingMessage" :is-streaming="true" />`，让 streaming 和 complete 走同一渲染路径。

Plan 需要明确选择哪个方案并给出具体改动描述（涉及文件、改哪几行、渲染分支如何调整），不能留 "可能需要调整"。

### 建议

推荐**方案 C**：
1. T7 改为：ChatPanel.vue 中移除 `CompactStreamingBubble` 分支，改为在 compact 模式下将 `streamingMessage` 传入现有 `MessageList` 渲染路径（需调整 streaming 消息的 v-for 位置）
2. T6 中 AgentRunBlock 同时处理 streaming 和 complete 两种状态（Plan 已设计了 `isStreaming` prop）
3. 此方案好处：AgentRunBlock 只在一个地方实例化，逻辑集中

---

## MUST_FIX-2: groupIntoSections API 变更未完整描述调用方适配

**严重度**: 中 — 不解决会导致编译错误

### 现状

```typescript
// message-layout.ts (current)
export function groupIntoSections(msg: Message): AssistantSection[]
```

调用方只有 `AssistantContent.vue:136`:
```typescript
const sections = computed<Section[]>(() => groupIntoSections(props.message))
```

### Plan 的问题

Plan T2 说：
> 改为接受第二个参数 `standaloneTools: Set<string>`，由调用方传入。调用方（AssistantContent.vue）从 store 读取并传入。

但 plan T6（AssistantContent 集成）只描述了"移除 CompactSummaryBar 的 import 和使用"和 "AgentRunBlock 替代 compact 渲染"，**没有描述**：
1. `sections` computed 如何改造（传入 standaloneTools）
2. 在 normal section 模式下（`compactStreaming=false`），`groupIntoSections` 是否也需要 standaloneTools 参数？

关键矛盾：如果 `groupIntoSections` 签名改为 `(msg: Message, standaloneTools: Set<string>)`，那 normal 模式下的调用也需要传此参数。但 normal 模式按 spec 不应改变分组行为。需要明确：
- normal 模式下 `standaloneTools` 传空 Set（所有 toolCall 都走旧逻辑）？
- 还是 `groupIntoSections` 只在 AgentRunBlock 内部调用，normal 模式保持旧 `groupByContentBlocks` 不变？

### 建议

在 T2 中明确：
1. `groupIntoSections` 保持现有签名不变（向后兼容）
2. 新增 `groupIntoSectionsV2(msg: Message, standaloneTools: Set<string>): AssistantSectionV2[]` 或在现有函数中让 `standaloneTools` 为可选参数（默认空 Set）
3. AgentRunBlock 内部调用新签名，AssistantContent 的 normal 模式调用旧签名
4. T6 中补充 `sections` computed 的具体改造描述

---

## MUST_FIX-3: E2E 测试计划未精确覆盖 AC-5 的 4 组时序

**严重度**: 中 — AC-5 是分组正确性的核心验收标准

### 现状

Spec AC-5 定义了 4 组精确时序（含符号表）：

| # | AC-5 输入序列 | AC-5 预期分组 |
|---|-------------|-------------|
| 1 | `T tc tc O T tc T tc O` | MergeBlock[thk,tc-read,tc-bash] + TextBlock + MergeBlock[thk,tc-read,thk,tc-grep] |
| 2 | `T O S O`（edit standalone） | MergeBlock[thk] + TextBlock + StandaloneBlock(edit) + TextBlock |
| 3 | `T tc S T tc O customTool O` | MergeBlock[thk,tc-read] + StandaloneBlock(write) + MergeBlock[thk,tc-bash] + TextBlock + CustomToolBlock(subagent) + TextBlock |
| 4 | 用户将 bash 加入 standaloneTools | bash 从 MergeBlock 移出变为 StandaloneBlock |

### E2E Test Plan（E2E-5）的 4 组时序：

| # | E2E-5 输入 | E2E-5 预期 |
|---|-----------|-----------|
| 1 | `[T, tc-read, tc-bash, T, tc-grep]` → 1 MergeBlock | ❌ 无 text block，不是 AC-5 seq 1 |
| 2 | `[T, tc-read, text, T, tc-bash]` → 2 MergeBlock + TextBlock | ❌ 部分 matching AC-5 seq 1 但缺第二个 text block |
| 3 | `[T, tc-read, write, T, tc-bash, edit]` → 2 MergeBlock + 2 StandaloneBlock | ❌ 不是 AC-5 seq 3（缺 text 和 customTool） |
| 4 | `[T, tc-read, subagent]` → MergeBlock + CustomToolBlock | ⚠️ 简化版 |

### test_cases_template.json 的对应：

| # | TC 输入 | AC-5 对应 |
|---|---------|----------|
| TC-12 | [thk, tc-read, tc-bash, thk, tc-grep] → 1 MergeBlock | ❌ 缺 text blocks |
| TC-13 | [thk, tc-read, text, thk, tc-bash] | ⚠️ 部分匹配 seq 1 |
| TC-14 | [thk, tc-read, write, thk, tc-bash, text, subagent, text] | ⚠️ 接近 seq 3 但不含独立 text between standalone |
| TC-15 | bash 加入 standaloneTools | ✅ 匹配 seq 4 |

### 问题

E2E test plan 和 test_cases_template.json 的测试序列**不精确匹配** AC-5 的 4 组时序。这意味着 AC-5 验收时无法直接用 E2E 测试结果判定通过/失败。

### 建议

在 e2e-test-plan.md 的 E2E-5 中，**直接复制** AC-5 的 4 组精确时序作为测试输入，确保测试可追溯地验证 AC-5 的每个断言。当前 E2E-5 的额外测试序列可以保留作为补充覆盖，但不应替代 AC-5 精确序列。

---

## SHOULD_FIX（建议改进，不阻塞）

### SHOULD_FIX-1: SectionType 命名与 spec 不一致

Spec FR-4 定义的 section 类型包含 `write`（表示独立展示的 write toolCall），Plan T2 使用 `standalone`。

Plan 的命名实际上更好（`standalone` 覆盖 write + edit + 任何用户放入 standaloneTools 的工具，`write` 太具体）。但这个偏差应该记录：
- 在 plan 中注明 "FR-4 的 `write` 类型重命名为 `standalone`，原因：write 只是默认 standaloneTools 的一种，类型名应反映通用语义"
- 或在 spec 中做正式修订

### SHOULD_FIX-2: T3 MergeBlock setInterval 清理细节

Non-functional-design 提到 `onUnmounted` 清理 timer，但 plan T3 未提及。建议在 T3 中加一行：`组件卸载时通过 onUnmounted 清理 setInterval 计时器`，确保实施时不遗漏。

### SHOULD_FIX-3: T4 StandaloneToolCard 的修改量 badge 解析

Plan T4 说 "从 toolCall.result 或 args 解析 +N/-N 行数" 但未说明解析策略。edit toolCall 的 result 可能是 diff 文本格式，write toolCall 可能无 diff 信息。建议明确：
- edit: 解析 diff 统计行（+added/-removed）
- write: 显示 "新建文件" 或从 args 内容估算
- 其他 standalone 工具: 不显示修改量 badge

---

## 辅助交付物检查

| 文件 | 存在 | 质量 | 与 spec 一致性 |
|------|------|------|--------------|
| `e2e-test-plan.md` | ✅ | ⚠️ AC-5 覆盖不精确 | 基本一致 |
| `test_cases_template.json` | ✅ | ⚠️ 同上 | 基本一致 |
| `use-cases.md` | ✅ | ✅ 4 个 UC 完整展开 | 一致 |
| `non-functional-design.md` | ✅ | ✅ 覆盖性能/稳定性/安全 | 一致 |

### use-cases.md 覆盖映射验证

| UC | 覆盖 AC | 验证 |
|----|---------|------|
| UC-1 | AC-1, AC-2, AC-3 | ✅ 步骤完整 |
| UC-2 | AC-4, AC-1 | ✅ 含 streaming 时序 |
| UC-3 | AC-2, AC-3 | ✅ 含 customTool 路径 |
| UC-4 | AC-5, AC-8 | ✅ 含设置变更流程 |

---

## 行动建议

1. **MUST_FIX-1**: 明确 T7 的架构方案（推荐方案 C），给出 ChatPanel.vue 的具体改动描述
2. **MUST_FIX-2**: 在 T2 中明确 groupIntoSections 的 API 变更策略和 normal 模式的兼容处理
3. **MUST_FIX-3**: 在 e2e-test-plan.md E2E-5 中补充 AC-5 的 4 组精确时序测试

修复以上 3 点后 plan 可进入 Phase 3 实施。
