---
verdict: pass
---

# Plan: AgentRunBlock 重构

## 目标

将 assistant 消息的渲染从 flat section 改为三层 AgentRunBlock 结构：容器 → MergeBlock/StandaloneBlock → 展开细节。同时新增 standaloneTools 设置项。

## 依赖图

```
T1 (settings store)
 ├── T2 (message-layout 分组)
 │    └── T3 (MergeBlock 组件)
 │    └── T4 (StandaloneToolCard 组件)
 │    └── T5 (AgentRunBlock 容器)
 │         └── T6 (AssistantContent 集成)
 │         └── T7 (ChatPanel streaming 集成)
 └── T8 (Settings 页面 UI)
```

## Task 列表

### T1: settings store 新增 standaloneTools

**文件**: `src-electron/renderer/src/stores/settings.ts`

**改动**:
- 新增 `const standaloneTools = ref<string[]>(['write', 'edit'])`
- 在 persist.pick 数组中追加 `'standaloneTools'`
- 导出 `standaloneTools`

**验证**: `grep standaloneTools src-electron/renderer/src/stores/settings.ts` 有输出

---

### T2: message-layout 分组逻辑重写

**文件**: `src-electron/renderer/src/lib/message-layout.ts`

**改动**:
1. 扩展 `SectionType` 为 `'merge' | 'text' | 'standalone' | 'customTool'`
2. 扩展 `AssistantSection` 新增可选字段 `toolCallIds?: string[]`（merge section 用）和 `toolCallId?: string`（standalone section 用）
3. 新增常量 `ALL_PI_TOOLS` 和函数 `isMergeBlock(block, msg, standaloneTools): boolean`
4. 重写 `groupByContentBlocks(msg, standaloneTools)`：
   - 遍历 contentBlocks
   - isMergeBlock → 追加到当前 merge section
   - 否则 → 关闭当前 merge，创建独立 section（text/standalone/customTool）
5. `groupByLegacyFields` 不变

**API 兼容策略**: `groupIntoSections` 签名改为 `groupIntoSections(msg: Message, standaloneTools?: Set<string>)`：
- 传入 `standaloneTools` → 走新分组逻辑（compactStreaming=true 路径）
- 不传或 `undefined` → 走原有 `groupByContentBlocks` 逻辑（compactStreaming=false 路径，行为不变）
- 这样 compactStreaming=false 的调用方无需任何改动

**调用方变更**: 仅 AssistantContent.vue（compactStreaming=true 分支）传入 standaloneTools 参数。其他调用方（如有）不受影响。

---

### T3: MergeBlock 组件

**文件**: `src-electron/renderer/src/components/chat/MergeBlock.vue`（新建）

**Props**:
```typescript
interface Props {
  blocks: ContentBlock[]          // 该 MergeBlock 包含的所有 contentBlocks
  message: Message                // 用于查找 thinking/toolCall 数据
  isStreaming: boolean            // streaming 或 complete
}
```

**Complete 状态**:
- 渲染 chip 摘要条：统计 blocks 中各类型数量，格式 `思考 ×N · read ×N · bash ×N`
- thinking chip 颜色用 `var(--accent-light)` 背景 + `var(--accent)` 文字
- tool chip 颜色用 `var(--success-light)` 背景 + `var(--success)` 文字
- 点击"过程"标签 toggle 展开/折叠
- 展开时复用现有 ThinkingBlock 和 ToolCallCard 组件

**Streaming 状态**:
- 紧凑一行（高度 28px）：脉冲圆点 + 操作描述 + 耗时
- 操作描述逻辑：
  - `message.thinking` 最后一个 block 的 `endTime === undefined` → "思考中..."
  - `message.toolCalls` 中 `status === 'running'` 的 → `${tc.toolName} ${tc.args?.file_path || ''}`
  - 都不满足 → 最新 text delta 预览（截断 60 字符）
- 耗时用 `setInterval(1000)` 更新，组件卸载时清理

**样式**: 全部用 Tailwind + CSS 变量，不用 `<style scoped>`（除非需要伪元素）

**行数预估**: <template> ~120 行, <script setup> ~100 行

**验证**: 在 Storybook 或 dev 模式中构造 mock 数据，验证 chip 统计和展开/折叠

---

### T4: StandaloneToolCard 组件

**文件**: `src-electron/renderer/src/components/chat/StandaloneToolCard.vue`（新建）

**Props**:
```typescript
interface Props {
  toolCall: ToolCall               // 具体的 toolCall 数据
  isCustomTool?: boolean           // 是否为自定义工具（非 pi 内置）
}
```

**渲染**:
- 卡片头部：工具图标 + 工具名 + 文件路径（从 args 提取）+ 状态 badge
- 修改量 badge（edit/write）：从 toolCall.result 或 args 解析 +N/-N 行数
- 可展开查看详细内容（diff 或 command output）
- 展开时复用 ToolCallCard 组件的渲染逻辑

**样式**: 与 ToolCallCard 保持一致的卡片风格

**行数预估**: <template> ~80 行, <script setup> ~60 行

**验证**: 构造 write/edit/subagent 三种 toolCall mock 数据

---

### T5: AgentRunBlock 容器组件

**文件**: `src-electron/renderer/src/components/chat/AgentRunBlock.vue`（新建）

**Props**:
```typescript
interface Props {
  message: Message
  isStreaming: boolean
}
```

**渲染结构**:
```
<div class="agent-run-block">
  <div class="run-status-bar" />       <!-- 3px 状态条 -->
  <div class="run-body">
    <!-- 按 sections 顺序渲染 -->
    <MergeBlock v-if="section.type === 'merge'" ... />
    <div v-else-if="section.type === 'text'" class="msg__body" v-html="..." />
    <StandaloneToolCard v-else-if="section.type === 'standalone'" ... />
    <StandaloneToolCard v-else-if="section.type === 'customTool'" :is-custom-tool="true" ... />
  </div>
  <div class="run-footer">             <!-- 步骤数 · 耗时 · 文件修改数 -->
  </div>
</div>
```

**Footer 逻辑**:
- 步骤数 = sections.filter(s => s.type !== 'text').length
- 文件修改数 = message.toolCalls.filter(tc => standaloneTools.has(tc.toolName)).length
- 耗时 = streaming 时用 ref + setInterval 实时更新，complete 时用 message.timestamp 差值

**验证**: 在 AssistantContent 中替换 CompactSummaryBar，确认渲染正确

---

### T6: AssistantContent.vue 集成

**文件**: `src-electron/renderer/src/components/chat/AssistantContent.vue`

**改动**:
1. import AgentRunBlock 组件
2. 修改渲染分支逻辑：
   ```vue
   <AgentRunBlock v-if="useCompact" :message="msg" :is-streaming="isStreaming" />
   <template v-else>
     <!-- 现有 section 渲染，不变 -->
   </template>
   ```
3. 移除 CompactSummaryBar 的 import 和使用（被 AgentRunBlock 替代）
4. `useCompact` 计算属性逻辑不变（读 settingsStore.compactStreaming）

**验证**: compactStreaming=true 时渲染 AgentRunBlock，false 时渲染原 section

---

### T7: ChatPanel streaming 路径统一

**文件**: `src-electron/renderer/src/components/panel/ChatPanel.vue`

**当前架构**: ChatPanel 直接渲染 streaming 消息，不经过 MessageList/AssistantContent：
```vue
<CompactStreamingBubble v-if="streamingMessage && compactStreaming" :message="streamingMessage" />
<StreamingMessage v-else-if="streamingMessage" :message="streamingMessage" />
```

**目标架构**: 移除 CompactStreamingBubble 分支。streaming 消息统一走 MessageBubble → AssistantContent → AgentRunBlock(isStreaming=true) 路径。ChatPanel 的 streaming 渲染变为：
```vue
<StreamingMessage v-if="streamingMessage" :message="streamingMessage" :is-streaming="isStreaming" />
```
StreamingMessage 内部使用 MessageBubble，MessageBubble 内部使用 AssistantContent。AssistantContent 根据 `compactStreaming` 决定渲染 AgentRunBlock 或 normal sections。compactStreaming=true 时 AgentRunBlock 接收 `isStreaming=true`，内部 MergeBlock 显示 streaming 状态。

**具体改动**:
1. 删除 `CompactStreamingBubble` 的 import 和模板中的 `v-if` 分支
2. StreamingMessage 组件保持不变（它已经走 MessageBubble → AssistantContent 路径）
3. 验证 streaming 消息通过 AssistantContent 正确渲染 AgentRunBlock

**验证**: streaming 中 AgentRunBlock 实时更新，不再出现 CompactStreamingBubble。compactStreaming=false 时 streaming 走现有 normal section 路径不受影响。

---

### T8: Settings 页面 standaloneTools UI

**文件**: Settings 对应的 Vue 组件（需确认具体文件路径，位于 `src-electron/renderer/src/components/settings/` 目录下）

**改动**:
- 在 compactStreaming 设置下方新增"独立展示工具"多选区域
- 列出 ALL_PI_TOOLS（7 个）作为 checkbox 列表
- 默认选中 write 和 edit
- v-model 绑定 settingsStore.standaloneTools
- 使用项目 UI 组件库的 Checkbox 组件（禁止原生 HTML checkbox）

**验证**: 修改 checkbox 后，立刻影响新收到的 assistant 消息的渲染分组

## 执行顺序

1. **T1** (settings store) — 无依赖，先做
2. **T2** (message-layout) — 依赖 T1 的类型定义
3. **T3** (MergeBlock) + **T4** (StandaloneToolCard) — 可并行，依赖 T2 的 section 类型
4. **T5** (AgentRunBlock 容器) — 依赖 T3 + T4
5. **T6** (AssistantContent 集成) + **T7** (ChatPanel streaming) — 依赖 T5
6. **T8** (Settings UI) — 仅依赖 T1，可与其他 task 并行

## Commit 策略

每个 Task 一个 commit，commit message 格式：
- `feat: add standaloneTools to settings store`
- `refactor: rewrite message-layout grouping for block-type classification`
- `feat: add MergeBlock component`
- `feat: add StandaloneToolCard component`
- `feat: add AgentRunBlock container component`
- `refactor: integrate AgentRunBlock into AssistantContent`
- `refactor: replace CompactStreamingBubble with AgentRunBlock streaming`
- `feat: add standaloneTools settings UI`
