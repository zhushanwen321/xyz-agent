# Plugin Sidebar View 端到端数据流调研（background bash 侧边栏设计前置）

worktree: /Users/zhushanwen/Code/xyz-agent-workspace/feat-background-bash-watcher
pi 实装版本: @earendil-works/pi-coding-agent@0.84.4（npm ls 核实）

## 1. extension → renderer 的 view 数据流（todo/goal 现行链路）

**结论**：pi extension 用 `guiSetWidget`（marker 编码进 `ctx.ui.setWidget`）推送结构化 GuiComponent → pi RPC stdout `extension_ui_request{method:'setWidget'}` → runtime EventAdapter 检测 NUL marker 解码 → WS `extension:widgetGui` → renderer MessageBusBridge 归一为 bus 事件 `extension-widget` → ViewHostStore 按 (sessionId, viewId) 分区缓存 → **WidgetArea（对话流面板）消费渲染**；sidebar 的 PluginViewContainer 是另一消费面（静态声明清单，现状恒空）。

### 事实锚点

**extension 侧**
- `extensions/universal/todo/src/index.ts:36-64` `makeRefreshDisplay`：每次 todo 变更调 `ctx.ui.setStatus("todo", statusText)`；RPC 模式（`isGuiCapable`，即 `ctx.mode==='rpc'`，`packages/extension-protocol/src/core/helpers.ts:24-26`）走 `guiSetWidget(ctx, "todo", buildGui(todos))`，TUI 走 `ctx.ui.setWidget("todo", renderWidgetLines(...))`
- `extensions/universal/todo/src/model.ts:106-107` `buildGui` 返回 `guiResult(guiComponent("list-tree", {numbered:true, items}), meta)`；meta.title/status/progress 由 model.ts:92-105 组装
- `packages/extension-protocol/src/core/helpers.ts:80-93` `guiSetWidget`：把 `GuiRenderResult`（`{v:1, component, meta?}`）JSON 序列化，编码为单行 `[GUI_WIDGET_MARKER + json]` string[] 传 `ctx.ui.setWidget(key, encoded)`；传 `undefined` 清除 widget
- `packages/extension-protocol/src/core/markers.ts:7` `GUI_WIDGET_MARKER = '\x00XYZ_GUI_WIDGET:'`
- goal 同款封装：`extensions/universal/goal/src/adapters/ports.ts:50` `setGuiWidget`

**pi 进程内（实装 0.84.4）**
- `node_modules/@earendil-works/pi-coding-agent/dist/modes/rpc/rpc-mode.js:123-130`：RPC 模式 `ui.setWidget(key, content)` → stdout JSONL `{type:"extension_ui_request", id, method:"setWidget", widgetKey, widgetLines}`（widgetLines 即上面编码后的 string[]）

**runtime 侧**
- `packages/runtime/src/infra/pi/event-adapter.ts:1178-1180` `attach(client)` 订阅 pi `onEvent`；`:1063` DISPATCHER 把 `extension_ui_request` 路由到 `:392 handleExtensionUIRequest`
- `:415-493` `method==='setWidget'` 分支：
  - `:421` widgetKey 匹配 `^subagent-stream-(.+)$` 短路（专用通道）
  - `:434-440` widgetLines 空 → WS `extension:widgetGui` `{sessionId, widgetKey, gui:null}`（清除语义）
  - `:444-471` 单行以 marker 开头 → JSON.parse → `isGuiRenderResult`（v1.1 信封）解包出 component+meta → WS `extension:widgetGui` payload `{sessionId, widgetKey, gui: component, meta?}`；v1 裸 component 兼容；解析失败降级 `extension:widget` 文本
- `packages/runtime/src/index.ts:431-432` adapterFactory = `new EventAdapter(sessionId, (events) => interpreter.interpret(events))`
- `packages/runtime/src/services/session/event-interpreter.ts:288-289` `kind==='message'` → `this.opts.send(ev.message)`
- `packages/runtime/src/services/session/session-lifecycle.ts:228-242` `send`：payload 带 sessionId → `messageBus.publish(sid, msg)`（per-session 单调 seq + ring/snapshot，定向推给订阅该 sid 的 ws，wave:perf-w09 单通道）；无 sid → `broadcastGlobal`（broker.broadcast）

**renderer 侧**
- `packages/renderer/src/main.ts:32` `initExtensionHostBridge(app)`（装配一次）
- `packages/renderer/src/api/events.ts:114-132` crossSession 通道：带 sid 消息经 route-inbound FALLBACK 分支 `dispatchCrossSession` 喂给全局单例消费者
- `packages/renderer/src/composables/shell/useExtensionHostBridge.ts:78-85` `EXTENSION_BRIDGE_TYPES` = ['extension:widget','extension:widgetGui','extension:status','extension:notify','extension.ui_request']；`:96-122` `createWsPluginMessageSource`：`onGlobal`（plugin:*）+ `onCrossSession`（extension:*）双订阅 → filter → handler
- `:188-198` `MessageBusBridge({source, bus})` + `ViewHostStore` + `createReactiveSessionScopedMap`（`:161-199`，shallowReactive 外层 Map + reactive 分区值——core headless Map 需响应式桥才能触发 computed 重算）
- `packages/core/src/extension-host/message-bus-bridge.ts:324-330` EXTENSION_HANDLERS：`'extension:widgetGui'` → `parseExtensionWidget`（`:291-308`）→ bus 事件 `extension-widget` `{viewId: widgetKey, pluginId:'', guiTree:[gui], meta}`；gui:null → `guiTree:[null]` 保留清除语义
- `packages/core/src/extension-host/view-host-store.ts:46-56` subscribe（`extension-widget` + `session-destroyed`→cleanup）；`:102-119` `consumeWidget`：guiTree=[null] → `invalidate(sessionId, viewId)`；否则 `narrowGuiTree`（isGuiComponent 直存 / string 行包装 `ansi-text`）→ `setView` 写入 per-session 分区 `Map<viewId, ViewCacheEntry>`

### 关键数据形状
```ts
// packages/core/src/extension-host/view-host-store.ts:29-35
interface ViewCacheEntry { viewId: string; pluginId: string; guiTree: GuiComponent[]; meta?: WidgetMeta; updatedAt: number }
// packages/shared/src/protocol.ts:965
'extension:widgetGui': { sessionId: string; widgetKey: string; gui: unknown }  // meta 字段运行时存在，map 注释漏登（event-adapter.ts:456 实发）
// packages/extension-protocol/src/core/types.ts:71-79
interface GuiRenderResult { v: 1; component: GuiComponent; meta?: WidgetMeta }
```

### 消费渲染（两个宿主）
- **对话流面板（todo/goal 现行宿主）**：`packages/renderer/src/components/panel/Panel.vue:78` `<WidgetArea :session-id>`；`packages/ui/src/features/chat/WidgetArea.vue:56-63` `entries = getViewIds(sessionId).map(id => getView(sessionId,id))` 过滤空；head 用 `entry.meta`（title/status 点/progress mini bar/折叠）
- **sidebar plugins tab**：`packages/renderer/src/components/sidebar/Sidebar.vue:137-141` `sidebar.activeTab==='plugins'` → `<PluginViewContainer :session-id="focusedSessionId">`（无焦点 session 时空态）；`packages/ui/src/extension-host/PluginViewContainer.vue:59` views ← inject `VIEWS_SOURCE_KEY.getViews(sessionId)`；`:47-50` `<ViewHost :view-id="activeView" :session-id>`
- `packages/ui/src/extension-host/ViewHost.vue:41` `view = source.getView(sessionId, viewId)` → 逐个 `GuiComponentRenderer` 渲染 guiTree

### session 隔离
- 双键分区：`SessionScopedMap<sessionId, Map<viewId, ViewCacheEntry>>`（view-host-store.ts:31；`packages/core/src/extension-host/utils/session-scoped-map.ts:16,34`）
- WS payload.sessionId = 分区键（bridge `resolveSessionId`：msg.sessionId ?? payload.sessionId，message-bus-bridge.ts:52-54）；无 sid 的 widget 消息被 `consumeWidget` 丢弃（view-host-store.ts:103）
- `session-destroyed` bus 事件 → `sessionScoped.cleanup(sid)`（view-host-store.ts:53-55）
- 响应式：壳 `createReactiveSessionScopedMap`（useExtensionHostBridge.ts:161-199）；WidgetArea.vue:51-54 注释——getViewIds/getView 必须同在 computed 内调用才被追踪
- PluginViewContainer 传 `:session-id` 后 ViewHost 取数路径 = `VIEW_HOST_SOURCE_KEY.getView(sessionId, viewId)`（useExtensionHostBridge.ts:302-306 provide，纯透传 core store）

## 2. sidebar.tab 视图贡献的声明来源

**结论**：sidebar.tab 贡献今天**只有 builtin 静态声明一条路**，且 builtin 里根本没有 views 声明——`loadExternal` 恒传空数组（s3 runtime 透传通道未完成）。sidebar plugins tab 现状恒「暂无插件视图」空态；todo/goal 刻意不进 sidebar（走对话流 WidgetArea）。

- `packages/core/src/extension-host/builtin-contributions.ts:18-40`：仅 2 条 builtin——`statusline`（statusBarItems，text 空串由 runtime 广播填充）+ `tasks`（只声明 slashCommands goal/todo；注释明示「其 views 不声明——todo/goal 状态经 guiSetWidget 由 M17 对话流面板承接，不进 sidebar」）
- `packages/core/src/extension-host/contribution-registry.ts:48-54` `registerBuiltin`；`:66-105` `loadExternal`（幂等覆盖式注入 PluginDescriptorLike.contributes，含 legacy panels→view alias）；`:145-160` `getViewsByPlacement(placement)`
- `packages/core/src/bootstrap.ts:69-71` `scanContributions`：`registerBuiltin()` + **`loadExternal([])`**（注释：s3 透传未完成）→ [Inferred] 目前没有任何机制让 pi extension 声明 sidebar.tab view（runtime plugin descriptor 通道未接）
- `packages/renderer/src/composables/shell/useExtensionHostBridge.ts:312-327` `VIEWS_SOURCE_KEY.getViews` 实现：`contributions.getContributions({type:'view'}).filter(c => c.placement==='sidebar.tab')`，映射 viewId/title/icon(undefined)/initialVisibility/pluginId；per-session 形参被忽略（纯静态）
- `packages/ui/src/extension-host/PluginViewContainer.vue:35` `BUILTIN_PLUGIN_IDS={'tasks'}` 不可关闭；`:161-170` 无 tabs → `data-testid="plugin-view-empty"` 空态
- 挂载点注册：`packages/core/src/bootstrap.ts:57-60` 只注册 4 个：`sidebar.tab / panel.header / composer.toolbar / statusbar`；`useExtensionHostBridge.ts:229-244` `ensureMountPointsSync` 经 `plugin.mountPoints.sync` 上报 runtime（消费方是 runtime plugin 的 views.listMountPoints）
- 动态发现 vs 静态声明并存：`view-host-store.ts:61-66` `getViewIds` 注释称「sidebar L2TabBar 据此动态暴露 view tab——任何 extension 推 extension:widget 后对应 viewId 自动出现在 tab 栏」，但 PluginViewContainer 实际读的是 VIEWS_SOURCE 静态清单（M17 wave2 D5 裁决后 widget 不进 sidebar）——两套清单源并存，动态路径无消费者
- **普通 pi extension 新增 sidebar tab 需动**：① `builtin-contributions.ts` 加 `{pluginId, contributes:{views:[{id, placement:'sidebar.tab', viewType:'gui', title}]}}`（静态、随壳编译）；② 视图数据经 `guiSetWidget(ctx, <viewId>, ...)` 推送（widgetKey 必须 = contributionId，ViewHost 按 viewId 取数）；③ [Inferred] 若不想动壳代码，需先打通 s3 loadExternal 透传（工作量更大，现状空数组）

## 3. GuiComponent 渲染词汇表

**结论**：9 个类型（8 原语 + custom 逃生口），全部纯展示**无任何交互回调**——没有 onClick/onSelect/事件回传机制；点击交互今天只能靠 extension.ui_request 模态对话框或 custom 编译期注册。

- 类型 SSOT：`packages/extension-protocol/src/core/types.ts:33-114`
  - `ansi-text`{lines} / `card`{variant?,header?,body[]} / `stats-line`{items:StatItem[]} / `progress-bar`{label?,current,total,unit?,severity?} / `list-tree`{items:TreeItem[],numbered?} / `group`{children[]} / `columns`{children[],ratios?} / `tab-bar`{tabs:{label,active?,status?}[]} / `custom`{component,props}
  - `TreeItem`{icon?:'arrow'|'check'|'cross'|'circle'|'dot'|'pause'|'branch', label, status?:'running'|'done'|'failed', depth?, children?}（:125-131）
  - `WidgetMeta`{title, status?:'running'|'done'|'failed'|'idle', progress?{current,total,label?,severity?}}（:88-100，宿主 head 渲染）
- 渲染路由：`packages/ui/src/rendering-protocol/GuiComponentRenderer.vue:52-61` BUILTIN_MAP；降级 SSOT 在 `packages/core/src/rendering-protocol/resolve.ts`（未知 type/脏数据 → ansi-text JSON 序列化）
- 交互回调：无。ListTree.vue 等原语 defineProps 均无事件字段、无 emit（`packages/ui/src/rendering-protocol/primitives/ListTree.vue:21-27` props 只有 items/numbered/depth）；唯一交互是 WidgetArea head 折叠（前端本地 Set，WidgetArea.vue:65-69）
- 事件回传通道只有 `extension.ui_request`（method ∈ confirm/select/input/editor，`packages/shared/src/extension.ts:30` + event-adapter.ts:90-92 INTERACTIVE_UI_METHODS）——语义是**阻塞模态对话框**，前端必须回 `extension.ui_response`（`packages/runtime/src/transport/extension-message-handler.ts:100` 处理；超时由 extension-timeout-manager 发默认响应，server.ts:447），不是列表点击
- custom 原语：「仅限内置 extension 编译期注册」（types.ts:108-111）；`GUI_CUSTOM_REGISTRY_KEY`（`packages/core/src/rendering-protocol/custom-registry.ts:19`）在生产代码**零 provide 者**（grep 核实，默认空表）→ custom 未注册即降级 ansi-text
- **评估（任务列表+详情）**：① 多状态徽标——TreeItem.status 三态 + WidgetMeta.status 四态可表达 running/done/failed，但缺 killing/orphaned（background-task.ts:62 枚举是 running|killing|exited|orphaned）；② 计时——无 elapsed 原语，只能 stats-line 静态文本靠 extension 重推刷新；③ **点击 item → 开 drawer：完全无通道**（无 clickable 原语、无事件回传 WS 帧）；④ 元信息表——stats-line/list-tree 可近似；⑤ kill 按钮——无 button 原语；⑥ 输出预览——只能 ansi-text 大段文本。[Inferred] 缺 clickable-list-item/button 原语 + 点击事件回传通道（或 custom 编译期注册 + 专用 WS 上行帧），这是设计文档需要新增的部分

## 4. drawer 机制

**结论**：drawer 是硬编码 7-tab 联合类型 + 容器组件 TabMeta 数组 + 壳层 PanelContainer v-if chain 三处同步的静态机制；'drawer.tab' 挂载点只存在于类型注释，无实际消费者。

- 控制态 SSOT：`packages/core/src/domain/drawer/`——`types.ts:19` `SideDrawerTab = 'terminal'|'browser'|'git'|'doc'|'detail'|'subagent'|'workflow'`；`DrawerControlState`（types.ts:27-40，含 selectedSubagentId/selectedWorkflowName 选中态先例）；per-session Map 分区（分区键 = panel store focusedSessionId）
- renderer 兼容层：`packages/renderer/src/composables/features/drawer/useSideDrawer.ts:77-107`（bindDrawerSessionId + re-export core API）
- 容器：`packages/ui/src/features/drawer/DrawerPanel.vue`——props{isOpen,activeTab,docked,sessionId} + emit close/set-tab/toggle-dock；tab 栏 = 硬编码 tabs computed（icon/i18n label/empty 文案）；内容区 = **默认 slot 由壳注入**，`hasDesktopPanelContent()` 判断 slot 空则渲染空态
- 壳注入点（唯一消费方）：`packages/renderer/src/components/workspace/PanelContainer.vue:107-143` v-if chain：TraceInspector(优先)/GitPanel/CommandDocPanel/DetailPane/BrowserPane(需 browserUrl)/TerminalView/SubagentTab/WorkflowTab——DetailPane/TerminalView 懒加载（:180-201）
- 搜索 drawer 接入先例：`packages/renderer/src/composables/features/sidebar/useSidebarSessionActions.ts:196-200` `onOpenSearchDrawer(tab)` → `useSideDrawer().open(tab)`（实际只有 'detail' 生效）
- 'drawer.tab' 挂载点：`packages/core/src/extension-host/types.ts:115,156`、`mount-point-registry.ts:6`、`packages/plugin-sdk/src/types.ts:257`、`packages/runtime/src/services/plugin-service/plugin-types/descriptor-types.ts:90` 均只是「开放字符串」注释示例——bootstrap.ts:57-60 未注册、ContributionRegistry 无 routeAll 消费、DrawerPanel 无贡献路由 → **无实际消费者**
- [Inferred] 新内容（bash 任务详情）进 drawer 的接入点（按现有范式 4 处）：① `core/domain/drawer/types.ts` SideDrawerTab 加成员（+ 若需选中态仿 selectedSubagentId 加 DrawerControlState 字段）；② `DrawerPanel.vue` tabs computed 加 TabMeta；③ `PanelContainer.vue` v-if chain 加面板组件；④ open 调用方（列表点击处）`openDrawerTab('xxx')` + 选中参数。drawer 宽度持久化由 useDrawerSplitWidth 承接，无需改

## 5. extension → 前端的事件推送通道

**结论**：pi extension 有 5 条现成下行通道（widgetGui / status / notify / ui_request 模态 / customStart 对话流注入）；runtime plugin 系另有 plugin:* 家族。任务状态变化实时刷列表可直接复用 widgetGui（推全量即重渲染）。

**pi extension 通道**（全部经 pi stdout `extension_ui_request` → EventAdapter → WS）：
1. **extension:widgetGui**（view 数据，Q1 全链路）——实时性：每次 guiSetWidget 即推即渲
2. **extension:status**：`ctx.ui.setStatus(key, text)` → event-adapter.ts:398-412 → WS `{sessionId,statusKey,text,textRaw}` → message-bus-bridge.ts:310-325 parseExtensionStatus → bus `extension-status` → StatusBarController（per-session/global 双 scope 分区）→ `packages/ui/src/extension-host/StatusBar.vue`（main-panel 底部 26px 状态栏，含 commandId 可点击项）
3. **extension:notify**（fire-and-forget toast）：`ctx.ui.notify` → event-adapter.ts:505-520 → WS `{sessionId,message,level}` → NotificationHostController（useExtensionHostBridge.ts:397-409）→ createNotifyToastHandler toast + 定位行
4. **extension.ui_request**（阻塞模态）：select/confirm/input/editor → 前端回 `extension.ui_response`；ask-user 富交互与 session-manager 复用 method:'select'+marker title（event-adapter.ts:540,561）
5. **message.customStart**（对话流注入）：extension 调 `pi.sendMessage({customType, content, display:true}, {deliverAs:'steer'})` → pi `message_start{role:'custom'}` → event-adapter.ts:655-667 → WS `message.customStart {sessionId,customType,content,details,display}`（`packages/shared/src/protocol.ts:1443-1451`）→ core applyEntry reducer → role:'system' 消息 → `packages/ui/src/features/chat/SystemNotice.vue`（customType 分支目前仅 subagent-directive 定制渲染，其余兜底文本行）
6. 专用：widgetKey `subagent-stream-<recordId>` 前缀 → subagent-stream 事件（event-adapter.ts:419-427）

**runtime plugin 系**（Worker/fork 插件，非 pi extension）：
- `plugin:statusBarUpdate`：`packages/runtime/src/services/plugin-service/status-bar-registry.ts:24,53-90`（itemKey=`${pluginId}:${id}`，100ms trailing debounce 合并，广播全量快照）→ `plugin-service.ts:179-181` 经 `server.broadcast` **全局盲广播**（无 sid）→ renderer onGlobal → parseStatusBarUpdate → bus `plugin-status-bar-update` → 同一 StatusBar
- `plugin:viewUpdate`：`packages/runtime/src/services/plugin-service/plugin-rpc-setup.ts:269-276` handleViewUpdate → messageBus.publish（session 级定向）→ `message-bus-bridge.ts:226-243` parseViewUpdate → **同一 `extension-widget` bus 事件 → 同一 ViewHostStore**（与 pi extension widget 合流）

**background bash 现状**（设计直接相关）：
- 状态持久化 SSOT：`packages/extension-protocol/src/background-task.ts`——registry.json at `<agentDir>/base-tool-enhance/<sessionId>/registry.json`，`BackgroundTaskState = 'running'|'killing'|'exited'|'orphaned'`，写侧原子写 temp+rename + 文件锁 RMW，runtime 收殓器为读侧
- 完成通知：`extensions/universal/base-tool-enhance/src/background/notify.ts:7-9,153-156` 经 `pi.sendMessage({customType:'background-bash', content, display:true}, {deliverAs:'steer', triggerTurn:true})`——今天**只进对话流**（SystemNotice 兜底文本行），无 sidebar 列表、无实时刷新
- base-tool-enhance 现不用 setStatus/setWidget（grep 零命中）
- [Inferred] 任务 running→exited 实时刷前端：复用 widgetGui（每次状态变化重推全量 GuiComponent 列表，WidgetArea/ViewHost 自动重渲）或 extension:status（摘要行）；但「点击看详情/kill 按钮」需要 Q3 所缺的交互回传通道

## 链路总图

```
pi extension (todo/base-tool-enhance/…)
  │ guiSetWidget(ctx,'todo', GuiRenderResult)          [extension-protocol helpers.ts:80]
  │  = ctx.ui.setWidget(key, ['\x00XYZ_GUI_WIDGET:{v,component,meta}'])
  ▼
pi 子进程 RPC stdout (rpc-mode.js:123)
  {type:'extension_ui_request', method:'setWidget', widgetKey, widgetLines}
  ▼
runtime EventAdapter.attach ← client.onEvent            [event-adapter.ts:1178]
  handleExtensionUIRequest :415 setWidget 分支
  ├─ marker 解码 → kind:'message' {type:'extension:widgetGui', payload:{sessionId,widgetKey,gui,meta?}}  :453
  ▼
EventInterpreter.interpret :288 → opts.send(msg)
  ▼
session-lifecycle.registerSession.send :228
  messageBus.publish(sid, msg)  (per-session seq+ring 定向推送)
  ▼
══════ WebSocket ══════
  ▼
renderer ws-client → route-inbound（有 sid → session 通道；FALLBACK → dispatchCrossSession :130）
  ▼
createWsPluginMessageSource (onGlobal+onCrossSession, 白名单 filter)   [useExtensionHostBridge.ts:96]
  ▼
MessageBusBridge.handleMessage → parseExtensionWidget :291
  bus.emit({kind:'extension-widget', sessionId, widget:{viewId,pluginId:'',guiTree,meta}})   [message-bus-bridge.ts:324]
  ▼
InternalEventBus ──→ ViewHostStore.consumeWidget :102
  sessionScoped[sessionId][viewId] = ViewCacheEntry{guiTree, meta}   (响应式分区 Map)
  │
  ├─▶ WidgetArea.vue:56 (Panel.vue:78 对话流面板)  ← todo/goal 现行宿主
  │     getViewIds(sid).map(getView) → GuiComponentRenderer
  │
  └─▶ PluginViewContainer.vue (Sidebar.vue:139 plugins tab)
        VIEWS_SOURCE.getViews() ← ContributionRegistry sidebar.tab 静态声明
        （builtin-contributions.ts 无 views → 现状恒空态）
        └─▶ ViewHost.vue:41 getView(sessionId, viewId) → GuiComponentRenderer
```
