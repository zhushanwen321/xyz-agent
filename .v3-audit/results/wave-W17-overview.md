# Wave W17 · Overview 审查结果

> **审查员**：W17 (A-OV) 执行员（自顶向下，L1-L3 独立 Region）
> **审查范围**：Overview.vue + SessionCard.vue + navigation store + useSidebar goOverview
> **审查日期**：2026-06-21
> **设计来源**：overview/spec.md + draft-overview.html + draft-entry.html + ADR-0005
> **W01 输入**：RC-09（SessionItem grid 无列定义）→ 核查 SessionCard 是否有同类布局问题
> **先前发现**：W07 RC-09 已确认（SessionItem 垂直堆叠）/ RC-10（spec-draft 激活标识冲突）

---

## 一、Wave 汇总表

| ID | 层 | 区域.模块 | 组件/锚点 | 判定 | 设计来源 | 实现位置 | 根因标签 |
|----|----|----------|----------|------|---------|---------|---------|
| OV-L1-01 | L1 | Overview | 独立 L1 Region，与 Sidebar/Workspace 并列 | ✅ | overview/spec.md §背景 + ADR-0005 | MainPanel.vue:16 view 路由 + Sidebar.vue 持久 | — |
| OV-L2-01 | L2 | Overview | 入口：sidebar 按钮 + 覆盖 workspace | ✅ | draft-entry.html + ADR-0005 §决策 | Sidebar.vue:33-52 按钮 + useSidebar.goOverview() | — |
| OV-L2-02 | L2 | Overview | 布局三层：工具栏→卡片网格→空状态 | ⚠ | overview/spec.md §布局 | Overview.vue:15-55 三层存在但工具栏残缺 | 孤立 |
| OV-L3-01 | L3 | Overview | 工具栏：新建+筛选多选chip+排序下拉+视图密度 | ⚠ | overview/spec.md §筛选与排序 | Overview.vue:18-32 仅标题+计数+新建 | 孤立 |
| OV-L3-02 | L3 | Overview | Session 卡片 6 区信息结构 | ⚠ | overview/spec.md §Session卡片信息结构 | SessionCard.vue:27-56 4 区实现，2 区缺失 | 孤立 |
| OV-L3-03 | L3 | Overview | 响应式网格：宽屏4列/笔记本3列/窄屏2列 | ✅ | overview/spec.md §布局 | Overview.vue:97-101 auto-fill minmax(280px,1fr) | — |
| OV-L3-04 | L3 | Overview | 卡片激活态：Card-Active inset accent ring（禁左竖条） | ✅ | draft-overview.html §3 + DEC-01 裁决 | SessionCard.vue:35 `ring-1 ring-inset ring-accent` | — |
| OV-L3-05 | L3 | Overview | 交互：卡片click→workspace载入session | ✅ | overview/spec.md §交互 | SessionCard.vue:38 emit('open')→Overview.vue selectSession | — |
| OV-L3-06 | L3 | Overview | 空状态+与SessionList分工 | ✅ | overview/spec.md §边缘状态+§分工 | Overview.vue:43-51 空态，grid vs sidebar 单列 | — |

**判定分布**: ✅ 6 / ⚠ 3 / ❌ 0 / 🆕 0

---

## 二、★ SessionCard 原子复用 + 布局核查专节

### 2.1 原子复用状态

Spec 要求：SessionCard = SessionItem 的「鸟瞰放大版」，**复用同一信息原子**（状态圆点、标题、分支 pill），密度上调一档。

| 信息原子 | SessionItem 实现 | SessionCard 实现 | 是否复用 |
|---------|-----------------|-----------------|---------|
| **相对时间** | `formatRelativeTime()` from `@/composables/logic/formatTime` | `formatRelativeTime()` from `@/composables/logic/formatTime` | ✅ 同源 composable |
| **状态点 5 态** | Tailwind class map（`bg-accent animate-pulse` 等） | Scoped CSS class map（`.status-dot--running` 等） | ⚠ 逻辑同源（color 枚举一致），**实现独立** |
| **状态点 pulse 动画** | Tailwind `animate-pulse`（整点淡入淡出） | Scoped CSS `pulse-accent` keyframes（`box-shadow` 同心环扩张 0→5px） | ❌ **两种动画机制**——SessionCard 用的是 draft 原版同心环，SessionItem 用的是 Tailwind 捷径 |
| **分支 pill** | 内联 `<span class="text-accent">` | `<span class="bg-accent-soft ... text-accent">` | ⚠ 样式不同，SessionCard 有 bg 容器 |
| **组件级复用** | — | SessionCard **不 import** SessionItem | ❌ 两个组件完全独立实现 |

**结论**：两个组件在逻辑层共享 `formatRelativeTime` composable，但视觉层（状态点、pulse 动画、pill）各自独立实现。Spec 说的「复用信息原子」落在 **逻辑复用**层面（同一 composable、同一 color 枚举），未做到组件复用。这不构成缺陷——卡片和列表项本就该是不同的组件形态，强行共享会导致 props 爆炸。

**但状态点 pulse 动画的两种实现是个问题**：SessionCard 的 `pulse-accent` keyframes 更接近 draft HTML 的 `pulse-ring`（`box-shadow` 同心环扩张），而 SessionItem 用的 `animate-pulse` 是捷径。W07 已将此标为 SB-L3-02 ⚠，此处确认 SessionCard 路径独立且**反而更正确**。

### 2.2 ★ RC-09 布局断裂核查

W07 确认 SessionItem 用 `grid` 无列定义导致垂直堆叠 3 行（RC-09）。**核查 SessionCard 是否有同样问题**：

- SessionCard 容器：`flex flex-col gap-2.5` → 垂直排列（卡片式，正确）
- 头部子容器：`flex items-center gap-2` → 水平排列，状态点 + 标题 + 分支 pill 同行 ✅
- 摘要区：`line-clamp-2` 独立块 ✅
- 指标行：`flex items-center gap-3.5` → 水平排列，改动+回合+时间同行 ✅

**SessionCard 无 RC-09 同类问题。** 卡片式 `flex flex-col` 是设计意图（垂直堆叠 6 区），不同于列表项的 `flex row` 需求。头部同行使用 `flex items-center`，正确。

### 2.3 信息密度对比（与 SessionList 分工验证）

| 维度 | Session List | Overview SessionCard | 取向差异 |
|------|-------------|---------------------|---------|
| 布局 | 单列紧凑 | 网格（3-4列） | ✅ |
| 信息量 | 标题 + 分支 + 时间 | 标题 + 分支 + 摘要 + 指标 + 时间 | ✅ 密度上调 |
| 摘要 | 无 | 末条 assistant 1-2 行 | ✅ 增量 |
| 指标 | 无 | 改动文件/回合数 | ✅ 增量 |
| 后台 agent | 无 | DEFERRED（设计有，render 无） | ⚠ 未实现 |
| 角标 | 无（W07 未实现） | DEFERRED（设计有，render 无） | ⚠ 未实现 |

**未退化为"放大版 SessionList"**——Overview 有格子布局、摘要、指标三大结构性增量。分工明确。

---

## 三、★ Card-Active 激活态核查专节

### 3.1 Render 实现

```html
<!-- SessionCard.vue:35 -->
:class="active
  ? 'border-transparent bg-surface-hover ring-1 ring-inset ring-accent'
  : 'border-border bg-surface hover:border-border-strong hover:bg-surface-hover'"
```

### 3.2 对照设计

| 检查项 | 设计 draft | Render | 一致 |
|--------|-----------|--------|------|
| 激活标识形式 | `inset 0 0 0 1px accent`（inset ring） | `ring-1 ring-inset ring-accent` | ✅ Tailwind ring-inset = CSS inset box-shadow |
| 底色 | `background: var(--surface-2)` | `bg-surface-hover` | ⚠ 轻微色差：draft 用 `--surface-2`，render 用 `--surface-hover`（略暗） |
| 边框 | `border-color: transparent` | `border-transparent` | ✅ |
| 无左竖条 | 明确"弃左竖条" | 无 absolute left bar | ✅ |

### 3.3 DEC-01 遵循

DEC-01 裁决：SessionItem 改 inset ring（列表项），Panel 保留四层（工作区）。Overview SessionCard 属于「卡片」语境——应用 inset ring。

**Render 严格遵守。** SessionCard 激活态使用 `ring-1 ring-inset ring-accent`，无左侧竖条。与 design draft §3 完全一致。

### 3.4 与 W07 发现 RC-10 的关联

W07 发现 SessionItem 激活态仍在用左竖条（`absolute left-0 w-0.5 bg-accent`），与 draft §4 inset ring 裁决冲突。**SessionCard 则走在正确路径上**——已在用 inset ring。两个组件对此裁决的采纳程度不一致：

| 组件 | 激活标识 | 与 draft §4 裁决一致 |
|------|---------|-------------------|
| SessionItem (sidebar) | 左竖条 | ❌（W07 SB-L3-03 ⚠ = RC-10） |
| SessionCard (overview) | inset ring | ✅ |

**这根因仍属 RC-10 范围**，SessionItem 需对齐到 SessionCard 的路径。

---

## 四、条目详情卡

### OV-L2-02 · 布局三层存在但工具栏残缺

- **层级位置**：L2 · Overview 容器
- **设计要求**：overview/spec.md §布局 — 自上而下三层：工具栏（新建+筛选+排序+视图密度切换）→ 卡片网格（响应式）→ 空状态（session=0）
- **实现现状**：Overview.vue 三层结构存在——`<header>`（工具栏）→ `<ScrollArea>`（网格）→ `<div>`（空状态）。但工具栏仅含标题 + 计数 badge + 新建按钮，**筛选 chip、排序下拉、视图密度切换均未渲染**。
- **判定**：⚠
- **差异描述**：三层结构骨架完整，工具栏内容不完整。模板注释声明"DEFERRED（spec §9）：卡片筛选/排序/批量操作（工具栏只留新建 + 计数）；⌘⇧O 切换快捷键（G3-003 v1 不做）；后台 agent 进度聚合（flow-3）"。筛选/排序是 spec 核心交互（spec §筛选与排序），非 v1 可 defer 项。
- **设计证据**：
  ```html
  <!-- draft-overview.html §1 工具栏 -->
  <div class="bar">
    <button class="new">新建会话 ⌘N</button>
    <div class="sep"></div>
    <span class="gl">状态</span>
    <span class="chip on">running</span>
    <span class="chip on">waiting</span>
    <span class="chip">done</span>
    <span class="chip">error</span>
    <div class="sep"></div>
    <span class="gl">标记</span>
    <span class="chip on">未读</span>
    <span class="chip">有后台 agent</span>
    <span class="chip">冲突</span>
    <div class="sort">排序
      <select><option>最近活动</option>...</select>
    </div>
  </div>
  ```
- **实现证据**：
  ```html
  <!-- Overview.vue:18-32 工具栏仅标题+计数+新建 -->
  <header class="mb-3.5 flex items-center gap-2.5">
    <h1>概览</h1>
    <span class="rounded-full ...">{{ session.list.length }} 个会话</span>
    <Button variant="ghost" @click="onNew"><Plus />新建<kbd>⌘N</kbd></Button>
  </header>
  ```
- **初步根因**：孤立 — 筛选/排序/视图密度属于 DEFERRED（按 spec §遗留"视图密度切换初版固定舒适档"），但 toolbar 作为独立组件应预留结构插槽，当前简化版无扩展点。
- **修复性质**：短期方案 · 治标（当前 v1 可接受）；长期需实现筛选 chip 组件 + 排序下拉 + 密度切换。

---

### OV-L3-01 · 工具栏四要素仅二

与 OV-L2-02 共卡（同一工具栏）。**不单列**。

详情见 OV-L2-02。

---

### OV-L3-02 · Session 卡片 6 区信息结构部分实现

- **层级位置**：L3 · Overview.SessionCard
- **设计要求**：overview/spec.md §Session 卡片信息结构 — 6 区：头（状态点+标题+分支pill）/ 摘要（末条assistant 1-2行）/ 指标（改动文件数+消息回合+运行时长）/ 后台agent（进度条+计数）/ 时间（相对时间）/ 角标（未读/错误/冲突）
- **实现现状**：SessionCard.vue 实现 4 区（头 ✅、摘要 ✅、指标 ⚠、时间 ✅），2 区缺失（后台 agent ❌、角标 ❌）。

| 区 | 设计 | Render | 判定 |
|---|------|--------|------|
| 头部 | 状态点 5 态 + 标题 + 分支 pill | `flex items-center gap-2` 完整 | ✅ |
| 摘要 | 末条 assistant，2 行 ellipsis | `<p v-if="summary" class="line-clamp-2">` | ✅ |
| 指标 | +N −M 行 / K 回合 / 运行时长 | `addCount`/`delCount` props 有但**Overview.vue 未传值**（`@open` 未传 `:add-count` `:del-count`）；turnCount ✅ | ⚠ |
| 后台agent | 进度条 + 计数（flow-3 联动） | **未渲染**（模板注释"DEFERRED，flow-3 联动"） | ❌ |
| 时间 | 相对时间（2分钟前） | `formatRelativeTime(session.lastActiveAt)` ✅ | ✅ |
| 角标 | 未读/错误/冲突 Badge | **未渲染**（模板注释"DEFERRED"） | ❌ |

- **判定**：⚠
- **差异描述**：4 区实现正确，2 区明确标记 DEFERRED（后台 agent 需要 flow-3 数据源，角标需要未读/冲突标记数据）。指标区的 `addCount`/`delCount` props 在 SessionCard 中定义了但 Overview.vue 调用处未传入——属于遗漏而非 defer。
- **设计证据**：
  ```html
  <!-- draft-overview.html §2 完整卡片 -->
  <div class="card">
    <div class="c-head"><span class="dot dot-running pulse"></span><span class="c-title">...</span><span class="branch">...</span></div>
    <div class="c-sum">...</div>
    <div class="agents"><!-- 后台 agent 进度聚合 --></div>
    <div class="c-meta"><span class="add">+168</span><span class="del">-31</span><span>12回合</span><span class="c-time">2分钟前</span></div>
    <div class="cbadge unread">2</div>
  </div>
  ```
- **实现证据**：
  ```html
  <!-- Overview.vue:36-42 SessionCard 调用 -->
  <SessionCard
    :session="s"
    :active="s.id === session.activeId"
    :status="statusOf(s.id)"
    :summary="digestOf(s.id).summary"
    :turn-count="digestOf(s.id).turnCount"
    @open="onOpen"
  />
  <!-- 缺少 :add-count / :del-count / 后台agent / 角标 props -->
  ```
- **初步根因**：孤立 — 数据源未就绪：后台 agent 进度需要 flow-3 聚合接口，角标需要未读/冲突标志（runtime 无推送），addCount/delCount 需要 file-changes 数据。**addCount/delCount 的漏传是代码遗漏**，SessionCard 已定义 props 但容器未提供。
- **修复性质**：长期方案。addCount/delCount 应立即在 Overview.vue 中传入（mock 数据即可）；后台 agent + 角标需 runtime 数据源就绪后补。

---

## 五、Wave 小结

### 审查统计

- 审查锚点数：**9**（OV-L1-01 ~ OV-L3-06）
- ✅ 一致：6
- ⚠ 偏差：3（OV-L2-02 工具栏残缺，OV-L3-01 同卡，OV-L3-02 6 区部分未实现）
- ❌ 缺失：0
- 🆕 多余：0

### 根因关联标注

| 根因 | 关联锚点 | 状态 |
|------|---------|------|
| **RC-09**（SessionItem grid 无列定义） | OV-L3-02 核查结论：SessionCard **无同类问题**——头部用 `flex items-center` 同行，整体用 `flex flex-col` 卡片式 | 本 wave 排除 |
| **RC-10**（激活标识 spec-draft 冲突） | OV-L3-04 ✅ SessionCard 已在用 inset ring（正确路径）；对比 SessionItem 仍用左竖条，两组件不一致 | 确认——SessionCard 是正确参考 |
| **RC-04**（token SSOT 缺失） | OV-L3-04 未受影响——`ring-accent` 走 CSS 变量，色值不是硬编码 | 本 wave 排除 |

### 命门总结

1. **独立 Region 定位正确**：MainPanel 用 `navigation.current.view` 在 chat/overview 间切换，sidebar 持久。覆盖整个 main 区——符合 ADR-0005 裁决。

2. **入口落点正确**：Sidebar Overview 按钮在 nav 与 segmented tab 之间，带计数角标，激活时 accent 态。`goOverview()` 推 `{ view:'overview' }` 到导航栈。与 ADR-0005 图一致。

3. **SessionCard 无 RC-09 布局断裂**：头部三人组（状态点+标题+pill）同行，使用正确 `flex items-center`。卡片式 `flex-col` 是设计意图。

4. **Card-Active 用 inset ring**：`ring-1 ring-inset ring-accent` 严格遵守 DEC-01 裁决，无左竖条。SessionItem 应以此为参考对齐。

5. **工具栏是最大缺口**：筛选 chip、排序下拉、视图密度全缺失。虽然 spec §遗留允许初版固定舒适档，但筛选交互是 Overview 的核心价值（多 session 鸟瞰时需要快速收敛），建议早日补上。

6. **addCount/delCount 漏传**：SessionCard 定义了 props，Overview.vue 调用时未传入。属代码遗漏（非设计 defer），应立即修复——至少 mock 数据让卡片指标区可见。

### 跨 wave 依赖

- **W07（SessionItem）**：SessionCard 的 inset ring 激活态可作为 SessionItem RC-10 修复的参考基准。
- **W13（Companion Zones / flow-3）**：后台 agent 进度聚合（OV-L3-02 缺失区）依赖 flow-3 多进度数据——W13 完成前 Overview 此区无法实现。
- **W01（全局根因清单）**：RC-09 本 wave 排除（SessionCard 无此类问题），RC-04 未影响。
