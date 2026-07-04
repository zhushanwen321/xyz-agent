# W05 (A-SB-C) · Sidebar 容器审查结果

> 审查日期：2026-06-21 | 执行员：W05 | 区域：Sidebar L2-L3 容器层
> 审查模式：自顶向下（Design Spec → Render 实现），双证据判定
> 审查范围：Sidebar.vue（容器）+ SegmentedTab.vue（视图切换）
> 不审：SessionList.vue（W07）、SessionItem.vue（W07）

---

## 一、Wave 汇总表

| ID | 层 | 区域.模块 | 组件/锚点 | 判定 | 设计来源 | 实现位置 | 根因标签 |
|----|----|----------|----------|------|---------|---------|---------|
| SB-L2-01 | L2 | Sidebar.Container | 容器纵向分层（Brand→nav→Overview入口→segmented tab→子视图区→用户区） | ✅一致 | sidebar/spec.md §视图切换机制 | Sidebar.vue:12-84 | — |
| SB-L2-02 | L2 | Sidebar.SegmentedTab | 互斥切换 + 计数 + 持久化 | ⚠偏差 | sidebar/spec.md §视图切换机制 | SegmentedTab.vue + sidebar.ts | 孤立（G2-003 defer） |
| SB-L2-03 | L2 | Sidebar.Container | Overview 入口按钮 ≠ tab | ✅一致 | sidebar/spec.md §视图切换机制 + overview/spec.md | Sidebar.vue:33-52 | — |
| SB-L2-04 | L2 | Sidebar.Container | 容器四态（A/B/C/D） | ⚠偏差 | sidebar/spec.md §容器四态 | Sidebar.vue:10,63-74 + SessionList.vue:20-29 | 孤立（G2-003 defer） |
| SB-L2-05 | L2-L3 | Sidebar.Container + Shell | 收起态三路唤回 + 320ms + 状态保留 | ⚠偏差 | sidebar/draft-collapsed-state.html | Sidebar.vue:97-106 + AppShell.vue:12-23 + AppNavControls.vue:19-24 | 孤立（疑似 AppNavControls 无法在折叠态见） |
| SB-L2-06 | L2 | Sidebar.Container | 搜索模态入口（nav 项 + ⌘K） | ❌缺失 | sidebar/spec.md §背景 + overlays/spec.md | 未找到（注释标记 DEFERRED hide G-022） | 孤立（整块缺失，含 SearchModal） |

---

## 二、条目详情卡

### SB-L2-02 · Segmented Tab 计数偏差

- **层级位置**：L2 · Sidebar.SegmentedTab
- **设计要求**：两 tab 右侧小字计数（会话 N / 文件 M），文件计数 = 当前 active session 改动文件数 —— sidebar/spec.md §视图切换机制
- **实现现状**：SegmentedTab 结构正确（互斥切换、v-model、localStorage 持久化、active 态 accent-soft），但文件计数写死为 `:file-count="0"` —— Sidebar.vue:58
- **判定**：⚠偏差
- **差异描述**：设计要求文件计数反映当前 active session 的改动文件数，实现传 0。代码注释写明 `G2-003 defer`（FileView 内容联调后计数自然接入）。核心交互骨架（v-model + 持久化 + active 态 + 计数栏位）已正确实现。
- **设计证据**：sidebar/spec.md：「每 tab 右侧小字计数（会话 N / 文件 M），不切换即知规模。File View 计数 = 当前 active session 的改动文件数」
- **实现证据**：Sidebar.vue:58 `:file-count="0"`；SegmentedTab.vue:24-27 计数栏位存在且正确渲染 `tab.count`
- **初步根因**：孤立问题（G2-003 联调 defer）。FileView 内容未实现 → 无文件列表数据源 → 计数自然为 0。非架构缺失。
- **修复性质**：短期方案 · 治标：FileView 联调完成后改 `fileCount` prop 为实时数据。

---

### SB-L2-04 · 容器四态 B（FileView）缺失

- **层级位置**：L2 · Sidebar.Container
- **设计要求**：B 态 = 文件视图（File View），与 A 态（Session List）互斥，容器内条件渲染 —— sidebar/spec.md §容器四态
- **实现现状**：容器已正确支持 B 态切换（`sidebar.activeTab === 'files'` 分支），但内容为占位文本 — Sidebar.vue:70-74
- **判定**：⚠偏差
- **差异描述**：设计要求的文件树视图（目录折叠 + 层级缩进 + git 标注 + 内过滤）全部未实现，仅渲染"文件视图待联调（G2-003 deferred）"占位文字。A/C/D 三态在各自判定锚点中 ✓ 或独立判定。
- **设计证据**：sidebar/spec.md：「B 文件视图（File View），子视图（与 A 互斥）」，draft-file-view.html 定义完整文件树结构
- **实现证据**：Sidebar.vue:70-74：`<div class="flex h-full items-center justify-center ...">文件视图待联调 ...（G2-003 deferred）</div>`
- **初步根因**：孤立问题（G2-003 联调 defer）。容器结构已预留 B 态槽位，等待 W08 FileView 组件实现后填充。非容器层架构缺失。
- **修复性质**：长期方案 · 治本：实现 FileView 组件（W08 范围），补入 Sidebar.vue 的 `v-else` 分支。

---

### SB-L2-05 · AppNavControls 折叠态可见性存疑

- **层级位置**：L2-L3 · Sidebar.Container + Shell.AppNavControls
- **设计要求**：三路唤回 (1) 顶栏按钮 (2) ⌘B (3) 左缘细条 hover，320ms 多轨同步，状态保留 —— sidebar/draft-collapsed-state.html §1/§5/§6
- **实现现状**：三路均已实现但顶栏按钮路径疑似 Broken：
  - (1) AppNavControls.vue:19-24 — 按钮存在且图标切换正确（PanelLeftOpen/PanelLeftClose），**但挂载在 AsideRegion 内（AsideRegion.vue:17）**。AsideRegion 折叠时 `flexBasis:0 + overflow:hidden`（AsideRegion.vue:7,11-14），AppNavControls `absolute left-[90px]` 在 0 宽容器内被 `overflow:hidden` 裁剪，**折叠态下不可见**。
  - (2) Sidebar.vue:97-106 — ⌘B toggle 正常 ✅
  - (3) AppShell.vue:12-23 — 左缘细条（`.rail-restore`，3px hairline → hover:6px accent）在 app-shell 层，不受 AsideRegion overflow 影响 ✅
  - 320ms 同步：Sidebar.vue:9 `transition-[width,opacity] duration-[var(--duration-slow)]` ✅；AppNavControls.vue:8 `transition-[left]` ✅；RailRestore:15 ✅
  - 状态保留：tab persist localStorage ✅；active session 保留 ✅；滚动不重置（`:class` 非 `v-if`，DOM 不销毁）✅
- **判定**：⚠偏差
- **差异描述**：设计 spec 要求三路唤回全部可用。实际运行时(2)(3) 可用但(1) 不渲染（被 overflow:hidden 裁剪）。依赖影响：当前由(2)(3) 兜底，用户仍可唤回 sidebar，但 spec 要求的三路冗余弱化为两路。**注意：此问题根在 Shell 层（W03 AsideRegion 组件结构），侧边栏容器自身逻辑无缺陷。**
- **设计证据**：draft-collapsed-state.html 卡 A：「折叠 + 非全屏 · 单一 panel · traffic-light + 折叠/前后落入 P1 header」。spec.md §收起态：「Workspace 顶栏「展开侧栏」按钮」
- **实现证据**：AsideRegion.vue:7 `overflow-hidden` + :11-14 `flexBasis: sidebar.collapsed ? '0px' : '200px'`；AppNavControls.vue:8 `absolute top-[16px] left-[90px]`，挂载于 AsideRegion.vue:17 `<AppNavControls />`
- **初步根因**：孤立问题，但跨 Wave（Shell W03）。AppNavControls 应浮于 app-shell 层（如 rail-restore 同级），或 AsideRegion 折叠态不应 overflow:hidden。当前 placement 在折叠态下物理不可访问。
- **修复性质**：长期方案 · 治本：将 AppNavControls 提升到 app-shell 层（W03 范围），与 rail-restore 对齐绝对定位策略。或按 draft-collapsed-state 设计，折叠态下 chrome 落入 main-header（工作量更大，需 W03+W06 协同）。

---

### SB-L2-06 · 搜索入口 + ⌘K 全文缺失

- **层级位置**：L2 · Sidebar.Container + L1 Overlays
- **设计要求**：Sidebar 保留搜索**触发入口**（nav 项"搜索 ⌘K"），浮层本体归 Overlay 层（⌘K 触发 SearchModal）—— sidebar/spec.md §背景 + overlays/spec.md
- **实现现状**：无搜索入口，无 ⌘K 快捷键，无 SearchModal 组件。Sidebar.vue:5 注释：「DEFERRED 入口 hide：搜索（⌘K，G-022）」。全量 `rg` 扫描 renderer 源码确认：无任何 `⌘K` 或搜索 modal 实现。
- **判定**：❌缺失
- **差异描述**：设计 spec 明确要求的搜索基础设施（入口 + 快捷键 + 浮层）三部分全部缺失。此非"入口可见但浮层未实现"的脱节——连入口也不存在。Sidebar 的 nav 区域仅有「新建任务 ⌘N」按钮（Sidebar.vue:18-29），缺少并列的「搜索 ⌘K」按钮。
- **设计证据**：sidebar/spec.md：「Sidebar 仅保留「搜索」触发入口（nav 项 + ⌘K）」。overlays/spec.md 定义完整 SearchModal 四类分组、5 态、键盘契约、匹配高亮
- **实现证据**：Sidebar.vue:5 `DEFERRED 入口 hide：搜索（⌘K，G-022）`；renderer 源码全量扫描 `⌘K`/`CmdK`/`search.*modal` 无命中
- **初步根因**：孤立问题（整块功能 deferred）。非 RC-01/02 衍生。缺失范围 = (sidebar nav item ×1) + (全局 ⌘K handler ×1) + (SearchModal 组件 = W09 Overlay 范围)。与 SB-L2-04 FileView 不同，此处连入口骨架也无——整个搜索契约未进入 build queue。
- **修复性质**：长期方案 · 治本：分三步 — (a) Sidebar.vue nav 区补"搜索 ⌘K"按钮（本 wave），(b) AppShell 或 Overlay 容器补 ⌘K 监听和 SearchModal 显示控制（W09），(c) 实现 SearchModal 浮层本体（W09）。入口按钮是本 wave 可直接 fix 的最小单元。

---

## 三、Wave 小结

- **审查条目数**：6（✅ 2 / ⚠ 3 / ❌ 1 / 🆕 0）
- **根因关联数**：0（无条目可关联到 W01 RC-01/02。Sidebar 容器层不依赖 theme 切换或 settingsStore）
- **新独立问题数**：3
  - **ISSUE-01** (SB-L2-02/04)：FileView 内容 + 计数缺失 — G2-003 defer，容器结构已就位，等待 W08 联调
  - **ISSUE-02** (SB-L2-05)：AppNavControls 折叠态可见性 — 跨 Wave（→W03 Shell），建议提升到 app-shell 层
  - **ISSUE-03** (SB-L2-06)：搜索基础设施全文缺失 — 入口 + ⌘K + SearchModal 皆无

- **跨 Wave 依赖提示**：
  - SB-L2-05 → W03 (Shell/AsideRegion)：AppNavControls absolute 定位策略需与 AsideRegion overflow 约束协同修复
  - SB-L2-06 → W09 (Overlays/SearchModal)：搜索入口按钮可先在 W05 fix，浮层本体归 W09
  - SB-L2-02/04 → W08 (FileView)：B 态 FileView 内容和文件计数等待 W08 联调

- **架构评价**：Sidebar 容器层的骨架实现质量高——分层顺序完全符合 design spec，Overview 入口按钮正确解耦于 segmented tab，四态切换结构完整。所有偏差均为已知 deferral（G2-003 FileView、G-022 Search）或跨层 placement 问题（AppNavControls），**非本 wave 架构理解错误**。
