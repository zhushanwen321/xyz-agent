# Wave W07 · SessionItem 审查结果

> **审查员**：W07 (A-SB-I) 执行员（自顶向下，L3-L4 业务组件层）
> **审查范围**：SessionItem.vue + SessionList.vue + session store + useSidebar
> **审查日期**：2026-06-21
> **设计来源**：sidebar/spec.md §会话项 + draft-session-item.html（5 态/激活/右键/子会话完整视觉）
> **用户差异点①**：session 会话项状态点+文字跨行 → 核查单行布局根因
> **W01 输入**：RC-07（session store derivedStatus 骨架 vs useSidebar deriveStatus 重复）

---

## 一、Wave 汇总表

| ID | 层 | 区域.模块 | 组件/锚点 | 判定 | 设计来源 | 实现位置 | 根因标签 |
|----|----|----------|----------|------|---------|---------|---------|
| SB-L3-01 | L3 | Sidebar.SessionItem | ★单行布局：状态点+标题+分支pill+时间同一行 | ❌ | draft-session-item.html §2 `.si` flex row | SessionItem.vue:46 `grid` 无列定义→垂直堆叠 | **已确认根因→RC-09** |
| SB-L3-02 | L3 | Sidebar.SessionItem | 状态点 5 态脉冲动画 | ⚠ | draft-session-item.html §1 自定义 pulse-ring（`::after` 同心环） | SessionItem.vue:56-62 Tailwind `animate-pulse`（整点淡入淡出） | 孤立 |
| SB-L3-03 | L3 | Sidebar.SessionItem | 激活态标识：左侧竖条 vs inset ring | ⚠ | spec.md §会话项"左侧竖条+bg-elevated" **vs** draft HTML §4 裁决弃左竖条用 inset ring | SessionItem.vue:49 absolute 2px 竖条 + `bg-accent-soft` | 疑似根因→RC-10（spec-draft 不一致） |
| SB-L3-04 | L3 | Sidebar.SessionItem | hover：时间隐去 → 浮现操作按钮 | ❌ | draft-session-item.html §3 时间 `display:none` + 2 操作钮浮现 | SessionItem.vue:71 `group-hover:invisible` 无操作钮 | 孤立（G2-005 DEFERRED） |
| SB-L3-05 | L3 | Sidebar.SessionItem | 右键菜单 5 项 | ❌ | draft-session-item.html §6 重命名/复制/归档/删除/在新Panel打开 | SessionItem.vue 全文无 `@contextmenu` / ctx 组件 | 孤立 |

**判定分布**: ✅ 0 / ⚠ 2 / ❌ 3 / 🆕 0

---

## 二、★单行布局深度核查（差异点①核心）

### 2.1 设计 draft 的布局模型（SSOT）

```
.si {
  display: flex;               ← flex row，单行
  align-items: flex-start;
  gap: 10px;
}
```

子元素排列：`[dot(7px, mt:5px)] [.si-main(flex:1)] [.si-actions(opacity:0→1 on hover)]`

`.si-main` 内部：
```
.si-title  (13px, nowrap, ellipsis)
.si-sub    (flex row, gap:6px)
  .branch  (accent pill, max-width:140px, ellipsis)
  .si-time (subtle, nowrap)        ← 时间在 sub 行内，与分支 pill 同行
```

关键：**时间在 `.si-main` 内部的 `.si-sub` 子行中**，与 branch pill 处于同一 flex row。hover 时操作钮在 `.si` 最右侧浮现（替换态 = 时间 `display:none` + 操作钮 `opacity:1`）。

### 2.2 Render 实现分析

```html
<!-- SessionItem.vue:46 -->
<div class="session-item group relative grid cursor-pointer items-start gap-2
            rounded-md px-2 py-[7px] transition-colors">
```

**根因确认**：`grid` **未指定列定义**（无 `grid-cols-*`、无 `grid-template-columns`）。

CSS Grid 默认行为：`grid-auto-flow: row` + 隐式单列 → **每个子元素独占一行**。

实际渲染结构：
```
Row 1: <span absolute>          ← 激活竖条（absolute，脱离流）
Row 2: <span w-2 h-2>           ← 状态圆点（8px）
Row 3: <div min-w-0>            ← 标题 + 子信息
Row 4: <span shrink-0>          ← 时间
```

**3 行垂直堆叠**。用户看到的"跨行"就是 Row 2/3/4 各占一行的结果。

### 2.3 三重差异详析

| 维度 | 设计 draft | Render 实现 | 差异级别 |
|------|-----------|------------|---------|
| **容器布局模式** | `display: flex` | `display: grid`（无列定义） | **致命** — 导致垂直堆叠 |
| **时间位置** | 在 `.si-sub` 内（与 branch pill 同一 flex row） | 在顶层 grid（独立 cell） | **致命** — 时间脱离主内容区 |
| **操作钮槽位** | `.si-actions` 在 flex 末尾（与 dot/main 同行） | 未实现（DEFERRED） | 缺失 |
| **对齐基准** | `align-items: flex-start` → dot 从顶部对齐 | `items-start` → 一致 | ✅ |

### 2.4 hover 行为分析（部分实现）

| 设计行为 | 实现行为 | 判定 |
|---------|---------|------|
| `.si:hover .si-time { display:none }` — 时间完全移除布局 | `group-hover:invisible` — 时间透明但**占据空间** | ⚠ 占位残留 |
| `.si:hover .si-actions { opacity:1 }` — 操作钮在同行浮现 | **未实现**（DEFERRED G2-005） | ❌ |
| `.si:hover { background: --surface-hover }` | `hover:bg-surface-hover` | ✅ |

`group-hover:invisible` vs `display:none` 差异：前者保留元素在布局流中的占位，后者完全移除。即使操作钮已实现，`invisible` 也意味着操作钮不能无缝替代时间的位置（中间会有空白 gap）。

### 2.5 根因 → RC-09

| 字段 | 内容 |
|------|------|
| **根因 ID** | **RC-09** |
| **描述** | SessionItem.vue 使用 `grid` 无列定义 → 隐式单列堆叠，状态点/标题/时间垂直排列成 3 行。设计要求 `flex` 单行。 |
| **影响面** | SessionItem.vue 全部实例（sidebar 列表 + 子会话折叠 + Overview 卡片若复用） |
| **修复** | `grid` → `flex items-start`（匹配 draft），或 `grid grid-cols-[auto_1fr_auto]`。推荐 `flex`：与 draft HTML 完全一致，操作钮槽位直接追加为 `ml-auto` flex 子项。 |

---

## 三、条目详情卡

### SB-L3-01 · ★单行布局（差异点①核心）

- **层级位置**：L3 · Sidebar.SessionItem
- **设计要求**：状态点 + 标题 + 分支 pill + 时间同一行。容器 `display:flex`，时间与分支 pill 同在 `.si-sub` 内 flex row。
- **实现现状**：容器 `display:grid` 无列定义 → 隐式单列，子元素垂直堆叠 3 行。时间在顶层 grid 独立 cell，不在 `.si-sub` 内。
- **判定**：❌
- **差异描述**：见 §二深度核查。
- **设计证据**：
  ```css
  /* draft-session-item.html:88 */
  .si { display:flex; align-items:flex-start; gap:10px; }
  .si-sub { display:flex; align-items:center; gap:6px; } /* time inside here */
  ```
- **实现证据**：
  ```html
  <!-- SessionItem.vue:46 -->
  <div class="session-item ... grid ... gap-2 ...">
    <!-- 无 grid-cols-* → 隐式单列，子元素垂直堆叠 -->
    <span class="mt-1 h-2 w-2 shrink-0 rounded-full" />  <!-- row 1 -->
    <div class="min-w-0">                                   <!-- row 2 -->
    <span class="shrink-0 ... group-hover:invisible">       <!-- row 3 -->
  ```
- **初步根因**：**RC-09**（已确认根因）。`grid` 未指定列 → CSS Grid 默认单列堆叠。
- **修复性质**：长期方案 · 治本。改为 `flex items-start` 匹配 draft，时间移入 sub 行内。

---

### SB-L3-02 · 状态点 5 态脉冲动画

- **层级位置**：L3 · Sidebar.SessionItem
- **设计要求**：draft-session-item.html §1 — running/waiting 带 `pulse-ring` 动画（`::after` 伪元素 + `box-shadow` 同心环从 0→6px 扩张）；done/stopped/error 静态色。圆点 7px。
- **实现现状**：SessionItem.vue:56-62 — `dotClass` computed 映射 Tailwind 类，running/waiting 用 `animate-pulse`（整点 opacity 呼吸）。圆点 8px（`w-2 h-2`）。
- **判定**：⚠
- **差异描述**：
  1. **动画机制不同**：设计用 `::after` 同心扩张环（`box-shadow 0→6px`），实现用 Tailwind `animate-pulse`（整体 opacity 0→1 往复）。视觉效果显著不同——前者是"波纹扩散"，后者是"闪烁"。
  2. **圆点尺寸**：设计 7px，实现 8px（Tailwind `w-2` = 0.5rem = 8px）。偏差 1px，可接受。
  3. **颜色枚举一致**：running=accent, waiting=warning, done=success, stopped=subtle, error=danger。✅
- **设计证据**：
  ```css
  /* draft-session-item.html §§1 */
  .dot { width:7px; height:7px; }
  .dot-running.pulse::after {
    color:rgba(79,142,247,0.55);
    animation:pulse-ring 1.8s var(--ease) infinite;
  }
  @keyframes pulse-ring {
    0% { box-shadow:0 0 0 0 currentColor; opacity:.8 }
    70% { box-shadow:0 0 0 6px transparent; opacity:0 }
  }
  ```
- **实现证据**：
  ```ts
  // SessionItem.vue:56
  const dotClass = computed(() => {
    const map: Record<DerivedStatus, string> = {
      running: 'bg-accent animate-pulse',   // ← Tailwind 整点呼吸
      waiting: 'bg-warning animate-pulse',
      done: 'bg-success',
      stopped: 'bg-subtle opacity-50',
      error: 'bg-danger',
    }
  })
  ```
- **初步根因**：孤立 — 自定义 `pulse-ring` 动画未从 draft CSS 迁移到 Tailwind config 或 scoped style。`animate-pulse` 是捷径。
- **修复性质**：长期方案 · 治本。在 Tailwind config 中注册 `pulse-ring` keyframes + animation，或在 `<style scoped>` 中定义（伪元素场景适合 escape hatch）。

---

### SB-L3-03 · 激活态：左侧竖条 vs inset ring

- **层级位置**：L3 · Sidebar.SessionItem
- **设计要求**：**两源冲突**：
  - `sidebar/spec.md §会话项`： "激活态：左侧竖条 + bg-elevated（与 workspace 四层激活呼应）"
  - `draft-session-item.html §4`： **裁决推翻** — "左竖条弃用。激活走 inset ring（`inset 0 0 0 1px accent`），与 panel/workspace 选中态一致。左竖条+亮底是 AI slop 反模式。"
- **实现现状**：SessionItem.vue:49 — absolute 2px 竖条 (`w-0.5 bg-accent`) + `bg-accent-soft`（激活底色）。遵循的是 spec.md 旧版，**未采纳 draft §4 的 inset ring 裁决**。
- **判定**：⚠
- **差异描述**：实现与 spec.md 一致，但与 draft HTML 不一致。draft HTML 是设计的最新载体（含 explicit 裁决注释），比 spec.md 更晚。此偏差的性质取决于 user 是否接受 draft §4 的裁决。
- **设计证据**（draft 裁决）：
  ```css
  /* draft-session-item.html §4（含裁决注释） */
  .si.active { background:var(--surface-2); box-shadow:inset 0 0 0 1px var(--accent) }
  ```
  注释原文："左竖条弃用——若 workspace/draft-dual-panel 仍用左竖条需统一到此"
- **实现证据**：
  ```html
  <!-- SessionItem.vue:48-49 -->
  :class="active ? 'bg-accent-soft' : 'hover:bg-surface-hover'"
  <span v-if="active" class="absolute bottom-1.5 left-0 top-1.5 w-0.5 rounded-sm bg-accent" />
  ```
- **初步根因**：**疑似根因→RC-10**（spec-draft 不一致，render 跟随旧 spec 未同步 draft 裁决修复）。需用户裁决：保留左竖条还是采纳 inset ring。
- **修复性质**：待裁决。若采纳 draft → 删 left bar，改 `bg-surface-2 + ring-1 ring-inset ring-accent`；若保留左竖条 → 需更新 draft HTML 回退裁决。

---

### SB-L3-04 · hover：时间隐去 → 操作按钮浮现

- **层级位置**：L3 · Sidebar.SessionItem
- **设计要求**：draft-session-item.html §3 — hover 时时间 `display:none`，2 个方形 ghost 操作钮（重命名图标 / 删除图标）在同一行的 `.si-actions` 槽位 `opacity:0→1`。
- **实现现状**：SessionItem.vue:71 — 时间 `group-hover:invisible`（透明但保留占位）。操作按钮 **未实现**（DEFERRED G2-005/G-013）。模板注释声明"按 hide 规则不渲染入口"。
- **判定**：❌
- **差异描述**：
  1. 时间隐藏方式：`invisible`（占位） vs 设计 `display:none`（移除）。即使有操作钮也无法无缝替代时间位置。
  2. 操作按钮槽位完全缺失。
- **设计证据**：
  ```css
  .si:hover .si-time { display:none }
  .si-actions { display:flex; gap:2px; opacity:0; align-self:center; }
  .si:hover .si-actions { opacity:1 }
  ```
- **实现证据**：
  ```html
  <!-- SessionItem.vue:71 -->
  <span class="shrink-0 ... group-hover:invisible">{{ timeLabel }}</span>
  <!-- 无 .si-actions / 操作按钮 -->
  ```
  模板注释（:37-39）："hover 操作（重命名/删除）属 DEFERRED（G2-005/G-013），按 hide 规则不渲染入口。"
- **初步根因**：孤立 — G2-005 DEFERRED。当前骨架仅实现时间隐藏（且方式有偏差），操作钮待实现。
- **修复性质**：长期方案。需实现操作钮组件（重命名/删除）+ `display:none` 替换 `invisible` + opacity 过渡。

---

### SB-L3-05 · 右键菜单 5 项

- **层级位置**：L3 · Sidebar.SessionItem
- **设计要求**：draft-session-item.html §6 — 右键弹出浮层菜单（Card-Elevated + shadow-2），5 项：重命名(F2) / 复制(⌘D) / 归档(E) / — / 在新 Panel 打开(⌘⇧O) / — / 删除(⌫ danger)。分组用分隔线。
- **实现现状**：SessionItem.vue 全文无 `@contextmenu` 事件监听，无右键菜单组件或浮层。grep 确认 sidebar 目录无 `contextmenu`/`dropdown-menu` 引用。
- **判定**：❌
- **设计证据**：draft-session-item.html §6 完整 `.ctx` + `.ctx-i` 5 项 HTML + CSS（Card-Elevated 浮层，`shadow-2`，快捷键 kbd）。
- **实现证据**：SessionItem.vue 102 行全文无 contextmenu handler。无关联的 context-menu / dropdown 组件文件。
- **初步根因**：孤立 — 未实现。注意：W02 发现 dropdown-menu 14 组件零业务引用，本 wave 确认 SessionItem 也未用 dropdown-menu → **W02 的 RC-03 结论未被推翻**。
- **修复性质**：长期方案。需实现右键浮层组件（可复用 dropdown-menu 原子 or 自建 context-menu 浮层），并接线 5 项操作。

---

## 四、RC-07 验证结论

### 问题描述

W01 发现 `stores/session.ts:31` 的 `derivedStatus` 返回硬编码 `computed(() => 'waiting')`（骨架），而 `composables/features/useSidebar.ts:52-68` 的 `deriveStatus()` + `derivedStatus()` 是真实派生实现。两处存在但职责重叠。

### 数据流追踪

```
SessionList.vue
  :status="statusOf(s.id)"          ← 由容器注入
    ↓
Sidebar.vue (容器, 调用 useSidebar)
  statusOf: useSidebar().derivedStatus  ← 真实派生逻辑
    ↓
useSidebar.ts:169
  function derivedStatus(id): ComputedRef<DerivedStatus>
    return computed(() => deriveStatus(id, chat, isActiveStreaming))
    ↓
useSidebar.ts:52
  function deriveStatus(): DerivedStatus  ← 优先级：waiting>running>error>stopped>done
    ├── last.toolCalls[].status === 'running' → 'waiting'
    ├── isStreaming || last.status === 'streaming' → 'running'
    ├── last.status === 'error' → 'error'
    ├── last.isInterrupted → 'stopped'
    └── else → 'done'
```

### 结论

| 项目 | 值 |
|------|-----|
| **SessionItem 实际读取的状态来源** | `useSidebar().derivedStatus()`（通过容器 props 注入） |
| **session store `derivedStatus` 状态** | 骨架默认 `'waiting'`，无人调用 |
| **是否重复** | 是——功能重复，session store 版本是死代码 |
| **是否造成运行时错误** | 否——调用路径不经过 store 版本 |
| **建议** | 删 session store 的 `derivedStatus` 死骨架，保留 useSidebar 唯一实现 |

**关联**：`根因关联→RC-07`（session store derivedStatus 骨架 vs useSidebar deriveStatus 重复，与 W01 结论一致）。

---

## 五、SessionList.vue 补充审查

SessionList.vue 作为 SessionItem 的容器，结构正确：

- `flex flex-col gap-0.5 px-1` → 垂直列表容器，SessionItem 之间间距 2px
- `v-for` 迭代 `sessions`，注入 `active` + `status` props
- 空态（sessions.length===0）：显示"暂无会话" + "新建会话" ghost 按钮
- `ScrollArea` 包裹，支持长列表滚动

无布局问题。✅

---

## 六、Wave 小结

### 审查统计

- 审查锚点数：**5**（SB-L3-01 ~ SB-L3-05）
- ✅ 一致：0
- ⚠ 偏差：2（SB-L3-02 脉冲动画，SB-L3-03 激活态 spec-draft 冲突）
- ❌ 缺失：3（SB-L3-01 单行布局断裂，SB-L3-04 hover 操作，SB-L3-05 右键菜单）
- 🆕 多余：0

### 新发现根因

| 根因 ID | 描述 | 影响面 |
|---------|------|--------|
| **RC-09** | SessionItem.vue `grid` 无列定义 → 垂直堆叠 3 行（★差异点①根因） | SessionItem 全部实例 |
| **RC-10**（疑似） | draft-session-item.html §4 裁决弃左竖条用 inset ring，但与 spec.md 冲突，render 未同步裁决 | 需用户裁决对齐 |

### W01 根因关联验证

| W01 根因 | 本 wave 验证结果 |
|---------|----------------|
| RC-07（derivedStatus 重复） | ✅ 已验证：useSidebar 是真数据源，session store 版本是死骨架。建议删除 store 版 |
| RC-03（dropdown-menu 零引用） | ✅ 未推翻：SessionItem 未使用 dropdown-menu，右键菜单完全未实现 |

### 命门总结

**差异点①（SB-L3-01）是 RC-09 的直接表现**——`grid` 无列定义导致隐式单列，状态点/标题/时间垂直分三行。修复只需将 `grid` 改为 `flex items-start`（匹配 draft HTML），并将时间移回 `.si-sub` 内。操作钮（SB-L3-04）和右键菜单（SB-L3-05）虽缺失，但它们是增量功能，不影响基础布局。先修 RC-09 布局断裂，再补 hover 操作和右键菜单。

### 跨 wave 依赖

- **SB-L3-02（脉冲动画）**：与 W10（PanelHeader 状态点）共用同一视觉原子。若 W10 也用了 `animate-pulse` 捷径，应统一定制 `pulse-ring` 动画。
- **SB-L3-03（激活标识）**：与 W09（Workspace 四层激活标识）联动——无论最终选左竖条还是 inset ring，Sidebar SessionItem 和 Workspace Panel 必须统一激活标识。
