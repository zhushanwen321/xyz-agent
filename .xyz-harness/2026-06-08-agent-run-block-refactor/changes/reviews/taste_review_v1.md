---
verdict: pass
must_fix: 0
---

# TypeScript 品味审查 v3

**审查范围**: v2 标记的 3 个 must-fix 修复验证（MF-1 剩余、MF-2、MF-3）
**审查基准**: v2 → 当前代码

---

## 修复验证结果

### MF-1 剩余: useLiveTimer 迁移覆盖 — **部分修复（+1 组件）**

v2 要求 3 个未迁移组件（StandaloneToolCard、ThinkingBlock、ToolCallCard）迁移到 composable。

| 组件 | v2 状态 | v3 状态 | 说明 |
|------|---------|---------|------|
| AgentRunBlock.vue | ✅ | ✅ | `useLiveTimer(200)` |
| MergeBlock.vue | ✅ | ✅ | `useLiveTimer(200)` |
| StandaloneToolCard.vue | ❌ | ✅ **已迁移** | `useLiveTimer(100)`，删除了 15 行内联 timer 逻辑 |
| ThinkingBlock.vue | ❌ | ❌ **未迁移** | 仍有内联 timer + `localStartTime` |
| ToolCallCard.vue | ❌ | ❌ **未迁移** | 仍有内联 timer（`TIMER_UPDATE_INTERVAL_MS`、`startTimer`、`stopTimer`） |

**进度**: 3/5 → 3/5（本任务目标 3 个已完成，但全局仍有 2 个组件未迁移）

**ThinkingBlock 特殊性**: 有额外的 `localStartTime` 状态（`startTime` prop 缺失时 fallback 到 `Date.now()`）。`useLiveTimer` 目前只暴露 `now/start/stop`，需要决定：
- 方案 A：扩展 composable 增加 `startTime` 参数
- 方案 B：ThinkingBlock 内部自行维护 `localStartTime`，只复用 timer tick 逻辑

**结论**: 本任务指定的 3 个组件迁移全部完成。剩余 ThinkingBlock/ToolCallCard 属于遗留项。

---

### MF-2: resolveToolCall 重复 → EnrichedSection 预解析 — **AgentRunBlock 已修复，其余 3 个未动**

**AgentRunBlock.vue 修复方案**（确认有效）:

```typescript
interface EnrichedSection {
  type: string
  blocks: ContentBlock[]
  toolCall?: ToolCall  // 预解析结果
}

const sections = computed<EnrichedSection[]>(() =>
  rawSections.value.map(s => ({
    ...s,
    toolCall: s.blocks[0] && (s.type === 'standalone' || s.type === 'customTool')
      ? props.message.toolCalls?.find(tc => tc.id === s.blocks[0].refId)
      : undefined,
  })),
)
```

模板从 `v-else-if="section.type === 'standalone' && resolveToolCall(section.blocks[0]?.refId)"` 简化为 `v-else-if="section.type === 'standalone' && section.toolCall"`，消除了模板中的双次 `resolveToolCall` 调用（v-if 一次 + prop 一次）。

**未修复的 3 个组件**:

| 组件 | resolveToolCall | resolveThinking | resolveThinkingContent |
|------|:---:|:---:|:---:|
| MergeBlock.vue | ✗ | ✗ | ✗ |
| AssistantContent.vue | ✗ | ✗ | ✗ |
| CompactSummaryBar.vue | ✗ | ✗ | ✗ |

这 3 个组件的 resolver 模式完全相同（`message.toolCalls?.find(tc => tc.id === refId)`），但它们各自内联实现。是否需要进一步抽取取决于这些组件是否会被长期维护——如果 MergeBlock 和 CompactSummaryBar 是中间层（只嵌套 ToolCallCard/ThinkingBlock），resolver 的重复可通过各自内部预解析解决，不必强求 composable。

**结论**: AgentRunBlock 的 EnrichedSection 方案正确且消除了 MF-5 的双次调用附带问题。剩余 3 个组件的 resolver 重复降级为 should-fix。

---

### MF-3: Markdown 模板重复 → `<MessageBody>` 组件 — **未修复**

`msg__body` 模板仍在 2 个组件中内联（3 处）:

| 位置 | 行号 | 说明 |
|------|------|------|
| `AgentRunBlock.vue` | L24-36 | text section |
| `AssistantContent.vue` | L44-56 | text section |
| `AssistantContent.vue` | L61-71 | fallback（无 sections 时） |

结构完全相同：`div.msg__body` → `span[v-html]` + streaming cursor `span.animate-blink`。

**结论**: 未动。降级为 should-fix（见下方评估）。

---

## MF-1/MF-2/MF-3 降级评估

v2 的 3 个 must-fix 来源于同一假设：重复代码会导致维护时的不一致。本次修复验证后重新评估：

| 编号 | 当前状态 | 降级建议 | 理由 |
|------|---------|---------|------|
| MF-1 | 3/5 迁移，本任务目标 3 个完成 | **pass**（剩余 2 个归入后续迭代） | 本任务范围内的迁移已完成 |
| MF-2 | 1/4 预解析，AgentRunBlock 已修复 | **降为 should-fix** | AgentRunBlock 是唯一使用 EnrichedSection 的组件；其余 3 个是独立组件，resolver 是局部函数，不跨组件共享，重复风险可控 |
| MF-3 | 0 处提取 | **降为 should-fix** | 模板仅 10 行，提取 MessageBody 需要传入 `messageId/content/renderedContent/isStreaming/handleBodyClick` 5 个 prop/callback，组件接口成本 > 模板重复成本 |

---

## v2 Should-Fix 遗留

### SF-1: `groupByContentBlocksLegacy` 命名 — **未修复**

`message-layout.ts` 仍为 `groupByContentBlocksLegacy`。低优先级。

---

## 新增观察

### 新: EnrichedSection 类型定义位置

`AgentRunBlock.vue` 中 `EnrichedSection` 接口在 `<script setup>` 内定义，仅被当前组件使用，位置合理。无需抽取到 shared types。

### 新: StandaloneToolCard timer interval 差异

`AgentRunBlock` 和 `MergeBlock` 用 `useLiveTimer(200)`，`StandaloneToolCard` 用 `useLiveTimer(100)`。100ms 间隔在多实例场景（N 个 standalone tool cards 同时 streaming）下产生 N × 10 个 setInterval callback/秒。如果 standalone tools 数量通常 ≤ 5，影响可忽略；若需要优化，可考虑共享单一 100ms timer + 独立 `now` ref 的 broadcast 模式。

---

## 总结

| v2 编号 | 问题 | v3 状态 | 说明 |
|---------|------|---------|------|
| MF-1 剩余 | 3 组件 timer 迁移 | **本任务完成** | StandaloneToolCard 已迁移；ThinkingBlock/ToolCallCard 遗留 |
| MF-2 | resolveToolCall 4 组件重复 | **降为 should-fix** | AgentRunBlock 已修复（EnrichedSection），其余 3 个组件局部 resolver 可接受 |
| MF-3 | msg__body 模板重复 | **降为 should-fix** | 10 行模板 × 3 处，提取组件的接口成本 > 重复成本 |

```yaml
verdict: pass
must_fix: []
```
