---
verdict: pass
---

# AgentRunBlock 重构：折叠 Agent 操作过程

## Background

xyz-agent 前端将 pi 的整个 Agent Run 映射为一个 streaming Message，内部包含 thinking、toolCall、text 三类 contentBlock。当前渲染方式按相邻同类型分 section（每段 thinking 一组、每段 toolCall 一组），导致一次 Agent Run 可能产生 5-8 个独立 section，用户需要逐个浏览才能找到关心的信息（文件修改和最终结论）。

用户的核心需求：**只关心修改了哪些文件、最终结论是什么**，过程中的 thinking/read/edit/bash 等操作可以折叠隐藏。

## Functional Requirements

### FR-1: AgentRunBlock 容器

**仅在 `compactStreaming=true` 时激活。** `compactStreaming=false` 时走现有 `groupByContentBlocks` section 渲染路径，不做任何改动。

AgentRunBlock 替代现有的 CompactSummaryBar（已完成消息）和 CompactStreamingBubble（streaming 消息）两个组件。AssistantContent.vue 的渲染分支变为：
- `compactStreaming=true && !isStreaming` → AgentRunBlock（complete 状态）
- `compactStreaming=true && isStreaming` → AgentRunBlock（streaming 状态，含实时 MergeBlock）
- `compactStreaming=false` → 现有 normal section 模式（不变）

容器结构：
- 顶部 3px 状态条：streaming 时扫光动画（复用现有 GlobalLoadingBar 样式），complete 时变为静默背景色
- 底部 footer 显示摘要（定义见下方）
- 容器内从上往下按顺序渲染 MergeBlock 和独立 ContentBlock

**Footer 字段定义：**
- **步骤数** = MergeBlock 数量 + 独立 ContentBlock 数量（不含 text block），反映用户可见的操作段数
- **总耗时** = 当前时间（streaming）或 message.timestamp 到 status 变为 complete 的间隔
- **文件修改数** = toolCalls 中 toolName 在 `standaloneTools` 集合内的总数

### FR-2: ContentBlock 分类渲染

AgentRunBlock 内部按到达顺序（contentBlocks 顺序）逐个渲染每个 block，根据类型和用户设置决定渲染方式：

**始终独立渲染：**
- `text`：直接渲染 markdown 内容（复用现有 msg__body 渲染）
- `toolCall` 且 toolName 不属于 pi 内置 7 种工具（即扩展注册的自定义工具如 `subagent`、`code-analysis`）：渲染为独立操作卡片

**按用户设置决定（`standaloneTools` 设置项）：**
- `toolCall`：toolName 在 `standaloneTools` 集合中 → 独立渲染为文件修改/操作卡片（显示文件路径 + 修改量 badge + 可展开详情）
- `toolCall`：toolName 不在 `standaloneTools` 中 → 合并到 MergeBlock
- `thinking`：始终合并到 MergeBlock（不可配置）

**`standaloneTools` 默认值：** `['write', 'edit']`

### FR-2.1: 独立展示工具设置（Settings）

在 Settings 页面增加设置项，允许用户配置哪些工具在 AgentRunBlock 中独立展示。

**设置位置：** Settings → 对话偏好（或现有 compactStreaming 设置所在区域）

**UI 形式：** 多选 checkbox 列表，列出所有 pi 内置工具名：
- ☑ write
- ☑ edit
- ☐ read
- ☐ bash
- ☐ grep
- ☐ find
- ☐ ls

**数据存储：** 存入 settings store 的 `standaloneTools: string[]` 字段，持久化到 `~/.xyz-agent/config.json`

**默认值：** `['write', 'edit']`

### FR-3: MergeBlock 折叠渲染

连续的合并类 block 归入同一个 MergeBlock。遇到独立类 block 时切断，下一个合并类 block 开始新的 MergeBlock。

**Streaming 状态：**
- 显示为紧凑的一行滚动条（高度约 28px），包含脉冲圆点 + 当前操作描述 + 耗时
- 操作描述按当前最新的活跃操作更新（thinking 时显示"思考中..."，tool running 时显示"read src/main.ts"）

**Complete 状态：**
- 显示为 chip 摘要条，格式：`思考 ×3 · read ×5 · grep ×2`
- 每个 chip 使用项目 CSS 变量着色（thinking 用 `--accent` 系，tool 用 `--success` 系）
- 点击展开显示内部每个操作的细节（复用现有 ThinkingBlock 和 ToolCallCard 组件）
- 支持"全部展开/折叠"：点击 chip 条左侧的"过程"标签（延续现有 CompactSummaryBar 的 toggle-all 交互）

### FR-4: 分组规则实现

分组逻辑在 `message-layout.ts` 的 `groupIntoSections` 函数中实现：

1. 遍历 contentBlocks，维护当前分组状态
2. 遇到合并类 block → 追加到当前 MergeBlock group
3. 遇到独立类 block → 关闭当前 MergeBlock group（如有），创建独立 section
4. 分组结果的新 section 类型：
   - `merge`：包含连续的 thinking + 普通 toolCall blocks
   - `text`：文本 block（不变）
   - `write`：write toolCall block（独立）
   - `customTool`：自定义工具 toolCall block（独立）

工具分类判断：从 settings store 读取 `standaloneTools` 集合，运行时判断

```typescript
// 所有 pi 内置工具名（用于 Settings UI 的 checkbox 列表）
const ALL_PI_TOOLS = ['read', 'bash', 'edit', 'write', 'grep', 'find', 'ls'] as const

function isMergeBlock(block: ContentBlock, msg: Message, standaloneTools: Set<string>): boolean {
  if (block.type === 'thinking') return true
  if (block.type === 'toolCall') {
    const tc = msg.toolCalls?.find(t => t.id === block.refId)
    // 不在 standaloneTools 中的内置工具 → 合并；自定义工具 → 始终独立
    return tc ? ALL_PI_TOOLS.includes(tc.toolName as any) && !standaloneTools.has(tc.toolName) : false
  }
  return false
}
```

### FR-5: Streaming 状态的 MergeBlock

Streaming 过程中，MergeBlock 需要实时更新显示内容：

- 从 `message.thinking` 的最后一个 block 判断是否在 thinking：`endTime === undefined` 表示仍在 thinking（`endTime` 是业务时间戳，语义明确）
- 从 `message.toolCalls` 中找 `status === 'running'` 的 toolCall 显示当前操作
- 耗时用定时器实时更新
- 两个条件都不满足时，显示最新 text delta 的预览（截断到 60 字符）

### FR-6: 历史消息兼容

- 无 contentBlocks 的历史消息（legacy）：走现有的 `groupByLegacyFields` 逻辑不变
- 有 contentBlocks 的消息：走新的分组逻辑
- 此功能仅影响 assistant 消息的渲染，不影响 user/system 消息

## Acceptance Criteria

### AC-1: AgentRunBlock 容器渲染
- assistant 消息整体包裹在 AgentRunBlock 容器中
- streaming 时顶部状态条有扫光动画
- complete 时顶部状态条为静默背景色
- footer 显示步骤数和总耗时

### AC-2: ContentBlock 独立渲染
- text block 直接渲染 markdown
- write toolCall 显示为独立卡片（如果在 standaloneTools 中），包含文件路径、修改量 badge
- 自定义工具 toolCall 显示为独立卡片

### AC-3: MergeBlock 折叠
- 连续的 thinking + 内置 toolCall 合并为一个 MergeBlock
- complete 后 chip 条显示 `思考 ×N · toolName ×N` 格式
- 点击 chip 条可展开查看内部 ThinkingBlock 和 ToolCallCard 细节
- 再次点击可折叠

### AC-4: MergeBlock Streaming
- streaming 中 MergeBlock 显示为一行紧凑的实时状态
- thinking 时显示"思考中..."
- tool running 时显示 `toolName path`
- 有实时耗时更新

### AC-5: 分组正确性

符号表：T=thinking, tc=toolCall(合并类), S=standalone tool, O=text
默认 standaloneTools=['write','edit']

- `T tc tc O T tc T tc O` 时序分组为：
  - MergeBlock: [thk, tc-read, tc-bash]
  - TextBlock: text
  - MergeBlock: [thk, tc-read, thk, tc-grep]
- `T O S O` 时序（edit 独立展示）分组为：
  - MergeBlock: [thk]
  - TextBlock: text
  - StandaloneBlock: edit
  - TextBlock: text
- `T tc S T tc O customTool O` 时序（混合场景）分组为：
  - MergeBlock: [thk, tc-read]
  - StandaloneBlock: write
  - MergeBlock: [thk, tc-bash]
  - TextBlock: text
  - CustomToolBlock: subagent
  - TextBlock: text
- 用户将 `bash` 加入 standaloneTools 后，bash 从 MergeBlock 移出变为独立 StandaloneBlock

### AC-6: 主题兼容
- 所有颜色使用项目 CSS 变量（`--accent`、`--success`、`--muted` 等）
- light/dark/dim 三种主题下均可正常显示
- 不新增 CSS 变量

### AC-7: 旧消息兼容
- 无 contentBlocks 的历史 assistant 消息仍走现有渲染逻辑
- 不影响 user/system 消息渲染

### AC-8: Settings standaloneTools 配置
- Settings 页面显示多选 checkbox 列表，列出 7 种 pi 内置工具
- 默认选中 write 和 edit
- 修改后立即生效，影响后续所有 assistant 消息的渲染分组
- 配置持久化到 `~/.xyz-agent/config.json`，重启后保留

## Constraints

1. **不改动共享类型**：`shared/src/message.ts` 的 Message、ContentBlock 类型不变。分组逻辑完全在前端渲染层实现
2. **不改动 EventAdapter**：不转发 turn_start/turn_end，不修改 WS 协议
3. **不改动 useChat.ts**：contentBlocks 的构建逻辑不变，流式消息的构建方式不变
4. **复用现有组件**：ThinkingBlock、ToolCallCard 直接在 MergeBlock 展开时复用
5. **CSS 变量复用**：不新增 CSS 变量，所有颜色/圆角/字体使用项目现有 tokens
6. **compactStreaming 开关**：AgentRunBlock 仅在 compactStreaming=true 时激活。false 时完全走现有路径（CompactStreamingBubble + CompactSummaryBar + normal section），不受影响
7. **设置存储**：`standaloneTools` 通过 settings store 持久化，分组逻辑运行时读取，不硬编码工具分类

## 业务用例

### UC-1: 用户查看 Agent 执行结果
- **Actor**: 开发者
- **场景**: Agent 完成一次文件修改任务
- **预期结果**: 用户看到 write 卡片（文件名+修改量）和最终文字结论。过程中的 thinking/read/edit 自动折叠为 chip 条，不占视觉空间。用户点击 chip 条可展开查看细节

### UC-2: 用户监控 Agent 执行过程
- **Actor**: 开发者
- **场景**: Agent 正在执行复杂任务，用户想了解当前进度
- **预期结果**: MergeBlock 实时显示当前操作（"read src/auth.ts · 2.3s"），write 卡片按到达顺序逐个出现。用户不需要展开就能知道 Agent 在做什么

### UC-3: 含 subagent 的任务执行
- **Actor**: 开发者
- **场景**: Agent 调用 subagent 执行子任务
- **预期结果**: subagent 调用显示为独立卡片（工具名+任务描述+状态），不被合并到 MergeBlock 中。用户可以展开查看子任务的执行结果

## Complexity Assessment

**中等复杂度**。核心改动集中在以下文件：
- `message-layout.ts`：分组逻辑重写（约 60 行）
- `AssistantContent.vue`：渲染逻辑重构（新增 merge/standalone section 类型）
- `MergeBlock.vue`（新组件）：MergeBlock 折叠/展开渲染
- `StandaloneToolCard.vue`（新组件）：write/edit 等独立工具卡片
- `stores/settings.ts`：新增 `standaloneTools` 字段
- Settings 页面：新增多选 checkbox UI

不改共享类型、不改 WS 协议、不改 useChat，影响面可控。
