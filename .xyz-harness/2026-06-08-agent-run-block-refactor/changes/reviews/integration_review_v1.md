---
verdict: pass
must_fix: 0
review_metrics:
  files_reviewed: 8
  lines_reviewed: ~880
  dimensions_checked: 5
  must_fix_count: 0
  suggest_fix_count: 1
---

# Integration Review v1 — AgentRunBlock 重构

**Reviewer**: Integration Review Agent
**Date**: 2026-06-08
**BLR v2 verdict**: pass（3/3 MUST_FIX 已修复，0 新增）
**Files reviewed**: message-layout.ts, AgentRunBlock.vue, MergeBlock.vue, StandaloneToolCard.vue, AssistantContent.vue, ChatPanel.vue, settings.ts, useLiveTimer.ts

---

## 1. 数据流方向

### 完整链路

```
Settings Store (Pinia)
  ↓ computed
AssistantContent.vue  ← useCompact = settingsStore.compactStreaming
  ├─ [compact=true]  → AgentRunBlock (sections = groupIntoSections(msg, standaloneToolsSet))
  │                     ├─ MergeBlock (:blocks, :message, :isStreaming)
  │                     ├─ StandaloneToolCard (:tool-call)
  │                     └─ text div (renderedContent)
  └─ [compact=false] → ThinkingBlock / ToolCallCard / text div (sections = groupIntoSections(msg))
```

```
ChatPanel.vue
  → StreamingMessage (:message, :isStreaming)
    → MessageBubble (:message, :isStreaming)
      → AssistantContent (:message, :isStreaming)
        → AgentRunBlock (:message, :isStreaming)  [compact path]
```

### 评估

- **Settings → Component**: `settingsStore.compactStreaming` 和 `settingsStore.standaloneTools` 通过 Pinia computed 直接访问，Vue 响应式自动追踪变更。方向正确。
- **Layout → Component**: `groupIntoSections()` 返回 `AssistantSection[]`，通过 computed 派生，sections 变化自动触发重渲染。
- **Component → Child**: AgentRunBlock 通过 `v-for` 遍历 sections，按 type 分发到 MergeBlock / text div / StandaloneToolCard。每个子组件只接收自己需要的数据。
- **ChatPanel → MessageBubble → AssistantContent**: `isStreaming` 在每一层正确透传，类型逐级收敛（`boolean` → `boolean?` → `boolean`）。

**结论**: 数据流方向严格单向（store → layout → component → child），无反向隐式依赖。

---

## 2. Props 类型匹配

| 传递路径 | 发送类型 | 接收类型 | 状态 |
|---------|---------|---------|------|
| ChatPanel → StreamingMessage `:is-streaming` | `boolean` | `boolean`（必填） | ✅ |
| StreamingMessage → MessageBubble `:is-streaming` | `boolean` | `boolean?`（可选，默认 false） | ✅ |
| MessageBubble → AssistantContent `:is-streaming` | `boolean?` | `boolean?`（可选） | ✅ |
| AssistantContent → AgentRunBlock `:is-streaming` | `!!isStreaming` → `boolean` | `boolean`（必填） | ✅ |
| AgentRunBlock → MergeBlock `:blocks` | `ContentBlock[]` | `ContentBlock[]` | ✅ |
| AgentRunBlock → MergeBlock `:message` | `Message` | `Message` | ✅ |
| AgentRunBlock → MergeBlock `:is-streaming` | `boolean` | `boolean` | ✅ |
| AgentRunBlock → StandaloneToolCard `:tool-call` | `ToolCall`（non-null asserted） | `ToolCall`（必填） | ✅ |
| MergeBlock → ThinkingBlock `:text` | `string` | `string` | ✅ |
| MergeBlock → ThinkingBlock `:start-time` | `number \| undefined` | `number \| undefined` | ✅ |
| MergeBlock → ToolCallCard `:tool-call` | `ToolCall`（non-null asserted） | `ToolCall` | ✅ |

**Non-null assertion 安全性**: StandaloneToolCard 和 ToolCallCard 的 `:tool-call` 使用了 `!` 断言，但外层 `v-if` 已用 `resolveToolCall()` 做了空值检查，v-if guard 保护了 `!` 断言的组件不会被渲染。逻辑正确。

**结论**: 所有 props 类型完全匹配，无非安全类型转换。

---

## 3. 组件间通信方式

| 通信方式 | 使用场景 | 评估 |
|---------|---------|------|
| **Props down** | 所有数据传递（message, isStreaming, blocks, toolCall） | ✅ 主路径 |
| **Emit up** | MergeBlock 无 emit；StandaloneToolCard 无 emit；AgentRunBlock 无 emit | ✅ 无需向上通信 |
| **Store 直接访问** | AgentRunBlock 和 AssistantContent 都访问 `settingsStore` | ⚠️ 见下 |

### Store 访问分析

两个组件直接访问 `settingsStore`：

1. **AssistantContent.vue**: 读取 `compactStreaming` 决定渲染模式（compact vs normal）
2. **AgentRunBlock.vue**: 读取 `standaloneTools` 构建 `standaloneToolsSet`，传入 `groupIntoSections()`

这是否违反"组件间通信只通过 props/emit"原则？**不违反**。原因：
- Settings 是全局配置，所有消费者都应直接从 store 读取，避免层层 props drilling
- 这不是组件间通信（A 组件影响 B 组件），而是全局配置 → 组件渲染
- 两个组件对 store 的读取是独立的，无隐式耦合

**结论**: 无隐式依赖。Settings 通过 store 直接访问符合 Pinia 最佳实践。

---

## 4. compactStreaming=false 路径隔离

### 代码路径

`AssistantContent.vue`:
```vue
<AgentRunBlock v-if="useCompact" ... />
<template v-else-if="sections.length">
  <!-- Normal section mode -->
</template>
```

当 `compactStreaming=false`：
- `useCompact` = `false` → AgentRunBlock 不渲染
- 进入 `v-else-if` 分支 → 使用 `sections`（来自 `groupIntoSections(msg)` — 无 standaloneTools 参数）
- 调用路径：`groupIntoSections(msg)` → 无第二个参数 → 走 `groupByContentBlocksLegacy(msg)`

### `groupByContentBlocksLegacy` vs `groupByContentBlocks`

| 维度 | Legacy (compact=false) | New (compact=true) |
|------|----------------------|-------------------|
| 分组策略 | 相邻同类型合并 | 基于 standaloneTools 分类 |
| text 去重 | 无 hasText 检查 | 有 hasText 去重 |
| thinking/toolCall 归并 | 无 MergeBlock 概念，各自成 section | thinking + 内置 toolCall 合并为 merge section |
| 自定义工具 | 与内置工具相同处理 | 区分 customTool vs standalone |

### 验证要点

1. **Legacy 路径无 hasText 检查**：compact=false 时 text block 是按相邻类型合并，不适用 hasText 去重。这是因为 legacy 路径直接渲染 ToolCallCard 和 ThinkingBlock（不经过 AgentRunBlock），不存在"文本被 MergeBlock 吞掉"的重复渲染问题。
2. **Legacy 路径不依赖 standaloneTools**：`groupIntoSections(msg)` 不传第二个参数，走 `groupByContentBlocksLegacy`。
3. **两个路径共享的纯函数**：`groupIntoSections` 入口、`groupByLegacyFields`（无 contentBlocks 时）。共享部分无状态修改，无交叉影响。

**结论**: compactStreaming=false 路径完全隔离，不受 compact 模式新增逻辑的影响。

---

## 5. Settings 变更即时反映

### compactStreaming 变更

`AssistantContent.vue`:
```ts
const useCompact = computed(() => settingsStore.compactStreaming)
```

`settingsStore.compactStreaming` 是 Pinia `ref`，computed 自动追踪。变更 → computed 重算 → `v-if` 条件切换 → 整个渲染模式切换。

切换时 AgentRunBlock 被销毁、normal sections 被创建（或反之）。Vue 的 v-if 语义确保组件完整销毁/创建，无残留状态。

### standaloneTools 变更

`AgentRunBlock.vue`:
```ts
const standaloneToolsSet = computed(() => new Set(settingsStore.standaloneTools))
const sections = computed(() => groupIntoSections(props.message, standaloneToolsSet.value))
```

变更链：`settingsStore.standaloneTools` → `standaloneToolsSet` 重算 → `sections` 重算 → template 重渲染。

这意味着用户在 Settings 中添加/移除 standalone tool 时，**已渲染的 AgentRunBlock 会立即重新分组**。例如：
- 将 `read` 从 standalone 移除 → 之前独立展示的 read 操作会归入 MergeBlock
- 将 `bash` 加入 standalone → 之前在 MergeBlock 中的 bash 操作会独立展示

这是预期行为，无状态泄漏。

### StandaloneToolCard 独立 Timer

StandaloneToolCard 有自己的 timer 管理（`onMounted`/`onUnmounted`/`watch`），不使用 `useLiveTimer` composable。这导致：
- AgentRunBlock 和 MergeBlock 使用 `useLiveTimer`
- StandaloneToolCard 使用内联 timer 逻辑

不影响正确性，但存在代码重复（BLR v2 的 suggest-fix 提到类似问题）。不阻塞合入。

---

## 发现的问题

### MUST-FIX: 0

无阻塞性问题。

### SUGGEST-FIX: 1

**SF#1: StandaloneToolCard timer 未使用 useLiveTimer composable**

- **文件**: `StandaloneToolCard.vue` L28-50
- **现状**: 自行管理 `setInterval`/`clearInterval`，与 AgentRunBlock 和 MergeBlock 的 `useLiveTimer` 用法不一致
- **风险**: 低。逻辑正确，但 timer 管理分散在两处，增加维护负担
- **建议**: 迁移到 `useLiveTimer`，与其他组件保持一致
- **阻塞级别**: 不阻塞

---

## 最终评估

| 检查维度 | 结果 | 说明 |
|---------|------|------|
| 数据流方向 | ✅ PASS | 严格单向，store → layout → component → child |
| Props 类型匹配 | ✅ PASS | 所有 props 类型正确，non-null assertion 有 v-if guard 保护 |
| 组件间通信 | ✅ PASS | Props/emit 为主，store 直接访问仅限全局配置，无隐式依赖 |
| compact=false 隔离 | ✅ PASS | 两条路径完全隔离，共享纯函数无状态修改 |
| Settings 即时反映 | ✅ PASS | Pinia computed 自动追踪，变更即时触发重渲染 |

**Verdict: pass**
