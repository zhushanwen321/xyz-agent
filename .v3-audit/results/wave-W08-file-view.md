# W08 (A-SB-F) · FileView 文件视图审查结果

> 审查日期：2026-06-21 | 执行员：W08 | 区域：Sidebar L3 FileView（文件树 + git 标注 + 过滤）
> 审查模式：自顶向下（Design Spec → Render 实现），双证据判定
> 审查范围：FileView 组件实现存在性 + 5 锚点逐项对照 draft-file-view.html
> 关联 Wave：W05 (Sidebar 容器，已确认 B 态占位) | W13 (GitZone) | W09 (Overlays/SearchModal)

---

## 一、Wave 汇总表

| ID | 层 | 区域.模块 | 组件/锚点 | 判定 | 设计来源 | 实现位置 | 根因标签 |
|----|----|----------|----------|------|---------|---------|---------|
| SB-L3-06 | L3 | Sidebar.FileView | 文件树：目录折叠 + 层级缩进 + 当前编辑文件高亮 | ❌缺失 | draft-file-view.html §2 | 未找到（Sidebar.vue:70-74 占位文本） | 孤立（G2-003 defer，FileView 组件未创建） |
| SB-L3-07 | L3 | Sidebar.FileView | git 状态标注：M/A/D/冲突（颜色对齐 git-zone） | ❌缺失 | draft-file-view.html §2 角标映射 | 未找到（仅 GitZone.vue 分支名占位，无角标组件） | 孤立（G2-003 defer，数据源 + 渲染全缺） |
| SB-L3-08 | L3 | Sidebar.FileView | 树内过滤搜索框（实时过滤，非 ⌘K 全局） | ❌缺失 | draft-file-view.html §3 | 未找到（无过滤框实现） | 孤立（G2-003 defer）；与 W05 SB-L2-06/⌘K 无混淆风险（代码中无过滤逻辑） |
| SB-L3-09 | L3 | Sidebar.FileView | 与 message-stream file-changes 块联动：点文件→跳 Panel 高亮 | ❌缺失 | draft-file-view.html §4「在 Panel 打开」 | 未找到（无 EventBus 文件跳转逻辑；shared 类型无 FileChange 定义） | 孤立（G2-003 defer + file-changes 块类型未定义） |
| SB-L3-10 | L3 | Sidebar.FileView | active session 联动：切 session 时 FileView 自动刷新 | ❌缺失 | sidebar/spec.md §视图切换机制「active session 联动」 | 未找到（无 watch/sessionId→刷新逻辑） | 孤立（G2-003 defer，FileView 无实现则刷新链不存在） |

**判定分布**：✅ 0 / ⚠ 0 / ❌ 5 / 🆕 0

**根因分布**：孤立 5（全部同一根因：FileView 组件未创建，G2-003 defer）。无新根因发现。

---

## 二、FileView 实现存在性确认

### 判定：FileView 组件**不存在**

- **独立组件**：零个。`renderer/src/components/` 下无 `FileView.vue`、`FileTree.vue`、`file-view/` 等任何文件视图组件。
- **内联渲染**：无。Sidebar.vue 的 B 态分支（`:else` 块）仅有占位文本，无任何文件树、过滤框、git 标注的模板代码。
- **composable**：零个。`composables/` 下无 `useFileView.ts`、`useFileTree.ts` 等文件视图逻辑。
- **store**：零个。`stores/` 下无 `fileView.ts`、`fileTree.ts` 等文件视图状态管理。
- **shared 类型**：无 `FileChange` 类型定义。`shared/src/session.ts` 有 `gitBranch?: string` 和 `gitIsWorktree?: boolean`，但无文件变更列表结构。
- **占位文本**：`Sidebar.vue:70-74`（行号，模板内）

```html
<!-- Sidebar.vue:70-74 -->
<template v-else>
  <div class="flex h-full items-center justify-center px-4 text-center text-[11px] text-subtle opacity-60">
    文件视图待联调<br><span class="font-mono text-[10px]">（G2-003 deferred）</span>
  </div>
</template>
```

### 证据汇总

| 证据类型 | 搜索范围 | 命中数 |
|---------|---------|-------|
| `*FileView*` / `*FileTree*` 文件名 | renderer/src/ 全量 | 0 |
| `fileView` / `fileTree` / `file_view` 代码引用 | renderer/src/**/*.{ts,vue} | 0 |
| `file.*changes` / `FileChange` / `fileChanges` 类型定义 | shared/src/**/*.ts | 0 |
| `file.*view` / `file.*tree` 注释 | renderer/src/**/*.{ts,vue} | 0（仅 sidebar 注释提 "File View"） |

> **并发执行证据**：`find -name "*FileView*" -o -name "*FileTree*"` → 无输出。`grep -rn "fileView\|FileView\|fileTree\|FileTree"` → 无输出。`grep -rn "file.*changes\|FileChange" shared/` → 仅 `protocol.ts` 中 `file.read` WS 类型，非文件变更列表。

---

## 三、条目详情卡

### SB-L3-06 · 文件树：目录折叠 + 层级缩进 + 当前编辑文件高亮

- **层级位置**：L3 · Sidebar.FileView
- **设计要求**：目录可折叠（chevron 旋转），文件名 mono 字体，缩进每层 16px（indent-1 22px / indent-2 38px / indent-3 54px），当前编辑文件 accent-soft 底 + accent 文件名（弃左色条）。— draft-file-view.html §2
- **实现现状**：无任何文件树模板代码。Sidebar.vue B 态分支仅渲染"文件视图待联调（G2-003 deferred）"占位文字。无目录节点、chevron、缩进级别、高亮逻辑的任何实现。
- **判定**：❌缺失
- **差异描述**：设计 spec 定义了完整的文件树交互（折叠/缩进/高亮），实现为纯占位文本。0% 完成度。
- **设计证据**：draft-file-view.html §2 `<div class="node dir">` + `<svg class="chev open">` + `indent-1/2/3` 类名 + `.node.cur { background: var(--accent-soft) }` 高亮裁决
- **实现证据**：Sidebar.vue:70-74 占位 div；`find -name "*FileView*" -o -name "*FileTree*"` → 无输出
- **初步根因**：孤立（G2-003 defer）。FileView 组件尚未创建，所有子功能为零。非架构缺失——容器 B 态槽位已预留（`v-if/v-else`），等待组件插入。
- **修复性质**：长期方案 · 治本：创建 `components/sidebar/FileView.vue`，实现文件树渲染（递归 TreeItem 组件 + 折叠/展开态 + 缩进计算 + 当前文件 prop）。

---

### SB-L3-07 · git 状态标注：M/A/D/冲突（颜色对齐 git-zone）

- **层级位置**：L3 · Sidebar.FileView
- **设计要求**：文件后跟 git 角标：M 修改（warning 黄）、A 新增（success 绿）、D 删除（danger 红，文件名灰+删除线）、U 冲突（danger 红框，需解决）。颜色对齐 message-stream file-changes 与 workspace git-zone。— draft-file-view.html §2 角标映射表
- **实现现状**：无 git 角标组件。无 git status 数据源。GitZone.vue（panel 下）仅渲染分支名 + "工作区干净"占位文字（`GitZone.vue:21`），无 M/A/D/U 状态标注逻辑。文件树不存在 → 无挂载点。
- **判定**：❌缺失
- **差异描述**：设计要求的 4 种 git 标注 + 颜色对齐完全缺失。无角标组件、无 git status 枚举类型、无数据源。GitZone.vue 同样为空壳（仅有分支名），两处需协同实现。**不过设计 token `--success/#22c55e`、`--warning/#f5a524`、`--danger/#ef4444` 在 draft-file-view.html 中已明确定义**，未来实现时可复用。
- **设计证据**：draft-file-view.html §2 角标映射：`.git-m { color: var(--warning); background: rgba(245,165,36,0.12) }` / `.git-a { color: var(--success) }` / `.git-d { color: var(--danger) }` / `.git-u { color: var(--danger); border: 1px solid var(--danger) }`
- **实现证据**：`grep -rn "git.*badge\|git.*mark\|git.*status\|GitStatus\|FileStatus\|M\|A\|D\|U" renderer/src/components/` → 无 git 角标命中。GitZone.vue:7-34 模板：仅 `<span>{{ gitBranch }}</span>` + "工作区干净"文本。
- **初步根因**：孤立（G2-003 defer）。git status 标注需要 FileView 组件 + git status 数据源 + shared 类型定义，三者皆无。与 W13 GitZone 的占位态是同一底层问题（git 操作链未联调）。
- **修复性质**：长期方案 · 治本：(a) shared 定义 `FileChange { path, status: 'M'|'A'|'D'|'U', additions?, deletions? }`；(b) runtime 通过 WS 推送当前 session 文件变更列表；(c) FileView 渲染角标。G2-003 联调时一并完成。

---

### SB-L3-08 · 树内过滤搜索框（实时过滤，非 ⌘K 全局）

- **层级位置**：L3 · Sidebar.FileView
- **设计要求**：FileView 顶部过滤框：仅过滤当前 session 改动文件树，命中高亮（warning 黄底 `.mark`），非命中折叠。与 `overlays/draft-search-modal` 的全局 ⌘K 严格区分（后者四类分组+浮层+键盘导航）。— draft-file-view.html §3 + overlays/spec.md §归属与边界
- **实现现状**：无过滤框。无过滤逻辑。无 `.mark` 高亮样式。无树折叠/展开过滤交互。全局 ⌘K 也无实现（W05 SB-L2-06 ❌缺失）。无混淆风险：代码中没有任何过滤相关逻辑，不存在树内过滤与 ⌘K 混用的问题。
- **判定**：❌缺失
- **差异描述**：设计 spec 在两处分别定义了树内过滤（draft-file-view §3）和全局 ⌘K（overlays/spec.md），并强调"两者不混"。当前两者均为 zero 实现，不存在混淆问题——但也没有正确实现的起点。未来实现时需注意：过滤框输入不应触发 ⌘K 浮层，⌘K 快捷键不应影响过滤框状态。
- **设计证据**：draft-file-view.html §3 `<div class="fv-filter">` → `<input placeholder="过滤文件树…" />` + `<span class="esc">Esc</span>` + `.mark` 高亮样式；handoff 强调"两者不混——本框无 ⌘K 提示，不弹浮层，输完即过滤"
- **实现证据**：`grep -rn "filter.*file\|file.*filter\|fv-filter\|tree.*filter" renderer/src/` → 无命中
- **初步根因**：孤立（G2-003 defer）。树内过滤依赖 FileView 组件存在，FileView 不存在则过滤框无挂载点。与 ⌘K 缺失（W05 SB-L2-06）各自独立，但需注意两者 UI 不应混淆。
- **修复性质**：长期方案 · 治本：FileView 组件内嵌过滤框（`<input>` + 实时 computed 过滤 + Esc 清空），使用 `computed` 对文件列表做 `filter()`，高亮命中文本。

---

### SB-L3-09 · 与 message-stream file-changes 块联动：点文件→跳 Panel 高亮

- **层级位置**：L3 · Sidebar.FileView ↔ Panel.MessageStream
- **设计要求**：右键「在 Panel 打开」(⌘O) = workspace 载入该文件 + message-stream 定位到对应 file-changes 块高亮。双击冲突文件（U）→ workspace 打开 diff 视图解决。— draft-file-view.html §4 + sidebar/spec.md 边缘状态
- **实现现状**：全链路缺失：(a) 无文件点击事件 → 无 emit/EventBus 触发；(b) shared 无 FileChange 类型 → 无 file-changes block 定义；(c) MessageStream 无 file-changes 块渲染逻辑；(d) Panel 无「定位到特定 block 并高亮」的跳转机制。当前 message-stream 仅支持 thinking/tool_call 两种 block（`Block.vue:4`）。
- **判定**：❌缺失
- **差异描述**：设计 spec 定义了文件树 → Panel 的双向联动（点文件→跳 panel 高亮对应块），但实现中 (a) FileView 不存在，(b) file-changes 块类型不存在，(c) 跳转机制不存在。三环全断。
- **设计证据**：draft-file-view.html §4「在 Panel 打开 = workspace 载入该文件 + message-stream 定位到对应 file-changes 块」；sidebar/spec.md 边缘状态「冲突文件（U）双击 → workspace 打开 diff 视图」
- **实现证据**：(a) `grep -rn "eventBus\|EventBus\|emit.*file\|on.*file" renderer/src/composables/` → 无文件跳转事件。(b) `grep -rn "file.*changes\|FileChange" shared/src/` → 无类型定义。(c) Block.vue:4 仅 `'thinking' | 'tool'` 两种类型，无 file-changes。(d) Panel.vue 无 scrollToBlock/highlightBlock 方法。
- **初步根因**：孤立（G2-003 defer）。但此锚点跨两个模块（FileView + MessageStream），修复需协同 W06 (Panel) 定义 file-changes block 类型 + W08 (FileView) 实现跳转 emit。当前阶段无任何基础设施。
- **修复性质**：长期方案 · 治本：(a) shared 定义 `FileChangeBlock` 类型 + `FileChangeEvent` EventBus 事件；(b) MessageStream/Block.vue 支持 file-changes block 渲染；(c) FileView 点击文件时 emit EventBus 事件；(d) Panel 监听事件并 scrollToBlock + 临时高亮动画。

---

### SB-L3-10 · active session 联动：切 session 时 FileView 自动刷新

- **层级位置**：L3 · Sidebar.FileView
- **设计要求**：侧栏切 session 时，FileView 自动刷新为当前 active session 的改动文件树。切 tab 不影响。（sidebar/spec.md §视图切换机制「active session 联动」）
- **实现现状**：无 FileView 组件 → 无 `watch(sessionId)` 刷新逻辑。SidebarContainer 的 session 切换只触发 SessionList 高亮迁移（`onSelectSession` → `selectSession()`），对 B 态内容无任何操作（B 态仅渲染占位文本，无数据依赖）。
- **判定**：❌缺失
- **差异描述**：设计 spec 要求 FileView 随 active session 自动刷新，实现中因 FileView 不存在，无任何联动逻辑。SessionList 的切换链路完整（`useSidebar.ts selectSession()` → store 更新 → SessionList props 更新），但 B 态无消费者。
- **设计证据**：sidebar/spec.md「切 session 时，File View 自动刷新为新 session 改动；Session List 则迁移高亮」
- **实现证据**：Sidebar.vue:68-74 B 态分支为纯占位 HTML，无 `computed`/`watch` 依赖 `session.activeId`；`grep -rn "watch.*sessionId\|watch.*activeId" renderer/src/components/sidebar/` → 无 FileView 相关 watch
- **初步根因**：孤立（G2-003 defer）。FileView 不存在导致联动链在消费者端断裂。SessionList 端的联动链完整，B 态待插入 FileView 组件后补 `watch(() => session.activeId, loadFiles)` 即可。
- **修复性质**：长期方案 · 治本：FileView 组件挂载时 `watch(sessionStore.activeId)` → 请求 WS `file.listChanges` → 渲染文件树。deactivate 时清理。

---

## 四、Wave 小结

- **审查条目数**：5（✅ 0 / ⚠ 0 / ❌ 5 / 🆕 0）
- **根因关联数**：0（全部 5 锚点归入同一孤立根因：G2-003 defer，FileView 组件未创建。无新根因可关联到 W01 RC 系列）
- **新独立问题数**：0（全部锚点为已知 W05 ISSUE-01 "FileView 内容 + 计数缺失"的深度展开，无新增独立问题）

### FileView 实现存在性结论

**FileView 组件完全不存在**——零组件、零 composable、零 store、零 shared 类型。Sidebar.vue:70-74 仅渲染占位文本，容器 B 态槽位（`v-if/v-else` 分支）已预留。整个文件视图子系统处于"未开建"状态。

### 待实现 spec 清单（5 锚点 → 设计要求的完整功能列表）

| 序号 | 功能 | 设计来源 | 依赖 |
|------|------|---------|------|
| 1 | 文件树组件：目录折叠/展开（chevron 旋转）、层级缩进（16px/层）、当前编辑文件 accent-soft 高亮 | draft-file-view.html §2 | 需 shared `FileTreeNode` 类型 |
| 2 | git 角标组件：M(黄)/A(绿)/D(红+删除线)/U(红框)，颜色对齐 `--warning`/`--success`/`--danger` | draft-file-view.html §2 角标映射 | 需 runtime WS 推送 git status |
| 3 | 树内过滤框：实时 local filter（computed），命中高亮 `.mark`，Esc 清空，严格区分 ⌘K 全局搜索 | draft-file-view.html §3 | 无外部依赖，纯前端 |
| 4 | toolbar：新建文件/文件夹/刷新按钮（ghost icon），右键菜单（重命名/删除/复制路径/在 Panel 打开 ⌘O） | draft-file-view.html §4 | 需 runtime WS 文件操作 + Panel 跳转 |
| 5 | 空状态：图标 + "这个会话还没有文件改动" + "给 Agent 下达任务"按钮 | draft-file-view.html §5 | 无，纯前端 |
| 6 | 内联重命名：原位替换为 `<input>`（同 SessionItem §8 模式）| draft-file-view.html §5 | 需 runtime WS rename |
| 7 | 文件树 ↔ message-stream file-changes 块联动：点文件 → Panel 跳转 + 高亮对应块 | draft-file-view.html §4 | 需 shared `FileChangeBlock` 类型 + MessageStream 渲染 + EventBus |
| 8 | active session 联动：`watch(sessionId)` → 自动刷新文件树 | sidebar/spec.md §视图切换 | 需 FileView 组件存在后补 watch |
| 9 | 文件计数接入：SegmentedTab `:file-count` prop 从 0 改为实时数据 | sidebar/spec.md §tab 计数 | 需 runtime WS 推送文件变更数 |

### 跨 Wave 依赖提示

- **SB-L3-07/09 → W13 (GitZone) + W06 (Panel/MessageStream)**：git 标注的颜色 token（`--success/#22c55e`、`--warning/#f5a524`、`--danger/#ef4444`）在 draft-file-view.html 中已定义，与设计 token 一致。但 GitZone.vue 当前仅有分支名占位，需 W13 同步实现 git 状态枚举。file-changes 块联动需 W06 定义 block 类型。
- **SB-L3-08 → W09 (Overlays/SearchModal)**：树内过滤与 ⌘K 全局搜索在设计规范中已严格切割（draft-file-view.html §3 handoff），实现时需确保两者入口/形态/结果不混。W09 实现 SearchModal 时不要错误地复用到 FileView 过滤。
- **SB-L3-06/10 → W05 (Sidebar 容器)**：容器 B 态槽位已就绪（Sidebar.vue:68-74），FileView 组件创建后填入 `v-else` 分支即可，容器层无需改动。

### 架构评价

FileView 是 v3 Sidebar 的**第二大子视图**（与 SessionList 并列），但当前完成度为零——不是"骨架存在缺功能"，而是"组件本身不存在"。容器为它预留的 B 态槽位结构正确（`v-if="activeTab === 'sessions'"` / `v-else`），SegmentedTab 的切换+持久化+计数栏位也已就绪（仅计数传 0 等待数据源）。FileView 的全部 5 个锚点均为同一根因（G2-003 defer）下的零实现，不存在已实现但偏离设计的偏差项——这比"有偏差实现"更好处理：只需从零创建组件，严格按 draft-file-view.html 的 CSS 类名、交互契约、颜色 token 实现即可，无需修正历史代码。
