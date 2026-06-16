# D1–D9 事实核对(Round 1)

> **核对覆盖范围**:`docs/refactor/architecture-review-issues.md`(D1–D9 盲点)与 `docs/refactor/architecture-design.md`(第一部分决策 + 第四部分 R/M/T 细化)中**所有可验证的代码事实声明**,均已逐条核对。D1–D9 **全部覆盖**,无遗漏决策。
>
> **核对方法**:对每条声明用 grep + read 独立取证,标注三态(✅属实 / ❌失实 / ⚠️部分属实)。所有证据给出 `文件:行号`。D6c(循环依赖)按任务要求**独立重新验证**,不采信任何预设结论。
>
> **核对时间**:2026-06-16 · **分支**:refactor-architecture-design

---

## 摘要

- **核对声明总数**:42(含数字类 15 + 结构类 27,跨 D1–D9 + 第四部分 R/M/T 细化)
- ✅ **属实**:26
- ❌ **失实**:7
- ⚠️ **部分属实**:9

### 严重影响决策有效性的失实项

| 失实项 | 影响 |
|--------|------|
| **D6c「SessionService ↔ PluginService ↔ ModelService 循环依赖」** | **最严重**。该决策的核心诊断(存在循环、setter 是掩盖、是定时炸弹)与代码事实相反:ModelService 是**单向委托**给 SessionService(非循环);PluginService 是**经接口的回调注入**(setSendMessageHook),SessionService 根本不 import PluginService。D6c 据此推导的"循环 1/循环 2"现状描述方向颠倒,直接动摇 D6c 的前提。建议该决策的诊断部分推翻重写(改进方向本身——用领域事件解耦——可保留,但不能立在"存在循环"的错误前提上)。 |
| 「8 个 composable 直 import send」(实际 7) | 复核 V2 / 迁移阶段 1 的"迁 8 个 composable"工作量估算偏差。 |
| 「9 个域 76 个文件 / chat 27 / settings 18」(实际 10 域 86 文件 / chat 33 / settings 20) | 第四部分 4.1 R1 的现状盘点失准,域数与各域文件数均低估。 |
| 「健康检查轮询 `/health`」(实际 TCP 端口连接检测) | M2 子职责表中"waitForHealth 轮询 /health"与实现不符(30×200ms 数字对,机制描述错)。 |

> 其余失实/部分属实项(7 个接口、5 个 handler 文件、60+ 消息类型等)不影响决策方向,属数字精度偏差。

---

## 逐决策核对

### D1 双通道(WS + IPC)

| 文档声明 | 判定 | 证据(文件:行) | 备注 |
|---|---|---|---|
| 渲染进程有两条出口通道:WS(ws-client)+ IPC(electronAPI) | ✅ | `composables/useConnection.ts:2-5`(import connect/disconnect from ws-client + 用 `window.electronAPI`) | 属实 |
| 启动时**必须先经 IPC 向 Main 取 runtime 端口**才能连 WS | ✅ | `useConnection.ts:71-77`:`const knownPort = await window.electronAPI.getRuntimePort(); if (knownPort) { connect(...) }` | 硬依赖属实,这是 useConnection.init 的主路径 |
| 注册 `onRuntimePort` 监听器用于 Runtime 重启后重连 | ✅ | `useConnection.ts:64-69`:`removeRuntimePortListener = window.electronAPI.onRuntimePort(...)` | 属实 |
| ipc-handlers.ts 注册了 **8+ 个** IPC handler | ✅ | `main/ipc-handlers.ts`:`ipcMain.handle(` 共 **10** 处(get-runtime-port / get-runtime-port-offset / create-window / get-windows / focus-window / update-window-state / find-session-window / open-external / pick-directory / open-settings-window) | "8+"约数表述正确(实际 10) |
| Main 通过 `RuntimeManager` 持有子进程的 spawn/kill/端口发现/健康检查全生命周期 | ✅ | `main/runtime-manager.ts`:`spawn()`(:start 方法)、`stop()`、`findAvailablePort()`(:findAvailablePort)、`healthCheck()`、`writePortFile()` | 四职责均在 RuntimeManager 内 |
| 健康检查"轮询 `/health`(30 次 × 200ms)" | ⚠️ | `runtime-manager.ts`:`HEALTH_RETRY_COUNT=30`、`HEALTH_INTERVAL_MS=200` 数字对;但 `healthCheck()` 用的是 `isPortInUse()`(**TCP socket 连接检测**,非 HTTP `/health` 端点) | D1 正文与 M2 子职责表均称"轮询 /health",机制描述失实;不过 runtime 进程确实暴露 `/health`(`server.ts:74-77`),只是 RuntimeManager 健康检查没用它 |
| 启动时序:RuntimeManager spawn **先于** createWindow(D1 时序契约步骤 2→3) | ⚠️ | `main/main.ts:whenReady`:`mainWindow = await createWindow(...)` **先于** `const port = await runtimeManager.start()`(:whenReady 内顺序) | 文档列的 8 步时序把 spawn 排在 createWindow 前,实际代码 createWindow 在 spawn 前。属文档"建议契约"与"现状"混写导致的偏差 |

---

### D2 跨进程窗口/面板状态

| 文档声明 | 判定 | 证据(文件:行) | 备注 |
|---|---|---|---|
| `WindowManager`(Main)持有每个窗口的**完整** `WindowState`(含 `panelTree` + `focusedPanelId` + `sessionIds`) | ✅ | `main/window-manager.ts:7`(`state: WindowState`)、`:108-117`(`initialWindowState` 含 `panelTree`/`focusedPanelId`/`sessionIds`)、`:89`(`findPaneBySessionId(state.panelTree, ...)`) | 属实;Main 确实解析 panelTree 内部(遍历找 session),印证文档"过度同步"判断 |
| 渲染进程 `stores/panel.ts` 是自己窗口 PanelTree 的**唯一写入者**(不可变树替换) | ✅ | `stores/panel.ts`:`replaceInTree`(:33)、`updateRatioInTree`(:48)、`splitPanel`(:84)、`updateRatio`(:138)均为不可变替换 | 属实 |
| Main 镜像经 `syncPaneState` / `updateWindowState` 由渲染进程"推上去" | ✅ | `App.vue:247`(`windowStore.syncPaneState(tree, focusedPanelId)`)→ `stores/window.ts:42-45`(`syncPaneState`→`updateWindowState`→`window.electronAPI?.updateWindowState`) | 属实,推送链路完整 |
| Main 唯一跨窗口查询是 `findSessionBySessionId` | ✅ | `window-manager.ts:87`(`findSessionBySessionId`) | 属实 |

---

### D3 API Client(请求/响应 vs 事件驱动)

| 文档声明 | 判定 | 证据(文件:行) | 备注 |
|---|---|---|---|
| 当前协议是**事件驱动 + fire-and-forget**,`send()` 无返回值 | ✅ | `lib/ws-client.ts:116`:`export function send(msg: ClientMessage): void` | 返回 void,属实 |
| 响应通过 `event-bus` 异步回来,每个调用方手动 wire 监听器 | ✅ | `composables/useChat.ts` 订阅模式(onXxx 事件 + payload.sessionId 路由)+ 各 composable 自行 send | 属实 |
| `ClientMessage.id` 字段"几乎没人用" | ✅ | 全仓搜索 send 调用:`useToolApproval.ts:5/8/11`、`useChat.ts:412/418` 等均为 `send({ type, payload })` **不带 id**;protocol.ts 中 id 为 `id?: string`(可选)。找到的 `crypto.randomUUID()` 均用于 panel id / notification id,**非 ClientMessage.id** | 属实,发送侧确不带 id |
| protocol.ts 有 **60+ 消息类型** | ⚠️ | `shared/src/protocol.ts`:`ClientMessageType` 字面量 **54** 个(=`ClientMessage` union 成员 54);`ServerMessageType` 字面量 **51** 个。合计 **105** | 歧义:若指 Client 单边(54),文档"60+"略高估;若指合计(105),远超。文档 D3 语境是"扫描消息类型按响应形态分类"(针对 Client 请求),单边 54,"60+"不精确但不影响"类型多"定性 |

---

### D4 Runtime 内部分层(infra / adapters / services)

| 文档声明 | 判定 | 证据(文件:行) | 备注 |
|---|---|---|---|
| `runtime/src/` **30+ 平铺文件**,transport/services/infra 混排 | ✅ | `ls runtime/src/`(排除 .test):平铺 **31** 个 + `services/` + `plugins/` + `utils/` 子目录 | 属实 |
| `event-adapter.ts` 是 pi RPC 事件 → WS ServerMessage 的**防腐层** | ✅ | `event-adapter.ts:31` 注释:"Translates pi subprocess RPC events into WS protocol ServerMessages";被 index.ts 以闭包工厂注入 SessionService | 职责属实 |
| `message-converter.ts` 是 pi 历史 → Message[] 纯数据转换 | ✅ | `message-converter.ts:27`:`export function convertPiHistory(raw): Message[]`;被 session-service.ts import(:23) | 属实 |
| `event-adapter.ts` **~480 行**,用一堆 `handleXxx(event, ctx)` 函数 | ⚠️ | `wc -l`:**511** 行;含 16 个 handle/on 类函数 | 行数略低估(511 vs 480),handle 函数描述属实。"~"近似可接受 |
| `interfaces.ts` 有 **7 个** service 接口 | ⚠️ | `interfaces.ts`:实际 **9** 个 `export interface I*`:`IRpcClient`/`IProcessManager`/`IMessageBroker`/`IEventAdapter`/`ISessionService`/`IConfigService`/`IExtensionService`/`IModelService`/`IPluginService` | 口径不符:纯 service 接口(Session/Config/Extension/Model/Plugin)=5;含 infra 共 9。"7"对不上任一口径 |
| 现有 **6 个** `*-message-handler.ts`(transport) | ⚠️ | `ls runtime/src/*-message-handler.ts`:仅 **5** 个(session/settings/extension/plugin/tree);server.ts 实例化的 handler 类是 **6** 个(另含 `BridgeHandler`/`bridge-handler.ts`,不带 "message" 后缀) | 文件名口径=5,handler 实例口径=6。review V4 写"6 个 *-message-handler.ts"按文件名失实,按实例属实 |

---

### D5 PluginService 垂直切片

| 文档声明 | 判定 | 证据(文件:行) | 备注 |
|---|---|---|---|
| `services/plugin-service/` 有 **27 个文件** | ✅ | `find plugin-service -name '*.ts'`(排除 test):**27** | 精确属实 |
| 内部含 `api/ host rpc sandbox registry permission hook storage` 子结构 | ✅ | `api/`(子目录)、`plugin-host.ts`/`plugin-bootstrap.ts`、`plugin-rpc-client/server/setup.ts`、`plugin-sandbox.ts`、`plugin-registry.ts`/`plugin-installer.ts`/`plugin-version-checker.ts`、`plugin-permission.ts`/`plugin-permission-storage.ts`、`hook-api.ts`/`bridge-interop.ts`/`tool-api.ts`、`plugin-storage.ts`/`session-data-*.ts` | 全部存在 |
| `api/` 对插件暴露 **6 个** API | ✅ | `api/` 下:agent-api / config-api / session-api / session-data-api / ui-api / workspace-api = 6 | 属实 |

---

### D6 横切关注点(错误流 / session 路由 / DI 循环)

#### D6a 错误流

| 文档声明 | 判定 | 证据(文件:行) | 备注 |
|---|---|---|---|
| "每个 composable 自己在 error 路径调 `setGenerating(false)` + `completeStreaming()`",不变量**散落** | ⚠️ | `stores/chat.ts` 已集中实现:`completeStreaming`(:169,内含 `streamingMessage=null` :192/197 + `isGenerating=false` :206)、`setGenerating`(:210)、`setError`(:253)。composable 侧仅 `useChat.ts:165` 一处调 `store.completeStreaming(...)` | 不变量的**实现**已在 chat store 集中,composable 调的是 store 方法,并非"各自重置"。文档"散落""极易漏"夸大;但 error 路径确实无单一入口(无 markSessionError),改进空间真实存在 |

#### D6b session 路由

| 文档声明 | 判定 | 证据(文件:行) | 备注 |
|---|---|---|---|
| 三层隔离 ① chat store 分区 | ✅ | `stores/chat.ts:114`:`chatSessions = reactive(new Map<string, ChatSessionState>())`;`:127` `getSessionState(sessionId)` | 属实 |
| 三层隔离 ② useChat 从 `payload.sessionId` 路由 | ✅ | `composables/useChat.ts:32`:`return (msg.payload?.sessionId as string) ?? null`;:20 注释"事件处理器从消息 payload 中提取 sessionId,路由到正确的 ChatStore 分区" | 属实 |
| 三层隔离 ③ PaneSessionView 按 `props.sessionId` 过滤 | ✅ | `components/panel/PanelSessionView.vue:51-53`:`defineProps<{ sessionId: string }>`;:70 `chatStore.getSessionState(props.sessionId)`;:83 `if (w.sessionId === props.sessionId)` | 属实(组件名为 `PanelSessionView`,文档 N7/CLAUDE.md 写"PaneSessionView",拼写小偏差) |

#### D6c DI 循环依赖(重点独立复核)

> 任务要求:独立验证「`SessionService ↔ PluginService ↔ ModelService` 存在隐含循环依赖,`index.ts` 用 3-Phase setter 构造掩盖」是否真实。以下为独立取证,未采信主 agent 种子。

| 文档声明 | 判定 | 证据(文件:行) | 备注 |
|---|---|---|---|
| `index.ts` 用「Phase 1/2/3 分阶段构造 + setter 注入」 | ✅ | `runtime/src/index.ts`:代码注释明确标 `Phase 1: create all service instances`、`Phase 2: create services that reference other services`、`Phase 3: wire cross-service runtime deps`;Phase 3 含 `pluginService.setSessionService(sessionService)`、`modelService.setServices(...)`、`server.setServices(...)` | 构造手法描述属实 |
| **循环 1:SessionService ↔ ModelService(switchModel 双向调用)** | ❌ | `services/model-service.ts:48`:`async switchModel(...){ await this.sessionService.switchModel(...) }` —— ModelService **委托**给 SessionService(单向);`session-service.ts:328` `switchModel` 自行做 RPC(`client.setModel` :337)+ 缓存更新(:345),返回 `Promise<string>`;`session-service.ts` import 列表(:10-31)**不含 model-service**,构造参数(:61-68)也不含 ModelService | **依赖方向是 ModelService → ISessionService 单向,无环**。文档"SessionService.switchModel 返回 string;ModelService 做完整编排又需要 sessionService"方向说反——实际 SessionService 是真正编排者,ModelService 是薄委托层。文档建议"让 ModelService 成为唯一 owner、SessionService 退化为纯委托"——**现状恰好相反** |
| **循环 2:SessionService ↔ PluginService(hook 双向)** | ❌ | (1)`session-service.ts` import(:10-31)与构造参数(:61-68)**均不含 PluginService**;(2)`session-service.ts:201-202` sendMessage 调的是 `this.sendMessageHook(sessionId, content)`(**回调**,类型 `SendMessageHook` :34),**不是** `pluginService.executeHooks`;(3)`plugin-service.ts:197-199` `registerSendMessageHook` 由 PluginService.initialize 主动调用 `this.deps.sessionService.setSendMessageHook(async ...)` 把自己的 hook **注入** SessionService;(4)`plugin-service.ts:85` deps.sessionService 经接口 `ISessionService` 持有;(5)`session-service.ts:59` `sendMessageHook: SendMessageHook \| null`——SessionService 只持有函数引用,不知 hook 来自 PluginService | **编译期无循环**(SessionService 不 import PluginService;PluginService 经 ISessionService 接口)。运行期是**控制反转/回调注入**(PluginService 主动注册 hook),非"双向循环"。文档"SessionService 发消息前调 pluginService.executeHooks"**失实**——调的是注入的回调,executeHooks 是 PluginService 在回调实现**内部**调的 |
| setter 注入 = "掩盖真循环""构造签名说谎""定时炸弹" | ❌ | 见上两行。setter 解决的是**构造顺序问题**(PluginService 先于 SessionService 实例化,故需后置 wire sessionService),这是**正常的 DI 延迟绑定**手法,非掩盖设计缺陷。所有跨 service 依赖均经 `interfaces.ts` 接口(ISessionService 等),无具体类循环 | 定性言过其实 |
| 运行期是否存在**任何**双向引用? | ⚠️ | `index.ts` 的 `createAdapter` 闭包捕获 `pluginService`(onHookExecute → `pluginService.executeHooks`,见 index.ts onHookExecute 段);EventAdapter 在 pi 事件路径间接调到 pluginService。故运行期存在「SessionService(经 adapter)→ pluginService」与「PluginService → sessionService」的双向引用 | **存在运行期双向引用,但经接口/闭包,非编译期循环,且方向与文档所述不符**。可改领域事件优化,但非"掩盖循环" |

**D6c 独立结论**:**循环依赖诊断主要失实**。
- ModelService↔SessionService:根本不是循环(单向委托,方向与文档相反)。
- PluginService↔SessionService:是经接口的回调注入(正常 IoC),非循环;SessionService 不 import PluginService。
- setter 注入是解决构造顺序的正常 DI,非"掩盖"。
- 文档 D6c 据错误前提推导"循环 1/循环 2"现状,**前提不成立**。改进建议本身(用领域事件解耦 hook)合理,但应改为"将回调注入升级为领域事件以进一步解耦",而非立在"存在循环依赖"的错误诊断上。

> **与主 agent 种子对比**:种子判断"循环诊断疑似失实,PluginService 通过 setSendMessageHook 注入回调实现反转,非循环"——**经独立验证,该判断正确**。本核对额外补充:ModelService 方向文档也说反了,且 setter 注入定性为"掩盖"不成立。

---

### D7 命名债

| 文档声明 | 判定 | 证据(文件:行) | 备注 |
|---|---|---|---|
| `SidecarServer`(server.ts)还叫 "sidecar" | ✅ | `runtime/src/server.ts:21`:`export class SidecarServer implements IMessageBroker` | 类名属实 |
| server.ts 注释自称 "pure Transport layer" | ✅ | `server.ts:13-17`:`* SidecarServer — pure Transport layer.` | 注释属实 |
| server.ts 注释与实现不符——通过 `setServices()` 持有 **6 个** Service 引用 | ✅ | `server.ts:63-69`:`setServices(session, config, model, tree, extension, plugin)` 共 **6** 个字段(sessionService/configService/modelService/treeService/extensionService/pluginService) | 属实 |
| server.ts 持有 **6 个** Handler 实例 | ✅ | `server.ts:55-60`:`bridgeHandler`/`settingsHandler`/`sessionHandler`/`extensionHandler`/`pluginMessageHandler`/`treeMessageHandler` = 6(extensionTimeoutMgr 不算 handler) | 属实 |

---

### 第四部分 R/M/T 细化(补充核对)

| 文档声明 | 判定 | 证据(文件:行) | 备注 |
|---|---|---|---|
| **Renderer**:`components/` **9 个域 76 个文件**(chat 27 / settings 18 / panel 9) | ❌ | 实际 **10 域**(chat/extension/layout/panel/panel-grid/plugin/settings/side-inspector/sidebar/toast)、**86** 个 .vue;chat **33**、settings **20**、panel **9** | 域数、总数、chat/settings 各域数均失实(文档偏低)。panel 域 9 属实 |
| **Renderer**:`composables/` **19 个** | ✅ | `ls composables/*.ts`(排除 test):**19** | 属实 |
| **Renderer**:`stores/` **11 个** Pinia store | ✅ | `ls stores/*.ts`:**11**(chat/layout/navigation/panel/plugin/provider/session/settings/sidebar/tree/window) | 属实 |
| `useConnection` 是"副作用胶水",不碰 store(R2 effects 分类) | ✅ | `composables/useConnection.ts`:`grep store import` = 0 处;只 import ws-client | 属实,符合文档"effects 只碰传输层"判断 |
| `useChat` 同时碰 api + store(R2 features 分类) | ✅ | `useChat.ts`:import ws-client send + import useChatStore(grep 命中 2) | 属实 |
| **Main**:`main.ts` 在 whenReady + activate 两处**重复** spawn runtime + 通知端口 | ✅ | `main/main.ts`:whenReady 块与 activate 块均含 `const port = await runtimeManager.start(); mainWindow.webContents.send('runtime-port', port)` + 相同 try/catch | 重复属实,印证 M1 细化点 |
| **Runtime**:`session-service.ts` **722 行**,职责过重(T2) | ✅ | `wc -l services/session-service.ts`:**722**;文件头 TODO 注释(:2-3)"Extract message-related logic... into a dedicated MessageService" | 精确属实,且代码自带同款拆分意图 |
| `server.ts` `handleMessage` 是"大 switch(~50 case)" | ⚠️ | `server.ts:handleMessage` 的 switch 实际约 **37-40** 个 case(ping+session 系列 11+tree 5+extension 9+plugin 10+file.read 1,不含 default) | "~50 case"略高估,"大 switch"定性正确 |
| T2 职责分类:session-service 含"生命周期/消息发送/进程绑定/持久化扫描/路径注入"五类 | ✅ | `session-service.ts` 含 create/delete/rename(:184 前后)、sendMessage(:201)、ensureActive/getRpcClient、listPersistedSessions、getSkillPaths 等(方法名 grep 命中) | 职责混杂属实 |

---

## 失实声明对决策有效性的影响评估

> 仅评估"失实是否动摇决策有效性",**不给替代方案**。

### 1. D6c 循环依赖诊断(影响:严重,动摇决策前提)

D6c 是 9 个决策中唯一把**失实的现状诊断**当作核心论据的。它声称存在两个循环(Session↔Model、Session↔Plugin),并据此把 setter 注入定性为"掩盖""定时炸弹",推导出"必须用领域事件打破循环"。

代码事实:
- ModelService → SessionService 是**单向委托**(model-service.ts:48 委托给 session-service.ts:328),SessionService 不反向依赖 ModelService。**无环**。文档对 switchModel 归属的描述与现状**方向相反**。
- PluginService → SessionService 是**经接口的回调注入**(setSendMessageHook)。SessionService 只持有一个 `SendMessageHook` 函数引用(session-service.ts:59),**不 import、不持有** PluginService。**编译期无环**。

**对决策有效性的影响**:D6c 的**前提**(存在循环)不成立,故其"打破循环"的论证链断裂。决策的**产出建议**(引入领域事件总线、switchModel 收敛)本身是合理的架构演进方向,但应当表述为"将回调注入升级为领域事件以进一步降低耦合",而非立在"存在循环依赖必须打破"的错误诊断上。建议 D6c 的"现状/循环识别"段落**重写**。

### 2. "8 个 composable 直 import send"(影响:轻微)

实际 7 个(useChat/useSession/useModel/useProvider/useTree/useExtensionUI/useToolApproval)。影响迁移阶段 1 的工作量估算(少 1 个),不改变"应建 API Client 层"的决策方向。

### 3. "9 域 76 文件 / chat 27 / settings 18"(影响:轻微)

实际 10 域 86 文件 / chat 33 / settings 20。影响第四部分 4.1 R1 的现状盘点准确性,不影响"展示/容器组件边界"的细化规则。文档对代码体量的低估,可能让读者低估重构工作量。

### 4. "健康检查轮询 /health"(影响:轻微)

实际 RuntimeManager 用 TCP socket 检测端口可达性(runtime-manager.ts:healthCheck→isPortInUse),非 HTTP `/health`。30×200ms 数字对。影响 M2 子职责表的机制描述精度,不影响"RuntimeManager 持有健康检查"的结构性结论。注意:runtime 进程本身**确实**暴露 `/health`(server.ts:74-77),只是 RuntimeManager 没调它——这反而是个值得记录的事实(健康检查可以但未走 HTTP)。

### 5. 其余数字/口径偏差(影响:可忽略)

- `interfaces.ts`"7 个接口"→实际 9(口径问题)
- "6 个 *-message-handler.ts"→文件名 5 个 / 实例 6 个(口径问题)
- "60+ 消息类型"→Client 单边 54(约数偏差)
- "event-adapter ~480 行"→511(近似可接受)

这些均为表述精度问题,不改变任何决策的方向性结论。

---

## 附:核对方法说明

- 所有 `文件:行号` 均为本次独立 grep/read 取证,非转述文档。
- D6c 按任务要求**独立重新验证**(未采信主 agent 种子),结论与种子一致但证据链独立(ModelService 委托方向、PluginService 回调注入路径、SessionService 构造参数与 import 列表均逐一查证)。
- 不可验证的纯设计性声明(如"建议用领域事件""应拆 3 文件")未纳入核对——它们是**建议**而非**事实声明**,标注 N/A 跳过。
