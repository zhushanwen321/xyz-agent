# v6 设置页补全 · 设计上下文（6 页共用基准）

> 日期：2026-08-01 · 用途：代理/终端/预设/工作区/更新/系统 6 个设置页的实现基准，worker 与 reviewer 共用。
> 权威链：`../v6-design.md`（决策 SSOT）> `../v6-summary.md`（设计总览索引）> `../v6-spec-settings-shell.html`（设置外壳规格）> 本文件（demo 实现层约定）。

## 0. 一句话定位

v6 demo（`docs/page-design/v6/`）是**视觉规格的交互验证层**：刻意用原生 CSS + tokens + 迷你组件，不绑 Tailwind/xyz-ui（真实实施按 v6-design.md 阶段 C 映射到项目技术栈）。因此**一切视觉值必须逐字用 token 变量**，禁止硬编码颜色/间距/圆角，禁止自创组件样式。

## 1. 设计目标（不可变）

- **五原则**：层级代替边框 / 圆角升档 / 正文提亮 / 内容收窄 / 彩色降噪
- **设置页形态（v6-design §4.5）**：全屏覆盖（无遮罩无模糊）；左 nav 220px `bg-sunken`；右内容区底色 **`--bg`**（非 surface——卡片才能浮起），内容列 `max-width: var(--content-max-w)` 720px，页面标题作为内容块顶部（左对齐，非固定栏）
- **impeccable 禁令**：禁 >1px 彩色侧边条；禁嵌套卡片；禁 uppercase tracking 装饰；禁 emoji；禁无意义渐变；禁硬编码视觉值
- **对比度**：正文位置全过 WCAG AA（正文用 `--neutral-fg`/`--neutral-mid`；装饰位才用 `--neutral-dim`/`--neutral-faint`）

## 2. Token 真值（逐字使用，禁止硬编码）

完整值见 `src/styles/tokens.css`（与 `../v6-spec-base.css` :17-113 逐字对齐）。关键：

```css
/* 背景层级 */
--bg: #1a1b1f;  --surface: #272830;  --surface-hover: #363740;
--surface-2: #2e2f38;  --bg-elevated: #313239;  --bg-input: #1e1f24;
--bg-sunken: var(--bg);  --bg-card: #22242c;
/* 文字 */
--neutral-fg: #e5e7eb;  --neutral-mid: #9ca3af;  --neutral-dim: #7d8494;
--neutral-faint: #4b5563;  --neutral-ico: #8b8d94;
/* 边框（静态容器不叠加） */
--border: rgba(255,255,255,0.08);  --border-strong: rgba(255,255,255,0.15);
/* 主色/状态 */
--accent: #4f8ef7;  --accent-hover: #6ba3ff;  --accent-soft: color-mix(in oklch, var(--accent) 12%, transparent);
--accent-ring: rgba(79,142,247,0.30);
--success: #22c55e;  --warn: #b08a3e;  --danger: #ef4444;  --info: #38bdf8;  --reasoning: #a78bfa;
--success-soft / --warn-soft / --danger-soft / --info-soft / --reasoning-soft: color-mix 12~14%;
/* 字号：10/11/12/13/14px = 2xs/xs/sm/base/md；圆角：sm 6px / radius 8px / lg 12px */
/* 间距 4px 栅格：space-1..4,6,8,12,16；动效 --ease + duration-fast 120ms / duration 200ms */
/* z：sticky 1 / popover 10 / overlay 20 / modal 1000 */
```

## 3. 公共件 API（已有，直接消费，禁止修改）

### 3.1 `.btn`（base.css SSOT，4 变体 × 尺寸）

| 类 | 用途 |
|---|---|
| `btn btn-default` | Primary（bg-accent 白字），添加/保存/确认类 |
| `btn btn-secondary` | 次级（透明 + border），次要操作 |
| `btn btn-ghost` | 幽灵（透明），行内操作/折叠 |
| `btn btn-danger` | 危险（红字，hover danger-soft），删除/放弃 |

尺寸：`btn-sm`(h36) / `btn-md`(h32 过渡兼容) / **`btn-dense`(h32，新代码首选)** / `btn-icon`(40×40) / `btn-icon-sm`(28×28)。
`.btn svg` 自动 16×16；`:disabled` opacity .5 + pointer-events none；`:focus-visible` accent 双环。**按钮内 icon 必须内联 SVG（stroke-width 1.75，lucide 路径语义）**。

### 3.2 `UiInput`（`src/components/settings/UiInput.vue`）

Props: `modelValue? / placeholder? / type? / mono? / dense? / error?`；emit `update:modelValue`。
- 高度：默认 40px，`dense` 32px/12px
- focus：inset 单环 `0 0 0 1px var(--accent-ring) inset`（已内置，无需额外样式）

### 3.3 `UiSwitch`（`UiSwitch.vue`）

Props: `checked / disabled? / ariaLabel?`；emit `update:checked`。36×20，无 hover 变色（spec §6.4），focus 双环内置。

### 3.4 `SettingRow`（`SettingRow.vue`）

设置行范式：`label` + 可选 `desc`（12px neutral-mid，**每行必带 desc**——v6-design §4.5）+ 右侧 slot 放 control。行间 hairline `color-mix(in oklch, var(--border) 50%, transparent)`。**所有「label + 控件」的设置项必须用 SettingRow**，不手写行结构。

### 3.5 `GroupCard`（`GroupCard.vue`）

分组卡片：`bg-card` + 10px 圆角 + 去 border；`group-head` 用 `bg-surface-2` 浮起分层（10px 16px + 顶部 hairline）。Props: `title? / collapsible?`；slots: `head / actions / 默认`。
**页面内容必须按语义分组进 GroupCard**（卡片间 gap `--space-4`），禁止裸行堆叠。

### 3.6 `SettingsOverlay`（接线层，worker 禁改）

左 nav 10 项 + 右内容区。当前 `settingsPage` 未接线的新页面走 `PlaceholderPage v-else`。**worker 不做接线**——主 agent 统一接线。

## 4. 页面范式（所有页面必须遵守）

### 4.1 页面骨架

```vue
<template>
  <div class="page">
    <header class="page-head">
      <div class="head-text">
        <h1 class="title">页面标题</h1>
        <p class="desc">页面级说明（12px neutral-mid）</p>
      </div>
      <div class="head-actions"><!-- 页级操作按钮（btn-dense） --></div>
    </header>
    <GroupCard title="分组一">...</GroupCard>
    <GroupCard title="分组二">...</GroupCard>
  </div>
</template>
```

- `.page-head`：flex space-between，`margin-bottom: var(--space-6)`，**无背景无 sticky**（spec §1：透出 `--bg`）
- `.title`：20px/600/neutral-fg（**不是** 18px/700——对齐 ProviderPage 现状）；`.desc` 12px neutral-mid
- 内容直接平铺在 `--bg` 上，靠 GroupCard(bg-card) 浮起

### 4.2 状态指示（v6-design §3.3）

- 状态一律 **7px 圆点**（`width/height: 7px; border-radius: 999px`）+ 语义色：connected/done=`--success`(90% opacity 可) / running=`--accent` / waiting=`--warn` / error=`--danger`
- 状态标签用 pill：`bg-soft + 语义色字` 或纯文字色，999px 胶囊，字号 11-12px
- 目录/来源标识（如 disc）：`bg-input + mono 10px + neutral-mid + radius-sm`

### 4.3 交互状态机（有编辑态的页面必须实现）

参照 ProviderPage/SystemPromptPage 已验证模式：

1. **dirty 快照 diff**：初值不 dirty；编辑后 `dirty=true`；**净零翻转（改回原值）恢复 clean**——用「快照 = 已保存值」diff 判定，不是布尔标记
2. **保存流**：mock 延迟 400-600ms（`saving` 态禁用保存按钮）→ 成功后快照刷新 + 1.5s「已保存」反馈（save-bar 或 toast 行内），错误进 save-bar/行内错误条
3. **离开守卫**：`watch([settingsPage, settingsOpen], ..., { flush: 'sync' })`——dirty 时拦截切页/关闭，弹确认（warn 语义：「放弃未保存的改动？」+「继续编辑」default /「放弃改动」danger），**放弃必须先还原快照再导航**（否则 sync watch 重入弹窗永久重开——已知坑）
4. **beforeunload**：dirty 时 `e.preventDefault()`
5. 确认弹窗**内联自建**（`fixed inset-0` + 遮罩 + 居中卡片），不复用 ProviderUnsavedDialog（各页自持）

### 4.4 mock 数据层

- mock 数据放**独立文件** `src/mock/<page>.ts`（export 类型 + 数据 + 文案常量），页面组件 import——禁止写死到组件里，禁止塞进 `src/mock/sessions.ts`（他人文件）
- 数据字段名对齐真实项目组件（worker 从真实组件抄字段）
- 初值 `dirty: false`；页面刷新数据时显式 skeleton/shimmer（`@keyframes shimmer` 已全局可用）

## 5. 硬约束（违反即返工）

1. **禁 git 操作**（commit 主 agent 统一做）；**禁改他人文件**（settings/ 下已有文件除自己的新文件外一律只读；base.css/UiInput/UiSwitch/SettingRow/GroupCard/SettingsOverlay 只消费不修改）
2. **行数**：`<template>` ≤ 400 / `<script setup>` ≤ 300（含注释空行，vue_rules_checker 口径）
3. **禁 `any`**、禁 `@apply`、禁硬编码颜色/间距/圆角（全部 token 化）、禁原生表单元素以外的原生控件（按钮必须 `.btn`）
4. **icon 全部内联 SVG**（lucide 路径，stroke-width 1.75），禁 emoji
5. 交互组件（按钮/输入）**必须可操作**：禁止死按钮（点了无响应 = 返工）；mock 场景也要有分支（成功/失败/空态）
6. 状态反馈齐全：busy 态（spinner/disabled）、成功态（短暂反馈）、失败态（错误条，非静默）
7. 验证：`npx vue-tsc --noEmit` exit 0（工作区临时报错可能是并行 worker 半成品，以自己文件为准）+ 行数检查；有能力的用 Playwright 自测（chrome executablePath 见下）
8. **vite watcher 常失效**：改文件后若 `curl http://localhost:1421/src/components/settings/<文件>` 不含新代码，重启 vite：`PID=$(lsof -ti :1421 -sTCP:LISTEN | head -1); kill $PID; sleep 1; nohup npx vite > /tmp/v6-vite.log 2>&1 &`
9. Playwright（可选自测）：`NODE_PATH=/Users/zhushanwen/.agents/skills/browser-automation/scripts/node_modules` + `chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' })`；打开设置页：`await page.evaluate(async () => { const m = await import('/src/composables/useStore.ts'); m.openSettings('<key>') })`

## 6. 页面功能来源（真实项目组件 → v6 demo 重画）

| 页面 | nav key | 真实组件（功能/字段/交互来源，必读） | v6 产出文件 |
|---|---|---|---|
| 代理 | `agent` | `packages/renderer/src/components/settings/SettingsResourcePage.vue`（kind=agent；与 skill 同构） | `AgentPage.vue`（仿 ResourcesPage 模式） |
| 终端 | `terminal` | `packages/renderer/src/components/settings/TerminalPage.vue` | `TerminalPage.vue`（新建） |
| 预设 | `preset` | `PiPresetsPage.vue` + `PresetModeSection.vue` | `PresetPage.vue` |
| 工作区 | `worktree` | `WorktreePage.vue` | `WorktreePage.vue`（新建） |
| 更新 | `update` | `UpdatePage.vue` | `UpdatePage.vue`（新建） |
| 系统 | `system` | `SystemPage.vue` | `SystemPage.vue`（新建） |

规则：
- **功能 = 真实组件为准**（字段、选项、分组、文案语义），**视觉 = v6 规格为准**（tokens/范式），两者冲突时视觉降级跟随功能（v6 是视觉规格层）
- 页面组件命名冲突注意：`TerminalPage.vue`/`WorktreePage.vue`/`UpdatePage.vue`/`SystemPage.vue` 在 v6/settings/ 下**尚不存在**，可新建；真实项目同名组件只是功能参考
- 真实组件里的业务术语（如「pi preset」「worktree 目录」「自动更新」）保留，ui 文案可润色但语义不变

## 7. 参考实现（读范式用，不必全读）

- 列表+分组+操作流范式：`src/components/settings/ResourcesPage.vue`（结构可仿，勿改）
- 编辑+dirty+save-bar+守卫范式：`src/components/settings/ProviderPage.vue`（交互状态机参考）
- 表单+计数器+守卫范式：`src/components/settings/SystemPromptPage.vue`
- 占位现状（将被替换）：`src/components/settings/PlaceholderPage.vue`（不动，主 agent 接线后自然不再命中）
