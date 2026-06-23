# Handoff · settings · System

> System 菜单 · 左导航第 5 项 · settings modal 内的「应用偏好」。
> 真身三块：语言与外观 / 聊天显示 / 配色主题；★draft 按决议移除「聊天显示」整块（4 字段），**draft 仅两块**（见 §11a）。**全枚举与开关，无强校验、无空态、无实体列表**——5 菜单里最简单的一个。
> 字段、默认值、布局、交互全部**对齐真实实现**（`~/Code/xyz-agent-workspace/main`）：
> `components/settings/SystemPane.vue` + `stores/settings.ts` + `shared/settings.ts`（`ThemeMode`/`ThemePreset` 类型）+ `lib/message-layout`（`ALL_PI_TOOLS`）+ `i18n`（`setLocale`/`getLocale`）。

## 1. 定位

- 主用模式：**B · Setting Card**（真身三块 / draft 两块）+ **A · Setting Row**（每设置项）。**不用 C**（无实体列表）。
- 与其他菜单分工：Provider/Skill/Extension/Agent 是「配置实体」，System 是「配置应用自身」——语言、外观、配色、消息展示。最轻量。

## 2. 数据模型（字段 + 默认值 + 类型，全部来自 settingsStore / shared）

```
// shared/src/settings.ts — 类型源头
type ThemeMode   = 'light' | 'dark' | 'system'
type ThemePreset = 'warm-teal'|'cold-teal'|'neutral'|'sharp'|'warm-neutral'  // Muted 组
                | 'terracotta'|'rose'|'amber'|'blue'|'violet'                 // Colorful 组

// settingsStore — 字段 + 默认值（ref 初值即默认）
locale:              string      = 'zh-CN'        // 'zh-CN' | 'en-US'（UI 仅这 2 项）
theme:               ThemeMode   = 'light'        // ★默认亮色，非暗色
themePreset:         ThemePreset = 'neutral'      // ★默认 Neutral（Muted 组）
autoExpandThinking:  bool        = true           // 自动展开 Thinking 内容
autoExpandToolCalls: bool        = true           // 自动展开 ToolCall 输入/输出
compactStreaming:    bool        = false          // 折叠 Agent 操作过程（Thinking/ToolCall→摘要标签）
standaloneTools:     string[]    = ['write','edit']  // ★两默认工具；compactStreaming 开启时生效
```

**store 里还有但本菜单不暴露的字段**（属别处）：`defaultModel`、`currentThinkingLevel`、`panelGridVisible`、`inspectorOpen`、`inspectorSide`。System 不动这些。

## 3. 主题应用机制（★draft 必须照此切色，不是静态 --accent）

配色不是改一个 CSS 变量，而是**改 `<html>` 上的两个属性**，由属性选择器驱动整套 token：

- `html[data-theme="light" | "dark"]` — `theme='system'` 时用 `matchMedia('(prefers-color-scheme: dark)')` 解析成 light/dark。
- `html[data-palette="<preset>"]` — preset 名直接做属性值。

调用点：
- 外观模式 select → `settingsStore.applyTheme()`：写 `data-theme` + `data-palette` + localStorage。
- palette swatch → `settingsStore.setThemePreset(id)`：仅写 `data-palette` + localStorage（不改 theme）。

**draft 实现要点**：定义 `html[data-palette="terracotta"]{ --accent: …; --accent-light: … }` 等规则块；切换时 JS 只改属性，CSS 自动重算。莫在 JS 里逐变量赋值。

## 4. 持久化（双重，有原因）

- **pinia persist**：key `xyz-settings`，pick：`theme, themePreset, locale, defaultModel, autoExpandThinking, autoExpandToolCalls, compactStreaming, standaloneTools`。
- **applyTheme() 额外直写** `localStorage['xyz-agent-theme']` + `['xyz-agent-palette']`。
  原因：主题必须在 **pinia hydrate 之前**就 apply（否则首帧闪烁），故走独立 localStorage 通道。draft 若做首屏无闪烁，照此双写。

**旧值迁移**（`migratePalette`，applyTheme 内）：`'warm' → 'warm-teal'`、`'claude' → 'terracotta'`。迁移后回写 store，老用户无感升级。draft 不必演示迁移，但要知道 preset 值域历史上有过别名。

## 5. 布局（真实结构，逐节）

容器 `max-w-[860px]`。三块 Card 顺序固定（**语言与外观 → 聊天显示 → 配色主题**），每块 `border + rounded-sm + mb-3`。

**卡 1「语言与外观」**（2 行 Setting Row，label 左 `min-w-76px` + 控件右 `max-w-200px`）：
- 语言 select（硬编码选项 `简体中文 / English (US)`，**不经 i18n**——语言名永远用母语显示）。
- 外观模式 select（选项 label 走 i18n：`themeLight/themeDark/themeSystem`）。

**卡 2「聊天显示」**（★draft 决议：本块从 draft 移除，真身保留；3 开关 + 条件子区）：
- 展开思考过程 / 展开工具调用 / 折叠 Agent 操作过程。每行 = 主 label（`text-xs`）+ 行内 hint（`text-[10px] muted`）+ 右 Toggle。
- `compactStreaming === true` 时，**同卡内**追加「独立展示工具」子区（不是独立卡）：标题行 + 工具网格（`flex-wrap`，每项 = 小 Toggle + mono 工具名，`text-[11px] muted`），遍历 `ALL_PI_TOOLS`。
- `compactStreaming === false` → 子区整体不渲染。

**卡 3「配色主题」**（2 组 swatch）：
- 组标题 `text-[11px] uppercase tracking-[0.05em] muted`：「Muted」「Colorful」。
- swatch = Button(ghost) `py-1.5 px-3 rounded-sm border`：左 `w-4 h-4 rounded-full` 色块（inline style background=oklch）+ 右 label。
- 选中态：`border-[--accent] bg-[--accent-light] ring-1 ring-[--accent]`；未选：`border-border bg-surface`，hover `bg-[--accent-light]`。

## 6. 配色主题 · palette 精确值（真身 10 + draft 新增 cold-blue）

| 组 | preset | label | swatch (oklch) |
|---|---|---|---|
| Muted | `warm-teal` | Warm Teal | `oklch(55% 0.08 195)` |
| Muted | `cold-teal` | Cold Teal | `oklch(62% 0.10 190)` |
| Muted | `neutral` | Neutral | `oklch(40% 0 0)` |
| Muted | `sharp` | Sharp | `oklch(10% 0 0)` |
| Muted | `warm-neutral` | Warm Neutral | `oklch(45% 0.04 80)` |
| Colorful | `cold-blue` | Cold Blue · 品牌 ★draft 新增默认 | `#4f8ef7`（design-tokens.md 主色） |
| Colorful | `terracotta` | Terracotta | `oklch(64% 0.13 28)` |
| Colorful | `rose` | Rose | `oklch(65% 0.14 350)` |
| Colorful | `amber` | Amber | `oklch(67% 0.15 65)` |
| Colorful | `blue` | Blue | `oklch(62% 0.15 250)` |
| Colorful | `violet` | Violet | `oklch(62% 0.15 280)` |

label 现状为**英文**（impl 未本地化）。draft 可中英对照或保留英文，二选一需统一。

## 7. 关键交互

- **语言**：select 改 → `setLocale(locale)`（i18n 即时切换，i18n 自带持久化）+ 同步 `settingsStore.locale`。**不需重开 modal**，整窗文案即时变。
- **外观模式**：light/dark/system → `applyTheme()`（system 跟随 `prefers-color-scheme`）。
- **配色主题**：点 swatch → `setThemePreset(id)`（不改 theme，只换 palette）。
- **聊天显示联动**（★draft 移除，真身保留）：`compactStreaming` off → 「独立展示工具」子区消失；on → 显 `ALL_PI_TOOLS` 网格，逐个 Toggle 增删 `standaloneTools`（push/splice）。
- **自动保存**：改任意控件 → 触发 settings-shell 的公共 pill（debounce 800ms，无 Save 按钮）。本菜单无独立保存逻辑。

## 8. 校验

无强校验（全枚举/开关/已知工具名）。select / toggle 即时生效 + 自动保存 pill。无需 FormMessage、无需 toast。

## 9. 状态枚举

无空态、无加载态。仅 settings-shell 公共的「已保存 / 保存中」。

## 10. ⚠ 与 settings-shell draft 的漂移（需对齐）

`draft-settings-shell.html` 的 System 占位 panel 画的是「主题(暗/亮/跟随) + 字号(紧凑/舒适/宽松) + 关于(版本/检查更新)」——这与真实 SystemPane **不符**：

- 真实是「**语言** + 外观模式 + 聊天显示 + 配色主题」，**没有字号档、没有关于区**。
- shell draft 的「主题」select 三态 ≈ 真实「外观模式」，但丢了语言。

**决议**：System per-menu draft 以本 handoff（真实实现）为准，**不沿用 shell 占位区的字号/关于**。字号缩放若要做，归到 §11 待裁决。

## 11. 决议记录（已执行 + 待裁决）

### 11a. 已执行 draft 决议（2026-06-19）

- ① **draft 默认 palette = cold-blue**（品牌主色 `#4f8ef7`，design-tokens.md 定义）。真身代码默认仍 `'neutral'`，draft 演示态置 cold-blue，使预览直接呈现项目实际主色冷蓝。真身若要跟随：新增 `cold-blue` 到 `SystemPane.vue` `palettes[]` + 改 `settings.ts` 初值。
- ② **「聊天显示」整块从 draft 移除**（`autoExpandThinking` / `autoExpandToolCalls` / `compactStreaming` / `standaloneTools` 四字段）。真身 `SystemPane.vue` 仍保留（见 §2 字段表 / §5 卡 2 / §7 联动的真身描述），draft 不展示、不验收。决议原因：v3 System 首要呈现主题/配色机制，聊天显示属消息流展示范畴，归 panel draft（`draft-message-stream.html` 等）。

### 11b. 待裁决 / 待落地决议

**▶ 已裁决待落地（ADR-0021-B，2026-06-20）** — 真身代码迁移，非 draft 改动：

- `settingsStore` 初值：`theme='light'` → `'dark'`、`themePreset='neutral'` → `'cold-blue'`；`SystemPane.vue` `palettes[]` 新增 `cold-blue`。
- CSS 变量迁移：`--section-bg`→`--surface`、`--divider`→`--border`、`--accent-light`→`--accent-soft`（见 §13）。
- 注：§2/§5/§12 如实记录真身**当前**仍为 light/neutral，迁移后同步更新本 handoff。

**▶ v3 范围待用户拍板**（原 open question）：

- **关于区（版本 / 检查更新）**：**倾向新增**，最小化。版本号 + 「检查更新」按钮，落 settingsStore 或独立 aboutStore。成本低、shell draft 已铺垫、属于「应用自身」语义。**需用户确认是否本稿就加。**
- **快捷键区（capture 模式）**：**倾向先不做可编辑版**。capture + 冲突检测 + reset-to-default 是独立工作量，非 v3 首要。若要做，先以**只读列表**呈现现有快捷键（⌘, / ⌘K / Esc / ←→），可编辑 capture 留后续。
- **字号档**（shell 占位区遗留）：**倾向不做**，除非用户明确要字体缩放设置。真实 impl 无此字段。

> 三项均为「v3 是否超出真实 impl 新增」的决策点，默认**以真实 impl 为准（不新增）**，除非用户拍板加。

## 12. 验收 P0

- [ ] 语言 select 即时切 i18n，不重开 modal（zh-CN / en-US 两项，母语显示）
- [ ] 外观模式三态（light/dark/system）经 `data-theme` 属性正确 apply；system 跟随 prefers-color-scheme
- [ ] 配色主题 11 swatch（Muted 5 + Colorful 6，含 draft 新增 cold-blue 品牌默认），oklch/hex 色块 + label，选中态 `accent ring + accent-light 底` 清晰
- [ ] palette 切换经 `data-palette` 属性驱动，非 JS 逐变量赋值
- [ ] ★draft 决议：「聊天显示」整块不进 draft 验收（compactStreaming/standaloneTools 等真身保留，draft 不展示）
- [ ] 默认值正确：theme=light / themePreset=neutral（★draft 演示态 preset=cold-blue）— 真身当前值；ADR-0021-B 裁决真身待迁移到 dark/cold-blue，迁移后此验收点同步更新
- [ ] 无字号档、无关于区漂移（除非 §11b 决议新增）

## 13. token 命名裂缝（✅ 已裁决 ADR-0021-B/选项②）

impl 自造的 `--section-bg` / `--divider` / `--accent-light` 迁移到 design-tokens.md SSOT 已有名，**不补进 tokens**（避免同语义双名）：

| impl 现名 | → SSOT 名 |
|---|---|
| `--section-bg` | `--surface` |
| `--divider` | `--border` |
| `--accent-light` | `--accent-soft` |

draft 已用 SSOT 名（无需改）；真身 CSS 待迁移。**禁止各 draft 自造第三套。**

## 14. 参考

- 真实 impl：`components/settings/SystemPane.vue` / `stores/settings.ts` / `shared/src/settings.ts`（类型）/ `lib/message-layout`（`ALL_PI_TOOLS`）/ `i18n`（`setLocale`/`getLocale`/`Locale`）
- 对齐：`docs/page-design/design-system.md`（Card / Setting Row 原语）/ `docs/page-design/design-tokens.md`（token，见 §13 裂缝）/ `settings/spec.md`（modal 骨架 + 三模式 + 自动保存横切）
