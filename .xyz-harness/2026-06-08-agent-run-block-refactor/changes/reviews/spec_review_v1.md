---
verdict: fail
must_fix: 1
---

# Spec Review: AgentRunBlock 重构（独立审查）

**文件**: `spec.md`
**审查日期**: 2026-06-08
**审查模式**: Plan review (验证 spec 完整性)
**说明**: 本审查独立于已有的 v1/v2 review，基于代码交叉验证重新评估

---

## 总评

Spec 的功能设计（MergeBlock 折叠 + standaloneTools 可配置 + 时序分组）合理且完整。FR → AC 追溯链清晰，约束条件大部分与代码一致。

但存在一个架构层面的关键遗漏：spec 描述的渲染分支与实际组件层级不匹配。Streaming compact 消息当前不走 AssistantContent.vue，而 spec 假设 AgentRunBlock 在 AssistantContent 中同时处理 streaming 和 complete 两种状态。此问题在 v1/v2 review 中均未识别，必须修复后才能进入 Plan。

---

## MUST_FIX

### MUST_FIX-1: Streaming compact 消息的渲染路径未纳入 spec（架构遗漏）

**位置**: spec.md FR-1

**问题**:

Spec 写道"AssistantContent.vue 的渲染分支变为"三个分支（compact+complete / compact+streaming / non-compact），暗示 AgentRunBlock 组件放在 AssistantContent.vue 中。

但实际代码中，**streaming compact 消息不走 AssistantContent**：

- **Complete 消息路径**: `ChatPanel.vue` → v-for MessageBubble → `AssistantContent.vue` → CompactSummaryBar
- **Streaming compact 消息路径**: `ChatPanel.vue` → 直接渲染 `<CompactStreamingBubble>`，**不经过** MessageBubble / AssistantContent

```vue
<!-- ChatPanel.vue 第 91-99 行 -->
<CompactStreamingBubble
  v-if="streamingMessage && settingsStore.compactStreaming"
  :message="streamingMessage"
/>
<StreamingMessage
  v-else-if="streamingMessage"
  :message="streamingMessage"
  :is-streaming="isStreaming"
/>
```

CompactStreamingBubble 和 CompactSummaryBar 分别在 **两个不同的组件层级** 中使用。Spec 声明 AgentRunBlock "替代"两者，但没有说明如何统一渲染路径。

**需要补充的内容**（至少选一个方案并在 spec 中明确）：

| 方案 | 描述 | 影响 |
|------|------|------|
| A | 修改 ChatPanel.vue，compact streaming 消息也走 MessageBubble → AssistantContent → AgentRunBlock（去掉 ChatPanel 中的 CompactStreamingBubble 分支） | ChatPanel 和 MessageBubble 都需改动 |
| B | AgentRunBlock 放在 ChatPanel.vue 中（与当前 CompactStreamingBubble 同层级），complete 消息路径不变（仍走 AssistantContent） | AgentRunBlock 拆成两个使用点 |
| C | ChatPanel 统一走 StreamingMessage（去掉 CompactStreamingBubble），由 AssistantContent 内部根据 compactStreaming 分流到 AgentRunBlock | StreamingMessage 本身就是 MessageBubble 的薄包装，可行且改动最小 |

**影响**: 不澄清这个问题，实现时必然遇到"AgentRunBlock 放在哪"的困惑，可能导致两种 streaming 路径行为不一致。

---

## SHOULD_FIX

### SHOULD_FIX-1: Footer "总耗时"在 complete 消息上无法直接计算

**位置**: spec.md FR-1 Footer 字段定义

Spec 定义"总耗时 = message.timestamp 到 status 变为 complete 的间隔"。但 Message 类型（`shared/src/message.ts`）没有记录 status 变为 complete 的时间戳。`timestamp` 是消息创建时间，`status` 只是状态枚举（`streaming | complete | error`），没有附带变更时间。

**建议**: 明确计算方法，例如 `max(all thinking.endTime, all toolCall.endTime) - message.timestamp`，或者在前端记录一个 `completedAt` 时间戳（仅前端 store 层，不改 shared 类型）。

### SHOULD_FIX-2: Streaming 过程丢失"展开查看全部"能力

**位置**: spec.md FR-3

现有 CompactStreamingBubble 支持点击展开，展开后渲染完整的 MessageBubble，用户可以在 streaming 过程中查看所有操作细节。Spec 的 streaming AgentRunBlock 只有"一行紧凑的实时状态"（MergeBlock 28px），无法展开。

**影响**: 对于长时 Agent Run（20+ 步操作），用户在 streaming 期间只能看到一个 28px 滚动条，丢失了现有的展开能力。

**建议**: 在 spec 中明确说明这是有意为之的设计取舍（streaming 时强制折叠），或为 streaming MergeBlock 增加"展开"选项。

### SHOULD_FIX-3: Footer "文件修改数"命名不准确

**位置**: spec.md FR-1 Footer 字段定义

Footer 的"文件修改数"定义为 `toolCalls 中 toolName 在 standaloneTools 集合内的总数`。如果用户将 `bash` 或 `grep` 加入 standaloneTools，bash 调用也会被计入"文件修改数"，语义不准确。

**建议**: 改为更中性的名称如"操作数"或"独立操作数"，或将计数限定为 `write + edit` 固定集合。

---

## 优点

1. **standaloneTools 用户可配置**是亮点。将工具分类从硬编码改为用户设置，既满足默认体验（只看 write/edit），又保留高级用户自定义能力。

2. **AC-5 符号表测试用例**质量高。4 组分组场景覆盖了纯合并、交错、混合自定义工具、配置切换，可直接转为 `groupIntoSections` 的单元测试。

3. **Constraints 与代码一致**。"不改动共享类型"的约束经过验证：ContentBlock/Message 确实不需要改动，分组逻辑完全在前端渲染层。Settings store 的 `compactStreaming` 已存在且有 persist，新增 `standaloneTools` 顺理成章。

4. **向后兼容完整**。FR-6 和 AC-7 覆盖了 legacy 消息路径，`groupByLegacyFields` 不变。

---

## 遗漏检查

| 维度 | 覆盖情况 | 说明 |
|------|---------|------|
| 问题定义 | ✅ | Background 清晰描述了 section 跳跃痛点 |
| 用户场景 | ✅ | UC-1/2/3 覆盖结果查看、过程监控、subagent |
| 功能需求 | ✅ | FR-1~6 完整，FR-2.1 Settings 配置有独立定义 |
| 验收标准 | ✅ | AC-1~8 可追溯到 FR |
| 约束/不变量 | ⚠️ | 7 条约束大部分正确，但"不改动 useChat"的边界需验证：如果采用方案 C 统一路径，ChatPanel.vue 的 streaming 渲染逻辑需要改动 |
| 边界情况 | ⚠️ | 空 AgentRunBlock（只有 MergeBlock 无 text）未显式覆盖 |
| 性能考量 | ⚠️ | 未提及 50+ contentBlocks 的渲染性能 |
| 组件层级 | ❌ | MUST_FIX-1: streaming/complete 分裂路径未纳入 |

---

## 结论

Spec 的功能设计可行，核心架构（MergeBlock + StandaloneToolCard + standaloneTools 设置）合理。**但有 1 条 MUST_FIX**：streaming compact 消息当前在 ChatPanel.vue 中独立渲染（CompactStreamingBubble），不走 AssistantContent.vue，spec 未说明如何将两条路径统一到 AgentRunBlock。此问题直接影响实现架构，必须在 spec 中明确方案后才能进入 Plan。
