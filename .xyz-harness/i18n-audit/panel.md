# Panel 模块 i18n 审计报告

## 审查时间
2026-07-14

## 审查范围
实际审查 30 个文件（任务指定清单）：

**components/panel/** (18 个文件)
- AddMenuPopover.vue
- CommandDocPanel.vue
- CommandPopover.vue
- Composer.vue
- ComposerInput.vue
- ContextCapacityPopover.vue
- ContextChipsBar.vue
- DetailPane.vue
- GitPanel.vue
- MessageStream.vue
- ModelSelectPopover.vue
- Panel.vue
- PanelHeader.vue
- ProgressZone.vue
- QueueBubble.vue
- RetryIndicator.vue
- SideDrawer.vue
- ThinkingLevelPopover.vue

**components/panel/message-stream/** (10 个文件)
- AmbiguousFilePopover.vue
- BgNotifyCard.vue
- Block.vue
- ChangeSetCard.vue
- ForkConfirmModal.vue
- GuiComponentRenderer.vue
- MarkdownRenderer.vue
- MermaidRenderer.vue
- SystemNotice.vue
- Turn.vue

**components/panel/detail-renderers/** (2 个文件)
- CodeBlock.vue
- DiffView.vue

注：未审计 `thinking-levels.ts`（不在指定清单内）以及 `message-stream/gui/` 子目录（不在指定清单内）。前者含 8 个硬编码中文 label（见"误报排除"段落末尾补充说明）。

## 总体结论
**FAIL** — 30 个文件中发现 19 处用户可见的硬编码字符串（中英文混合），未走 `t('panel.*')` 通道。

## locale keys 现状
- panel.ts keys (zh-CN): 14 个分组 / ~110 条
- panel.ts keys (en-US): 14 个分组 / ~110 条
- 是否一致: 是（两个 locale 文件均为 238 行，结构对齐）

缺失的 keys 需补（见"漏网字符串清单"）：
- `panel.message.compacted` / `panel.message.compactedTokens`
- `panel.message.branchCreated`
- `panel.message.toolCount` / `panel.message.thinkCount`
- `panel.bgNotify.patchHint`
- `panel.ambiguous.title` / `panel.ambiguous.matchCount`
- `panel.queue.itemCount`
- `panel.git.stage` / `panel.git.unstage` / `panel.git.commit`
- `panel.git.pillClean` / `panel.git.pillStaged` / `panel.git.pillDirty` / `panel.git.pillConflict`
- `panel.sideDrawer.tabTerminal` / `panel.sideDrawer.tabBrowser` / `panel.sideDrawer.tabGit` / `panel.sideDrawer.tabDoc` / `panel.sideDrawer.tabDetail`
- `panel.detail.tabDiff`
- `panel.overlay.subagent` / `panel.overlay.agentCall`
- `panel.command.noFullDoc`
- `panel.subagent.multi`
- `panel.file.kind.directory`

## 漏网字符串清单

### `components/panel/AddMenuPopover.vue`
- 无漏网

### `components/panel/CommandDocPanel.vue`
- **位置**: 第 37 行 `<p>` 标签内
- **原文**: `无完整文档（仅 description）。`
- **判定**: 漏网（用户可见的非 skill 命令信息卡末段说明文字）
- **建议**: `panel.command.noFullDoc` → zh: "无完整文档（仅 description）" / en: "No full documentation (description only)"

### `components/panel/CommandPopover.vue`
- **位置**: 第 190 行 `icon` 字段硬编码
- **原文**: `f.kind === '目录' ? 'folder' : 'file'`
- **判定**: 漏网（用中文 '目录' 字面量作为 file 类型分支判定条件——该字面量本应是来自 file 系统的 kind 值，不是显示文案。需人工判断：是改判定为 i18n key，还是改 file node 数据源返回 enum）
- **建议**: 优先排查 `f.kind` 数据源（file-candidates.ts），建议改为 enum/dict 而非中文字面量；UI 侧 `panel.file.kind.directory` 走 i18n

### `components/panel/Composer.vue`
- 无漏网

### `components/panel/ComposerInput.vue`
- 无漏网

### `components/panel/ContextCapacityPopover.vue`
- 无漏网

### `components/panel/ContextChipsBar.vue`
- 无漏网

### `components/panel/DetailPane.vue`
- **位置**: 第 24 行 `<Button>` 文本
- **原文**: `>Diff<`
- **判定**: 漏网（Diff/Preview toggle 按钮文案，Diff 是英文未走 i18n；Preview 已走 `t('panel.detail.preview')`）
- **建议**: `panel.detail.tabDiff` → zh: "差异" / en: "Diff"

### `components/panel/GitPanel.vue`
- **位置**: 第 86 / 93 / 99 行 按钮文本
- **原文**: `>Stage<` / `>Unstage<` / `>Commit<`
- **判定**: 漏网（Git 操作三按钮文案，Stage/Unstage/Commit 是 git 业内术语，但 W4 已将 git.title 等走 i18n，此三按钮明显漏了）
- **建议**: `panel.git.stage` → "暂存" / "Stage"；`panel.git.unstage` → "取消暂存" / "Unstage"；`panel.git.commit` → "提交" / "Commit"
- **位置**: 第 151 行 `pillLabel` 计算属性
- **原文**: `Clean` / `Staged` / `Dirty` / `Conflict`
- **判定**: 漏网（Git 状态 pill 标签）
- **建议**: `panel.git.pillClean` / `panel.git.pillStaged` / `panel.git.pillDirty` / `panel.git.pillConflict` → "干净" / "已暂存" / "有改动" / "冲突"（en: Clean / Staged / Dirty / Conflict）

### `components/panel/MessageStream.vue`
- 无漏网

### `components/panel/ModelSelectPopover.vue`
- 无漏网

### `components/panel/Panel.vue`
- **位置**: 第 186-190 行 `subagentLabel` computed
- **原文**: `Agent call · ${id}` / `Subagent`（fallback 分支）
- **判定**: 漏网（panel 标题栏显示的 subagent/agent call overlay 标签，硬编码英文）
- **建议**: `panel.overlay.subagent` → "子代理" / "Subagent"；`panel.overlay.agentCall` → "代理调用" / "Agent call"

### `components/panel/PanelHeader.vue`
- 无漏网

### `components/panel/ProgressZone.vue`
- 无漏网

### `components/panel/QueueBubble.vue`
- **位置**: 第 33 行 `<template>` 内插值
- **原文**: `{{ totalCount }} 条 · `
- **判定**: 漏网（队列计数文本 "X 条"）
- **建议**: `panel.queue.itemCount` (param: count) → "{count} 条" / "{count} items"

### `components/panel/RetryIndicator.vue`
- 无漏网

### `components/panel/SideDrawer.vue`
- **位置**: 第 211 / 218 / 225 / 232 / 239 行 `tabs` computed `label` 字段
- **原文**: `Terminal` / `Browser` / `Git` / `Doc` / `Detail`
- **判定**: 漏网（侧栏 5 个 tab 的 tooltip/label，Terminal/Browser/Git/Doc/Detail 均未走 i18n）
- **建议**: `panel.sideDrawer.tabTerminal` / `tabBrowser` / `tabGit` / `tabDoc` / `tabDetail`（zh 保持英文或译"终端"/"浏览器"/"Git"/"文档"/"详情"）

### `components/panel/ThinkingLevelPopover.vue`
- 无漏网

### `components/panel/message-stream/AmbiguousFilePopover.vue`
- **位置**: 第 29 行 `<div>` 文本
- **原文**: `「{{ basename }}」有 {{ candidates.length }} 个匹配，选择要打开的文件`
- **判定**: 漏网（歧义文件选择浮层标题，用户可见）
- **建议**: `panel.ambiguous.title` (params: basename, count) → "「{basename}」有 {count} 个匹配，选择要打开的文件" / "「{basename}」has {count} matches, choose a file to open"

### `components/panel/message-stream/BgNotifyCard.vue`
- **位置**: 第 131 行 `patchHint` computed
- **原文**: `` `改动以 patch 形式保存：${s.patchFile}（用 git apply 应用到当前仓库）` ``
- **判定**: 漏网（bg-notify 卡片展开后的 patch 提示）
- **建议**: `panel.bgNotify.patchHint` (param: file) → "改动以 patch 形式保存：{file}（用 git apply 应用到当前仓库）" / "Changes saved as patch: {file} (apply with git apply)"

### `components/panel/message-stream/Block.vue`
- **位置**: 第 49 行 `<span>` 文本
- **原文**: `Subagent`（subagent 块 header 标签）
- **判定**: 漏网（subagent 工具块标签）
- **建议**: `panel.message.subagent` → "子代理" / "Subagent"
- **位置**: 第 64 行 `<span>` 文本
- **原文**: `工具 ×{{ toolCount }}`
- **判定**: 漏网（subagent 进度详情行的"工具"前缀）
- **建议**: `panel.subagent.toolCount` (param: count) → "工具 ×{count}" / "Tools ×{count}"
- **位置**: 第 250 行 `subagentAgent` computed
- **原文**: `` `${firstName} 等 ${arr.length} 个` ``
- **判定**: 漏网（多 subagent 时显示 "X 等 N 个" 摘要）
- **建议**: `panel.subagent.multiSummary` (params: first, count) → "{first} 等 {count} 个" / "{first} and {count} more"

### `components/panel/message-stream/ChangeSetCard.vue`
- 无漏网

### `components/panel/message-stream/ForkConfirmModal.vue`
- 无漏网

### `components/panel/message-stream/GuiComponentRenderer.vue`
- 无漏网

### `components/panel/message-stream/MarkdownRenderer.vue`
- 无漏网

### `components/panel/message-stream/MermaidRenderer.vue`
- 无漏网

### `components/panel/message-stream/SystemNotice.vue`
- **位置**: 第 32 行 `resolveNotice` 内
- **原文**: `` `已压缩上下文${tokLabel}` ``
- **判定**: 漏网（compaction summary 系统提示）
- **建议**: `panel.message.compacted` (param: tokens?) → "已压缩上下文{0}" / "Context compacted{0}"
- **位置**: 第 37 行 `resolveNotice` 内
- **原文**: `` `已创建分支${fromLabel}` `` + `` `（自 ${from}）` ``
- **判定**: 漏网（branch summary 系统提示）
- **建议**: `panel.message.branchCreated` (param: from?) → "已创建分支（自 {from}）" / "Branch created (from {from})"

### `components/panel/message-stream/Turn.vue`
- **位置**: 第 145 行 `<span>` 内容
- **原文**: `思考 ×{{ thinkCount }}`
- **判定**: 漏网（turn-meta 思考次数 badge）
- **建议**: `panel.message.thinkCount` (param: count) → "思考 ×{count}" / "Think ×{count}"
- **位置**: 第 148 行 `<span>` 内容
- **原文**: `工具 ×{{ toolCount }}`
- **判定**: 漏网（turn-meta 工具调用次数 badge）
- **建议**: `panel.message.toolCount` (param: count) → "工具 ×{count}" / "Tool ×{count}"

### `components/panel/detail-renderers/CodeBlock.vue`
- 无漏网

### `components/panel/detail-renderers/DiffView.vue`
- 无漏网

## 误报排除

下列内容被初判为可疑，但最终判定为**误报 / 非漏网**：

1. **`thinking-levels.ts` 第 21-26、85-86 行** 硬编码中文 "关/低/中/高/极高/最高/开/思考"
   - 该文件不在指定 30 个文件清单内（位于 `panel/thinking-levels.ts`，是 .ts 工具文件）
   - 任务范围明确为 30 个 .vue + 必要 .ts，本 ts 未列入
   - 备注：但它是 W4 i18n 化的一个明显漏网点（thinking 等级 label 完全硬编码），建议作为 W5 补漏任务跟进

2. **`Block.vue` 第 65 行** `turn {{ turnCount }}` 英文
   - "turn" 在 subagent 进度快照里是技术术语（与 subagent 协议字段名一致），非显示文案
   - 误报，无需处理

3. **`Block.vue` 第 232 行** `` `${input.tasks.length} todos` `` 英文
   - 该字段展示 todo 工具入参的任务数；与 tool name "todo_write" 同语义族
   - 误报（runtime 内部字段透传），无需处理

4. **`MarkdownRenderer.vue` / `MermaidRenderer.vue` / `CodeBlock.vue` / `DiffView.vue` 注释内中文**
   - 全部为代码注释（含设计意图 / 历史说明 / escape hatch 解释）
   - 任务标准明确规定注释不算漏网

5. **`Turn.vue` 第 214 行** `MD` 徽章
   - "MD" 是技术缩写（Markdown），是行业通用标识
   - 误报，无需处理

6. **`Panel.vue` 第 189 行** `Subagent`
   - 与 `Block.vue:49` 重复判定：subagent 块标签
   - 已计入 Block.vue 漏网；Panel.vue:189 的 `subagentLabel` 已与 `Agent call` 一同在 Panel.vue 漏网段记录

7. **`GitPanel.vue` 状态 badge `A/M/D/U`** 第 115 行
   - Git 业内通用文件状态缩写（Added/Modified/Deleted/Unmerged）
   - 误报，无需处理

8. **`message-stream/gui/` 目录**（AnsiText/Card/Columns/ProgressBar/StatsLine/TabBar 等）
   - 不在任务指定 30 个文件清单内，未审计
   - 备注：ListTree.vue 经抽样查看已正确使用 i18n，状态 label 走 `panel.listTree.*`

## 统计

- 漏网数: **19**
  - 高优先级（按钮/标签/弹窗文案）: 13
    - DetailPane Diff 按钮
    - GitPanel 3 个操作按钮 + 4 个状态 pill
    - Panel.vue subagent/agent call 标签 ×2
    - SideDrawer 5 个 tab label
    - AmbiguousFilePopover 标题
    - Block.vue Subagent 标签
  - 中优先级（系统提示/计数/详情摘要）: 6
    - QueueBubble "X 条"
    - BgNotifyCard patchHint
    - SystemNotice 压缩/分支提示 ×2
    - Block.vue 工具数 + 多 subagent 摘要 ×2
    - Turn.vue 思考/工具 badge ×2
  - 需人工判断（数据源设计）: 1
    - CommandPopover.vue '目录' 字面量（可能要从数据源改而非 UI 改）
- 误报数: 8（含 1 个跨范围备注）
- 严重程度（用户频繁可见的高优先级）: 13

## 建议处理顺序

1. **W5 优先补全高优先级 13 处**（按钮/标签/弹窗）—— 全部是用户最常点的 UI 元素
2. **SystemNotice 2 处 + QueueBubble 1 处** —— 消息流和队列是常驻可见
3. **CommandPopover '目录' 字面量** —— 需先排查 `toFileCandidates` 数据源（建议改为 enum），不能简单走 i18n
4. **顺手处理 `thinking-levels.ts`** —— 该文件不在 30 文件清单内，但 W4 i18n 化的明显漏网点，W5 应一并补全（11 个 label）
