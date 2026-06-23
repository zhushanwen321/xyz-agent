# Design Tokens — zcode 冷蓝暗色（Single Source of Truth）

> 真身文件。所有色值/字体/圆角/阴影/动效以此为准。
> 由 ADR-0018 确立：C(zcode-demo) 视觉方向 + 补全的完整体系。
> 标注「补全」的项未经视觉校准，需在高保真阶段验证。

## 色彩 — 暗色（默认 / 优先）

| Token | 值 | 用途 | 来源 |
|-------|-----|------|------|
| `--bg` | `#0d0d0f` | 画布底层 | C 原始 |
| `--surface` | `#151519` | 面板/卡片 | C (`--panel`) |
| `--surface-hover` | `#1f1f26` | 面板悬停 | draft-session-item/composer-states.html `:root`（P1-1 修正：原误取 surface-2 值 #1b1b20） |
| `--surface-2` | `#1b1b20` | 二级表面（Card-Elevated） | draft-composer-states.html `:root` |
| `--bg-elevated` | `#1c1c20` | 浮起面板/激活面板底色 | draft-dual-panel.html `.panel.active` |
| `--bg-input` | `#101013` | 输入区底色（Input/Textarea/Composer zone） | draft-companion-zones.html + draft-composer-states.html |
| `--fg` | `#f0f0f5` | 主文字 | C (`--text-primary`) |
| `--muted` | `#8a8a95` | 次级文字 | C (`--text-secondary`) |
| `--subtle` | `#5a5a65` | 三级文字/占位 | C (`--text-tertiary`) |
| `--border` | `rgba(255,255,255,0.06)` | 分隔线 | C 原始 |
| `--border-strong` | `rgba(255,255,255,0.12)` | 强调分隔 | 补全 |
| `--accent` | `#4f8ef7` | 主色/链接/聚焦 | C 原始 |
| `--accent-hover` | `#6ba3ff` | 主色悬停 | 补全 |
| `--accent-soft` | `rgba(79,142,247,0.12)` | 主色背景填充 | 补全 |
| `--accent-ring` | `rgba(79,142,247,0.30)` | 选中态内描边（Card-Active `inset 0 0 0 1px`）| workspace/spec.md（draft 间 0.30/0.45/0.50 不一，以 spec 为准）|

## 状态色（继承 D 的结构，色相对齐冷蓝体系）

| Token | 值 | 用途 | 来源 |
|-------|-----|------|------|
| `--success` | `#22c55e` | 成功 | C + D 一致 |
| `--warning` | `#f5a524` | 警告 | 补全 |
| `--danger` | `#ef4444` | 错误/危险 | 补全 |
| `--info` | `#38bdf8` | 信息/提示 | 补全 |
| `--reasoning` | `#a78bfa` | 思考块色相（draft-message-stream §4 + composer 思考等级） | 补全（v3 重建 Wave 1） |

## 字体

```css
--font-sans: Inter, 'SF Pro Display', 'PingFang SC', system-ui, sans-serif;  /* C */
--font-mono: 'JetBrains Mono', 'IBM Plex Mono', ui-monospace, Menlo, monospace;  /* D 继承 */
/* display 与 body 同用 --font-sans（tech-utility 取向，开发者工具直觉） */
```

## 圆角（C 原仅 3/12，补 8 中间档）

| Token | 值 | 用途 |
|-------|-----|------|
| `--radius-sm` | `3px` | 输入框/标签（C） |
| `--radius` | `8px` | 按钮/卡片（补全） |
| `--radius-lg` | `12px` | 面板/弹层（C） |

## 间距（4px 栅格，补全）

`--space-1` 4px · `--space-2` 8px · `--space-3` 12px · `--space-4` 16px · `--space-6` 24px · `--space-8` 32px · `--space-12` 48px · `--space-16` 64px

## 阴影

```css
--shadow-1: 0 0 0 1px rgba(0,0,0,0.2);           /* C 原始，描边 */
--shadow-2: 0 8px 24px rgba(0,0,0,0.4);          /* 补全，浮层 */
--shadow-glow: 0 0 0 3px rgba(79,142,247,0.25);  /* 补全，聚焦环 */
```

## 动效

```css
--ease: cubic-bezier(0.4, 0, 0.2, 1);  /* D 继承，通用 */
--duration-fast: 120ms;                 /* 补全 */
--duration: 200ms;                      /* 补全 */
--duration-slow: 320ms;                 /* 补全 */
```

## 色彩 — 亮色（备选，待校准）

> 暗色优先；亮色为降级变体，保持同色相，后续高保真阶段打磨。

| Token | 值 |
|-------|-----|
| `--bg` | `#f8f9fb` |
| `--surface` | `#ffffff` |
| `--surface-2` | 待设计确认 |
| `--bg-elevated` | 待设计确认 |
| `--bg-input` | 待设计确认 |
| `--fg` | `#0d0d0f` |
| `--muted` | `#5a5a65` |
| `--border` | `rgba(0,0,0,0.08)` |
| `--accent` | `#2563eb`（加深保证对比度） |

## 已知裂缝（需对齐）

- **impl 变量归一**（✅ 已裁决 ADR-0021-B / 选项②，2026-06-20）：真实代码自造的 `--section-bg` / `--divider` / `--accent-light` **迁移到本文件 SSOT 已有名**，不补进 tokens（避免同语义双名）：`--section-bg`→`--surface`、`--divider`→`--border`、`--accent-light`→`--accent-soft`。draft 已用 SSOT 名（无需改）；真身 CSS 待迁移。见 `settings/handoff-system.md §13`。
- **默认主题方向**（✅ 已裁决 ADR-0021-B，2026-06-20）：**暗色冷蓝为真默认**（`--bg #0d0d0f` / accent `#4f8ef7`），与本文件 + `design-system.md §10` 主张一致。真身 `settingsStore` 初值待从 `light/neutral` 迁移到 `dark/cold-blue`（见 handoff `§11b` 待办）；draft 已用 cold-blue 演示，与本裁决一致。

## 待办

- [ ] 补全项（标注「补全」）经高保真视觉校准
- [ ] 亮色变体打磨（含新增 `--surface-2` / `--bg-elevated` / `--bg-input` 亮色值）
- [x] 落地到 `style.css :root` + `tailwind.config.ts`（见 ADR-0018 修复清单；新增 3 token 已于 T01 补齐）
- [x] ~~裁决 impl 变量归一~~（已裁决 ADR-0021-B/选项②，2026-06-20）
- [ ] 真身落地：① `settingsStore` 初值改 `dark/cold-blue` ② CSS `--section-bg`/`--divider`/`--accent-light` 迁移到 SSOT 名（见 ADR-0021）

## shadcn 命名映射（2026-06-20 收尾）

本地 `components/ui/`（shadcn-vue copy）+ xyz-ui 依赖 shadcn 命名约定（`--primary`/`--secondary`/`--destructive` 等），与本文件 v3 命名（`--accent`/`--surface`/`--danger`）存在 gap，导致 default Button 背景透明（W18）。修复：**别名映射**，不引入新色值，不改 SSOT 原子值。

落地两层：`style.css :root`（CSS 变量）+ `tailwind.config.ts theme.extend.colors`（utility 映射，shadcn class 如 `bg-primary` 经此生成）。

映射表（shadcn → v3）：

| shadcn token | → v3 | 说明 |
|---|---|---|
| `--primary` / `--primary-foreground` | `--accent` / `--fg` | default Button 底=主色蓝 |
| `--secondary` / `--secondary-foreground` | `--surface` / `--fg` | secondary Button 底=面板色 |
| `--destructive` / `--destructive-foreground` | `--danger` / `--fg` | destructive Button 底=危险红 |
| `--muted-foreground` | `--muted` | shadcn 次级文字（-foreground 后缀）|
| `--accent-foreground` | `--fg` | ghost hover 配字 |
| `--background` / `--foreground` | `--bg` / `--fg` | 画布/主文字 |
| `--popover` / `--popover-foreground` | `--surface` / `--fg` | 弹层面板 |
| `--input` | `--border` | input 边框 |
| `--ring` | `--accent` | focus ring（主色）|

**已知命名冲突（维持 v3，不覆盖）**：
- `--accent`：v3=主色蓝（强调/品牌，19 处业务代码 + tailwind config 锁定）；shadcn=hover 软底（中性）。语义相反，维持 v3 主色蓝（W01 零回归）。副作用：ghost/outline Button 的 `hover:bg-accent` hover 成主色蓝（既有状态，非本修复引入）。
- `--muted`：v3=次级文字色（#8a8a95）；shadcn=背景色。维持 v3。副作用：`bg-muted`（仅 `DropdownMenuSeparator` 1px 分隔线用）渲染为 v3 灰——视觉正确。

两项冲突是 shadcn 命名与 v3 命名的根本不兼容，纯 token 别名无法消除；维持 v3 语义保证 W01 零回归，副作用可接受。若未来要 ghost hover 中性化，需在 button variant 改用 `hover:bg-surface-hover`（改组件，非 token 层）。
