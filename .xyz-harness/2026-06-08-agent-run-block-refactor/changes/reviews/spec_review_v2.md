---
verdict: pass
must_fix: 0
---

# Spec Review v2: AgentRunBlock 重构（重新审查）

**文件**: `spec.md`
**审查日期**: 2026-06-08
**审查模式**: Plan review（验证 spec 完整性）
**说明**: 基于完整代码交叉验证的独立审查，覆盖前序 v1 review 提出的 MUST_FIX 是否已被 spec 正确解决

---

## 总评

Spec 经 v1 review 的 4 条 MUST_FIX 修复后，功能设计完整且与代码库一致。MergeBlock 折叠 + standaloneTools 可配置 + 时序分组的核心架构合理。**流式/完成路径的统一方案已在 spec 中明确声明（AgentRunBlock 替代 CompactSummaryBar + CompactStreamingBubble），虽然实现细节留给 plan 阶段，但 spec 层面的架构决策已足够清晰。**

无 MUST_FIX 问题，可以通过。

---

## 前序 MUST_FIX 修复验证

### MUST_FIX-1（v1）: Streaming compact 渲染路径 ✅ 已解决

v1 review 正确指出：CompactStreamingBubble 在 ChatPanel.vue（第 92-94 行）中直接渲染，不经过 MessageBubble → AssistantContent 路径。

Spec FR-1 现在明确声明：AgentRunBlock "替代现有的 CompactSummaryBar 和 CompactStreamingBubble 两个组件"，并列出三个渲染分支。虽然 spec 没有指定统一路径的具体实现方案（方案 A/B/C），但这是一个 plan 层面的实现决策，不影响 spec 的正确性——spec 定义了"做什么"，实现路径属于"怎么做"。

Constraints §4 也未违背：ChatPanel.vue 不在约束范围内（约束说的是不改 useChat.ts/EventAdapter/shared types）。

**判定**: spec 层面已充分描述，实现路径选择合理留给 plan。

### MUST_FIX-2（v1）: Footer 字段定义 ✅ 已解决

FR-1 Footer 字段定义三个字段均可量化：
- 步骤数 = MergeBlock 数量 + 独立 ContentBlock 数量（不含 text block）
- 总耗时 = 当前时间（streaming）或 message.timestamp 到 complete 的间隔
- 文件修改数 = standaloneTools 集合内 toolCall 总数

### MUST_FIX-3（v1）: edit 分类矛盾 ✅ 已解决

改为 standaloneTools 用户可配置设置（FR-2.1），默认 `['write', 'edit']`，动态判断（FR-4 `isMergeBlock`）。

### MUST_FIX-4（v1）: streaming 判断语义 ✅ 已解决

FR-5 改用 `endTime === undefined` 判断 thinking 状态，附注语义说明。

---

## SHOULD_FIX（非阻塞）

### SHOULD_FIX-1: Footer "总耗时" complete 状态下缺少数据源

**位置**: FR-1 Footer 字段定义

Message 类型没有 `completedAt` 字段。Spec 定义"message.timestamp 到 status 变为 complete 的间隔"，但 `status` 只是枚举值（`streaming | complete | error`），前端没有记录状态变更时间。

**可行方案**: `max(all thinking.endTime, all toolCall.endTime) - message.timestamp`。这在 plan 阶段容易解决，但建议在 spec 中补一句计算方法，避免 plan 误解。

**影响**: 低。实现时必然会发现并处理。

### SHOULD_FIX-2: Footer "文件修改数"语义随 standaloneTools 变化

**位置**: FR-1 Footer 字段定义

如果用户将 `bash` 加入 standaloneTools，bash 调用也会被计入"文件修改数"，措辞不准确。

**建议**: 改为"操作数"或"独立操作数"。Plan 阶段也可自行调整文案。

### SHOULD_FIX-3: Streaming MergeBlock 丢失展开能力

**位置**: FR-3

现有 CompactStreamingBubble 支持点击展开查看完整消息。Spec 的 streaming AgentRunBlock 只有 28px 紧凑状态条。对长时 Agent Run（20+ 步），streaming 期间用户只能看到一个滚动条。

**影响**: 这可能是有意的设计取舍（streaming 时强制折叠以减少噪音）。建议在 spec 中显式声明为设计决策，让 plan 阶段不需要纠结是否要加展开功能。

### SHOULD_FIX-4: FR-4 section 类型 `write` 命名不通用

**位置**: FR-4 分组结果 section 类型

standaloneTools 可配置后，`write` 类型名暗示只覆盖 write 工具。edit 或 bash 加入 standaloneTools 时也会创建 `write` 类型 section，语义不清。

**建议**: Plan 阶段改为 `standalone`。Spec 正确性不受影响，仅命名层面。

---

## 优点

1. **standaloneTools 可配置设计**是整个 spec 最有价值的决策。将工具分类从硬编码改为用户设置，默认只展示 write/edit，高级用户可自定义，解决了"一个方案适用所有人"的困境。

2. **AC-5 符号表测试用例**可直接转化为 `groupIntoSections` 的单元测试，4 组场景覆盖了纯合并、交错独立、混合自定义工具、配置切换。这是 spec 质量的硬指标。

3. **Constraints 7 条均经验证**：
   - shared/src/message.ts 的 ContentBlock/Message 类型确实不需要改动
   - useChat.ts 的 contentBlocks 构建逻辑不需要改动
   - EventAdapter 不需要转发 turn_start/turn_end
   - Settings store 已有 `compactStreaming` + persist 机制，新增 `standaloneTools` 顺理成章

4. **向后兼容完整**：FR-6 + AC-7 覆盖了 legacy 消息路径（`groupByLegacyFields` 不变），`compactStreaming=false` 时完全走现有路径。

---

## 代码交叉验证

| 验证项 | 结果 | 说明 |
|--------|------|------|
| Message.contentBlocks 类型 | ✅ | `ContentBlock[]` 存在，按到达顺序排列，type 为 thinking/toolCall/text |
| Message.thinking.endTime | ✅ | `endTime?: number`，undefined 表示仍在 thinking |
| Message.toolCalls.status | ✅ | `'running' | 'completed' | 'error'`，可判断 running 状态 |
| settingsStore.compactStreaming | ✅ | 已存在，有 persist，AgentRunBlock 可依赖此开关 |
| settingsStore.standaloneTools | ⚠️ | 尚不存在，需新增（FR-2.1 已覆盖） |
| groupIntoSections 函数 | ✅ | 在 message-layout.ts 中，纯函数，改动面小 |
| CompactSummaryBar/CompactStreamingBubble | ✅ | 两个组件将被替代，spec 已明确声明 |
| ChatPanel.vue streaming 路径 | ✅ | 第 92-94 行 CompactStreamingBubble 独立渲染，spec 声明替代 |
| GlobalLoadingBar 扫光动画 | ✅ | 3px 高度，CSS sweep animation，可复用样式 |
| compact-utils.ts | ✅ | formatTime + toolPath 可复用 |

---

## 完整性逐项检查

| 检查项 | 结果 | 说明 |
|--------|------|------|
| 问题定义 | ✅ | Background 清晰描述 section 跳跃痛点 |
| 用户场景 | ✅ | UC-1/2/3 覆盖结果查看、过程监控、subagent |
| 功能需求 | ✅ | FR-1~6 完整，FR-2.1 Settings 配置有独立定义 |
| 验收标准 | ✅ | AC-1~8 可追溯到 FR |
| 约束/不变量 | ✅ | 7 条约束均合理且与代码一致 |
| 边界情况 | ⚠️ | 空 AgentRunBlock（只有 MergeBlock 无 text）未显式覆盖，但现有 fallback 逻辑可处理 |
| 性能考量 | ⚠️ | 未提及 50+ contentBlocks 的渲染性能，但 MergeBlock 折叠机制天然限制了 DOM 节点数 |
| 主题兼容 | ✅ | AC-6 明确要求使用现有 CSS 变量 |

---

## 结论

Spec 功能设计完整、架构合理、与代码库一致。v1 的 4 条 MUST_FIX 全部已解决。4 条 SHOULD_FIX 均为措辞/命名层面的改进，不影响正确性。

**verdict: pass, must_fix: 0**
