# TypeScript 品味审查 v1

**审查范围**: 6 个文件，消息布局分组 + AgentRunBlock 紧凑模式 + Settings store
**审查维度**: 职责单一性、命名、prop 设计、DRY、条件逻辑、组件拆分

---

## 总体评价

核心架构方向正确：纯函数布局逻辑 (`message-layout.ts`) 与 Vue 组件分离、紧凑/普通双模式通过 store flag 切换。但存在**显著的跨组件代码重复**和若干命名/设计问题，需要处理后再合并。

---

## 1. 重复代码（DRY）— 最严重的问题

### 1.1 Timer 模式复制粘贴 5 次

`ref(Date.now()) + setInterval + onBeforeUnmount 清理` 模式在以下 5 个文件中各自独立实现：

| 文件 | 常量名 | 间隔(ms) |
|------|--------|----------|
| `AgentRunBlock.vue` | `TIMER_INTERVAL_MS` | 200 |
| `MergeBlock.vue` | `TIMER_INTERVAL_MS` | 200 |
| `StandaloneToolCard.vue` | `TIMER_UPDATE_INTERVAL_MS` | 100 |
| `ThinkingBlock.vue` | `DECISECOND_MS` | 100 |
| `ToolCallCard.vue` | `TIMER_UPDATE_INTERVAL_MS` | 100 |

**建议**: 抽取 `useLiveTimer(intervalMs)` composable，返回 `{ now, start, stop }`。各组件按需调用，消除重复的 start/stop/lifecycle 逻辑。

### 1.2 `resolveToolCall` / `resolveThinkingContent` / `resolveThinking` 重复 3 次

| 函数 | AgentRunBlock | MergeBlock | AssistantContent |
|------|:---:|:---:|:---:|
| `resolveToolCall(refId)` | ✓ | ✓ | ✓ |
| `resolveThinking(refId)` | — | ✓ | ✓ |
| `resolveThinkingContent(refId)` | — | ✓ | ✓ |

三个组件内部各自 `Array.find` 遍历同一个 `message.toolCalls` / `message.thinking`。

**建议**: 抽取 `useMessageResolvers(message)` composable，或直接在 `message-layout.ts` 的 `AssistantSection` 中预解析好数据（section 的 `blocks` 携带 resolved 对象），让组件直接读，不需要运行时 `find`。

### 1.3 Markdown 文本渲染模板复制 3 次

完全相同的 HTML 结构在 `AgentRunBlock.vue`、`AssistantContent.vue`（文本 section）、`AssistantContent.vue`（fallback）中重复出现：

```html
<div class="msg__body select-text py-1 leading-[1.6] text-fg text-xs"
     :data-message-id="..." :data-markdown-source="..." @click="handleBodyClick">
  <span v-html="renderedContent" />
  <span v-if="isStreaming" class="inline-block w-0.5 h-[1.1em] bg-accent rounded-sm
    align-text-bottom animate-blink motion-reduce:opacity-60 motion-reduce:animate-none" />
</div>
```

同时 `useMarkdownRender` + `useMarkdownBodyClick` 在两个组件中各自实例化。

**建议**: 抽取 `<MessageBody>` 组件，props: `{ message, isStreaming }`，封装 markdown 渲染 + 事件委托 + cursor 动画。

---

## 2. 函数职责与命名

### 2.1 `isMergeBlock` — 参数耦合过紧

```ts
function isMergeBlock(block: ContentBlock, msg: Message, standaloneTools: Set<string>): boolean
```

函数需要 `msg` 仅仅是为了 `msg.toolCalls?.find(t => t.id === block.refId)` 做一次交叉查询。调用者已有 message，但函数签名暗示它需要整个 message 上下文，职责边界模糊。

**建议**: 让调用者先解析 toolCall，传 `(block: ContentBlock, toolCall: ToolCall | undefined, standaloneTools: Set<string>)`，或直接在 `groupByContentBlocks` 内联判断（该函数本来就有 `msg` 参数）。

### 2.2 `groupByContentBlocksLegacy` — 命名误导

"Legacy" 暗示"待废弃的旧路径"，但实际上它是 `standaloneTools` 配置不存在时的分组逻辑。与 `groupByContentBlocks` 的区别不是"新旧"而是"有无 standaloneTools 配置"。

**建议**: 重命名为 `groupByContentBlocksWithoutStandalone` 或 `groupByContentBlocksUnified`（因为所有 block 统一按 type 合并）。

### 2.3 `fileEditCount` — 命名与实现不匹配

`AgentRunBlock.vue` 的 `fileEditCount` 实际统计的是 standalone tool 的数量：

```ts
const fileEditCount = computed(() => {
  const standalone = standaloneToolsSet.value
  return tcs.filter(tc => standalone.has(tc.toolName)).length
})
```

但 `standaloneTools` 不一定全是文件编辑工具（未来可能包含 `grep` 等），且文件编辑工具不一定都在 standaloneTools 里。

**建议**: 重命名为 `standaloneToolCount`，footer 文案改为 `N 个独立工具` 或保持动态映射。

### 2.4 `stepCount` — 语义模糊

```ts
const stepCount = computed(() => sections.value.filter(s => s.type !== 'text').length)
```

"步"是什么？filter 条件是"非文本 section"，但 thinking + merge + standalone + customTool 都算"步"。读者无法从名字理解计数逻辑。

**建议**: 加注释说明什么算一步，或重命名为 `nonTextSectionCount`（如果不需要对外展示的话）。

---

## 3. 组件 Prop 设计

### 3.1 `StandaloneToolCard.isCustomTool` — 死 prop

```ts
const props = withDefaults(defineProps<{
  toolCall: ToolCall
  isCustomTool?: boolean
}>(), { isCustomTool: false })
```

`isCustomTool` 在组件内未被使用——不参与渲染、不影响样式、不参与逻辑。`AgentRunBlock.vue` 中区分 `standalone` 和 `customTool` section type 的逻辑在分组层已完成，card 本身不需要知道。

**建议**: 删除 `isCustomTool` prop。如果未来 custom tool 需要不同样式，在 `StandaloneToolCard` 内部通过 `toolCall.toolName` 判断，不需要外部传入布尔值。

### 3.2 `AgentRunBlock` template 中 `!` 非空断言

```html
:tool-call="resolveToolCall(section.blocks[0].refId)!"
```

`resolveToolCall` 返回 `ToolCall | undefined`，模板中用 `!` 强制断言。虽然外层 `v-else-if="section.type === 'standalone'"` 保证了 `blocks[0]` 存在，但 `refId` 对应的 `toolCall` 不存在时 `!` 会运行时 crash。

**建议**: 改为 `v-if` 守卫：
```html
<StandaloneToolCard
  v-if="resolveToolCall(section.blocks[0].refId)"
  :tool-call="resolveToolCall(section.blocks[0].refId)!"
/>
```
或预解析到 section 对象中消除运行时查找。

---

## 4. 条件逻辑清晰度

### 4.1 `isMergeBlock` 双重否定

```ts
return tc
  ? (ALL_PI_TOOLS as readonly string[]).includes(tc.toolName) && !standaloneTools.has(tc.toolName)
  : false
```

"是内置工具 AND 不在 standalone 集合中" → 逻辑正确但阅读成本高。`!standaloneTools.has` 是否定条件。

**建议**: 提取为命名函数或变量：
```ts
const isBuiltinMergeable = (toolName: string) =>
  ALL_PI_TOOLS.includes(toolName) && !standaloneTools.has(toolName)
```

### 4.2 `MergeBlock.streamStatusText` — 三层 fallback

```ts
const streamStatusText = computed(() => {
  // 1. last thinking running?
  // 2. any tool running?
  // 3. fallback: text preview
})
```

逻辑本身清晰，但嵌套在 computed 内的可读性一般。考虑提取为独立函数 `getStreamStatusText(msg)` 以便单测。

### 4.3 `groupByContentBlocks` 的 `hasText` flag

用 mutable boolean flag 做"去重只保留第一个 text block"：

```ts
let hasText = false
// ...
if (!msg.content || hasText) continue
hasText = true
```

可读性尚可但不够声明式。如果要表达"最多一个 text section"，filter + takeFirst 模式更直观。

---

## 5. 组件拆分合理性

### 5.1 `AgentRunBlock` 职责偏重

`AgentRunBlock` 同时承担：
- Section 渲染编排（template 中的 v-for + v-if）
- Markdown 渲染（`useMarkdownRender`）
- Footer 统计（stepCount、fileEditCount、elapsedMs）
- 实时计时器
- ToolCall 解析

其中 markdown 渲染 + 文本展示应委托给子组件（见 1.3 建议），footer 统计可以提取为 `useRunStats(message, sections)` composable。

### 5.2 `MergeBlock` 双模式切换合理

streaming / complete 的 template 分支用 `v-if / v-else` 切换，干净利落。`ChipInfo` 类型定义在组件内部合理（不对外暴露）。

### 5.3 `AssistantContent` 作为编排组件合理

它做三件事：选择 compact/normal 模式、分组 sections、委托渲染。职责清晰，不需要进一步拆分。但 DRY 问题（1.2、1.3）需要解决。

---

## 6. Settings Store

### 6.1 `standaloneTools` 默认值与 `ALL_PI_TOOLS` 隐式耦合

```ts
// settings.ts
const standaloneTools = ref<string[]>(['write', 'edit'])

// message-layout.ts
export const ALL_PI_TOOLS = ['read', 'bash', 'edit', 'write', 'grep', 'find', 'ls'] as const
```

默认值 `['write', 'edit']` 是 `ALL_PI_TOOLS` 的子集，但没有任何类型约束保证这一点。如果 pi 侧工具名变更，默认值静默失效。

**建议**: 从 `ALL_PI_TOOLS` 导出默认子集：
```ts
export const DEFAULT_STANDALONE_TOOLS: readonly string[] = ['write', 'edit']
```

### 6.2 `compactStreaming` 命名模糊

"Compact" 修饰的是"streaming mode 下的消息显示方式"，但名字读起来像"压缩流"。

**建议**: 考虑 `agentRunBlockMode` 或 `compactMessageLayout` 更明确。这个是 low priority，当前命名在上下文中可以理解。

---

## 7. 其他细节

### 7.1 `toolPath` 截断硬编码

`StandaloneToolCard.vue`:
```ts
return raw.length > 50 ? raw.slice(0, 50) + '...' : raw
```

`MergeBlock.vue` 的 `TEXT_PREVIEW_MAX = 60`。

截断长度不一致（50 vs 60），且都是 magic number。

**建议**: 统一为一个常量 `PATH_DISPLAY_MAX_LEN = 50`，放在 `compact-utils.ts`。

### 7.2 `elapsedMs` 中 `Math.min(...allTimes)` 对大数组的性能

```ts
return Math.max(...endTimes) - Math.min(...startTimes)
```

spread operator 对大数组有栈溢出风险。实际场景中 thinking + toolCalls 不会超过几十个，但用 `reduce` 写法更安全：
```ts
const minStart = startTimes.reduce((a, b) => Math.min(a, b), Infinity)
```

Low priority，实际不会触发问题。

---

## 总结

| 类别 | 等级 | 说明 |
|------|------|------|
| Timer 重复 5 次 | **Must Fix** | 抽取 `useLiveTimer` composable |
| `resolveToolCall` 等 重复 3 次 | **Must Fix** | 抽取 composable 或在 section 中预解析 |
| Markdown 文本模板 重复 3 次 | **Must Fix** | 抽取 `<MessageBody>` 组件 |
| `isCustomTool` 死 prop | **Must Fix** | 删除未使用的 prop |
| template `!` 非空断言 | **Should Fix** | 改为 v-if 守卫 |
| `fileEditCount` 命名 | **Should Fix** | 与实际计数逻辑不符 |
| `groupByContentBlocksLegacy` 命名 | **Should Fix** | "legacy" 含义误导 |
| `isMergeBlock` 参数耦合 | **Nice to Have** | 可改进但不阻塞 |
| `standaloneTools` 默认值耦合 | **Nice to Have** | 类型约束加强 |
| 截断长度不一致 | **Nice to Have** | 统一常量 |

---

```yaml
verdict: conditional_pass
must_fix:
  - 抽取 useLiveTimer composable，消除 5 处 timer 重复
  - 抽取 resolveToolCall/resolveThinking 等 resolver 为共享 composable 或预解析到 section
  - 抽取 MessageBody 组件，消除 3 处 markdown 渲染模板重复
  - 删除 StandaloneToolCard 的 isCustomTool 死 prop
  - AgentRunBlock 模板中 resolveToolCall 的 ! 非空断言改为 v-if 守卫
  - fileEditCount 重命名为 standaloneToolCount（或调整 footer 文案匹配实际语义）
```
