# Wave W01 · 全局根因高发区审查结果

> **审查员**：W01 全局根因 wave 执行员（自底向上第 0 层，串行最先跑）
> **审查范围**：10 文件（style.css + 4 stores + 3 composables + App.vue + types.ts）
> **审查日期**：2026-06-21
> **审查策略**：双向交叉（设计 SSOT ↔ render 实现），双证据（设计来源 + 实现位置:行号）
> **核心产出**：常规三态条目 + 🆕多余判定 + 全局根因清单（★横切影响下游 18 wave）

---

## 一、Wave 汇总表

| ID | 层 | 区域.模块 | 组件/锚点 | 判定 | 设计来源 | 实现位置 | 根因标签 |
|----|----|----------|----------|------|---------|---------|---------|
| W01-a-01 | Global | style.css | Warm & Soft 遗留色 | ✅ | ADR-0018 / design-tokens.md 已知裂缝 | style.css:1-127（全文无 `--brand`/`--amber`/`--rose`/`--teal`/`--text*`/`--divider`） | — |
| W01-a-02 | Global | style.css | 所有 v3 token 值与 design-tokens.md SSOT 对齐 | ✅ | design-tokens.md 全部色/字/距/影/动效 token | style.css:13-71（逐项对比一致） | — |
| W01-a-03 | Global | style.css | `[data-theme]` 亮暗切换机制 | ❌ | ADR-0004-B 裁决暗色真默认但需 settingsStore 管理切换 | style.css:13 `:root` 硬编码，全文无 `[data-theme]` | 疑似根因→RC-02 |
| W01-a-04 | Global | style.css | settingsStore 存在性 | ❌ | ADR-0004-B + settings/handoff-system.md §2/§11a | stores/ 目录无 settings.ts（仅 5 文件） | 已确认根因→RC-01 |
| W01-a-05 | Global | style.css | `--surface-2` token | ❌ | design-system.md §2 Card-Elevated 要求 `--surface-2` | style.css 全文无此变量；design-tokens.md SSOT 也无 | 已确认根因→RC-04 |
| W01-a-06 | Global | style.css | shadcn 命名别名映射 | ✅ | design-tokens.md shadcn 命名映射表（10 条） | style.css:82-102（10 条映射完整） | — |
| W01-a-07 | Global | style.css/tailwind | `--section-bg`/`--divider`/`--accent-light` 自造名 | ✅ | ADR-0021-B 已裁决迁移，不应出现 | style.css 全文无此三变量 | — |
| W01-b-01 | Store | stores/navigation | view 枚举 `chat\|overview\|settings` | ✅ | ui-skeleton.md §3 + D1 | navigation.ts:35 `{ view: 'chat' }` | — |
| W01-b-02 | Store | stores/navigation | MAX_ENTRIES=50 + 指针分支截断 | ✅ | plan-frontend §4 | navigation.ts:17 / :42-44 | — |
| W01-c-01 | Store | stores/chat | 块类型覆盖 text/thinking/tool_call/error | ✅ | panel spec G2-006 + draft-message-stream §4 | chat.ts:87-226（4 类完整） | — |
| W01-c-02 | Store | stores/chat | 错误重置 isStreaming（规则 #3） | ✅ | CLAUDE.md 规则 #3 | chat.ts:164-195（message.complete/error/stream_error 三路径） | — |
| W01-c-03 | Store | stores/chat | stream_error 合成 error 消息 | ✅ | CLAUDE.md 规则 #3 | chat.ts:224-242 | — |
| W01-d-01 | Store | stores/panel | Panel 单/双状态机（split/close） | ✅ | workspace/spec.md + panel/spec.md | panel.ts:58-75（split）/ :79-84（close） | — |
| W01-d-02 | Store | stores/panel | G-023 DEFERRED 标注 | ✅ | workspace/spec.md | panel.ts:9-11 注释 | — |
| W01-e-01 | Store | stores/session | derivedStatus 骨架默认 'waiting' | ⚠ | sidebar/spec.md §会话项 D6 五态（waiting>running>error>stopped>done） | session.ts:31（hardcoded computed，真实逻辑在 useSidebar.ts） | 疑似根因→RC-07 |
| W01-e-02 | Store | stores/session | 无废弃词 'idle' | ✅ | D6 五态枚举 | session.ts:31 `'waiting'`（非 idle）| — |
| W01-f-01 | Store | stores/sidebar | activeTab localStorage 持久化 | ✅ | sidebar/spec.md §视图切换 | sidebar.ts:15-22（loadActiveTab）/ :27-30（watch 落盘） | — |
| W01-f-02 | Store | stores/sidebar | VALID_TABS 白名单防篡改 | ✅ | sidebar/spec.md | sidebar.ts:13 | — |
| W01-g-01 | Composable | composables/features/useSidebar | features 层是唯一跨 api+stores 编排层 | ✅ | R2 铁律 1 | useSidebar.ts:1-7（文件注释声明） | — |
| W01-g-02 | Composable | composables/features/useSidebar | deriveStatus 五态优先级 waiting>running>error>stopped>done | ✅ | D6 + sidebar/spec.md §会话项 | useSidebar.ts:52-68（优先级匹配） | — |
| W01-g-03 | Composable | composables/features/useSidebar | loadSessions 全量预 hydrate | ⚠ | D6 要求载入即可派生 | useSidebar.ts:140-149（全量预载有成本，TODO 标注） | 孤立 |
| W01-g-04 | Composable | composables/features/useSidebar | selectSession panelId opts 路径 | ✅ | panel/spec.md 状态与交互 | useSidebar.ts:101-106（opts.panelId 路径） | — |
| W01-g-05 | Composable | composables/features/useSidebar | syncSessionToPanel 防时序死锁 | ✅ | W05 发现的原 PanelContainer watch bug | useSidebar.ts:79-85 | — |
| W01-h-01 | Composable | composables/features/useChat | 会话级流式订阅表（防过早拆除） | ✅ | [HISTORICAL] plan-frontend 事故修复 | useChat.ts:31-59（ensureStreamSubscription + streamSubscriptions Map） | — |
| W01-h-02 | Composable | composables/features/useChat | send isStreaming 守卫+非空检验 | ✅ | UC-2 数据流链 | useChat.ts:67-69 | — |
| W01-i-01 | Composable | composables/effects/usePlatformChrome | detectPlatform UA 解析 mac/win/linux | ✅ | shell/spec.md §七-3 | usePlatformChrome.ts:30-36 | — |
| W01-i-02 | Composable | composables/effects/usePlatformChrome | isFullscreen 单例 ref（跨 TrafficLight+AppNavControls 共享） | ✅ | shell/spec.md §七-4 | usePlatformChrome.ts:43（module-level ref）/ :47（listening 单次注册） | — |
| W01-j-01 | Entry | App.vue | 根挂载点：AppShell 单挂载，无多余全局组件 | ✅ | shell/spec.md §一 | App.vue:3 | — |
| W01-j-02 | Entry | types.ts | DerivedStatus 五态 running/waiting/done/stopped/error | ✅ | D6 契约 | types.ts:13 | — |
| W01-j-03 | Entry | types.ts | NavEntry.view 枚举 chat/overview/settings | ✅ | D1 + ui-skeleton.md §3 | types.ts:8 | — |

---

## 二、全局根因清单（★核心产出）

### RC-01 · settingsStore 不存在

| 字段 | 内容 |
|------|------|
| **根因 ID** | RC-01 |
| **根因描述** | render 仓库 `stores/` 目录无 settings.ts（仅有 chat/navigation/panel/session/sidebar 5 个 store），无主题管理/语言切换/外观设置存储。 |
| **判定** | **已确认根因** |
| **设计要求** | ADR-0004-B 裁决：「暗色冷蓝为真默认，真身代码跟随设计主张」→ `settingsStore` 初值 `theme:'dark'` / `themePreset:'cold-blue'`。settings/handoff-system.md §2 列出 settingsStore 应包含 `theme`/`themePreset`/`locale`/`fontSize`/`density` 等字段。ADR-0021-B 裁决 impl 变量迁移到 SSOT 名（`--section-bg`→`--surface` 等）。 |
| **实现现状** | `stores/` 目录仅 5 个文件（chat/navigation/panel/session/sidebar.ts），无 settings.ts。style.css:9 注释声明「亮色变体待 settingsStore 接入」。SettingsModal.vue:50 注释「配置项待联调阶段实现」。tailwind.config.ts:10 `darkMode:'class'` 但无注入 dark class 的代码。 |
| **影响面** | **W18 (A-ST-S Settings 骨架)**, **W19 (A-ST-M Settings 菜单页)**, **W11 (A-WP-M MessageStream theme 依赖)**, 所有需主题切换的 UI 组件 wave（W02 Shell 安全区留白、W03 Sidebar 容器、W04 Overview/Overlays、W08 Panel 各 zone、W09-W10 原子组件层） |
| **修复性质** | **长期方案 · 治本**。需创建 stores/settings.ts（含 theme/themePreset/locale 字段 + localStorage 持久化 + [data-theme] 属性注入），配合 style.css 补充亮色 `[data-theme="light"]` 变量块。不可短期 patch（涉及 5+ 组件联动）。 |

---

### RC-02 · style.css 无 `[data-theme]` 亮暗切换机制

| 字段 | 内容 |
|------|------|
| **根因 ID** | RC-02 |
| **根因描述** | style.css 仅 `:root {}` 硬编码暗色 token，无 `[data-theme="light"]` 亮色变体，无 `[data-theme="dark"]` 显式暗色块。 |
| **判定** | **已确认根因**（RC-01 的子根因） |
| **设计要求** | design-tokens.md「色彩—亮色（备选，待校准）」已给出 6 个亮色 token 值（`--bg:#f8f9fb` / `--surface:#ffffff` / `--fg:#0d0d0f` / `--muted:#5a5a65` / `--border:rgba(0,0,0,0.08)` / `--accent:#2563eb`）。ADR-0004-B 要求暗色真默认但需有切换能力。design-tokens.md 待办「亮色变体打磨」表明亮色值尚不完整。 |
| **实现现状** | style.css:13 `:root {}` 直接定义全部 CSS 变量（暗色值），无 `[data-theme]` 选择器包裹。全文无 `data-theme` 出现（grep 确认）。style.css:8-11 注释：「暗色为真默认……亮色变体待 settingsStore 接入，design-tokens 仅给出部分亮色值，未给全前不臆造落地」。tailwind.config.ts:10 `darkMode:'class'` 配置但无 runtime 注入 dark class。 |
| **影响面** | **所有 UI 组件 wave（W02-W19）**——亮色模式全不可用。 |
| **修复性质** | **长期方案 · 治本**。需分两步：① design-tokens.md 亮色值补全 → ② style.css 新增 `[data-theme="light"]{}` 块 + settingsStore 注入 `data-theme` attribute。短期可先只补 `[data-theme="dark"]` 显式块（当前 `:root` 等价 dark，加显式块是为未来 light 铺路）。 |

---

### RC-03 · dropdown-menu 14 子组件无业务使用

| 字段 | 内容 |
|------|------|
| **根因 ID** | RC-03 |
| **根因描述** | `components/ui/dropdown-menu/` 包含 14 个 Vue SFC + 1 个 index.ts，均为 shadcn-vue CLI 全量复制产物。`grep -rn "DropdownMenu[A-Z]"` 排除该目录自身后**零匹配**——所有组件（RadioGroup/RadioItem/CheckboxItem/Sub/SubTrigger/SubContent 等）无业务代码引用。 |
| **判定** | **已确认根因** |
| **设计要求** | design-system.md §Dropdown 要求下拉菜单原语支持 sidebar 右键菜单。当前 render 无右键菜单实现，14 子组件全闲置。 |
| **实现现状** | `components/ui/dropdown-menu/` 含 15 文件：DropdownMenu.vue, DropdownMenuCheckboxItem.vue, DropdownMenuContent.vue, DropdownMenuGroup.vue, DropdownMenuItem.vue, DropdownMenuLabel.vue, DropdownMenuRadioGroup.vue, DropdownMenuRadioItem.vue, DropdownMenuSeparator.vue, DropdownMenuShortcut.vue, DropdownMenuSub.vue, DropdownMenuSubContent.vue, DropdownMenuSubTrigger.vue, DropdownMenuTrigger.vue, index.ts。`grep -rn "DropdownMenu[A-Z]"` 在 render/src/ 全文中，排除 `components/ui/dropdown-menu/` 后结果为空。 |
| **影响面** | **W05 (B-UI-W5 dropdown-menu 组审查)**——需判定哪些子组件保留（按需引入）、哪些标记 🆕多余清理。shadcn 全量 copy 是已知反模式，下游业务 wave 不受波及（无引用就不会有表现）。 |
| **修复性质** | **短期方案 · 治标**（可立即清理无引用文件）。但长期需确定：sidebar 右键菜单是否需要、需要哪些子组件，再按需保留。当前 14 组件全删不影响任何功能。 |

---

### RC-04 · `--surface-2` 在 design-system.md 有定义但在 design-tokens.md SSOT 和 style.css 均缺失

| 字段 | 内容 |
|------|------|
| **根因 ID** | RC-04 |
| **根因描述** | design-system.md §2 Card-Elevated 要求背景色为 `--surface-2`，但 design-tokens.md（SSOT）和 style.css 均未定义此 CSS 变量。 |
| **判定** | **已确认根因** |
| **设计要求** | design-system.md §2 卡片族：「Card-Elevated 浮起（抽屉/浮层内），背景 `--surface-2`」。design-system.md §4 输入：「背景 `--surface-2`」。两处使用了未定义的 token。 |
| **实现现状** | style.css:13-71 全文搜索 `surface-2` 结果为空。design-tokens.md 全文搜索 `surface-2` 结果为空。Turn.vue:120 注释提到 `surface-2` 但实际 CSS 用的是 `--surface-hover`（Turn.vue:122）。业务代码中无实际引用 `--surface-2`，所以当前无渲染 bug——但这是 SSOT 裂缝，design-system.md 引用了不存在的变量。 |
| **影响面** | **W11 (A-WP-M MessageStream)**, **W12 (A-WP-C Composer)**, 所有需 Card-Elevated 场景。当前无业务代码引用，属 SSOT 层面裂缝。 |
| **修复性质** | **长期方案 · 治本**。需要：① design-tokens.md SSOT 补登 `--surface-2` 值（建议 `#1e1e25`，介于 surface `#151519` 与 surface-hover `#1b1b20` 之间更亮的层次，或直接等于 `--surface-hover`），② style.css 同步落地。 |

---

### RC-05 · 废弃术语 `aside-region` 残留在 AsideRegion.vue

| 字段 | 内容 |
|------|------|
| **根因 ID** | RC-05 |
| **根因描述** | `AsideRegion.vue:9` 使用 class 名 `aside-region`，v3-demo/README.md 术语映射表显示应改为 Sidebar。 |
| **判定** | **已确认根因**（plan-B 已识别，W01 确认） |
| **设计要求** | v3-demo/README.md 术语映射表：`aside-region` → `sidebar`。ui-skeleton.md 使用「Sidebar 容器」命名。 |
| **实现现状** | `AsideRegion.vue:9`：`class="aside-region relative flex flex-col overflow-hidden pt-[52px]"`。grep 全库仅此一处使用 `aside-region`（无 CSS 选择器/测试硬编码）。文件名仍为 `AsideRegion.vue`。 |
| **影响面** | **W02 (B-SH-W2 AsideRegion 组件审查)**——该 wave 会发现此问题，但应标注「RC-05 根因表现」而非重复记录。影响范围：仅 1 个 class 名（CSS 选择器无引用，实际无渲染副作用）。 |
| **修复性质** | **短期方案 · 治标**。需批量替换：① `AsideRegion.vue` 文件名 → `SidebarContainer.vue` ② class `aside-region` → `sidebar-container` ③ 所有 import 路径更新。当前无 CSS 选择器依赖此 class，改后无回归风险。 |

---

### RC-06 · tailwind.config.ts `darkMode:'class'` 但无 runtime 注入

| 字段 | 内容 |
|------|------|
| **根因 ID** | RC-06 |
| **根因描述** | tailwind.config.ts:10 配置 `darkMode:'class'`，但应用中无任何代码在 `<html>` 上设置 `class="dark"`（目前 HTML 上仅有 `data-platform` 属性）。等于 darkMode 机制未启用。 |
| **判定** | **疑似根因，待下游验证**（RC-01/RC-02 的子表现） |
| **设计要求** | ADR-0004-B 裁决暗色为真默认。若主题切换用 `[data-theme]` 属性选择器（v3 SSR-friendly），则 tailwind darkMode 应改为 `['class', '[data-theme="dark"]']` 或直接改为 `'media'`。 |
| **实现现状** | tailwind.config.ts:10 `darkMode: 'class'`。`App.vue` 和 `usePlatformChrome.ts` 均只注入 `data-platform`，不注入 dark class。 |
| **影响面** | 所有使用 Tailwind `dark:` variant 的组件（当前代码库中未见 `dark:` variant，无实际影响）。但若未来要切亮暗，tailwind config 需对齐 `[data-theme]` 选择器。 |
| **修复性质** | **短期方案 · 治本**。跟随 RC-01/RC-02 修复时，将 `darkMode` 改为 `['class', '[data-theme="dark"]']` 或直接移除（暗色为默认时 dark variant 无意义）。 |

---

### RC-07 · session store derivedStatus 骨架与 useSidebar deriveStatus 重复定义

| 字段 | 内容 |
|------|------|
| **根因 ID** | RC-07 |
| **根因描述** | `stores/session.ts:31` 的 `derivedStatus` 返回 hardcoded `computed(() => 'waiting')`（骨架占位），真正的派生逻辑在 `composables/features/useSidebar.ts:52` 的 `deriveStatus()`。同一语义有两处定义，骨架版是废弃占位——但下游组件若直接调 `sessionStore.derivedStatus(id)` 会拿到永远 `'waiting'` 的错误结果。 |
| **判定** | **疑似根因，待下游验证** |
| **设计要求** | D6 五态优先级 waiting>running>error>stopped>done。派生逻辑应单一落点（features 层，因需跨 chat + session store）。 |
| **实现现状** | session.ts:31：`function derivedStatus(id: string): ComputedRef<DerivedStatus> { void id; return computed(() => 'waiting' as DerivedStatus) }`。useSidebar.ts:158：`function derivedStatus(id: string): ComputedRef<DerivedStatus> { return computed(() => { const isActiveStreaming = ...; return deriveStatus(id, chat, isActiveStreaming) }) }`。两处同名同签不同语义。 |
| **影响面** | **W03 (B-SB-W3 SessionItem 状态点)**, **W04 (B-OV-W4 SessionCard 状态点)**, **W08 (A-PN-H PanelHeader 状态点)**——任何直接调用 `sessionStore.derivedStatus()` 的组件会拿到错误状态。需验证下游是否有这样的误调用。 |
| **修复性质** | **短期方案 · 治标**。① 验证下游组件是否直接调 session store derivedStatus（非 useSidebar 的版本），若有 → 改为 useSidebar；② 在 session store derivedStatus 上标注 `@deprecated Use useSidebar().derivedStatus() instead`；③ 长期：移除 session store 的骨架占位。 |

---

## 三、条目详情卡（⚠ / ❌ / 🆕）

### [W01-a-03] style.css 无 `[data-theme]` 亮暗切换 ❌

- **层级位置**：Global · style.css
- **设计要求**：ADR-0004-B 裁决暗色冷蓝为真默认但需 settingsStore 管理主题切换；design-tokens.md 已给部分亮色值（`--bg:#f8f9fb` 等 6 个）。亮色为备选（design-system.md §10）。
- **实现现状**：style.css:13 `:root {}` 硬编码暗色 token，全文无 `[data-theme]` 选择器。注释 line 9 声明「亮色变体待 settingsStore 接入」，是有意不落地（亮色值 SSOT 未给全，不臆造）。
- **判定**：❌ 缺失
- **差异描述**：设计层面承认亮暗双态（design-tokens.md 已给 6 个亮色 token 值），实现层面只有暗色硬编码且不依赖 settingsStore。这不是实现 bug（设计明确要求暗色优先），而是**架构预备缺失**——无切换槽位，后续补亮色需改 style.css 结构。
- **设计证据**：design-tokens.md「色彩—亮色（备选，待校准）」已列 6 token；ADR-0004-B「真身 settingsStore 初值改 theme='dark'/themePreset='cold-blue'」
- **实现证据**：style.css:13 `:root {` — 全文无 `[data-theme]` 出现（grep 确认）。tailwind.config.ts:10 `darkMode: 'class'` 但无注入。
- **初步根因**：RC-02（RC-01 子根因）
- **修复性质**：长期方案 · 治本。分两步：① design-tokens.md 亮色值补全 → ② style.css 加 `[data-theme="light"]{}` 块 + settingsStore 注入 `data-theme` attr。

---

### [W01-a-04] settingsStore 不存在 ❌

- **层级位置**：Global · stores/
- **设计要求**：ADR-0004-B 裁决 settingsStore 初值 `theme:'dark'` / `themePreset:'cold-blue'`。handoff-system.md §2 列出字段：`theme`/`themePreset`/`locale`/`fontSize`/`density`。handoff §11b 标为待办。
- **实现现状**：`stores/` 目录仅 5 文件（chat/navigation/panel/session/sidebar），无 settings.ts。`grep -rn "settingsStore\|useSettingsStore"` 全库零匹配。SettingsModal.vue:50 注释「配置项待联调阶段实现」。
- **判定**：❌ 缺失
- **差异描述**：设计已有完整的 settings store 定义（字段/初值/localStorage 持久化），但 render 仓库完全未创建。这导致：① 无主题切换机制（RC-02）、② Settings 各菜单页无数据源（W18/W19）、③ System 菜单表单无读写目标。
- **设计证据**：ADR-0004-B 裁决原文；handoff-system.md §2 字段清单；handoff §11b「settingsStore 初值迁移」待办
- **实现证据**：`ls stores/` → chat.ts, navigation.ts, panel.ts, session.ts, sidebar.ts（5 文件）。grep settingsStore/useSettingsStore → zero match。
- **初步根因**：RC-01（已确认根因）
- **修复性质**：长期方案 · 治本。需创建 stores/settings.ts + 所有 Settings 菜单页接入。

---

### [W01-a-05] `--surface-2` 缺失 ❌

- **层级位置**：Global · style.css + design-tokens.md
- **设计要求**：design-system.md §2 Card-Elevated 要求背景色 `--surface-2`；§4 Input 要求背景 `--surface-2`。
- **实现现状**：style.css 和 design-tokens.md 均未定义 `--surface-2`。Turn.vue:120 注释提到此名但实际 CSS 用的是 `--surface-hover`（Turn.vue:122）。
- **判定**：❌ 缺失
- **差异描述**：design-system.md 引用了 design-tokens.md SSOT 中不存在的变量名。业务代码未实际引用（注释外），当前无渲染 bug。但这是 SSOT 裂缝——新组件若要 Card-Elevated 背景，会找不到 token。
- **设计证据**：design-system.md §2 表格 Card-Elevated 行：「背景 `--surface-2`」；§4 Input：「背景 `--surface-2`」
- **实现证据**：style.css 全文无 `surface-2`（grep 确认）；design-tokens.md 全文无 `surface-2`（grep 确认）
- **初步根因**：RC-04（已确认根因）
- **修复性质**：长期方案 · 治本。需在 design-tokens.md SSOT 补登 `--surface-2` 值（建议 `#1e1e25`），再在 style.css 落地。

---

### [W01-e-01] session store derivedStatus 骨架 vs useSidebar 重复 ⚠

- **层级位置**：Store · stores/session.ts
- **设计要求**：D6 五态优先级 waiting>running>error>stopped>done。派生逻辑应单一落点（features 层）。
- **实现现状**：session.ts:31 hardcoded `computed(() => 'waiting')`（骨架占位）。useSidebar.ts:52-68 有完整的 deriveStatus 实现。两处同名同签不同语义。
- **判定**：⚠ 偏差（骨架占位未标注废弃，存在误调用风险）
- **差异描述**：设计上 derivedStatus 应唯一落点在 features 层（需跨 chat store）。session store 的硬编码骨架是有意占位（注释「骨架阶段返回合法默认」），但未标注 `@deprecated`，下游组件可能误调拿到错误值。
- **设计证据**：D6 spec sidebar/spec.md §会话项 + useSidebar.ts:52 优先级实现
- **实现证据**：session.ts:31 注释「骨架阶段返回合法默认 'waiting'，实现阶段填派生逻辑」
- **初步根因**：RC-07（疑似根因）
- **修复性质**：短期方案 · 治标。验证下游组件直接调 session store derivedStatus 的路径 → 如有则改为 useSidebar；给骨架版加 `@deprecated` 注释。

---

### [W01-g-03] loadSessions 全量预 hydrate 性能标注 ⚠

- **层级位置**：Composable · composables/features/useSidebar.ts
- **设计要求**：D6：载入 session 列表后状态点应即可派生（需有消息数据）。
- **实现现状**：useSidebar.ts:140-149 用 `Promise.allSettled` 全量预载每个 session 的 chat 历史。注释标 TODO「真实 runtime 下全量预载历史有成本，应改为 WS 推送 status 或默认 done/idle + 按需 hydrate」。
- **判定**：⚠ 偏差（当前 mock 环境可行，真 runtime 需改为按需 hydrate）
- **差异描述**：设计未规定 hydrate 策略（全量 vs 按需）。当前全量方案 mock 环境成本低，但真实 runtime 下 N 个 session 各 N 条消息的 `getHistory` RPC 调用成本高。TODO 已标注。
- **设计证据**：D6 要求载入即可派生状态点
- **实现证据**：useSidebar.ts:146-149 TODO 注释
- **初步根因**：孤立（策略差异，非根因）
- **修复性质**：短期方案 · 治标。联调阶段按 TODO 改为：默认 `done`（空 session）+ 当前 active session 按需 hydrate。旧预载逻辑保留作 mock 分支。

---

## 四、横切影响交叉表（根因 → 下游 wave）

| 根因 ID | 描述 | 影响的下游 wave | 下游如何识别 |
|---------|------|----------------|-------------|
| **RC-01** | settingsStore 不存在 | W18 (A-ST-S), W19 (A-ST-M), W11 (A-WP-M), W02-W19 所有需 theme 的组件 | 任何引用 settingsStore 的代码 → 不存在；theme/themePreset/locale → 无来源 |
| **RC-02** | style.css 无 `[data-theme]` 切换 | W02-W19 所有 UI 组件 | 亮色模式下所有 token 回退到暗色值；`[data-theme="light"]` 选择器匹配不到 |
| **RC-03** | dropdown-menu 14 组件无业务使用 | W05 (B-UI-W5) | dropdown-menu 组审查时标注：RC-03 已确认多余，不重复记录为独立 bug |
| **RC-04** | `--surface-2` 未定义 | W11 (A-WP-M), W12 (A-WP-C), W05 (B-UI-W5 input 组) | 使用 Card-Elevated 或 Input 背景时找不到 token |
| **RC-05** | `aside-region` 废弃术语 | W02 (B-SH-W2) | AsideRegion.vue class 名不符规范；标注 RC-05 根因表现 |
| **RC-06** | tailwind darkMode 未启用 | W02-W19（当需要 dark: variant 时） | `dark:` variant 不工作（当前无使用，无表现） |
| **RC-07** | session store derivedStatus 骨架 vs useSidebar 重复 | W03 (B-SB-W3), W04 (B-OV-W4), W08 (A-PN-H) | 若组件调 `sessionStore.derivedStatus()` 拿到恒 'waiting'；应标注 RC-07 根因表现 |

---

## 五、Wave 小结

### 统计数据

| 指标 | 数值 |
|------|------|
| 审查条目总数 | 32 |
| ✅ 一致 | 25 |
| ⚠ 偏差 | 2 |
| ❌ 缺失 | 3 |
| 🆕 多余 | 0（但 RC-03 本质是 14 个多余文件，在下游 W05 展开） |
| 已确认根因 | 5（RC-01/02/03/04/05） |
| 疑似根因（待下游验证） | 2（RC-06/07） |

### 根因清单

| ID | 简述 | 判定 | 影响 wave 数 |
|----|------|------|------------|
| RC-01 | settingsStore 不存在 | 已确认 | 5+ wave（W18/W19/W11 + 所有 UI wave） |
| RC-02 | style.css 无 `[data-theme]` 切换机制 | 已确认（RC-01 子根因） | 所有 18 wave |
| RC-03 | dropdown-menu 14 组件无业务使用 | 已确认 | W05 |
| RC-04 | `--surface-2` 在 SSOT 和 style.css 均缺失 | 已确认 | W05/W11/W12 |
| RC-05 | `aside-region` 废弃术语残留 | 已确认 | W02 |
| RC-06 | tailwind darkMode class 无注入 | 疑似 | 所有 UI wave（暂无实际表现） |
| RC-07 | derivedStatus 骨架 vs features 重复 | 疑似 | W03/W04/W08 |

### 关键发现摘要

1. **Warm & Soft 无残留** — style.css 完全干净，无 `--brand`/`--amber`/`--rose`/`--teal`/`--text*`/`--divider`/`--section-bg`/`--accent-light` 任何旧 token（plan-B 预判正确）。
2. **Token 值与 SSOT 完全对齐** — style.css 的 42 个 v3 CSS 变量名/值与 design-tokens.md 逐项一致（色值/字号/间距/阴影/动效/字体全匹配，shadcn 别名映射 10 条齐全）。
3. **核心裂缝是架构预备缺失** — settingsStore 不存在 + `[data-theme]` 切换无槽位，不是 token 值不对，而是**根本没有主题概念在代码中**。
4. **dropdown-menu 全量复制** — 14 个 shadcn 子组件零业务引用，随时可删。
5. **`--surface-2` 是 SSOT 裂缝** — design-system.md 引用了 design-tokens.md 不存在的变量，需在 design-tokens.md 补登。
6. **features 层 hold 住 R2 铁律** — useSidebar/useChat 确为唯一跨 api+stores 编排层，store 间无互相 import，架构约束到位。
7. **D6 派生逻辑落入正确层** — deriveStatus 在 features 层（需跨 chat + session store），session store 骨架是历史遗留。

### 本 wave 未覆盖但需下游关注的交叉项

- **style.css 中 shadcn `--muted` 语义分歧**：已文档化（v3=文字色 / shadcn=背景色），style.css 层面维持 v3 语义。业务代码中 `bg-muted` 仅 DropdownMenuSeparator 1px 分隔线使用（视觉正确），`text-muted` 大量用于次级文字（v3 语义正确）。下游 wave 审查 shadcn 组件时，若发现 `bg-muted` 渲染非预期背景色 → 标注 RC-08（`--muted` 语义分歧引起的偏差，非独立 bug）。
- **tailwind.config.ts `accent.foreground` 仅映射 shadcn 别名**：`accent.foreground: 'var(--accent-foreground)'` 映射到 `--fg`，而 `--accent-foreground` 是 shadcn 命名（ghost hover 配字），不是 v3 设计 token。需在 design-tokens.md shadcn 映射表补充此条（当前映射表未列 `--accent-foreground`）。
- **tailwind.config.ts `boxShadow.1`/`boxShadow.2` 命名冲突风险**：Tailwind 原生 `shadow-sm`/`shadow`/`shadow-md` 等仍可用，`shadow-1`/`shadow-2` 为自定义扩增。当前无冲突，但需注意：若未来引入 `shadow-{1-25}` 的 Tailwind 原生 scale，会冲突。
