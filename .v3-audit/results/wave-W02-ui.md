# Wave W02 (B-UI) · UI 原子组件层审查报告

> **审查员**: W02 (B-UI) 执行员
> **审查日期**: 2026-06-21
> **审查范围**: `components/ui/` 7 组 36 文件（button 2 + dialog 10 + dropdown-menu 15 + input 2 + scroll-area 3 + textarea 2 + tooltip 4，含 index.ts）
> **设计来源**: `docs/designs/design-system.md` + `docs/designs/design-tokens.md` + `docs/designs/v3-demo/ui-skeleton.md`
> **W01 根因输入**: RC-01/02/03/04/06/08 已纳入审查范围

---

## 一、Wave 汇总表

| ID | 组 | 锚点 | 判定 | 设计来源 | 实现位置 | 根因标签 |
|----|----|------|------|---------|---------|---------|
| BUI-BTN-01 | button | variant 枚举与 design-system 不匹配 | ⚠ | design-system.md §3 四变体 | button/index.ts:11-21 | 孤立（shadcn 模板残留） |
| BUI-BTN-02 | button | Secondary 背景色偏差 | ⚠ | design-system.md §3 Secondary="透明底+border" | button/index.ts:16 | 孤立 |
| BUI-BTN-03 | button | Ghost hover 色 | ⚠ | design-system.md §3 Ghost hover=`--surface-hover` | button/index.ts:18 | `根因关联→RC-08`（shadcn accent 语义冲突） |
| BUI-BTN-04 | button | Destructive 实色底 vs 文字色 | ⚠ | design-system.md §3 Danger="--danger 字 + hover soft 底" | button/index.ts:14 | 孤立（shadcn 模板残留） |
| BUI-BTN-05 | button | 缺 dense 32px 高度 | ⚠ | design-system.md §3 高度 32/36/44 | button/index.ts:22-27 | 孤立 |
| BUI-BTN-06 | button | default 高度 40≠36 | ⚠ | design-system.md §3 默认 36px | button/index.ts:22 | 孤立 |
| BUI-BTN-07 | button | `outline` + `link` 变体无设计对应 | 🆕 | design-system.md §3 无此二变体 | button/index.ts:15,19 | 孤立（shadcn 全量 copy） |
| BUI-DLG-01 | dialog | backdrop 缺模糊（blur） | ❌ | settings/spec.md + overlays/spec.md backdrop blur | DialogContent.vue:27 | 孤立 |
| BUI-DLG-02 | dialog | 弹层 bg 用 `--bg` 非 `--surface` | ⚠ | design-system.md §2 Card-Elevated 浮层用 surface | DialogContent.vue:32 | 孤立 |
| BUI-DLG-03 | dialog | close button open 态 accent 蓝底 | ⚠ | design-system.md §3 Ghost hover=`--surface-hover` | DialogContent.vue:39 | `根因关联→RC-08` |
| BUI-DLG-04 | dialog | DialogClose 无业务引用 | 🆕 | — | DialogClose.vue | 孤立 |
| BUI-DLG-05 | dialog | DialogFooter 无业务引用 | 🆕 | — | DialogFooter.vue | 孤立 |
| BUI-DLG-06 | dialog | DialogTrigger 无业务引用 | 🆕 | — | DialogTrigger.vue | 孤立 |
| BUI-DLG-07 | dialog | DialogScrollContent 无业务引用且样式不一致 | 🆕 | — | DialogScrollContent.vue | 孤立 |
| BUI-DM-01 | dropdown-menu | **全部 15 文件零业务引用** | 🆕 | — | dropdown-menu/ 全目录 | `根因关联→RC-03` |
| BUI-IP-01 | input | bg 非 `--surface-2` | ❌ | design-system.md §4 背景=`--surface-2` | Input.vue:23 | `根因关联→RC-04` |
| BUI-IP-02 | input | focus ring 外环非 inset | ⚠ | design-system.md §4 "1px ring（inset）" | Input.vue:23 | 孤立 |
| BUI-IP-03 | input | 缺 error 态样式 | ❌ | design-system.md §4 "--danger 边框 + 下方错误文案" | Input.vue（无对应代码） | 孤立 |
| BUI-SA-01 | scroll-area | thumb 色过淡（border=rgba 6%） | ⚠ | —（无 ScrollArea 原语 spec） | ScrollBar.vue:26 | 孤立 |
| BUI-TA-01 | textarea | **缺 focus-visible ring** | ❌ | design-system.md §4 聚焦 `--accent` ring | Textarea.vue:32 | 孤立 |
| BUI-TA-02 | textarea | min-height 40≠56 | ⚠ | design-system.md §4 Composer min 56 | Textarea.vue:32 | 孤立 |
| BUI-TA-03 | textarea | bg 透明非 `--surface-2` | ⚠ | design-system.md §4 背景=`--surface-2` | Textarea.vue:32 | `根因关联→RC-04` |
| BUI-TP-01 | tooltip | **全部 4 文件零业务引用** | 🆕 | — | tooltip/ 全目录 | 孤立 |

**判定分布**: ✅ 0 / ⚠ 12 / ❌ 4 / 🆕 8（含 dropdown-menu 14 件合一）

---

## 二、条目详情卡

### BUI-BTN-01 · Button variant 枚举与 design-system 不匹配

- **层级位置**: UI 原子 · button 组
- **设计要求**: design-system.md §3 定义 4 变体：Primary（accent 实色底白字）/ Secondary（透明底+border+fg）/ Ghost（透明底+hover surface-hover）/ Danger（danger 字+hover soft 底）。无 outline/link 变体。
- **实现现状**: button/index.ts:11-21 定义 6 变体：default / destructive / outline / secondary / ghost / link。多了 `outline`、`link`。
- **判定**: ⚠（多 2 变体 + 既有变体语义偏离，见 BUI-BTN-02/03/04）
- **差异描述**: shadcn-vue 全量模板未经 v3 语义裁剪。`outline` 虽是合理补充（border 按钮），但不在 design-system 原语中；`link` 是纯文本按钮，无设计稿对应。
- **设计证据**: design-system.md §3 表格，四行四变体，无 outline/link。
- **实现证据**: `button/index.ts:11-21`，variant 枚举含 `outline: "border border-input bg-background..."` 和 `link: "text-primary underline-offset-4..."`。
- **初步根因**: 孤立 — shadcn 全量 copy 未按 v3 设计裁剪。
- **修复性质**: 长期方案 · 治本 — 保留 `outline`（补充 devtools 常见模式）并补入 design-system.md，`link` 若无使用场景则删除。

---

### BUI-BTN-02 · Secondary 背景色偏差

- **层级位置**: UI 原子 · button/index.ts
- **设计要求**: design-system.md §3 Secondary = "透明底 + `--border` + `--fg`"
- **实现现状**: button/index.ts:16 — `bg-secondary text-secondary-foreground hover:bg-secondary/80`。`--secondary` 映射到 `--surface`（#151519 面板色，非透明），无 border。
- **判定**: ⚠
- **差异描述**: 设计要透明底+边框，实现是实色面板底+无边框。视觉上 secondary button 会呈现为面板色方块，而非线框按钮。
- **设计证据**: design-system.md §3 "透明底 + `--border` + `--fg`"
- **实现证据**: `button/index.ts:16` — `bg-secondary`（=`var(--surface)`=#151519），无 border class。
- **初步根因**: 孤立 — shadcn `secondary` 语义（实色面板底）与 v3 设计（透明线框）冲突。
- **修复性质**: 长期方案 · 治本 — 改为 `bg-transparent border border-border text-fg hover:bg-surface-hover`。

---

### BUI-BTN-03 · Ghost hover 色

- **层级位置**: UI 原子 · button/index.ts
- **设计要求**: design-system.md §3 Ghost = "透明，hover 出 `--surface-hover`"
- **实现现状**: button/index.ts:18 — `hover:bg-accent hover:text-accent-foreground`。hover 变为 accent 蓝底白字。
- **判定**: ⚠
- **差异描述**: 设计 hover 浅灰面板色（#1b1b20），实际 hover 为主色蓝（#4f8ef7）。幽灵按钮 hover 时变成实心蓝按钮，视觉过于强烈。
- **设计证据**: design-system.md §3 Ghost "hover 出 `--surface-hover`"
- **实现证据**: `button/index.ts:18` — `hover:bg-accent`（#4f8ef7），非 `--surface-hover`。
- **初步根因**: `根因关联→RC-08` — shadcn `--accent`（hover 软底）与 v3 `--accent`（主色蓝）语义冲突。design-tokens.md 已记录此副作用为"可接受"。
- **修复性质**: 长期方案 · 治本 — 改 Ghost 为 `hover:bg-surface-hover`，需确认是否影响业务代码中 Ghost button 的视觉预期。

---

### BUI-BTN-04 · Destructive 实色底 vs 文字色

- **层级位置**: UI 原子 · button/index.ts
- **设计要求**: design-system.md §3 Danger = "`--danger` 字 + hover soft 底"
- **实现现状**: button/index.ts:14 — `bg-destructive text-destructive-foreground hover:bg-destructive/90`（实色红底白字）
- **判定**: ⚠
- **差异描述**: 设计要红字+透明底+hover 淡红底（ghost-danger 模式），实现是实色红底白字。视觉上 delete/terminate 按钮过于强烈，可能造成误触恐惧。
- **设计证据**: design-system.md §3 Danger "`--danger` 字 + hover soft 底"
- **实现证据**: `button/index.ts:14` — `bg-destructive`（=`var(--danger)`=#ef4444 实底）
- **初步根因**: 孤立 — shadcn destructive 是实色底模式，v3 是文字色模式。
- **修复性质**: 长期方案 · 治本 — 改为 `text-danger hover:bg-[rgba(239,68,68,0.12)]`，与现有 Composer stop button 风格一致。

---

### BUI-BTN-05/06 · 高度尺寸偏差

- **层级位置**: UI 原子 · button/index.ts
- **设计要求**: design-system.md §3 高度 32（dense）/ 36（默认）/ 44（移动命中区）
- **实现现状**: button/index.ts:22-27 — default h-10(40px) / sm h-9(36px) / lg h-11(44px) / icon(40px) / icon-sm(36px) / icon-lg(44px)
- **判定**: ⚠（合并 BUI-BTN-05 缺 dense + BUI-BTN-06 default 高度偏差）
- **差异描述**: 缺 dense 32px 高度；default=40px ≠ 设计默认 36px（设计 36 对应实现 sm）。
- **设计证据**: design-system.md §3 "高度 32（dense）/ 36（默认）/ 44（移动命中区）"
- **实现证据**: `button/index.ts:22-27`，size 枚举无 32px 档位。
- **初步根因**: 孤立 — shadcn 默认高度体系（40/36/44）与 v3（32/36/44）不同。
- **修复性质**: 长期方案 · 治本 — 增加 `dense: 'h-8'`（32px），default 改为 h-9（36px）。

---

### BUI-BTN-07 · outline + link 变体无设计对应

- **层级位置**: UI 原子 · button/index.ts
- **设计要求**: design-system.md §3 无 outline/link 变体
- **实现现状**: button/index.ts:15,19 — 存在 `outline` 和 `link` 两个额外 variant
- **判定**: 🆕
- **差异描述**: 两个 shadcn 变体在 v3 design-system 中无对应原语。`outline` 使用场景可能合理（边框按钮），但 `link` 在当前代码库无使用。
- **设计证据**: design-system.md §3 四变体表，无 outline/link。
- **实现证据**: `button/index.ts:15` outline / `:19` link。
- **初步根因**: 孤立 — shadcn 全量 copy 未裁剪。
- **修复性质**: 短期方案 · 治标 — `outline` 如有业务使用则保留并补入 design-system；`link` 如无使用则删除。

---

### BUI-DLG-01 · Dialog backdrop 缺模糊

- **层级位置**: UI 原子 · dialog/DialogContent.vue
- **设计要求**: settings/spec.md + overlays/spec.md 要求 Dialog backdrop 带 `backdrop-blur`
- **实现现状**: DialogContent.vue:27 — `class="fixed inset-0 z-50 bg-black/80 data-[state=open]:animate-in ..."`，无 `backdrop-blur`。
- **判定**: ❌
- **差异描述**: 弹层背景仅 80% 黑遮罩，无模糊效果。v3 设计稿（settings/spec.md）明确要求 backdrop blur 来实现毛玻璃分层感。
- **设计证据**: settings/spec.md §modal 形态 "backdrop blur"
- **实现证据**: `DialogContent.vue:27` — `bg-black/80` 无 `backdrop-blur` / `backdrop-blur-sm` / `backdrop-blur-md`。
- **初步根因**: 孤立 — shadcn 默认 template 不带 blur，未按 v3 设计补全。
- **修复性质**: 短期方案 · 治标 — 加 `backdrop-blur-sm` 到 DialogOverlay。

---

### BUI-DLG-02 · Dialog 弹层 bg 用 `--bg` 非 `--surface`

- **层级位置**: UI 原子 · dialog/DialogContent.vue
- **设计要求**: design-system.md §2 Card-Elevated 浮层应使用 `--surface` 或 `--surface-2` 背景（脱离画布）
- **实现现状**: DialogContent.vue:32 — `bg-background`（=`--bg`=#0d0d0f，画布底色）
- **判定**: ⚠
- **差异描述**: Dialog 画布同色（#0d0d0f），与下方 workspace 无分层感，视觉上 Dialog "融进"背景而非"浮起"。应为 `bg-surface`（#151519）以形成面板浮层感。
- **设计证据**: design-system.md §2 Card-Elevated "浮起（抽屉/浮层内）背景 `--surface-2`，脱离背景"
- **实现证据**: `DialogContent.vue:32` — `bg-background`
- **初步根因**: 孤立 — `--background` shadcn 别名映射到 `--bg`，shadcn Dialog 模板默认用 `bg-background`，在 v3 语境下应改为 `bg-surface`。
- **修复性质**: 短期方案 · 治标 — 改为 `bg-surface`。

---

### BUI-DLG-03 · Close button open 态 accent 蓝底

- **层级位置**: UI 原子 · dialog/DialogContent.vue
- **设计要求**: 关闭按钮应为 ghost 风格，hover/active 用 `--surface-hover`
- **实现现状**: DialogContent.vue:39 — `data-[state=open]:bg-accent data-[state=open]:text-muted-foreground`（open 态蓝色底）
- **判定**: ⚠
- **差异描述**: dialog 打开时 close button 背景变蓝色（accent），视觉突兀。应为 `hover:bg-surface-hover`。
- **设计证据**: design-system.md §3 Ghost "hover 出 `--surface-hover`"
- **实现证据**: `DialogContent.vue:39` — `data-[state=open]:bg-accent`
- **初步根因**: `根因关联→RC-08` — shadcn `data-[state=open]:bg-accent` 意图是浅灰底，但因 `--accent` v3=蓝，变成蓝底。
- **修复性质**: 短期方案 · 治标 — 改为 `data-[state=open]:bg-surface-hover data-[state=open]:text-fg`。

---

### BUI-DLG-04/05/06/07 · Dialog 未使用子组件

- **层级位置**: UI 原子 · dialog/DialogClose.vue / DialogFooter.vue / DialogTrigger.vue / DialogScrollContent.vue
- **设计要求**: 业务代码仅使用 Dialog + DialogContent + DialogHeader + DialogTitle + DialogDescription
- **实现现状**: DialogClose、DialogFooter、DialogTrigger、DialogScrollContent 在 `src/` 全目录无 import 引用
- **判定**: 🆕（4 文件）
- **差异描述**: SettingsModal 和 SearchModal 均未使用这些子组件。DialogFooter 无 footer 需求；DialogClose 关闭逻辑内嵌在 DialogContent 的 X 按钮中；DialogTrigger 无程序化触发场景；DialogScrollContent 与 DialogContent 功能重复且样式不一致（border-border vs border、overlay 内嵌 vs 独立）。
- **设计证据**: SettingsModal.vue:13-57、SearchModal.vue:13-43 组件使用情况
- **实现证据**: `grep -rn "DialogClose\|DialogFooter\|DialogTrigger\|DialogScrollContent" src/ --include="*.vue" --include="*.ts"` 无结果（排除 ui/dialog/ 自身）
- **初步根因**: 孤立 — shadcn 全量 copy，未按业务实际需求裁剪。
- **修复性质**: 短期方案 · 治标 — 删除 4 个未使用文件，index.ts 移除对应 export。如未来需要再加回。

---

### BUI-DM-01 · Dropdown-menu 全部 15 文件零业务引用

- **层级位置**: UI 原子 · dropdown-menu/ 整组（14 .vue + 1 index.ts）
- **设计要求**: design-system.md §Dropdown 引用，但无业务落地
- **实现现状**: 14 子组件 + index.ts + `DropdownMenuPortal` re-export，**零业务引用**（`grep -rn "DropdownMenu[A-Z]" src/ --exclude-dir=components/ui/dropdown-menu` 无结果；`grep -rn "from.*dropdown-menu" src/` 无结果）
- **判定**: 🆕（15 文件合一）
- **差异描述**: 全部 14 子组件（DropdownMenu / Content / Item / Trigger / Separator / Label / Shortcut / Group / Sub / SubContent / SubTrigger / CheckboxItem / RadioGroup / RadioItem）均未被任何业务代码 import。属于 shadcn 全量 copy 的完全冗余。
- **设计证据**: 无业务 spec 引用 dropdown-menu（sidebar spec 提及右键菜单但未实现）
- **实现证据**: 两次独立 grep 均零匹配。
- **初步根因**: `根因关联→RC-03` — W01 已确认此根因。
- **修复性质**: 长期方案 · 治本 — **全部删除** dropdown-menu/ 目录及其 index.ts。若未来需要 context menu，从 shadcn 按需引入 DropdownMenu + Content + Item + Trigger + Separator 即可，5 个文件够用。CheckboxItem/RadioGroup/RadioItem/Sub 系列为高级交互模式，v3 阶段不需要。

---

### BUI-IP-01 · Input bg 非 `--surface-2`

- **层级位置**: UI 原子 · input/Input.vue
- **设计要求**: design-system.md §4 "背景 `--surface-2`"
- **实现现状**: Input.vue:23 — `bg-background`（=`--bg`=#0d0d0f）
- **判定**: ❌
- **差异描述**: 设计明确要求输入框背景为 `--surface-2`（比画布略亮的面板色），但 SSOT design-tokens.md 和 style.css 均**未定义** `--surface-2`。实现退化为画布底色 `--bg`，输入框在暗色画布上无视觉边界感。
- **设计证据**: design-system.md §4 "背景 `--surface-2`"
- **实现证据**: `Input.vue:23` — `bg-background`；`grep -rn "\-\-surface-2\b" src/style.css` 无结果
- **初步根因**: `根因关联→RC-04` — W01 已确认 `--surface-2` 在 SSOT 和 style.css 均缺失。
- **修复性质**: 长期方案 · 治本 — ①在 design-tokens.md 补 `--surface-2` 色值（建议 `#1a1a20`，介于 surface #151519 和 surface-hover #1b1b20 之间）；②style.css 落地；③Input.vue 改为 `bg-surface-2`；④tailwind config 补 `surface-2` utility。

---

### BUI-IP-02 · Input focus ring 外环非 inset

- **层级位置**: UI 原子 · input/Input.vue
- **设计要求**: design-system.md §4 "聚焦 `--accent` 1px ring（inset，同 Card-Active 手法）"
- **实现现状**: Input.vue:23 — `focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2`（2px 外环 + 2px offset）
- **判定**: ⚠
- **差异描述**: 设计要 1px inset ring（不改变盒模型），实现是 2px 外环+offset（会撑开布局）。inset ring 是 v3 Card-Active 的核心手法（`inset 0 0 0 1px accent-ring`），Input 应一致。
- **设计证据**: design-system.md §4 "1px ring（inset，同 Card-Active 手法）"
- **实现证据**: `Input.vue:23` — `ring-2 ring-offset-2`（Tailwind ring 是 box-shadow 外扩，非 inset）
- **初步根因**: 孤立 — shadcn focus ring 模式（外环）与 v3 inset ring 模式不一致。
- **修复性质**: 长期方案 · 治本 — 改为 `focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-accent-ring`，移除 ring-offset。

---

### BUI-IP-03 · Input 缺 error 态样式

- **层级位置**: UI 原子 · input/Input.vue
- **设计要求**: design-system.md §4 "错误态 `--danger` 边框 + 下方错误文案"
- **实现现状**: Input.vue 无 error prop、无 error 样式、无错误文案 slot
- **判定**: ❌
- **差异描述**: 输入框缺错误态支持。design-system 明确有 error 态规范，但原子组件未提供对应 prop 和样式变体，业务侧（如 Settings 表单）无法使用。
- **设计证据**: design-system.md §4 "错误态 `--danger` 边框 + 下方错误文案"
- **实现证据**: `Input.vue:1-26` — 无 error 相关 prop、class、slot。
- **初步根因**: 孤立 — shadcn Input 模板无 error 态。
- **修复性质**: 长期方案 · 治本 — 增加 `error?: boolean` + `errorMessage?: string` props，error 时 `border-danger`。

---

### BUI-SA-01 · ScrollBar thumb 色过淡

- **层级位置**: UI 原子 · scroll-area/ScrollBar.vue
- **设计要求**: 无明确 ScrollArea 原语 spec（design-system.md 未展开 ScrollArea），但可用性要求 thumb 可见
- **实现现状**: ScrollBar.vue:26 — `bg-border`（=`rgba(255,255,255,0.06)`，6% 透明白）
- **判定**: ⚠
- **差异描述**: 滚动条 thumb 仅 6% 不透明度白色，在暗色背景上几乎不可见。对比 Sidebar.vue 中 SessionList 的 scoped scrollbar 使用自定义 thumb 色（更可见），原子组件与业务滚动条视觉不一致。
- **设计证据**: 无直接 spec，但 message-stream scoped scrollbar 可作为参考
- **实现证据**: `ScrollBar.vue:26` — `bg-border`
- **初步根因**: 孤立 — shadcn 默认 thumb 色在暗色主题下过淡。
- **修复性质**: 短期方案 · 治标 — 改为 `bg-border-strong`（rgba 12%）或在 tailwind config 中覆盖。

---

### BUI-TA-01 · Textarea 缺 focus-visible ring

- **层级位置**: UI 原子 · textarea/Textarea.vue
- **设计要求**: design-system.md §4 "聚焦 `--accent` 1px ring（inset）"
- **实现现状**: Textarea.vue:32 — class 含 `focus-visible:outline-none` 但**无任何** `focus-visible:ring-*` 类。
- **判定**: ❌
- **差异描述**: Textarea 聚焦时完全无视觉反馈（outline 被禁 + 无 ring）。键盘用户无法判断焦点位置。对比 Input.vue（至少有 ring-2），Textarea 漏掉了整个 focus ring。
- **设计证据**: design-system.md §4 "聚焦 `--accent` 1px ring"
- **实现证据**: `Textarea.vue:32` — 全 class 字符串中无 `ring` 关键词。
- **初步根因**: 孤立 — shadcn Textarea 模板不带 focus ring（依赖全局 outline），项目 `style.css` 重置了 outline，导致双重缺失。
- **修复性质**: 短期方案 · 治标 — 补 `focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-accent-ring`。

---

### BUI-TA-02 · Textarea min-height 40≠56

- **层级位置**: UI 原子 · textarea/Textarea.vue
- **设计要求**: design-system.md §4 "Composer 多行自动高，最小 56"
- **实现现状**: Textarea.vue:32 — `min-h-[40px]`
- **判定**: ⚠
- **差异描述**: Composer 使用的 Textarea min-height 为 40px，设计要求 56px。40px 约 1.5 行，56px 约 2.5 行，视觉上输入区更宽敞。
- **设计证据**: design-system.md §4 "最小 56"
- **实现证据**: `Textarea.vue:32` — `min-h-[40px]`
- **初步根因**: 孤立 — shadcn 默认 40px，未按 v3 composer 需求调整。
- **修复性质**: 短期方案 · 治标 — Textarea 原语保持 40px 通用默认值，Composer.vue 使用时通过 `class` prop 覆写 `min-h-[56px]`（当前 Composer.vue 可能已有覆写，待 W01-PN 审查确认）。

---

### BUI-TA-03 · Textarea bg 透明非 `--surface-2`

- **层级位置**: UI 原子 · textarea/Textarea.vue
- **设计要求**: design-system.md §4 "背景 `--surface-2`"
- **实现现状**: Textarea.vue:32 — `bg-transparent`
- **判定**: ⚠
- **差异描述**: Textarea 完全透明背景，在画布上无视觉容器感。设计要求 `--surface-2` 背景以形成输入区域视觉边界。
- **设计证据**: design-system.md §4 "背景 `--surface-2`"
- **实现证据**: `Textarea.vue:32` — `bg-transparent`
- **初步根因**: `根因关联→RC-04` — `--surface-2` 缺失导致无法使用。
- **修复性质**: 同 BUI-IP-01，等 RC-04 修复后改为 `bg-surface-2`。

---

### BUI-TP-01 · Tooltip 全部 4 文件零业务引用

- **层级位置**: UI 原子 · tooltip/ 整组（Tooltip.vue / TooltipContent.vue / TooltipProvider.vue / TooltipTrigger.vue + index.ts）
- **设计要求**: design-system.md §Tooltip 引用，但无业务落地
- **实现现状**: 4 子组件 + index.ts，零业务引用（`grep -rn "Tooltip\b\|TooltipProvider\|TooltipContent\|TooltipTrigger" src/ --exclude-dir=components/ui/tooltip` 无结果）
- **判定**: 🆕（4 文件合一）
- **差异描述**: Tooltip 组件体系完全未被使用。当前 UI 依赖 title 属性原生 tooltip 或无 tooltip。
- **设计证据**: 无业务 spec 引用 tooltip 组件
- **实现证据**: grep 零匹配
- **初步根因**: 孤立 — shadcn 全量 copy，未按实际需求裁剪。Tooltip 是低频需求（按钮/图标 hover 解释），v3 阶段可暂缓。
- **修复性质**: 短期方案 · 治标 — 删除 tooltip/ 目录。若未来需要，从 shadcn 按需引入。

---

## 三、RC-03 dropdown-menu 多余清单

> 逐个文件标注保留/🆕多余 + 理由。依据：`grep -rn "DropdownMenu[A-Z]" src/ --exclude-dir=components/ui/dropdown-menu` 零匹配。

| 文件 | 判定 | 理由 |
|------|------|------|
| `DropdownMenu.vue` | 🆕多余 | 根容器，无业务引用 |
| `DropdownMenuTrigger.vue` | 🆕多余 | 触发器，无业务引用 |
| `DropdownMenuContent.vue` | 🆕多余 | 内容容器，无业务引用 |
| `DropdownMenuItem.vue` | 🆕多余 | 菜单项，无业务引用 |
| `DropdownMenuSeparator.vue` | 🆕多余 | 分隔线（唯一含 `bg-muted` 用法），无业务引用 |
| `DropdownMenuLabel.vue` | 🆕多余 | 分组标签，无业务引用 |
| `DropdownMenuShortcut.vue` | 🆕多余 | 快捷键提示，无业务引用 |
| `DropdownMenuGroup.vue` | 🆕多余 | 分组容器，无业务引用 |
| `DropdownMenuSub.vue` | 🆕多余 | 子菜单根，无业务引用 |
| `DropdownMenuSubTrigger.vue` | 🆕多余 | 子菜单触发器，无业务引用 |
| `DropdownMenuSubContent.vue` | 🆕多余 | 子菜单内容，无业务引用 |
| `DropdownMenuCheckboxItem.vue` | 🆕多余 | 复选项，无业务引用 |
| `DropdownMenuRadioGroup.vue` | 🆕多余 | 单选组，无业务引用 |
| `DropdownMenuRadioItem.vue` | 🆕多余 | 单选项，无业务引用 |
| `index.ts` | 🆕多余 | 桶文件 + DropdownMenuPortal re-export，无引用 |

**结论**: 15 文件全部 🆕多余。`根因关联→RC-03`。W01 已确认此根因，不重复记录为独立问题。建议全部删除；若未来需要 context menu，仅需 5 文件（Menu + Content + Item + Trigger + Separator）。

---

## 四、RC-08 核实结论

### 核查方法

扫描 7 组 36 文件中所有 `bg-muted` / `text-muted` / `text-muted-foreground` / `bg-secondary` / `text-secondary` / `text-secondary-foreground` 用法，对照 v3 token 语义（`--muted` = 次级文字色 #8a8a95，`--secondary` 映射到 `--surface` #151519）判定视觉正确性。

### 原子组件层用法清单

| 文件:行号 | class | v3 解析 | 语义是否正确 |
|-----------|-------|---------|------------|
| `DropdownMenuSeparator.vue:18` | `bg-muted` | `--muted`=#8a8a95 灰色背景（用于 1px 分隔线） | ✅ 视觉正确（灰色线在深色背景上可见） |
| `DialogContent.vue:39` | `text-muted-foreground` | `--muted-foreground`→`--muted`=#8a8a95 文字色 | ✅ 正确（关闭按钮文字次级色） |
| `DialogDescription.vue:18` | `text-muted-foreground` | 同上 | ✅ 正确（描述文字次级色） |
| `Input.vue:23` | `placeholder:text-muted-foreground` | 同上 | ✅ 正确（placeholder 文字色） |
| `Textarea.vue:32` | `placeholder:text-muted-foreground` | 同上 | ✅ 正确（placeholder 文字色） |
| `button/index.ts:16` | `bg-secondary text-secondary-foreground` | `--secondary`→`--surface`=#151519 面板底 + fg 文字 | ✅ 正确（secondary button 面板色底） |
| `DialogScrollContent.vue:47` | `hover:bg-secondary` | `--secondary`→`--surface` 面板色 hover 底 | ✅ 正确（关闭按钮 hover 面板色） |

### 结论

**RC-08 在原子组件层不成立（无表现）**。

- `bg-muted` 仅出现在 DropdownMenuSeparator（unused 组件），且 visual result 可接受（灰色分隔线）。
- 所有 `text-muted-foreground` 用法正确映射到文字色。
- 所有 `bg-secondary` 用法正确映射到面板色。
- 唯一的语义冲突（shadcn `bg-muted`=背景色 vs v3 `--muted`=文字色）在原子层无不良视觉效果。

**但 RC-08 作为根因仍然存在**：shadcn 与 v3 的 `--muted` 语义分歧是客观事实。当前无害仅因原子层没有需要"muted 背景色"的场景（如 notifications、badge bg、disabled bg）。若未来引入此场景，需使用 `--surface-hover` 或新 token 替代 `bg-muted`，而不是依赖当前 `--muted` 的歧义行为。

---

## 五、其他根因核验

### RC-01/02（settingsStore 缺失 + 无 `[data-theme]` 切换）

原子组件层无直接依赖 `settingsStore` 或 `data-theme` 属性。所有 token 通过 `:root` CSS 变量接入，主题切换机制在 CSS 层而非组件层。**原子层不受 RC-01/02 直接影响**。

### RC-06（tailwind `darkMode: 'class'` 无注入）

在 36 个文件中无任何 `dark:` variant 使用。`darkMode: 'class'` 机制在 tailwind.config.ts 中已配置，但原子组件不依赖此机制（全部用 `:root` CSS 变量，暗色/亮色通过 CSS 变量值切换，非 Tailwind dark class）。**RC-06 在原子层无表现**。

---

## 六、Wave 小结

| 指标 | 数量 |
|------|------|
| 审查文件总数 | 36 |
| ✅ 一致 | 0 |
| ⚠ 偏差 | 12 |
| ❌ 缺失 | 4 |
| 🆕 多余（组/文件） | 3 组共 23 文件（dropdown-menu 15 + tooltip 4 + dialog 4） |
| 根因关联条目 | 6（RC-03 ×1 / RC-04 ×2 / RC-08 ×3） |
| 新独立问题 | 18（未与 W01 根因关联的 ⚠/❌/🆕） |

### 关键发现优先级

1. **P0 · ❌ 阻断**: Textarea 缺 focus ring（BUI-TA-01）— 无障碍缺陷，所有键盘用户受影响。
2. **P0 · ❌ 阻断**: `--surface-2` 缺失（RC-04，波及 Input + Textarea）— 两个核心输入组件背景无视觉容器感。
3. **P1 · 🆕 清理**: dropdown-menu 15 文件 + tooltip 4 文件完全冗余 — 构建体积、代码导航噪音。
4. **P1 · ⚠ 语义**: Button 4/6 variant 与 design-system 不一致（Ghost hover 蓝 / Secondary 实底 / Destructive 实底）— 影响全局按钮视觉统一性。
5. **P2 · ⚠ 体验**: Dialog backdrop 缺 blur / Dialog bg 用 canvas 色 / Input ring 外环非 inset — 精细度问题。

### 跨 wave 依赖提示

- **BUI-TA-02**（Textarea min-height）需 W01-PN 审查 Composer.vue 时确认是否已有 `min-h-[56px]` 覆写。
- **BUI-IP-01 + BUI-TA-03**（`--surface-2` 缺失）需 W06-CS 审查 style.css/tailwind.config 时确认 token 补全方案。
- **BUI-DLG-02**（Dialog bg）与 B-SH-W2 MainPanel 的 float-panel 语义相关，两 wave 应统一 `--surface` vs `--bg` 在浮层中的使用约定。
