# 架构审查待办 — 2026-07-13

> 来源：`improve-codebase-architecture` skill 审查，4 个 Explore subagent 并行覆盖 runtime pi-adapter / runtime services / renderer state / renderer components 四个 scope。原始 20 候选，精选 12 个。
>
> 可视化报告（before/after 架构图）：`$TMPDIR/architecture-review-20260713-134713.html`（临时文件，每次运行重新生成）
>
> 词汇：module · interface · depth · seam · locality · leverage

## 贯穿性观察

R1 / R2 / R5 / R7 四个 Strong 候选都是同一类问题——**正确的 deep module 已建好，但没被贯彻为唯一 seam，旁边被加了第二条路径**。修复很少是「建新东西」，而是「删掉旁路，走回已存在的 module」。这是本审查中 ROI 最高的一类改动。

---

## Strong（7 个）

### [x] R1 · 收口第二条 pi 事件订阅 — ✅ 已完成（cw-2026-07-13-enforce-deep-module-seams W3, commit 9a595f6e）

- **文件**：`packages/runtime/src/services/session/session-service.ts:549-580`（`attachUsageListener`）· `packages/runtime/src/infra/pi/event-adapter.ts:198-255` · `packages/runtime/src/services/session/event-interpreter.ts:113-246`
- **问题**：同一个 `RpcClient` 上挂了两条平行原始事件订阅。EventAdapter 走「翻译→interpret」结构化管线；`attachUsageListener` 又直接 `client.onEvent` 手解 pi usage JSON（`turn_end`/`message ?? payload`/`usage.totalTokens`）。pi usage 字段格式的知识散布在 infra 与 service 两层，seam 泄漏。
- **方案**：让 EventAdapter 成为 pi 事件的唯一 listener owner。删除 `attachUsageListener`，`tokenCount`/`isGenerating`/`labelPersisted` 改为由已存在的 `turn-usage`/`turn-end` 中间事件驱动。
- **收益**：locality（pi usage schema 单点）· seam 恢复（service 不触 pi 原始 JSON）· 测试面（usage 解析成 EventAdapter 纯函数单测）· 消除两监听器顺序竞态
- **ADR**：无冲突。ADR-0003 支持把 usage 解析收进 translate。

### [x] R2 · 统一 pi tool-result 归一 — ✅ 已完成（W1, commit 7292a026）

- **文件**：`packages/runtime/src/infra/pi/event-adapter.ts:134-195`（实时路）· `packages/runtime/src/infra/pi/message-converter.ts:73-244`（历史路）· `stripAnsi`/`ANSI_REGEX` 逐字重复（event-adapter:39-42 vs message-converter:9-12）
- **问题**：pi tool result 三种形态（string / `{content:[]}` / object）+ `args ?? input` + `path ?? file_path` + ANSI 剥离 + outputRaw 对称恢复 + write/edit 工具名集合——这套归一逻辑在实时路径和历史路径各实现一遍，靠注释互引维持对称。改一处必须同步改另一处，否则重开 session 后渲染不一致。
- **方案**：提取一个深的「pi tool 数据归一」模块（infra 纯函数），吸收 result 多形态判定 + stripAnsi/outputRaw 对称 + details/images 提取 + filePath 双读 + 工具名归类。两条路径退化为「调归一函数 + 塞进帧」薄壳。
- **收益**：locality（pi 字段漂移单点）· leverage（一函数服务 2 调用点 + 测试）· 对称性从注释保证变机械事实 · 删除逐字重复

### [ ] R3 · 合并 contenteditable 编辑器为一个 module

- **文件**：`packages/renderer/src/composables/panel/useContenteditableInput.ts`（640）· `packages/renderer/src/composables/useComposerChipCommands.ts`（179）· `packages/renderer/src/components/panel/ComposerInput.vue`（forwardRef hack）· `packages/renderer/src/components/panel/Composer.vue`
- **问题**：两个 composable 互相依赖（chip composable 的 `onChanged/restoreSelection` 是 contenteditable composable 的方法；后者的 `onKeydown` 调前者的 `handleBackspaceOnChip`），`ComposerInput.vue` 用 `forwardRef` 占位后赋值打破 setup 期循环依赖——「本应是一个 module、被行数上限逼成两个」的信号。`defineExpose` 透传 15 个方法，interface 极宽。
- **方案**：合并成 `useContenteditableEditor` module。interface 收窄为 `{ model, focus, clear, setText, insertChip, dispose }`（5-6 个），implementation 吸收光标/选区/IME/chip DOM/TreeWalker/savedRange。ComposerInput 退化成纯模板绑定。
- **收益**：locality（编辑器行为单文件）· interface（15 方法 → 5 命令）· 测试面（编辑器可独立 mount 单测）
- **注**：300 行上限是 `<script setup>` 规则，`.ts` composable 不受约束。

### [ ] R4 · 按判别式拆分 Block.vue

- **文件**：`packages/renderer/src/components/panel/message-stream/Block.vue`（355）· `packages/renderer/src/components/panel/message-stream/Turn.vue:158-171` · `packages/renderer/src/composables/logic/messageTurns.ts:141-182`
- **问题**：`Block.vue` 接受 `type: 'thinking'|'tool'|'text'` 判别式 prop，模板三条独立渲染路径，共享零个 computed。tool 分支内部还有 subagent 子分支（约 110 行，10 个 subagent 专属 computed）。浅 module 伪装成深 module——删掉任一分支复杂度不转移。
- **方案**：按 `OrderedBlock.kind` 拆成 `ThinkingBlock` / `TextBlock` / `ToolBlock`，subagent 逻辑抽成 `SubagentToolBlock` 由 ToolBlock 委托。每个 block：≤4 props + 深 implementation。
- **收益**：locality（subagent 进度协议隔离）· interface（每个 block ≤4 props）· 测试面（每种 block 独立 mount）

### [x] R5 · 把 subagent 流式收进 chat store interface — ✅ 已完成（W4, commit 8c2ee276）

- **文件**：`packages/renderer/src/composables/features/useSubagentView.ts:179-256`（`applyStreamDelta` 直调 `chat.setMessages`）· `packages/renderer/src/stores/chat.ts:165-168` · `packages/renderer/src/stores/chat-message-effects.ts:256-272`（主路径 text_delta handler）
- **问题**：chat store 建了深 interface（`applyMessageEvent` → 21-effect 注册表 + sealed guard + finalize），但 subagent 流式绕过整个 interface 直调 `setMessages`，形成「主 session 走 effect 注册表（append delta）/ subagent 走 setMessages（replace full）」两条平行 mutation 路径。
- **方案**：给 chat store 增 `applySubagentStreamDelta(virtualId, lines)` + `finalizeSubagentStream(virtualId)`，吸收「找最后 streaming assistant / 替换 content / 补 contentBlocks / 终态收口」。useSubagentView 退化为订阅生命周期 + 调 store 入口。
- **收益**：locality（assistant content 更新单点）· 测试面（纯 store 单测）· leverage（sealed guard/finalize 复用）

### [ ] R6 · 拆分 useSidebar god-composable

- **文件**：`packages/renderer/src/composables/features/useSidebar.ts`（484）· 8 个消费者各拉小子集
- **问题**：通过 deletion test（有效胶水），但把 3 个正交编排轴焊死：session CRUD + selectSession 巨方法（60 行）/ app 启动编排（initApp + registerAppCommands + appBootstrapped）/ 广播订阅生命周期（refCount 模式抄两遍 :45-58 + :70-102）。interface 太宽。
- **方案**：useSidebar 缩为「session CRUD + focusedSession 派生」；抽出 `useAppBootstrap`（initApp + appBootstrapped + registerAppCommands，App.vue 唯一消费）和 `useBroadcastSubscriptions`（refCount 模式收成泛型 helper）。
- **收益**：locality（启动时序不变量单点）· leverage（refCount helper 可复用）· interface（PanelContainer/Overview 不再拉入 initApp 闭包）

### [x] R7 · 消除 PluginInstaller 的 child_process spawn — ✅ 已完成（W2, commits 4032d007 + 3c1e26c5）

- **文件**：`packages/runtime/src/services/plugin-service/plugin-installer.ts`（86，第 1 行 `import { execFile } from 'node:child_process'`，:41 `npm pack`、:55 `tar -xzf`）· `packages/runtime/src/services/ports/installer.ts`（1-46）· `packages/runtime/src/infra/installers/npm-installer.ts`（495，纯 Node 安装器）
- **问题**：清晰的 seam 泄漏——PluginInstaller 在 services 层直接 spawn 子进程，而 infra 已有 495 行纯 Node npm 安装器（经 IInstaller port）服务 ExtensionService。两个安装器做几乎相同的事，一个在 infra 经 port，一个在 services 直 spawn。打包后 npm/tar CLI 可能不在 PATH。
- **方案**：扩展 IInstaller port（或新建 `IPluginInstaller`），让 PluginInstaller 变成 port 消费者。infra adapter 复用 npm-installer 的 fetchMetadata + downloadAndExtract，加 `pkg.xyzAgent.manifestVersion` 校验。
- **收益**：seam 恢复（services 无 child_process import）· locality（npm 下载+解压+校验收敛）· 健壮性（打包环境不依赖 npm/tar CLI）· 测试面（in-memory port adapter）

---

## Worth exploring（5 个）

### [x] R8 · 深化 RpcClient 为 transport + command gateway — ✅ 已完成（cw-2026-07-13-close-rpc-escape-hatch，4 commits d788b4ff+6ffaca5c+06684876+7a6ef75d）

- **文件**：`packages/runtime/src/infra/pi/rpc-client.ts`（455，4 类职责混一类）· `packages/runtime/src/services/ports/pi-engine.ts:87-183`（18 方法宽 interface）· session-lifecycle.ts:172,238（`client.sendCommand('switch_session', ...)` 字面量穿墙）
- **问题**：RpcClient 把 (a) 子进程 spawn/kill/pipe/readline (b) request/response id 关联+超时 (c) 高层命令 (d) escape hatch 全揉一个类。IPiEngine 18 方法扁平摊开。`switch_session` 等 pi 命令字面量泄漏到 service 层；`readRpcData` 的 data/payload 归一样板在 ports 层兜底。
- **方案**：拆 (1) `PiProcessTransport`（spawn/kill/pipe/pending/超时/日志，interface: send/onEvent/kill + 响应归一）(2) `PiCommandGateway`（吸收命令字面量 + 响应解析，实现 IPiEngine 命令面）。service 层只见 `gateway.switchSession(path)` 语义方法。escape hatch 保留给一次性探查。
- **收益**：interface（IPiEngine 命令面收窄自描述）· seam（pi 字面量不泄漏）· 测试面（transport/gateway 独立测）

### [ ] R9 · 拆分 ConfigService 的 4 CRUD 为 2 个内聚 module

- **文件**：`packages/runtime/src/services/config-service.ts`（413）· `packages/runtime/src/services/ports/config.ts` · `packages/runtime/src/services/model-mapper.ts` · `packages/runtime/src/services/scanners/`
- **问题**：facade 门面了 4 个正交关注点，每个是浅委托：Provider CRUD（含 40 行 model merge 埋在薄委托间 :101-139）/ Tool permissions（独立读 config.json）/ Skill 发现（200 行，Map 手工合并）/ Agent 发现。Skill/Agent 的「强制目录 ∪ discovery 目录」优先级合并是两份近似实现。model-mapper.ts 被 config-service 和 model-service 两处消费，owner 不明。
- **方案**：(A) `ProviderModelStore`（吸收 model merge + model-mapper + default model 管理）· (B) `DiscoveryScanner`（吸收 Skill+Agent 目录优先级合并骨架，interface: `scan(type, orderedDirs)`）。Tool permissions 留 ConfigService。
- **收益**：locality（Provider 写入逻辑不再藏于薄委托）· leverage（model-mapper 单 owner）· 测试面（优先级合并独立测）

### [ ] R10 · 消除 sessionId 5 层 prop drilling

- **文件**：prop drilling 链 `Panel.vue` → `MessageStream.vue` → `Turn.vue` → `Block.vue`（:150 纯透传）→ `MarkdownRenderer.vue`（:59 消费）· 同类 `ChangeSetCard.vue`（:62，仅 drawer.open 用不到 sessionId）
- **问题**：sessionId 从 Panel 一路透传 5 层。Block.vue 的 `sessionId` prop 唯一用途是透传——教科书级 prop drilling = seam 泄漏，Block 是浅 module（只做转发）。中间组件 interface 被无意义撑宽。
- **方案**：Panel 层 `provide(SESSION_CONTEXT_KEY)`，叶子组件 `inject`。Block/Turn 去掉 sessionId prop。双 panel 各自 Panel.vue 实例，provide 边界正确。
- **收益**：locality（数据流变更改 provide + 消费者）· interface（Block/Turn props 缩）· seam（session 上下文成显式注入点）
- **注**：provide/inject 略增测试成本（需 provide mock），对面板级单例上下文是 Vue 惯用模式。

### [ ] R11 · 消息类型 renderer 注册表

- **文件**：`packages/renderer/src/components/panel/MessageStream.vue:18-37`（4 路 v-if 硬编码）· `packages/renderer/src/components/panel/message-stream/Turn.vue`（444，user/assistant/summary/changeSet 混一组件）· `packages/renderer/src/components/panel/message-stream/GuiComponentRenderer.vue:35-63`（已有 BUILTIN_MAP 注册表模式，仅 GUI 子组件）
- **问题**：内容路由分两层两套机制——MessageStream 模板硬编码 v-if 分发（不是注册表，新增卡片改模板 + toRenderItems 两处）；Turn 内部再分叉。对比 GuiComponentRenderer 的 BUILTIN_MAP + CUSTOM_MAP 是正确深 module 形态，但没上提到消息类型粒度。
- **方案**：上提 `messageRendererRegistry`（register(type, component, detect) + resolve(message)）。MessageStream 退化成 `<component :is="registry.resolve(item)">` 循环。Turn 拆 `UserBubble` + `AssistantSummary` + 薄编排器。
- **收益**：leverage（一 registry 服务多调用点）· seam（新消息类型 = 注册，不改模板，开闭原则）· locality（user 气泡 pending/steer 逻辑离开 assistant summary）
- **注**：Turn 拆分需权衡——user/assistant 共享 useCopy/isSessionActive，拆后各自取可能增 store 访问点。

### [ ] R12 · 从 SideDrawer 容器抽出 useDrawerWidgets

- **文件**：`packages/renderer/src/components/panel/SideDrawer.vue`（410）· widget 缓冲 :246-310 · 订阅编排 :319-352 · status 聚合 :294-301 · 容器职责 :19-131 + :176-194 + :371-388
- **问题**：三类互不相关职责：(1) drawer 容器（布局/动画/ESC/钉住/tab 栏）(2) widget 数据缓冲层（terminal/browser/gui 三 ref + widgetKey→tab 启发式路由 + 1000 行截断 + status 聚合，约 130 行）(3) tab 内容路由。`mapWidgetKeyToTab` 注释明确写「NFR Prototype 1 枚举对齐前的过渡方案」——会演化的 seam 却无 module 边界。
- **方案**：抽 `useDrawerWidgets(sessionIdRef)`（interface: terminalLines/browserLines/guiWidgetsByTab/statusEntries），吸收 widgetKey 路由 + 截断 + 订阅 + status 聚合 + sessionId 切换清空。SideDrawer 退化成容器 + tab 路由（410 → 约 220 行）。
- **收益**：locality（widget 协议解析隔离）· 测试面（mock session events 单测路由/截断）· leverage（缓冲逻辑可复用于全屏 terminal）

---

## Speculative（未入选 HTML，备查）

源自 subagent 报告但强度较低，记录在此供后续参考：

- **深化 ISessionService facade**：context 用量状态机（inputTokens 缓存 + contextWindow 解析 + usagePercent + 竞态保护）散在 facade 五处，`ISessionService` 把内部状态操作也暴露成 public。抽 `ContextUsageTracker` 深模块。Speculative——facade 虽宽但 work，ADR-0002 的提取按职责分（已做完三类），是否再提一块需权衡碎片化。
- ~~**pi-protocol 类型层近乎 dead module**~~ — ✅ 已完成（cw-2026-07-13-pi-protocol-real-contract，commits e1a74ef4 + 1c561f6e + 1c3ece7e）。走向 A：深化为真契约。PiEvent 联合 13→23 成员，PiUsage/AgentEnd/ToolResult 字段对齐 pi 源码，event-adapter 15 handler 窄化 + 删 4 处防御性双读。ADR-0033 推翻 ADR-0003。
- **深化 ExtensionService**：827 行最大文件，12 公开方法 + 38 次 `*Sync()` + tempDir 两阶段协议跨 transport 耦合。文件系统操作下沉新 port `IExtensionInstaller`。
- **深化 NpmInstaller SSRF/HTTP 层**：495 行，15 module-level 函数散布，状态经参数传递。收口为 `NpmRegistryClient` 深模块 + `isValidPiExtension` 提升为共享 value object。已被 D26 重构过，边际递减。
- **深化 ExtensionTimeoutManager**：118 行，9 方法，时序协议（register→markTimedOut→isTimedOut→clearTimedOut）泄漏到 transport。收口为 `RequestLifecycle`（register 返回 `{onTimeout, onResponse}`，2 方法）。出双响应 bug 时才值得做。
- **内联 chat-readers.ts**：10 个 1-3 行 payload-reader 单消费者浅 helper，打破 locality（理解 message.complete 要在 effects + readers 两文件跳）。deletion test 复杂度不转移。可内联回 chat-message-effects.ts。
- **session.* 事件 dispatch 深化为注册表**：补完 F2 未竟——useChat 的 session.* inline switch（5 case）对齐 message.* 已完成的 effect 注册表。新增 session.* type 从改 switch 降为注册表加一行。需权衡 store 隔离边界（ADR：stores 禁互相 import）。

---

## 建议执行顺序

> 已完成：R1 + R2 + R5 + R7（deep-module 旁路修复，cw-2026-07-13-enforce-deep-module-seams）+ R8（关闭 RpcClient 逃生口 + 修 bridge-handler 白等 60s bug，cw-2026-07-13-close-rpc-escape-hatch）+ pi-protocol 真契约（cw-2026-07-13-pi-protocol-real-contract，ADR-0033 推翻 ADR-0003）

1. **R3**：自包含的编辑器合并，kills 循环依赖 hack（forwardRef），无跨模块影响。
2. **R6**：拆 useSidebar god-composable（3 轴 → 3 module），refCount helper 可复用。
3. **R4**：Block 拆分，subagent 独立化收益明确。
4. **R10**：prop drilling → provide/inject，改动面小立即收益。
5. R9/R11/R12 按 Worth exploring 优先级，触碰对应区域时顺手做（R9 ConfigService / R11 renderer 注册表 需先 grilling 讨论决策点）。
6. Speculative 组（ISessionService facade / ExtensionService / NpmInstaller / TimeoutManager / chat-readers 内联 / session.* 注册表）按需推进。
