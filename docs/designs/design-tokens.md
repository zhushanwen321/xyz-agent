# Design Tokens — zcode 冷蓝暗色（Single Source of Truth）

> 真身文件。所有色值/字体/圆角/阴影/动效以此为准。
> 由 ADR-0018 确立：C(zcode-demo) 视觉方向 + 补全的完整体系。
> 标注「补全」的项未经视觉校准，需在高保真阶段验证。

## 色彩 — 暗色（默认 / 优先）

| Token | 值 | 用途 | 来源 |
|-------|-----|------|------|
| `--bg` | `#0d0d0f` | 画布底层 | C 原始 |
| `--surface` | `#151519` | 面板/卡片 | C (`--panel`) |
| `--surface-hover` | `#1b1b20` | 面板悬停 | C (`--panel-hover`) |
| `--fg` | `#f0f0f5` | 主文字 | C (`--text-primary`) |
| `--muted` | `#8a8a95` | 次级文字 | C (`--text-secondary`) |
| `--subtle` | `#5a5a65` | 三级文字/占位 | C (`--text-tertiary`) |
| `--border` | `rgba(255,255,255,0.06)` | 分隔线 | C 原始 |
| `--border-strong` | `rgba(255,255,255,0.12)` | 强调分隔 | 补全 |
| `--accent` | `#4f8ef7` | 主色/链接/聚焦 | C 原始 |
| `--accent-hover` | `#6ba3ff` | 主色悬停 | 补全 |
| `--accent-soft` | `rgba(79,142,247,0.12)` | 主色背景填充 | 补全 |

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
| `--fg` | `#0d0d0f` |
| `--muted` | `#5a5a65` |
| `--border` | `rgba(0,0,0,0.08)` |
| `--accent` | `#2563eb`（加深保证对比度） |

## 已知裂缝（需对齐）

- **impl 变量归一**（✅ 已裁决 ADR-0021-B / 选项②，2026-06-20）：真实代码自造的 `--section-bg` / `--divider` / `--accent-light` **迁移到本文件 SSOT 已有名**，不补进 tokens（避免同语义双名）：`--section-bg`→`--surface`、`--divider`→`--border`、`--accent-light`→`--accent-soft`。draft 已用 SSOT 名（无需改）；真身 CSS 待迁移。见 `settings/handoff-system.md §13`。
- **默认主题方向**（✅ 已裁决 ADR-0021-B，2026-06-20）：**暗色冷蓝为真默认**（`--bg #0d0d0f` / accent `#4f8ef7`），与本文件 + `design-system.md §10` 主张一致。真身 `settingsStore` 初值待从 `light/neutral` 迁移到 `dark/cold-blue`（见 handoff `§11b` 待办）；draft 已用 cold-blue 演示，与本裁决一致。

## 待办

- [ ] 补全项（标注「补全」）经高保真视觉校准
- [ ] 亮色变体打磨
- [ ] 落地到 `style.css :root` + `tailwind.config.ts`（见 ADR-0018 修复清单）
- [x] ~~裁决 impl 变量归一~~（已裁决 ADR-0021-B/选项②，2026-06-20）
- [ ] 真身落地：① `settingsStore` 初值改 `dark/cold-blue` ② CSS `--section-bg`/`--divider`/`--accent-light` 迁移到 SSOT 名（见 ADR-0021）
