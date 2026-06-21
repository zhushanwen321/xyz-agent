# Wave W10 — PanelHeader + Breadcrumb Popovers（面板头部业务组件层）

> 审查日期：2026-06-21
> 审查范围：PanelHeader 结构 + Breadcrumb 三段 + 分支 Popover（切换/新建）+ ⌘B 三态集成
> 设计来源：designs/v3-demo/workspace/spec.md §Header结构 + panel/spec.md + draft-breadcrumb-popovers.html + shell/spec.md §⌘B
> 实现来源：components/panel/PanelHeader.vue + Panel.vue + workspace/PanelContainer.vue
> W09 参考：.v3-audit/results/wave-W09-workspace-topology.md

---

## 一、Wave 汇总表

| ID | 层 | 区域.模块 | 组件/锚点 | 判定 | 设计来源 | 实现位置 | 根因标签 |
|----|----|----------|----------|------|---------|---------|---------|
| WP-L2-06 | L2 | Panel.PanelHeader | Header 结构：状态圆点 + session 名 + 目录 + …三点 + ×关闭 | ⚠偏差 | workspace/spec.md §Header结构 | PanelHeader.vue:16-75 | 孤立（⋯ DEFERRED + 高度偏差 4px） |
| WP-L3-01 | L3 | Panel.Breadcrumb | Breadcrumb：项目 ▸ 会话 ▸ 分支（仅分支段可点击） | ⚠偏差 | draft-breadcrumb-popovers.html §1 | PanelHeader.vue:26-52 | 孤立（三段渲染正确，L3 交互 DEFERRED） |
| WP-L3-02 | L3 | Panel.Breadcrumb | 分支切换 popover（git 状态前置：ahead/behind） | ❌缺失 | draft-breadcrumb-popovers.html §3 | PanelHeader.vue:15（注释标注 DEFERRED） | 孤立（G3 联调 DEFERRED） |
| WP-L3-03 | L3 | Panel.Breadcrumb | 新建分支 popover（内联表单，不开新弹层） | ❌缺失 | draft-breadcrumb-popovers.html §4 | 同上 | 孤立（G3 联调 DEFERRED） |
| WP-L3-04 | L3 | Panel.Breadcrumb | ⌘B 三态优先级集成（sidebar 折叠 + 未保存编辑时触发分支 popover） | ❌缺失 | shell/spec.md §⌘B + draft-breadcrumb-popovers.html §6 | PanelHeader.vue（无 ⌘B 监听逻辑） | 孤立（G-033 DEFERRED 第 3 态） |

**判定统计**：✅一致 x0 / ⚠偏差 x2 / ❌缺失 x3 / 🆕多余 x0

---

## 二、条目详情卡

### [WP-L2-06] Header 结构 — ⋯三点缺失 + 高度 4px 偏差

- **层级位置**：L2 · Panel.PanelHeader（panel/spec.md zone ①）
- **设计要求**：`[●状态圆点] session名 [📁 目录] [⋯三点] [×关闭]` + split/新建会话同槽位互斥按钮（workspace/spec.md §Header结构）
- **实现现状**：
  - 状态圆点：✅ 正确渲染，5 态色（running/waiting/done/stopped/error），数据源为 chat store 派生
  - session 名：✅ 正确，active 态用 `text-fg`，非 active 用 `text-muted`
  - 目录：✅ 正确，Folder 图标 + mono 字体 + 末两段截断
  - split/新建会话同槽位互斥：✅ 正确（W09 已确认 `v-if="!isDual"` / `v-else`）
  - ×关闭：✅ 双 panel 正确显示，hover 变 danger 色
  - ⋯三点更多：❌ 不渲染（注释：`三点更多 ⋯（G2-005 rename 等）全 DEFERRED，按 G3-002 hide 规则不显示`）
  - header 高度：⚠ `h-[38px]` vs draft-breadcrumb-popovers.html 卡 D `.main-header { height: 42px }`，偏差 4px
- **判定**：⚠偏差
- **差异描述**：
  1. 「三点更多」按钮按 G3-002 hide 规则未渲染——设计 spec 仍列在 header 结构中，属 DEFERRED 未实现
  2. header 高度 38px vs 设计 draft 42px——见下文"高度核查专节"详析
- **设计证据**：
  ```text
  /* workspace/spec.md §Header结构 */
  [●状态圆点] session名 [📁 目录]              [⋯三点] [×关闭]
  ```
- **实现证据**：
  ```html
  <!-- PanelHeader.vue:16 -->
  <header class="flex h-[38px] flex-shrink-0 items-center gap-2 border-b border-border px-3.5 pl-4 [-webkit-app-region:drag]">
  <!-- PanelHeader.vue:74-76 — 三点更多 ⋯ 不渲染 -->
  <!-- 三点更多 ⋯（G2-005 rename 等）全 DEFERRED，按 G3-002 hide 规则不显示 -->
  ```
- **初步根因**：孤立。⋯ 按钮属 G2-005 rename 功能，G3 联调阶段才实现；高度偏差属独立问题。
- **修复性质**：⋯ 按钮 — 长期方案（待 G3 联调）；高度 — 见专节

---

### [WP-L3-01] Breadcrumb 三段 — 结构正确，L3 交互缺失

- **层级位置**：L3 · Panel.Breadcrumb（header 内 breadcrumb 三段）
- **设计要求**：
  - L1（项目名）：静态文本，cursor: default，无 hover 背景，无 chevron ▾
  - L2（会话名）：静态文本，同上
  - L3（分支名）：mono 字体 + accent pill 背景，**可点击**触发 popover
  - 三段视觉层级明显分级（L1/L2 普通文本 vs L3 accent pill）
- **实现现状**：
  - 三段结构：✅ 正确渲染 `<ol>` → L1（Folder + dirName）▸ L2（sessionLabel）▸ L3（gitBranch）
  - 视觉分级：✅ L1/L2 用 `text-subtle`/`text-muted`，L3 用 `font-mono text-[11px] text-accent`——区分显著
  - L1/L2 无点击：✅ `<span>` 无 @click、无 cursor-pointer——正确未误加成可点击
  - L3 点击交互：❌ `<span>` 无 @click、无 cursor-pointer——与设计"仅分支段可点击"矛盾
  - 模板注释："popover 点击跳转 DEFERRED（shell/spec §八，属 G3 联调）；v1 纯展示"
- **判定**：⚠偏差
- **差异描述**：三段 DOM 结构完全正确，视觉分级也正确（L3 pill 权重明显高于 L1/L2）。但 L3 分支段渲染为纯静态 `<span>`，无 click handler、无 popover 触发逻辑。设计明确要求"仅分支段可点击"，实现侧标注 DEFERRED 但不改变判定——功能缺口存在。
- **设计证据**：
  ```css
  /* draft-breadcrumb-popovers.html §1 */
  .breadcrumb .crumb.branch {
    font: 10px/1 ui-monospace; color: var(--accent);
    background: var(--accent-soft); padding: 2px 6px;
  }
  .breadcrumb .crumb.branch:hover { background: rgba(79,142,247,0.22); }
  /* L3 是唯一带 hover 交互的 crumb */
  ```
- **实现证据**：
  ```html
  <!-- PanelHeader.vue:46-51 — L3 分支段无交互 -->
  <li class="min-w-0">
    <span class="truncate font-mono text-[11px] text-accent"
          :title="`分支：${gitBranch}`">
      {{ gitBranch }}
    </span>
  </li>
  ```
- **初步根因**：孤立。整个 breadcrumb popover 子系统属于 G3 联调范围，v1 阶段 breadcrumb 作为纯展示。
- **修复性质**：长期方案 — 待 G3 联调时给 L3 分支 `<span>` 添加 @click handler 触发 popover 组件。

---

### [WP-L3-02] 分支切换 popover — 完全缺失

- **层级位置**：L3 · Panel.Breadcrumb（分支切换 popover 子组件）
- **设计要求**：
  - 320px 宽 popover，从分支 crumb 正下方浮出，右对齐 panel 右边界
  - 分「本地」+「remote」两组，每组显示 ahead/behind 状态
  - **git 状态前置**：每条分支右侧 meta 显示 `HEAD` / `N ahead` / `N ahead · M behind` / `merged`
  - 搜索过滤：输入即时过滤本地+remote，命中段高亮
  - 键盘操作：↑↓ 移动、⏎ 切换、esc 关闭
  - 当前分支：✓ 前缀 + accent-soft pill 背景
- **实现现状**：不存在。PanelHeader.vue 无任何 popover 子组件渲染，无分支切换逻辑。注释标注"popover 点击跳转 DEFERRED（shell/spec §八，属 G3 联调）；v1 纯展示"。
- **判定**：❌缺失
- **差异描述**：完整的 320px popover 组件体系（分组 + git 状态前置 + 搜索过滤 + 键盘导航 + active/非 active 视觉态）均未实现。breadcrumb L3 当前只是静态文本。
- **设计证据**：draft-breadcrumb-popovers.html 卡 A（默认态 · 全分支列表）— 320×360 popover 含 popover-head / popover-search / popover-body（本地+remote 分组）/ popover-foot（键盘提示）
- **实现证据**：PanelHeader.vue 全文无 popover 相关组件引入、无分支列表数据拉取、无 popover 状态管理
- **初步根因**：孤立，G3 联调 DEFERRED。整个分支 popover 依赖 git 状态数据源（runtime git service 未联调），v1 不实现。
- **修复性质**：长期方案 — 需新建 `BranchPopover.vue` 组件，集成 `git service` ahead/behind 数据，挂载到 L3 分支 span 的 click handler。注：git 状态前置是关键 UX 决策，实现时不可遗漏。

---

### [WP-L3-03] 新建分支 popover — 完全缺失

- **层级位置**：L3 · Panel.Breadcrumb（新建分支内联表单）
- **设计要求**：
  - 在 popover 内点击「+ 新建分支」展开**内联表单**（不开独立 dialog/modal）
  - 字段：① 名称（monospace 输入，实时校验 `[a-z0-9/_-]+`、不以 `/` 结尾、不重名）；② 基础分支（默认当前分支）
  - 非法态：右侧 ✗（danger）+ 行下错误提示，「创建」按钮 disabled
  - 创建后行为：默认「创建并切换」，「仅创建」选项放创建按钮右侧下拉箭头
  - 取消回退到列表态（不关闭 popover）
- **实现现状**：不存在。无内联表单、无校验逻辑、无创建按钮。同 WP-L3-02。
- **判定**：❌缺失
- **差异描述**：完整的内联表单 + 实时校验 + 非法态已设计完毕（draft-breadcrumb-popovers.html 卡 C/H），实现侧零代码。
- **设计证据**：draft-breadcrumb-popovers.html 卡 C（新建分支态 · 内联表单：名称输入 + 基础分支下拉 + 创建/取消按钮）+ 卡 H（非法态：✗ 错误提示 + 规则说明 + disabled 创建按钮）
- **实现证据**：PanelHeader.vue 无任何新建分支相关逻辑
- **初步根因**：孤立，G3 联调 DEFERRED。依赖 git service 创建分支 API。
- **修复性质**：长期方案 — 在 BranchPopover.vue 内实现内联表单态，禁止使用 `<Dialog>` / `<Modal>` 组件（设计明确要求不开新弹层）。名称校验需前端先行（规则 `[a-z0-9/_-]+`），创建调 runtime git service。

---

### [WP-L3-04] ⌘B 三态优先级集成 — 完全缺失

- **层级位置**：L3 · Shell + Panel.Breadcrumb（全局快捷键冲突规约）
- **设计要求**：
  - shell/spec.md §⌘B 三态优先级矩阵（2026-06-19 定）：
    1. sidebar 展开 → ⌘B 收起 sidebar（最高优先）
    2. sidebar 折叠 + 无未保存编辑 → ⌘B 展开 sidebar
    3. sidebar 折叠 + 当前视图有未保存编辑 → ⌘B 触发分支 popover
  - 核心原则：⌘B 是 chrome 级 toggle，**不专属 popover**——popover 开着时任何 ⌘B 都先关 popover
  - mac 视觉提示：sidebar 折叠时 breadcrumb L3 旁短暂闪 ⌘B chip（200ms fade）
- **实现现状**：
  - PanelHeader.vue：无任何 ⌘B 事件监听逻辑
  - PanelHeader 不持有 sidebar 折叠状态、不持有"未保存编辑"状态
  - W03 已发现 ⌘B 仅 toggle sidebar（G-033 DEFERRED 第 3 态）
- **判定**：❌缺失
- **差异描述**：⌘B 三态优先级矩阵的完整集成逻辑（读 sidebar 折叠态 + 未保存编辑态 → 决策触发 popover 或 toggle sidebar）均未实现。当前 ⌘B 只有 W03 发现的基础 toggle（第 1/2 态），第 3 态及 popover 优先关闭逻辑完全缺失。
- **设计证据**：
  ```text
  /* shell/spec.md §全局快捷键 · ⌘B 三态优先级（2026-06-19 定） */
  on ⌘B:
    if popover 打开 → 关闭 popover
    else if sidebar 非折叠态 → toggle sidebar → 折叠态
    else if 当前视图 有未保存编辑 → 打开分支 popover
    else → toggle sidebar → 非折叠态
  ```
- **实现证据**：PanelHeader.vue 全文无 `⌘B` / `CmdB` / `keydown` / `KeyboardEvent` 等快捷键处理。PanelHeader 的 props 不包含 `sidebarCollapsed` 或 `hasUnsavedEdits` 状态。
- **初步根因**：孤立，G-033 DEFERRED。⌘B 三态集成需跨 Shell/PanelHeader 协调，属联调阶段任务。
- **修复性质**：长期方案 — 需在 AppShell.vue（或全局 keyboard composable）实现 ⌘B 三态优先级决策，第 3 态通过 emit 通知 PanelHeader 打开分支 popover。PanelHeader 自身不持有 ⌘B 监听（三态判断需要全局上下文）。

---

## 三、Header 高度核查专节（W03 提示）

### 问题：PanelHeader `h-[38px]` vs draft `height: 42px`

W03 提示 header 可能存在高度偏差。本 wave 逐一核查设计源和实现。

### 设计源核查

| 设计文档 | 高度值 | 来源 |
|---------|--------|------|
| workspace/spec.md §Header结构 | **未指定**数字高度 | 仅描述结构："单一 panel-header……[●状态圆点] session名 [📁 目录]" |
| draft-breadcrumb-popovers.html 卡 D | **42px** | `.main-header { height: 42px; }` |
| panel/spec.md | **未指定**数字高度 | zone ① panel-header 只有结构描述 |

**关键发现**：workspace/spec.md 和 panel/spec.md 两个权威 spec **均未指定 header 的精确像素高度**。42px 仅出现在 draft-breadcrumb-popovers.html 的 trigger 卡片（卡 D），该卡片本质是 breadcrumb 功能的 demo 上下文，不是 header 高度的权威 spec。

### 实现核查

```html
<!-- PanelHeader.vue:16 -->
<header class="flex h-[38px] flex-shrink-0 items-center gap-2 border-b border-border px-3.5 pl-4 [-webkit-app-region:drag]">
```

| 属性 | 值 | 备注 |
|------|-----|------|
| height | 38px | `h-[38px]` |
| padding-x | 14px / 16px (pl-4) | 左 16px 可能给 traffic light 留安全区 |
| border-bottom | 1px | border-border |

### 偏差分析

- 偏差值：4px（42 - 38）
- 相对偏差：~10.5%
- 权威性评估：draft-breadcrumb-popovers.html 的 42px header 是为了给 breadcrumb popover 留 8px 呼吸空间（"popover top = main-header 42px + 8px"），而不是为了定义 header 的视觉高度。header 高度本身无功能性要求，38px 或 42px 均合理。
- **判定**：⚠偏差（4px），但设计源对此没有强约束。建议以 38px 或 40px 为准，将 breadcrumb popover 的 top 偏移改为 `38px + 8px = 46px`（或 `40px + 8px = 48px`），而不是反过来要求 header 升高。

### 高度建议

**短期**：维持 38px，popover 对接时调整 top 偏移。不可因为 draft 中的 42px 盲目改 header 高度——panel 垂直空间紧张，每 1px 都宝贵。draft HTML 的 42px 只是为了给 popover 位置计算做参考值，非视觉设计评审后的精确值。

**长期**：若真机体验后觉得 header 过挤（状态点 7px + 文字 13px + padding），可提到 40px 做微调。38→40 增加 2px，不影响 panel 内容区观感。

---

## 四、RC-07 验证 · PanelHeader 状态点数据来源

### RC-07 描述

> "session derivedStatus 骨架 vs useSidebar 重复"——需要验证 PanelHeader 状态点数据来源（调哪个 store），确认是否存在两套实现之间的断裂。

### 调用链追踪

```
PanelHeader.status (prop)
  ← Panel.vue :status="status"
    ← PanelContainer.vue statusOf(leaf)
      → derivedStatus(leaf.sessionId).value
        → useSidebar().derivedStatus
          → deriveStatus(id, chat, isActiveStreaming) [useSidebar.ts:46-68]
```

### 数据源确认

PanelHeader 的状态点数据最终来源为 **`useSidebar.ts` → `deriveStatus()`**（第 46-68 行），该函数从 `useChatStore` 读取消息和流式状态派生 5 态：

```ts
export function deriveStatus(
  sessionId: string,
  chat: ReturnType<typeof useChatStore>,
  isStreaming: boolean,
): DerivedStatus {
  const msgs = chat.getMessages(sessionId)
  const last = msgs[msgs.length - 1]
  if (last?.role === 'assistant') {
    const tools = last.toolCalls ?? []
    if (tools.length > 0 && tools[tools.length - 1].status === TOOL_RUNNING) {
      return 'waiting'
    }
  }
  if (isStreaming || last?.status === STREAMING_STATUS) return 'running'
  if (!last) return 'done'
  if (last.status === ERROR_STATUS) return 'error'
  if (last.role === 'assistant' && last.isInterrupted) return 'stopped'
  return 'done'
}
```

### 与 SessionItem 的同源性

SessionItem（sidebar 会话项）的状态点数据来源：

```
SessionItem.status (prop)
  ← SessionList.vue :status="statusOf(id)"
    → useSidebar().derivedStatus → 同上 deriveStatus()
```

**结论**：PanelHeader 和 SessionItem 使用**完全相同的 `deriveStatus()` 函数**作为状态派生逻辑。两处的 `DerivedStatus` 5 态映射表（`map: Record<DerivedStatus, string>`）在 PanelHeader.vue:122-128 和 SessionItem.vue:57-63 **各自独立定义但内容完全一致**：

| 态 | PanelHeader.vue | SessionItem.vue |
|----|------|------|
| running | `bg-accent animate-pulse` | `bg-accent animate-pulse` |
| waiting | `bg-warning` | `bg-warning` |
| done | `bg-success` | `bg-success` |
| stopped | `bg-subtle opacity-50` | `bg-subtle opacity-50` |
| error | `bg-danger` | `bg-danger` |

### RC-07 双套 derivedStatus 评估

| 位置 | 状态 | 是否被 PanelHeader 使用 |
|------|------|------------------------|
| `useSidebar.ts` → `deriveStatus()` | **活跃**，完整实现 | ✅ 是 |
| `session.ts` store → `derivedStatus()` | **骨架**，恒返回 `'waiting'` | ❌ 否 |

`session.ts` 的 `derivedStatus` 是骨架占位——注释标注"骨架阶段返回合法默认 'waiting'，实现阶段填派生逻辑"。但 `useSidebar.ts` 已有完整实现，使得 session store 的这个函数成为**死代码**（dead skeleton），应在后续阶段移除或统一到单一声源。

**RC-07 对本 wave 的影响**：PanelHeader 状态点数据链路完整且正确，不受 session store 骨架影响。两套 `derivedStatus` 的冗余是代码清理问题，非功能性 bug。状态点 5 态色映射表在两处重复定义是重复代码，但不产生行为分歧（内容严格一致）。

---

## 五、根因关联标注

| 本 wave 问题 | 关联根因 | 关联性质 |
|-------------|---------|---------|
| WP-L2-06（⋯三点） | 无（孤立） | G2-005 rename DEFERRED |
| WP-L2-06（高度 4px） | 无（孤立） | draft vs 实现数值不一致，无 spec 强约束 |
| WP-L3-01～04（popover 全系） | 无（孤立） | G3 联调 DEFERRED，整套 breadcrumb popover 子系统未进入 v1 开发范围 |
| RC-07 验证 | 无（非本 wave 缺陷） | session store derivedStatus 是死骨架，但与 PanelHeader 无功能关联 |

**RC-01/02/06 影响评估**：PanelHeader 不依赖 `settingsStore` 或 `[data-theme]` 切换。状态点色值用 Tailwind class（`bg-accent`/`bg-warning`/`bg-success`/`bg-danger`/`bg-subtle`），均通过 CSS 变量间接引用 design tokens，不受 theme 切换影响。

---

## 六、Wave 小结

- **审查条目数**：5（✅一致 x0 / ⚠偏差 x2 / ❌缺失 x3 / 🆕多余 x0）
- **根因关联数**：0（无 RC 关联）
- **核心发现**：
  1. **Header 结构主体正确**：状态圆点 + session 名 + 目录 + split/新建 + 关闭按钮均实现到位。唯一缺口是「⋯三点更多」按钮（G2-005 DEFERRED）。
  2. **Breadcrumb 三段 DOM 正确，交互全缺**：L1/L2 正确渲染为静态文本（无误加成可点击），L3 正确渲染为 accent pill（视觉分级明显）。但 L3 点击交互 + popover 全系（切换/新建/⌘B）均未实现，属 G3 联调 DEFERRED。这不是实现错误，而是开发排期的自然阶段。
  3. **Header 高度 4px 偏差**：38px vs draft 42px。设计 spec（workspace/spec.md + panel/spec.md）均未指定精确高度值，仅 draft HTML 有 42px 参考。**建议保持 38px 或微调到 40px，不强制对齐 draft 的 42px**——draft 中的 42px 是为 popover 偏移计算设参考，非视觉设计评审定案。
  4. **RC-07 验证通过**：PanelHeader 状态点数据源为 `useSidebar.deriveStatus()`（从 chat store 消息派生），与 SessionItem 共用同一派生函数，5 态色映射表内容一致。session store 的 `derivedStatus` 骨架未被使用，属待清理死代码。
- **正向发现**：
  - 状态点 5 态系统（running/waiting/done/stopped/error）与 sidebar SessionItem 完全同源同逻辑，跨组件一致性优秀
  - L1/L2 静态文本实现正确——`<span>` 无 cursor-pointer、无 @click、无 chevron ▾，与设计"不参与导航动作"精确对齐
  - split/新建会话同槽位互斥逻辑已由 W09 确认正确，本 wave 不重复
  - 非 active panel 的 header 通过 Panel.vue 的 `opacity-50` 整体降低，header 内 session 名同步切换 `text-muted`——双层淡化语义正确
- **跨 wave 依赖提示**：
  - W03 提示的 header 高度偏差已在本 wave 核实：偏差 4px 存在，但设计源无强约束，建议不强制对齐
  - WP-L3-02/03 popover 缺失会影响 W11（composer/git-zone）的 git 操作流程——分支切换是 git 操作的前置入口
  - Breadcrumb popover 子系统（切换/新建）建议作为独立 sub-wave 在 G3 阶段集中实现，避免分散到各 wave 零散修补
