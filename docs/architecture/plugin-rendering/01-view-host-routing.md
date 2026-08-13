# 01 · Sidebar plugins tab 二级 view tab + viewId 路由

> 主文档：`README.md`（§3.3 D1/D2，本子文档是 W1 的详细设计）
> 解决主问题 P1（todo/goal 无常驻展示位）+ 主问题 P5 的 A1 部分（二级 tab 视觉）

## §1 问题定义

**现状**：`bootstrap.ts registerMountPoints` 注册挂载点 `'sidebar.tab'`；`Sidebar.vue` plugins tab 渲染 `<ViewHost view-id="sidebar.tab">`；数据侧 `MessageBusBridge` 把 extension:widget/widgetGui 归一为 `viewId ← widgetKey`（`'todo'`/`'goal'`/开放字符串）。

**断裂点**：挂载点名字 `'sidebar.tab'` 被当作唯一 viewId 查询，而数据按 widgetKey 落 viewId。todo/goal 的内容存在 `ViewHostStore['todo'|'goal']`，plugins tab 查 `'sidebar.tab'` → 永远空。

**根本问题**：宿主位置（挂载点）与插件内容（view）两个概念被压成一个字符串。

**目标**（使用者视角）：
1. 侧栏 plugins tab 显示**二级 view tab 列表**（来自 plugin 声明），点哪个 tab 看哪个 view 的内容
2. todo/goal 的 pi widget 推送自动落到「任务」「目标」两个 tab（零 runtime 改动）
3. 空态语义明确：无任何 view 声明 → tab 空态提示；有声明无数据 → 内容区空态；无焦点 session → 现有占位

## §2 现状细节（代码事实）

### 2.1 数据侧已就绪（无需改动）

```
pi extension setWidget('todo', lines)
  → runtime event-adapter: extension:widget {widgetKey:'todo', lines}
  → useExtensionHostBridge 双订阅（EXTENSION_BRIDGE_TYPES 白名单含 extension:widget/widgetGui）
  → MessageBusBridge.parseWidget: kind:'extension-widget', widget:{viewId:'todo', ...}
  → ViewHostStore.setView(sessionId, 'todo', entry)
```

已核实：`message-bus-bridge.ts:234-250`（widgetKey → viewId 直映射）、`view-host-store.ts`（per-viewId per-session 分区 + isGuiComponent 校验 + string 行包装 ansi-text + null 清除语义）。

### 2.2 声明侧已就绪但未消费

- `builtin-contributions.ts` 只声明了 tasks 的 `slashCommands`（goal/todo），**没有 views 声明**
- `ContributionRegistry.parseContributes` 已解析 `views[]`（`contribution-registry.ts:130-141`），**但 view 记录形状有限**：`view: {viewType, title, initialVisibility}`，**无 id 字段**——viewId 只存在于 contributionId；查询面只有通用 `getContributions({pluginId?, type?})`（:157-166），**无 getViews(placement) 专用查询**（本次需补适配，见 D1-4）
- `Sidebar.vue:122-141`：plugins tab 单 ViewHost，`view-id="sidebar.tab"`

### 2.3 消费侧缺失

| 缺失 | 说明 |
|---|---|
| 二级 tab bar 组件 | V6 视觉 l2-tabbar（`v6-spec-plugin-rendering.html` §2 A1：bg-bg-input + radius-sm(6px) + p-[3px] + gap-2、tab 项 padding `3px 4px 3px 8px`、active=bg-bg-elevated+neutral-fg、l2-ico 11px、pin/close hover 显现） |
| view 列表聚合 | 从 ContributionRegistry 取 placement='sidebar.tab' 的 views；builtin + external 合并 |
| viewId 路由组件 | active tab → `ViewHost view-id=<view.id>` |

## §3 方案

### 3.1 方案对比

| 方案 | 说明 | 长期 | 成本 | 风险 |
|---|---|---|---|---|
| **A（推荐）** 挂载点聚合视图容器 | 新建 `PluginViewContainer`（ui 包）：查 ContributionRegistry 的 sidebar.tab views → 二级 tab bar + 内容区按 activeViewId 渲染 ViewHost | ★★★★★ 与 V6 spec 一致，external plugin 声明即自动出现 | 中 | 低 |
| B 维持单 view + 数据兜底 | plugins tab 的 ViewHost 改查"任一有数据的 viewId"（store 遍历兜底） | ★★ 无 tab 概念，多个 plugin view 只能叠放/覆盖 | 低 | 中（外部插件 view 无法区分） |
| C runtime 侧加路由 | runtime 把 widgetKey 映射到 'sidebar.tab' | ★ 在适配层做业务路由，违背"widgetKey 开放字符串"设计 | 低 | 高（每加一个 widgetKey 改一次 runtime） |

**推荐 A**。被否方案：B 无法承载"多个 plugin 各自 view"（V6 明确二级 tab 模型），C 把前端展示逻辑塞进 runtime 适配层。

### 3.2 终态结构（组件树）

```
Sidebar.vue
└── <template v-if="sidebar.activeTab === 'plugins'">
    └── PluginViewContainer          ★新增（ui/src/extension-host/）
        ├── 数据源注入：VIEWS_SOURCE_KEY（ContributionRegistry 查询适配）
        ├── L2TabBar（二级 tab）     ★新增或复用现有 SegmentedTab 变体
        │   ├── tab: [icon] title [pin?]   ← 来自 views[].icon/title（视觉按 v6 spec：容器 gap 2px，非 gap-2）
        │   └── active 态：bg-bg-elevated + neutral-fg（D8 中性，非 accent）
        └── 内容区
            └── <ViewHost :view-id="activeViewId" :session-id="focusedSessionId" empty="placeholder" />
```

### 3.3 数据流

```
ContributionRegistry.getContributions({type:'view'}) 过滤 placement==='sidebar.tab'  ← 本次补适配（D1-4）
  ├── builtin tasks: [{contributionId:'todo', title:'任务'}, {contributionId:'goal', title:'目标'}]   ← builtin-contributions.ts 新增
  └── external plugins: [...view 贡献]
        │
        ▼
PluginViewContainer computed: viewTabs = [{viewId: contributionId, title, icon?, pinned?}]
        │
        ├── L2TabBar 渲染 tabs（无 tabs → 空态提示"无插件视图"）
        └── activeViewId → <ViewHost :view-id> → source.getView(sessionId, viewId)
              └── ViewHostStore['todo'] ← pi widget 推送（已就绪链路）
```

### 3.4 关键决策

**D1-1：view 声明形状**（builtin-contributions.ts 新增）：

```ts
{
  pluginId: 'tasks',
  contributes: {
    views: [
      { id: 'todo', title: '任务', placement: 'sidebar.tab', initialVisibility: 'visible' },
      { id: 'goal', title: '目标', placement: 'sidebar.tab', initialVisibility: 'visible' },
    ],
    slashCommands: [/* 现有 */],
  },
}
```

- `id` 与 pi extension 的 widgetKey 对齐（'todo'/'goal'）——数据零映射自动路由；**消费侧 viewId = contributionId（即声明 id）**
- **`initialVisibility` 必须显式声明 `'visible'`**：parseContributes 默认 `?? 'hidden'`（`contribution-registry.ts:139`），不写则「任务」「目标」tab 不显示（场景 A2 落空）。消费侧语义：`'visible'` = 声明即显示 tab；`'hidden'` = 仅在数据到达时显示（本次仅 builtin 声明 visible，hidden 语义留给 future）
- icon 字段：schema v2 `PluginContributesView` 无 icon 字段——已核实：`{id, title, view, placement, viewType, activationEvent, initialVisibility}`（`plugin-sdk/types.ts:218`）。**icon 缺失**：builtin 侧在 tab 元数据层补 icon 映射（内置字典 id→icon，如 todo→ListTodo、goal→Target）；external 的 icon 字段进 schema v2 提案（`@proposed`，本次不改 schema，tab 无 icon 时显示默认图标）

**D1-2：pinned/close 行为**（V6 l2-tabbar 定义，本次范围）
- 关闭（×）：仅对 non-builtin view 生效；builtin（tasks）不可关闭。**builtin 判定**：`ContributionRecord` 无 builtin 字段（`types.ts:115-124`），按 **pluginId 白名单**（`'tasks'`）判定（future 可加字段，本次不加 schema）
- pin：纯前端状态（localStorage per-user），本次实现 pin 切换 UI + 持久化，不做"pinned 不被关闭"之外的复杂语义
- 溢出：V6 未定义（仅 flex-wrap），本次维持 flex-wrap，不做「+ 更多」

**D1-3：挂载点路由保持开放字符串**
- PluginViewContainer 只消费 `placement === 'sidebar.tab'` 的 views；MountPointRegistry 的注册与查询逻辑不动
- panel.header / composer.toolbar 挂载点维持现状（单 view 渲染，M9/M12 空壳保持——本次不扩展为多 view，因为这两个挂载点没有二级 tab 的 V6 视觉定义）

**D1-4：registry 查询适配（审查 MUST_FIX 3 的落地）**
- ContributionRegistry **无 getViews(placement)**，view 记录无 id 字段（id 在 contributionId）。本次在 core 补一个查询：`getViewsByPlacement(placement): ViewContribution[]`（内部 `getContributions({type:'view'})` 过滤 placement，返回 `{viewId: contributionId, title, icon?, initialVisibility}`），消费侧（PluginViewContainer 数据源）只依赖此查询。补单测覆盖（含 builtin tasks 声明解析）。

**D1-5：数据为空时的 tab 行为**
- 有 view 声明但 ViewHostStore 无数据 → tab 正常显示，内容区空态（"等待插件渲染…"，现有 ViewHost placeholder 语义）
- 无任何 view 声明 → 整个 PluginViewContainer 零 DOM（empty='hidden' 语义延续），plugins tab 显示现有"选择会话"占位逻辑不变

**D1-6：切 tab 保留状态**
- ViewHostStore 是 per-viewId per-session 分区，切 tab 只改 activeViewId，各 view 数据天然保留（无需额外状态）

### 3.5 运行时断言（附探针）

| 断言 | 探针 |
|---|---|
| todo widget 推送落到 viewId='todo' | `MessageBusBridge.parseWidget` 单测已覆盖 widgetKey→viewId 映射（s2 交付）；新增集成断言：emit extension:widget{widgetKey:'todo'} → ViewHostStore.getView(sid,'todo') 命中 |
| 二级 tab 列表来自声明 | PluginViewContainer 单测：注入 mock source（views 声明列表）→ 渲染 tab 数 = 声明数 |
| 切 tab 内容切换 | 单测：activeViewId 变化 → ViewHost view-id prop 变化（断言渲染的 GuiComponent 来自对应 viewId） |

## §4 验收（对应主文档场景 A/B 侧栏部分）

### 场景 A2：todo 二级 tab 可见

1. dev 启动 + 新建 session，让 agent 用 todo 工具添加任务
2. 点侧栏 Puzzle tab
3. **通过**：出现「任务」「目标」两个二级 tab；「任务」tab 显示 todo 列表（来自 pi widget 推送）；agent 更新 todo 后列表刷新；「目标」tab 空态（无 goal）

### 场景 B2：goal 二级 tab 可见

1. `/goal create ...` 后切到 plugins tab
2. **通过**：「目标」tab 显示 goal 状态卡（progress-bar/stats-line）；`/goal complete` 后显示完成态

### 场景 E2：无 session 占位

1. Overview 态（无焦点 session）切 plugins tab
2. **通过**：显示现有"选择会话"占位，不崩

### 回归护栏

- `cd packages/ui && npx vitest run`（新增 PluginViewContainer/L2TabBar 测试）
- `cd packages/renderer && npx vitest run`（Sidebar 相关既有测试适配）
- `cd packages/core && npx vitest run`（ContributionRegistry views 解析测试）
- `pnpm typecheck` 全包

## §5 下一层拆分（wave 级）

| 步骤 | 内容 | 验证 |
|---|---|---|
| 1 | builtin-contributions.ts 新增 tasks views 声明（todo/goal）+ ContributionRegistry views 解析测试补强 | core 测试绿 |
| 2 | ui 包新增 L2TabBar（V6 l2-tabbar 视觉）+ PluginViewContainer（tab 列表 + activeViewId 路由） | ui 测试绿（mock source） |
| 3 | Sidebar.vue plugins tab 替换单 ViewHost → PluginViewContainer；壳 provide VIEWS_SOURCE_KEY（ContributionRegistry 适配） | renderer 测试绿 |
| 4 | icon 映射字典（todo/goal 内置 icon）+ pin 状态持久化 | 场景 A2/B2/E2 手工验证 |

**文件改动地图**：
- `packages/core/src/extension-host/builtin-contributions.ts`（+views 声明）
- `packages/core/src/extension-host/contribution-registry.ts`（确认/补 getViews 查询）
- `packages/ui/src/extension-host/`（+L2TabBar.vue +PluginViewContainer.vue +views-source.ts）
- `packages/renderer/src/components/sidebar/Sidebar.vue`（plugins tab 换容器）
- `packages/renderer/src/composables/shell/useExtensionHostBridge.ts`（+VIEWS_SOURCE_KEY provide）
