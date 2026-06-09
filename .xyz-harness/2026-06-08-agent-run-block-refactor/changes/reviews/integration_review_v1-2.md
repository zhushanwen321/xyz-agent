---
verdict: pass
must_fix: 0
review_metrics:
  files_reviewed: 10
  lines_reviewed: ~980
  dimensions_checked: 9
  must_fix_count: 0
  suggest_fix_count: 3
---

# Integration Review v1-2 — AgentRunBlock 重构

**Reviewer**: Integration Review Agent
**Date**: 2026-06-08
**Prior reviews**: v1-1 (pass, 0 MF, 3 SF)
**Files reviewed**: message-layout.ts, AgentRunBlock.vue, MergeBlock.vue, StandaloneToolCard.vue, AssistantContent.vue, ChatPanel.vue, StreamingMessage.vue, MessageBubble.vue, settings.ts, SystemPane.vue

---

## 1. 数据流方向

### 完整链路

```
Settings Store (Pinia)
  ↓ ref + persist
AssistantContent.vue  ← useCompact = settingsStore.compactStreaming
  ├─ [compact=true]  → AgentRunBlock
  │    sections = groupIntoSections(msg, standaloneToolsSet)
  │    enrichedSections = sections.map(toolCall resolve)
  │    ├─ MergeBlock (:blocks, :message, :isStreaming)
  │    │    ├─ ThinkingBlock (:text, :start-time, :end-time)
  │    │    └─ ToolCallCard (:tool-call)
  │    ├─ StandaloneToolCard (:tool-call)
  │    └─ text div (renderedContent via useMarkdownRender)
  └─ [compact=false] → AssistantSection → ThinkingBlock / ToolCallCard / text

ChatPanel.vue
  → StreamingMessage (:message, :isStreaming)
    → MessageBubble (:message, :isStreaming)
      → AssistantContent (:message, :isStreaming)
        → AgentRunBlock (:message, :isStreaming)  [compact path]
```

### 评估

- **Settings → Component**: `settingsStore.compactStreaming` 和 `settingsStore.standaloneTools` 通过 Pinia ref 直接访问，Vue computed 自动追踪。变更即时触发重渲染。方向正确。
- **Layout → Component**: `groupIntoSections()` 返回 `AssistantSection[]`，AgentRunBlock 在 `rawSections` 基础上 enrich `toolCall` 字段形成 `EnrichedSection[]`。数据从纯函数到组件的映射清晰。
- **Component → Child**: 每个子组件只接收自己需要的 props。MergeBlock 接收 `blocks + message + isStreaming`，自行 resolve 内部数据。StandaloneToolCard 只接收预解析好的 `toolCall`。
- **ChatPanel → AssistantContent**: `isStreaming` 在 StreamingMessage → MessageBubble → AssistantContent → AgentRunBlock 四层中正确透传（`boolean` → `boolean?` → `boolean?` → `boolean` via `!!isStreaming`）。

**结论**: 数据流方向严格单向，无反向隐式依赖。

---

## 2. Props 类型匹配

| 传递路径 | 发送类型 | 接收类型 | 状态 |
|---------|---------|---------|------|
| ChatPanel → StreamingMessage `:is-streaming` | `boolean` | `boolean`（必填） | ✅ |
| StreamingMessage → MessageBubble `:is-streaming` | `boolean` | `boolean?`（可选） | ✅ |
| MessageBubble → AssistantContent `:is-streaming` | `boolean?` | `boolean?`（可选） | ✅ |
| AssistantContent → AgentRunBlock `:is-streaming` | `!!isStreaming` → `boolean` | `boolean`（必填） | ✅ |
| AgentRunBlock → MergeBlock `:blocks` | `ContentBlock[]`（from rawSections） | `ContentBlock[]` | ✅ |
| AgentRunBlock → MergeBlock `:message` | `Message` | `Message` | ✅ |
| AgentRunBlock → MergeBlock `:is-streaming` | `boolean` | `boolean` | ✅ |
| AgentRunBlock → StandaloneToolCard `:tool-call` | `ToolCall \| undefined`（v-if guard） | `ToolCall`（必填） | ✅ |
| MergeBlock → ThinkingBlock `:text` | `string`（含 fallback） | `string` | ✅ |
| MergeBlock → ToolCallCard `:tool-call` | `ToolCall \| undefined`（v-if guard） | `ToolCall` | ✅ |

**Non-null assertion 安全性**: StandaloneToolCard 和 ToolCallCard 的 `:tool-call` 在 v-if 中通过 truthy 检查保护，`!` 断言安全。

**结论**: 所有 props 类型匹配，无类型不一致。

---

## 3. 模块边界与职责隔离

| 组件 | 职责 | 对外依赖 |
|------|------|---------|
| message-layout.ts | 纯函数：分组逻辑 | @xyz-agent/shared 类型 |
| AgentRunBlock | 容器：分组展示 + footer 统计 | message-layout, settingsStore, useLiveTimer, useMarkdownRender |
| MergeBlock | 合并块：streaming 状态 + complete chip 条 + 展开 | ThinkingBlock, ToolCallCard, useLiveTimer |
| StandaloneToolCard | 独立工具卡片：状态 + 路径 + 展开 | ToolCallCard, useLiveTimer |
| AssistantContent | 渲染分支：compact vs normal | AgentRunBlock（compact）, AssistantSection（normal） |

**分组逻辑**: 纯函数，无 Vue 依赖、无副作用、无状态。`groupIntoSections` 根据 `standaloneTools` 参数是否传入，分发到新/旧分组函数。两条路径互不干扰。

**结论**: 每个组件职责单一，边界清晰。AssistantContent 是唯一的渲染模式分发点。

---

## 4. Timer 生命周期管理

```typescript
// 三个组件均使用 useLiveTimer，interval 各不同：
AgentRunBlock:       useLiveTimer(200)  ← footer elapsed
MergeBlock:          useLiveTimer(200)  ← streaming status text
StandaloneToolCard:  useLiveTimer(100)  ← card elapsed
```

**生命周期**: 所有组件通过 `watch(isStreaming, ...)` 启停 timer。`useLiveTimer` 内部注册 `onBeforeUnmount(stop)`，组件卸载时自动清理。无 timer 泄漏风险。

**独立性**: 三个组件的 timer 各自管理，互不影响。即使 MergeBlock 内嵌套 ToolCallCard（展开时），ToolCallCard 的 timer 由自身管理，与 MergeBlock 的 timer 独立。

**结论**: Timer 生命周期管理正确，无泄漏。

---

## 5. Settings → 渲染管道

### compactStreaming 变更链路

```
settingsStore.compactStreaming (ref)
  → AssistantContent.useCompact (computed)
  → v-if 条件切换
  → AgentRunBlock 创建/销毁 或 normal sections 创建/销毁
```

Vue v-if 语义确保组件完整销毁/创建，无残留状态。

### standaloneTools 变更链路

```
settingsStore.standaloneTools (ref)
  → AgentRunBlock.standaloneToolsSet (computed: new Set(...))
  → AgentRunBlock.sections (computed: groupIntoSections(msg, standaloneToolsSet))
  → template v-for 重渲染
```

变更即时生效。用户将 `bash` 加入 standaloneTools → MergeBlock 中的 bash block 会移到 StandaloneToolCard。

### 持久化

`standaloneTools` 在 `persist.pick` 数组中，存储到 localStorage `xyz-settings` key。重启后恢复用户配置。默认值 `['write', 'edit']` 在 `ref` 初始化时设定。

### Settings UI 验证

SystemPane.vue 中 standaloneTools UI 仅在 `settingsStore.compactStreaming` 为 true 时显示。使用 `Toggle` 组件（非原生 checkbox），`v-for="tool in ALL_PI_TOOLS"` 遍历 7 种内置工具。`toggleStandaloneTool` 函数正确地创建新数组赋值给 store（确保响应式触发）。

**结论**: Settings 到渲染的管道完整，变更即时反映，持久化正确。UI 使用项目组件库，无原生 HTML 表单元素。

---

## 6. compactStreaming=false 路径隔离

`AssistantContent.vue`:
```vue
<AgentRunBlock v-if="useCompact" ... />
<template v-else-if="sections.length">
  <!-- Normal section mode: sections = groupIntoSections(msg) — 无 standaloneTools 参数 -->
</template>
```

当 `compactStreaming=false`:
- `useCompact` = `false` → AgentRunBlock 不渲染
- `sections` = `groupIntoSections(msg)` → 无第二参数 → `groupByContentBlocksLegacy(msg)`
- Legacy 路径不涉及 MergeBlock、StandaloneToolCard、ALL_PI_TOOLS 等新概念

### 隔离验证

| 维度 | compact=true 路径 | compact=false 路径 | 隔离 |
|------|-------------------|-------------------|------|
| 分组函数 | `groupByContentBlocks` | `groupByContentBlocksLegacy` | ✅ 独立函数 |
| 渲染组件 | AgentRunBlock → MergeBlock / StandaloneToolCard | AssistantSection → ThinkingBlock / ToolCallCard | ✅ 独立组件树 |
| Settings 读取 | `standaloneTools` | 不读取 | ✅ 无交叉 |
| Timer | useLiveTimer（AgentRunBlock + MergeBlock） | ToolCallCard 自有 timer | ✅ 独立 |

**结论**: compactStreaming=false 路径完全隔离，不受新增逻辑影响。

---

## 7. ContentBlock refId 解析一致性

| 组件 | 解析方式 | 数据源 |
|------|---------|--------|
| AgentRunBlock | `sections` computed: `message.toolCalls?.find(tc => tc.id === s.blocks[0].refId)` | `props.message.toolCalls` |
| MergeBlock | `resolveToolCall(refId)`: `message.toolCalls?.find(tc => tc.id === refId)` | `props.message.toolCalls` |
| MergeBlock | `resolveThinking(refId)`: `message.thinking?.find(b => b.id === refId)` | `props.message.thinking` |

**一致性**: 所有解析都从同一个 `message` 对象读取，使用相同的 `refId` 匹配逻辑。AgentRunBlock 为 standalone/customTool section 预解析 toolCall 并传递给 StandaloneToolCard；MergeBlock 内部自行解析。两种方式使用相同的匹配算法，结果一致。

**结论**: refId 解析在所有组件中一致，无数据不一致风险。

---

## 8. 模块间交叉依赖检查

### 导入关系图

```
message-layout.ts
  ← @xyz-agent/shared (Message, ContentBlock 类型)
  ← ../stores/chat (ChatMessage 类型)

AgentRunBlock.vue
  ← message-layout.ts (groupIntoSections, ALL_PI_TOOLS)
  ← stores/settings.ts (useSettingsStore)
  ← composables/useMarkdownRender.ts
  ← composables/useMarkdownBodyClick.ts
  ← composables/useLiveTimer.ts
  ← lib/compact-utils.ts (formatTime)
  ← MergeBlock.vue, StandaloneToolCard.vue

MergeBlock.vue
  ← @xyz-agent/shared (ContentBlock, Message, ThinkingBlock, ToolCall)
  ← ThinkingBlock.vue, ToolCallCard.vue
  ← lib/compact-utils.ts (formatTime, toolPath)
  ← composables/useLiveTimer.ts

StandaloneToolCard.vue
  ← @xyz-agent/shared (ToolCall)
  ← ToolCallCard.vue
  ← lib/compact-utils.ts (formatTime, toolPath)
  ← composables/useLiveTimer.ts

AssistantContent.vue
  ← message-layout.ts (groupIntoSections, AssistantSection)
  ← AgentRunBlock.vue
  ← ThinkingBlock.vue, ToolCallCard.vue, AssistantSection.vue
  ← composables/useMarkdownRender.ts, useMarkdownBodyClick.ts
  ← stores/settings.ts
```

**循环依赖**: 无。所有依赖关系为单向树形结构。

**共享依赖**: `useLiveTimer`、`compact-utils`、`@xyz-agent/shared` 被多个组件共享，但都是无状态工具函数/类型定义，不存在状态耦合。

**结论**: 模块依赖关系健康，无循环依赖，共享依赖为纯函数/类型。

---

## 9. 边界条件与数据变换正确性

### 9.1 空 contentBlocks

`groupIntoSections` 第一行：`if (msg.contentBlocks?.length)` — 无 contentBlocks 时走 `groupByLegacyFields`，安全。

### 9.2 空 text block

`groupByContentBlocks` 中：`if (!msg.content || hasText) continue` — 空 content 或重复 text block 被跳过。AgentRunBlock template 中 `v-else-if="section.type === 'text' && message.content"` 进一步保护。双重安全。

### 9.3 toolCalls 为 undefined

`groupByContentBlocks` 中：`msg.toolCalls?.find(...)` — 可选链安全。tc 为 undefined 时 `isCustom` 为 false，section type 为 `standalone`。AgentRunBlock 中 `section.toolCall` 为 undefined，v-if guard 跳过渲染（见 SF#3）。

### 9.4 thinking 为 undefined

`isMergeBlock` 中 `block.type === 'thinking'` 直接返回 true（不依赖 message.thinking）。MergeBlock 中 `resolveThinking(refId)` 返回 undefined，ThinkingBlock 接收空字符串和 undefined 时间。可接受。

### 9.5 timestamp 缺失

AgentRunBlock `elapsedMs` 计算：`allTimes.length === 0` 时返回 0。MergeBlock `streamElapsed`：`!ts` 时返回空字符串。均安全。

### 9.6 toolCall.startTime 缺失

StandaloneToolCard `elapsedMs`：`if (!start) return 0` — 安全。

**结论**: 所有边界条件均有防护，无未处理的 null/undefined 路径。

---

## 发现的问题

### MUST-FIX: 0

### SUGGEST-FIX: 3（与 v1-1 相同，未修复但不阻塞）

**SF#1: MergeBlock 与 AgentRunBlock 耗时计算方式不一致**

- **MergeBlock** `streamElapsed`: `now - message.timestamp`（从消息创建时间算起）
- **AgentRunBlock** `elapsedMs`: `now - min(startTimes)`（从最早 thinking/toolCall 开始时间算起）
- **影响**: footer 显示的耗时与 MergeBlock streaming 显示的耗时可能有微小差异（通常 `message.timestamp` ≈ `min(startTimes)`，但不保证完全一致）
- **建议**: 统一为一种计算方式。由于 footer 是主要耗时展示点，MergeBlock streaming 可简化为 `now - footerElapsedMs` 或直接不显示耗时
- **阻塞级别**: 不阻塞

**SF#2: StandaloneToolCard timer interval 与其他组件不一致**

- **StandaloneToolCard**: `useLiveTimer(100)` — 100ms 更新间隔
- **AgentRunBlock + MergeBlock**: `useLiveTimer(200)` — 200ms 更新间隔
- **影响**: StandaloneToolCard 的 elapsed 显示更流畅但 CPU 开销翻倍。如果用户将所有 7 种工具设为 standalone，streaming 期间同时运行 7 个 100ms timer + 1 个 200ms timer（MergeBlock）+ 1 个 200ms timer（AgentRunBlock footer）
- **建议**: 统一为 200ms
- **阻塞级别**: 不阻塞

**SF#3: section.toolCall 为 undefined 时静默跳过渲染**

- **位置**: AgentRunBlock.vue template — `v-else-if="section.type === 'standalone' && section.toolCall"`
- **现状**: 如果 `sections` computed 中 `toolCalls?.find()` 返回 undefined（refId 不匹配），该 section 不渲染，用户看不到任何内容
- **影响**: 低。正常情况下 refId 不会不匹配（EventAdapter 保证一致性）。仅在数据异常时触发
- **建议**: 添加 fallback 渲染（如显示工具名 + "数据加载中..."），或在 `sections` computed 中过滤掉 toolCall 为 undefined 的 standalone/customTool section
- **阻塞级别**: 不阻塞

---

## 最终评估

| 检查维度 | 结果 | 说明 |
|---------|------|------|
| 数据流方向 | ✅ PASS | 严格单向：store → layout → component → child |
| Props 类型匹配 | ✅ PASS | 所有 props 类型正确，v-if guard 保护 non-null assertion |
| 模块边界 | ✅ PASS | 每个组件职责单一，分组逻辑为纯函数 |
| Timer 生命周期 | ✅ PASS | useLiveTimer + onBeforeUnmount 自动清理，无泄漏 |
| Settings → 渲染管道 | ✅ PASS | computed 自动追踪，变更即时反映，持久化正确 |
| compact=false 隔离 | ✅ PASS | 两条路径完全独立，共享纯函数无状态修改 |
| refId 解析一致性 | ✅ PASS | 所有组件从同一 message 源解析，匹配逻辑一致 |
| 模块交叉依赖 | ✅ PASS | 无循环依赖，共享依赖为纯函数/类型 |
| 边界条件 | ✅ PASS | 所有 null/undefined 路径均有防护 |

**Verdict: pass**
