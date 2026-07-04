# Wave W14 · Side Drawer (detail-pane) 审查报告

> 审查日期：2026-06-21
> 审查员：W14 (A-WP-D) 执行员
> 范围：Side Drawer（detail-pane，Panel 联动浮层，承载 Diff/文件/终端/子Agent 详情）
> 设计 SSOT：`panel/spec.md §Side Drawer` + `panel/draft-detail-pane.html` + `flow-2-code-review/spec.md` + `flow-3-subagent/spec.md`
> 实现源：`renderer/src/components/workspace/PanelContainer.vue` + `panel/Panel.vue` + `panel/GitZone.vue`
> 审查锚点：7 个（WP-L3-32 ~ WP-L3-38），来自 plan-A §A-WP-W6

---

## 一、Wave 汇总表

| ID | 组件/锚点 | 设计来源 | 判定 | 实现位置 | 根因标签 |
|----|----------|---------|------|---------|---------|
| WP-L3-32 | Drawer 结构：header 多 tab 容器 | draft-detail-pane.html | ❌缺失 | 未找到（全项目无独立 SideDrawer 组件） | G-023 DEFERRED |
| WP-L3-33 | 文件×N tab（Diff/预览 view-toggle） | draft-detail-pane.html | ❌缺失 | 未找到 | G-023 DEFERRED |
| WP-L3-34 | ChangeSet Detail tab（变更集 + Accept/Reject） | draft-detail-pane.html + flow-2 spec | ❌缺失 | 未找到 | G-023 DEFERRED（联动缺失 W11 WP-L3-11） |
| WP-L3-35 | SubAgent Detail tab（子 agent 完整消息流） | draft-detail-pane.html + flow-3 spec | ❌缺失 | 未找到 | G-023 DEFERRED（联动缺失 flow-3 未实现） |
| WP-L3-36 | 反向联动：源块点击 → drawer 打开 + 高亮 | draft-detail-pane.html | ❌缺失 | 未找到（emit 链终止于空 stub） | G-023 DEFERRED（联动缺失 W11/W13） |
| WP-L3-37 | Tab 切换动效（dd-tabs + view-toggle） | draft-detail-pane.html | ❌缺失 | 未找到 | G-023 DEFERRED |
| WP-L3-38 | 单/双 Panel 下方向正确（dir-right/left） | draft-detail-pane.html + workspace spec | ❌缺失 | 未找到（PanelContainer.vue:75-77 空 stub） | G-023 DEFERRED（联动 W09 WP-L2-04） |

**判定统计**：✅一致 x0 / ⚠偏差 x0 / ❌缺失 x7

> 7 锚点全 ❌ 的原因是 Side Drawer 整体子系统未实现（G-023 DEFERRED），非某个锚点单独缺失。下节详述。

---

## 二、Side Drawer 实现存在性确认

### 2.1 独立组件搜索

**结论：不存在任何 Side Drawer / DetailPane 独立 Vue 组件。**

```bash
$ find renderer/src/components/ -iname '*drawer*' -o -iname '*detail*' -o -iname '*side*'
# → 仅返回 sidebar/Sidebar.vue + shell/AsideRegion.vue（不相关）
```

全项目搜索 `detail-pane`、`DetailPane`、`SideDrawer`、`side-drawer`、`detail_drawer`：

```bash
$ grep -rn 'detail-pane\|DetailPane\|SideDrawer\|side-drawer\|detail_drawer\|detail drawer' renderer/src/ --include='*.vue' --include='*.ts'
# → 仅 GitZone.vue 注释和 PanelContainer.vue 注释中提到（均为 DEFERRED 标注），无任何实现代码
```

`shared/src/` 搜索同样无匹配。类型定义层也无 SideDrawer 相关接口。

### 2.2 diff 事件链（完整追踪）

| 层级 | 位置 | 行为 | 状态 |
|------|------|------|------|
| GitZone.vue:25 | `@click="emit('diff')"` → 向父组件 Panel 发射 | → | ✅ 按钮接线正确 |
| Panel.vue:43 | `@diff="emit('diff')"` → 透传给 PanelContainer | → | ✅ 透传正确 |
| PanelContainer.vue:28 | `@diff="onDiff"` | → | ❌ 空 stub |
| PanelContainer.vue:75-77 | `function onDiff(): void { /* DEFERRED, v1 空实现 */ }` | → 终止 | ❌ 未消费 |

**emit 消费方不存在。** `onDiff()` 是事件链的终点——空函数体、无任何组件创建、无状态变更、无 drawer 渲染。

### 2.3 其他潜在触发路径

除 GitZone 的 Diff 按钮外，draft-detail-pane.html 定义了两个核心联动触发源：

| 触发源 | 设计行为 | 实现状态 |
|--------|---------|---------|
| **FileChanges 块**（message-stream 中） | 点击 → drawer 打开 ChangeSet Detail | ❌ FileChanges 块完全未实现（W11 WP-L3-11） |
| **SubAgent 块**（message-stream 中） | 点击 → drawer 打开 SubAgent Detail | ❌ SubAgent 块未实现（flow-3 DEFERRED） |
| **GitZone Diff 按钮** | 点击 → drawer 打开 Diff tab | ❌ emit 链终止于 `onDiff()` 空 stub |

三条触发路径全部断链——两条连触发源都未实现，一条 emit 到空 stub。

### 2.4 Panel.vue 内的条件渲染核查

Panel.vue 的 template 仅渲染 5 个固定 zone（PanelHeader / MessageStream / ProgressZone / Composer / GitZone），**无任何条件渲染的 drawer 组件**。`<template>` 全文搜索无 `Drawer`/`drawer`/`detail`/`v-if` 与抽屉相关。

---

## 三、数据源依赖矩阵

Drawer 的每个 tab 需要特定数据源，各自就绪状态如下：

| Tab 内容 | 所需数据源 | 数据源状态 | 备注 |
|---------|-----------|-----------|------|
| **ChangeSet Detail**（文件 diff） | FileChanges 块数据（A/M/D 文件列表 + git diff 内容） | ❌ 全链未就绪 | FileChanges 块未实现（W11 WP-L3-11）；git diff 后端未接入；变更集 5 态状态机未实现 |
| **ChangeSet Detail**（Accept/Reject 交互） | 文件变更状态机 + patch 应用/回退后端 | ❌ 全链未就绪 | 依赖 flow-2 变更集卡（accumulating→ready→reviewed→resolved），现为空 |
| **SubAgent Detail**（子 agent 消息流） | 子 agent 的 message stream 数据 + 进度聚合 + 子变更集 | ❌ 全链未就绪 | flow-3 整体 DEFERRED；子 agent 块未实现；progress-zone 多进度聚合未实现 |
| **Diff tab**（文件 diff git diff） | git diff 原始输出 + 文件路径 + +/- line stats | ❌ 全链未就绪 | 后端无 diff 数据输出通道；frontend 无 diff 渲染组件 |
| **预览 tab**（文件最终态预览） | 文件内容 + 语法高亮 | ❌ 全链未就绪 | 设计标注为"待实现"，优先级低于 Diff |
| **Terminal tab**（终端） | 终端会话 WebSocket 流 | ❌ 全链未就绪 | 终端功能不在 v1 范围内 |
| **Browser tab**（浏览器预览） | iframe/WebView URL | ❌ 全链未就绪 | 浏览器预览不在 v1 范围内 |

**结论：所有 tab 的数据源均未就绪。** 即使 Side Drawer 组件实现，也没有可消费的数据。这是一个"组件未实现"与"数据源未就绪"同时存在的全栈断层。

---

## 四、条目详情卡

### [WP-L3-32] Drawer 结构：header 多 tab 容器

- **层级位置**：L3 · Panel.SideDrawer.容器结构
- **设计要求**：detail-pane 是"一个 header 多 tab 容器"（tab 承载文件×N / 终端 / 子Agent / 浏览器），非单实体视图切换。draft-detail-pane.html 的 `.dd-head` + `.dd-tabs` 完整定义。
- **实现现状**：未找到（全项目无独立 SideDrawer 组件）。PanelContainer.vue:75-77 `onDiff()` 为空函数。
- **判定**：❌缺失
- **差异描述**：设计定义了完整的 header 多 tab 容器范式（`.dd-head-row` 左标题+右关闭，`.dd-tabs` 横向滚动 tab 列表），实现侧为零。
- **设计证据**：
  ```html
  <!-- draft-detail-pane.html -->
  <div class="detail-drawer dir-right closed" id="detail-drawer">
    <div class="dd-head">
      <div class="dd-head-row"><span class="dd-title">钻取详情</span><button class="dd-close">×</button></div>
      <div class="dd-tabs" id="dd-tabs">
        <span class="dd-tab active" data-kind="file" data-file="auth">AuthService.ts</span>
        <span class="dd-tab-sep"></span>
        <span class="dd-tab" data-kind="sub">子Agent · 运行中</span>
      </div>
    </div>
    ...
  ```
- **实现证据**：PanelContainer.vue:75-77
  ```ts
  function onDiff(): void {
    // diff 抽屉属 Side Drawer（G-023/G detail-pane），DEFERRED，v1 空实现
  }
  ```
- **初步根因**：G-023 DEFERRED。整个子系统从零实现，非代码遗漏。
- **修复性质**：长期方案 · 治本。需要新建 `components/panel/drawer/SideDrawer.vue`，含 header 多 tab 容器 + dd-body + 各 pane 条件渲染。组件树建议：`SideDrawer.vue` → `DrawerHeader.vue` + `DrawerTabs.vue` + `ChangeSetDetail.vue` + `SubAgentDetail.vue` + `DiffView.vue` + `PreviewView.vue`。

### [WP-L3-33] 文件×N tab（Diff/预览 view-toggle）

- **层级位置**：L3 · Panel.SideDrawer.文件Tab
- **设计要求**：文件 tab 内含 Diff/预览 view-toggle — Diff 下沉为文件 tab 内部子视图，而非与文件 tab 同级。draft-detail-pane.html `.view-toggle` + `.cs-diff` + `.preview-stub` 完整定义。
- **实现现状**：未找到。
- **判定**：❌缺失
- **差异描述**：设计明确要求 Diff/预览 是文件 tab 内的 view-toggle，非 tab 级切换。实现侧无此组件，连文件 tab 列表都未实现。
- **设计证据**：
  ```html
  <!-- draft-detail-pane.html -->
  <div class="view-toggle" id="view-toggle">
    <button data-view="diff" class="on">Diff</button>
    <button data-view="preview">预览</button>
  </div>
  <div class="cs-diff" id="cs-diff"><!-- diff 内容 --></div>
  <div class="preview-stub" id="cs-preview" style="display:none"><!-- 预览占位 --></div>
  ```
- **实现证据**：全项目无文件 tab 列表组件、无 view-toggle 组件、无 diff 渲染组件。
- **初步根因**：G-023 DEFERRED。父组件 SideDrawer 未实现。
- **修复性质**：长期方案 · 治本。需等 SideDrawer 容器就绪后实现 `FileTabList.vue` + `ViewToggle.vue` + `DiffViewer.vue` + `FilePreview.vue`。

### [WP-L3-34] ChangeSet Detail tab（变更集详情 + Accept/Reject）

- **层级位置**：L3 · Panel.SideDrawer.ChangeSet
- **设计要求**：
  - 变更集详情：文件 diff + +/- 行数统计（draft-detail-pane.html `.cs-diff` + `.cs-d-path` + `.cs-diff-body`）
  - 底部审批栏：Accept / Reject 当前文件 + Accept All / Reject All + 回退回合 + 复制 patch + 编辑器打开（draft-detail-pane.html `.cs-foot`）
  - Accept → 标记已接受，计数 -1，自动跳下一个未审查文件（flow-2 spec §S5）
  - 5 态状态机：accumulating → ready → partially-reviewed → resolved / superseded（flow-2 spec §状态机）
- **实现现状**：未找到。
- **判定**：❌缺失
- **差异描述**：变更集审查是整个 flow-2（代码审查主路径）的核心交互。当前零实现——既无 diff 渲染，也无 Accept/Reject 交互，连 5 态状态机的数据模型都未在 shared 层定义。
- **设计证据**：
  - draft-detail-pane.html: `.cs-diff` diff 视图（行号 + add/del 着色）
  - draft-detail-pane.html: `.cs-foot` 按钮栏（回退/复制 patch/编辑器打开）
  - flow-2 spec §S4: 「Accept → diff 标记已接受，计数 -1，自动跳下一个」
  - flow-2 spec §状态机: accumulating → ready → partially-reviewed → resolved / superseded
- **实现证据**：全项目无 ChangeSetDetail 组件、无 Accept/Reject 按钮、无 5 态状态机。shared/message.ts 无 fileChanges 字段、无 review 状态枚举。
- **初步根因**：G-023 DEFERRED + 关联 W11 WP-L3-11（FileChanges 块缺失 → ChangeSet 触发源不存在）。
- **修复性质**：长期方案 · 治本。需要：
  1. shared 层定义 `FileChange`/`ChangeSetStatus`/`ReviewDecision` 类型
  2. runtime 输出 git diff 数据事件
  3. chat store 处理 fileChanges 数据流
  4. 实现 ChangeSetDetail.vue（diff 渲染 + Accept/Reject 按钮 + 计数 -1 + 自动跳转）

### [WP-L3-35] SubAgent Detail tab（子 agent 完整消息流）

- **层级位置**：L3 · Panel.SideDrawer.SubAgent
- **设计要求**：
  - 子 agent 元信息卡：tag/名称/状态圆点/描述/模型/运行时间/上下文（draft-detail-pane.html `.sa-hero`）
  - 执行进度：步骤列表（done/active/pending 各态 + 百分比）（`.sa-steps`）
  - 产出文件：A/M/D badge + 行数（`.sa-output`）
  - 子 agent 消息流（折叠）：tool call / thinking / text 时序（`.sa-stream`）
  - 操作按钮：终止子 agent / 导出日志（`.cs-foot`）
  - 6 态状态机：dispatched → running → done / stopped / failed / timeout / superseded（flow-3 spec）
- **实现现状**：未找到。
- **判定**：❌缺失
- **差异描述**：flow-3（多子 agent 编排）是产品护城河，SubAgent Detail 是其核心呈现位。当前零实现——无 subagent 块触发源、无 SubAgentDetail 组件、无子 agent 状态机。
- **设计证据**：
  - draft-detail-pane.html: `.sa-hero`（元信息卡）+ `.sa-steps`（步骤列表）+ `.sa-output`（产出文件）+ `.sa-stream`（消息流折叠）
  - flow-3 spec §S4: 「用户点某子 agent → Side Drawer 展开，Detail 内含该子 agent 的完整消息流」
  - flow-3 spec §子 Agent 状态机: dispatched → running → done / stopped / failed / timeout / superseded
- **实现证据**：全项目无 SubAgentDetail 组件、无 subagent 块渲染、无子 agent 数据模型。flow-3 的 S1（任务拆解派发）也未实现。ProgressZone 无多进度聚合能力。
- **初步根因**：G-023 DEFERRED + flow-3 DEFERRED（progress-zone 多进度聚合未实现，W13 WP-L3-30）。
- **修复性质**：长期方案 · 治本。需要 flow-3 整个子系统（主 agent 编排 → 子 agent 并行 → 进度聚合 → 结果汇总 → Diff 审查）全部实现后才可能有 SubAgent Detail。这是 v2 需求。

### [WP-L3-36] 反向联动：源块点击 → drawer 打开 + 源块高亮

- **层级位置**：L3 · Panel.SideDrawer.反向联动
- **设计要求**：
  - message-stream 中点 FileChanges 块 / SubAgent 块 → Side Drawer 打开对应 tab
  - 关联 panel 内的源块高亮（`source-active` inset ring + glow）
  - 联动方向正确：源块在 active panel → drawer 覆盖对侧，源块始终完整可见
  - draft-detail-pane.html JS: `sources.forEach(s => s.onclick → state.detail = s.dataset.source; render())`
- **实现现状**：未找到。
- **判定**：❌缺失
- **差异描述**：反向联动需要三个条件全部满足才能工作——(A) 源块存在、(B) Drawer 存在、(C) EventBus/bus 连线。当前三个条件全不满足：
  - A: FileChanges 块未实现（W11 WP-L3-11），SubAgent 块未实现
  - B: Side Drawer 未实现
  - C: 任何源块→drawer 的事件通道不存在（无 event bus topic、无 composable、无 emit 链条）
- **设计证据**：
  ```javascript
  // draft-detail-pane.html JS
  sources.forEach(function (s) {
    s.addEventListener('click', function () {
      if (!s.closest('.panel').classList.contains('active')) return;
      state.detail = s.dataset.source;
      syncSeg('seg-detail','detail'); render();
    });
  });
  ```
  ```css
  /* 源块高亮态 */
  .blk.source-active {
    border-color: var(--accent);
    box-shadow: inset 0 0 0 1px var(--accent-ring), 0 0 0 3px var(--accent-glow);
  }
  ```
- **实现证据**：全项目无 event bus topic 注册（如 `eventBus.on('drawer:open')`），无 `source-active` CSS 类使用，PanelContainer.vue 无 drawer 状态管理。
- **初步根因**：G-023 DEFERRED + 关联 W11 WP-L3-11（FileChanges 源块缺失）。
- **修复性质**：长期方案 · 治本。联动需要：
  1. 定义 event bus topic（如 `drawer:open` payload {panelId, tabType, entityId}）
  2. FileChanges / SubAgent 块 emit `drawer:open`
  3. SideDrawer composable 监听 topic，控制 drawer open/close + tab select + source highlight
  4. PanelContainer 级状态管理：`drawerState: { open, direction, activeTab, sourceBlockId }`

### [WP-L3-37] Tab 切换动效（dd-tabs + view-toggle Diff/预览）

- **层级位置**：L3 · Panel.SideDrawer.动效
- **设计要求**：
  - tab 切换：`.dd-tab` border-bottom color transition 220ms + background ease + active 态 accent color + accent-soft 底（draft-detail-pane.html CSS）
  - Diff/预览 view-toggle：segment control 式切换，`bg-hover` 高亮 + `bg-input` 底（`.view-toggle`）
  - pane 切换：display:none → display:flex，无 slide/fade 动画（设计稿未定义动画）
- **实现现状**：未找到。
- **判定**：❌缺失
- **差异描述**：设计定义了 220ms ease 的 tab 下划线颜色过渡 + active accent 高亮，以及 segment control 式 view-toggle。实现侧无任何 tab 组件。
- **设计证据**：
  ```css
  /* draft-detail-pane.html */
  .dd-tab {
    border-bottom: 2px solid transparent;
    transition: color var(--dur) var(--ease), background var(--dur) var(--ease), border-color var(--dur) var(--ease);
  }
  .dd-tab.active {
    color: var(--accent);
    border-bottom-color: var(--accent);
    background: var(--accent-soft);
  }
  .view-toggle {
    background: var(--bg-input);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    padding: 2px;
  }
  .view-toggle button.on {
    background: var(--bg-hover);
    color: var(--text-primary);
  }
  ```
- **实现证据**：全项目无 `dd-tab` 类、无 `view-toggle` 类。
- **初步根因**：G-023 DEFERRED。无容器组件。
- **修复性质**：长期方案 · 治本。SideDrawer 实现后，tab 动效可用 Tailwind `transition-colors duration-[220ms] ease` 表达，无需自定义 CSS。

### [WP-L3-38] 单/双 Panel 下方向正确（dir-right/left）

- **层级位置**：L3 · Panel.SideDrawer.方向逻辑
- **设计要求**：
  - 归 Panel 联动，固定挂触发 Panel，不跨 Panel 覆盖（panel/spec.md §Side Drawer）
  - 单 session：关联 panel 收窄到 50%，drawer 占右半并排，不盖对话区（draft-detail-pane.html v2 裁决）
  - 双 session：关联 panel 保持 50%，drawer 覆盖对侧 standby panel（已知限制）
  - 方向：关联左 panel(active-1) → drawer 贴右 dir-right；关联右 panel(active-2) → drawer 贴左 dir-left
  - 定位：workspace-body 级 absolute，width:50%
  - 关闭动画：`translateX(100%)` (dir-right) / `translateX(-100%)` (dir-left)，320ms ease-out
- **实现现状**：PanelContainer.vue:75-77 `onDiff()` 为空 stub。方向逻辑、收窄逻辑、animation 全未实现。
- **判定**：❌缺失
- **差异描述**：设计定义了完整的 v2 形态裁决（推翻旧 v1 右浮 65%，改为各占一半并排）。Workspace spec §边缘状态明确方向规则。实现侧连最基础的 `dir-right`/`dir-left` 逻辑都未开始。
- **设计证据**：
  ```css
  /* draft-detail-pane.html v2 裁决 */
  .detail-drawer { position: absolute; top: 0; bottom: 0; width: 50%;
    z-index: 40; transition: transform var(--dur-slow) var(--ease-out); }
  .detail-drawer.dir-right { right: 0; left: auto; }
  .detail-drawer.dir-right.closed { transform: translateX(100%); }
  .detail-drawer.dir-left { left: 0; right: auto; }
  .detail-drawer.dir-left.closed { transform: translateX(-100%); }
  ```
- **实现证据**：PanelContainer.vue:75-77
  ```ts
  function onDiff(): void {
    // diff 抽屉属 Side Drawer（G-023/G detail-pane），DEFERRED，v1 空实现
  }
  ```
  全项目搜索 `dir-right`/`dir-left`，仅在 draft HTML 中出现，无 Vue 组件引用。
- **初步根因**：G-023 DEFERRED。关联 W09 WP-L2-04（同方向逻辑空 stub）。
- **修复性质**：长期方案 · 治本。需要：
  1. PanelContainer 维护 `drawerState: { open, associatedPanelId }`
  2. computed: `drawerDirection` = associatedPanelId === P1 ? 'dir-right' : 'dir-left'
  3. 单 session 收窄：associated panel 设 `half` class → `flex: 0 0 calc(50% - 1px)`
  4. workspace-body 设为 `position: relative`（定位容器）
  5. 关闭动画：320ms ease-out with transform

---

## 五、根因关联标注

| 本 wave 条目 | 关联 wave/根因 | 关联性质 |
|-------------|--------------|---------|
| WP-L3-32 ~ WP-L3-38（全部 7 锚点） | **G-023** DEFERRED | 整体子系统延迟实现，非单个条目的独立问题 |
| WP-L3-34（ChangeSet Detail） | W11 WP-L3-11（FileChanges 块缺失） | 数据源触发源未就绪 |
| WP-L3-35（SubAgent Detail） | W13 WP-L3-30（progress-zone 多进度聚合未实现） + flow-3 DEFERRED | 数据源触发源未就绪 |
| WP-L3-36（反向联动） | W11 WP-L3-11 + W13 WP-L3-31 | 源块不存在 → 联动无触发点 |
| WP-L3-38（方向逻辑） | W09 WP-L2-04（Side Drawer 方向空 stub） | 完全重合——两个 wave 审查了同一缺失的不同侧面（W09 从拓扑视角，W14 从锚点级细化） |
| WP-L3-33/37（文件 tab/diff 渲染） | RC-04（`--bg-elevated`/`--bg-input` token 缺失） | 若 SideDrawer 实现，Card-Elevated 浮层需 `--surface-2`/`--bg-elevated`，当前 render CSS 无此 token（W09 WP-L2-03 同源问题） |
| WP-L3-34（Accept/Reject） | DEC-01（inset ring 方向） | Accept 按钮的 active/focus 态应对齐 inset ring 裁决（非本次 scope，修复时注意） |

---

## 六、Wave 小结

### 审查条目数

7（✅ x0 / ⚠ x0 / ❌ x7）。全部 ❌ 因为 Side Drawer 整体子系统未实现，非单锚点独立缺失。

### 正向发现

- **emit 链上游接线正确**：GitZone → Panel → PanelContainer 的事件透传链工作正常，只是最后 `onDiff()` 是空 stub。当 Side Drawer 实现时，只需替换 `onDiff()` 的函数体，上游三组件无需改动。
- **设计规范完整**：draft-detail-pane.html 提供了完整的 CSS/HTML/JS 交互范本，含 v2 形态裁决（各占一半不重叠）、header 多 tab 范式、文件 tab 内 view-toggle、反向联动 JS 逻辑、双 panel 方向切换。实现时可直接参考。
- **PanelContainer 已有 `onDiff` 预留 slot**：`panel.isDual`、`panel.activePanelId` 等状态已就绪，方向逻辑实现时可直接读取。

### 待实现 spec 清单（按优先级排序）

以下清单是 Side Drawer 实现时需完成的工作，从零开始：

| 优先级 | 工作项 | 依赖 | 预估复杂度 |
|--------|-------|------|-----------|
| **P0** | 新建 `SideDrawer.vue` 容器组件（workspace-body 级 absolute, width:50%） | 无 | 中 |
| **P0** | PanelContainer 维护 `drawerState` + `onDiff` 替换为实逻辑 | 无 | 低 |
| **P0** | 单/双 Panel 方向逻辑（dir-right/left + 收窄 half） | PanelContainer drawerState | 中 |
| **P0** | Drawer 打开/关闭动画（320ms translateX ease-out） | 容器就绪 | 低 |
| **P1** | header 多 tab 容器（dd-head + dd-tabs） | SideDrawer.vue | 中 |
| **P1** | Diff 视图渲染组件（行号 + add/del 着色 + 行超长横向滚动） | 容器就绪 + git diff 数据 | 中 |
| **P1** | 文件 tab 内 view-toggle（Diff/预览 segment control） | diff 渲染就绪 | 低 |
| **P2** | ChangeSet Detail tab（含 Accept/Reject 按钮 + 计数 -1 + 自动跳转） | 依赖 flow-2 变更集卡 + FileChanges 块（W11 WP-L3-11） | 大 |
| **P2** | 反向联动机制（EventBus topic + source-active 高亮） | ChangeSet detail + FileChanges 块 | 中 |
| **P2** | Tab 切换动效（220ms ease border-bottom color transition） | header 多 tab 就绪 | 低 |
| **P3** | SubAgent Detail tab（含子 agent 消息流 + 进度 + 操作按钮） | 依赖 flow-3 整体（v2 需求） | 大 |
| **P3** | 预览视图（文件最终态只读高亮） | 非阻塞，可后补 | 低 |
| **P3** | 终端 / 浏览器 tab | 不在 v1 范围 | 大 |

### 与 W09 的差异

W09 WP-L2-04 从"Workspace 容器拓扑"审查 Side Drawer 方向逻辑，结论 `❌缺失（空 stub）`。本 wave 从 detail-pane 锚点级深化：确认了 **7 个设计锚点全部缺失**、**3 条触发路径全部断链**、**所有 tab 数据源均未就绪**。两者的结论一致但粒度不同——W09 认定拓扑缺失，W14 量化到具体锚点级。

### 跨 wave 依赖提示

- **W11 WP-L3-11（FileChanges 块）是 Side Drawer ChangeSet 的先决条件**——没有 FileChanges 触发源，ChangeSet Detail 无从打开。
- **W13 WP-L3-31（GitZone 干净态未 disabled）** 联动本 wave——GitZone 的 Diff 按钮当前无条件 `emit('diff')`，设计要求干净态应 disabled。修复时需与 Side Drawer 协同。
- **RC-04（token SSOT 缺失）** 会影响 Side Drawer 的 Card-Elevated 浮层造型（`.detail-drawer { background: var(--bg-elevated); }`）。实现前需在 render CSS 中定义 `--bg-elevated` 和 `--bg-input` 变量。
- **DEC-01（inset ring 方向）** 对 Accept/Reject 按钮的 active 态、dd-tab 的 active 下划线有约束——应统一使用 inset ring 模式而非实线 border。
