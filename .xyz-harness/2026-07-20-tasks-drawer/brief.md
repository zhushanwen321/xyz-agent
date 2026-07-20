# Tasks Drawer — 设计 Brief

> 分支：`feat-todo-goal-visualization`  
> 日期：2026-07-20  
> 状态：已确认，待实现

## 1. Feature Summary

在 SideDrawer 新增「Tasks」tab，常驻展示当前 session 的 goal（目标卡片）和 todo（任务清单）。解决两个问题：(a) goal/todo 状态在 UI 中无处可见；(b) 对话流被 todo/goal 的 tool call 噪音污染。Tasks tab 有数据时才出现，打开后自动 docked。

**用户**：长时间与 AI Agent 协作的开发者，需要在不离开对话流的情况下掌控 goal 进度和 todo 余量。

**成功标准**：用户任何时候打开 drawer 都能看到当前 goal 是什么、进度到哪、是否 blocked、还剩哪些 todo；对话流回归「思考 + 代码改动」的纯净度。

## 2. Primary User Action

**扫视**。用户瞥一眼 drawer 就能回答三个问题：goal 还活着吗？进行到哪一步？下一步要做什么？

不是「操作」——goal/todo 的创建和变更是 AI 通过 tool 完成的，用户在 drawer 里是**观察者**，唯一的主动操作是 goal blocked 时点 resume。

## 3. Design Direction

**Color strategy**：Restrained。冷蓝暗色画布，accent(#4f8ef7) 仅用于 goal ACTIVE 徽章 + 进度条填充；状态色（success/warning/danger）按语义点状使用（completed ✓ / blocked 徽章 / budget 超限）。大面积仍是 surface + muted 文字。

**Theme scene sentence**：开发者在深夜的暗色 IDE 里，目光在对话流和 drawer 之间来回切换，drawer 是余光可及的状态锚点，不能喧宾夺主要安静存在，但在 goal blocked 时必须能抓住注意力。

**Anchor references**：
- **Cursor 的右侧 panel**（密度参考）——信息层次清晰，不堆砌
- **Linear 的 issue 状态徽章**（语义色参考）——状态用小色块表达，克制
- **VS Code 的 Source Control 面板**（常驻感参考）——dock 后是工作区一部分，不是浮层

## 4. Scope

- **Fidelity**：production-ready（这是要 ship 的功能，不是 demo）
- **Breadth**：SideDrawer 的 Tasks tab（单个 tab 内的完整 UI）+ 对话流 Block.vue 的 tool call 过滤
- **Interactivity**：shipped-quality 组件，真实数据流（tool `__gui__` 缓存 + goal widget merge + extension:widgetGui 订阅）
- **Time intent**：polish until ship

## 5. Layout Strategy

Tasks tab 内自上而下两个区块（无 tab 切换，一屏可见）：

```
┌─ drawer body ─────────────┐
│  ┌─ Goal 卡片 ──────────┐ │  ← 顶部，常驻，blocked 时置顶 + 变色
│  │ [ACTIVE] fix-auth-bug │ │
│  │ objective 两行        │ │
│  │ ▓▓▓▓▓▓░░░░ 3/5        │ │
│  │ tokens 71% · 12m/30m  │ │
│  │ [Resume] ← 仅 blocked │ │
│  └───────────────────────┘ │
│                            │
│  任务清单            3/5   │  ← section header（计数右对齐）
│  ✓ 复现 token 过期场景    │
│  ✓ 定位循环点             │
│  ✓ 添加 maxRetry 守卫 VERIFY│
│  ◐ 编写单元测试    VERIFY │  ← in_progress 脉冲
│  ○ 更新文档               │
└────────────────────────────┘
```

**视觉层次**：
- Goal 卡片是「锚」（surface 底 + border + 阴影），todo 列表是「流」（无容器，靠 checkbox + 文字节奏）
- blocked goal 卡片用 warning 渐变背景 + warning 边框，**视觉权重压过 todo 列表**，确保用户余光能捕获
- todo 当前项（in_progress）用脉冲动画点，是列表里唯一的动态元素，自然吸引注意

**节奏**：goal 卡片与 todo section 之间留 `--space-3`(12px) gap；todo item 之间 `2px` 间距，紧凑但不挤。

## 6. Key States

### Goal 卡片

| 状态 | 视觉 | 数据 |
|---|---|---|
| active | default variant 卡片，accent 徽章 | objective + 进度条 + budget 行 |
| blocked | **warning 渐变背景 + warning 边框 + Resume 按钮 + 自动置顶** | 同上，徽章变 BLOCKED(warning) |
| complete | success variant 卡片，success 徽章 | 同上，进度条 100% success 填充 |
| paused | warning 徽章（不变色） | 同 active |
| budget_limited / time_limited | danger variant 卡片，danger 徽章 | 显示 ⊗ Token exhausted / ⏱ Time exhausted |
| cancelled | **卡片不显示**（goal extension `renderWidgetLines` 对 cancelled 返回 []） | — |
| 无 budget | 简化为 stats-line（slug + status + turn），无进度条 | — |

### Todo 列表

| 状态 | 视觉 |
|---|---|
| pending | ○ 空心圆，fg 文字 |
| in_progress | ◐ warning 色脉冲点，fg 文字 |
| completed | ✓ success 填充 checkbox，subtle 文字 + 删除线 |
| isVerification | 文字右侧紫色 `VERIFY` 小标签 |

### Tasks tab 整体

| 状态 | 视觉 |
|---|---|
| 有 goal + 有 todo | 完整布局（goal 卡片 + todo section） |
| 有 goal，无 todo | 只显 goal 卡片，todo section 隐藏 |
| 无 goal，有 todo | 只显 todo section，goal 卡片位置空（不占位） |
| 无 goal 且无 todo | **Tasks tab icon 不显示**（count=0 时 tab 隐藏） |
| loading（tool `__gui__` 尚未到达） | drawer body 显示骨架屏（goal 卡片轮廓 + 3 行 todo 占位） |
| todo 状态刚变化 | Tasks tab icon 短暂高亮（accent 色脉冲 300ms），避免静默操作 |

### 对话流

| 状态 | 视觉 |
|---|---|
| `todo` tool call（任意 action） | **完全不渲染**（Block.vue `v-if` 跳过） |
| `goal_control` tool call（任意 action，含 report_blocked） | **完全不渲染** |

## 7. Interaction Model

**入口**：drawer header 的 Tasks icon（✓ 图标，与 Git/Terminal/Browser/Doc/Detail 并列）。有数据时显示 + 带 count badge（`3/5`）；无数据时 icon 隐藏。

**打开行为**：点击 Tasks icon → drawer 打开 + Tasks tab 激活 + **自动 docked**（docked = true，不会因失焦/切 panel 自动关）。用户仍可手动关（✕）或手动 undock（📌）。

**Goal 卡片交互**：
- 默认展示（无需点击展开）
- objective 文本超过 2 行自动截断，hover 显 tooltip 全文
- blocked 时 Resume 按钮点击 → 触发 `/goal resume`（走现有 command 通道，不开新口子）

**Todo 列表交互**：
- 纯展示，item 不可点击改状态（状态由 AI 通过 tool 改，用户不直接操作 todo）
- hover item 显淡背景（surface-hover），无其他交互
- verify 标签 hover 显 tooltip：「验证任务，完成前不可标记 goal complete」

**Drawer 关闭后再打开**：docked 状态记忆（session 级），重新打开仍是 docked + Tasks tab。

**切 session**：每个 session 独立的 drawer 状态（goal/todo 是 session 级数据，切 session 时 Tasks tab 内容切换）。

## 8. Content Requirements

### Copy（i18n key 走 `panel.tasks.*`）

- Tasks tab icon title：`任务` / `Tasks`
- Goal section：无显式 header（卡片自带 slug 作标题）
- Todo section header：`任务清单` / `Task list`，右侧 count `{done}/{total}`
- 空态（有 goal 无 todo）：不显示 todo section（不写「暂无任务」文案，直接隐藏区块）
- Resume 按钮：`恢复` / `Resume`
- VERIFY 标签 tooltip：`验证任务 — 必须完成才能结束 goal` / `Verification task — must complete before goal completion`

### 状态徽章文案（对齐 goal extension 的 GoalStatus 枚举）

| status | zh | en |
|---|---|---|
| active | `进行中` | `ACTIVE` |
| blocked | `已阻塞` | `BLOCKED` |
| paused | `已暂停` | `PAUSED` |
| complete | `已完成` | `COMPLETE` |
| budget_limited | `预算耗尽` | `BUDGET` |
| time_limited | `超时` | `TIMEOUT` |

### Budget 行格式

- 有 token + time budget：`tokens {used}k/{total}k · {timeUsed}m/{timeMinutes}m`
- 仅 token：`tokens {used}k/{total}k`
- 仅 time：`{timeUsed}m/{timeMinutes}m`
- budget 百分比 ≥ 70% 显 warning 色，≥ 90% 显 danger 色（对齐 goal extension 的 BUDGET_PERCENT_LOW/HIGH）

### 动态数据范围

- todo 数量：0-20（典型 3-8，超过 10 列表滚动）
- objective 长度：10-200 字符（超 2 行截断 + tooltip）
- goal status：6 种枚举（见上表）
- budget：token 0-2M，time 0-120min

## 9. 实现策略（非 UX，但 shape 要交代数据流）

### 数据源（两阶段）

**阶段 1（本次分支，xyz-agent 侧独立交付）**：
- **Todo**：在 `chat-message-effects.ts` 缓存最近一次 `todo` tool result 的 `details.__gui__`（list-tree GuiComponent）到 session 级 store。Tasks tab 读这个缓存。
- **Goal**：
  - 主数据 = 最近一次 `goal_control` tool result 的 `details.__gui__`（card GuiComponent，含 progress-bar + stats-line）
  - 实时 merge = 收到 goal 主动推的 ANSI widget（`extension:widget` widgetKey="goal"）时，解析出 `status` / `token%` / `time%`，merge 进缓存的 goal 卡片（覆盖 stats-line 的 status + progress-bar 的 current）
  - 解析失败则只用 `__gui__` 缓存（降级，不崩）

**阶段 2（goal extension 侧，跨仓库 PR，后续做）**：
- goal extension 的 `updateWidget` 改用 `guiSetWidget(ctx, "goal", buildGoalGui(state))` 推结构化 marker
- event-adapter 的 `GUI_WIDGET_MARKER` 解码已支持，xyz-agent 直接收 `extension:widgetGui` 结构化数据
- 阶段 1 的 ANSI merge 逻辑删除

### Store 新增

`stores/tasks.ts`（新文件）：session 级缓存 goal/todo 的最新 GuiComponent 快照。读写都按 sessionId 分区（对齐 chat.ts 的 `chatSessions: Map` 范式）。

### Block.vue 过滤

新增常量 `HIDDEN_TOOL_NAMES = new Set(['todo', 'goal_control'])`，在 tool call block 渲染前 `v-if="!HIDDEN_TOOL_NAMES.has(toolName)"` 跳过。过滤发生在 Block.vue 顶层，不影响 message-turns 的 block 数组结构（只是渲染层跳过）。

### Tasks tab icon 显隐

SideDrawer header 的 tab 列表改为 computed：基础五 tab（Git/Terminal/Browser/Doc/Detail）+ 条件 Tasks tab（`tasksStore.hasData(sessionId)` 时 push）。count badge = todo 的 `done/total`。

### Docked 自动化

`useSideDrawer` 新增逻辑：`setTab('tasks')` 时顺带 `docked = true`。切其他 tab 不自动 undock（保留用户手动 undock 的控制权）。

## 10. Recommended References

实现时优先参考：
- `reference/layout.md` —— goal 卡片 + todo 列表的双区块布局节奏
- `reference/product.md` —— register 为 product（design SERVES product），drawer 是工具不是主角
- `docs/page-design/design-tokens.md`（项目内）—— 色值/圆角/间距 SSOT
- `packages/renderer/src/components/panel/SideDrawer.vue`（项目内）—— 现有 tab 机制 + widget 订阅范式
- `packages/renderer/src/components/panel/message-stream/gui/Card.vue` / `ProgressBar.vue` / `ListTree.vue`（项目内）—— `__gui__` 已有的 GuiComponent 渲染器，goal 卡片和 todo 列表直接复用

## 11. Open Questions

**无遗留问题**。所有决策点已在前序对话确认：

| # | 决策 | 确认轮次 |
|---|---|---|
| 落点 | SideDrawer Tasks tab（非 Sidebar） | 轮 3 |
| docked 行为 | 打开 Tasks tab 自动 docked，不自动关 | 轮 4 |
| 对话流 tool call | todo + goal_control 全隐藏（含 report_blocked） | 轮 4 |
| 无数据时 | Tasks tab icon 不显示 | 轮 4 |
| 视觉密度 | 中等（demo 密度） | 轮 5 |
| blocked 处理 | 强引导（变色 + resume + 置顶） | 轮 5 |
| goal 数据源 | 阶段 1 `__gui__`+ANSI merge，阶段 2 extension 改推 marker | 轮 4 |

## 12. Anti-Goals

- **不做** Tasks tab 内的 goal/todo 编辑（用户不直接改状态，只观察 + blocked 时 resume）
- **不做** 多 goal 支持（goal extension 当前单 goal 语义，drawer 只展示当前 goal）
- **不做** 跨 session 的 goal/todo 汇总（Tasks tab 是 session 级，不是全局视图）
- **不做** 对话流内的状态条/徽章（方案 C 已否决，状态信息全归 drawer）
- **不把** drawer 变成常驻布局成员（保持 overlay/split 两种模式，docked 是状态不是结构变更）

## 13. 风险

1. **ANSI merge 解析脆**（阶段 1）：goal widget 的 ANSI 格式由 `renderWidgetLines` 控制，若 goal extension 改格式，merge 失效。缓解：解析失败降级到纯 `__gui__` 缓存，不崩；阶段 2 改推 marker 后此风险消除。
2. **todo `__gui__` 缓存陈旧**：AI 不调 todo tool 时，drawer 显示旧快照。但 todo 每次状态变都调 tool，实际上新鲜度可接受。不做主动轮询。
3. **隐藏 tool call 后用户无感**：若 drawer 没打开，todo 变化用户完全看不到。缓解：Tasks tab icon 的 count badge + 状态变化时脉冲提示，是「drawer 没打开」时的唯一信号。必要时考虑系统级 toast（本次不做，观察用户反馈）。
