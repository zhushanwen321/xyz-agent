---
verdict: pass
must_fix: 0
review_metrics:
  files_reviewed: 8
  boundaries_checked: 10
  issues_found: 4
  must_fix_count: 0
  low_count: 3
  info_count: 1
  duration_estimate: "20"
---

# Integration Review v1

## 审查记录
- 审查时间：2026-06-07 22:25
- 上游 BLR: business_logic_review_v1.md
- 模块边界点数：10
- 模拟数据验证路径数：6

## 模块关系图

```
ChatPanel
  ├─[B1]→ CompactStreamingBubble  (streaming + compact on)
  │          ├─[B5]→ MessageBubble (expanded state)
  │          │          └─→ AssistantContent (isStreaming=true → normal mode)
  │          └─[B9]→ compact-utils (formatTime, toolPath)
  ├─[B2]→ StreamingMessage        (streaming + compact off)
  └─[B3]→ MessageBubble           (completed messages)
               └─[B4]→ AssistantContent (isStreaming=undefined → compact mode)
                         ├─[B6]→ CompactSummaryBar
                         │          ├─[B7]→ ThinkingBlock (refId resolve)
                         │          ├─[B8]→ ToolCallCard  (refId resolve)
                         │          └─[B10]→ compact-utils (formatTime, toolPath)
                         └─→ normal section rendering (v-else)
```

## 边界检查矩阵

| UC | 边界点 | D1 格式转换 | D2 错误传播 | D3 契约一致 | D4 前后端 | 问题 |
|----|--------|------------|------------|------------|----------|------|
| UC-1 | B1: ChatPanel→CompactStreamingBubble | ✅ | — | ✅ | — | — |
| UC-1 | B5: CompactStreamingBubble→MessageBubble | ✅ | — | ✅ | — | — |
| UC-1 | B3: ChatPanel→MessageBubble | ✅ | — | ✅ | — | — |
| UC-1 | B4: MessageBubble→AssistantContent | ✅ | — | ✅ | — | — |
| UC-1 | B6: AssistantContent→CompactSummaryBar | ✅ | — | ⚠️ | — | 逻辑重复(INFO-1) |
| UC-1 | B7: CompactSummaryBar→ThinkingBlock | ✅ | — | ✅ | — | — |
| UC-1 | B8: CompactSummaryBar→ToolCallCard | ✅ | — | ⚠️ | — | 非空断言(LOW-1) |
| UC-1 | B9-10: compact-utils 消费 | ✅ | ✅ | ✅ | — | — |
| UC-1 | Streaming→Complete 状态转换 | ✅ | — | ✅ | — | item.expanded 重置(LOW-2) |
| UC-2 | B7: CompactSummaryBar→ThinkingBlock(resolve) | ✅ | — | ✅ | — | — |
| UC-2 | B8: CompactSummaryBar→ToolCallCard(resolve) | ✅ | — | ⚠️ | — | 同LOW-1 |

## 问题清单

| # | 严重度 | UC | 边界点 | 维度 | 描述 | 文件 | 行号 | 修改建议 |
|---|--------|-----|--------|------|------|------|------|---------|
| 1 | LOW | UC-1 | B8 | D3 | `resolveToolCall(item.refId)!` 使用 TypeScript 非空断言，无运行时防护。数据流自洽（chipData 从 `message.toolCalls` 构造，resolve 也从同一数组查找），正常路径不会 undefined，但 `!` 隐藏了潜在的数据不一致风险 | CompactSummaryBar.vue | L62 | 可改为 `v-if="resolveToolCall(item.refId)"` 包裹 ToolCallCard，或让 resolve 返回 `!` 之前加 console.warn 兜底 |
| 2 | LOW | UC-1 | B6→B9 | D3 | `onToggleAll()` 在 AssistantContent 中独立计算 chip 数量（thinking 有无 + toolName 去重计数），与 CompactSummaryBar 的 `chipData()` 分组逻辑重复。若 CompactSummaryBar 的聚合规则变更（如按 type 进一步分组），AssistantContent 的 expand-all 行为会失效 | AssistantContent.vue | L51-58 | 将 chipCount 暴露为 CompactSummaryBar 的 prop 或 provide，AssistantContent 从中读取而非重算 |
| 3 | LOW | UC-1 | B6 | D1 | `expandedGroups` 是 `reactive(new Set<number>())`，当 `message` 对象引用变化时 `chips` computed 重算，所有 `CompactChipItem.expanded` 回到 `false`（因为 `chipData()` 每次创建新对象）。已完成消息不会频繁变化，实际影响极小 | CompactSummaryBar.vue | L189 | 可将 `expanded` 状态从 item 级别提升到 `Map<refId, boolean>` 与 chips 解耦，避免重算丢失 |
| 4 | INFO | UC-1 | B6 | D3 | 空 CompactSummaryBar（无 thinking 无 toolCalls）仍渲染 bar 容器（"过程" 标签 + chevron）。功能正确但视觉冗余，可后续 UI 打磨时决定是否条件隐藏 | CompactSummaryBar.vue | L3-14 | `v-if="chips.length > 0"` 包裹整个 compact-bar，或由 AssistantContent 在传入前判断 |

## 模拟数据验证详情

### UC-1 Path 1: Streaming thinking — B1 ChatPanel→CompactStreamingBubble

**模拟数据：** `{"id":"msg-001","status":"streaming","thinking":[{"id":"th-1","content":"让我分析一下...","collapsed":false,"startTime":1749300000000}]}`
**调用方传递：** `:message="streamingMessage"` — 类型 `Message | null`，由 `v-if` 保证非 null
**被调用方期望：** `message: Message`
**结论：** ✅ 匹配。`statusText` 检查 `thinking[thinking.length-1].collapsed === false` → "思考中..."

### UC-1 Path 2: Streaming toolCall — B9 compact-utils

**模拟数据：** `{"toolName":"read","input":{"path":"/src/main.ts"},"status":"running"}`
**调用方传递：** `toolPath(runningTc.input, 50)` — input 为 `{path: "/src/main.ts"}`
**被调用方期望：** `input: unknown`
**结论：** ✅ 匹配。`toolPath` 检查 `obj.path` → `"/src/main.ts"` → 返回 `read /src/main.ts`

### UC-1 Path 3: Streaming→Complete — B1→B3→B4→B6 全链路

**模拟数据：** `{"id":"msg-003","status":"streaming→complete","thinking":[{"id":"th-3","collapsed":true}],"toolCalls":[{"id":"tc-3a","toolName":"read"},{"id":"tc-3b","toolName":"read"}]}`
**状态转换验证：**
1. `message.status` 变为 `"complete"` → CompactStreamingBubble watch 触发 → `expanded = false` ✅
2. `streamingMessage` 变为 null → CompactStreamingBubble 卸载 ✅
3. 消息进入 `messages` 数组 → ChatPanel 渲染 `<MessageBubble :message="msg" />` — **注意：isStreaming 未传递**
4. MessageBubble: `isStreaming` 默认 `undefined` → 传给 AssistantContent
5. AssistantContent: `useCompact(true) && !isStreaming(!undefined → true)` → compact mode ✅
6. CompactSummaryBar: `chipData()` 生成 `[thinking chip, read chip(count=2)]` ✅

**结论：** ✅ 全链路正确。`isStreaming` 从 ChatPanel → MessageBubble → AssistantContent 的隐式 `undefined` 传播是正确的（completed 消息不需要 streaming 标志）。

### UC-1 Path 4: 操作行展开 — B7/B8 CompactSummaryBar→ThinkingBlock/ToolCallCard

**ThinkingBlock 边界：**
**模拟数据：** `{"id":"th-4","content":"深度思考内容...","startTime":100,"endTime":500}`
**调用方传递：** `:text="resolveThinkingText('th-4')" :start-time="resolveThinking('th-4')?.startTime" :end-time="resolveThinking('th-4')?.endTime"` — 注意 `streaming` 未传递
**被调用方期望：** `text: string, streaming?: boolean, startTime?: number, endTime?: number`
**结论：** ✅ 匹配。`streaming` 为 optional prop，默认 `undefined` → falsy → 不启动定时器，不显示脉冲动画。`elapsedMs` 使用 `startTime=100, endTime=500` → 400ms → "0.4s" 显示正确。

**ToolCallCard 边界：**
**模拟数据：** `{"id":"tc-4","toolName":"bash","input":{"command":"npm test"},"status":"completed"}`
**调用方传递：** `:tool-call="resolveToolCall('tc-4')!"` — TypeScript 非空断言
**被调用方期望：** `toolCall: ToolCall`（推测为 required prop）
**结论：** ⚠️ 数据自洽时正确（refId 源自 `message.toolCalls`，resolve 也查同一数组）。但 `!` 断言无运行时防护，若 message 对象被外部 mutate 导致 toolCalls 数组变化，可能传入 undefined。实际风险极低。记录为 LOW-1。

### UC-1 Path 5: Overflow 12 read — B6 CompactSummaryBar 内部

**模拟数据：** 16 个 toolCalls（12 read + edit + bash + grep + write），1 thinking → 6 chips
**验证：**
- `visibleChips`: 6 > MAX_VISIBLE_CHIPS(4) && !chipOverflowExpanded → `slice(0,4)` → [thinking, read, edit, bash] ✅
- `chipOverflowCount`: 6 - 4 = 2 → "+2 more" ✅
- read chip: `overflow = max(0, 12-8) = 4` → `visibleItems` slice(0,8) → "还有 4 个" ✅
- `expanded` Set index：overflow 展开后 visibleChips 变为全部 6 个，已有 index 0-3 仍对应相同 chip（chips 数组顺序不变）✅

### UC-1 Path 6: 空消息 — B6 AssistantContent→CompactSummaryBar

**模拟数据：** `{"thinking":[],"toolCalls":[],"content":"你好！有什么可以帮助你的？"}`
**验证：** `chipData()` → 空数组 → `visibleChips = []` → 无 chip 渲染 → bar 容器仍显示（"过程" + chevron）
**结论：** ✅ 功能正确。空 bar 视觉冗余记录为 INFO-4。

## 关键边界深度分析

### B5: CompactStreamingBubble→MessageBubble（展开 streaming 消息）

CompactStreamingBubble 展开时：
```html
<MessageBubble :message="message" :is-streaming="true" />
```

MessageBubble 对 assistant 消息委托给 AssistantContent：
```html
<AssistantContent :message="message" :is-streaming="isStreaming" />
```

AssistantContent 的分支逻辑：
```
useCompact(true) && !isStreaming(true) → false → 走 v-else-if="sections.length" → 正常 section 渲染
```

**结论：** ✅ 展开的 streaming 消息使用正常 section 模式（ThinkingBlock + ToolCallCard + text），不是 compact 模式。这是正确的——用户主动展开时应看到完整内容。

### B6: AssistantContent→CompactSummaryBar 的 expanded Set 跨组件共享

`expandedGroups` 是 `reactive(new Set<number>())`，作为 prop 传入 CompactSummaryBar。

Vue 3 的 `reactive()` 对 Set 创建 Proxy，保持 `has/add/delete/clear` 方法的响应性。CompactSummaryBar 模板中 `expanded.has(ci)` 能正确触发依赖追踪。

事件流：
1. 用户点击 chip → CompactSummaryBar emit `toggle-group(ci)`
2. AssistantContent `onToggleGroup(ci)` → `expandedGroups.add(ci)` 或 `.delete(ci)`
3. `expandedGroups` 变化 → CompactSummaryBar 响应式更新 → `v-show="expanded.has(ci)"` 切换

**结论：** ✅ reactive Set 跨组件传递和事件驱动更新均正确。

## 结论

**通过。** 10 个模块边界点逐一验证，无 MUST_FIX 问题。核心数据流（streaming → complete → compact 展开 → 操作行 resolve → ThinkingBlock/ToolCallCard 复用）在所有 6 条模拟路径上正确传递。`refId` 机制正确桥接 CompactSummaryBar 的聚合数据与原始 Message 对象。`isStreaming` 的隐式 undefined 传播（ChatPanel 不传 → MessageBubble 默认 → AssistantContent 判断）语义正确。3 条 LOW 为防御性建议，1 条 INFO 为视觉打磨项。
