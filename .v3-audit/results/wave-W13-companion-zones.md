# Wave W13 · Companion Zones 审查报告（A-WP-Z）

> 审查日期：2026-06-21
> 审查员：W13 (A-WP-Z) 执行员
> 范围：Panel zone ③ progress-zone + zone ⑤ git-zone
> 设计 SSOT：`panel/draft-companion-zones.html` + `workspace/spec.md §进度区` + `flow-3-subagent/spec.md`

---

## 一、Wave 汇总表

| ID | 层 | 区域.模块 | 组件/锚点 | 判定 | 设计来源 | 实现位置 | 根因标签 |
|----|----|----------|----------|------|---------|---------|---------|
| WP-L3-24 | L3 | Panel.ProgressZone | progress-zone 4 态（设计实际 3 态） | ❌缺失 | draft-companion-zones.html §1 | ProgressZone.vue: 骨架占位 | 孤立（FG4→FG5 未实现） |
| WP-L3-25 | L3 | Panel.ProgressZone | progress-zone 展开/收起（chevron 切换） | ⚠偏差 | workspace/spec.md §进度区 + draft §完成态自动收起 | ProgressZone.vue:16-20 | 孤立（手动折叠 + 方向疑反） |
| WP-L3-26 | L3 | Panel.ProgressZone | progress-zone 空态（无进度时隐藏） | ⚠偏差 | draft-companion-zones.html `.progress-zone.empty{display:none}` | ProgressZone.vue:8 `v-if="sessionLabel"` | 孤立（sessionLabel ≠ 无任务判断） |
| WP-L3-27 | L3 | Panel.GitZone | git-zone 4 态：干净/已暂存/有diff/冲突 | ❌缺失 | draft-companion-zones.html §2 | GitZone.vue: 仅干净态 | 孤立（FG4→FG5 未实现） |
| WP-L3-28 | L3 | Panel.GitZone | git-zone 常量 38px 单行 | ⚠偏差 | workspace/spec.md §git-zone | GitZone.vue:12 `h-[38px]` | 孤立（缺少 stats / 分支名截断） |
| WP-L3-29 | L3 | Panel.Composer+Progress+Git | 与 composer 视觉连贯（共享上下带） | ⚠偏差 | draft-companion-zones.html §裁决·统一带独立卡 | 三文件分别 `bg-black/20` / `rounded-md` 不同 / 间距不统一 | 疑似根因→token SSOT 缺失（RC-04: 无 `--bg-input` 接入） |
| WP-L3-30 | L3 | Panel.ProgressZone | Flow 3：progress-zone 多进度聚合升级 | ❌缺失 | flow-3-subagent/spec.md §S2 | ProgressZone.vue: 单进度条 `w-0` 占位 | 孤立（Flow 3 DEFERRED，v1 不做） |
| WP-L3-31 | L3 | Panel.GitZone | git Diff 入口 → Side Drawer | ⚠偏差 | draft-companion-zones.html §干净态 Diff disabled | GitZone.vue:23 `emit('diff')` | 孤立（G-023 Side Drawer DEFERRED；干净态未 disabled） |

**汇总**：8 条目 · ✅ 0 / ⚠ 5 / ❌ 3 / 🆕 0

---

## 二、★两 zone 与 composer 视觉一体核查专节

### 设计要求（draft-companion-zones.html §裁决·统一带独立卡）

> 三 zone 共享卡片语言（同 `bg-input` / `border` / `radius-lg` / 左右边距），垂直 6px 紧凑成「带」；但各自独立成卡——因 composer 有独立 focus ring、progress/git 有独立状态变化，合并容器会让 focus 与状态语义打架。

**关键设计属性**：

| 属性 | 设计值 | 实现现状 | 偏差 |
|------|--------|---------|------|
| **背景色** | `var(--bg-input)` (`#101013`) | 三者统一 `bg-black/20` (`rgba(0,0,0,0.2)` ≈ `#000` with 20% alpha) | ⚠ 不同。`bg-black/20` 效果接近 `#000` 过黑，`bg-input` 是明确 token。无 `--bg-input` 在 render 中定义。 |
| **边框** | `border: 1px solid var(--border)` | 三者均 `border border-border` | ✅ 一致 |
| **圆角** | `radius-lg` (12px) | ProgressZone: `rounded-lg`(12px) ✅ / Composer: `rounded-lg`(12px) ✅ / GitZone: `rounded-md`(8px) ⚠ | GitZone 用 `rounded-md` 而非 `rounded-lg`，与另两 zone 不一致 |
| **左右边距** | 统一 | 三者均 `mx-3.5` (14px) | ✅ 一致 |
| **垂直间距** | 6px (`gap: 6px`) | ProgressZone `mt-2.5`(10px) / Composer `pt-2.5`(10px) / GitZone `mb-3`(12px) — 无统一 gap 容器 | ⚠ 非 6px，无明确 gap 设置（三 zone 各自设上下 margin） |

### 核查结论

三 zone **左右边距一致**、**边框一致**，满足"同一视觉带"的基本要求。但三个偏差需修正：

1. **背景色**：`bg-black/20` 不是设计 token，应用 `bg-[var(--bg-input)]` 或直接定义 `--bg-input` token。此与 RC-04（`--surface-2`/`--bg-elevated` token SSOT 缺失）同源。
2. **GitZone 圆角**：`rounded-md`(8px) 与另两 zone 的 `rounded-lg`(12px) 不一致，破坏视觉统一。
3. **垂直间距**：非规范 6px，各自设独立 margin 缺少明确设计意图。

**面板内整体间距现状**：
```
ProgressZone:  mx-3.5 mt-2.5  ← 上方 10px
Composer:      mx-3.5 pt-2.5  ← 上方 10px (pt)
GitZone:       mx-3.5 mb-3    ← 下方 12px
```
ProgressZone ↔ Composer 间距由 ProgressZone 的 padding-bottom + Composer 的 pt-2.5 决定；Composer ↔ GitZone 间距由 Composer 的 padding-bottom + GitZone 的 margin-top 决定——没有显式的 6px gap 容器包裹三者。

---

## 三、Process Panel 残留核查结论

### 全局搜索

```bash
grep -rn 'Process Panel\|ProcessPanel\|process-panel\|processPanel\|进程面板' \
  src-electron/renderer/src/
# 结果：NO_MATCHES
```

**结论**：**无任何残留**。render 代码中完全不存在"Process Panel"、"进程面板"、"ProcessPanel"等旧术语和组件引用。

ProgressZone.vue 的注释已明确标注：
> `todo / goal 列表待 FG5 实现`

没有"展开 Process Panel"入口，没有到 Process Panel 的路由/emit/引用。阻塞态（如果未来有）也应走对话/澄清，不挂独立面板。

---

## 四、条目详情卡

### WP-L3-24 · progress-zone 状态机（⚠→❌）

- **层级位置**：L3 · Panel.ProgressZone
- **设计要求**：3 态（draft-companion-zones.html 明确：待办/进行/完成，**无阻塞态**）。纯只读、不可点击。完成态自动收起为单行横幅。plan-A 写"4 态"有误——设计裁决已收口为 3 态。
- **实现现状**：FG4 骨架——只立容器结构（可折叠卡片）+"进度区待实现"标签 + `w-0` 占位进度条 + "todo / goal 列表待 FG5 实现"文字。
- **判定**：❌缺失（0/3 态实现）
- **差异描述**：三态无一实现。整区只展示静态占位骨架，无状态圆点变化、无进度条填充、无 todo 列表渲染。
- **设计证据**：
  ```css
  .progress-zone .status-dot.running { background: var(--accent); animation: pulse-blue ...; }
  .progress-zone .status-dot.done { background: var(--success); }
  .progress-zone.collapsed .pz-body { display: none; }  /* 完成态自动收起 */
  ```
- **实现证据**：
  ```html
  <!-- ProgressZone.vue:8-10 -->
  <span class="size-[7px] rounded-full bg-subtle" />  <!-- 固定灰点，非状态驱动 -->
  <span class="font-semibold text-fg">{{ sessionLabel }}</span>
  <span class="font-mono text-[11px] text-subtle">进度区待实现</span>
  ```
- **初步根因**：孤立——FG4 骨架阶段，进度数据源（todo/goal 列表）尚未接入 runtime。非根因问题。
- **修复性质**：长期方案——接入 runtime 进度数据，实现 3 态视觉 + 状态驱动自动收起。

### WP-L3-25 · progress-zone 展开/收起（⚠偏差）

- **层级位置**：L3 · Panel.ProgressZone
- **设计要求**：展开/收起靠右上 chevron（展开时箭头向下，收起时向上）。**完成态自动收起**（状态驱动，非用户点击）。
- **实现现状**：有 ChevronDown 按钮，`collapsed` ref 控制。默认收起（`collapsed = ref(true)`）。chevron 方向：collapsed 时 rotate-180（箭头向上），展开时箭头向下。
- **判定**：⚠偏差
- **差异描述**：
  1. **chevron 方向**：collapsed（内容隐藏）→ rotate-180 → 箭头向上 "^"（点击展开）；展开时 → 箭头向下 "v"（点击收起）。此为可折叠区标准惯例，**方向正确** ✅。
  2. **完成态自动收起未实现**：当前只有手动点击折叠。设计明确要求"完成态自动收起为单行横幅，非用户点击"（`.progress-zone.collapsed .pz-body { display: none; }`）。
- **设计证据**：
  > 完成态自动收起（状态驱动，非用户点击）：body 隐藏，inline 单行条显示
  ```css
  .progress-zone.collapsed .pz-body { display: none; }
  .progress-zone.collapsed .pz-inline { display: flex; }
  ```
- **实现证据**：
  ```ts
  // ProgressZone.vue:24 — 纯手动折叠
  const collapsed = ref(true)
  // 无状态驱动的自动收起逻辑
  ```
- **初步根因**：孤立——FG4 骨架阶段，状态机未实现，chevron 仅做手动 toggle。
- **修复性质**：长期方案——实现状态机后，done 态自动设 collapsed=true。

### WP-L3-26 · progress-zone 空态（⚠偏差）

- **层级位置**：L3 · Panel.ProgressZone
- **设计要求**：无任务时整区隐藏（`.progress-zone.empty { display: none; }`）。空态判断依据 = 无 todo/goal 任务，而非无 session。
- **实现现状**：`v-if="sessionLabel"` — 有 session 标签就显示骨架。无 session 时隐藏。但即使有 session 标签，如果该 session 无 agent 任务（无 todo），也应隐藏进度区。当前骨架**强制显示**（只要 sessionLabel 存在），因为骨架阶段无真实任务数据。
- **判定**：⚠偏差
- **差异描述**：隐藏条件错误——用 `sessionLabel` 代替 `has progress tasks`。导致无任务的 session 也显示空进度区骨架。
- **设计证据**：
  ```css
  .progress-zone.empty { display: none; }  /* 无任务时整区隐藏 */
  ```
- **实现证据**：
  ```html
  <!-- ProgressZone.vue:8 -->
  <div v-if="sessionLabel" class="...bg-black/20">
  ```
- **初步根因**：孤立——骨架阶段无任务数据，用 sessionLabel 做 proxy 判断。
- **修复性质**：长期方案——接入进度数据后改为 `v-if="hasTasks"`，空任务时不渲染。

### WP-L3-27 · git-zone 4 态（❌缺失）

- **层级位置**：L3 · Panel.GitZone
- **设计要求**：干净 / 已暂存 / 有 diff / 冲突，4 态视觉各不同：
  - **干净**：绿 pill "工作区干净" + Diff 按钮 **disabled**
  - **已暂存**：绿 staged pill（含文件数）+ "取消暂存" + "提交" primary + Diff
  - **有 diff**：裸 stats（+N −M · K 文件）+ "暂存" + "提交" primary + Diff
  - **冲突**：左 3px danger 竖条 + danger soft 渐隐底 + 红 conflict pill + "解决冲突" danger
- **实现现状**：只实现干净态骨架——"工作区干净"文字（非 pill） + Diff 按钮（未 disabled）。
- **判定**：❌缺失（3/4 态完全未实现，干净态细节有偏差）
- **差异描述**：
  1. "工作区干净"是纯文字，非设计中的绿色 pill + check 图标
  2. Diff 按钮未 disabled（设计干净态应禁用）
  3. 无已暂存/有 diff/冲突三态
- **设计证据**（干净态）：
  ```html
  <span class="gz-pill clean"><svg>check</svg>工作区干净</span>
  <button class="gz-btn" disabled>Diff</button>
  ```
- **实现证据**：
  ```html
  <!-- GitZone.vue:20 -->
  <span class="font-mono text-[11px] text-subtle">工作区干净</span>  <!-- 纯文字，非 pill -->
  <!-- GitZone.vue:21-23 — Diff 按钮未 disabled -->
  <Button variant="ghost" size="sm" ... @click="emit('diff')">Diff</Button>
  ```
- **初步根因**：孤立——FG4 骨架阶段，git 操作需联调 Side Drawer（G-023 DEFERRED）+ 后端 git status 数据源未接入。
- **修复性质**：长期方案——接入 git status → 4 态状态机 → 按钮接线。

### WP-L3-28 · git-zone 38px 单行（⚠偏差）

- **层级位置**：L3 · Panel.GitZone
- **设计要求**：固定高度 38px，不随内容撑高。内容：分支名（超长省略号）+ `+N −M · K 文件` + 操作按钮。
- **实现现状**：高度 `h-[38px]` 正确。但内容仅分支名 + "工作区干净"，**缺少 `+N −M · K 文件` 统计数据**。分支名无 `truncate` 省略号保护（超长会溢出或被 flex-shrink 压缩，但父容器 `flex items-center` 会导致溢出）。
- **判定**：⚠偏差
- **差异描述**：
  1. 高度 38px ✅ — 与 PanelHeader 38px 同高，视觉对齐良好
  2. 缺少变更统计：`+N −M · K 文件` 未渲染（因为只实现了干净态）
  3. 分支名无 `truncate`：`{{ gitBranch }}` 直接输出，无省略号。需加 `truncate` 或 `max-w-[Xpx] truncate`
- **设计证据**：
  ```html
  <span class="gz-stats">
    <span class="add">+67</span><span class="del">−8</span>
    <span class="files">· 3 文件</span>
  </span>
  ```
- **实现证据**：
  ```html
  <!-- GitZone.vue:14-17 -->
  <span class="inline-flex items-center gap-1.5 font-mono text-[11px] text-accent">
    <GitBranch class="size-[13px]" />
    {{ gitBranch }}  <!-- 无 truncate -->
  </span>
  ```
- **初步根因**：孤立——FG4 骨架阶段，git stats 数据源未接入。truncate 属防御性缺失。
- **修复性质**：短期方案——加 `truncate max-w-[120px]`；长期方案——接入 stats 数据后完整渲染。

### WP-L3-29 · visual coherence with composer（⚠偏差）

已在 §二 专节详述。总结：

| 偏差点 | 设计 | 实现 | 严重度 |
|--------|------|------|--------|
| 背景色 | `bg-input` (#101013) | `bg-black/20` | 中（token 缺失 RC-04） |
| GitZone 圆角 | `rounded-lg` (12px) | `rounded-md` (8px) | 低（视觉不一致） |
| 垂直间距 | 统一 gap:6px | 各自 margin/padding | 低（布局不精确） |
| 左右边距 | 统一 | 统一 mx-3.5 | ✅ |

### WP-L3-30 · Flow 3 多进度聚合（❌缺失）

- **层级位置**：L3 · Panel.ProgressZone
- **设计要求**（flow-3-subagent/spec.md §S2）：单 session 进度 → 多进度聚合（每子 agent 一条进度条 + 整体进度）。子 agent 状态：dispatched→running→done/stopped/failed/timeout/superseded。
- **实现现状**：单进度条 `w-0` 占位，无任何子 agent 相关概念。
- **判定**：❌缺失（但非缺陷——Flow 3 整体 DEFERRED）
- **差异描述**：完全未实现多进度聚合。当前骨架仅为未来单进度做占位。
- **设计证据**：
  > progress-zone 升级：从单 session 进度 → 多进度聚合（每子 agent 一条进度 + 整体进度）
- **初步根因**：孤立——Flow 3 subagent 编排是产品护城河，整体推迟。progress-zone 当前为 v1 单进度占位。
- **修复性质**：长期方案——Flow 3 阶段统一升级。v1 不做是正确决策。

### WP-L3-31 · git Diff 入口 → Side Drawer（⚠偏差）

- **层级位置**：L3 · Panel.GitZone
- **设计要求**：Diff 按钮 → 打开 Side Drawer（Detail Pane）。干净态 Diff button **disabled**（无可 diff 内容）。
- **实现现状**：Diff 按钮存在，点击 `emit('diff')`。按钮未 disabled。Panel.vue 监听 `@diff` 并 emit 到上层。Side Drawer 为 G-023 DEFERRED（W09 确认空 stub）。
- **判定**：⚠偏差
- **差异描述**：
  1. 干净态 Diff 按钮应 disabled，当前始终可点击
  2. emit 事件链有但终点缺失（Side Drawer 未实现）
  3. 按钮正确 emit `diff` 事件，Panel.vue → 上层链路完整
- **设计证据**：
  ```html
  <!-- 干净态 -->
  <button class="gz-btn" disabled>Diff</button>
  ```
- **实现证据**：
  ```html
  <!-- GitZone.vue:21 -->
  <Button variant="ghost" size="sm" ... @click="emit('diff')">Diff</Button>
  <!-- 无 disabled 属性 -->
  ```
- **初步根因**：孤立——G-023 DEFERRED + FG4 骨架只有干净态，disabled 逻辑未加。
- **修复性质**：短期方案——加 `:disabled="!hasDiff"` prop；长期方案——等 Side Drawer 实现后完整接线。

---

## 五、Wave 小结

### 审查统计

- 条目数：8（✅ 0 / ⚠ 5 / ❌ 3）
- 缺失 3 条均为 **FG4→FG5 骨架未完工**导致的整态缺失（进度 3 态、git 3 态、Flow 3 多进度），非架构偏差
- 偏差 5 条中 2 条为视觉细节（token/间距/圆角），2 条为防御性缺失（truncate/disabled），1 条为空态判断条件错误

### 根因关联标注

| 关联 | 条目 | 说明 |
|------|------|------|
| **RC-04** (`--surface-2`/`--bg-elevated` token SSOT) | WP-L3-29 | 三 zone 用 `bg-black/20` 而非 `bg-input` token。`--bg-input` 在 render 中 **未定义**，与 RC-04 同源——所有 surface/elevated/input 层背景 token 缺失或不被引用 |
| **RC-08** (Button Ghost hover 变蓝) | — | ProgressZone chevron 和 GitZone Diff 用 `variant="ghost"`，但均用 `cn()` + `twMerge` 正确**覆盖**了 hover 样式（`hover:bg-surface-hover`），实际**不受 RC-08 影响** |
| **W09** (Panel 5 zone 顺序) | WP-L3-28/29 | Panel.vue 中 5 zone 顺序正确：header→message-stream→progress-zone→composer→git-zone，与 W09 确认一致。三 zone 在 composer 上下的位置编排正确 |
| **W09** (Side Drawer G-023 DEFERRED) | WP-L3-31 | Diff emit 存在但目标缺失，与 W09 结论一致 |
| **W10** (PanelHeader 38px) | WP-L3-28 | GitZone 38px 与 PanelHeader 38px 同高，视觉对齐 ✅ |

### 疑似新根因候选

1. **`--bg-input` token 未在 render 中定义/使用**（与 RC-04 可能同源或子问题）：在 render 全量搜索中未找到 `bg-input` 引用。三 zone 统一用 `bg-black/20` 作为 input 背景色的临时替代。若 RC-04 修复后 token 体系完善，此处应同步更新。

### 跨 wave 依赖提示

- **A-WP-W6 (Side Drawer/Detail Pane)**：GitZone 的 Diff 按钮 emit → Side Drawer 接线依赖 W6 审查。
- **A-WP-W4 (Composer)**：三 zone 视觉一体性依赖 W4 审查的 Composer 样式是否与设计一致。
- **Flow 3 subagent**：progress-zone 多进度聚合需 Flow 3 整体方案落地后同步升级。

### 命门核查总结

| 命门 | 结论 |
|------|------|
| 两 zone 与 composer 视觉一体 | ⚠ 框架正确（同 mx/同边框），细节偏差（背景 token/圆角/间距不一致） |
| git-zone 38px 常量高度 | ✅ 实现正确 |
| 干净工作区空态 | ⚠ 显示"工作区干净"但格式非 pill、Diff 按钮未 disabled |
| progress-zone 多进度 | ❌ v1 不做是正确决策（Flow 3 DEFERRED），当前骨架合理 |
| Process Panel v1 已删除 | ✅ 无任何残留 |
| git-zone 操作按钮 | ⚠ 只实现 Diff（未接线），暂存/提交/取消暂存未实现 |
| git-zone 38px 与 PanelHeader 关系 | ✅ 同高 38px，良好对齐 |
| progress-zone 4 态完整性 | ❌ 0/4 实现，FG4 骨架阶段。plan-A 说"4 态"有误——设计实际是 3 态 |
