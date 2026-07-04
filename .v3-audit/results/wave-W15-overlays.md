# Wave W15 (A-OL) · Overlays SearchModal 审查结果

> 审查日期：2026-06-21
> 层级范围：L1-L3 · Overlays
> 锚点数：7
> 设计来源：`overlays/spec.md` + `draft-search-modal.html`
> 实现源：`src-electron/renderer/src/components/overlays/SearchModal.vue`

---

## 一、Wave 汇总表

| ID | 层 | 区域.模块 | 组件/锚点 | 判定 | 设计来源 | 实现位置 | 根因标签 |
|----|----|----------|----------|------|---------|---------|---------|
| OL-L1-01 | L1 | Overlays.SearchModal | 归属 L0 Overlay 级，z-index 1000 | ⚠ | overlays/spec.md §归属与边界 | SearchModal.vue:13-16 | 孤立 |
| OL-L2-01 | L2 | Overlays.SearchModal | 入口 ⌘K/Ctrl+K + Sidebar「搜索」nav | ❌ | overlays/spec.md §背景 | SearchModal.vue:1-8（注释） | 孤立 |
| OL-L2-02 | L2 | Overlays.SearchModal | 四类分组固定顺序 | ❌ | overlays/spec.md §四类分组 | SearchModal.vue:26-33（占位） | 孤立 |
| OL-L2-03 | L2 | Overlays.SearchModal | 键盘契约 ↑↓/Enter/Esc/Tab | ❌ | overlays/spec.md §键盘契约 | SearchModal.vue:18-25 | 孤立 |
| OL-L3-01 | L3 | Overlays.SearchModal | 5 态（默认/查询分组/类型过滤/空结果/加载） | ❌ | overlays/spec.md §状态 | SearchModal.vue:26-33 | 孤立 |
| OL-L3-02 | L3 | Overlays.SearchModal | 匹配高亮 `<mark class="hl">` | ❌ | overlays/spec.md §实现要点 | SearchModal.vue:26-33 | 孤立 |
| OL-L3-03 | L3 | Overlays.SearchModal | 无障碍 role="dialog"/aria-modal/focus trap | ⚠ | overlays/spec.md §实现要点 | SearchModal.vue:14, ui/dialog/DialogContent.vue:23-55 | 孤立 |

**判定分布**：✅ 0 / ⚠ 2 / ❌ 5 / 🆕 0

---

## 二、条目详情卡

### OL-L1-01 · 归属 L0 Overlay 级 + z-index 1000

- **层级位置**：L1 · Overlays.SearchModal（独立 Overlay 组件）
- **设计要求**：Search Modal 归属 L0 Overlay 级，z-index 1000，浮于 Sidebar/Workspace 之上，不归属任何 Region（overlays/spec.md §归属与边界）
- **实现现状**：使用 shadcn Dialog + Portal 渲染到 `<body>` 末端，正确实现"浮于所有 Region 之上"的 Overlay 行为。但 z-index 为 `z-50`（DialogContent.vue:24, :34），非 spec 要求的 z-1000（SearchModal.vue:13-16）
- **判定**：⚠ 偏差
- **差异描述**：Overlay 行为正确（DialogPortal 渲染到 body，脱离正常文档流），但 z-index 值 `50` vs spec 要求 `1000`。当前无冲突（OS traffic light 由系统绘制），但若未来有其它需要严格 z-index 分层的 Overlay（如确认 toast z-1100），当前 50 值可能不够留白
- **设计证据**：> spec §实现要点："z-index：浮层 1000，遮罩同层；确认 toast 1100。高于 Sidebar / Workspace / Workspace 顶栏"
- **实现证据**：`ui/dialog/DialogContent.vue:24` — `class="fixed inset-0 z-50 bg-black/80 ..."`；`:34` — `class="... z-50 grid ..."`
- **初步根因**：孤立问题。shadcn Dialog 默认值是 `z-50`，组件未覆盖。非 RC-01 等相关
- **修复性质**：短期方案 — 在 SearchModal 调用处通过 `class` prop 覆盖 z-index 或调整 DialogContent 基类的 `z-{n}`

---

### OL-L2-01 · 入口 ⌘K/Ctrl+K + Sidebar「搜索」nav 项

- **层级位置**：L2 · Overlays.SearchModal · 入口层
- **设计要求**：⌘K / Ctrl+K 全局快捷键唤起 + Sidebar「搜索」nav 项作为视觉入口（overlays/spec.md §背景）
- **实现现状**：两者均 DEFERRED。SearchModal.vue 模板注释（行 1-8）明确标注"DEFERRED（spec §9）：触发入口（⌘K / sidebar「搜索」nav，G3-002 hide，v1 不渲染触发入口）"。Sidebar.vue:7 同样标注搜索入口 DEFERRED hide
- **判定**：❌ 缺失
- **差异描述**：设计需要两个独立入口（全局快捷键 + Sidebar nav），v1 两个都未实现。SearchModal 仅通过 `v-model:open` prop 受控，无任何调用方渲染触发入口（待 G-022 联调）
- **设计证据**：> spec §背景："Search Modal 是 L0 Shell 的 Overlay 级组件——⌘K 触发"；> Sidebar 注："Sidebar 仅保留「搜索」**触发入口**（nav 项 + ⌘K）"
- **实现证据**：`SearchModal.vue:3-8` — 模板注释 "DEFERRED（spec §9）：触发入口...v1 不渲染触发按钮"；`Sidebar.vue:7` — "DEFERRED 入口 hide：搜索（⌘K，G-022）"
- **初步根因**：孤立。v1 骨架阶段的功能边界划定，入口在 G-022 联调阶段接入
- **修复性质**：长期方案 — G-022 联调阶段接入，需同时处理 Sidebar 入口 + 全局 keydown 监听（capture phase）

---

### OL-L2-02 · 四类分组固定顺序

- **层级位置**：L2 · Overlays.SearchModal · 结果呈现
- **设计要求**：四类分组（命令/文件/符号/会话）按固定顺序展示，每组含图标语义、数据源、跳转目标定义（overlays/spec.md §四类分组）
- **实现现状**：仅占位文案 "四类分组 · 跨项目范围（G-022 DEFERRED）"（SearchModal.vue:26-33），无实际分组渲染
- **判定**：❌ 缺失
- **差异描述**：spec 定义了完整的四类（命令/文件/符号/会话）分组表，each with 图标语义/数据源/跳转目标。v1 仅空态占位，无任何分组逻辑
- **设计证据**：> spec §四类分组 — 完整的四行表（类型/图标语义/数据源/跳转目标）
- **实现证据**：`SearchModal.vue:31-33` — 占位文字 "四类分组 · 跨项目范围（G-022 DEFERRED）"
- **初步根因**：孤立。四类的后端索引/数据源（LSP/ripgrep/会话库）未接入，v1 不渲染
- **修复性质**：长期方案 — G-022 联调，需对接四类后端 + 分组渲染组件

---

### OL-L2-03 · 键盘契约 ↑↓/Enter/Esc/Tab

- **层级位置**：L2 · Overlays.SearchModal · 交互层
- **设计要求**：↑↓跨组扁平化移动选中项 / Enter 确认 / Esc 关闭 / Tab/Shift+Tab 循环切类 / Home/End 可选（overlays/spec.md §键盘契约）
- **实现现状**：仅 Esc 关闭通过 Radix Dialog 内置支持生效。无 ↑↓/Enter/Tab 等键盘导航实现。SearchModal.vue 模板中仅 Esc 键盘提示（`<kbd>Esc</kbd>`，行 25）
- **判定**：❌ 缺失
- **差异描述**：spec 定义了完整的键盘契约（5+ 键行为），包括跨组扁平化移动（非分组内循环），唤起自动 focus 输入框光标置末尾，输入 debounce 120ms。v1 仅 Esc 关闭可用
- **设计证据**：> spec §键盘契约 — 表格定义 ⌘K/Esc/↑/↓/Enter/Tab/Shift+Tab/Home/End 的全部行为；> spec §实现要点："唤起即 focus() 输入框、光标置末尾。输入走 debounce(120ms) 再查索引"
- **实现证据**：`SearchModal.vue:18-25` — 仅 `<Input v-model="query">` + Esc 键盘提示，无键盘事件处理
- **初步根因**：孤立。键盘导航依赖于结果列表渲染（OL-L2-02 DEFERRED）
- **修复性质**：长期方案 — G-022 联调，与 OL-L2-02 同批次实现

---

### OL-L3-01 · 5 态（默认/查询分组/类型过滤/空结果/加载）

- **层级位置**：L3 · Overlays.SearchModal · 状态机
- **设计要求**：5 态状态机：① 默认(recents) — 唤起查询为空时展示每类最近 5 项；② 查询分组 — 输入查询命中后四类分组+命中计数；③ 类型过滤 — Tab 切类后只显所选类；④ 空结果 — 无命中空态插画+建议操作；⑤ 加载 — 索引查询 >200ms 时骨架/加载条（overlays/spec.md §状态）
- **实现现状**：仅实现了"空态"的两个变体：查询为空 → "输入关键词开始搜索"、查询有值 → "暂无匹配结果"。recents/查询分组/类型过滤/加载均 DEFERRED（SearchModal.vue:26-33）
- **判定**：❌ 缺失
- **差异描述**：5 态状态机只实现了 1/5。缺失的 recents 态（唤起默认展示）是用户体验关键——用户唤起 ⌘K 应直接看到最近项而非空白空态
- **设计证据**：> spec §状态 — 5 态表格定义（触发条件 + 内容）
- **实现证据**：`SearchModal.vue:29-30` — 仅 `query ? '暂无匹配结果' : '输入关键词开始搜索'`，两行文案对应空态的两个文本变体
- **初步根因**：孤立。recents 需要持久化机制（spec §遗留④ 待定策略），查询分组/加载依赖于后端索引（G-022）
- **修复性质**：长期方案 — G-022 联调，需 recents 持久化+后端索引后端就绪

---

### OL-L3-02 · 匹配高亮 `<mark class="hl">`

- **层级位置**：L3 · Overlays.SearchModal · 视觉细节
- **设计要求**：后端返回命中区间数组，前端渲染为 `<mark class="hl">`，样式 `color:accent`，不加背景（overlays/spec.md §实现要点）
- **实现现状**：无结果渲染 → 无匹配高亮（SearchModal.vue:26-33 仅文本占位）
- **判定**：❌ 缺失
- **差异描述**：高亮渲染组件和 `<mark class="hl">` 样式均未实现。依赖于 OL-L2-02（结果渲染）和 OL-L3-01（查询分组态）先落地
- **设计证据**：> spec §实现要点："匹配高亮：后端返回命中区间数组，前端渲染为 `<mark class="hl">`（`color:accent`，不加背景，避免打断阅读节奏）"
- **实现证据**：`SearchModal.vue:26-33` — 无任何 mark/highlight 渲染代码
- **初步根因**：孤立。依赖 OL-L2-02 结果渲染先落地
- **修复性质**：长期方案 — 与 OL-L2-02 同批次，需后端返回 `[{start, end}]` + 前端区间切分渲染

---

### OL-L3-03 · 无障碍 role="dialog"/aria-modal/focus trap

- **层级位置**：L3 · Overlays.SearchModal · 无障碍
- **设计要求**：`role="dialog"` + `aria-modal="true"`；打开时 trap focus 在浮层内，关闭后焦点还给触发元素；结果列表 `role="listbox"`，项 `role="option" aria-selected`（overlays/spec.md §实现要点）
- **实现现状**：`aria-modal="true"` 显式声明 ✅（SearchModal.vue:14）。`role="dialog"` 和 focus trap 由底层的 Radix DialogContent 提供（DialogContent.vue:23-55 包装了 Radix `DialogContent` + `DialogPortal` + `DialogOverlay`），未在组件代码中显式体现。结果列表 ARIA 无（结果渲染 DEFERRED）。DialogClose（X 按钮）通过 shadcn DialogContent 内置提供（DialogContent.vue:42-45）
- **判定**：⚠ 偏差
- **差异描述**：Modal 级 ARIA（role="dialog" + aria-modal + focus trap + focus restore）由 Radix 代理实现，功能正确但非显式满足 spec 的"代码可见"要求。结果列表级 ARIA（role="listbox"/role="option"）因结果未渲染而不适用
- **设计证据**：> spec §实现要点："无障碍：role="dialog" + aria-modal="true"；打开时 trap focus 在浮层内，关闭后焦点还给触发元素（Sidebar「搜索」nav 项或当前 active 区）。结果列表 role="listbox"，项 role="option" aria-selected"
- **实现证据**：`SearchModal.vue:14` — `aria-modal="true"` 显式声明；`ui/dialog/DialogContent.vue:23,34-36` — Radix `DialogContent` 包装（提供 role="dialog" + focus trap）
- **初步根因**：孤立。Radix 代理 ARIA 是合理的架构选择（不自己造 dialog），但缺少显式的 role="dialog" 声明降低了代码可审计性
- **修复性质**：短期方案 — 在 DialogContent 上显式加 `role="dialog"`；或接受 Radix 代理（功能等价的长期方案）。结果 listbox ARIA 等 G-022 联调时追加

---

## 三、Wave 小结

- **审查条目数**：7（✅ 0 / ⚠ 2 / ❌ 5 / 🆕 0）
- **常规条目数**：5（OL-L2-01/02/03, OL-L3-01/02 均因 G-022 DEFERRED）
- **根因关联数**：0（W15 无 RC-01/RC-02 相关性，SearchModal 不涉及 theme/locale/settingsStore）
- **偏差条目数**：2（OL-L1-01 z-index + OL-L3-03 ARIA 委托）
- **新独立问题数**：0（所有发现均为已知 v1 范围划定内的 DEFERRED 或架构决策）

**总体评价**：SearchModal v1 骨架范围收得极紧——仅 modal 形态（遮罩 + 居中浮层 + 焦点输入框 + 空态）落地，其余全部 defer 到 G-022。骨架本身无架构级问题（shadcn Dialog 用对了 Overlay 行为），z-index 偏差属配置级小事。

**跨 wave 依赖提示**：无。SearchModal 不依赖任何其他 wave 的组件。
