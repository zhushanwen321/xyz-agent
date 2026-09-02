# Renderer 深化波次（renderer-deepening）设计

> **一句话结论**：把架构评审发现的 9 项摩擦组织成五组连贯的深化波次——「不变量从注释搬进代码结构、双轨收口到唯一 SSOT、接口恢复诚实、测试面与调用面同 seam」——除两处显式声明的行为纠正（§3.3 D4、D13）外全部行为等价，每波独立交付可回滚。

**层声明**：当前层 = 架构评审候选集（9 候选 + 8 小项，已按共享领地归并为 5 组）；下一层 = 实施计划（unit 拆分 + 测试设计）。本次设计涉及运行时行为断言与数据流，准则 5/6/7 全适用。

---

## §1 背景目标

- **S（情境）**：renderer 重做按 SSOT（docs/architecture/renderer-rebuild-architecture.md）推进中。tc-transport-consolidation 完成后，`packages/core` 已有约 25.5k 行生产代码（transport 连接与协议层、coordination 订阅与路由层、domain 业务域、extension-host、rendering-protocol、foundation、platform），桌面壳 `packages/renderer` 残留约 17.6k 行 composables + 2.5k 行 stores 待逐域绞杀。
- **C（冲突）**：三路架构走查（transport+coordination / domain 集群 / 壳残留+extension-host，全部带文件行号证据）发现 9 项摩擦 + 8 条小项。其中两类反复出真实事故：① **关键不变量靠注释跨文件承载**——selectSession 切入链三份实现已漂移（core 与壳的时序不一致，本设计期实证）；seq 协议散在三个文件，历史 bug（MF-3 基线提前推进、PR #175 回放双实体）全出在交互层。② **绞杀路线的半拉子收口态长期滞留**——command store 双 SSOT 双锁死，builtin tasks 双份声明已漂移，死接口面无人认领。
- **Q（问题）**：怎么把这些修复组织成一次连贯的架构深化，让不变量有代码载体、双轨有终点、测试面与调用面过同一 seam，而不是 9 个互不相干的修补 PR？
- **A（答案）**：五组深化波次（transport 清扫 / 双轨收口 / staging 泛化 / coordination 深化 / session 切入链接地 + chat 接口分层），每组按 locality/leverage 判据定形态，统一真实场景验收门。本文展开这个答案。

### 系统是什么（给不了解背景的读者）

xyz-agent 是 Electron + Vue 3 桌面 AI agent 工作台。前端分两包：**core**（`@xyz-agent/core`，headless 内核：WS 连接、消息路由、订阅状态、业务域 store/composable，零 DOM）与 **renderer**（桌面壳：组件、壳装配 composable、Electron 平台适配）。运行时后端（runtime 进程）经 WebSocket 推送消息，前端链路为 `ws-client → routeInbound 分发 → events 三通道（session/global/crossSession）→ domain store/effects`。

本设计的「使用者」是**后续开发与维护这段代码的工程师**（含 AI agent）——终态章节从他们做五件典型任务时的体验倒推。

### 设计目标

- **G1 一处改**：Session 切入链、seq 协议、入站路由知识各有唯一代码载体——改一处即全效，不靠注释跨文件同步。
- **G2 一个 SSOT**：command/fileSearch 双轨收口；新增 server-push 消息类型 = 一行声明式条目 + 一个 effect 函数。
- **G3 诚实接口**：接口不宣告不存在的能力（死面清零）；chat store 消费方只学自己那面。
- **G4 测试面 = 调用面**：use-connection / seq 协议的测试经 seam 注入，不再 mock 四个模块内部。
- **G5 零行为回归**：除 §3.3 D4（切入链时序纠正）与 D13（branchSummary entry 化）两处显式声明的行为变化外，全部改动行为等价。
- **G6 每波独立可交付、可回滚**（沿用逐域绞杀纪律）。

### In-scope

五组全部内容：组 1（transport 不变量清扫 + use-connection 测试 seam 复位）、组 2（command/fileSearch 双轨收口）、组 3（composer staging 泛化 + 类型收敛）、组 4（seq 协议归位 + route-inbound 三结构归一）、组 5（selectSession 切入链接地 + legacy useSidebar 删除 + chat store 接口分层 + chat 域内三小件：branchSummary entry 化、effects 骨架 helper、apply-entry 投影 builder）。

### Out-of-scope（附理由，防 scope creep）

- mock 轨与 real 轨语义对齐（评审 Card 9）——有 go/no-go 抉择，挂起到 P3 chat 域迁移波再议。
- core root barrel 公共面治理（11 个 `export *`）——P6 清尾项，当前靠约定维持且现状干净。
- settings/compat-fields.ts 归位——随未来 ui 包 feature view 迁移带走，不单独动。
- new-task-search flow.ts 聚合返回面收窄——登记观察，无事故证据。
- mobile 壳对接 core bootstrap——沿用既有排期（tc-transport-consolidation out-of-scope 组 3）。

---

## §2 现状与问题分析

**结论：全部 9 项摩擦可归约到两个根因——R1「不变量无代码载体」（跨模块调用序、协议配对、常量双写只靠注释同步，必然漂移出事故）与 R2「收口态无终点」（绞杀中间态没有显式收口节点，半拉子态长期滞留并持续产生维护税）。**

以下八组现状例子全部取自当前代码（分支 refactor-renderer-architecture，HEAD f86f2c1），行号已逐条核实。

### 术语锚定（首次出现，后文复用）

- **Session 切入链**：用户在侧栏点选一个 session 后，前端必须按固定顺序执行的动作序列（取消新建任务流 → 通知 runtime 切换 → 置 activeId → 清未读 → 建立流订阅 → 更新 LRU → 载入 panel → 推导航 → 回填历史 → 预载文件树 → 保护 panel 绑定 session → LRU 驱逐）。就是 §2 例 1 里那 12 步。当前它**没有任何单一代码载体**。
- **seq 协议**：server-push 消息序号（per-session）的去重、缺口检测与自愈回拉规则。物理上散在三个文件（例 2）。
- **ROUTE_TABLE / CROSS_SESSION_TYPES / FALLBACK**：入站消息分发的三套并存结构（例 3）。
- **双轨**：同一概念两份真实现同时活着、各自有生产消费方（例 4）。

### 例 1：Session 切入链——三份实现，两处已漂移（R1 最重实例）

同一条链现在有三份物理拷贝，且顺序已不一致：

- **core 版**（`packages/core/src/domain/session/use-session.ts:224-256`）：`switchSession → setActiveId → hydrate/reconcile → syncSessionToPanel → navigation.push`——**hydrate 先于 panel 载入**。
- **壳新版**（`packages/renderer/src/composables/features/sidebar/useSidebarNew.ts:207-248` postLoadSession）：`clearUnread → ensureStreamSubscription → touchLru → syncSessionToPanel → navigation.push → hydrate → loadTree → touchLru(panel 绑定) → evictIfNeeded`——**panel 先挂载、历史异步回填**。
- **壳旧版**（`packages/renderer/src/composables/features/sidebar/useSidebar.ts:160-219`）：与新版逐字同构，仍被 1 个生产消费方（`useChatViewDeps.ts:34,63`）+ 6 个测试文件使用；useSidebarNew 已被 46 个文件消费。

链条上的时序前提只存在于注释，且是两处事故伤疤：

- `useSidebarNew.ts:196-197`：「ensureStreamSubscription 须先于 syncSessionToPanel（C-W3-4）——panel 载入后 MessageStream 挂载，订阅必须先就绪否则 snapshot 回放事件被丢（2026-07-29 handoff 回复丢失事故）」。
- `useSidebar.ts:211-218`：「[lru-panel-exempt-fix] evictIfNeeded 前刷新 panel 绑定 session 的 LRU recency……若加 panel 检查会让 deleteSession 流程中被删 session 被 exempt 拦截 → 内存泄漏」。

另有一笔登记在案的接缝债：`useSidebarNew.ts:302-304`——deleteSession/deleteFolder 的 wasActive 回退走 core.selectSession 的 headless 路径，**缺 ensureStreamSubscription**（回退后新 session 无流订阅），注释自述「w5 接缝期接受」。

### 例 2：seq 协议——判定、副作用、簿记散在三文件（R1）

- `packages/core/src/coordination/seq-gap.ts:39-66`：evalSeqGap 纯函数，只做六分支判定（drop / pass / pass+reconcileFromSeq），不碰状态。
- `packages/core/src/coordination/route-inbound.ts:154-184`：applySeqGap 执行副作用（drop 返回 / `recordGapDispatchedSeq` 簿记写入 / fire-and-forget reconcile / `updateLastSeenSeq` 基线推进），其中 `:161-176` 是一段 16 行的时序论证注释，逐字解释 MF-3（基线提前推进会让 reconcile 失败后缺失段永久不可恢复）与 PR #175 R1（gap 触发消息与回放双实体）为什么不能那么改。
- `packages/core/src/coordination/subscription-state.ts`：簿记收敛与清理（`:228-244` max 四源收敛 + gap 簿记配对清理）、`updateLastSeenSeq` 顺带清理（`:304-315`）、`resubscribeAll` 的「先重置 {0,false} 再发 RPC」语义（`:342-356`）。

**真实失败模式**：MF-3 与 PR #175 R1 都不是 evalSeqGap 判定错误，而是「判定 + 簿记写入 + 收敛清理」三者配对在跨文件交互层出错——纯函数单测测不到这类 bug。

### 例 3：入站路由——一条消息的知识分三套房（R1）

`packages/core/src/coordination/route-inbound.ts`（443 行）：

- `ROUTE_TABLE`（`:199-280`，6 个 type 带 effect）；`CROSS_SESSION_TYPES`（`:297-308`，8 个 type 只声明「额外 dispatchCrossSession」）；`FALLBACK`（`:320-343`，恒真兜底）。表外还有 pending 分流（`:431-435`）。
- `'error'` 的完整生命周期要读两处：有 sid 支在表条目（`:264-279`），无 sid 支在 FALLBACK（`:338-342`）。
- 「精确匹配」的实际语义是「type ∧ 有 sid」——查表被 sid 门控（`dispatchRouted :398-412`），合取条件不在表声明里；6 个条目各自重复同一段 `if (!sid) return` 防御。
- `CROSS_SESSION_TYPES` 的注释自证表达力不足（`:294-296`）：「不进 ROUTE_TABLE……硬塞会产出雷同 handle 函数」。

### 例 4：command / fileSearch 双轨——同一概念两个 SSOT（R2 最重实例）

- `packages/renderer/src/stores/command.ts`（194 行，pinia 全量实现）vs `packages/core/src/domain/new-task-search/command-store.ts`（277 行，factory 全量实现），各自持有 `commandsBySession` + `appCommands` 缓存。core 版文件头注释自述「renderer 旧 store 保留，待消费方迁移完成后删除」（`:6`）。
- 消费方在同一个 feature 目录内分裂：`features/search/useSearchJump.ts:29`、`useSearch.ts:40,71` 走壳轨；`features/command/useCommandStore.ts:16`、`useSearchModalDeps.ts` 走 core 轨。CommandPopover（壳轨）与 SearchModal（core 轨）数据可发散。
- fileSearch 同构小一号（`stores/fileSearch.ts` 41 行 vs core file-search-store.ts）。

### 例 5：composer 镜像重复与类型抄写（R2）

- `packages/core/src/domain/composer/dispatch/fork-mode.ts`（241 行）× `handoff-mode.ts`（280 行）：约 75% 逐字镜像（enter/exit/signal watch 守卫/handleEsc/handleSend 骨架/modeRef getter），注释自证「与 fork handleForkSend 对称」（handoff-mode.ts:205/211）。
- `ComposerInputInstance` 类型散布：权威宽接口已在 `composer/types.ts:173`（ADR-0058 归位），另有 6 处局部声明——`dispatch/send.ts:32`、`submit.ts:26`（均 `{getSegments}`）、`fork-mode.ts:40`、`handoff-mode.ts:38`（`{focus?}`）、`context/injection.ts`、`context/context-chips.ts:29-32`（`{getSegments; removeImageChip}`，已带意图注释——恰是有意窄契约的已达标样例）。局部声明多为有意的结构子类型窄契约（各模块只声明所需最小面），但与权威接口的关系零注释（context-chips 除外）——读者无法区分「有意窄契约」与「漂移抄写」；要消灭的是无名分的复制，不是窄契约本身。

### 例 6：chat store 公共面——64 项混装（R2）

`packages/core/src/domain/chat/store.ts:868-931` 的 return 面约 64 项：状态 refs 10 + 读方法约 9 + ops 约 30 + LRU 四件套（touchLru/evictIfNeeded/evictSessionWithVirtual/evictVirtualKey）+ timer 三件套（armStreamingTimer/armBashTimer/clearBashTimer）+ 测试逃生舱 2 项（`_sessionStreamingFlagsForTest`/`_entryStatesForTest`）。

已实证：timer 三件套**生产外部消费方为零**（全仓 grep 含测试，仅 core/domain/chat 内部经 effects ctx 消费，ctx 由 store 闭包构建——store.ts:613/:713）；另有 2 个测试文件经公共 return 面消费（`renderer/src/__tests__/useChat.test.ts:266`、`renderer/src/__tests__/stores/chat-dispose-session.test.ts:41`），剪枝时需连带改指（D6①）。LRU 四件套被壳直取且带时序前提（useSidebar.ts:174,215-218），是例 1 的组成部分。

### 例 7：死面与注释同步的不变量（R1+R2 混合）

- `disconnected` 错误构造 4 处手写 `Object.assign(new Error(...), { code: 'disconnected' })`：`transport/api/request.ts:56-59`、`transport/use-connection.ts:276-281/289-291/309-315`，靠三份注释互相对齐；识别方靠 `error.code === 'disconnected'` 字符串约定，任何一处改字面量即静默失配。
- EXTENSION_BRIDGE_TYPES 白名单双写：壳 `useExtensionHostBridge.ts:76-82` 与 core `message-bus-bridge.ts:324-330`，靠注释保持 5 项一致。
- core 内部经自身 barrel 回引成环：`domain/chat/lru.ts:25`、`changeset.ts:25`、`timers.ts:13`（+ transport/mock 3 处）import `@xyz-agent/core`——index.ts re-export lru，lru 又 import index，运行期不炸但 ESM 序隐患。
- 死面：`events.ts:60-62` 的 `dispatch` 兼容别名生产零调用；`use-connection.ts:77` ConnectionPorts.toast 死字段（壳装配被迫提供 useToast()）；`platform/port.ts:55-67` PlatformPort.ipc 双壳注入 null、core 零消费（接口宣告不存在的能力）；`extension-host/builtin/tasks/manifest.ts` 118 行生产零消费且形状已漂移（slashCommands name 前导 `/` 不一致）；`domain/session/effects/panel-orchestration.ts` 是 widget 删除后的纯 interface 残渣；`extension-host/activation-manager.ts`（64 行）生产注入 no-op trigger（useExtensionHostBridge.ts:290-292）、registerActivationEvents 生产零调用——休眠模块未标记，读者会误判为已生效机制。

### 例 8：use-connection 测试 seam 退化（R1 的测试面形态）

`packages/core/src/transport/use-connection.ts` 的 `ensureDispatcher`（`:175-182`）在收口后只接受 ConnectionPorts.effects；其测试（`transport/__tests__/use-connection-reconnect-resubscribe.test.ts:44-86`、`use-connection-clear-pending.test.ts:29,57`）需要 `vi.mock` 四个模块内部（ws-client / api/pending / api/events / domains/session）才能构造。连带扭曲：route-inbound 的 subscribe 被迫用动态 import 惰性解析（`route-inbound.ts:351-363`），注释自述是为保护 renderer 测试对 ws-client 的 vi.mock 拦截链。

### 物理数据流（准则 5）

**入站消息流（现状）**：

```
runtime 进程（WS push）
  → packages/core/src/transport/ws-client.ts onMessage（单槽）
  → coordination/route-inbound.ts routeInbound
      ├─ pending 分流（msg.id 命中 → resolveEnvelope，D7 id/seq 互斥）
      ├─ dispatchRouted（sid 为真才查 ROUTE_TABLE ← 合取条件藏在这）
      │     └─ 条目 handle：applySeqGap（← seq-gap.ts 判定 + subscription-state.ts 簿记/基线，协议散三文件）
      │           → events.dispatchSession → effect 回调
      ├─ FALLBACK：有 sid → applySeqGap → dispatchSession（+ CROSS_SESSION_TYPES 查 Set → dispatchCrossSession）
      │           无 sid → dispatchGlobal + L9 warn + error → onGlobalError
  → transport/api/events.ts 三通道（session / global / crossSession）
  → domain store / effects（chat store、extension-host 等消费者）
```

**Session 切入链（现状，跨四层无单一载体）**：

```
用户点侧栏 session
  → 壳 features/sidebar/useSidebarNew.postLoadSession（或 legacy useSidebar.selectSession，或 core use-session.selectSession——三份，时序已漂移）
      ├─ new-task-search 域：cancelFlow
      ├─ transport/api domains：switchSession / getHistory RPC
      ├─ session 域 store：setActiveId
      ├─ 壳 composables：clearUnread / useFileTree.loadTree
      ├─ chat 域：ensureStreamSubscription / touchLru / evictIfNeeded / reconcileHistory
      ├─ 壳 stores：panel.loadSession / navigation.push
      └─（deleteSession 回退路径走 core 版，缺 ensureStreamSubscription——接缝债）
```

### 根因分析（MECE）

- **R1 不变量无代码载体**：跨模块调用序（例 1）、协议配对（例 2）、常量/构造约定（例 7 前半）只靠注释同步。注释不参与编译，漂移无信号——例 1 的 core/壳时序漂移就是实证。
- **R2 收口态无终点**：绞杀路线的中间形态（双轨例 4、镜像例 5、宽接口例 6、死面例 7 后半、测试 seam 退化例 8）没有显式收口节点，每滞留一天就产生一天维护税，且随消费方增长收口成本单调上升。

---

## §3 解决方案

### 3.1 终态（开发者视角先行）

**结论：落地后，六件典型任务的体验从「先考古注释、再同步多处」变为「改一处、测一处」。** 以下每个场景给出成功路径与失败路径（带恢复指引，准则 6）。

**场景 A：新增一个 server-push 消息类型**（回溯 G2）
成功路径：打开 `route-inbound.ts`，在路由表加一行声明式条目（type + 可选 sessionEffect/crossSession/payloadGuard），如需兜底回调就在壳 effects 装配处加一个函数。seq 门控、无 sid 兜底、crossSession 分发由 dispatcher 统一承担，不用读懂三套结构。
失败路径：type 字符串写错 → 消息落默认路径（语义同现状 FALLBACK），若属 session.*/message.* 前缀且无 sid 会打 L9 warn → 恢复：对照 runtime event-adapter 的实际 type 修正条目。

**场景 B：改切 session 的时序**（回溯 G1）
成功路径：改 `core/src/domain/session/use-session.ts` 的切入链一处，壳、headless、mobile 三条路径同效；12 步顺序有接口级单测断言（记录型 fake 端口回放调用序），改错顺序测试即红。
失败路径：某步失败各有恢复——switchSession 失败抛错由 UI 层捕获（现状语义不变）；hydrate 失败标 failedHistory，landing 显重试按钮；subscribe 失败 console.warn 且 WS 重连后 resubscribeAll 重建。

**场景 C：排查「丢消息 / 消息重复」**（回溯 G1/G4）
成功路径：只读 `coordination/subscription-state.ts` 一个模块——判定、簿记写入、收敛清理、重置语义同处；MF-3 类回归有接口级测试（feed gap 消息 → 断言 reconcile 意图 + 簿记；模拟 reconcile 失败 → 断言基线原位）。
失败路径：测试红 → 断言消息即指向被破坏的协议条款。

**场景 D：新增一个 composer staging mode**（回溯 G5 行为等价下的 leverage）
成功路径：写一份配置对象（文案 + 目标 action + 少量差异点），传给 createStagingMode；enter/exit/watch 守卫/Esc/send 骨架不再抄写。
失败路径：配置缺必填字段 → 编译期类型报错，按报错补齐。

**场景 E：写一个新的 chat store 消费组件**（回溯 G3）
成功路径：只面对 readers 面（facet 类型）；ops 面在组件层不可见（lint 规则拦截）。
失败路径：组件误用 ops 字段 → lint 报错并指向 facet 定义文件。

**场景 F：改 command 行为**（回溯 G2）
成功路径：只改 `core/domain/new-task-search/command-store.ts`，CommandPopover、SearchModal、new-task 流程三处同步生效。
失败路径：typecheck 覆盖全部消费方，改坏即编译红。

### 3.2 多方案对比（整体策略）

| 方案 | 长期架构 | 短期成本 | 风险 | 裁决 |
|---|---|---|---|---|
| **A. 五组连贯深化（本设计）** | 不变量入代码、双轨归零、接口诚实——root cause R1/R2 均被消除 | 五波，每波 0.5-3 天量级 | 两处行为纠正（D4/D13）需验收门兜底 | ✅ |
| B. 逐组独立修补 PR | 每组各自合理，但共享文件（route-inbound.ts、use-connection.ts）反复挨刀；切入链与 chat 接口的联动（LRU 吸收）无人编排 | 单看每 PR 更小 | 顺序错配导致重复手术；时序漂移窗口拉长 | ❌ |
| C. 并入 P3 逐域绞杀不单独做 | 绞杀是迁移不是深化——tc 波次已实证「迁移只搬运不改组织」（注释时序债被原样搬进 core） | 零新增 | R1/R2 根因永存，双轨随迁移扩散 | ❌ |

**推荐 A**。理由：R1/R2 是结构性根因，B 不解决顺序依赖（Card 8 依赖 Card 1 吸收 LRU 后才好分层），C 被 tc 波次的实测证据否定（迁移不修复组织问题）。

若用 B：§2 例 1 的切入链接地（组 5）与 chat store 分层（组 5b）被拆成两个独立 PR 后，LRU 四件套的归属会出现第三个中间态；若用 C：例 4 的 command 双轨会随 search 域迁移被搬进新结构继续双锁死。

### 3.3 关键决策与权衡（四件套）

**D1：seq 协议吸收入 subscription-state（组 4a，选定）**
- **采用**：evalSeqGap 六分支判定、gap 簿记写入/清理、基线推进/重置语义全部收进 `coordination/subscription-state.ts`（它本来就持有 subscriptionStates Map——让状态所有者同时持有协议）。对外暴露一个 gate 函数（sid + msg → dispatch/drop + reconcile 意图）；route-inbound 的 applySeqGap 缩成「gate 调用 + reconcile 触发」。判定表保持纯函数内嵌，逐字不动。
- **被否**：① 独立 SeqTracker per-session 控制器模块——tracker 与 state 之间只有一个 adapter，按 one-adapter 原则是假想 seam，不建；② 维持三文件现状——MF-3/PR#175 证明交互层是事故高发带。
- **证据**：三文件现状 §2 例 2；16 行时序注释 route-inbound.ts:161-176。
- **效果**：G1/G4——协议一处改一处测；MF-3 回归变接口级测试。

**D2：route-inbound 改声明式条目（组 4b，选定）**
- **采用**：ROUTE_TABLE 条目从 handle 函数改为声明 `{ sessionEffect?, globalEffect?, crossSession?, payloadGuard? }`；dispatcher（现 dispatchRouted）持有唯一 prologue：有 sid → seq gate → dispatchSession → crossSession? → payloadGuard 过 → sessionEffect?.()；无 sid → dispatchGlobal → globalEffect?.() → L9 前缀 warn。**守卫归宿**（两类语义不同，分置）：**跳过型**守卫（`:227` subagents 的 Array.isArray、`:241-243` subagentEntriesAppended 双重守卫——坏形状 → 不调 effect、dispatch 照常）收进条目声明 `payloadGuard`（布尔门），由 dispatcher 在 dispatch 之后、effect 之前统一执行；**整形型**守卫（`:276` error 的 `typeof payload.message === 'string' ? … : 'Unknown error'`——message 非法时**仍调** onSessionError 传兜底值，非跳过）留在 sessionEffect 的参数构造处，不入 payloadGuard（布尔门承载不了参数兜底）。payloadGuard 只门控 effect 调用，不门控 dispatchSession/crossSession 分发。「坏形状跳 effect 保 dispatch」（per-session 订阅者可能自带消费逻辑）语义留在 core 单点。`'error'` 收敛为一个条目（sessionEffect=onSessionError，globalEffect 内含 `!msg.id` 守卫）；CROSS_SESSION_TYPES 的 8 个 type 变 8 条 `crossSession: true` 声明；未命中条目走 dispatcher 默认路径（语义 = 现 FALLBACK）；pending 分流保留在表外（D7 id/seq 互斥不动）；hasOwnProperty 守卫（:403）保留；replay 共享路径（setSubscriptionPorts :417-420）不动。
- **被否**：① handle + 共享 prologue helper——条目仍各持函数体，「type ∧ sid」合取仍不可见；② 守卫移入壳装配的 effect 函数——core 失去防御且多壳重复挂守卫，削弱 G1「知识唯一载体」；③ 维持三结构——例 3 的 error 双处定义与 6 处重复防御永存。
- **证据**：route-inbound.ts:199-343 三套并存 + :294-296 注释自证表达力不足；两类形状守卫——跳过型 :227/:241-243、整形型 :276（坏形状行为已被 route-inbound.test.ts:293-305 与 :348-351 锁定，P3 探针兜底）。
- **效果**：G2——新增 server-push = 一行条目；remote-use 未来 busy/idle/presence 分支落地形式即追加条目。

**D3：selectSession 端口束扩展（组 5a，选定）**
- **采用**：`UseSessionDeps` 增加 `sessionEntry` 端口束——`cancelActiveFlow? / clearUnread? / ensureStreamSubscription? / touchRecency? / evictLru?(panelSessionId) / preloadFileTree?`，全部可选、缺省 no-op。core 的 selectSession 扩展为完整 12 步链，restoreSession 共享段（现壳 postLoadSession）一并入 core。壳 useSidebarNew.selectSession 变一行代理。headless/mobile 路径**零新增步骤**（端口全缺省时执行 core 原有动作），但时序按 D4 纠正为 panel-first——不是「零变化」。跨域调用（chat 的订阅/LRU、new-task 的 flow）保持端口注入模式，不开 domain 间直接 import 的先例（包拓扑铁律，renderer-rebuild-architecture.md §3/§4 + 一致性原则）。
- **被否**：① hooks 槽（before/after 回调）——时序不变量重新散回壳的回调注册顺序，比现状更糟；② 壳单拷贝现状（C-W5-1 立场）——已被时序漂移实证击穿（见 D4 证据），且 deleteSession 回退缺订阅的接缝债永存。
- **证据**：use-session.ts:19-21（w5 壳组合项注释）、useSidebarNew.ts:9-13（C-W5-1）与 :302-304（接缝债）。
- **效果**：G1——链有唯一载体；接缝债闭合（deleteSession 回退也过完整链）；两处事故时序变接口级断言。

**D4：统一链采壳版时序（panel 先于 hydrate）——行为纠正（组 5a，选定）**
- **采用**：统一后的切入链顺序 = 壳版（syncSessionToPanel/navigation 先于 hydrate——panel 立即挂载，历史异步回填）。core 版当前的 hydrate-first 顺序被纠正。
- **被否**：core 版 hydrate-first——panel 载入要等历史 RPC 返回，切换感知延迟变长，是 UX 回退。
- **证据**：core use-session.ts:230-255（hydrate :230-253 先于 sync :254）vs 壳 useSidebarNew.ts:214-242（sync :214 先于 hydrate :219）。壳版顺序有 UX 意图（panel 先亮、流式实体不断链）。
- **效果**：G1 成立的前提——这是本设计**两处有意行为变化之一**，影响面仅为当前走 core 版的路径，消费面 grep 实证共三处：deleteSession/deleteFolder 的 wasActive 回退（use-session.ts:374/:407，经 useSidebarNew :307-308 代理触达）+ core 内部 newSession 建后自动选入（:294）；mobile 未切 core 不受影响。验收 A2 场景覆盖。
- **联动**：G5 声明的行为等价条款中本条为显式例外。

**D5：legacy useSidebar 删除与迁移面（组 5a，选定）**
- **采用**：2 处生产消费方切换 useSidebarNew——useChatViewDeps.ts:63 的 `{ forkSession, handoff }`（New 已有同名透传，:395-396/:424-425）与 trace/useTraceJump.ts:78 的动态 import（改指 New 同名导出）；16 个测试文件改指 New（mock / 动态 import / 隔离入口三类适配：legacy 的 `resetAppBootstrap` → New 的 `resetSidebarNewForTest`，:67-71，语义等价 = 守卫重置 + 订阅计数重置）；全部改指完成后删除 legacy 文件（567 行）及其双份链拷贝。
- **被接管路径副作用枚举**（准则：接管 ≠ 全程复用）：legacy 的 deleteSession/deleteFolder 失败兜底走内部 `enterEmptyChatState()`（navigation.push + **startFlow 进新建任务流**，:334-337）；core 版兜底只做 `navigation.push({view:'chat'})`（use-session.ts:377,380），不启动 flow。该差异**已是线上现状**——useSidebarNew 的 deleteSession 早已代理 core（:307-308），46 个消费方走的就是 core 语义；legacy 版仅剩测试触达。删 legacy = 消除分叉而非引入变化，设计显式声明放弃 startFlow 兜底（删最后一个 session 后停留空 chat 态，用户点新建进 landing——与 New 路径现状一致）。
- **被否**：保留双轨至 P3 session 域波次——双轨每滞留一天，例 1 的漂移就多一天复利。
- **证据**：消费面 grep 实证（静态 import + 动态 import + vi.mock 三口径，2026-09-03 实施前复核修正——初版只扫静态口径漏了 1 生产 + 10 测试）= 2 生产 + 16 测试。生产：useChatViewDeps.ts:34,63（静态）、trace/useTraceJump.ts:78（动态）；测试含隔离入口型 6（fg6-overview / useSidebar-delete-empty-state / focused-session-id / app-bootstrap / list-load-error / initapp-default-cwd-session）与 mock/动态型 10（MessageStream.wire / MessageStream-kind / MessageStream-subagent-force-working / SubagentDirectiveStream / use-fork-notice-stream / useHandoffEffect / use-chat-view-deps / fork-entry-behavior / subagent-tab / useTraceJump）。initApp/onConnected/goOverview/toggleCollapse 在 New 已存在（:322-376）；enterEmptyChatState 零外部消费方（grep 实证，仅 legacy 内部自调）。
- **效果**：G2——sidebar 编排一个 SSOT。

**D6：chat store 类型级 facet + 剪枝（组 5b，选定）**
- **采用**：① timer 三件套（armStreamingTimer/armBashTimer/clearBashTimer）收进 `testInternals` 命名空间（生产外部零消费已实证——仅 core/domain/chat 内部经 effects ctx 消费，ctx 由 store 闭包构建不受影响；2 个测试文件经公共面消费连带改指：`renderer/src/__tests__/useChat.test.ts:266`、`renderer/src/__tests__/stores/chat-dispose-session.test.ts:41`）。选择收编而非让测试直接 import `chat/timers.ts` 的 initTimers（chat-bash-effects.test.ts:84 先例）：store 内 timer 经 `initTimers(finalizeSession, …)`（store.ts:713）与 store 闭包绑定，外部 initTimers 得到的是不同 finalize 闭包的独立实例，这两处测试测的是 store 行为，走先例会悄悄改变测试语义；② 既有测试逃生舱（`_sessionStreamingFlagsForTest`/`_entryStatesForTest`）并入同一 `testInternals` 命名空间；③ 导出 facet 类型（`ChatStoreReaders` / `ChatStoreOps` = `Pick<ChatStoreInstance, …>`），消费方按类声明；④ 追加 taste-lint 自定义规则「组件只碰 readers 面」（项目已有 taste/no-* 规则基建），负面拦截走验收 A8。**依赖组 5a 先落地**：LRU 四件套被 sessionEntry 端口吸收、壳不再直取后，公共面先自然缩一圈再分层。
- **被否**：① 运行时嵌套拆分（return { readers, ops }）——约 100 个调用点 codemod + pinia 嵌套响应式陷阱，只买「物理防呆」，成本收益不成立；② 不动——64 项混装面继续扩大。
- **证据**：return 面 store.ts:868-931；timer 生产零消费 grep 实证（含测试扫描，2 处测试消费已并入改动面）；ctx 闭包构建 :613/:713。
- **效果**：G3——消费方只学自己那面；误用面可 lint 拦截。

**D7：command/fileSearch 双轨收口方向 = 壳轨切 core 单例（组 2，选定）**
- **采用**：壳消费方（useSearchJump.ts:29、useSearch.ts:40,71、useFileSearch）切到 core 单例（useCommandStore），删除壳 stores/command.ts（194 行）+ fileSearch.ts（41 行）+ 对应壳测试。**前置硬门（探针 P1）**：先做两实现语义对等核对（194 vs 277 行差集逐条定性为「core 新增」或「壳独有」）——发现壳版独有行为则先补齐 core 再切换。
- **被否**：① 反向（core 轨切壳轨）——与包拓扑铁律相反；② 长期双轨——core 文件头注释已自述壳版待删，双 SSOT 数据发散风险持续。
- **证据**：§2 例 4 消费分裂清单。
- **效果**：G2——command 概念一个 SSOT，-235 行。

**D8：createStagingMode 泛化（组 3，选定）**
- **采用**：一个 `createStagingMode(config)` 泛型 module + fork/handoff 两份配置对象。ComposerInputInstance 收敛方向（探针 P2 一并定性）：权威宽接口已在 `composer/types.ts:173`，6 处局部窄契约逐处判定——有意的耦合控制（send/submit 的 `{getSegments}`、handoff 的 `{focus?}`、context-chips 的 `{getSegments; removeImageChip}`——后者已带意图注释，P2 定性预期为保留）改为字段级 import / 从权威接口 `Pick` 派生并注释声明意图，漂移抄写直接删；**不追求全部合一**（窄契约是合法形态，消灭的是无名分复制）。**前置硬门（探针 P2）**：先列 25% 差异清单 + 窄契约定性，全部确认可配置表达才动手；发现行为级差异 → 降级为部分泛化（共享骨架函数 + 各自保留差异段），不硬抽象。
- **被否**：① 维持镜像——注释自证对称的两份拷贝独立漂移；② 抽象基类继承——引入继承层级换配置就能解决的问题，加机制不减法（准则 8）。
- **证据**：fork-mode.ts:241 行 × handoff-mode.ts:280 行镜像清单（enter/exit/watch 守卫/handleEsc/handleSend 骨架/modeRef getter）；类型 5 份清单。
- **效果**：G5 下的 leverage——消约 300 行，新增 staging mode = 一份配置。

**D9：ensureDispatcher 可选注入——内部测试 seam 复位（组 1，选定）**
- **采用**：`ensureDispatcher(ports, dispatcher?)` 接可选 dispatcher 参数（与 configureRouteInbound 的可选 ports 同体例——core 内部测试 seam，不出现在壳装配面）；use-connection 测试从 4 处 vi.mock 模块内部减至 **ws-client 1 处 mock + dispatcher 1 处注入**（pending/events/domains-session 三处可消；ws-client 是 use-connection 自身顶层依赖 `:29`，mock 不可消也不必消）；route-inbound 的 subscribe 动态 import（:351-363）回直为静态。
- **被否**：① 维持 4 处 vi.mock——测试断言实现细节，模块形状被测试基建扭曲；② 恢复壳装配面注入（回退收口决策）——生产接口重新变宽，因小失大。
- **证据**：use-connection-reconnect-resubscribe.test.ts:44-86 四处模块 mock；route-inbound.ts:351-363 注释自述被迫绕行。
- **效果**：G4——测试与调用方过同一 seam；静态依赖图恢复。**联动**：若探针 P5（renderer 测试 mock 链）失败则保留动态 import，其余照做。
- **附注**：本条部分重访 tc-transport-consolidation 的收口决策，但只加内部 seam、生产面保持窄；若未来有人提议回退，以本条记录为依据。

**D10：不变量工厂化 + 常量 SSOT（组 1，选定）**
- **采用**：① `transportUnavailableError()` 工厂收编 4 处 disconnected 错误构造（code 字面量单点）；② EXTENSION_BRIDGE_TYPES 白名单改为 core 导出常量、壳 import 同一份；③ core 内部经自身 barrel 的回引（lru.ts:25、changeset.ts:25、timers.ts:13 + mock 3 处）改相对路径。
- **被否**：维持注释同步——注释不参与编译，漂移无信号（例 1 已实证）。
- **证据**：§2 例 7 前三条。
- **效果**：G1——约定从注释变代码；包级循环隐患消除。

**D11：死面删除清单（组 1，选定）**
- **采用**：删除 events.dispatch 兼容别名（events.ts:60-62）、ConnectionPorts.toast 死字段（use-connection.ts:77，连带壳装配 useConnection.ts:70 的 useToast() 注入）、PlatformPort.ipc 空挂字段（port.ts:55-67 + 双壳注入点）、builtin/tasks/manifest.ts 整目录（118 行死声明）、session/effects/panel-orchestration.ts 残渣（并入 api-port）；activation-manager.ts 加 dormant 头注（显式标记「等 runtime 激活 RPC，未生效」）。
- **被否**：保留占位「反正无害」——接口宣告不存在的能力比没有更糟（读者按接口学习不存在的行为）。
- **证据**：§2 例 7 后五条，全部经「生产零消费」grep 实证。
- **效果**：G3——接口恢复诚实；约 350 行死面删除。

**D12：波次顺序与依赖（选定）**
- **采用**：W1 组 1 → W2 组 2 ∥ W3 组 3（互不共享文件）→ W4 组 4（内部串行：seq 归位 commit → 路由归一 commit）→ W5 组 5a → W6 组 5b。
- **被否**：并行全开——组 4 两张卡片主战场都是 route-inbound.ts，组 5b 依赖 5a 吸收 LRU，乱序 = 同文件双手术 + 中间态反复。
- **证据**：文件领地交集分析（§5 改动地图）；tc 波次「每单元测试绿」纪律先例。
- **效果**：G6——每波独立交付可回滚。

**D13：branchSummary entry 化（组 5b 小件，选定）**
- **采用**：live 链路的 branchSummary 不再直插 Message（现 effects/registry.ts:565-581），补 entry 化投影，fallback 文案与 reducer（`rawSummary ?? ''`）收敛一致。
- **被否**：维持现状——live ≡ reload 在该消息类型不成立（live 显示 'Branched'、重开后投影为空串），是行为不一致不是整洁问题。
- **证据**：registry.ts:565-581 vs apply-entry.ts reducer 两 case。
- **效果**：G1 派生——这是本设计**第二处有意行为变化**，验收 A4 场景覆盖。
- **联动**：effects 骨架 helper（sealed-guard + findLastAssistantIndex + commit ×8、entry 化四步 ×3 → applyEntryFrameWithOverlay）与 apply-entry 双形态 builder 共享（compaction/branchSummary 两对同构函数）同波做，均为域内机械收敛。

---

## §4 验收（真实场景，非单测非 mock）

**结论：验收 = dev app 真实操作场景（A1-A6）+ 全量回归门（A7）+ lint 负面拦截（A8）+ 负面行为反向验证；每个场景回溯 §1 目标。沿用 tc 波次的双级门形态：Gate A 全量测试 + lint，Gate B dev 实跑（必要时 CDP 取证）。**

改动规模：大改动（跨 5 组、含 2 处行为纠正），多场景投入。

| # | 场景（谁/什么上下文/做什么） | 步骤 | 通过标准 | 回溯 |
|---|---|---|---|---|
| A1 | 开发者在 dev app（真实 runtime）从侧栏连续切换 session | 点选 3 个不同 session，其中 1 个从未打开过；再连切 10 个不同 session | 每次 panel 立即挂载（先亮后填）；首个新 session 历史回填完整；未读 badge 点选即消；连切后最早被逐出 LRU 的不是当前 session 也不是 panel 绑定 session；console 无重复订阅 warn | G1/G5 |
| A1-负向 | 切 session 时人为断网（hydrate 失败） | dev 工具断网后点选一个未 hydrate session | landing 显重试入口（不永久卡住）；恢复网络点重试后历史正常回填 | G1，恢复指引成立 |
| A2 | 开发者删除当前活跃 session | 侧栏删除活跃 session | 回退到列表首项，且**回退路径也建立了流订阅**（D3 接缝债闭合：回退后给该 session 发消息，流式回复实时到达——此前走 core headless 路径缺订阅） | G1 |
| A3 | 断连重连 + gap 自愈（重演 PR #175 场景） | 对话进行中 kill runtime 进程 → supervisor 自动重启 → renderer 重连 → 继续发消息 | 断连窗口的消息经 reconcile 补齐；无 message_start 双实体 / customStart 双 system notice；seq 簿记无泄漏（重连后一切如常） | G1/G4 |
| A4 | 真实对话流 + extension 下行（行为等价总验） | 真实模型跑「列出当前目录文件」（bash 工具 + thinking + 流式）；触发一个产生 widget 的 pi extension 下行（crossSession 类型）；执行一次 fork 与一次 handoff（含 staging 态 Esc/发送）；触发一次 branch（branchSummary 路径） | 全部渲染与改造前一致；widget 在 drawer 正常渲染；staging 文案/Esc/发送行为一致；branch 后 live 显示与关闭重开一致（live ≡ reload，D13） | G5/D8/D13 |
| A5 | mock 模式 | VITE_MOCK=true 启动，跑一条流式对话 | mock 流式、思考/工具块、变更集 fixture 全部正常（mock 轨不在本次改动范围，行为必须不变） | G5 负向 |
| A6 | command SSOT（组 2 专项） | 新建一个 session（触发 runtime 推送该 session 的 commands 更新）后：⌘K 搜索跳转 + 打开 CommandPopover + 走 new-task 命令流 | 三处消费同一份数据：新 session 的命令集在 ⌘K 结果、CommandPopover 列表、new-task 流三处同步可见且一致；壳 stores/command.ts 与 fileSearch.ts 已不存在 | G2 |
| A7 | 回归门 | 根 `pnpm test` + `pnpm lint --max-warnings 0` + 双包 typecheck | 全绿；新增钉住测试清单全绿：切入链 12 步顺序断言 / error 双支单条目 / crossSession 声明式 / MF-3 接口级（reconcile 失败基线不动）/ staging 配置等价 / disconnected 工厂单点 | G4/G5 |
| A8 | facet lint 负面拦截（组 5b 专项） | 临时组件 fixture 误用 ops 面字段（如组件内调 evictIfNeeded）→ 跑 taste-lint → 移除 fixture 复跑 | fixture 存在时 lint 报错且 message 指向 facet 定义文件；移除后复绿（空规则/选择器匹配不到任何代码时 A7 同样全绿，故必须以真实误用样例证明拦截成立） | G3 |

各组验收投入匹配：组 1（机械清扫）= A7 + grep 死面零命中一句话验证；组 2 = A6 + A7；组 3 = A4(fork/handoff 段) + A7；组 4 = A3 + A4 + A7；组 5a = A1 + A1-负向 + A2 + A7；组 5b = A4(branch 段) + A7 + A8。

---

## §5 下一层拆分

**结论：六个波次、14 个 unit 种子，每波呼应 §4 的独立验收子集；文件改动地图如下，设计期无法确定的事项诚实标注为待验证检查点（探针清单）。**

### 波次与 unit 种子

| 波次 | unit | 内容 | justification | 验收 |
|---|---|---|---|---|
| W1 组1 | u1.1 | 不变量工厂化 + 常量 SSOT + barrel 回引去环（D10） | 纯机械、零行为变化，先清场让后续各组少碰干扰项 | A7 + grep |
| W1 组1 | u1.2 | 死面删除 + dormant 注释（D11） | 同上；与 u1.1 无文件交集可并行 | A7 + grep |
| W1 组1 | u1.3 | ensureDispatcher 可选注入 + 动态 import 回直 + use-connection 测试改写（D9） | 依赖 u1.1/u1.2 清场后的 use-connection.ts（toast 字段删除同文件） | A7 |
| W2 组2 | u2.1 | command/fileSearch 对等核对（探针 P1）→ 壳消费方切换 → 删壳 store + 壳测试改写（D7） | 单 unit：核对与切换必须原子完成，否则中间态出现第三轨 | A6 + A7 |
| W3 组3 | u3.1 | ComposerInputInstance 窄契约定性收敛（权威接口 types.ts:173 已在：有意窄契约改 Pick/字段级 import + 注释声明，漂移抄写删） | 收敛方向先定，给 u3.2 的配置对象铺路；定性随探针 P2 一并出 | A7 |
| W3 组3 | u3.2 | 差异清单（探针 P2）→ createStagingMode 泛化（D8） | 差异清单是动手前置门，与泛化同 unit 保证门不被跳过 | A4(fork/handoff) + A7 |
| W4 组4 | u4.1 | seq 协议归位 subscription-state（D1，行为等价） | 先做机械归位再做结构归一，同一文件两次手术风险分层 | A3 + A7 |
| W4 组4 | u4.2 | route-inbound 声明式归一（D2，两 commit：骨架 → error 条目合并） | error 双支合并是语义最复杂的一步，独立 commit 可单独回滚 | A3 + A4 + A7 |
| W5 组5a | u5.1 | sessionEntry 端口束 + core 切入链全链化 + restoreSession 入 core + 时序纠正（D3/D4） | core 侧先行，壳代理化前 core 路径自洽（deleteSession 回退即时受益） | A2 + A7 |
| W5 组5a | u5.2 | useSidebarNew 代理化 + 2 处生产消费方切换（useChatViewDeps 静态 / useTraceJump 动态）+ 隔离入口型 6 测试改指 + context.md 登记「Session 切入链」（D5） | 依赖 u5.1 的 core 全链；生产切换与配套测试先行 | A1 + A1-负向 + A2 + A7 |
| W5 组5a | u5.3 | mock/动态型 10 测试改指 + legacy useSidebar.ts 删除（原子收尾）（D5） | 删除必须等全部消费方改指完成 | A1 + A2 + A7 |
| W6 组5b | u6.1 | chat store 剪枝（timer 三件套入 testInternals + 2 个测试文件连带改指 + 逃生舱并入）+ facet 类型 + taste-lint 规则（D6） | 依赖组 5a 吸收 LRU 后再分层 | A7 + A8 |
| W6 组5b | u6.2 | branchSummary entry 化 + effects 骨架 helper + apply-entry builder（D13） | 域内机械收敛同波；D13 是行为变化，独立 commit | A4(branch) + A7 |

### 文件改动地图（要点）

- **W1**：`core/transport/api/request.ts`、`core/transport/use-connection.ts`、`core/transport/api/events.ts`、`core/platform/port.ts`、`renderer/platform/desktop-platform.ts`、`mobile-renderer` 注入点、`core/extension-host/builtin/tasks/`（删）、`core/domain/session/effects/`（并入）、`core/extension-host/message-bus-bridge.ts` + `renderer/composables/shell/useExtensionHostBridge.ts`（常量 SSOT）、`core/domain/chat/{lru,changeset,timers}.ts` + `core/transport/mock/`（相对路径）、`core/transport/__tests__/`（测试改写）。
- **W2**：`renderer/composables/features/search/{useSearch,useSearchJump,useFileSearch}.ts`、`stores/command.ts`（删）、`stores/fileSearch.ts`（删）、对应壳测试、`core/domain/new-task-search/`（按需补齐差集）。
- **W3**：`core/domain/composer/dispatch/{fork-mode,handoff-mode}.ts`、`dispatch/types.ts`（新）、`submit.ts`、`context/injection.ts`、`context/context-chips.ts`。
- **W4**：`core/coordination/subscription-state.ts`、`seq-gap.ts`（并入后删）、`route-inbound.ts`、两者测试文件。
- **W5**：`core/domain/session/use-session.ts`（+ api-port 类型）、`renderer/composables/features/sidebar/{useSidebarNew,useSidebar}.ts`（一代理一删除）、`renderer/composables/panel/useChatViewDeps.ts`、`renderer/composables/features/trace/useTraceJump.ts`、16 个测试文件（静态+动态+mock 三口径 grep 全集）、`docs/architecture/context.md`（术语登记）。
- **W6**：`core/domain/chat/store.ts`、`index.ts`（facet 导出）、`effects/registry.ts`、`bash-effects.ts`、`apply-entry.ts`、taste-lint 规则（eslint 插件）、`renderer/src/__tests__/useChat.test.ts` + `renderer/src/__tests__/stores/chat-dispose-session.test.ts`（timer 消费改指 testInternals）。

### 待验证检查点（探针清单，准则 7）

| ID | 验证的行为断言 | 探针 | 状态 | 失败降级路径 |
|---|---|---|---|---|
| P0-a | timer 三件套生产外部零消费（含测试扫描：2 处测试经公共面消费需连带改指）、ctx 经闭包构建 | grep 全仓（含 __tests__）+ read store.ts:613/:713 | ✅ 已实证（R1 审查修正：初版漏扫测试文件，2 处测试消费已并入 u6.1 改动面） | 连带改指 testInternals |
| P0-b | legacy useSidebar 消费面 = 1 生产 + 6 测试；fork/handoff/initApp 在 New 已存在 | grep + read :395-396/:424-425/:63-68 | ✅ 已实证 | — |
| P0-c | core/壳切入链时序已漂移（hydrate-first vs panel-first） | read use-session.ts:230-255 vs useSidebarNew.ts:214-242 | ✅ 已实证 | — |
| P1 | command 双轨语义对等（194 vs 277 差集全是 core 新增，无壳独有行为） | u2.1 前置：逐函数差集核对清单 | ⛔ W2 门前 | 壳独有行为先补齐 core 再切换；核对不通过则本波只做 fileSearch |
| P2 | staging 两 mode 的 25% 差异全部可配置表达；ComposerInputInstance 6 处窄契约均可定性（有意窄契约 vs 漂移抄写） | u3.1/u3.2 前置：差异清单 + 窄契约逐条定性 | ⛔ W3 门前 | 部分泛化（共享骨架 + 差异段各自保留）；定性不清的窄契约保留原样 + 注释标记待查 |
| P3 | route-inbound 归一后行为等价 | core 路由测试全绿 + dev 实跑消息流（A3/A4） | ⛔ W4 | 拆两 commit 独立回滚；骨架先行、error 合并后置 |
| P4 | 统一切入链时序正确（panel 先亮、订阅先于回放消费） | dev 实跑 A1/A2 + console/CDP 观察订阅建立顺序 | ⛔ W5 | 回退壳组合（端口束保留、壳继续重编排），时序问题单独排查 |
| P5 | use-connection 注入化后 renderer 测试的 ws-client mock 链不失效 | 受影响测试全量跑（u1.3 内） | ⛔ W1 | 保留 subscribe 动态 import，其余照做 |

---

## 附录 A：评审候选 ↔ 组/例映射（自包含锚点）

架构评审（improve-codebase-architecture 三路走查）产出 9 候选 + 8 小项。候选按下表归并为本文档 5 组；8 小项全部吸收进对应组决策（如 barrel 回引去环→D10、branchSummary entry 化→D13、effects 骨架 helper 与 apply-entry builder→D13 联动、panel-orchestration 残渣清理与 activation dormant 标记→D11 等）。正文引用 Card 编号时以本表为锚。

| 评审候选 | 主题 | 归宿 |
|---|---|---|
| Card 1 | Session 切入链三份实现漂移 | 组 5a / §2 例 1 / D3-D5 |
| Card 2 | seq 协议散三文件 | 组 4a / §2 例 2 / D1 |
| Card 3 | command/fileSearch 双轨 | 组 2 / §2 例 4 / D7 |
| Card 4 | 死面 + 常量双写 | 组 1 / §2 例 7 / D10-D11 |
| Card 5 | route-inbound 三结构并存 | 组 4b / §2 例 3 / D2 |
| Card 6 | use-connection 测试 seam 退化 | 组 1 / §2 例 8 / D9 |
| Card 7 | composer staging 镜像重复 | 组 3 / §2 例 5 / D8 |
| Card 8 | chat store 64 项混装公共面 | 组 5b / §2 例 6 / D6 |
| Card 9 | mock 轨与 real 轨语义对齐 | Out-of-scope（挂起 P3 再议） |

---

## 附录 B：变更历史

- v1：2026-09-02 初版。来源：架构评审（三路 Explore 走查，9 候选 + 8 小项）→ 分组裁决（5 组）→ 组 4/5 grilling（设计树走完）→ 本文档覆盖全 5 组。
- v2：2026-09-02 R1 对抗式审查修订（1 must-fix + 7 suggestion 全修）：① D6 timer 实证修正——生产零消费 + 2 个测试文件经公共面消费连带改指 testInternals（P0-a 重扫、u6.1/W6 改动面补齐）；② D2 补守卫归宿——条目 schema 增 `payloadGuard`，dispatcher 在 dispatch 与 effect 之间统一执行；③ D3/D4 内部矛盾修正——「零变化」改「零新增步骤、时序按 D4 纠正」，core.selectSession 消费面三处 grep 实证补入 D4；④ 新增 A8 facet lint 负面拦截验收（组 5b / u6.1 联动）；⑤ D9 表述去满——下限为 ws-client 1 处 mock + dispatcher 1 处注入；⑥ 例 5 重述——权威接口 types.ts:173 已在，5 处为有意窄契约，u3.1 改定性收敛（P2 探针扩围）；⑦ A6 补触发手段（新建 session 触发 runtime commands 推送）；⑧ 附录 A 补评审候选映射（自包含）。
- v3：2026-09-02 R2 聚焦复审修订（0 must-fix + 2 suggestion + 1 info 全修）：① D2 守卫分两类——跳过型（:227/:241-243）入 payloadGuard，整形型（:276 的 'Unknown error' 参数兜底）留 sessionEffect 参数构造处，并显式「payloadGuard 只门控 effect、不门控分发」；② 例 5/D8/P2/W3 补第 6 处窄契约 context-chips.ts:29-32（已带意图注释的达标样例，P2 定性预期保留）；③ D6① 补 testInternals 选择理由（store 闭包绑定的 timer 无法经独立 initTimers 复现，走 chat-bash-effects.test.ts:84 先例会改变测试语义）。审查记录：.review/renderer-deepening-review-r1.md（R1 全文 + R2 聚焦复审）。
- v4：2026-09-03 实施前复核修正（doc_error）：D5 消费面初版 grep 只扫静态 import 口径，漏动态 import 与 vi.mock——真实消费面 = 2 生产（useChatViewDeps 静态 + useTraceJump:78 动态）+ 16 测试（隔离入口型 6 + mock/动态型 10）；u5.2 相应拆为 u5.2（生产切换 + 隔离入口型）与 u5.3（mock/动态型 + 删除收尾），删除仍原子收尾。
