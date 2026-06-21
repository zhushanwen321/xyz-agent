# Wave W12 · Composer 8+ 态 + 工具区 + @浮层 — 审查报告

> 审查日期：2026-06-21  
> 审查范围：L2-L4 · Panel zone ④ Composer（输入区 + 工具区视觉一体）  
> 设计来源：panel/spec.md §composer + draft-composer-states.html + draft-companion-zones.html  
> 实现来源：Composer.vue + chat.ts + useChat.ts + Panel.vue  
> 审查锚点：9（WP-L3-15 ~ WP-L3-23）  
> 上游发现引用：W02（Textarea min-height/focus-ring）+ W09（5 zone 编排确认）

---

## 一、Wave 汇总表

| ID | 层 | 区域.模块 | 组件/锚点 | 判定 | 设计来源 | 实现位置 | 根因标签 |
|----|----|----------|----------|------|---------|---------|---------|
| WP-L3-15 | L3 | Panel.Composer | 输入区 + 工具区视觉一体 | ⚠ | panel/spec.md §composer + draft §1 | Composer.vue:16-47 | `根因关联→RC-04` |
| WP-L3-16 | L3 | Panel.Composer | 空态（composer 无内容） | ⚠ | draft S1 card | Composer.vue:8-57 | 孤立 |
| WP-L3-17 | L3 | Panel.Composer | 输入中态（多行 + 自动高 + shift+enter 换行） | ⚠ | draft S2 card | Composer.vue:16-57,143-146 | `根因关联→BUI-TA-02` |
| WP-L3-18 | L3 | Panel.Composer | @浮层（上下文候选列表，composer 内部状态） | ❌ | draft §2d S3 card | 未找到（注释声明 DEFERRED G2-002） | 孤立 |
| WP-L3-19 | L3 | Panel.Composer | 附件态（图片/文件拖拽） | ❌ | draft S4 card | 未找到（注释声明 DEFERRED G2-002） | 孤立 |
| WP-L3-20 | L3 | Panel.Composer | 发送中 / 停止态 | ⚠ | draft S5/S6 cards | Composer.vue:30-52,95-135 | 孤立 |
| WP-L3-21 | L3 | Panel.Composer | Steer pending 态（AI 工作中提交引导，排队不打断） | ❌ | draft §4 S6/S7 cards | 未找到（注释声明 DEFERRED G-019） | 孤立 |
| WP-L3-22 | L3 | Panel.Composer | Followup pending 态（AI 完成后提交追问，开新一轮） | ❌ | draft §4 S7 card | 未找到（注释声明 DEFERRED G-019） | 孤立 |
| WP-L3-23 | L3 | Panel.Composer | 工具区 5 项：+添加/上下文/模型/thinking-level/发送 | ⚠ | draft §1 §2 | Composer.vue:22-50 | 孤立 |

**汇总**：✅ 0 / ⚠ 5 / ❌ 4 / 🆕 0

---

## 二、★工具区 5 项逐项核查专节（差异点②核心）

| # | 工具项 | 设计要求（draft §1-§2） | 实现现状（Composer.vue） | 判定 |
|---|--------|------------------------|--------------------------|------|
| ① | **+添加内容** | `.c-insert` 按钮，左锚定，`width:28px;height:28px`，hover 浮 `--bg-hover`，click → 4 路菜单（附件/@引用/#文件//命令） | **模板中不存在**。注释声明 "hide（触发的 S3/S4 浮层 G2-002 DEFERRED → 按 G3-002 hide 规则，不留无反应按钮）" | ❌缺失 |
| ② | **上下文状态** | `.c-text.ctx` 按钮（`border:0;background:transparent`），文字显示 `N · N%`（数值=tabnum），hover 浮 `--bg-hover` + popover（容量条 + 已用/总量/使用率/缓存命中率 4 项统计）。用量>70% 转 warning | `<span>` 静态展示 `"0 · 0%"`（`text-subtle`），**无 hover 效果、无 popover、无 warning 分档**。注释 "容量 popover §2a DEFERRED" | ⚠偏差 |
| ③ | **模型选择器** | `.c-text.model` 按钮，文字显当前模型名，带 `▾` chevron（click 旋转 180°），click → provider 分组 select（非级联，平铺单层选，含搜索框）。选中项 `active` 高亮 + check 标记 | `<span>` 静态展示 `"sonnet-4.5"`，**无 chevron、无 click、无 popover**。注释 "切换 popover §2b DEFERRED" | ⚠偏差 |
| ④ | **thinking-level** | `.c-text.think` 按钮，6 级（off/low/medium/high/xhigh/max），默认 max。按 `data-lvl` 染色：medium 柔紫→high 纯紫→xhigh 紫+光晕→max 紫底白字+外发光。click → popover 6 级列表（点大小+光晕递进） | `<span>` 静态展示 `"思考 最高"`（`text-subtle`），**无颜色分级、无 chevron、无 click、无 popover**。注释 "切换 §2c DEFERRED" | ⚠偏差 |
| ⑤ | **发送按钮** | 三态：idle → `.c-send`（accent 实色，`width:30px;height:30px;border-radius:8px`，hover→accent-hover，disabled→透明文字）；streaming → `.c-stop`（`bg:surface-2`，hover→danger 红底）；sending → `.c-spinner`（accent-soft 底，spinner 旋转） | ✅ 三态实现：send(ArrowRight, accent bg, disabled=transparent) / stop(Square, ghost, hover danger bg) / sending(Loader2, accent bg) | ✅一致 |

### 工具区布局偏差

| 维度 | 设计要求 | 实现现状 |
|------|---------|---------|
| 排列方向 | 左：+添加 → 右锚定区：上下文/模型/思考 → 最右：发送 | 实现无+添加，其余三项 `justify-end` 右对齐 + 发送右锚定（`ml-1.5`） ✅ |
| 按钮样式 | 上下文/模型/思考：`border:0;background:transparent` 无边框纯文字，`gap:2px` 排列，不画分隔线 | 全部 `<span>` 静态文字，`px-2 py-1.5`，`gap-0.5`，无边框 ✅ |
| 文字色 | `--text-tertiary` | `text-subtle`（语义接近，但非完全等价于 `text-tertiary`）⚠ |
| hover 反馈 | hover 浮 `--bg-hover`，移开即隐 | 无 hover（`<span>` 不可交互） |
| 发送唯一实色 | 发送是唯一实色锚点 | ✅ 发送 accent 实色 |

---

## 三、★steer/followup/状态机核查专节

### 3.1 整体状态机覆盖

| 状态 | Design | 实现 | 判定 |
|------|--------|------|------|
| S1 空 | placeholder + 0·0% + send disabled | 基本一致（placeholder 略短） | ⚠ |
| S2 输入中 | 中性聚焦 ring + send 激活 | ✅ 中性 ring + send 激活 | ✅ |
| S3 @/#// 浮层 | composer 内 popover 向上开 | ❌ 未实现（DEFERRED G2-002） | ❌ |
| S4 附件 | chip 在 composer-box 内输入区上方 | ❌ 未实现（DEFERRED G2-002） | ❌ |
| S5 发送中 | opacity 0.55 + 输入禁+保留文字 + spinner | opacity 0.55 ✅ / 输入禁用 ✅ / **文字清空** ⚠ / spinner ✅ | ⚠ |
| S6 停止 | 停止按钮(danger hover) + 输入可用 + accent 蓝呼吸 ring + steer/followup hint | 停止按钮 ✅ / 输入可用 ✅ / **中性 ring（非 accent）** ⚠ / **hint 不同** ⚠ | ⚠ |
| S7 steer/followup pending | pending 气泡两色区分 | ❌ 未实现（G-019 DEFERRED） | ❌ |
| S8 双队列 | steering/followUp 分组可展开 | ❌ 未实现（G-019 DEFERRED） | ❌ |
| S9 发送失败 | danger 边框 + error 提示条 + 重试/× | ❌ 未实现（仅 draft 恢复，无 UI 反馈） | ❌ |

### 3.2 Steer/Followup 关键差异详析

| 维度 | 设计要求 | 实现现状 | 偏差程度 |
|------|---------|---------|---------|
| **S6 聚焦 ring** | `composer-box.focus.steer` → accent 蓝 `border-color:var(--accent)` + 呼吸动画 `steer-breathe 2.6s` | `border-[var(--border-strong)] shadow-[0_0_0_2px_rgba(255,255,255,0.04)]` → **中性 ring** | 重大偏差 — accent 蓝专属 steer 信号被稀释 |
| **S6 placeholder** | "想补充什么？⏎ 加入当前任务 · Alt+⏎ 排到下一轮…" | "AI 正在工作中，按「停止」中断…" | 完全不同的提示语义 |
| **S6 hint** | `⏎` 追加 steer · `Alt+⏎` 新轮 followup · `⇧⏎` 换行 | "AI 正在工作中 · 按「停止」中断" | 缺失 steer/followup 操作引导 |
| **Steer 提交** | `⏎`（S6 态）→ `rt.steer()` | `⏎` 被禁用（`if (!isStreaming.value) onSend()` 阻止 streaming 时发送） | ❌ 完全未实现 |
| **Followup 提交** | `Alt+⏎`（S6 态）→ `rt.followup()` | `Alt+⏎` 无任何逻辑（onKeydown 不处理 Alt 修饰） | ❌ 完全未实现 |
| **Pending 气泡** | 虚线 + 脉冲点 + 两色区分（accent 蓝 steer / info 青 followup）+ WHO 标 + 副文案 | 无 | ❌ 完全未实现 |
| **双队列视图** | steering / followUp 分组可展开，只读镜像 | 无 | ❌ 完全未实现 |

### 3.3 S6 实现的根本矛盾

当前 S6 实现存在一个自相矛盾的状态机：
1. `isStreaming=true` 时显示 stop 按钮（代替 send）— ✅
2. `isStreaming=true` 时 textarea **不禁用**（可以输入）— ✅  
3. 但 `onKeydown` 中 `if (!isStreaming.value) onSend()` 阻止了 Enter 发送 — **键盘无任何动作**
4. placeholder 引导用户「按停止中断」，而非「输入补充指令」
5. 用户输入区可用但 Enter 无效 = **死胡同 UI**：能打字但不能提交

与设计 S6 的行为完全相反：设计期望 S6 是"steer 追加"的主入口，当前实现把 S6 变成了"输入无用"的过渡态。

---

## 四、Textarea 原子覆写核查

### 4.1 min-height 覆写

| 维度 | 原子 Textarea | Composer 使用 | 设计要求 |
|------|-------------|--------------|---------|
| min-height | `min-h-[40px]` | `min-h-[40px]`（**未覆写**） | 56px（design-system.md §4） |
| max-height | 无限制 | `max-h-[120px]` | 120px（draft §1 `.composer-area`） |

**判定**：⚠偏差 — Composer.vue:19 显式设置了 `min-h-[40px]`（与原子相同），**未覆写到 56px**。W02 已发现此问题（BUI-TA-02），此处确认 Composer 未做覆写。

**设计证据**：`draft-composer-states.html §1` — `.composer-area { min-height:40px }`（draft 本身也是 40px！）

等等 —— draft CSS 也是 `min-height:40px`（不是 56px）。W02 引用的 design-system.md §4 "Composer 多行自动高，最小 56" 与 draft 实际 CSS 存在矛盾。draft 是最终设计权威，draft CSS = 40px。

**修正判定**：⚠→转述为「设计内部矛盾」——design-system.md 说 56px，draft CSS 是 40px。实现 40px 与 draft 一致。但这不是「已解决」——需确认哪个是最终值。标注为 `待澄清：design-system.md(56) vs draft CSS(40)`。

### 4.2 focus-visible ring

| 维度 | 原子 Textarea | Composer 使用 | 设计要求 |
|------|-------------|--------------|---------|
| focus ring | `focus-visible:outline-none`（无 ring） | `focus-visible:ring-0 focus-visible:ring-offset-0`（**显式禁用** ring） | focus ring 作用于 composer-box 整体（非 textarea 自身） |

**判定**：⚠偏差（可解释但需标记）。draft 设计聚焦 ring 在 **composer-box**（`.composer-box.focus { border-color:var(--border-strong); box-shadow:0 0 0 2px rgba(255,255,255,0.04) }`），非在 textarea 自身。Composer 通过 `boxClass` computed 在 composer-box 上添加 ring，同时在 textarea 上显式禁 ring 避免双重 ring——这个做法合理。

**但问题**：当 textarea 未嵌套在带 ring 的 composer-box 中时（如在其他场景使用原子 Textarea），则完全无聚焦反馈。这是原子组件层面的缺陷（W02 BUI-TA-01），Composer 场景被 composer-box ring 兜底覆盖。

### 4.3 背景色

| 维度 | 原子 Textarea | Composer 使用 | 设计要求 |
|------|-------------|--------------|---------|
| bg | `bg-transparent` | `bg-transparent`（依赖 composer-box `bg-black/20`） | `--bg-input`（draft `.composer-box { background:var(--bg-input) }`） |

**判定**：⚠偏差 + `根因关联→RC-04`。composer-box 背景为 `bg-black/20`（hardcoded 黑半透）而非 `var(--bg-input)`。`--bg-input` 在 design-tokens 中定义为 `#101013`，与 `black/20` 在 base `#0d0d0f` 上视觉效果接近但不等价。这属于 RC-04（token SSOT 缺失）的波及——若 `--bg-input` 在 CSS 变量体系中有正确定义，composer-box 应直接用 `bg-[var(--bg-input)]` 而非硬编码 `bg-black/20`。

---

## 五、跨 Zone 视觉连贯性核查

### 5.1 5 Zone 编排（Panel.vue）

Panel.vue 正确实现了 panel/spec.md 的 5 zone 自上而下布局：
1. PanelHeader → 2. MessageStream → 3. ProgressZone → 4. Composer → 5. GitZone ✅

### 5.2 Composer 与上下 Zone 的视觉关系

| 维度 | 设计要求（draft-companion-zones §composer 关系） | 实现现状 | 判定 |
|------|---------|---------|------|
| 水平边距 | 三区共享相同 `mx`（视觉等宽） | ProgressZone: `mx-3.5 mt-2.5` / Composer: `mx-3.5 pt-2.5` / GitZone: `mx-3.5 mb-3` — **共享 mx-3.5** ✅ | ✅ |
| 背景连贯 | "共享上下带，不割裂" | 三区各有独立 bg/border：ProgressZone `bg-black/20 border` / Composer `bg-black/20 border` / GitZone `bg-black/20 border` — 每个 zone 独立 card 风格 | ⚠ |
| 间距 | composer 与上下 zone 间呼吸间距 | ProgressZone `mt-2.5` → Composer `pt-2.5` → GitZone `mb-3` — composer 自身只有 `pt-2.5`（上间距），与 ProgressZone 底部无 gap，若 ProgressZone 展开则紧贴 | ⚠ |

**⚠偏差详析**：三区各自是独立 card（border + bg），视觉上是三个分离的卡片，而非"共享上下带"的连续区域。设计 spec 说 "共享上下带，不割裂"，意图是三 zone 视觉上融为一体（像同一个连续背景下的三个功能区），但当前实现是三张独立卡片。

**相邻间距矛盾**：Composer `pt-2.5`（10px 上内边距）而 ProgressZone 只有 `mt-2.5`（10px 上外边距）——如果 ProgressZone 展开，其底部到 Composer 顶部只有 10px（Composer 的 padding-top）。设计 companion-zones draft 中 ProgressZone 与 Composer 间应有更明确的呼吸间距。

---

## 六、条目详情卡（⚠/❌ 展开）

### WP-L3-15 · 输入区 + 工具区视觉一体

- **层级位置**：L3 · Panel.Composer
- **设计要求**：composer-box 单一容器，`--bg-input` 底 / `--border` / `--radius-lg`，输入区上、工具条下，无强分隔线。工具条左侧+添加、右侧上下文/模型/思考，三者无边框纯文字。
- **实现现状**：Composer.vue:16-17 — composer-box 用 `bg-black/20 rounded-lg border`；Composer.vue:22-50 — 工具条用 compose-bar 同容器内
- **判定**：⚠偏差
- **差异描述**：
  1. 背景色 `bg-black/20` 非 `var(--bg-input)`（`根因关联→RC-04`）
  2. 无强分隔线 ✅ — 同容器内排列 ✅
  3. 工具条 +添加按钮缺失（DEFERRED hide）
  4. 上下文/模型/思考为静态 `<span>` 非交互按钮（DEFERRED）
- **设计证据**：draft §1 "composer-box 单一容器（同一 `--bg-input` 底 / `--border` / `--radius-lg`）" + `.composer-box { background:var(--bg-input) }`
- **实现证据**：`Composer.vue:17` — `class="composer-box rounded-lg border bg-black/20"`
- **修复性质**：短期方案（修正背景 token）+ 长期方案（实现工具条交互）

### WP-L3-16 · 空态

- **层级位置**：L3 · Panel.Composer
- **设计要求**：placeholder "描述你想让 AI 做什么，或 @ 引用、# 文件、/ 命令…"，上下文显 "0 · 0%"（不隐藏），发送禁用退成透明文字，hint 含 kbd 引导
- **实现现状**：Composer.vue:8-10(placeholder)，22-24(上下文)，47-49(send disabled)，55-57(hint)
- **判定**：⚠偏差
- **差异描述**：placeholder 为 "描述你想让 AI 做什么…"（缺少 @/#/ 引导）——draft 明确包含 "@ 引用、# 文件、/ 命令…" 以引导用户发现高级功能
- **设计证据**：draft S1 card — `data-placeholder="描述你想让 AI 做什么，或 @ 引用、# 文件、/ 命令…"`
- **实现证据**：`Composer.vue:106-108` — `'描述你想让 AI 做什么…'`
- **修复性质**：短期方案 — 补充 @/#/ 引导文案

### WP-L3-17 · 输入中态

- **层级位置**：L3 · Panel.Composer
- **设计要求**：聚焦时中性 ring（border-strong + subtle glow），发送激活（accent 实色），容量随输入变化
- **实现现状**：Composer.vue:16-17(boxClass)，97-99(boxClass computed)，容量始终 0（mock）
- **判定**：⚠偏差
- **差异描述**：
  1. 聚焦 ring 正确 ✅（中性 border-strong + shadow）
  2. **min-height 40px**（draft CSS 也是 40px，但 design-system.md 要求 56px）— `待澄清`
  3. 上下文容量始终显示 0（mock 无数据源）
- **设计证据**：draft §1 `.composer-area { min-height:40px }` vs design-system.md §4 "最小 56"
- **实现证据**：`Composer.vue:19` — `min-h-[40px]`
- **根因关联**：`根因关联→BUI-TA-02`（W02 发现 Textarea 原子 min-height 问题）
- **修复性质**：先澄清 40 vs 56 哪个是最终值，再统一

### WP-L3-18 · @浮层（命令浮层）

- **层级位置**：L3 · Panel.Composer
- **设计要求**：敲 @/#// 触发浮层，浮在 composer 内向上开（非 Overlay 级），@→内联蓝名，#→内联绿名，/→slash-token chip。键盘导航 ↑↓/Enter/Esc
- **实现现状**：未找到（Composer.vue 注释声明 "S3（@/#// 命令浮层 G2-002）DEFERRED"）
- **判定**：❌缺失
- **差异描述**：完全未实现，无任何弹出逻辑或键盘监听。这是用户差异点②的核心缺失之一。
- **设计证据**：draft §2d S3 card — 三路命令浮层完整交互
- **实现证据**：`Composer.vue:5` — 顶部注释 "DEFERRED（按 spec §8.5 Round3 统一 hide，不留 disabled 占位）：S3（@/#// 命令浮层 G2-002）"
- **修复性质**：长期方案 — 需实现 composer 内 popover 组件 + @/#// 触发逻辑 + 候选列表

### WP-L3-19 · 附件态

- **层级位置**：L3 · Panel.Composer
- **设计要求**：拖拽/点击添加文件，附件 chip 在 composer-box 内输入区上方（同一容器），容量随附件跳涨
- **实现现状**：未找到（G2-002 DEFERRED）
- **判定**：❌缺失
- **设计证据**：draft S4 card — attach-row + attach-chip 在 composer-box 内
- **实现证据**：`Composer.vue:6` — 注释 "S4（附件 G2-002）DEFERRED"
- **修复性质**：长期方案 — 需实现文件拖拽/选择 + chip 渲染 + 容量联动

### WP-L3-20 · 发送中 / 停止态

- **层级位置**：L3 · Panel.Composer
- **设计要求**：
  - S5 发送中：整体 opacity 0.55，输入禁用+保留文字，发送位→spinner
  - S6 停止：发送位→stop 按钮（hover danger），输入可用，聚焦 ring 染 accent 蓝+呼吸（steer 信号），placeholder 切换为快捷键提示
- **实现现状**：Composer.vue:95-135(onSend/onAbort/onKeydown)，30-52(send/stop/spinner 三态)
- **判定**：⚠偏差
- **差异描述**：
  1. S5 发送中：实现清空输入（`draft.value = ''`），设计保留文字 "正在发送 · 重构 AuthService.login…"
  2. S6 停止：聚焦 ring 保持**中性**（非 accent 蓝，注释声明 "S6 不用 accent 呼吸 ring（steer G-019 DEFERRED）"）
  3. S6 placeholder："AI 正在工作中，按「停止」中断…" 而非设计的 "想补充什么？⏎ 加入当前任务 · Alt+⏎ 排到下一轮…"
  4. S6 hint：缺失 steer/followup 操作引导
  5. S6 键盘：Enter 被阻止（第 144 行 `if (!isStreaming.value) onSend()`），输入区可用但 Enter 无效 — "死胡同 UI"
  6. 错误处理：`onSend` catch 恢复 draft 但**无视觉错误反馈**（无 S9 error 条）
- **设计证据**：draft S5 card — textarea 保留文字 + disabled；S6 card — `composer-box.focus.steer` accent ring + 快捷键 hint
- **实现证据**：`Composer.vue:99-100`（boxClass 中性 ring），`Composer.vue:105-108`（placeholder），`Composer.vue:144`（键盘阻止），`Composer.vue:119-125`（draft 清空）
- **修复性质**：短期方案 — S5 保留输入文字；长期方案 — 实现 G-019 steer（accent ring + steer/followup 提交 + pending 气泡）

### WP-L3-21/22 · Steer/Followup Pending 态

- **层级位置**：L3 · Panel.Composer
- **设计要求**：steer = accent 蓝虚线脉冲气泡 "STEER 追加 · 当前回合后拾取"；followup = info 青虚线脉冲气泡 "FOLLOWUP 新轮 · 当前回合后开新轮"。提交仅键盘（⏎ steer / Alt+⏎ followup）。队列按 steering/followUp 双 FIFO 分组展示。
- **实现现状**：未找到（G-019 DEFERRED）
- **判定**：❌缺失（两组锚点合并记述）
- **差异描述**：这是用户差异点②的核心——steer/followup 两色区分 + 双队列分组 + pending 气泡均未实现。注释声明 "steer 提交 DEFERRED（G-019）"，但设计文档明确标注 "立刻打断暂不实现"，而 **steer/followup 提交本身不受影响可以实施**——当前实际是过度的全部推迟。
- **设计证据**：draft §4 — steer/followup 触发表 + 两色 pending 气泡 + §5 双队列视图
- **实现证据**：`Composer.vue:13-14` — 注释 "steer 提交 DEFERRED（G-019）"
- **修复性质**：长期方案 — 需后端 RPC 扩展 + 前端 steer/followup 提交 + pending 气泡 + 队列镜像

### WP-L3-23 · 工具区 5 项

- **层级位置**：L3 · Panel.Composer
- **设计要求**：见 §二逐项核查
- **实现现状**：见 §二逐项核查
- **判定**：⚠偏差
- **差异描述**：+添加缺失(❌)，上下文/模型/thinking-level 退化为静态展示 span(⚠)，发送三态正确(✅)。总计 5 项中 1 项 ✅一致，3 项 ⚠偏差，1 项 ❌缺失。
- **修复性质**：长期方案 — 需实现 popover 组件族 + 数据源接入

---

## 七、Composer 9 态整体覆盖率

```
设计 9 态：
S1 空 ──── ✅ 基本一致（placeholder 略短）
S2 输入中 ─ ✅ 中性 ring + 发送激活（min-height 待澄清）
S3 @浮层 ── ❌ 未实现（G2-002 DEFERRED）
S4 附件 ─── ❌ 未实现（G2-002 DEFERRED）
S5 发送中 ─ ⚠ 清空输入 vs 保留文字
S6 停止 ─── ⚠ 中性 ring(非accent) + 死胡同键盘 + 无steer/followup引导
S7 pending ─ ❌ 未实现（G-019 DEFERRED）
S8 双队列 ── ❌ 未实现（G-019 DEFERRED）
S9 失败 ──── ❌ 未实现（无视觉反馈）

覆盖率：3/9 有可工作的实现，6/9 缺失或有实质偏差
```

---

## 八、Wave 小结

### 审查条目

- 审查条目数：9（✅ 0 / ⚠ 5 / ❌ 4 / 🆕 0）
- 根因关联数：3（RC-04 `--bg-input` 缺失波及 composer 背景；BUI-TA-02 min-height 波及输入区；BUI-TA-01 focus-ring 由 composer-box ring 部分兜底）
- 新独立问题数：6（placeholder 文案/发送清空/S6 死胡同键盘/S6 hint 缺失/三 zone card 割裂/工具区退化为静态 span）
- 用户差异点②的覆盖结论：**核心功能大面积缺失**。工具区 5 项中仅发送按钮正确（1/5）；@浮层/附件/steer/followup 全部 DEFERRED；S6 行为的根本矛盾（输入可用但 Enter 无效）是交互死胡同。这是目前所有审查 wave 中偏差最大的区域。

### 优先级建议

1. **P0 · 阻断**：S6 "死胡同 UI" — 用户可打字但 Enter 无效，placeholder 引导「按停止中断」而非「输入补充指令」，需求完全反向
2. **P1 · 高**：Toolbar 交互 — 模型切换/thinking-level/上下文 popover 全部缺失，当前为"看起来有但点了没用"的欺骗性 UI
3. **P1 · 高**：@/#// 命令浮层（G2-002）— "composer 区域完全不一样"的用户核心抱怨
4. **P2 · 中**：Steer/followup（G-019）— 设计已详细推演（双色+双队列），被过度推迟（设计明确说 steer 提交本身不受 abort 问题影响）
5. **P2 · 中**：S5 文字保留 + S9 error 反馈 — 发送体验微伤
6. **P3 · 低**：跨 zone 视觉连贯性（三 card 割裂）— 骨架阶段可接受

### 跨 Wave 依赖提示

- W02 BUI-TA-02（min-height 40 vs 56）需先澄清 design-system.md 与 draft CSS 的矛盾
- RC-04（`--bg-input` token）修复后 Composer 背景可从 `bg-black/20` 迁移到 `bg-[var(--bg-input)]`
- W09（Panel 5 zone 编排）已确认编排正确，Composer 位于 zone ④，视觉连贯性问题在于三 zone 各自独立 card 风格
- W05/W06（message-stream 回合折叠）与 Composer S6 steer 有联动——steer 提交后的 pending 气泡需与 message-stream 的 steer/followup 块类型对齐
