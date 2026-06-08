---
verdict: fail
must_fix: 3
review_metrics:
  ucs_total: 4
  ucs_pass: 2
  ucs_partial: 2
  ucs_fail: 0
  alt_paths_covered: 6/8
  must_fix_count: 3
  suggest_fix_count: 2
  files_reviewed: 8
  lines_reviewed: 730
---

# Business Logic Review — AgentRunBlock 重构

**Reviewer**: BLR Agent (dev mode)
**Date**: 2026-06-08
**Commit**: HEAD (vs HEAD~1)
**Files reviewed**: 8 files, ~730 lines changed

---

## 总览

| 维度 | 评估 |
|------|------|
| Verdict | **fail** |
| Must-fix | 3 |
| Suggest-fix | 2 |

---

## UC-1: 用户查看 Agent 执行结果

**覆盖状态: PASS (主流程) / PARTIAL (替代路径)**

### 主流程覆盖

| 步骤 | 描述 | 覆盖情况 | 代码位置 |
|------|------|---------|---------|
| 1 | 用户打开聊天界面，查看 assistant 消息 | ✅ | `AssistantContent.vue` L7-10: `useCompact` 为 true 时渲染 AgentRunBlock |
| 2 | 看到 write/edit 卡片，显示文件路径和修改量 | ✅ | `AgentRunBlock.vue` L40-43: standalone section → StandaloneToolCard |
| 3 | 看到最终文字结论 | ✅ | `AgentRunBlock.vue` L27-38: text section 渲染 markdown |
| 4 | thinking/read/grep 折叠为 chip 条 | ✅ | `MergeBlock.vue` L29-35: chips 统计 `思考 ×N · toolName ×N` |
| 5 | 点击"过程"标签展开细节 | ✅ | `MergeBlock.vue` L26: `@click="toggleExpand"` |
| 6 | 再次点击折叠 | ✅ | `MergeBlock.vue` L100: `expanded.value = !expanded.value` |

### 替代路径覆盖

| 路径 | 覆盖情况 | 说明 |
|------|---------|------|
| Agent 未修改文件（无 StandaloneToolCard） | ✅ | groupByContentBlocks 中无 standalone section 时，只生成 merge + text |
| Agent 只修改了一个文件 | ✅ | 单个 standalone section |

---

## UC-2: 用户监控 Agent 执行过程

**覆盖状态: PASS (主流程) / PARTIAL (替代路径)**

### 主流程覆盖

| 步骤 | 描述 | 覆盖情况 | 代码位置 |
|------|------|---------|---------|
| 1 | 用户发送消息后观察 assistant 区域 | ✅ | `ChatPanel.vue` L87-89: streaming 消息统一走 StreamingMessage |
| 2 | MergeBlock 显示 "思考中..." | ✅ | `MergeBlock.vue` L131-135: `lastThinking.endTime === undefined` → "思考中..." |
| 3 | Agent 切换到 read，更新为 "read src/auth.ts" | ✅ | `MergeBlock.vue` L138-142: `status === 'running'` → `${toolName} ${path}` |
| 4 | Agent 执行 write，write 卡片出现 | ✅ | AgentRunBlock sections 实时计算，write 为 standalone section |
| 5 | 新 MergeBlock 出现 | ✅ | groupByContentBlocks 遇到 standalone 切断 merge |
| 6 | 耗时实时更新 | ✅ | `AgentRunBlock.vue` L141-148: `setInterval(200ms)` + `MergeBlock.vue` L119-122 |

### 替代路径覆盖

| 路径 | 覆盖情况 | 说明 |
|------|---------|------|
| Agent 长时间 thinking，递增耗时 | ✅ | MergeBlock `now` ref + `formatTime(ms)` 实时更新 |
| 多个 toolCall 并发，显示最新 running | ✅ | `Array.find(tc => tc.status === 'running')` 取第一个 |

### Must-fix #1: CompactStreamingBubble 删除但 streaming 路径未验证

**问题**: `ChatPanel.vue` 移除了 `CompactStreamingBubble` 分支（diff -4 行），改为统一走 `StreamingMessage`。但 `StreamingMessage` → `MessageBubble` → `AssistantContent` 这条链路中，`AssistantContent` 的 `isStreaming` prop 是从 `MessageBubble` 传入的。需要确认 `StreamingMessage` 组件是否正确传递了 `isStreaming` prop 到 `MessageBubble` → `AssistantContent`。

**严重性**: 如果 streaming 路径中 `isStreaming` 未正确传入，AgentRunBlock 会以 complete 状态渲染（无扫光、MergeBlock 显示 chip 而非实时状态），UC-2 完全失效。

**建议**: 验证 `StreamingMessage.vue` → `MessageBubble.vue` → `AssistantContent.vue` 的 `isStreaming` prop 传递链路。当前 diff 未包含 `StreamingMessage.vue` 和 `MessageBubble.vue` 的改动，意味着依赖已有 prop 传递。如果这两个组件之前已正确传递 `isStreaming`，则无问题。

---

## UC-3: 含 subagent 的任务执行

**覆盖状态: PASS**

### 主流程覆盖

| 步骤 | 描述 | 覆盖情况 | 代码位置 |
|------|------|---------|---------|
| 1 | Agent 执行过程中调用 subagent | ✅ | contentBlock 为 toolCall，toolName 不在 ALL_PI_TOOLS 中 |
| 2 | subagent 显示为独立 CustomToolBlock 卡片 | ✅ | `message-layout.ts` L121: `isCustom ? 'customTool' : 'standalone'` |
| 3 | 卡片显示状态 running → complete | ✅ | `StandaloneToolCard.vue` L8: `toolCall.status` 驱动 badge/颜色 |
| 4 | 用户点击展开查看执行结果 | ✅ | `StandaloneToolCard.vue` L5: `@click="expanded = !expanded"` |
| 5 | Agent 继续后续操作 | ✅ | groupByContentBlocks 按 contentBlocks 顺序逐个处理 |

### 替代路径覆盖

| 路径 | 覆盖情况 | 说明 |
|------|---------|------|
| subagent 执行失败 | ✅ | StandaloneToolCard `--error` 状态样式 |
| 多个 subagent 独立展示 | ✅ | 每个 customTool 类型 section 独立渲染 |

---

## UC-4: 用户配置独立展示工具

**覆盖状态: PASS (主流程) / PARTIAL (替代路径)**

### 主流程覆盖

| 步骤 | 描述 | 覆盖情况 | 代码位置 |
|------|------|---------|---------|
| 1 | 导航到"聊天显示"设置区域 | ✅ | `SystemPane.vue` L133+: "聊天显示" section |
| 2 | 看到"独立展示工具"多选列表，7 个工具 | ✅ | `SystemPane.vue` L152-161: `v-for="tool in ALL_PI_TOOLS"` |
| 3 | 默认 write 和 edit 已选中 | ✅ | `settings.ts` L19: `standaloneTools = ref<string[]>(['write', 'edit'])` |
| 4 | 用户勾选 bash | ✅ | `toggleStandaloneTool()` 更新 settings store |
| 5 | 返回聊天，bash 显示为独立卡片 | ✅ | `message-layout.ts` `isMergeBlock` 读取 standaloneTools set |

### 替代路径覆盖

| 路径 | 覆盖情况 | 说明 |
|------|---------|------|
| 取消所有工具 → 全部折叠 | ✅ | standaloneTools 为空集，所有内置工具都 merge |
| 恢复默认 | ⚠️ 见 Suggest-fix #1 | 无"恢复默认"按钮 |

---

## Must-fix Issues

### Must-fix #1: AgentRunBlock 耗时计算可能为 0

**文件**: `AgentRunBlock.vue` L155-182 (`elapsedMs` computed)

**问题**: `elapsedMs` 从 `thinking[].startTime/endTime` 和 `toolCalls[].startTime/endTime` 收集时间戳。但在 streaming 状态下，如果第一个 thinking block 尚未有 `startTime`（pi 延迟写入），`times` 数组为空，`elapsedMs` 返回 0，footer 显示 "0.0s"。

Complete 状态下更严重：`const endTimes = times.length > 0 ? times : []` 这行赋值后 `endTimes` 和 `times` 始终相同，`end = Math.max(...endTimes)` 可能取到 `startTime` 而非 `endTime`。如果最后一个操作没有 `endTime`（边界情况），计算结果错误。

**修复建议**: 
1. Complete 路径改为分别取 startTimes 和 endTimes：`const startTimes = ...filter(hasStartTime)`, `const endTimes = ...filter(hasEndTime)`，用 `max(endTimes) - min(startTimes)`。
2. streaming 路径增加 `times.length === 0` 的 fallback（用 `message.timestamp` 或 `Date.now()`）。

### Must-fix #2: groupByContentBlocks 中 text block 跳过条件过于严格

**文件**: `message-layout.ts` L110-112

**问题**: 当遇到 text 类型 contentBlock 时，代码检查 `if (!msg.content) continue`。但 `msg.content` 是整个消息的 content 字段，不是当前 text block 的内容。在 AgentRunBlock 模式下，如果消息有多个 text block（中间穿插 toolCall），每个 text block 都依赖 `msg.content` 来决定是否跳过。这导致：
- 如果 `msg.content` 为空字符串，所有 text block 都被跳过（正确）
- 如果 `msg.content` 非空，即使某个 text block 实际无内容也不会被跳过（轻微问题）
- 更关键的是：text block 的渲染在 AgentRunBlock.vue L30 中使用 `renderedContent`（基于 `message.content`），这意味着所有 text section 渲染的是**同一段 markdown 内容**，而非按 contentBlock 分别渲染

**根因**: spec 中 text block 是直接渲染 markdown，但当前实现只有一个 `message.content` 字段。多个 text section 会渲染重复内容。

**修复建议**: 文本 section 最多应该只出现一个（因为 `message.content` 只有一个）。可以在 `groupByContentBlocks` 中对 text block 做去重：只保留第一个 text block，后续跳过。

### Must-fix #3: CompactStreamingBubble 被删除但未验证 streaming 渲染完整性

**文件**: `ChatPanel.vue` L87-89

**问题**: `CompactStreamingBubble` 组件的 import 和渲染分支被完全移除。streaming 消息现在统一走 `StreamingMessage`。但 `StreamingMessage` → `MessageBubble` → `AssistantContent` 链路是否已支持 `isStreaming` prop 正确传递？

当前 diff 中 `StreamingMessage.vue` 和 `MessageBubble.vue` **没有任何改动**。如果之前这两个组件已经正确传递 `isStreaming`，则无问题。但如果之前 `CompactStreamingBubble` 是因为 streaming 路径不经过 `AssistantContent` 而存在的（plan T7 中提到 "ChatPanel 直接渲染 streaming 消息，不经过 MessageList/AssistantContent"），那么现在删除后 streaming 消息可能**不会**经过 `AssistantContent`，导致 `compactStreaming=true` 时仍走 normal section 渲染。

**修复建议**: 验证 `StreamingMessage.vue` 的渲染路径是否包含 `MessageBubble` → `AssistantContent`，并确认 `isStreaming` prop 能正确传到 `AgentRunBlock`。

---

## Suggest-fix Issues

### Suggest-fix #1: 无"恢复默认"按钮

**文件**: `SystemPane.vue`

**问题**: UC-4 替代路径 "用户恢复默认 → 点击恢复 write + edit" 无法实现。Settings UI 只能逐个勾选/取消，没有"恢复默认"按钮。

**影响**: 低。用户可以手动取消全部后只勾选 write 和 edit，操作略繁琐但功能完整。

### Suggest-fix #2: MergeBlock chip 颜色使用了 `color-mix`，需要浏览器兼容性确认

**文件**: `MergeBlock.vue` L190-196

**问题**: `.merge-chip--thinking` 和 `.merge-chip--tool` 使用 `color-mix(in oklch, ...)` CSS 函数。Electron 33 内置 Chromium 130+，`color-mix` 支持无问题。但 spec AC-6 要求"不新增 CSS 变量"，`color-mix` 不算新增变量，符合要求。此处仅提醒。

---

## 分组逻辑验证 (AC-5)

### 测试用例 1: `T tc tc O T tc T tc O`

输入: thinking, toolCall(read), toolCall(bash), text, thinking, toolCall(read), thinking, toolCall(grep), text
默认 standaloneTools: `['write', 'edit']`

**预期**:
- MergeBlock: [T, tc-read, tc-bash]
- TextBlock: text
- MergeBlock: [T, tc-read, T, tc-grep]
- TextBlock: text

**代码验证**: 
- `isMergeBlock(T) = true`, `isMergeBlock(tc-read) = true (read ∉ standaloneTools)`, `isMergeBlock(tc-bash) = true (bash ∉ standaloneTools)` → flushMerge → [merge]
- text → flushMerge → [text] ✅
- `isMergeBlock(T) = true`, `isMergeBlock(tc-read) = true`, `isMergeBlock(T) = true`, `isMergeBlock(tc-grep) = true` → [merge]
- text → [text] ✅

**结果: PASS** ✅

### 测试用例 2: `T O S O` (edit 独立展示)

输入: thinking, text, toolCall(edit), text
默认 standaloneTools: `['write', 'edit']`

**预期**:
- MergeBlock: [T]
- TextBlock: text
- StandaloneBlock: edit
- TextBlock: text

**代码验证**:
- `isMergeBlock(T) = true` → mergeBlocks = [T]
- text → flushMerge [merge], [text] ✅
- `isMergeBlock(tc-edit) = false (edit ∈ standaloneTools)` → flushMerge, standalone ✅
- text → [text] ✅

**结果: PASS** ✅

### 测试用例 3: `T tc S T tc O customTool O`

输入: thinking, toolCall(read), toolCall(write), thinking, toolCall(bash), text, toolCall(subagent), text
默认 standaloneTools: `['write', 'edit']`

**预期**:
- MergeBlock: [T, tc-read]
- StandaloneBlock: write
- MergeBlock: [T, tc-bash]
- TextBlock: text
- CustomToolBlock: subagent
- TextBlock: text

**代码验证**:
- T → merge, tc-read → merge, tc-write → `isMergeBlock = false (write ∈ standaloneTools)` → flush [merge], standalone ✅
- T → merge, tc-bash → merge, text → flush [merge], [text] ✅
- tc-subagent → `isMergeBlock = false (subagent ∉ ALL_PI_TOOLS → custom)` → customTool ✅
- text → [text] ✅

**结果: PASS** ✅

### 测试用例 4: 用户将 bash 加入 standaloneTools

**预期**: bash 从 MergeBlock 移出变为 StandaloneBlock

**代码验证**: `isMergeBlock(tc-bash)` → `ALL_PI_TOOLS.includes('bash') && !standaloneTools.has('bash')` → 当 bash ∈ standaloneTools 时返回 false → 走 standalone 分支 ✅

**结果: PASS** ✅

---

## 旧消息兼容 (AC-7)

`groupIntoSections(msg, undefined)` → `standaloneTools` 为 undefined → 走 `groupByContentBlocksLegacy(msg)` → 原有相邻同类型合并逻辑。✅

`groupIntoSections(msg, standaloneTools)` 但 `msg.contentBlocks` 为空 → 走 `groupByLegacyFields(msg)` → 从 thinking/toolCalls/content 构造 sections。✅

compactStreaming=false 时 `AssistantContent.vue` L12 `<template v-else-if="sections.length">` 走原有 normal section 模式。✅

---

## Footer 字段验证

| 字段 | Spec 定义 | 实现 | 匹配 |
|------|----------|------|------|
| 步骤数 | MergeBlock 数 + 独立 ContentBlock 数（不含 text） | `sections.filter(s => s.type !== 'text').length` | ✅ |
| 总耗时 | streaming 时当前时间间隔，complete 时 endTime - startTime | `elapsedMs` computed | ⚠️ Must-fix #1 |
| 文件修改数 | toolCalls 中 toolName 在 standaloneTools 集合内的总数 | `tcs.filter(tc => standalone.has(tc.toolName)).length` | ✅ |

---

## 总结

| 类别 | 数量 | 详情 |
|------|------|------|
| UC 主流程通过 | 4/4 | UC-1~UC-4 所有主流程步骤覆盖 |
| UC 替代路径通过 | 6/8 | 2 个轻微缺失（恢复默认按钮、text block 去重） |
| Must-fix | 3 | 耗时计算边界、text block 重复渲染、streaming 路径验证 |
| Suggest-fix | 2 | 恢复默认按钮、color-mix 兼容性提醒 |
| AC-5 分组测试 | 4/4 PASS | 所有时序分组用例验证通过 |

**结论**: 核心分组逻辑和组件结构正确，但有 3 个 must-fix 问题需要在合入前解决。其中 Must-fix #3（streaming 路径完整性）影响最大，如果 `StreamingMessage` 不经过 `AssistantContent`，则整个 streaming 模式下的 AgentRunBlock 功能失效。
