# Wave W09 — Workspace 容器拓扑层（双 Panel 主从 + 四层激活标识）

> 审查日期：2026-06-21
> 审查范围：workspace/spec.md §拓扑决策 / §Panel激活标识系统 / §状态与交互 / §边缘状态
> 设计来源：designs/v3-demo/workspace/spec.md + draft-dual-panel.html + panel/spec.md
> 实现来源：components/workspace/{Workspace.vue, PanelContainer.vue} + components/panel/Panel.vue + stores/panel.ts

---

## 一、Wave 汇总表

| ID | 层 | 区域.模块 | 组件/锚点 | 判定 | 设计来源 | 实现位置 | 根因标签 |
|----|----|----------|----------|------|---------|---------|---------|
| WP-L1-01 | L1 | Workspace.容器 | Workspace 作为容器（Panel 挂其内） | ✅一致 | workspace/spec.md §拓扑决策 | Workspace.vue:15 | — |
| WP-L2-01 | L2 | Workspace.PanelContainer | 双 Panel 主从模式（非对等） | ✅一致 | workspace/spec.md §拓扑决策 | PanelContainer.vue:6, panel.ts:57-74 | — |
| WP-L2-02 | L2 | Workspace.PanelContainer | 单 Panel 默认态：Panel-1 撑满 | ✅一致 | workspace/spec.md §状态与交互 | Workspace.vue:15, panel.ts:14-19 | — |
| WP-L2-03 | L2 | Workspace.Panel | 四层激活标识（竖条 + ring + bg + opacity） | ⚠偏差 | workspace/spec.md §Panel激活标识系统 | Panel.vue:26,87-90 | 孤立 |
| WP-L2-04 | L2 | Workspace.PanelContainer | Side Drawer 方向（双 Panel 覆盖对侧） | ❌缺失 | workspace/spec.md §边缘状态 | PanelContainer.vue:56（空 stub） | 孤立（G-023 DEFERRED） |
| WP-L2-05 | L2 | Panel.PanelHeader | split/新建会话按钮同槽位互斥 | ✅一致 | workspace/spec.md §状态与交互 | PanelHeader.vue:54-76 | — |

**判定统计**：✅一致 x4 / ⚠偏差 x1 / ❌缺失 x1 / 🆕多余 x0

---

## 二、条目详情卡

### [WP-L2-03] 四层激活标识 — bg 层 token 偏离

- **层级位置**：L2 · Workspace.Panel（四层激活标识系统第三层）
- **设计要求**：active panel 背景用 `bg-elevated` (#1c1c20) 微亮，非 active 用 `bg-panel` (#151519)，营造"浮起"而非"变色"
- **实现现状**：active panel 用 `bg-surface-hover` (#1b1b20)，而非 `bg-elevated` (#1c1c20)
- **判定**：⚠偏差
- **差异描述**：
  - 设计 draft-dual-panel.html 定义 `--bg-elevated: #1c1c20`，`.panel.active { background: var(--bg-elevated); }`
  - 实现 Panel.vue:87 用 `bg-surface-hover` → `var(--surface-hover): #1b1b20`（style.css:19）
  - 差值微小（0x1b vs 0x1c），视觉几乎不可察觉，但 token 非标准——render 的 style.css 根本没有定义 `--bg-elevated`，设计 token 在此未落地
  - 附带 bug：Panel.vue:84 注释写 "双 active = bg-elevated + inset accent-ring + opacity 1"，但代码实际用 `bg-surface-hover`，注释失实
- **设计证据**：
  ```css
  /* draft-dual-panel.html */
  --bg-elevated: #1c1c20;
  .panel.active { background: var(--bg-elevated); }
  ```
- **实现证据**：
  ```ts
  // Panel.vue:84-90
  // 注释: "双 active = bg-elevated + inset accent-ring + opacity 1"
  if (props.active && props.isDual) {
    return 'bg-surface-hover opacity-100 shadow-[inset_0_0_0_1px_var(--accent-ring)]'
  }
  ```
  ```css
  /* style.css:19 */
  --surface-hover: #1b1b20;
  ```
- **初步根因**：孤立问题。render CSS 缺少 `--bg-elevated` token 定义，`bg-surface-hover` 并非为此场景设计的语义 token（surface-hover 语义是"悬停"，elevated 语义是"浮起"，语义不同）
- **修复性质**：长期方案 · 治本 — 在 style.css 新增 `--bg-elevated: #1c1c20` CSS 变量，Panel.vue 将 `bg-surface-hover` 替换为 `bg-elevated`，注释同步修正

---

### [WP-L2-04] Side Drawer 缺失（空 stub）

- **层级位置**：L2 · Workspace.PanelContainer（Side Drawer 方向/浮层）
- **设计要求**：diff 抽屉从 active panel 对侧滑入覆盖 — active-1 从右覆盖 P2，active-2 从左覆盖 P1（workspace/spec.md §边缘状态）。单 Panel 从右滑出。
- **实现现状**：PanelContainer.vue:56 `onDiff()` 为空函数，"diff 抽屉属 Side Drawer（G-023/G detail-pane），DEFERRED，v1 空实现"。无任何 SideDrawer 组件渲染。
- **判定**：❌缺失
- **差异描述**：整个 Side Drawer 子系统未实现。设计定义了完整的多 tab 抽屉（文件×N + 终端，Diff/预览 view-toggle，审批栏 Accept/Reject），实现侧仅留了一个空事件转发。
- **设计证据**：workspace/spec.md §边缘状态 + draft-dual-panel.html `.diff-drawer` 完整 CSS + HTML
- **实现证据**：
  ```ts
  // PanelContainer.vue:56
  function onDiff(): void {
    // diff 抽屉属 Side Drawer（G-023/G detail-pane），DEFERRED，v1 空实现
  }
  ```
- **初步根因**：已知 DEFERRED（G-023），非意外缺失。标注为孤立问题，不影响本 wave 其他锚点。
- **修复性质**：长期方案 — 待 G-023 联调时实现，需同步实现方向逻辑（active-1 → dir-right / active-2 → dir-left）

---

## 三、四层激活标识核查专节

> 逐层对照 workspace/spec.md §Panel激活标识系统 + draft-dual-panel.html `.panel`/`.panel.active` CSS

### 层 1 · 左侧 2px accent 竖条（焦点锚点）

| 维度 | 内容 |
|------|------|
| **设计要求** | 2px accent 实色竖条，绝对定位 left:0，z-index:6。仅 active panel 显示，非 active 透明（`.panel::before { background: transparent }`） |
| **实现** | Panel.vue:26 — `<div v-if="active && isDual" class="absolute left-0 top-0 bottom-0 z-[6] w-[2px] bg-accent" />` |
| **判定** | ✅一致 |
| **备注** | 设计用 `::before` 伪元素，实现用真实 `<div>`（注释说明"避免 scoped 伪元素"）。`v-if` 控制显隐等价于 `background: transparent` 切换，语义等价 |

### 层 2 · inset 1px accent-ring（内描边，30% 透明）

| 维度 | 内容 |
|------|------|
| **设计要求** | 1px `accent-ring`（accent 30% 透明），inset box-shadow，不改盒模型、不抖动。设计注明"避免中缝双线打架" |
| **实现** | Panel.vue:87 — `shadow-[inset_0_0_0_1px_var(--accent-ring)]` |
| **CSS 变量** | style.css:34 — `--accent-ring: rgba(79, 142, 247, 0.30)` |
| **判定** | ✅一致 |
| **备注** | 正确使用 inset box-shadow 而非 border。30% 透明度精确匹配设计 |

### 层 3 · 背景 bg-elevated 微亮

| 维度 | 内容 |
|------|------|
| **设计要求** | active panel `background: var(--bg-elevated)` = #1c1c20；非 active `background: var(--bg-panel)` = #151519 |
| **实现** | active: `bg-surface-hover` = `var(--surface-hover)` = #1b1b20；非 active: 默认无 class → 继承父 `bg-panel`? 实际上 Panel.vue 没有设置非 active 的背景 class，依赖外层。而 PanelContainer.vue 也没有给子 panel 设 bg。需要确认实际背景来源。 |
| **判定** | ⚠偏差 |
| **详情** | 见 [WP-L2-03] 详情卡。差值 #1b1b20 vs #1c1c20，视觉微弱但 token 语义不对 |
| **附带问题** | 非 active panel 未显式设 `bg-panel` — 在单 panel 场景下无激活标识所以不影响，双 panel 下 standby 面板背景色可能继承到不正确的值。需验证 standby panel 背景是否为 #151519 |

### 层 4 · 整体 opacity（1 / 0.5 / hover 0.78）

| 维度 | 内容 |
|------|------|
| **设计要求** | active: opacity 1；非 active: opacity 0.5；hover 回升 0.78。设计注明校准点：0.5 可能偏暗需真机验证 |
| **实现** | Panel.vue:87-90 — active: `opacity-100`；standby: `opacity-50` + `hover:opacity-[0.78]` |
| **判定** | ✅一致 |
| **过渡动画** | Panel.vue:24 — `transition-[background-color,opacity,box-shadow] duration-[var(--duration)] ease-[var(--ease)]` — ✅ 包含 opacity/background/box-shadow 过渡，与设计 `.panel { transition: background var(--dur) var(--ease), opacity var(--dur) var(--ease), box-shadow var(--dur) var(--ease) }` 等价 |
| **备注** | hover 回升动画在 220ms ease 下平滑。0.78 精确匹配设计。0.5 校准点按设计 spec 标注待真机验证 |

### 四层激活标识小结

| 层 | 设计 | 实现 | 判定 |
|----|------|------|------|
| 左侧竖条 | 2px accent | 2px bg-accent `<div>` | ✅ |
| inset ring | 1px accent-ring 30% inset box-shadow | `shadow-[inset_0_0_0_1px_var(--accent-ring)]` | ✅ |
| bg 微亮 | bg-elevated #1c1c20 | bg-surface-hover #1b1b20 | ⚠ |
| opacity | 1 / 0.5 / hover 0.78 | opacity-100 / opacity-50 / hover:opacity-[0.78] | ✅ |

**关键结论**：四层中三层精确对齐，bg 层 token 有 1 点色值偏差 + 语义 token 错位。中缝双线问题已正确规避（inset box-shadow 而非 border）。过渡动画正确覆盖 opacity/background/box-shadow。

---

## 四、主从模式关键行为核查

### 4.1 active panel 对话区永不被压缩

- 实现：双 panel 各 `flex-1` 等宽（panel.ts `DEFAULT_RATIO = 0.5`），不因 active/standby 改变宽度
- 设计意图：active panel 不因附属信息而缩小 — 附属信息推到对侧或内嵌
- **判定**：✅ 正确。等宽分配满足"不被压缩"约束，但不等宽分配（如 active 可拉大）属 v2 需求

### 4.2 单 Panel → 双 Panel 过渡

- 实现：panel.ts `split()` 创建 SplitNode，instant 切换（无动画）。`close()` 同样 instant。
- 设计：draft-dual-panel.html 中 split/close 无动画（纯状态切换）
- **判定**：✅ 一致。设计稿也未定义 split 动画。

### 4.3 中缝 gap + bg-border

- 设计：draft-dual-panel.html `.workspace-body { gap: 1px; background: var(--border); }`
- 实现：PanelContainer.vue:14 — `:class="panel.isDual ? 'gap-px bg-border' : ''"`
- **判定**：✅ 一致。`gap-px` = 1px gap，`bg-border` 透出分隔线颜色。

### 4.4 单 Panel 无激活标识

- 设计：panel/spec.md §单/双 Panel 状态机 — 单 Panel 激活标识"无（唯一 panel）"
- 实现：Panel.vue:26 `v-if="active && isDual"` — 竖条仅双 panel + active 时显示；Panel.vue:86-90 — panelStateClass 仅在 `isDual` 时返回非空 class
- **判定**：✅ 一致。

---

## 五、根因关联标注

| 本 wave 问题 | 关联根因 | 关联性质 |
|-------------|---------|---------|
| WP-L2-03 bg token 偏离 | 无（孤立） | `--bg-elevated` 未在 render CSS 定义，属 token 落地不完整 |
| WP-L2-04 Side Drawer 缺失 | 无（孤立） | 已知 DEFERRED G-023 |

**RC-01/02 影响评估**：Workspace 容器拓扑层不依赖 `settingsStore` 或 `[data-theme]` 切换。激活标识的 accent 色/opacity 均用 Tailwind class 硬编码，不受 theme 切换影响。本 wave 无 RC-01/02 关联。

---

## 六、Wave 小结

- **审查条目数**：6（✅一致 x4 / ⚠偏差 x1 / ❌缺失 x1 / 🆕多余 x0）
- **根因关联数**：0（无 RC 关联，2 个孤立问题）
- **新独立问题数**：
  1. **WP-L2-03**：bg-elevated token 未落地 — render CSS 缺少 `--bg-elevated` 定义，实现用 `bg-surface-hover` 替代，色值差 1 点 + 语义错位。附带注释失实 bug。
  2. **WP-L2-04**：Side Drawer 空 stub — G-023 DEFERRED，不影响主流程但缺失完整的 diff/详情抽屉方向逻辑。
- **正向发现**：四层激活标识的 inset ring / opacity 两层的实现质量高，精确对齐设计值（30% 透明 ring、0.5/0.78 opacity）。中缝双线问题已正确规避。单/双 panel 状态机逻辑健壮。
- **跨 wave 依赖提示**：
  - panel/spec.md §7 "ChatView 废弃待统一" — 本 wave 的 Panel.vue 等组件已使用 `Panel` 术语，无遗留 `ChatView` 引用，术语替换已在实现侧完成。
  - `--bg-elevated` token 缺失可能影响其他组件（如 L2 Card-Active 态），建议 W10/W11 审查时关注。
