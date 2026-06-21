# Wave W11 · MessageStream (Panel Zone ②) 审查报告

> 审查日期：2026-06-21
> 审查员：A-WP-M 执行员（自顶向下 W11）
> 范围：MessageStream.vue + Turn.vue + Block.vue + messageTurns.ts + chat.ts Message 类型
> 设计源：panel/spec.md + draft-message-stream.html §4 + flow-2-code-review/spec.md
> 审查锚点：10 个（WP-L3-05 ~ WP-L3-14）

---

## 一、Wave 汇总表（10 锚点）

| ID | 层 | 区域.模块 | 组件/锚点 | 判定 | 设计来源 | 实现位置 | 根因标签 |
|----|----|----------|----------|------|---------|---------|---------|
| WP-L3-05 | L3 | Panel.MessageStream | 回合折叠机制（默认折叠只显 Summary + FileChanges） | ⚠ | panel/spec.md §message-stream | Turn.vue:35-62 / messageTurns.ts:32-68 | 疑似根因→FileChanges 块缺失 |
| WP-L3-06 | L3 | Panel.MessageStream | "已工作 X · N reasoning · M tool" pill → 点击展开 | ✅ | draft-message-stream.html §1 | Turn.vue:22-40 / messageTurns.ts:67-77 | — |
| WP-L3-07 | L3 | Panel.MessageStream | ① UserMessage（靠右气泡） | ✅ | draft-message-stream.html §4 规则表 | Turn.vue:11-13 / Turn.vue:113-122 | — |
| WP-L3-08 | L3 | Panel.MessageStream | ② OutputText（Markdown + 流式光标） | ⚠ | draft-message-stream.html §4 规则表 | Turn.vue:48-53 | 孤立 |
| WP-L3-09 | L3 | Panel.MessageStream | ③ ReasoningBlock（thinking 折叠 + 计时） | ⚠ | draft-message-stream.html §4 规则表 | Block.vue:15-21 | 孤立 |
| WP-L3-10 | L3 | Panel.MessageStream | ④ ToolCallCard（工具名/目标文件/状态 + 失败红框） | ✅ | draft-message-stream.html §4 规则表 | Block.vue:24-40 | — |
| WP-L3-11 | L3 | Panel.MessageStream | ⑤ FileChanges（变更集聚合 5 态状态机） | ❌ | flow-2-code-review/spec.md §状态机 | 未找到（全项目无实现） | 已确认缺失 |
| WP-L3-12 | L3 | Panel.MessageStream | ⑥ Steer/Followup pending 气泡 | ❌ | draft-message-stream.html §4 规则表 | 未找到（G-019 DEFERRED） | 关联 W12 G-019 |
| WP-L3-13 | L3 | Panel.MessageStream | ⑦ SystemNotice（错误/断网/完成提示） | ❌ | draft-message-stream.html §4 规则表 | 未找到（全项目无独立 System 块） | 已确认缺失 |
| WP-L3-14 | L3 | Panel.MessageStream | 消息操作菜单（hover user msg → 编辑并重发/复制/引用/删除） | ❌ | flow-2-code-review/spec.md §状态机·消息操作菜单 | 未找到（全项目无实现） | 已确认缺失 |

**汇总**：✅ x3 / ⚠ x3 / ❌ x4

---

## 二、★回合折叠核查专节

### 设计契约（panel/spec.md §message-stream）

> AI 一次「工作回合」= 从开始工作到停止。回合默认折叠，只显示：
> 1. **Summary**（stop 前总结）— Agent 行为契约：每轮停止前必须输出结构化总结
> 2. **File Changes**（文件变更清单）— 本回合改动的文件（新增/修改/删除 + 行数）
> 其余内容折叠为一条 pill：「已工作 3m 24s · 5 reasoning · 12 tool」

### 核查表

| 子项 | 设计要求 | 实现现状 | 判定 |
|------|---------|---------|------|
| 默认折叠（只显 Summary + FileChanges） | 折叠 reasoning/tool/中间 text | Summary ✅ 恒显（Turn.vue:48-53），FileChanges ❌ 不存在 | ⚠ |
| 折叠 pill "已工作 X · N reasoning · M tool" | mono Pill，click 展开 | ✅ Turn.vue:25-40，chev 旋转+expanded ref 控制 | ✅ |
| 展开后时序还原 | trace 块按时间序排列 | ✅ `v-for` 遍历 assistants 按序渲染 thinking/tool 块（Turn.vue:35-42） | ✅ |
| Working 态（流式中） | 脉冲点+实时计时+trace 默认展开 | ✅ Turn.vue:28-33 `turn.isWorking` + `showTrace` 展开 | ✅ |
| Elapsed 时间计算 | 回合首尾 assistant timestamp 差 | ✅ messageTurns.ts 从 assistant timestamp 算（Turn.vue:100-107） | ✅ |
| Summary 契约落地 | Agent 停止前必输出总结 | ⚠ 渲染层已就绪（summaryText 拼接 assistant.content），但契约无 PRODUCT.md 落契（panel/spec.md 标记为"未决项"） | ⚠ |
| File Changes 列表（回合默认可见） | A/M/D badge + 行数 + 点击跳 Diff | ❌ 完全未实现。Turn.vue 无任何 FileChanges 渲染，messageTurns.ts 无 fileChanges 字段 | ❌ |

### 关键偏差

1. **FileChanges 缺失是回合折叠的致命缺陷**。设计明确要求 FileChanges 与 Summary 同为「折叠态恒显」的两个锚点。当前实现只有 Summary，没有 FileChanges。这使折叠态信息量减半——用户不知道这个回合改了哪些文件。

2. **中间 Output Text 折叠未实现**。draft-message-stream.html §4 规则表定义：Output Text 分两种渲染——中间产出折进执行流程（`vis-hide`），收尾位固定不折叠（`vis-show`）。当前 Turn.vue 的 `summaryText` 取所有 assistant.content 拼接为收尾，中间阶段的 text 碎片（message_start→text_delta→complete 路径中在 tool_call 之前的 text）未从收尾中拆分出来折进 trace。`chat.ts` 已有 `contentBlocks` 字段（Message.contentBlocks），可据此区分中间 text 与收尾 text，但 Turn.vue 未用此字段。

3. **折叠态记忆 DEFERRED**。设计稿 HTML 内置了 localStorage 按 session+回合记忆（draft-message-stream.html JS 脚本）。Turn.vue:8 注释声明 `G-031 DEFERRED`，v1 仅 session 内保持。

---

## 三、7 类块逐类核查专节

### chat store 块类型契约（G2-006）现状

`chat.ts` 注释声明覆盖 4 类：text / thinking / tool_call / error。但设计 §4 要求 7 类。

| # | 块类型 | 设计要求 | chat.ts 类型覆盖 | Block.vue 渲染 | 判定 |
|---|--------|---------|-----------------|---------------|------|
| ① | User Message | 靠右气泡，无标签行 | `role:'user'`（message 级） | Turn.vue:11-13 直接渲染 content | ✅ |
| ② | Output Text | 两种渲染：中间折进 trace / 收尾恒显 | `ContentBlockType:'text'` + `contentBlocks` 字段 | Turn.vue:48-53 summaryText 全当收尾 | ⚠ |
| ③ | Reasoning | 紫底斜体，归折叠条计数 | `thinking` 数组（appendAssistantChunk） | Block.vue:15-21 type='thinking' | ⚠ |
| ④ | Tool Call | 青色 mono + 结果 + 失败红框 | `toolCall` 数组（tool_call_start/end） | Block.vue:24-40 type='tool' | ✅ |
| ⑤ | File Changes | A/M/D badge + 行数 + 跳 Diff | ❌ 无对应类型/字段 | ❌ 无渲染 | ❌ |
| ⑥ | Steer/Followup | 靠右 pending 气泡，虚线+脉冲圆点 | `sendMode` 字段存在但未用于渲染 | ❌ 无渲染（G-019） | ❌ |
| ⑦ | System | 配额/上下文/模型切换，灰底折叠 | `role:'system'` 存在但未参与 turns 分组 | ❌ 无渲染 | ❌ |

### 各块详细差异

#### ② Output Text — 中间/收尾未拆分（⚠）

- **设计证据**：draft-message-stream.html §4 规则表：「Output Text ★ 一种类型·两种渲染：①中间产出→折进执行流程（下划线行）；②收尾位→固定不折叠」
- **实现证据**：Turn.vue:84-86 将所有 assistant.content 拼接为 `summaryText`，无论中间还是收尾。`contentBlocks` 字段可区分但未被使用。
- **影响**：中间阶段的文本碎片（如在 tool_call 前输出的 "我来分析一下..."）会混入收尾 summary，不符合设计"收尾是稳定的回合焦点"的意图。

#### ③ Reasoning — 独立折叠缺失（⚠）

- **设计证据**：draft-message-stream.html §4：「紫底斜体，归折叠条 N reasoning 计数；**长块可单独再折叠**」
- **实现现状**：Block.vue 的 thinking 块（:18-21）仅显示 content 纯文本，无独立折叠 UI。`ThinkingBlock.collapsed` 字段已定义（shared/message.ts:23），但 Block.vue 未响应此字段。
- **差异**：长 reasoning 块（如 200 行推理）展开后占据大量空间，无独立折叠能力。

#### ⑤ File Changes — 完全缺失（❌）

- **设计来源**：flow-2-code-review/spec.md §S3 + §状态机·变更集卡
- **设计要求**：
  - 回合默认可见，A/M/D badge + 行数统计（+48 −12 等）
  - 点行→Side Drawer Diff
  - 5 态状态机：accumulating → ready → partially-reviewed → resolved / superseded
- **实现现状**：全项目搜索无 FileChanges 组件、无 file-changes 块渲染、chat store 无对应数据字段
- **影响**：这是**本 wave 最严重的缺失**——FileChanges 是回合折叠的两个恒显锚点之一，缺失导致用户完全看不到本回合的文件改动情况。

#### ⑥ Steer/Followup — DEFERRED（❌）

- **关联 W12 G-019**：W12 审查确认 steer/followup 提交逻辑 + pending 气泡全被标记 DEFERRED
- **实现现状**：`sendMode` 字段已在 shared/message.ts 定义（'send'|'steer'|'follow-up'），但 message-stream 层不读取此字段，不渲染 pending 气泡
- **判定**：关联 W12 同一根因，不作为独立缺失

#### ⑦ System — 完全缺失（❌）

- **设计来源**：draft-message-stream.html §4 规则表：「System 配额/上下文/模型切换，灰底折叠。Error 非独立类型，挂 Tool Call 块渲染红框」
- **实现现状**：error 已通过 `message.error` / `message.stream_error` 挂到 assistant message 上（chat.ts:159-190），但系统级通知（配额告警、上下文窗口切换、模型切换）无独立块类型渲染。`role:'system'` 的 message 在 messageTurns.ts 的 groupTurns 中不被处理（只处理 user/assistant），会被静默丢弃。
- **影响**：配额告警、上下文窗口切换等系统事件对用户不可见。

---

## 四、条目详情卡（⚠/❌ 展开）

### [WP-L3-05] 回合折叠机制 — FileChanges 锚点缺失

- **层级位置**：L3 · Panel.MessageStream.回合折叠
- **设计要求**：默认折叠，只显 Summary + File Changes 两个锚点。panel/spec.md §message-stream：「其余内容折叠为一条 pill」
- **实现现状**：Summary ✅ 恒显（Turn.vue:48-53），FileChanges ❌ 不存在。Turn.vue 无 `turn-files` 渲染，messageTurns.ts 无 fileChanges 字段。
- **判定**：⚠
- **差异描述**：折叠态的两个恒显锚点只实现了一个。FileChanges 是"这个回合改了哪些文件"的核心信息，缺失后折叠态信息量减半。
- **设计证据**：panel/spec.md §message-stream 列出的折叠态两元素：「1. Summary […] 2. File Changes（文件变更清单）」。draft-message-stream.html §1 回合 #1/#2 的 `.turn-files` 节完整展示。
- **实现证据**：Turn.vue 全文搜索 `file`/`files`/`turn-files` 均无匹配。messageTurns.ts MessageTurn 接口无 fileChanges 字段。
- **初步根因**：疑似根因→FileChanges 块缺失。需要从 chat store 类型契约开始补（在 Message 中增加 fileChanges 字段，与 flow-2 变更集卡数据模型对齐）。
- **修复性质**：长期方案 · 治本。需要补：① shared/message.ts 增加 FileChange 接口 + Message.fileChanges 字段，② runtime 输出文件变更事件，③ chat.ts 处理文件变更 chunk，④ Turn.vue 渲染 `.turn-files` 节。

### [WP-L3-08] Output Text — 中间/收尾未拆分

- **层级位置**：L3 · Panel.MessageStream.OutputText
- **设计要求**：一种类型·两种渲染——中间产出折进执行流程（vis-hide），收尾位固定不折叠（vis-show）。draft-message-stream.html §4 规则表。
- **实现现状**：Turn.vue:84-86 取所有 assistant.content 拼接为 `summaryText`，全当收尾。未使用 `contentBlocks` 区分中间 text 与收尾 text。
- **判定**：⚠
- **差异描述**：中间阶段的 text 碎片（"我来分析一下"等）混入收尾 summary，模糊了"收尾是稳定回合焦点"的设计意图。
- **设计证据**：draft-message-stream.html §4 规则表 Output Text 行：「中间产出→折进执行流程（下划线行）；收尾位→固定不折叠」
- **实现证据**：Turn.vue:84-86 `summaryText = assistants.map(a => a.content).filter(Boolean).join('\n\n')`，无中间/收尾区分逻辑。contentBlocks 字段已存在于 Message 类型（shared/message.ts:44-46）但未被使用。
- **初步根因**：孤立问题。contentBlocks 字段提供了区分能力，渲染层未接入。
- **修复性质**：短期方案 · 治标（可先手动把最后一条 text 块当收尾，其余折进 trace）。长期方案需与 runtime 协商收尾 text 标记规则。

### [WP-L3-09] ReasoningBlock — 独立折叠缺失

- **层级位置**：L3 · Panel.MessageStream.Reasoning
- **设计要求**：长 reasoning 块可独立再折叠（draft-message-stream.html §4：「长块可单独再折叠」）
- **实现现状**：Block.vue:18-21 直接显示 content 纯文本。ThinkingBlock.collapsed 字段已定义（shared/message.ts:23）但未被 Block.vue 使用。
- **判定**：⚠
- **差异描述**：长 reasoning 无法独立折叠。200 行推理展开后占据大量空间，用户需要此能力。
- **设计证据**：draft-message-stream.html §4 规则表 Reasoning 行：「紫底斜体，归折叠条 N reasoning 计数；长块可单独再折叠」
- **实现证据**：Block.vue:15-21，无折叠 UI。ThinkingBlock.collapsed 字段未被引用。
- **初步根因**：孤立问题。ThinkingBlock 数据模型已就绪（collapsed 字段），Block.vue 未接。
- **修复性质**：短期方案 · 治标（Block.vue 加 `@click` toggle + `v-if` 折叠内容展示摘要行）。

### [WP-L3-11] FileChanges — 变更集聚合 5 态状态机（❌ 完全缺失）

- **层级位置**：L3 · Panel.MessageStream.FileChanges
- **设计要求**：flow-2-code-review/spec.md §S3 + §状态机。5 态状态机：accumulating → ready → partially-reviewed → resolved / superseded。回合默认可见 A/M/D badge + 行数统计。点行→Side Drawer Diff。
- **实现现状**：未找到（全项目搜索 `fileChanges`/`FileChange`/`turn-files` 无渲染实现）。chat store 无 fileChanges 字段，messageTurns.ts 无相关分组逻辑，无独立组件。
- **判定**：❌
- **差异描述**：这是本 wave 最严重的缺失。FileChanges 是回合折叠的另一个恒显锚点，是 flow-2 的核心交互。当前实现完全没有此模块。
- **设计证据**：flow-2-code-review/spec.md §S3：「Agent 完成文件改动后，变更集卡出现在 assistant 消息下方。卡片内容：'N 个文件变更 · [查看全部]'」。§状态机 5 态枚举。draft-message-stream.html §1 `.turn-files` 节完整视觉。
- **实现证据**：全项目无 FileChanges 组件/渲染。chat store Message 接口无 `fileChanges` 字段。
- **初步根因**：已确认缺失。这是 flow-2（代码变更审查）的核心模块，未进入实现阶段。
- **修复性质**：长期方案 · 治本。需要：① shared/message.ts 增加 FileChange 接口，② runtime 输出文件变更事件，③ chat.ts 处理文件变更数据流，④ 新建 `message-stream/FileChanges.vue` 渲染组件（含 5 态状态机），⑤ Turn.vue 集成。

### [WP-L3-12] Steer/Followup pending 气泡（❌ DEFERRED）

- **层级位置**：L3 · Panel.MessageStream.SteerFollowup
- **设计要求**：draft-message-stream.html §4 规则表：「Steer/Followup 靠右 pending 气泡，虚线 + 脉冲圆点；入流后与普通用户气泡同形态」
- **实现现状**：未找到（G-019 DEFERRED）。shared/message.ts 有 `sendMode` 字段但 message-stream 层不读取。W12 确认 steer/followup 提交逻辑全部 DEFERRED。
- **判定**：❌
- **差异描述**：关联 W12 G-019。提交逻辑和渲染块均未实现。
- **设计证据**：draft-message-stream.html §4 规则表 Steer/Followup 行。§3 未决⑥：「时机归 runtime 接口层」
- **实现证据**：W12 审查报告 G-019 确认：「steer/followup 提交逻辑 + pending 气泡全被标记 DEFERRED」
- **初步根因**：关联 W12 G-019（steer/followup 整体 DEFERRED）。
- **修复性质**：长期方案 · 治本。与 W12 协同：先实现 composer 的 steer/followup 提交，再在 message-stream 做 pending 气泡。

### [WP-L3-13] SystemNotice（❌ 完全缺失）

- **层级位置**：L3 · Panel.MessageStream.System
- **设计要求**：draft-message-stream.html §4 规则表：「System 配额/上下文/模型切换，灰底折叠」
- **实现现状**：未找到。`role:'system'` 的 message 在 messageTurns.ts groupTurns 中不被处理（只处理 user/assistant），静默丢弃。error 已挂 tool 块（符合"Error 非独立类型"设计），但配额告警等系统通知无独立块。
- **判定**：❌
- **差异描述**：系统级通知完全不可见。`role:'system'` 消息到达 chat store 后无法渲染——messageTurns.ts 不在 user/assistant 分支中处理。
- **设计证据**：draft-message-stream.html §4 规则表 System 行。
- **实现证据**：messageTurns.ts:44-58 — 只处理 `role === 'user'` 和 `role === 'assistant'`，system 角色被跳过。Turn.vue 无 system 渲染分支。
- **初步根因**：已确认缺失。需从 chat store 类型契约 + messageTurns 分组扩招。
- **修复性质**：长期方案 · 治本。需在 messageTurns.ts 增加 system 消息分组，Turn.vue 增加 system 块渲染。

### [WP-L3-14] 消息操作菜单（❌ 完全缺失）

- **层级位置**：L3 · Panel.MessageStream.消息操作菜单
- **设计要求**：flow-2-code-review/spec.md §状态机·消息操作菜单：「hover 用户消息 → 显示 ··· → 菜单：编辑并重发 / 复制 / 引用到新消息 / 删除（带确认）」
- **实现现状**：未找到。Turn.vue 的 `.bubble-user` 无 hover 菜单交互，无右键菜单。
- **判定**：❌
- **差异描述**：critique P0 短板。用户无法编辑重发或引用消息，删除需去 sidebar。
- **设计证据**：flow-2-code-review/spec.md §状态机·消息操作菜单。
- **实现证据**：Turn.vue:11-13 — `.bubble-user` 只是 `<div>{{ turn.user.content }}</div>`，无任何交互。全项目搜索 `edit and resend`/`quoteMessage`/`deleteMessage` 无菜单组件。
- **初步根因**：已确认缺失。这是 critique P0 标记的功能。
- **修复性质**：长期方案 · 治本。需新建 `message-stream/MessageContextMenu.vue`，集成到 Turn.vue user 气泡 hover 态。

---

## 五、根因关联标注

### 与 W01 全局根因清单的关联

| 根因 ID | 本 wave 关联点 | 详情 |
|---------|--------------|------|
| **RC-04** | Turn.vue 背景 token 注释与实现不一致 | Turn.vue:120 注释 `/* user 气泡：靠右，surface-2 底 */`，实际 CSS Turn.vue:122 `background: var(--surface-hover)`。设计稿 `.bubble-user` 使用的是 `background: var(--surface-2)`（draft-message-stream.html:83）。RC-04 确认 `--surface-2` 在 style.css 和 design-tokens.md SSOT 中均未定义，但 draft HTML 内联了 `--surface-2: #1b1b20`。当前 `--surface-hover: #1f1f26` 与 `--surface-2: #1b1b20` 视觉近似但不等价。 |
| RC-01/02 | 不相关 | MessageStream 无 settingsStore 依赖 |

### 与 W12（Composer）的关联

| W12 ID | 关联描述 |
|--------|---------|
| W12 G-019 | steer/followup overall DEFERRED。W12 S7 pending 气泡和 W11 WP-L3-12 Steer/Followup 块同源 DEFERRED。修复时需 W11（气泡渲染）+ W12（提交逻辑）协同。 |

### 与 W10（PanelHeader）的关联

W10 确认 PanelHeader 状态点与 SessionItem 同源（deriveStatus），回合折叠的 working/complete 态依赖于 Message.status，与 header 状态无直接耦合。**无冲突**。

---

## 六、Wave 小结

### 审查条目数
共审查 **10 个锚点**：
- ✅ 一致：**3**（WP-L3-06 pill、WP-L3-07 UserMessage、WP-L3-10 ToolCallCard）
- ⚠ 偏差：**3**（WP-L3-05 折叠加 FileChanges 缺失、WP-L3-08 OutputText 中间/收尾未拆分、WP-L3-09 Reasoning 独立折叠缺失）
- ❌ 缺失：**4**（WP-L3-11 FileChanges 5 态、WP-L3-12 Steer/Followup、WP-L3-13 SystemNotice、WP-L3-14 消息操作菜单）

### 疑似根因聚类

| 根因聚类 | 关联锚点 | 本质 |
|---------|---------|------|
| **FileChanges 块缺失** | WP-L3-05, WP-L3-11 | chat store 类型契约只覆盖 4 类，缺失 file-changes 整个数据通道（shared types → runtime 输出 → store → 渲染） |
| **块类型契约不完整** | WP-L3-05, WP-L3-11, WP-L3-12, WP-L3-13 | 设计 7 类 → 实现 4 类（chat.ts G2-006 注释自称覆盖 4 类），3 类完全缺失 |
| **RC-04 背景 token 不一致** | WP-L3-07 | Turn.vue 注释 vs CSS vs draft 三源不一致，`--surface-2` 未落地 |
| **G-019 steer/followup DEFERRED** | WP-L3-12 | 跨 W11/W12 的整体延后，提交+渲染均未实现 |

### 跨 wave 依赖提示

1. **FileChanges → flow-2 整体**：WP-L3-11 缺失是整个 flow-2（代码变更审查）未启动的症状。需确认 flow-2 的实现计划和时间线。
2. **Steer/followup → W12 Composer**：WP-L3-12 与 W12 G-019 同源，两个 wave 需协同修复。
3. **RC-04 → W01**：Turn.vue 背景 token 是 RC-04 的表现之一，需等 W01 SSOT 补登 `--surface-2` 后统一修正。
4. **Block.vue → FileChanges/System/SteerFollowup**：Block.vue 当前只处理 `thinking|tool` 两种 type，扩到 7 类需重构 Block.vue 的 type union。

### 命门评估

**回合折叠机制是 MessageStream 的核心交互命门**。当前实现了骨架（pill 折叠/展开 + working 态），但缺少 FileChanges（折叠态第二个恒显锚点）和中间 OutputText 拆分，使折叠态信息完整度仅约 50%。7 类块中 3 类完全缺失，剩余 4 类中 2 类有偏差（OutputText 中间/收尾未拆分、Reasoning 独立折叠缺失）。**当前实现能满足基本对话流，但不符合 v3 design spec 的完整度要求。**
