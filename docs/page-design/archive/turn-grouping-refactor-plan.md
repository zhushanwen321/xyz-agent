# Turn 分组 + Section 缩进重构 Plan

基于 `docs/designs/chat-area-design-decisions.md` 方案 B（Turn 分组 + 细分割线）。

## 1. 影响分析

### 1.1 受影响组件清单

| 组件 | 影响程度 | 变更内容 |
|------|---------|---------|
| **MessageBubble.vue** | **重度** | 抽出 AssistantContent，移除 assistantSections/batch 逻辑，瘦身至 ~200 行 |
| **ChatPanel.vue** | **中度** | Turn 分组渲染已部分完成，需配合新接口调整 |
| **ThinkingBlock.vue** | **轻微** | 移除 `mb-2`（改由 section 容器控制间距） |
| **ToolCallCard.vue** | **轻微** | 移除 `my-2`（改由 section 容器控制间距） |
| **StreamingMessage.vue** | **无** | 继续透传给 MessageBubble |
| **SystemNotification.vue** | **无** | 不受 Turn 分组影响（已在 ChatPanel 独立渲染） |
| **SkillDrawer.vue** | **无** | 不受影响 |
| **ChatOutline.vue** | **无** | 不受影响 |
| **MessageActionMenu.vue** | **无** | 不受影响 |
| **BranchIndicator.vue** | **无** | 不受影响 |
| **ApprovalCard.vue** | **无** | 不受影响 |

### 1.2 CSS 样式影响分析

#### 已存在的全局样式（style.css）

| 选择器 | 位置 | 当前状态 | 重构后影响 |
|--------|------|---------|-----------|
| `.turn-group` | style.css L820 | 已添加 | **保留**，微调间距参数 |
| `.turn-group + .turn-group` | style.css L823 | 已添加 | **保留** |
| `.turn-group--system-only` | style.css L829 | 已添加 | **保留** |
| `.asst-section` | style.css L845 | 已添加 | **保留**，可能改名为 `.section-block` |
| `.asst-section__label` | style.css L855 | 已添加 | **保留** |
| `.asst-section__dot*` | style.css L864-871 | 已添加 | **保留** |
| `.asst-section .thinking-block` | style.css L874 | 已添加 | **保留**（清除子组件自带的 margin） |
| `.msg__body *` | style.css L388+ | markdown 渲染 | **不动** |
| `--msg-assistant-bg` | style.css L61/104 | CSS 变量 | **不动** |
| `--msg-thinking-bg` | style.css L62/105 | CSS 变量 | **不动** |
| `--msg-tool-bg` | style.css L63/106 | CSS 变量 | **不动** |

#### 组件 scoped 样式

| 组件 | scoped 样式 | 重构影响 |
|------|-----------|---------|
| ThinkingBlock.vue | `.thinking-block` background + `.thinking-header` 渐变 | **保留**，但移除根元素的 `mb-2` class |
| ToolCallCard.vue | `.tool-card` background + `.tool-header` 渐变 + progress 动画 | **保留**，但移除根元素的 `my-2` class |
| MessageBubble.vue | `.msg-actions` hover 显示 + `.skill-link` + `.msg-batch-checkbox` | **保留**，移入新组件或留在 MessageBubble |
| ChatPanel.vue | `.scroll-fab` + fab transition | **不动** |

#### CSS 变量引用链

```
.turn-group border-top → var(--border) → oklch(90%/24%)
.asst-section border-left → var(--border)
.thinking-block bg → var(--msg-thinking-bg) → oklch(97%/19%)
.tool-card bg → var(--msg-tool-bg) → oklch(97%/19%)
user bubble bg → var(--user-bubble-bg)
text bubble bg → var(--msg-assistant-bg) → oklch(98%/18%)
```

**关键发现**：ThinkingBlock、ToolCallCard、text 气泡三者的背景色差异在浅色模式下只有 L=1%（97% vs 98%），在深色模式下只有 L=1%（19% vs 18%）。**视觉区分度几乎为零**。方案 B 的 section border-left + 彩色圆点正是为了弥补这个区分度不足。

### 1.3 间距（gap/margin）依赖链

```
ChatPanel gap-[6px]          ← 消息列表容器，每条消息间 6px
  └─ .turn-group padding: 6px 0  ← Turn 内部上下各 6px
       └─ .asst-section margin-bottom: 6px  ← section 间 6px
            └─ ThinkingBlock mb-2 (8px) ← 目前与 section margin 冲突
            └─ ToolCallCard my-2 (8px)  ← 目前与 section margin 冲突
```

**问题**：ThinkingBlock 的 `mb-2`(8px) 和 ToolCallCard 的 `my-2`(8px) 与 section 的 `margin-bottom: 6px` 叠加，导致间距不均匀。

**修复**：移除子组件自带 margin，统一由 section 容器控制。已在 style.css `.asst-section .thinking-block { margin-bottom: 0 }` 做了覆盖，但 ToolCallCard 的 `my-2` 还需要同样处理。

## 2. 架构方案

### 2.1 文件结构

```
lib/
  message-layout.ts            ← NEW: 纯函数，分组逻辑
    groupIntoTurns(msgs) → Turn[]
    groupIntoSections(msg) → AssistantSection[]

composables/
  useTurnGroups.ts              ← REWRITE: 薄 wrapper，调用 lib

components/chat/
  MessageBubble.vue             ← REFACTOR: 瘦身，只管 frame
  AssistantContent.vue          ← NEW: 编排 thinking/tool/text sections
  AssistantSection.vue          ← NEW: section 容器 + label（border-left + dot）
  ThinkingBlock.vue             ← MICRO: 移除 mb-2
  ToolCallCard.vue              ← MICRO: 移除 my-2
```

### 2.2 数据流

```
ChatPanel
  │ props.messages: ChatMessage[]
  │
  ├─ useTurnGroups(messages) → Turn[]
  │     调用 lib/message-layout.ts groupIntoTurns()
  │
  └─ Template:
      <div class="turn-group" v-for="turn in turns">
        <SystemNotification v-if="system" />
        <MessageBubble v-else :message="msg">
          │
          ├─ user → 气泡 + skill-link + actions（不变）
          │
          └─ assistant → <AssistantContent :message="msg">
                │
                ├─ groupIntoSections(msg) → Section[]
                │     处理 contentBlocks 有/无 两种情况
                │
                └─ <AssistantSection v-for="section" :type="section.type">
                     <template #label>Thinking · 3.2s</template>
                     <ThinkingBlock /> or <ToolCallCard /> or text
```

### 2.3 新文件说明

#### `lib/message-layout.ts`

纯函数模块，无 Vue 依赖，可单元测试。

```typescript
// Types
interface Turn { key: string; messages: ChatMessage[] }
type SectionType = 'thinking' | 'toolCall' | 'text'
interface AssistantSection { type: SectionType; blocks: ContentBlock[]; label: string }

// Functions
function groupIntoTurns(msgs: ChatMessage[]): Turn[]
function groupIntoSections(msg: Message): AssistantSection[]
```

`groupIntoSections` 的核心逻辑：
- 有 `contentBlocks`：按相邻同类型合并，返回有序 sections
- 无 `contentBlocks`（历史消息）：从 `message.thinking` → `message.toolCalls` → `message.content` 构造 sections
- **统一 fallback 路径**，不再在模板里判断

#### `AssistantContent.vue`

- Props: `message: Message`
- 调用 `groupIntoSections(props.message)` 获取 sections
- 遍历 sections，每个渲染一个 `<AssistantSection>`
- text section 的 markdown 渲染逻辑从 MessageBubble 移入

#### `AssistantSection.vue`

- Props: `type: SectionType`, `label?: string`
- 提供 border-left + padding-left + margin-bottom 容器
- 渲染 section label（彩色圆点 + 文字）
- 默认 slot 放子组件（ThinkingBlock/ToolCallCard/text content）

### 2.4 MessageBubble 瘦身后职责

| 保留 | 移除 |
|------|------|
| user 气泡渲染 | `assistantSections` computed |
| skill-link 逻辑 | `batchInfoMap` computed |
| action menu | `formatBatchSize` / `extractContentSize` |
| branch indicator | mermaid 渲染逻辑（移入 composable） |
| copy handler | markdown 渲染逻辑（移入 AssistantContent 或 composable） |
| assistant frame（label + timestamp） | fallback 模板 |
| `<AssistantContent>` 委托 | contentBlocks 遍历 |

## 3. 实施顺序（Phase）

### Phase 0: 准备（不改动现有功能）

**Step 0.1** — 新建 `lib/message-layout.ts`

- 纯函数 `groupIntoTurns` + `groupIntoSections`
- 从现有 `useTurnGroups.ts` 和 `MessageBubble.vue` 的 `assistantSections` 提取逻辑
- `groupIntoSections` 统一处理有/无 contentBlocks 两种情况
- **无任何现有代码改动**

**Step 0.2** — 新建 `AssistantSection.vue`

- 纯展示组件：border-left + label + slot
- 接收 `type` 和可选 `label` prop
- 包含 section dot 颜色逻辑
- **无任何现有代码改动**

**Step 0.3** — 新建 `AssistantContent.vue`

- 接收 `message: Message` prop
- 调用 `groupIntoSections(message)` 获取 sections
- 遍历 sections，渲染 `<AssistantSection>` + 对应子组件
- text section 的 markdown 渲染暂时从 MessageBubble 复制（后续抽出 composable）
- **无任何现有代码改动**

**验证点**: `vue-tsc --noEmit` 通过

### Phase 1: 切换（替换 MessageBubble assistant 分支）

**Step 1.1** — MessageBubble assistant 分支替换为 `<AssistantContent>`

- 删除整个 assistant 模板（section-grouped + fallback 两个 `<template>`）
- 替换为 `<AssistantContent :message="message" />`
- 保留 assistant frame（label + timestamp + actions + branch indicator）

**Step 1.2** — 从 MessageBubble 移除 assistant 专属逻辑

- 移除 `assistantSections` computed
- 移除 `toolCallCount` computed
- 移除 `batchInfoMap` computed 及相关辅助函数
- 移除 `ContentBlock` import
- 移除 `BatchInfo` import

**Step 1.3** — 重写 `useTurnGroups.ts`

- 改为调用 `lib/message-layout.ts` 的 `groupIntoTurns`
- 保持 composable 接口不变（ChatPanel 无需改动）

**Step 1.4** — 移除 ThinkingBlock `mb-2` 和 ToolCallCard `my-2`

- ThinkingBlock: 移除根元素 class 中的 `mb-2`
- ToolCallCard: 移除根元素 class 中的 `my-2`
- 删除 style.css 中 `.asst-section .thinking-block { margin-bottom: 0 }` 覆盖（不再需要）

**验证点**:
- `vue-tsc --noEmit` 通过
- 启动 dev，发送消息，检查 assistant 回复的 thinking/tool/text 渲染正确
- 对比 demo HTML 截图，确认视觉一致性

### Phase 2: 清理（移除冗余代码和样式）

**Step 2.1** — 清理 MessageBubble 中的 markdown/mermaid 逻辑

- 将 `renderFull`/`renderLightweight`/mermaid 懒加载/watch 逻辑抽出到 `composables/useMarkdownRender.ts`
- MessageBubble（user）和 AssistantContent 都使用这个 composable
- MessageBubble 行数目标：~200 行

**Step 2.2** — 清理 style.css 中过时的样式

- 移除 `.asst-section .thinking-block { margin-bottom: 0 }`（已在 Phase 1 根治）
- 确认 `.turn-group--system-only` 规则在所有场景正确
- 确认 `gap-[6px]` 在 ChatPanel 消息列表容器上的效果（Turn 内部消息不再需要 gap，由 turn-group 接管）

**Step 2.3** — 清理 import 链

- 确认 MessageBubble 不再 import `ContentBlock`/`BatchInfo`
- 确认 ChatPanel 的 `useTurnGroups` import 指向重写后的版本

**验证点**:
- `vue-tsc --noEmit` 通过
- `npm run lint` 无新增 error
- 回归测试：消息发送、streaming、skill 触发、batch select、branch navigate 全部正常

## 4. 风险评估

### 4.1 高风险

| 风险 | 缓解措施 |
|------|---------|
| markdown 渲染逻辑迁移时引入 bug（mermaid 懒加载、代码高亮、streaming 轻量渲染） | Phase 2 才迁移 markdown，Phase 1 先复制一份到 AssistantContent |
| fallback 路径（无 contentBlocks 的历史消息）渲染不一致 | `groupIntoSections` 统一处理两种情况，单测覆盖 |

### 4.2 中风险

| 风险 | 缓解措施 |
|------|---------|
| ThinkingBlock/ToolCallCard 移除 margin 后，非 section 场景（如果其他地方单独使用）间距丢失 | grep 确认这两个组件只在 section 容器内使用 |
| CSS `.turn-group + .turn-group` 的相邻选择器在 system-only turn 时行为异常 | 已有 `--system-only` 覆盖规则 |

### 4.3 低风险

| 风险 | 缓解措施 |
|------|---------|
| `groupIntoSections` 新函数的性能（每条消息都调用） | 消息量通常 < 200 条，computed 缓存足够 |
| AssistantContent 新组件的 streaming 状态传递 | 通过 message.status prop 天然传递，无需额外逻辑 |

## 5. 审查遗漏（补充）

### 5.1 StreamingMessage / Thinking Indicator 在 turn-group 外

当前 ChatPanel 中：
- `turn-group` 只包裹 `view.messages`（已完成的消息）
- `StreamingMessage` 和 thinking indicator（"思考中..."）在 turn-group 外独立渲染

**影响**：StreamingMessage → MessageBubble → assistant 分支。重构后 assistant 分支委托给 `AssistantContent`，streaming 消息自然走新路径，不需要额外处理。thinking indicator 纯 CSS，不受影响。

**结论**：无需改动，当前行为正确（streaming 消息不属于任何已完成 turn）。

### 5.2 Batch Select DOM 查询

`ChatPanel.copyBatchAs` 通过 `[data-entry-id]` 查询 DOM。重构后 MessageBubble 仍保留 `data-entry-id`/`data-role`/`data-timestamp` 在根元素上（frame 层），不受内部 section 重构影响。

**结论**：无需改动。

### 5.3 Copy / Fork 功能

copy 和 fork 在 MessageBubble frame 层（action menu）。`handleCopy` 通过 `getMessageEl()` 获取 DOM，然后调用 `collectMessageContent`。重构后 MessageBubble 根元素不变，copy 目标是整个消息（包含所有 section），DOM 查询路径不受影响。

**结论**：无需改动。

### 5.4 getThinkingContent / getToolCall 迁移

这两个函数从 `message.thinking`/`message.toolCalls` 中按 refId 查找。重构后需要移到 `AssistantContent.vue` 中。

**Plan 更新**：Phase 0.3 新建 AssistantContent 时需包含这两个查找函数。

### 5.5 batchInfoMap 迁移

`batchInfoMap`（连续同类型 tool call 的批量信息）和 `BatchInfo` 类型目前定义在 MessageBubble 中。重构后移到 AssistantContent。

**Plan 更新**：Phase 0.3 新建 AssistantContent 时需包含 batch 逻辑。

### 5.6 ChatPanel gap-[6px] 与 turn-group 间距交互

当前：
- 消息列表容器有 `gap-[6px]`（flex gap）
- turn-group 是直接子元素，所以 gap-[6px] 作用于 turn-group 之间
- turn-group 内部消息之间没有 gap，靠消息自身 margin

重构后：
- turn-group 之间的 gap-[6px] + turn-group 的 border-top 叠加可能过大
- **需要评估**：是否把 gap-[6px] 改为 0，完全由 turn-group 的 padding + border-top 控制

**Plan 更新**：Phase 2.2 清理时调整 gap。

## 6. 不在范围内

以下工作明确不在本次重构范围内：

- ThinkingBlock 渐变 header 简化（保留现有交互体验）
- ToolCallCard 折叠为单行行内形式（保留现有渲染器体系）
- ChatOutline activeIndex 跟随滚动
- MessageBubble 行数超标修复（作为 Phase 2 完成后的自然结果）
- `StreamingMessage.vue` 改造（它只是 MessageBubble 的透传，不需要改）
