---
verdict: pass
must_fix: 0
---

# Spec Review: AgentRunBlock 重构

**文件**: `spec.md`
**审查日期**: 2026-06-08
**审查模式**: Plan review (验证 spec 完整性)

---

## 总评

Spec 质量较高。背景问题定义清晰，FR 到 AC 的追溯链完整，约束条件与现有代码一致。核心设计决策（MergeBlock 折叠 + 独立工具卡片 + 用户可配置 standaloneTools）合理且实现可行。

以下分三个维度展开。

---

## 一、优点

1. **问题定义精准**。现有 `CompactSummaryBar` 按工具类型聚合（所有 thinking 一组、所有 read 一组），用户需要在 5-8 个 section 之间跳跃。新方案按时间线交错渲染 MergeBlock 和独立卡片，直接解决了"跳跃式浏览"的痛点。

2. **Constraints 保守得当**。逐条验证了与现有代码的一致性：
   - `shared/src/message.ts` 的 `ContentBlock`/`Message` 类型确实不需要改动——分组逻辑在渲染层完成
   - `AssistantContent.vue` 确实是 compactStreaming 分支的入口点（`useCompact && !isStreaming` → CompactSummaryBar）
   - `ChatPanel.vue` 确实有 `CompactStreamingBubble` 用于 streaming 状态
   - `settings.ts` 的 `compactStreaming` 确实已存在并持久化
   - `GlobalLoadingBar` 确实存在可复用

3. **AC-5 的符号表测试用例**覆盖了时序分组的核心场景（纯合并、交错、混合自定义工具、用户配置切换），可直接转为单元测试。

4. **向后兼容处理明确**。FR-6 和 AC-7 覆盖了 legacy 消息路径，`groupByLegacyFields` 不变。

---

## 二、问题与建议

### SHOULD_FIX-1: Footer "文件修改数" 计算逻辑与 FR-2 定义不一致

**FR-1 Footer** 定义"文件修改数 = toolCalls 中 toolName 在 `standaloneTools` 集合内的总数"。

但 **FR-2** 定义 standaloneTools 中的工具是"独立渲染为文件修改/操作卡片"，而"文件修改"只是其中 write/edit 的语义。如果用户将 `bash` 或 `grep` 加入 standaloneTools，footer 的"文件修改数"会把 bash 调用也计入，语义上不准确。

**建议**：将 footer 字段改为更中性的名称如"操作数"（与 FR-1 的"步骤数"区分），或者将"文件修改数"限定为 `write + edit` 固定集合，不受 standaloneTools 影响。

### SHOULD_FIX-2: FR-5 的 streaming 状态判断依赖 `endTime` 字段，但需确认字段来源

Spec 写"从 `message.thinking` 的最后一个 block 判断是否在 thinking：`endTime === undefined`"。

查看 `ThinkingBlock` 类型定义（`shared/src/message.ts`），`endTime` 是可选字段。但实际 `CompactStreamingBubble.vue` 用的是 `collapsed` 字段（`lastThinking && !lastThinking.collapsed`）来判断 thinking 是否活跃。两种判断方式不等价：
- `endTime === undefined`：thinking block 已创建但未完成
- `collapsed === false`：thinking 内容未被折叠

**建议**：明确 FR-5 使用哪个字段判断 streaming thinking 状态，并在 spec 中注明选择理由。当前代码用的是 `collapsed`，如果改用 `endTime` 需要验证 sidecar 是否正确设置该字段。

### SHOULD_FIX-3: CompactStreamingBubble 的交互行为与 AgentRunBlock streaming 不一致

现有 `CompactStreamingBubble` 展开时渲染完整的 `MessageBubble`（含所有 section），用户可以边 streaming 边看完整内容。新方案的 streaming AgentRunBlock 只显示"一行紧凑的实时状态"（MergeBlock 高度 28px），要看到 write 卡片需要等它们逐个到达。

**影响**：如果 Agent 执行了 20 个操作但还没产生任何 write，用户在 streaming 过程中只看到一个 28px 的 MergeBlock 滚动条，丢失了当前 `CompactStreamingBubble` 提供的"展开查看全部"能力。

**建议**：在 MergeBlock streaming 状态增加"展开"选项（类似现有 CompactStreamingBubble 的 expanded toggle），展开后显示已到达的所有操作细节。或者在 spec 中明确说明这是有意为之的设计取舍（streaming 时强制折叠，减少视觉噪声）。

### SHOULD_FIX-4: FR-4 代码示例使用 `any` 类型，违反项目编码规范

```typescript
ALL_PI_TOOLS.includes(tc.toolName as any) && !standaloneTools.has(tc.toolName)
```

项目 CLAUDE.md 明确禁止 `any`。应改为类型安全的实现，例如：

```typescript
const ALL_PI_TOOLS: readonly string[] = ['read', 'bash', 'edit', 'write', 'grep', 'find', 'ls']
// 或用 includes 的泛型重载
```

### SHOULD_FIX-5: standaloneTools Settings 缺少动态性考虑

FR-2.1 列出了 7 种 pi 内置工具的静态 checkbox 列表。但 pi 的扩展系统允许注册自定义工具（spec 的 FR-2 也提到了 subagent 等自定义工具"始终独立渲染"）。

**问题**：如果用户安装了新的 pi extension 注册了新工具 `my-tool`，这个工具在 Settings 中不可见（只有 7 种内置工具），也不在 `ALL_PI_TOOLS` 中。根据 FR-2 的逻辑，它会被判断为"自定义工具"而始终独立渲染。这可能是期望行为，但 spec 没有明确说明。

**建议**：在 FR-2 或 FR-2.1 中增加一段说明："ALL_PI_TOOLS 之外的 toolName 一律视为自定义工具，始终独立渲染，不出现在 Settings checkbox 列表中"。

### INFO-1: 新增 CSS 变量需求

Spec 的 AC-6 和 Constraints 都声明"不新增 CSS 变量"。但 MergeBlock 的 streaming 动画（扫光、脉冲圆点）和 chip 条的着色可能需要额外的 CSS 变量。当前 CompactSummaryBar 已经在 `<style scoped>` 中硬编码了 `color-mix` 表达式，新组件可以沿用同样的模式（不新增变量、直接 color-mix 现有变量），这是可行的。只需确认 plan 阶段遵循这个约束。

---

## 三、遗漏检查清单

| 维度 | 覆盖情况 |
|------|---------|
| 问题定义 | ✅ 有 Background，痛点清晰 |
| 用户场景 | ✅ UC-1/2/3 覆盖查看结果、监控过程、subagent |
| 功能需求 | ✅ FR-1~6 完整 |
| 验收标准 | ✅ AC-1~8 可追溯到 FR |
| 约束/不变量 | ✅ 7 条约束，已与代码交叉验证 |
| 边界情况 | ⚠️ 空 AgentRunBlock（只有 MergeBlock 无 text）未显式覆盖 |
| 性能考量 | ⚠️ 未提及。大量 contentBlocks（50+）时的渲染性能？建议 plan 阶段考虑虚拟化 |
| 无障碍 | ⚠️ 未提及 keyboard navigation（chip 条的展开/折叠）|
| 国际化 | ✅ 中文 UI 文案已内嵌 |

---

## 结论

Spec 设计合理，可进入 Phase 2 (Plan)。6 个 SHOULD_FIX 建议在 plan 阶段处理，不阻塞。核心架构（MergeBlock 折叠 + StandaloneToolCard 独立 + settings 驱动分组）在现有代码基础上可行，不需要改共享类型、WS 协议或 useChat。
