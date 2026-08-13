# 04 · M16 设置页接线 + V6 视觉对齐

> 主文档：`README.md`（§3.3，W4 的详细设计）
> 解决主问题 P4（M16 未接线）+ P5（V6 视觉未对齐）

## §1 问题定义

**现状**：
1. **M16**：`ui/src/extension-host/PluginSettingsPage.vue` 已实现（插件列表四列 + contribution 可用性置灰 + `contribution-unavailable` testid），数据契约 `PluginSettingsDataSource` 已定义（getContributions 查询），但 **Settings 无入口引用它**（`components/settings/extension/` 是旧的 ExtensionPage，管理 pi extension 安装）。
2. **视觉**：7 原语（re-home 后）与 A1 二级 tab、A4 底栏的视觉仍是旧样式，未对齐 `v6-spec-plugin-rendering.html`（C7 波次未实施）。

**目标**：
1. Settings 内可进入插件贡献管理页（builtin + external 的 contribution 可用性可见）
2. 7 原语、二级 tab、底栏视觉对齐 V6 spec（数值以 spec 为权威）
3. 视觉改动零协议变更（只改 CSS/模板，已接入 extension 零改动自动获得新视觉）

## §2 现状细节（代码事实）

- `PluginSettingsPage.vue`：四列（插件/贡献/状态/操作）+ 置灰 + 原因文案；inject `PLUGIN_SETTINGS_DATA_SOURCE_KEY`；**零消费方**
- `plugin-settings-data-source.ts`：`getContributions()` 接口契约；注释"真实实现接 S2 contribution-registry"
- Settings 结构：`components/settings/` 按域分目录（extension/preset/provider/resource/system/terminal/update），`SettingsModal.vue` 收口
- 7 原语文件：`ui/src/rendering-protocol/primitives/{Card,StatsLine,ProgressBar,ListTree,Columns,TabBar,AnsiText}.vue`（re-home 完成，视觉未 v6 化）
- 视觉权威：`v6-spec-plugin-rendering.html`（§3 原语 + §2 A1/A4）；数值摘要见主文档关联，完整表见该 spec

## §3 方案

### 3.1 M16 接线

**方案对比**：

| 方案 | 说明 | 长期 | 成本 | 风险 |
|---|---|---|---|---|
| **A（推荐）挂入现有 Settings 扩展页** | SettingsModal 的 extension 域增加"插件贡献"区块（或独立子页），PluginSettingsPage 挂载；数据源接 ContributionRegistry 适配 | ★★★★★ 与 schema v2 的 configuration/D2 演进同路径 | 低 | 低 |
| B 独立 Settings tab | 新增一级 tab | ★★ 一级 tab 泛滥（v6 裁决 D2 反对） | 中 | 中 |

**推荐 A**。挂载点：Settings extension 域内"插件贡献"子页（ExtensionPage 旁），入口按钮或 tab 切换。

**数据源适配**：`useExtensionHostBridge` 新增 provide `PLUGIN_SETTINGS_DATA_SOURCE_KEY`，getContributions 委托 ContributionRegistry（含 builtin statusline/tasks + external）。

### 3.2 V6 视觉对齐（7 原语 + A1 二级 tab + A4 底栏）

> 数值均以 `v6-spec-plugin-rendering.html` 为权威（demo 是缩放版不取数）。视觉 explorer 已提炼完整数值表（见调研报告），此处列关键改动点：

| 组件 | 关键改动 |
|---|---|
| Card | 去 border 靠 bg 层级（default=bg-surface / elevated=bg-surface-2 / card=bg-card（--bg-card 变量，#18181a））；header 去 border-b 改 bg-surface-2 浮起；圆角 8px；variant 靠 7px dot + badge（danger/success/warn/neutral） |
| StatsLine | severity 收窄：仅 danger 着色，ok/warn 降 neutral-fg；border-l hairline 保留；value tabular-nums |
| ProgressBar | fill 柔化 color-mix 55%；done 态降 neutral-dim；track 高 6px 圆角 6px bg-bg-input；indeterminate 动画 1.4s |
| ListTree | 缩进 16px（纯留白无引导线）；icon 12px；status 7px 圆点（done=success opacity .9 / running=accent / failed=danger / pending=neutral-dim opacity .5） |
| Columns | gap 12px 标准 scale |
| TabBar | 强制 SegmentedTab 范式：外层 bg-bg-input rounded-lg p-[3px]，active bg-bg-elevated 中性浮起，去 accent-soft 去底线 |
| AnsiText | ANSI 16 色 → v6 语义色映射表（spec §8），丢 bg 只用 fg，暗/亮双主题 |
| L2TabBar（W1 新建） | 直接按 V6 视觉实现（bg-bg-input + radius-sm + p-[3px]，tab padding 3px 4px 3px 8px，active bg-bg-elevated，pin/close hover 显现） |
| StatusBar（A4） | 24-28px 高 bg-bg-elevated；7px 状态点（ok/warn/danger/neutral/plugin-src=accent）；left/right 两段 + priority 降序；溢出横向滚动隐藏滚动条 |

**冲突裁决**（视觉 explorer 报告 §11）：
1. plugin 第 5 tab 身份色：**以 spec + D8 为准**（统一中性 bg-elevated+neutral-fg，不用 accent-soft 染底）——demo 是旧版
2. l2-tabbar 圆角 radius-sm(6px)（二级容器有意小于一级 12px）
3. 底栏高度取 26px（spec CSS 值）
4. gcols gap 12px（spec）
5. l2-pin 显示机制 opacity 0→hover 1（spec）

### 3.3 运行时断言（附探针）

| 断言 | 探针 |
|---|---|
| 设置页可达 + 列表渲染 | 组件测试：mount SettingsModal → 进入插件贡献子页 → `contribution-unavailable` 置灰项存在（mock source） |
| 原语视觉零协议变更 | `pnpm typecheck` + extension-protocol 类型未动（git diff 检查）；既有 GuiComponentRenderer 测试全绿 |
| ANSI 映射生效 | AnsiText 单测：ANSI 序列 → v6 语义色 class 断言（spec §8 表逐条） |

## §4 验收（对应主文档场景 E + 视觉比对）

### 场景 E：设置页入口

1. 打开 Settings → 扩展 → 插件贡献子页
2. **通过**：列表显示 builtin（statusline/tasks）+ 挂载点可用性（sidebar.tab/statusbar 等已注册=可用，未注册=置灰+原因）；`contribution-unavailable` testid 断言存在

### 场景 V：视觉比对（7 原语 + 二级 tab + 底栏）

1. dev 运行，**优先复用场景 B 的 goal 卡 + 对话流 tool 块（真实数据）**；mock 分支仅用于 spec 未覆盖原语的兜底（如 columns）
2. **通过**：与 `v6-spec-plugin-rendering.html` 逐组件视觉比对——card 无边框圆角 8px、stats-line 仅 danger 红、progress 柔化填充、list-tree 16px 缩进 + 7px 圆点、tab-bar SegmentedTab 范式、ANSI 文本为 v6 语义色
3. 侧栏 plugins tab 二级 tab（W1 后）与 A4 底栏：对照 spec §2 A1/A4 视觉

### 回归护栏

- `cd packages/ui && npx vitest run`（原语测试适配 v6 断言）
- `cd packages/renderer && npx vitest run`
- `pnpm typecheck`

## §5 下一层拆分（wave 级）

| 步骤 | 内容 | 验证 |
|---|---|---|
| 1 | 原语 v6 视觉（Card/StatsLine/ProgressBar/ListTree/Columns/TabBar/AnsiText 逐组件 + 测试适配） | ui 测试绿 + 场景 V 逐项 |
| 2 | StatusBar 视觉对齐（26px/状态点/priority 排序） | 场景 V 底栏项 |
| 3 | M16：Settings extension 域加"插件贡献"子页 + PluginSettingsPage 挂载 + 数据源适配 | 场景 E |
| 4 | L2TabBar 视觉最终对齐（随 W1 落地） | 场景 V 二级 tab 项 |

**依赖**：步骤 4 依赖 W1（01 子文档，L2TabBar 组件）；步骤 1-3 独立可并行。原语 v6 视觉改动会触碰所有消费 GuiComponent 的地方（对话流卡片/plugins tab/底栏）——先原语后接线，避免中间态不一致。

**文件改动地图**：
- `packages/ui/src/rendering-protocol/primitives/*.vue`（7 原语视觉）
- `packages/ui/src/extension-host/StatusBar.vue`（A4 视觉）
- `packages/ui/src/extension-host/PluginSettingsPage.vue`（若需微调）
- `packages/renderer/src/components/settings/extension/`（+插件贡献子页入口）
- `packages/renderer/src/composables/shell/useExtensionHostBridge.ts`（+PLUGIN_SETTINGS_DATA_SOURCE_KEY provide）
