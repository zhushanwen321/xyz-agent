# Design Tokens — 太极·玄纯灰暗色（Single Source of Truth）

> 真身文件。所有色值/字体/圆角/阴影/动效以此为准。
> 由 ADR-0019 确立：C(zcode-demo) 视觉方向 + 补全的完整体系。
> 标注「补全」的项未经视觉校准，需在高保真阶段验证。
>
> **2026-08-02 更新**：v6 重构后，token 决策与范式权威源迁至 [`v6-master-spec.md`](./v6-master-spec.md) §4；值真值的机器可读固化见 [`v6-tokens.css`](./v6-tokens.css)（自 .tmp/v6 demo 固化，随仓库提交）。本文件表格已同步为定稿值（如 `--accent` = `#cfcfd4`，微提自早期提案 `#c8c8cd`）；如有差异，以 master-spec §4 + v6-tokens.css 为准。本文件保留作历史决策追溯。

## 色彩 — 暗色（默认 / 优先）

> 2026-07-09 提亮校准（对标 VS Code Dark+）：原值画布过暗（bg L=0.0041），
> 长时间使用体感"太暗"；提亮后 bg L=0.0110，与 VS Code Dark 持平。
> subtle 一并修复到 ≥4.5:1（原 2.85:1 不达 WCAG AA）。
> fg 提到更白的 #f7f8fc。
>
> 2026-07-12 拉大层级间距：原相邻 token 亮度差 <3%（bg→surface 仅 Δ8），
> 侧边栏与对话流肉眼不可辨。surface 以上整体上推，bg→surface 拉到 Δ13（≈5%），
> 每层 ≥Δ5 肉眼可辨。bg / bg-input 保持不变（锚点 + 输入坑凹陷语义）。
>
> **2026-08-02 太极·玄定稿值**（当前真值）：冷蓝暗色系整体替换为纯灰系（太极·玄），
> 决策见 `2026-08-02-taiji-v3-color-decision.md` §三。下表「值」列为太极·玄定稿值（与 [`v6-tokens.css`](./v6-tokens.css) 逐字对齐），
> 「来源」列末尾以「；2026-08-02 太极·玄」标注改动项。亮色变体本轮不动。

| Token | 值 | 用途 | 来源 |
|-------|-----|------|------|
| `--bg-stage` | `#0a0a0c` | 舞台深底（最外层衬底，低于 `--bg`） | 2026-08-02 太极·玄新增（demo tokens.css §4） |
| `--bg` | `#131316` | 画布底层 | 2026-07-09 提亮（原 C 原始 `#0d0d0f`）。07-12 锚点不变；2026-08-02 太极·玄（阶梯上抬） |
| `--bg-sunken` | `var(--bg)` | 同画布色（v6 新增：语义变更，不往黑推，靠 surface 浮起分隔） | 2026-08-02 太极·玄新增 |
| `--surface` | `#1f1f22` | 面板/卡片 | 2026-07-12 拉距（原 07-09 `#222329`，+5 拉大与 bg 间距）；2026-08-02 太极·玄（阶梯上抬） |
| `--surface-hover` | `#303033` | 面板悬停 | 2026-07-12 拉距（原 07-09 `#2d2e36`，+9）；2026-08-02 太极·玄（加宽级差） |
| `--surface-2` | `#27272a` | 二级表面（Card-Elevated） | 2026-07-12 拉距（原 07-09 `#282930`，+6）；2026-08-02 太极·玄（阶梯上抬） |
| `--bg-elevated` | `#2b2b2e` | 浮起面板/激活面板底色 | 2026-07-12 拉距（原 07-09 `#2a2b32`，+7）；2026-08-02 太极·玄（阶梯上抬） |
| `--bg-input` | `#17171a` | 输入区底色（Input/Textarea/Composer zone） | 2026-07-09 提亮（原 `#101013`）。07-12 不变（Δ4 from bg 凹陷语义）；2026-08-02 太极·玄（阶梯上抬） |
| `--bubble-bg` | `var(--surface-hover)` | 用户气泡底色（暗：浮起灰；亮：纯白，见亮色表） | 2026-08-06 新增（亮色灰底读作禁用态 → 白纸化，见 style.css :root 注释） |
| `--composer-bg` | `var(--bg-input)` | composer 输入区底色（暗：凹陷；亮：纯白） | 2026-08-06 新增（同上，亮色白纸化） |
| `--bg-card` | `#1b1b1e` | 卡片底色 | 2026-08-02 太极·玄新增 |
| `--neutral-fg` | `#dedee2` | 主文字 | 2026-07-26 W1 重命名（原 `--fg` `#f7f8fc`，调低至冷中性 #e5e7eb 对齐 neutral 谱系）；2026-08-02 太极·玄（上抬） |
| `--neutral-mid` | `#96969c` | 次级文字 | 2026-07-26 W1 重命名（原 `--muted` `#a8a8b5`）；2026-08-02 太极·玄（上抬） |
| `--neutral-dim` | `#74747a` | 三级文字/占位 | 2026-07-26 W1 重命名（原 `--subtle` `#82828f`）；2026-08-02 太极·玄（上抬，对比度 ~4.4:1） |
| `--neutral-faint` | `#46464c` | 极弱文字/禁用态 | 2026-07-26 W1 新增（neutral 谱系第四阶）；2026-08-02 太极·玄（上抬） |
| `--neutral-ico` | `#86868c` | 默认图标色 | 2026-07-26 W1 新增（图标独立于文字色相，避免文字灰与图标灰混用）；2026-08-02 太极·玄（上抬） |
| `--neutral-ico-hover` | `#dedee2` | 图标 hover 色 | 2026-07-26 W1 新增（hover 回升至 fg 级）；2026-08-02 太极·玄（同步 fg） |
| `--border` | `rgba(255,255,255,0.07)` | 分隔线 | 2026-07-09 提亮（原 0.06，提亮 bg 后可见度不足）；2026-08-02 太极·玄（0.05→0.07） |
| `--border-strong` | `rgba(255,255,255,0.13)` | 强调分隔 | 2026-07-09 提亮（原 0.12）；2026-08-02 太极·玄（0.10→0.13） |
| `--hairline` | `rgba(255,255,255,0.05)` | 行分隔 / drawer L1 栏底线（v6 新增，比 border 更弱） | 2026-08-02 太极·玄新增 |
| `--accent` | `#cfcfd4` | 主色/链接/聚焦 | C 原始；2026-08-02 太极·玄（冷蓝 #4f8ef7 → 纯灰亮灰，微提自 #c8c8cd） |
| `--accent-hover` | `#e0e0e4` | 主色悬停 | 补全；2026-08-02 太极·玄 |
| `--accent-soft` | `color-mix(in oklch, var(--accent) 10%, transparent)` | 主色背景填充（color-mix 派生：palette 切换自动跟随 --accent） | 补全（暗色从 rgba 硬编码改为 color-mix，与亮色一致）；2026-08-02 太极·玄（12%→10%） |
| `--accent-ring` | `color-mix(in oklch, var(--accent) 30%, transparent)` | 选中态内描边（Card-Active `inset 0 0 0 1px`）| workspace/spec.md（draft 间 0.30/0.45/0.50 不一，以 spec 为准）；2026-08-02 太极·玄（改 color-mix 派生跟随 --accent） |
| `--accent-fg` | `#1a1a1c` | accent 实色上的文字色（暗主题中亮灰 accent 需深字） | 2026-08-02 太极·玄新增 |

## 状态色（继承 D 的结构；2026-08-02 太极·玄：水墨降饱和，克制放开档）

| Token | 值 | 用途 | 来源 |
|-------|-----|------|------|
| `--success` | `#78a87e` | 成功 | C + D 一致；2026-08-02 太极·玄（降饱和放开档） |
| `--warn` | `#b79c54` | 警告 | 2026-07-26 W1 重命名调值（原 `--warning` `#f5a524`，降饱和至哑光金 #b08a3e，褪鲜橙）；2026-08-02 太极·玄（放开档） |
| `--danger` | `#bf6b6b` | 错误/危险 | 补全；2026-08-02 太极·玄（放开档） |
| `--danger-fg` | `#f0f0f2` | danger 实色上的文字色（降明度 danger 需浅字） | 2026-08-02 太极·玄新增 |
| `--info` | `#6d99a5` | 信息/提示 | 补全；2026-08-02 太极·玄（放开档） |
| `--reasoning` | `#8e85ab` | 思考块色相（draft-message-stream §4 + composer 思考等级） | 补全（v3 重建 Wave 1）；2026-08-02 太极·玄（放开档） |
| `--reasoning-soft` | `color-mix(in oklch, var(--reasoning) 12%, transparent)` | think badge / slash chip 背景（统一 12% 基准，与状态色 soft 对齐） | 补全（18%→12% 统一） |
| `--info-soft` | `color-mix(in oklch, var(--info) 12%, transparent)` | 信息/提示软底（badge/提示条背景，12% 基准） | 补全（状态色 soft 归一） |
| `--success-soft` | `color-mix(in oklch, var(--success) 12%, transparent)` | 成功软底（badge/changeset resolved 背景，12% 基准） | 补全（状态色 soft 归一） |
| `--danger-soft` | `color-mix(in oklch, var(--danger) 12%, transparent)` | 错误/危险软底（失败块/badge 背景，12% 基准） | 补全（状态色 soft 归一） |
| `--warn-soft` | `color-mix(in oklch, var(--warn) 14%, transparent)` | 警告软底（badge/提示条背景，14% 基准） | 2026-07-26 W1 重命名（原 `--warning-soft` 12%，提到 14% 补偿哑光金的视觉重量不足） |

## diff 着色（2026-08-02 太极·玄：柔化 12%）

| Token | 值 | 用途 | 来源 |
|-------|-----|------|------|
| `--diff-add-bg` | `color-mix(in oklch, var(--success) 12%, transparent)` | diff 行背景（新增，柔化档） | 2026-08-02 太极·玄新增 |
| `--diff-del-bg` | `color-mix(in oklch, var(--danger) 12%, transparent)` | diff 行背景（删除，柔化档） | 2026-08-02 太极·玄新增 |
| `--diff-add-strong` | `color-mix(in oklch, var(--success) 45%, transparent)` | diff 字符级背景（新增，高饱和） | 2026-08-02 太极·玄新增 |
| `--diff-del-strong` | `color-mix(in oklch, var(--danger) 45%, transparent)` | diff 字符级背景（删除，高饱和） | 2026-08-02 太极·玄新增 |

## 图表派生 token（2026-08-25 用量统计页新增）

> 全部从 `--chart-ink` 派生（color-mix oklch），不手写色值；6 主题各自定义（玄=:root 默认，
> 其余主题块同名覆盖；彩色亮色 preset 青墨/朱印额外覆盖 --chart-ink 掺入 accent 色相）。
> 明度方向自动反转（暗：墨越亮越浓；亮：墨越深越浓）。定义见 style.css 各主题块；
> 文档版同步 docs/page-design/v6-tokens.css。dim/mid 对比度修正提案待产品拍板。

| Token | 值（玄 · 暗） | 用途 |
|-------|--------------|------|
| `--chart-ink` | `var(--neutral-fg)` | 图表墨色派生源（青墨/朱印 = color-mix 掺 45% accent） |
| `--chart-p1` | `color-mix(in oklch, var(--chart-ink) 92%, var(--bg))` | provider 序列 p1（占比最高档） |
| `--chart-p2` | `color-mix(in oklch, var(--chart-ink) 70%, var(--bg))` | provider 序列 p2 |
| `--chart-p3` | `color-mix(in oklch, var(--chart-ink) 48%, var(--bg))` | provider 序列 p3 |
| `--chart-p4` | `color-mix(in oklch, var(--chart-ink) 30%, var(--bg))` | provider 序列 p4 |
| `--chart-p5` | `color-mix(in oklch, var(--chart-ink) 17%, var(--bg))` | provider 序列 p5 |
| `--heat-0` | `color-mix(in oklch, var(--chart-ink) 5%, var(--bg))` | 热力墨阶 0（无消耗底色） |
| `--heat-1` | `color-mix(in oklch, var(--chart-ink) 12%, var(--bg))` | 热力墨阶 1 |
| `--heat-2` | `color-mix(in oklch, var(--chart-ink) 24%, var(--bg))` | 热力墨阶 2 |
| `--heat-3` | `color-mix(in oklch, var(--chart-ink) 40%, var(--bg))` | 热力墨阶 3 |
| `--heat-4` | `color-mix(in oklch, var(--chart-ink) 60%, var(--bg))` | 热力墨阶 4 |
| `--heat-5` | `color-mix(in oklch, var(--chart-ink) 82%, var(--bg))` | 热力墨阶 5（当日最浓） |
| `--cache-hit` / `--cache-out` / `--cache-in` | `85% / 55% / 30%` 派生 | 缓存构成三色（命中/输出/新输入） |
| `--hover-tint` | `color-mix(in oklch, var(--neutral-fg) 5%, transparent)` | 图表 hover 列高亮 |
| `--row-hover` | `color-mix(in oklch, var(--neutral-fg) 3%, transparent)` | 排名行 hover |
| `--track` | `color-mix(in oklch, var(--neutral-fg) 8%, transparent)` | 排名条底槽 |
| `--heat-outline` | `color-mix(in oklch, var(--neutral-fg) 45%, transparent)` | 热力格描边 |

## 字体

```css
--font-sans: system-ui, 'PingFang SC', 'Helvetica Neue', 'Microsoft YaHei', 'Noto Sans CJK SC', sans-serif;
> 2026-08-25 改系统栈，supersede 本文件原 Inter 决策，权威见 v6-master-spec §4.6
--font-mono: 'JetBrains Mono', 'IBM Plex Mono', ui-monospace, Menlo, monospace;  /* D 继承 */
/* display 与 body 同用 --font-sans（tech-utility 取向，开发者工具直觉） */
```

## 字号 scale（补全，2026-07-28 W2；2026-08-02 太极·玄整体上移一档 + calc 自适应）

> 组件级字号 SSOT。所有 `text-[Npx]` utility 优先用 `text-[var(--text-X)]` 引用本 scale，
> 禁止 `.5px` 字号（`text-[12.5px]` 等）—— snap 到最近 scale step。
>
> 2026-08-02 太极·玄：base 13→14px 整体上移一档；改 calc 自适应公式
> `calc(Npx × --font-scale-u × --font-scale-mq)`，用户档位与视口档位相乘。

| Token | 值 | 用途 |
|-------|-----|------|
| `--font-scale-u` | `1`（默认） | 用户字号档位（data-font-size: small=0.929 / medium=1 / large=1.143） | 2026-08-02 太极·玄新增（demo tokens.css + useTheme） |
| `--font-scale-mq` | `1`（默认） | 视口自适应档位（@media: ≥2100px=1.08 / ≤1399px=0.95） | 2026-08-02 太极·玄新增（demo tokens.css 底部 @media） |
| `--font-scale-sidebar` / `--font-scale-chat` / `--font-scale-drawer` | `1`（默认） | 分区字号档位（data-fs-\<region\>: small=0.9 / medium=1 / large=1.15 / xlarge=1.3；区域根 data-fs-scope 槽位重声明 --text-* 链） | 2026-08-26 feat-font-optimize 新增（Settings 外观页分区字号） |
| `--text-3xs` | `calc(10px × u × mq)` | 极小字（sidebar 徽标 / drawer 次要 meta） | 2026-08-26 feat-font-optimize 新增（sidebar/drawer 硬编码 10px token 化） |
| `--text-2xs` | `calc(11px × u × mq)` | 极小字（bash truncation / runId / dirPath） |
| `--text-xs` | `calc(12px × u × mq)` | 小字（tag / meta / mono detail） |
| `--text-sm` | `calc(13px × u × mq)` | 次级正文（task preview / bash content / label） |
| `--text-base` | `calc(14px × u × mq)` | block header 统一字号（2026-08-02 上移：原 13px） |
| `--text-md` | `calc(15px × u × mq)` | 正文（user message body；2026-08-02 上移：原 14px） |

## 圆角（C 原仅 3/12，补 8 中间档）

> **v6 已落地**（2026-08-02 反写，C1）：`--radius-sm` 已升至 `6px`（全局默认档），新增 `--radius-card: 10px`。下表为当前真值（与 [`v6-tokens.css`](./v6-tokens.css) 对齐）。

| Token | 值 | 用途 |
|-------|-----|------|
| `--radius-sm` | `6px` | 输入框/标签（v6 升档） |
| `--radius` | `8px` | 按钮/卡片（补全） |
| `--radius-card` | `10px` | 卡片容器（v6 新增） |
| `--radius-lg` | `12px` | 面板/弹层（C） |

## 间距（4px 栅格，补全）

`--space-1` 4px · `--space-2` 8px · `--space-3` 12px · `--space-4` 16px · `--space-6` 24px · `--space-8` 32px · `--space-12` 48px · `--space-16` 64px

## 阴影

```css
--shadow-1: 0 0 0 1px rgba(0,0,0,0.2);           /* C 原始，描边 */
--shadow-2: 0 8px 24px rgba(0,0,0,0.4);          /* 补全，浮层 */
--shadow-drawer: -12px 0 24px rgba(0,0,0,0.16); /* 2026-08-02 太极·玄新增：弱投影（D2 一体化分隔） */
--shadow-glow: 0 0 0 3px color-mix(in oklch, var(--accent) 25%, transparent);  /* steer/活跃环（composer-shell isActive 分支；focus 聚焦环用 --accent-ring）；2026-08-02 V3 改 color-mix 派生跟随 --accent */
```

## 动效

```css
--ease: cubic-bezier(0.4, 0, 0.2, 1);  /* D 继承，通用 */
--duration-fast: 120ms;                 /* 补全 */
--duration: 200ms;                      /* 补全 */
--duration-slow: 320ms;                 /* 补全 */
```

## 色彩 — 亮色（备选，已校准）

> 暗色优先；亮色为降级变体，保持同色相。
> 2026-06-27 回填 SSOT 并落地 `style.css [data-theme="light"]`。
> 层级关系与暗色镜像：bg 最浅 → surface 纯白 → surface-2 略灰 → surface-hover 更灰；
> bg-elevated 浮起用接近 surface 的白 + 阴影区分；bg-input 输入区略沉于 surface。

| Token | 值 | 来源 |
|-------|-----|------|
| `--bg-stage` | `#dbd9d4` | MF-1 新增：亮色最深衬底（窗口底，透过 app-shell 圆角/padding 透出）；TAIJI_PAPER 无独立 stage，复用宣纸族最深暖灰（同 `--surface-hover`），延续暗色 base→canvas→surface 三层明度（style.css `[data-theme=light]`） |
| `--bg` | `#f8f9fb` | draft-system light |
| `--surface` | `#ffffff` | draft-system light |
| `--surface-2` | `#f1f3f6` | draft-system light（原「待确认」，draft 已给值） |
| `--surface-hover` | `#e9ecef` | draft-system light（原「待确认」，draft 已给值） |
| `--bg-elevated` | `#ffffff` | 补全：浮起面板用纯白（同 surface）+ `--shadow-2` 区分层级，避免亮色再叠灰显脏 |
| `--bg-input` | `#f1f3f6` | 补全：输入区沉于 surface，对齐 surface-2（同色相同层级） |
| `--bubble-bg` | `#ffffff` | 用户气泡底色（白纸浮起，与米白面板区分；链接对比度 4.24→5.53 过 AA） | 2026-08-06 新增 |
| `--composer-bg` | `#ffffff` | composer 输入区底色（白纸，禁用感消除） | 2026-08-06 新增 |
| `--neutral-fg` | `#0d0d0f` | 2026-07-26 W1 重命名（原 `--fg`） |
| `--neutral-mid` | `#5a5a65` | 2026-07-26 W1 重命名（原 `--muted`） |
| `--neutral-dim` | `#8a8a95` | 2026-07-26 W1 重命名（原 `--subtle`；亮色下 dim/mid 明度对调：mid 深、dim 浅） |
| `--neutral-faint` | `#c0c0c8` | 2026-07-26 W1 新增 |
| `--neutral-ico` | `#6a6a75` | 2026-07-26 W1 新增 |
| `--neutral-ico-hover` | `#0d0d0f` | 2026-07-26 W1 新增 |
| `--warn` | `#8a6a2e` | 2026-07-26 W1 重命名调值（原 `--warning`，亮色加深保证白底对比度） |
| `--warn-soft` | `color-mix(in oklch, var(--warn) 14%, transparent)` | 2026-07-26 W1 重命名（原 `--warning-soft`） |
| `--border` | `rgba(0,0,0,0.08)` | draft-system light |
| `--border-strong` | `rgba(0,0,0,0.14)` | draft-system light（原「待确认」，draft 已给值） |
| `--accent` | `#2563eb` | 加深保证对比度（palette 切换时由 data-palette 覆盖，themePreset 暂未实装） |
| `--accent-hover` | `#3b82f6` | 补全：亮色下提亮一档（暗色是 #6ba3ff 提亮，亮色相反取更亮蓝保证白底可见） |
| `--accent-soft` | `color-mix(in oklch, var(--accent) 13%, transparent)` | 派生（draft-system §token 方案）：跟随 --accent 自动适配明暗，无需逐主题手写 |
| `--accent-ring` | `color-mix(in oklch, var(--accent) 30%, transparent)` | 派生：同上，选中态内描边 |

> `--accent-soft` / `--accent-ring` 用 `color-mix` 派生是 draft-system 已验证方案：
> 无论暗/亮主题，soft/ring 自动跟随当前 `--accent`（含未来 palette 覆盖），单一来源、零维护。
> 状态色（success/warning/danger/info/reasoning）亮暗共用同一色相，亮色下饱和度足够，不单独覆盖。

## 已知裂缝（需对齐）

- **impl 变量归一**（✅ 已裁决 ADR-0022-B / 选项②，2026-06-20）：真实代码自造的 `--section-bg` / `--divider` / `--accent-light` **迁移到本文件 SSOT 已有名**，不补进 tokens（避免同语义双名）：`--section-bg`→`--surface`、`--divider`→`--border`、`--accent-light`→`--accent-soft`。draft 已用 SSOT 名（无需改）；真身 CSS 待迁移。见 `settings/handoff-system.md §13`。
- **默认主题方向**（✅ 已落地，2026-06-27；2026-08-02 太极·玄）：**暗色纯灰为真默认**（`--bg #131316` / accent `#cfcfd4`，2026-07-09 提亮校准 + 08-02 太极·玄定稿）。`stores/settings.ts` 重构为单一真相源，DEFAULT_SYSTEM = `{ theme:'dark', themePreset:'cold-blue', locale:'zh-CN' }`（themePreset 名暂留历史，色值已由本文件 :root token 覆盖为太极·玄），`setSystem()` 同步 `<html data-theme>` 到 DOM —— 主题切换已从「死设置」变为实际生效。

## 待办

- [ ] 补全项（标注「补全」）经高保真视觉校准
- [x] ~~亮色变体打磨~~（2026-06-27 完成：`--surface-2` / `--surface-hover` / `--bg-elevated` / `--bg-input` / `--subtle` / `--border-strong` / `--accent-hover` / `--accent-soft` / `--accent-ring` 亮色值已回填 SSOT 并落地 `style.css [data-theme="light"]`）
- [x] 落地到 `style.css :root` + `tailwind.config.ts`（见 ADR-0019 修复清单；新增 3 token 已于 T01 补齐）
- [x] ~~裁决 impl 变量归一~~（已裁决 ADR-0022-B/选项②，2026-06-20）
- [x] ~~真身落地：settingsStore 初值改 dark/cold-blue~~（2026-06-27 stores/settings.ts 重构完成；CSS `--section-bg`/`--divider`/`--accent-light` 真身代码无残留，全用 SSOT 名）
- [ ] themePreset（palette）实装：11 个配色 swatch 的 `data-palette` 切换 + `--accent` 覆盖（`--accent-soft`/`--accent-ring` 经 color-mix 已自动跟随，只需覆盖 `--accent`）。当前 SystemPage 选中态落地、实色切换暂缓。

## shadcn 命名映射（2026-06-20 收尾）

本地 `components/ui/`（shadcn-vue copy）+ xyz-ui 依赖 shadcn 命名约定（`--primary`/`--secondary`/`--destructive` 等），与本文件 v3 命名（`--accent`/`--surface`/`--danger`）存在 gap，导致 default Button 背景透明（W18）。修复：**别名映射**，不引入新色值，不改 SSOT 原子值。

落地两层：`style.css :root`（CSS 变量）+ `tailwind.config.ts theme.extend.colors`（utility 映射，shadcn class 如 `bg-primary` 经此生成）。

映射表（shadcn → v3）：

| shadcn token | → v3 | 说明 |
|---|---|---|
| `--primary` / `--primary-foreground` | `--accent` / `--neutral-fg` | default Button 底=主色蓝 |
| `--secondary` / `--secondary-foreground` | `--surface` / `--neutral-fg` | secondary Button 底=面板色 |
| `--destructive` / `--destructive-foreground` | `--danger` / `--neutral-fg` | destructive Button 底=危险红 |
| `--muted-foreground` | `--neutral-mid` | shadcn 次级文字（-foreground 后缀）|
| `--accent-foreground` | `--neutral-fg` | ghost hover 配字 |
| `--background` / `--foreground` | `--bg` / `--neutral-fg` | 画布/主文字 |
| `--popover` / `--popover-foreground` | `--surface` / `--neutral-fg` | 弹层面板 |
| `--input` | `--border` | input 边框 |
| `--ring` | `--accent` | focus ring（主色）|

**已知命名冲突（维持 v3，不覆盖）**：
- `--accent`：v3=主色蓝（强调/品牌，19 处业务代码 + tailwind config 锁定）；shadcn=hover 软底（中性）。语义相反，维持 v3 主色蓝（W01 零回归）。副作用：ghost/outline Button 的 `hover:bg-accent` hover 成主色蓝（既有状态，非本修复引入）。
- `--neutral-mid`：v3=次级文字色（#888890，2026-08-02 V3 纯灰换色后；原 07-26 值 #9ca3af）；shadcn=背景色。维持 v3。副作用：`bg-neutral-mid`（仅 `DropdownMenuSeparator` 1px 分隔线用）渲染为 v3 灰——视觉正确。

两项冲突是 shadcn 命名与 v3 命名的根本不兼容，纯 token 别名无法消除；维持 v3 语义保证 W01 零回归，副作用可接受。若未来要 ghost hover 中性化，需在 button variant 改用 `hover:bg-surface-hover`（改组件，非 token 层）。

## 组件尺寸（composer-bash-execute W3）

| Token | 值 | 用途 |
|-------|-----|------|
| `--bash-output-max-height` | `240px` | BashOutputBlock 输出区最大高度 |
| `--composer-btn-size` | `30px` | Composer 发送/停止按钮尺寸 |
| `--content-max-w` | `720px` | 内容列最大宽（settings 等收窄；v6 新增） |
| `--panel-bg` | `var(--surface)` | panel 内 sticky 浮层底色契约（v6 新增） |
| `--message-stream-pad-top` | `20px` | 消息流顶部留白：MessageStream scrollEl pt 与 TurnMeta sticky 覆盖同源（sticky 用 -mt+pt 同值让浮层背景覆盖 padding 区，挡住滚过来的文字） |
| `--bar-fill-soft` | `55%` | progress-bar fill 柔化档（v6 新增） |

## z-index 层级（2026-08-02 太极·玄新增）

| Token | 值 | 用途 |
|-------|-----|------|
| `--z-sticky` | `1` | 吸顶元素 |
| `--z-popover` | `10` | 弹层 |
| `--z-overlay` | `20` | 覆盖层 |
| `--z-modal` | `1000` | 模态 |
