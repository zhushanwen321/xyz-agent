# Wave W04 (B-SH) · Shell 层多余/遗留审查（自底向上）

> 审查日期：2026-06-21
> 执行员：W04 (B-SH)
> 方法论：自底向上，逐文件扫描未使用 import / 废弃代码 / 死 CSS / shadcn 残留 / 旧设计遗留。W03 已记的不重复，但复核一致性。
> 关联 W01 根因：RC-05 独立验证

---

## 一、Wave 汇总表

| ID | 层 | 区域.模块 | 组件/锚点 | 判定 | 设计来源 | 实现位置 | 根因标签 |
|----|----|----------|----------|------|---------|---------|---------|
| SH-EX-01 | L0 | Shell.AppNavControls | 折叠态裁剪（跨 wave SB-L2-05 确认） | 🆕 | shell/spec.md §二（AppNavControls left 90→20，无折叠态 third position） | AsideRegion.vue:9 `overflow-hidden` + AppNavControls.vue:9 `absolute left-[90px]` | 孤立（placement 问题） |
| SH-EX-02 | L1 | Shell.Sidebar | collapse 冗余层（与 AsideRegion 重叠） | 🆕 | 无对应设计（实现冗余） | Sidebar.vue:12 `w-0 opacity-0 overflow-hidden` + AsideRegion.vue:9 `overflow-hidden` + :11 `flexBasis:0` | 孤立（belt-and-suspenders） |
| SH-EX-03 | L0 | Shell.AppShell | `.rail-restore` class 无对应 CSS 选择器 | 🆕 | 无对应设计 | AppShell.vue:14 class="rail-restore" | 孤立（debug identifier） |
| SH-EX-04 | L0 | Shell.AppNavControls | `top:[16px]` vs traffic-light `top:20px` 无 spec 依据 | ⚠ | shell/spec.md §三（仅定 left，未定 top） | AppNavControls.vue:9 `top-[16px]` / TrafficLight.vue:10 `top-[20px]` | 孤立（spec 未覆盖） |
| — | — | RC-05 复核 | `aside-region` 引用范围 | ✅确认 | W01 RC-05 | AsideRegion.vue:9（唯一引用） | 根因关联→RC-05 |
| — | — | W03 复核 | AppShell.vue:43 注释失实 | ✅一致 | W03 已记 | AppShell.vue:43 `data-platform / data-fullscreen` 实际只设 data-platform | W03 已记 |
| — | — | W03 复核 | border-radius:10px 缺失 | ✅一致 | W03 SH-L0-01 | AppShell.vue:6 无 rounded-[10px] | W03 已记 |
| — | — | W03 复核 | ⌘B 三态优先级 | ✅一致 | W03 SH-L0-08 | Sidebar.vue:134-143 仅 toggle | W03 已记 |
| — | — | W03 复核 | draft traffic light 色值冲突 | ✅一致 | W03 额外发现 | TrafficLight.vue:41-43 用 spec 正文值（非 draft） | W03 已记 |

**判定统计**：🆕 3 / ⚠ 1 / ✅复核 5（RC-05 + W03×4）

---

## 二、条目详情卡

### [SH-EX-01] 🆕 AppNavControls 折叠态裁剪根因（跨 wave SB-L2-05 确认）

- **层级位置**：L0 · Shell.AppNavControls
- **设计要求**：shell/spec.md §二 定义 AppNavControls 两态位移——非全屏 `left:90px`，全屏 `left:20px`。折叠态 spec 未定义第三个位置（"收起侧栏后的折叠态布局未定 → 属 L2 模块"），但隐含期望：←/→ 导航按钮应在折叠态仍可用。
- **实现现状**：
  - AppNavControls 挂载在 AsideRegion 内部（`absolute top-[16px] left-[90px] z-10`）
  - AsideRegion 折叠时 `flexBasis: '0px'` + `overflow:hidden` → 容器可视区域归零
  - AppNavControls 在 `left:90px` 处，完全落在 0 宽视口外 → 被裁剪不可见
  - AppShell.vue:10 **注释已识别同类问题**：`"aside 折叠后 width:0+overflow-hidden 会切内含元素，放父层才可见"`（指 rail-restore）
- **判定**：🆕多余 — placement 问题致 UI 不可达
- **差异描述**：AsideRegion 用 `overflow:hidden` 约束 flex 子宽度（必要），但 AppNavControls 作为绝对定位子元素也需要在折叠态可见，却被一同裁剪。AppShell 的 rail-restore 已为同类问题移至父层，AppNavControls 未做同样处理。
- **设计证据**：
  - spec.md §二（AppNavControls 两态 `left:90px→20px`，320ms 平移）
  - spec.md §八 "收起侧栏后的折叠态布局未定 → 属 L2 模块"
  - AppShell.vue:10 注释：`"aside 折叠后 width:0+overflow-hidden 会切内含元素，放父层才可见"`
- **实现证据**：
  - AsideRegion.vue:9 `class="...overflow-hidden..."`
  - AsideRegion.vue:10-16 `flexBasis: sidebar.collapsed ? '0px' : '200px'`
  - AppNavControls.vue:9 `class="...absolute top-[16px] left-[90px]..."`
- **初步根因**：孤立（placement 问题，非 overflow 策略问题）。`overflow:hidden` 是 flex 布局正确所需（不能删），问题在于 AppNavControls 不应是其子元素。
- **修复性质**：长期方案 · 将 AppNavControls 提升到 AppShell 层（与 rail-restore 同级），用与 TrafficLight 相同的 `usePlatformChrome().isFullscreen` ref 控制 left 位移。折叠态 left 可用 spec §二全屏值 `20px` 或新增 `collapsedLeft` token。

---

### [SH-EX-02] 🆕 Sidebar.vue collapse 冗余层

- **层级位置**：L1 · Shell.Sidebar
- **设计要求**：无直接设计要求（collapse 由 AsideRegion flexBasis 控制）
- **实现现状**：折叠态触发两层 collapse 机制：
  1. 父层 AsideRegion：`flexBasis: 0px` + `overflow:hidden` → 容器归零，裁剪子元素（AsideRegion.vue:9-16）
  2. 子层 Sidebar：`:class="{ 'w-0 opacity-0 overflow-hidden': sidebar.collapsed }"` → 自身归零（Sidebar.vue:12）
  3. 子层 Sidebar 内层：硬编码 `w-[200px]` —— 容器 `w-0` 下被裁剪（Sidebar.vue:14）
- **判定**：🆕多余 — 冗余 collapse 保护
- **差异描述**：父层 AsideRegion 已将容器归零 + overflow:hidden 裁剪，子层 Sidebar 再做 w-0/opacity-0/overflow-hidden 是重复劳动。非 bug（belt-and-suspenders 无害），但 collapse 职责分散在两层，降低可维护性。
- **设计证据**：无对应设计（非 spec 要求，是实现的 belt-and-suspenders）
- **实现证据**：AsideRegion.vue:9-16 + Sidebar.vue:12
- **初步根因**：孤立。可能 Sidebar 最初独立控制 collapse，后续 AsideRegion 接管了 collapse 但 Sidebar 的 collapse class 未清理。
- **修复性质**：短期方案 · 评估 Sidebar 是否仍需自己的 collapse class（可能用于 opacity transition 而非裁剪）。如需保留 opacity transition，去掉 `w-0 overflow-hidden` 只留 `opacity-0`。

---

### [SH-EX-03] 🆕 `.rail-restore` class 无对应 CSS 选择器

- **层级位置**：L0 · Shell.AppShell
- **设计要求**：无对应设计（rail-restore 是实现细节）
- **实现现状**：AppShell.vue:14 的 rail-restore div 有 class `rail-restore`，但所有样式均由 Tailwind 内联类提供（`absolute bottom-0 left-0 top-0 z-20 w-[3px]...`），`.rail-restore` 作为 CSS 选择器全项目无引用（grep 确认仅此一处）。
- **判定**：🆕多余 — debug identifier only
- **差异描述**：class 名 `rail-restore` 不是 CSS hook，仅作 DOM debug 标识。不是 bug，但在 Dead Code Elimination 视角下是零功能 class。
- **设计证据**：无对应设计
- **实现证据**：AppShell.vue:14（唯一定义）+ grep 全项目仅 1 处匹配
- **初步根因**：孤立（编码习惯——用语义 class 名标注 DOM 节点，即使无对应 CSS）
- **修复性质**：不修。保留有益于 DevTools 调试。

---

### [SH-EX-04] ⚠ AppNavControls `top:[16px]` 无 spec 依据

- **层级位置**：L0 · Shell.AppNavControls
- **设计要求**：spec.md §三 定义 traffic-light `top:20px`，AppNavControls 的 `top` 未明确定义（仅指定 `left:90px/20px`）
- **实现现状**：AppNavControls.vue:9 使用 `top-[16px]`，与 TrafficLight.vue:10 的 `top-[20px]` 差 4px。偏移可能是为了 22px 按钮行与 12px traffic light 圆点的视觉居中对齐（`(22-12)/2 ≈ 5px` → `20-4=16`），但 spec 未文档化此偏移逻辑。
- **判定**：⚠偏差 — spec 未覆盖，实现有隐含对齐逻辑
- **差异描述**：AppNavControls top 偏离 traffic-light top 4px，可能是刻意的视觉对齐，但 spec 未记录。若未来 traffic-light 高度调整，此偏移可能失效。
- **设计证据**：spec.md §三（仅定义 traffic-light `top:20px`，AppNavControls top 未指定）
- **实现证据**：AppNavControls.vue:9 `top-[16px]` vs TrafficLight.vue:10 `top-[20px]`
- **初步根因**：孤立（spec 覆盖不足）
- **修复性质**：短期方案 · 在 spec §三 补充 token `--anc-top: 16px` 或注释说明对齐关系。

---

## 三、W01 根因关联复核

### RC-05 · `aside-region` 废弃术语

**确认结果**：代码侧唯一引用 `AsideRegion.vue:9`。Grep 全项目（`*.vue/*.ts/*.css/*.html/*.js`）仅此 1 处匹配。

**额外发现**：构建产物的 dist CSS 中有 `.aside-region[data-v-c9e97387]{width:200px;padding-top:52px}`。这个带 scoped hash 的规则来源不明——AsideRegion.vue 无 `<style>` 块（37 行纯 template+script），`w-[200px]` 是 Sidebar.vue:14 子元素使用的 Tailwind class（不是 AsideRegion 自身的 class）。此 dist CSS 规则可能是构建工具的 artifact，不影响功能（inline `:style` binding 优先级更高）。

**结论**：`根因关联→RC-05` 确认。引用唯一，清理安全。但 spec.md 自身使用 `aside-region`，Phase C 收敛时建议统一为 `aside-left`（对齐 draft-skeleton.html）或保留 `aside-region`（对齐 spec.md）。

### RC-01/02/06 · settingsStore / data-theme / darkMode

**影响判定**：Shell 层 5 文件均不依赖 theme 切换，不受 RC-01/02/06 影响。（与 W03 结论一致）

---

## 四、AppNavControls 折叠态根因确认专节（跨 wave SB-L2-05）

### 问题复述

W05（批次 1）发现 **AppNavControls 折叠态被 AsideRegion `overflow:hidden` + `flexBasis:0` 裁剪**（SB-L2-05 ⚠）。W03 审 AppNavControls 锚点时未覆盖折叠态场景（判 ✅）。本 wave 独立确认根因。

### 证据链

| # | 证据 | 位置 |
|---|------|------|
| 1 | AsideRegion 根元素 `overflow-hidden`（常驻，非折叠态特化） | AsideRegion.vue:9 |
| 2 | 折叠时 `flexBasis: sidebar.collapsed ? '0px' : '200px'` | AsideRegion.vue:11 |
| 3 | `position: relative`（为 absolute 子提供 offset parent） | AsideRegion.vue:9 |
| 4 | AppNavControls `absolute top-[16px] left-[90px]`（offset parent = AsideRegion） | AppNavControls.vue:9 |
| 5 | 折叠时容器 clip region = 0×h → left:90px 完全在外 | CSS 盒模型推论 |
| 6 | AppShell 注释确认同类问题：rail-restore **已**提至 AppShell 父层 | AppShell.vue:10 |

### 根因判定

**Placement 问题**，不是 overflow 策略问题。

- `overflow:hidden` 在 AsideRegion 上正确且必要——flex 布局依赖它约束子元素宽度。去掉它会导致 Sidebar 内容撑开容器，折叠态失效。
- 问题在于 AppNavControls 需要跨两态（展开/折叠）可见，却被放在了一个会将其裁剪的容器内。
- AppShell 的 rail-restore 已为**完全相同的场景**做过修正：`"aside 折叠后 width:0+overflow-hidden 会切内含元素，放父层才可见"`（AppShell.vue:10）。AppNavControls 应做同样处理。

### 修复建议（不执行，仅分析）

**推荐**：将 AppNavControls 移到 AppShell 层（与 rail-restore 同级），作为 AsideRegion 的兄弟节点：

```html
<!-- AppShell.vue -->
<div class="app-shell ...">
  <AsideRegion />
  <TrafficLight />       <!-- 已在 AsideRegion 内，不需移 -->
  <AppNavControls />     <!-- ★ 从 AsideRegion 内部移到这里 -->
  <div v-if="sidebar.collapsed" class="rail-restore ..." />
  <MainPanel />
</div>
```

- AppNavControls 用 `position: fixed` 或 `absolute` 相对 app-shell 定位
- left 值：非全屏 `90px`（= p-3 12px + TrafficLight 72px + 呼吸 6px? no. Actually, the spec says 90px which is relative to the window edge. If moved to AppShell which has `p-3`, the absolute positioning would need to account for the padding. Better to use `fixed` positioning.)
  
  更精确的方案：用 `position: fixed; top: 16px; left: 90px`（相对于窗口），避开容器 padding 的影响。这与 TrafficLight 的 `position: absolute; top: 20px; left: 20px`（offset parent 为 AsideRegion，无 padding 影响）类似——AsideRegion 的 padding-top:52px 只影响正常流内容，不影响 absolute 子元素。

  如果 AppNavControls 用 `fixed`，则 `top: 16px` vs TrafficLight 的 `top: 20px`（absolute 相对 AsideRegion 顶部 = 20px 距离窗口顶）需要对应调整。

**替代方案**：折叠态将 AsideRegion 的 `overflow` 临时切为 `visible`——但此方案会破坏 flex 布局（sidebar 内容撑开），不推荐。

---

## 五、Wave 小结

- **审查文件数**：5（AppShell.vue / AsideRegion.vue / MainPanel.vue / AppNavControls.vue / TrafficLight.vue）
- **多余条目**：🆕 3 / ⚠ 1
- **根因关联数**：1（RC-05 确认）
- **新独立问题**：4
  1. SH-EX-01 🆕 AppNavControls 折叠态裁剪（根因：placement 应在 AppShell 层）
  2. SH-EX-02 🆕 Sidebar.vue collapse 冗余层（AsideRegion 已处理 collapse，Sidebar 重复 w-0+overflow-hidden）
  3. SH-EX-03 🆕 `.rail-restore` class 无 CSS hook（仅 debug identifier）
  4. SH-EX-04 ⚠ AppNavControls `top:16px` 无 spec 文档化（对齐逻辑未记录）
- **跨 wave 确认**：
  - W05 SB-L2-05（AppNavControls 折叠态裁剪）→ 根因确认为 placement 问题，非 overflow 策略问题
  - W03 4 个已记问题复核一致（border-radius / ⌘B / 注释失实 / 色值冲突）
- **无死 import / 无 TODO/FIXME / 无 shadcn 残留**：5 文件全部 import 均有消费方，0 行注释代码，0 TODO/FIXME
