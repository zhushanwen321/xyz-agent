---
verdict: pass
must_fix: 0
review_metrics:
  files_reviewed: 9
  lines_reviewed: ~750
  dimensions_checked: 5
  must_fix_count: 0
  suggest_fix_count: 2
---

# Integration Review v1-1 — AgentRunBlock 重构（fix 后复查）

**Reviewer**: Integration Review Agent
**Date**: 2026-06-08
**基线**: v1 评审 + 4 个 fix commit 后的最终代码状态
**Files reviewed**: message-layout.ts, AgentRunBlock.vue, MergeBlock.vue, StandaloneToolCard.vue, AssistantContent.vue, ChatPanel.vue, settings.ts, useLiveTimer.ts, AssistantSection.vue, compact-utils.ts

---

## 1. Fix 后状态验证

v1 评审后应用了以下 fix：

| Commit | 内容 | 状态 |
|--------|------|------|
| `627e4bcc` | BLR must-fix: elapsedMs 分离 startTimes/endTimes，hasText 去重 | ✅ 已合并 |
| `7f554eea` | taste: 提取 useLiveTimer，null guard，重命名 fileEditCount→standaloneToolCount | ✅ 已合并 |
| `9d6fdb4d` | robustness: timer 生命周期（watch immediate），spread overflow → reduce | ✅ 已合并 |
| `4f6bc381` | taste v2: StandaloneToolCard 迁移到 useLiveTimer，预解析 toolCalls 到 EnrichedSection | ✅ 已合并 |

**v1 SF#1 已修复**：StandaloneToolCard 已从内联 timer 迁移到 `useLiveTimer(100)`，三个组件（AgentRunBlock、MergeBlock、StandaloneToolCard）timer 管理统一。

---

## 2. 数据流方向（复查）

### 完整链路（最终状态）

```
Settings Store (Pinia)
  ├─ compactStreaming → AssistantContent.useCompact
  └─ standaloneTools → AgentRunBlock.standaloneToolsSet
                          ↓
                    groupIntoSections(msg, standaloneToolsSet)
                          ↓
                    rawSections → EnrichedSection[] (预解析 toolCall)
                          ↓
              ┌───────────┼───────────┐
          MergeBlock   text div   StandaloneToolCard
```

```
ChatPanel → StreamingMessage → MessageBubble → AssistantContent
  → [compact] AgentRunBlock → MergeBlock / StandaloneToolCard
  → [normal]  AssistantSection → ThinkingBlock / ToolCallCard
```

### 评估

- **Settings → Layout**: `standaloneTools` 通过 `computed(() => new Set(settingsStore.standaloneTools))` 派生，响应式正确
- **Layout → AgentRunBlock**: `rawSections` → `sections` 通过 computed 派生，toolCall 预解析在 AgentRunBlock 层完成，子组件不再需要自行 resolve
- **AgentRunBlock → 子组件**: 数据通过 props 单向传递，子组件无反向依赖

**结论**: 数据流严格单向，v1 评估结论在 fix 后仍然成立。

---

## 3. Props 类型匹配（复查）

| 传递路径 | 发送类型 | 接收类型 | v1 | v1-1 |
|---------|---------|---------|-----|------|
| ChatPanel → StreamingMessage `:is-streaming` | `boolean` | `boolean` | ✅ | ✅ |
| StreamingMessage → MessageBubble `:is-streaming` | `boolean` | `boolean?` | ✅ | ✅ |
| MessageBubble → AssistantContent `:is-streaming` | `boolean?` | `boolean?` | ✅ | ✅ |
| AssistantContent → AgentRunBlock `:is-streaming` | `!!isStreaming` | `boolean` | ✅ | ✅ |
| AgentRunBlock → MergeBlock `:blocks/message/is-streaming` | `ContentBlock[]/Message/boolean` | 对应类型 | ✅ | ✅ |
| AgentRunBlock → StandaloneToolCard `:tool-call` | `ToolCall`（EnrichedSection 预解析） | `ToolCall` | ✅ | ✅ |
| MergeBlock → ThinkingBlock `:text/start-time/end-time` | `string/number\|undefined` | 对应类型 | ✅ | ✅ |
| MergeBlock → ToolCallCard `:tool-call` | `ToolCall` | `ToolCall` | ✅ | ✅ |

**Fix 后变化**：
- AgentRunBlock 的 `sections` 从原始 `AssistantSection[]` 变为 `EnrichedSection[]`，`toolCall` 字段在 computed 中预解析。StandaloneToolCard 的 `:tool-call` 绑定从 `resolveToolCall(section.blocks[0].refId)!` 改为 `section.toolCall`，加了 `v-if` guard（`section.toolCall` 存在时才渲染）
- StandaloneToolCard 移除了 `isCustomTool` prop（不再需要，custom/standalone 在 AgentRunBlock 层已区分）

**结论**: 所有 props 类型匹配。fix 后的 EnrichedSection 预解析消除了 v1 中 `resolveToolCall` + non-null assertion 的模式，更安全。

---

## 4. compactStreaming=false 路径隔离（复查）

### 路径分析

`AssistantContent.vue` 中：
```vue
<AgentRunBlock v-if="useCompact" ... />
<template v-else-if="sections.length">
  <AssistantSection ... />
</template>
```

compact=false 时：
- `useCompact` = false → AgentRunBlock 不渲染
- 进入 normal sections 分支 → `sections = groupIntoSections(msg)` — 无 standaloneTools 参数
- 调用 `groupByContentBlocksLegacy(msg)` — 相邻同类型合并，行为与重构前完全一致

ChatPanel 中：
```vue
<StreamingMessage v-if="streamingMessage" ... />
```
已移除 `CompactStreamingBubble` 分支。streaming 消息统一走 `StreamingMessage → MessageBubble → AssistantContent` 路径。compact=true 时 AssistantContent 渲染 AgentRunBlock（isStreaming=true），compact=false 时走 normal sections。

**验证**: ChatPanel 不再依赖 `settingsStore.compactStreaming`（已移除 import），streaming 渲染路径完全由 AssistantContent 内部分支控制。

**结论**: 两条路径完全隔离，v1 评估结论在 fix 后仍然成立。

---

## 5. Settings 变更即时反映（复查）

### standaloneTools 变更链

```
settingsStore.standaloneTools (ref<string[]>)
  → AgentRunBlock.standaloneToolsSet (computed → new Set)
    → AgentRunBlock.sections (computed → groupIntoSections with Set)
      → MergeBlock/StandaloneToolCard 重渲染
```

fix 后增加了一层 EnrichedSection 预解析（toolCall resolve），但 computed 依赖链正确：`standaloneTools` 变化 → `standaloneToolsSet` 重算 → `rawSections` 重算 → `sections` 重算。

### compactStreaming 变更

`useCompact` 是 `computed(() => settingsStore.compactStreaming)`，v-if 切换时 AgentRunBlock/normal sections 完整销毁/创建，无残留状态。

**结论**: Settings 变更即时生效，v1 评估结论不变。

---

## 6. Fix 质量评估

### 6.1 timer 统一（useLiveTimer）

三个组件现在统一使用 `useLiveTimer`：

| 组件 | interval | 启动条件 | stop 时机 |
|------|----------|---------|----------|
| AgentRunBlock | 200ms | isStreaming=true | isStreaming=false 或 unmount |
| MergeBlock | 200ms | isStreaming=true | isStreaming=false 或 unmount |
| StandaloneToolCard | 100ms | toolCall.status='running' | status 非 running 或 unmount |

`useLiveTimer` 内部 `onBeforeUnmount(stop)` 确保 unmount 时清理。watch `immediate: true` 确保初始状态即同步。

**评估**: 正确。interval 差异（100 vs 200ms）合理 — StandaloneToolCard 单工具卡需要更高刷新率显示 running 状态。

### 6.2 elapsedMs 时间戳分离

fix 将 `times` 数组分离为 `startTimes` 和 `endTimes`，complete 时用 `max(endTimes) - min(startTimes)` 而非之前的 `max(all) - min(all)`。

**评估**: 正确。之前所有时间戳混在一起，如果 thinking 的 endTime > toolCall 的 startTime（交叉执行），计算会出错。分离后语义明确。

### 6.3 EnrichedSection 预解析

fix 在 AgentRunBlock 层预解析 toolCall（`sections` computed），子组件直接使用 `section.toolCall`，无需自行 resolve。

**评估**: 正确。减少了子组件与 message.toolCalls 的直接耦合，StandaloneToolCard 不再需要 message prop。

### 6.4 hasText 去重

`groupByContentBlocks` 增加 `hasText` 标志，跳过第二个 text block。

**评估**: 正确。message.content 在 text section 中已渲染一次，contentBlocks 中可能有多个 text block（thinking/toolCall 交替），重复渲染会导致双倍文本。

---

## 7. 新发现的问题

### MUST-FIX: 0

无阻塞性问题。

### SUGGEST-FIX: 2

**SF#1: MergeBlock streaming elapsed 显示 message.timestamp 差值，非活动块差值**

- **文件**: `MergeBlock.vue` L147-152
- **现状**:
  ```ts
  const streamElapsed = computed(() => {
    const ts = props.message.timestamp
    if (!ts) return ''
    const ms = Math.max(0, now.value - ts)
    ...
  })
  ```
  MergeBlock 的 streaming 耗时基于 `message.timestamp`（消息创建时间），不是该 MergeBlock 内第一个 block 的 startTime
- **风险**: 低。streaming 中 MergeBlock 只有一个（最新的合并块），显示从消息创建到当前的总耗时，语义上可接受。但如果未来支持多个 MergeBlock 同时 streaming（理论上不会发生），每个 MergeBlock 会显示相同的总耗时
- **建议**: 当前实现可接受。如果需要精确到 MergeBlock 级别的耗时，可用 `blocks[0].startTime` 替代 `message.timestamp`，但增加复杂度且收益小
- **阻塞级别**: 不阻塞

**SF#2: StandaloneToolCard `resolvedPath` 截断到 50 字符，与 compact-utils `PATH_MAX_LEN=40` 不一致**

- **文件**: `StandaloneToolCard.vue` L55-58 vs `compact-utils.ts` L30
- **现状**: StandaloneToolCard 用 `maxLen=50`（默认值），compact-utils 中 `toolPath` 默认 `maxLen=40`
- **风险**: 无功能影响。两处截断独立，StandaloneToolCard 的 50 字符是 UI 层二次截断
- **建议**: 统一为同一常量或同一 maxLen，减少维护负担
- **阻塞级别**: 不阻塞

---

## 最终评估

| 检查维度 | 结果 | 说明 |
|---------|------|------|
| 数据流方向 | ✅ PASS | 严格单向，EnrichedSection 预解析消除了子组件反向 resolve |
| Props 类型匹配 | ✅ PASS | 所有 props 类型正确，EnrichedSection + v-if guard 更安全 |
| 组件间通信 | ✅ PASS | Props 为主，store 直接访问仅限全局配置 |
| compact=false 隔离 | ✅ PASS | 两条路径完全隔离，ChatPanel 移除了 CompactStreamingBubble 依赖 |
| Settings 即时反映 | ✅ PASS | computed 依赖链正确，变更即时触发重渲染 |

**Fix 质量**: 4 个 fix commit 质量高，解决了 timer 重复、时间戳语义错误、组件耦合等问题，未引入新问题。

**Verdict: pass**
