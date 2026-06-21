# Wave W03 (A-SH) · Shell 层审查（L0-L2）

> 审查日期：2026-06-21
> 执行员：W03 (A-SH)
> 方法论：以 shell/spec.md 为 SSOT checklist，逐锚点对照 render 实现，双证据（设计来源 + 实现位置:行号）。
> 关联 W01 根因：RC-05 确认 / RC-01/02/06 判定不影响 Shell

---

## 一、Wave 汇总表

| ID | 层 | 区域.模块 | 组件/锚点 | 判定 | 设计来源 | 实现位置 | 根因标签 |
|----|----|----------|----------|------|---------|---------|---------|
| SH-L0-01 | L0 | Shell.三层语义 | base平铺+sidebar透明+main浮起 | ⚠ | shell/spec.md §一 | AppShell.vue:6 / AsideRegion.vue:9 / MainPanel.vue:6 | 孤立（border-radius缺失） |
| SH-L0-02 | L0 | Shell.安全区 | padding-top: 52px（三平台统一） | ✅ | shell/spec.md §三 | AsideRegion.vue:9 `pt-[52px]` | — |
| SH-L0-03 | L0 | Shell.TrafficLight | 跨平台红黄绿（mac OS / win·linux mimic_mac） | ✅ | shell/spec.md §五 | TrafficLight.vue:10-31 | — |
| SH-L0-04 | L0 | Shell.AppNavControls | 收起/←/→ 三按钮（left 90→20） | ✅ | shell/spec.md §二 | AppNavControls.vue:9-11 | — |
| SH-L0-05 | L0 | Shell.两态 | 全屏/非全屏 320ms 同步 | ✅ | shell/spec.md §二 | TrafficLight.vue:12 / AppNavControls.vue:9 | — |
| SH-L0-06 | L0 | Shell.Breadcrumb | 位置在 main-header 内（非横跨顶栏） | ✅ | shell/spec.md §四 | PanelHeader.vue:19（在 panel 层，非 shell 层） | — |
| SH-L0-07 | L0 | Shell.Z-index | 分层（traffic 10 / main auto / aside auto / base 0） | ✅ | shell/spec.md §六 | TrafficLight.vue:12 `z-10` / 其余 auto | — |
| SH-L0-08 | L0 | Shell.快捷键 | ⌘B 三态优先级 | ❌ | shell/spec.md §二（⌘B） | Sidebar.vue:134-143（仅 toggle，G-033 DEFERRED） | 孤立（DEFERRED） |

**判定统计**：✅ 6 / ⚠ 1 / ❌ 1

---

## 二、条目详情卡

### [SH-L0-01] ⚠ 三层语义：border-radius 缺失 + token 命名对齐

- **层级位置**：L0 · Shell.三层语义
- **设计要求**：窗口 `bg-base #0d0d0f` 平铺全屏 + `border-radius:10px`；aside 透明无背景；main 唯一 float-panel（`bg-panel` + border + `radius:12px` + shadow）
- **实现现状**：
  - AppShell 用 `bg-bg`（= `#0d0d0f`）— 色值一致
  - AsideRegion 无 background — 一致
  - MainPanel 用 `bg-surface`（= `#151519`）+ `rounded-lg`（= 12px）+ `border` + 双 shadow — 一致
  - **AppShell 根元素缺少 `border-radius:10px`**
- **判定**：⚠偏差
- **差异描述**：设计 spec §一明确要求 window 层设 `border-radius:10px`（draft-overlay-states.html 的 `.window-mock` 也设了）。render AppShell.vue:6 的根 `<div class="app-shell...bg-bg...">` 没有 `rounded-[10px]`。macOS 下此缺失由原生窗口圆角掩盖；Windows/Linux `frame:false` 下窗口锐角可见。
- **设计证据**：
  - spec.md §一：`窗口 (bg-base #0d0d0f 平铺全屏, border-radius:10px, 浮于桌面)`
  - draft-overlay-states.html：`.window-mock { border-radius: 10px; }`
- **实现证据**：AppShell.vue:6（无 border-radius 类）
- **初步根因**：孤立问题。可能 macOS 开发环境导致未被发现（原生窗口自带圆角）。win/linux frameless 窗口会暴露。
- **修复性质**：短期方案 · 加 `rounded-[10px]` 于 AppShell 根 div，或在 `<html>`/`<body>` 层加。

---

### [SH-L0-08] ❌ ⌘B 三态优先级：仅实现简单 toggle

- **层级位置**：L0 · Shell.快捷键
- **设计要求**：`⌘B` 三态优先级——①sidebar 展开 → 折叠；②折叠 + 无未保存 → 展开；③折叠 + 有未保存 → 触发分支 popover（breadcrumb L3）
- **实现现状**：Sidebar.vue:134-143 仅调用 `sidebar.toggleCollapsed()`，无条件分支。注释明确写 "v1 只做 toggle 前两态，G-033 第 3 态 DEFERRED"。无未保存编辑检测、无分支 popover 集成、无视觉提示 chip。
- **判定**：❌缺失
- **差异描述**：
  - 缺失：未保存编辑 dirty flag 检测
  - 缺失：优先级 3 分支 popover 触发
  - 缺失：mac ⌘B chip 视觉提示（200ms fade）
  - 缺失：win/linux tooltip + status bar 提示
- **设计证据**：shell/spec.md §二（⌘B）完整三态伪代码 + 视觉提示规格 + 配套文档指向 `draft-breadcrumb-popovers.html` 卡 E
- **实现证据**：Sidebar.vue:134-143
- **初步根因**：显式 DEFERRED（G-033），非遗漏。优先级 1+2 的 toggle 行为可满足当前使用。
- **修复性质**：长期方案 · 与 Flow 4 分支回退联动，需 dirty flag 系统 + branch popover 组件就绪后实现。

---

## 三、W01 根因关联复核

### RC-05 · `aside-region` 废弃术语

**确认结果**：AsideRegion.vue:9 使用 class `aside-region`。W01 RC-05 标记此 class 为"废弃术语"。

**复核发现**：
- 代码侧唯一引用：AsideRegion.vue:9
- **无** CSS 文件引用（grep 全项目 `aside-region` 仅 1 处）
- **无** e2e 测试引用（tests/ scripts/ 均空）
- **spec 内部存在命名不一致**：spec.md（SSOT）使用 `.aside-region`，但 draft-skeleton.html 使用 `.aside-left`。代码跟随 spec.md，与 draft-skeleton.html 冲突。
- 结论：`根因关联→RC-05` 确认。但 RC-05 的"废弃术语"定性存疑——spec.md 自身使用该术语。建议 Phase C 收敛时决策：统一为 `aside-left`（对齐 skeleton）或保留 `aside-region`（对齐 spec.md）。

### RC-01/02 · settingsStore 不存在 + 无 `[data-theme]` 切换

**影响判定**：Shell 层 5 个文件均不依赖 theme 切换。`bg-bg`/`bg-surface` 等色值直接使用 CSS 变量固定值（暗色）。**不受 RC-01/02 影响**。

### RC-06 · tailwind `darkMode: 'class'` 无注入

**影响判定**：Shell 层未使用 `dark:` Tailwind variant（所有颜色通过 CSS 变量 `bg-bg`/`bg-surface` 等引用，非主题变体）。**不受 RC-06 影响**。

---

## 四、Wave 小结

- **审查条目数**：8（✅ 6 / ⚠ 1 / ❌ 1）
- **根因关联数**：1（RC-05 确认）
- **新独立问题**：2
  1. `border-radius:10px` 在 AppShell 根元素缺失（影响 win/linux frameless 窗口）
  2. ⌘B 三态优先级未实现（G-033 DEFERRED，优先级 3 + 未保存检测 + 视觉提示缺失）
- **跨 Wave 提示**：
  - PanelHeader.vue `h-[38px]` vs spec `42px` — 属 W02 (A-WP-W2) 审查范围，此处仅标注以提醒
  - `data-fullscreen` 未注入 `<html>`（代码用 `:class` 绑定替代）— 不影响功能，但 AppShell.vue:43 注释错误声称已同步（实际只同步 `data-platform`）
- **额外发现**：
  - draft-overlay-states.html traffic light 色值（`--tl-red: #fc6155`、`--tl-yellow: #fdb40a`、`--tl-green: #34c84a`）与 spec.md 正文（`#ff5f57`/`#febc2e`/`#28c840`）不一致。代码跟随 spec.md 正文。draft HTML 的 CSS 变量为旧值未更新，建议同步。
  - spec 内 `aside-region`（spec.md）与 `aside-left`（draft-skeleton.html）命名冲突，Phase C 需统一。
