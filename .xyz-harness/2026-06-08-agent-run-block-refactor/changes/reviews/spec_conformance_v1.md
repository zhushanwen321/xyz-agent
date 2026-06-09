---
verdict: pass
must_fix: 0
warnings: 3
---

# Spec-Plan Conformance Review — AgentRunBlock 重构

**Reviewer**: Stage 1 自动审查  
**日期**: 2026-06-08  
**范围**: spec.md 全部 FR/AC + plan.md 全部 T1-T8

## 审查结论

**PASS**。spec 中 6 项功能需求（FR-1 ~ FR-6）和 8 项验收标准（AC-1 ~ AC-8）全部在源码中找到对应实现。无 must_fix 级缺失。3 项 warning 级观察见下。

## 逐项审查

### FR-1: AgentRunBlock 容器 — PASS

| 要求 | 实现 | 状态 |
|------|------|------|
| compactStreaming=true 时激活 | `AssistantContent.vue` `v-if="useCompact"` → `<AgentRunBlock>` | OK |
| compactStreaming=false 走现有路径 | `v-else` → `AssistantSection` 渲染，无改动 | OK |
| 3px 顶部状态条 + 扫光动画 | `AgentRunBlock.vue` `run-status-bar` + `@keyframes run-sweep` | OK |
| Complete 时静默背景色 | `isStreaming ? 'run-status-bar--streaming' : 'bg-border'` | OK |
| Footer: 步骤数 | `stepCount = sections.filter(s => s.type !== 'text').length` | OK |
| Footer: 总耗时 | `useLiveTimer` + `formatTime(elapsedMs)`，streaming 实时更新 | OK |
| Footer: 文件修改数 | `toolCalls.filter(tc => standaloneTools.has(tc.toolName)).length` | OK |

### FR-2: ContentBlock 分类渲染 — PASS

| 要求 | 实现 | 状态 |
|------|------|------|
| text 始终独立渲染 | `message-layout.ts` text block → `type: 'text'` section | OK |
| 自定义工具始终独立 | `isCustom` 判断 → `type: 'customTool'` | OK |
| standaloneTools 内 → 独立 | `!isMergeBlock` 且非 text → `type: 'standalone'` | OK |
| standaloneTools 外 → 合并 | `isMergeBlock` 返回 true → 追加到 merge group | OK |
| thinking 始终合并 | `isMergeBlock` 对 thinking 返回 true | OK |
| ALL_PI_TOOLS 常量 | `['read','bash','edit','write','grep','find','ls']` | OK |

### FR-2.1: Settings standaloneTools 配置 — PASS

| 要求 | 实现 | 状态 |
|------|------|------|
| Settings 页面 checkbox 列表 | `SystemPane.vue` v-for ALL_PI_TOOLS + Toggle 组件 | OK |
| 默认值 `['write','edit']` | `settings.ts` `ref<string[]>(['write', 'edit'])` | OK |
| 持久化 | `persist.pick` 包含 `'standaloneTools'` | OK |
| compactStreaming 关闭时隐藏 | `v-if="settingsStore.compactStreaming"` 条件包裹 | OK |

### FR-3: MergeBlock 折叠渲染 — PASS

| 要求 | 实现 | 状态 |
|------|------|------|
| 完整模式 chip 摘要条 | `MergeBlock.vue` `chips` computed + `merge-bar` 模板 | OK |
| 格式 `思考 ×N · toolName ×N` | chip label + `×${chip.count}` | OK |
| thinking chip 用 --accent | `merge-chip--thinking { background: var(--accent); color: var(--accent) }` | OK |
| tool chip 用 --success | `merge-chip--tool { background: var(--success); color: var(--success) }` | OK |
| 点击展开 | `toggleExpand` + `v-show="expanded"` | OK |
| 展开复用 ThinkingBlock + ToolCallCard | import 两个组件并按 block.type 条件渲染 | OK |
| "过程" 标签 | `merge-bar__label` 文本 "过程" | OK |

### FR-4: 分组规则 — PASS

`isMergeBlock` 函数与 spec 代码完全一致。`groupByContentBlocks` 算法：
1. 遍历 contentBlocks → isMergeBlock 追加到 merge group → flushMerge 关闭
2. 非 merge 按 text/standalone/customTool 分类

**AC-5 分组验证**（对照 spec 示例）：

| 输入序列 | spec 预期 | 代码逻辑匹配 |
|---------|----------|-------------|
| `T tc-read tc-bash O T tc-read T tc-grep O` | merge → text → merge → text | OK（read/bash/grep 不在 standaloneTools → merge） |
| `T O S-edit O` | merge → text → standalone → text | OK（edit 在 standaloneTools → standalone） |
| `T tc-read S-write T tc-bash O subagent O` | merge → standalone → merge → text → customTool → text | OK |

### FR-5: Streaming MergeBlock — PASS

| 要求 | 实现 | 状态 |
|------|------|------|
| thinking 判断 `endTime === undefined` | `lastThinking.endTime === undefined → '思考中...'` | OK |
| running tool 显示 `toolName path` | `runningTc` → `toolPath(runningTc.input)` → 格式化 | OK |
| text delta 预览截断 60 字符 | `TEXT_PREVIEW_MAX = 60` + `slice(0, 60) + '...'` | OK |
| 实时耗时 | `useLiveTimer(200)` + `formatTime` | OK |
| 紧凑一行高度 28px | `.merge-stream { height: 28px }` | OK |
| 脉冲圆点 | `.merge-stream__pulse` + `@keyframes merge-pulse` | OK |

### FR-6: 历史消息兼容 — PASS

| 要求 | 实现 | 状态 |
|------|------|------|
| 无 contentBlocks → legacy 路径 | `groupIntoSections` 首行检查 `contentBlocks?.length` | OK |
| `groupByLegacyFields` 不变 | 函数体未修改，从 thinking/toolCalls/content 构造 | OK |
| 仅影响 assistant 消息 | 渲染在 AssistantContent.vue，user/system 走其他路径 | OK |

### AC-1 ~ AC-8 验收标准逐项

| AC | 描述 | 状态 |
|----|------|------|
| AC-1 | 容器渲染 + 状态条 + footer | PASS — AgentRunBlock.vue 全覆盖 |
| AC-2 | text/write/自定义工具独立渲染 | PASS — message-layout 分类 + StandaloneToolCard |
| AC-3 | MergeBlock 折叠 chip + 展开 | PASS — MergeBlock.vue 完整实现 |
| AC-4 | MergeBlock streaming 紧凑状态 | PASS — merge-stream 模板 |
| AC-5 | 分组正确性 | PASS — isMergeBlock + groupByContentBlocks 逻辑匹配 spec |
| AC-6 | 主题兼容 CSS 变量 | PASS — 无硬编码颜色，全用 var(--accent/--success/--border 等) |
| AC-7 | 旧消息兼容 | PASS — groupByLegacyFields 未改动 |
| AC-8 | Settings UI + 持久化 | PASS — SystemPane.vue checkbox + persist.pick |

## Plan 执行完整性

| Task | 描述 | 文件 | 状态 |
|------|------|------|------|
| T1 | settings store standaloneTools | `stores/settings.ts` | DONE |
| T2 | message-layout 分组重写 | `lib/message-layout.ts` | DONE |
| T3 | MergeBlock 组件 | `chat/MergeBlock.vue` | DONE |
| T4 | StandaloneToolCard 组件 | `chat/StandaloneToolCard.vue` | DONE |
| T5 | AgentRunBlock 容器 | `chat/AgentRunBlock.vue` | DONE |
| T6 | AssistantContent 集成 | `chat/AssistantContent.vue` | DONE |
| T7 | ChatPanel streaming 统一 | `panel/ChatPanel.vue` | DONE — CompactStreamingBubble 已移除 |
| T8 | Settings 页面 UI | `settings/SystemPane.vue` | DONE |

8/8 tasks 完成。

## Constraints 合规

| 约束 | 状态 |
|------|------|
| 不改动共享类型 | OK — shared/src/message.ts 未动 |
| 不改动 EventAdapter / WS 协议 | OK — 无 sidecar 层变更 |
| 不改动 useChat.ts | OK — 仅前端渲染层变更 |
| 复用 ThinkingBlock + ToolCallCard | OK — MergeBlock 和 StandaloneToolCard 均 import 复用 |
| CSS 变量复用，不新增 | OK — 无新 CSS 变量定义 |
| compactStreaming 开关隔离 | OK — false 路径完全不变 |

## Warnings（非阻塞）

### W1: 无单元测试覆盖新增逻辑

`message-layout.ts` 的 `groupByContentBlocks`、`isMergeBlock`、`ALL_PI_TOOLS` 是此次重构的核心算法，但 `lib/__tests__/` 中无对应测试文件。`MergeBlock.vue` 和 `StandaloneToolCard.vue` 也无组件测试。

建议后续补充 `message-layout.spec.ts` 覆盖 AC-5 的 4 种分组场景。

### W2: AssistantSection 类型包含旧 sectionType

`SectionType = 'merge' | 'text' | 'standalone' | 'customTool' | 'thinking' | 'toolCall'` 中 `thinking` 和 `toolCall` 仅在 `groupByContentBlocksLegacy`（compactStreaming=false 路径）中使用。类型定义混合了新旧两种模式的类型，后续清理可将 legacy 路径的 SectionType 独立出来。

### W3: MergeBlock streaming 耗时基于 message.timestamp

`MergeBlock.vue` 的 `streamElapsed` 用 `now.value - message.timestamp` 计算。如果 message.timestamp 是消息创建时间（而非首个 block 开始时间），耗时可能偏大。AgentRunBlock.vue 的 `elapsedMs` 用了更精确的 min(startTime) 方案，两处计算口径不一致。
