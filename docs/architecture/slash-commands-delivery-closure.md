# slash 命令投递闭环设计（修复 composer skill 消失）

> **一句话结论**：对话流 composer slash 浮层的 skill 列表数据链是「一次性投递、零补拉」——session 激活时广播一帧，消费组件若未就位帧即永久丢失；修复方案是在消费侧接上「挂载 / 切 session / 打开浮层时主动拉取」的补拉闭环（复用既有 `session.getCommands` RPC，runtime 零改动），并修正订阅 handler 的分区写入。

| | |
|---|---|
| 分支 | fix-composer-skill-disappear（基于 main 0.9.7） |
| 层性质 | 技术方案设计（下一层 = 具体代码任务 + 测试） |
| 相关文档 | dev-0.9.8 `docs/architecture/composer-symbol-system.md`（commit `2342dc7f0`，§D4）；ADR-0049（session 隔离 Map 分区范式）；AGENTS.md「Runtime broadcast 时序竞争」条款 |
| 相关在途改动 | dev-0.9.8 U3（commit `f1f6634d8`，reload 后 commands 失效）——与本文互补，见 §3.5 |

---

## 1. 背景目标

**SCQA**：

- **S**：太极工作台对话流的 composer 里输入 `/` 会弹出 slash 命令浮层；skill 以 `skill:<name>` 形态与 extension 命令、内置 compact 并列，数据来自该会话 pi 子进程的 `get_commands` 快照。
- **C**：这份快照到渲染端的投递是**单次、尽力而为**的——session 激活时 runtime 播种拉取并广播一帧；渲染端消费组件（CommandPopover）是异步挂载就位的，帧到达早于订阅建立即永久丢失。而本应兜底的主动拉取 RPC（`session.getCommands`）在渲染端**零调用方**，快照也无任何失效/重试源。
- **Q**：使用中频繁出现浮层里所有 skill 项消失（常只剩 compact 一项），且本次运行内不自愈，只能重启应用或重开会话。
- **A**：消费侧接上「打开即拉」补拉闭环，配合订阅 handler 分区写修正，形成「广播 + 主动拉」双保险；失败静默降级保留旧值。

**系统是什么**：三层结构——渲染进程（Vue 3 + Pinia，`packages/renderer/`）、runtime（Node WebSocket 服务，`packages/runtime/`，每个会话托管一个 pi 子进程）、pi（`@earendil-works/pi-coding-agent` RPC 模式）。slash 浮层候选 = pinia `commandStore` 中按 sessionId 分区的命令表，写入来源只有 runtime 推送的 `session.commands` 帧。

**设计目标**（从使用者体验倒推）：

- **G1 新建即完整**：landing 发首条消息进入对话流后，输入 `/` 立即看到完整 skill 列表——无论创建路径是否带模型 chip / 思考等级 / 图片（这些中间 RPC 是当前高概率丢失窗口）。
- **G2 切换不丢不串**：切入任何会话（含后台激活过的会话）浮层都有数据；旧会话的迟到帧不污染新会话分区。
- **G3 打开即新鲜**：浮层每次打开反映 pi 当前真实命令集——skill 增删后无需重启应用或重激活会话。
- **G4 降级可恢复**：pi 异常时浮层保留上次列表不清空、无错误弹窗；恢复后下次打开自动刷新。

**in-scope**：渲染端 CommandPopover 数据链的补拉接线与订阅 handler 分区写修正。

**out-of-scope**：① runtime 侧 reload 完成后的快照失效（dev-0.9.8 U3 已实现，本文 §3.5 说明协调）；② landing 态浮层（走 skillRegistry/settingsStore 扫描源，独立链路，不受本缺陷影响）；③ slash 命令的执行链路；④ bus 协议改造。

---

## 2. 现状与问题分析

### 2.1 使用者视角的现状（真实例子）

- **例 1（新建会话丢失，最常见）**：用户在 landing 选了模型 chip、输入首条消息发送 → 视图切入对话流 → 输入 `/` → 浮层只显示 compact 一项，所有 skill 消失。重启应用才恢复。对照：landing 态浮层一直正常——它读的是另一条源（`globalSkills`/`projectSkills` props，来自 skillRegistry 扫描），不经过本链路。
- **例 2（后台激活的会话切入为空）**：会话 A 使用中，另一个会话 B 曾被后台激活（预建/agent-managed spawn/早前切换过）；点进 B 输入 `/` → 空列表。B 的激活帧在它进入列表时就已回放消耗，彼时无消费者。
- **例 3（列表陈旧）**：会话存活期间用户增删了 skill 目录，浮层永不反映变化（当前分支无任何刷新路径）。

### 2.2 物理数据流（现状）

```
pi 子进程（stdout JSONL，RPC 模式）
  get_commands 应答 = extension 命令 + prompt 模板 + skill:* 三段拼接
  [实装依据 node_modules/.../dist/modes/rpc/rpc-mode.js:539-566]
        │ ① 仅在 session 激活时调用一次
        ▼
runtime Node 进程（内存）
  ReplicatedState<CommandsSnapshot> 实例
  ├─ 播种：initializeManagedSession → commands.refetch()（一次性）
  ├─ 失效源：仅 sessionService.getCommands() RPC 内 markDirty —— 渲染端无人调用
  ├─ 失败退避：[1s,5s,15s] 耗尽后停止；无 pollIntervalMs 周期兜底
  │  [replicated-states.config.ts:216-223 / replicated-state.ts 不变量 2]
  └─ fetch 成功 → setTimeout(0) 发布一帧 session.commands
        │ ② MessageBus（内存）
  stateSnapshot（last-value，同 typeKey 覆盖）+ 定向推给「已订阅该 sid 的 ws 连接」
  [session-service.ts:1900-1906；message-bus.ts STATE_TYPE_KEY_MAP]
        │ ③ WS（localhost）定向推送 / 首订时回放 stateSnapshot
        ▼
渲染进程（内存）
  subscribeSession 首订回放（一生只发生一次——subscribed 幂等守卫短路后续）
  [core/coordination/subscription-state.ts:155-157, 208-214]
        │ ④ 本地 events bus dispatchSession(sid)
        ▼
CommandPopover（useSessionEvents 订阅，挂载/切 sid 时才建立）   ← 异步就位
        │ ⑤ 唯一写入点：commandStore.applyCommands(sid, cmds)
        ▼
commandStore[sid]（pinia，Map 分区） ──> 浮层 items / Turn.vue 用户气泡 chip 解析
```

**链路盲区提示（S3 验收的前提）**：pi 的 skills 段来自 `resourceLoader.getSkills()` **内存注册表**（启动/reload 时重扫，无文件 watcher）——磁盘 skill 目录变化要进注册表，必须走既有异步编排：skill-registry chokidar watcher → `skillRegistry.onChange` → `ReloadOrchestrator.onSkillChange` → idle session 发 `/__xyz_reload__` → pi `ctx.reload()` 完成重扫（接线在 `runtime/src/index.ts:561-568`，整链秒级）。因此「打开即拉」刷新的是 **pi 内存注册表的当前值**，不是磁盘当前值；reload 未完成前拉到的仍是旧列表（这是降级不是 bug）。

### 2.3 术语定义（锚定本节例子）

- **播种 refetch**：session 激活时对快照实例做的一次立即拉取（上图标 ①），每个 pi 进程生命周期内通常只发生这一次。
- **stateSnapshot**：runtime 侧每类 state 消息的「最后值」缓存（上图标 ②）。订阅建立时随订阅应答回放一次。例：`session.commands` 帧发布后无人订阅，其最后值存在这里等回放。
- **查询即失效**：runtime 对 `session.getCommands` RPC 的处理语义——应答查询结果的同时对快照实例 `markDirty`，触发防抖重拉与再广播（`session-service.ts:1986-1997`）。意味着「每次主动查询都顺带刷新了快照」。
- **幂等守卫**：渲染端订阅状态 `subscribed=true` 后，后续 `subscribeSession` 直接短路（`subscription-state.ts:155-157`）——回放一生只发生一次。

### 2.4 失败模式

| # | 失败模式 | 触发条件 | 代码依据 |
|---|---|---|---|
| FM1 | **激活帧 + 首订回放双双落在组件就位之前**，store 分区从未写入 | landing 新建路径中 `appendSession`（触发订阅）与 `pushChat`（触发挂载）之间存在 `applyModel` / `setThinkingLevel` / `migrateImages` 等中间 RPC（`packages/core/src/domain/new-task-search/flow.ts:267-278`），订阅回放先于 Composer 挂载到达 → 永久空表 | `CommandPopover.vue:186-192` 唯一写入点 |
| FM2 | **后台激活的会话回放提前消耗**：会话进列表即被 App 级 watcher 订阅（`useSessionStreamSync`），回放派发时用户不在看该会话，无本地消费者；事后切入被幂等守卫短路 | 任何非当前视图会话的激活（预建、agent-managed spawn、早前切换） | `useSessionStreamSync.ts:70-76`；`subscription-state.ts:155-157` |
| FM3 | **播种拉取退避耗尽**：pi 忙碌导致 `get_commands` 超时（10s）×4 次失败后实例永无快照，`publishCommandsSnapshot` 因 undefined 跳过发布——stateSnapshot 无值，pi 持续异常窗口内重连也救不回（WS 重连/session 再激活会触发 `refetch()` 重置退避重拉，但拉取成功前提是 pi 恢复正常） | 激活窗口内 pi 异常忙碌/卡顿 | `replicated-state.ts` 不变量 2 + `session-service.ts:1903` |
| FM4 | **跨分区污染**：订阅 handler 写 `props.sessionId` 而非消息所属 sid，切换瞬间旧会话迟到帧写进新会话分区（表现为列表错乱：显示上一个会话的 skills） | 切换瞬间帧到达落在 props 已变、订阅未重订的窗口 | `CommandPopover.vue:188-192` 无视 `useSessionEvents` 第二参数（该参数即为此设计，`useSessionEvents.ts:96-102`） |

### 2.5 根因

**数据链是「单次投递、零重试、零补拉」，而消费组件的挂载/订阅是异步就位的——两者任意错序即永久丢失。** 本项目自己登记的架构约定「renderer 切换/创建 session 后需立即消费的 session 级状态必须主动拉取（`session.getCommands` RPC），不可依赖 broadcast」（AGENTS.md「Runtime broadcast 时序竞争」）早就写明了对策，补拉 RPC 与 mock 也都建好了（`api/domains/session.ts:118`、`api/mock/index.ts:329-335`、runtime 侧 handler `session-message-handler.ts:407-414`、协议 `protocol.ts:1486`），**唯独渲染端从未接线**。这不是机制缺失，是闭环断在最后一厘米。

---

## 3. 解决方案

### 3.1 终态（使用者视角）

**成功路径**：新建会话（带模型 chip）→ 进入对话流 → 输入 `/` → 浮层立即出现完整列表（skill 项 + extension 命令 + compact；数量与该会话 pi `get_commands` 真实返回一致）。之后每次重新打开浮层，列表反映 pi 当前命令集——skill 目录变更经 ReloadOrchestrator reload 编排完成后（§2.2 链路盲区提示），下次打开即见新增项。（渲染模式 = SWR：打开瞬间先渲染 store 旧值，拉取应答 ms 级回写刷新，见 D5。）

**失败路径（含恢复指引）**：pi 进程异常时打开浮层 → 显示上次已知列表（不清空、无错误弹窗、console 留 `[useCommandSync]` warn 供排查）；恢复动作 = 等 runtime 重建会话（或手动重开会话）后重新打开浮层，即自动拉到新列表。runtime 整体重启后切回会话输入 `/`，列表经「重连回放 + 挂载拉取」恢复。

### 3.2 方案对比

| 方案 | 长期架构合理性 | 短期实现成本 | 风险 | 裁决 |
|---|---|---|---|---|
| **A. 消费侧打开即拉双保险**（挂载/切 sid/开浮层 → `sessionApi.getCommands` → 写 store；handler 改用捕获 sid） | 对齐 AGENTS.md 广播时序竞争条款与 dev-0.9.8 设计文档 §D4 自己规划的形态（「renderer 浮层开时 1 次 RPC」）；「查询即失效」顺带刷新 runtime 快照，与 U3 同路幂等 | 1 个新 composable + CommandPopover 两处接线 + 测试，~100 行量级；runtime/协议零改动 | 浮层每次打开 1 次 ms 级 RPC（pi 本地进程）；per-sid 全量覆盖写天然幂等，无竞态 | ✅ **推荐** |
| B. runtime 侧加轮询兜底（commands 实例配 `pollIntervalMs`） | 违背团队既有裁决——composer-symbol-system §D4 明确否决轮询（「违背事件驱动范式」；thinkingLevel 的 30s 先例是高频变化字段，commands 不是）；且轮询「拉取时机」与「组件就位」无关，FM1/FM2 的根本窗口一个都没关上 | 1 行配置 | N 个活跃 session × 每周期 N 次 `get_commands` 常驻开销；空表场景依旧偶发 | ❌ |
| C. 投递机制改造（消费确认+重发 / stateSnapshot 变更时向新订阅者重播） | bus 协议级改造，收益与 A 相同但影响面重一个数量级（协议、bus、订阅状态机、两端测试） | 高 | 高（动全局消息基础设施，回归面广） | ❌ |

**推荐 A 的理由**：最小闭环打穿根因——补拉把「帧是否被及时消费」从强依赖降级为尽力而为的优化项（丢了也有拉取兜底），且全部复用已存在并验证过的设施（RPC、查询即失效、mock）。若用方案 B，§2.1 例 1 依旧偶发（轮询拉到的帧照样可能在组件就位前广播）；若用方案 C，例 1 消失但付出协议改造代价去解决一个一层 RPC 就能解决的问题。

### 3.3 关键决策

**D1：补拉触发点 = 挂载 + sessionId 变化（immediate）+ 浮层打开（slash 类型）（选定）**
- **采用**：新 composable `useCommandSync(sessionIdRef)` 内三个触发点，fire-and-forget，写入 `commandStore.applyCommands`。
- **被否**：①仅打开时拉——浮层关闭状态下 store 空表照样伤害非浮层消费者（Turn.vue 用户气泡 chip 解析 `findCommandByName` 读同一 store），G2 不完整；②仅挂载+切 sid 拉——长寿命会话内 skill 增删不刷新，G3 不达成。
- **证据**：`CommandPopover.vue:186-192`（唯一写入点）；`command.ts:120`（chip 解析读 store）；同构先例——CommandPopover 已在 onMounted 拉文件候选（`useFileSearch`，`CommandPopover.vue:128-143`）。
- **效果**：G1/G2/G3。

**D2：写入分区 = 回执/帧自带的 sessionId，禁止读 props（选定）**
- **采用**：拉取写 `reply.sessionId` 分区；广播 handler 改用 `useSessionEvents` 注入的**捕获 sid**（handler 第二参数）——ADR-0049 的 `updateFor(capturedSid)` 范式。
- **被否**：维持现状读 `props.sessionId`——FM4 的跨分区污染正是 ADR-0049 明令消除的 M1 竞态形态。
- **证据**：`useSessionEvents.ts:96-102`（第二参数设计意图注释：「写入消息所属 sid 分区，不污染新 sid 分区」）。
- **效果**：G2（含 FM4 修复）。

**D3：失败语义 = 静默降级保留旧值（选定）**
- **采用**：catch → `console.warn('[useCommandSync] ...')`，store 不动，无 toast。
- **被否**：①toast/横幅——打开浮层是高频动作，异常弹窗成噪声，且 pi 异常在生成链路已有可见报错；②清空 store——丢失最后已知好值，违反 runtime 同款降级语义（ReplicatedState 核心不变量 2「失败保留上次快照」）。
- **证据**：错误链路已核实闭环——runtime `server.ts:406-426` 外层 catch → `sendError` → 渲染端 pending reject（✅探针 P5）；非活跃会话抛 `session not active`（`session-service.ts:1990`）。
- **效果**：G4。

**D4：不加轮询、不改 runtime、不改协议（选定）**
- **采用**：纯渲染端改动。runtime 既有「查询即失效」已是完备重试源——即使播种退避已耗尽（FM3），`getCommands` RPC 内的 `markDirty` 会**重启**拉取周期（防抖到点再拉，成功后照常广播），且 RPC 应答本身直接携带最新列表。
- **被否**：commands 配 `pollIntervalMs`——见 §3.2 方案 B；动 bus/协议——见方案 C。
- **证据**：✅探针 P3（`replicated-state.ts:174-189` markDirty 置防抖定时器重启 doFetch，与退避游标解耦）；`replicated-states.config.ts:216-223`（commands 现无周期配置）；FM3 场景下 RPC 应答直接回填（`session-message-handler.ts:407-414`）。
- **效果**：改动面最小（1 新文件 + 1 文件修改），与 dev-0.9.8 U3 零文件冲突。

**D5：数据模式 = 打开即拉（权威）+ SWR 旧值先行；store 服务同步消费者；广播降级为背景优化（选定）**
- **采用**：浮层打开 → 立即渲染 store 旧值 → 同步发 RPC → 应答回写覆盖。拉取路径**全程实时透传 pi**（`session-service.ts:1990-1997` → `client.getCommands()` → pi 内存注册表现拼应答，`rpc-mode.js:539-566`），不经过 runtime 快照缓存。store 保留：浮层之外的同步消费者（Turn.vue 历史消息 slash chip 解析 `findCommandByName`、SearchModal 命令注入）在 Vue computed 渲染路径里读它——computed 无法发异步 RPC，必须有已落地的结果。runtime 广播/快照链路保留但浮层正确性不再依赖（丢了也有拉兜底），只剩「非打开时刻让 chip 等消费者尽量新鲜」的背景价值。
- **被否**：①「删 store、浮层直接消费 RPC」——chip 等同步消费者无数据可读，需把消息渲染层 chip 解析异步化，改动面扩大一个数量级；②「打开时同步 await 权威值」——打开出现 loading 态，pi 忙碌时浮层延迟最高 10s（FAST_TIMEOUT），体验劣于 SWR 旧值先行；③「删 runtime 广播链路」——多 state topic 共用基建（`message-bus.ts:131-138` STATE_TYPE_KEY_MAP 五条目：commands/context/subagents/workflows/state_changed），单删 commands 一条破坏对称性且是协议级工程，收益为零。
- **证据**：chip 同步读取点 `command.ts:114-120`（getCommands/findCommandByName）；pi 应答实时拼装无缓存 `rpc-mode.js:539-566`；RPC 路径透传 `session-service.ts:1990-1997`（快照只被顺带 markDirty，不作应答来源）。
- **效果**：G3（打开即新鲜，ms 级）+ G4（旧值即降级态）；回应「低频操作无需缓存」——store 的存在不是为省 RPC，是为同步消费者与 SWR。

**探针登记**（运行时断言核实状态）：

| # | 断言 | 状态 | 依据 |
|---|---|---|---|
| P1 | pi `get_commands` 应答 = extension + prompt + skill 三段拼接，skill 项 source='skill' | ✅已测（读实装 dist） | `rpc-mode.js:539-566` |
| P2 | commands 快照唯一失效源 = `sessionService.getCommands`（查询即失效 + markDirty） | ✅已测 | `session-service.ts:1986-1997` |
| P3 | markDirty 在退避耗尽后仍可重启拉取周期 | ✅已测 | `replicated-state.ts:174-189` |
| P4 | 订阅幂等守卫使 stateSnapshot 回放一生只发生一次 | ✅已测 | `subscription-state.ts:155-157` |
| P5 | RPC 错误经 runtime 外层 catch → sendError → 渲染端 command() reject | ✅已测 | `server.ts:406-426` + `api/pending.ts` |
| P6 | mock 模式 `getCommands` 存在同形实现 | ✅已测 | `api/mock/index.ts:329-335` |
| P7 | 协议契约 `ReplyPayloadMap['session.getCommands']` 已登记 | ✅已测 | `protocol.ts:1486` |
| P8 | 生成中会话可安全查询（`get_commands` 是快照查询，不产生 turn、无 busy 守卫） | ✅已测 | `rpc-mode.js` 命令循环 + `session-service.ts:1990-1997` 无 isGenerating 检查 |
| P9 | 浮层打开路径全部汇聚于 `cmdOpen`（slash-trigger / + 菜单 / SearchModal 注入） | ✅已测 | `useCommandPopoverTrigger.ts:80-97,110+` |
| P10 | 打开浮层触发的 RPC 延迟在 ms 级、无可感知卡顿 | ⛔实施期门：若实测打开出现 >100ms 可感知延迟，降级为「仅 store 为空时拉取」（freshness 让位给 U3 reload 路径），其余方案不变 | 探针：实施期在 dev app 打开浮层计时 |

### 3.4 接口契约（下一层入口）

`packages/renderer/src/composables/panel/useCommandSync.ts`：

```
useCommandSync(sessionIdRef: Ref<string | null | undefined>): {
  // 行为契约（不暴露状态给调用方，纯副作用 composable）：
  // 1. watch(sessionIdRef, immediate) —— sid 变化/挂载即拉（sid 为空不拉）
  // 2. onOpenPull() —— 供浮层打开时调用（CommandPopover watch open && type==='slash'）
  // 3. 拉取 = sessionApi.getCommands(sid) → commandStore.applyCommands(reply.sessionId, reply.commands)
  // 4. per-sid in-flight 去重（同 sid 并发触发复用同一 Promise）
  // 5. 失败 console.warn('[useCommandSync] ...')，store 不动
}
```

CommandPopover 接线：① setup 调 `useCommandSync(toRef(props, 'sessionId'))`；② `watch(() => props.open && props.type === 'slash', v => v && sync.onOpenPull())`；③ 订阅 handler 改用第二参数 sid 写分区（D2）。

### 3.5 与 dev-0.9.8 U3 的关系（合并协调）

U3（`f1f6634d8`）在 runtime 侧补「reload 完成后失效快照」，本设计在渲染端补「消费侧拉取闭环」，两者正交互补：U3 管「skill 目录变化 → reload 后 runtime 快照刷新」，本设计管「无论 runtime 发没发帧、何时发的帧，渲染端都能拿到」。文件无冲突（U3：`reload-orchestrator.ts` / `session-service.ts` / `interfaces.ts`；本设计：renderer 两文件）。两边合并后，本设计的打开即拉与 U3 的 reload 失效走同一「查询即失效」管线，天然幂等聚合（markDirty 防抖 300ms）。

---

## 4. 验收

全部场景在真实环境执行：`pnpm dev` 启动真实 Electron app + runtime + pi 子进程（VITE_MOCK 不开），不 mock 任何一层。每个场景标注回溯目标。

| # | 场景 | 步骤 | 通过标准 | 回溯 |
|---|---|---|---|---|
| S1 | 新建即完整 | 在 landing 选模型 chip + 输入首条消息发送 → 进入对话流 → 输入 `/`。重复 3 次（分别带模型 chip / 思考等级 / 纯文本） | 每次浮层都含 `skill:*` 项；skill 项数量与该会话 pi 真实 `get_commands` 一致（对照依据：`~/.xyz-agent/logs/pi-*.jsonl` 中该会话的 get_commands 应答计数，或本地 `pi --mode rpc` 同 cwd 拉取对照） | G1 |
| S2 | 切换不丢不串 | 开两个不同 cwd 的会话 A（本 worktree，含 `~/.agents/skills` 全局 + 项目 skills）与 B（另一项目 worktree，项目 skills 不同）→ 快速 A→B→A 切换，每次切换后立即输入 `/` | B 浮层不含 A 独有 skill、A 浮层完整；全程无「上一个会话的 skill 残留」（负面验证 FM4/D2） | G2 |
| S3 | 打开即新鲜（两层：reload 完成后新鲜 / reload 进行中旧值保留） | ① 会话打开浮层记录项数 N → 在 `~/.agents/skills/` 下新建测试 skill 目录（含 SKILL.md）→ **等待 reload 完成锚点：runtime 日志出现 reload 编排完成记录（或 watcher 事件触发后固定等 ≥3s）** → 关闭浮层再打开 → 删除该目录 → 同样等锚点 → 再打开；② 负面层：新建目录后**不等锚点立即**重开浮层 | 正面：第二次打开 N+1 且新 skill 在列、第三次回到 N（本分支无 U3，刷新依赖打开即拉——验证 D1 第三触发点 + §2.2 链路盲区前提）；负面：立即重开显示旧列表 N（reload 进行中，降级非 bug，不清空不报错） | G3 |
| S4 | 降级可恢复 | 对话中 `ps` 找到该会话 pi 进程并 kill → 打开浮层 → **等待 RPC 失败返回后再查 console（挂起的 getCommands 最多 FAST_TIMEOUT 10s 后 reject）** → 等待 runtime 恢复/重开会话 → 再打开浮层 | kill 后浮层显示旧列表（不清空）、无错误弹窗、console 有 `[useCommandSync]` warn（延迟至多 10s 出现）；恢复后打开浮层列表刷新 | G4 |
| S5 | 重启自愈 | 杀 runtime 进程（模拟 runtime 重启）→ 应用自动重连 → 切回该会话输入 `/` | 列表经重连回放 + 挂载拉取恢复正常（覆盖 FM2 幂等守卫短路场景） | G2/G4 |
| S6 | 打开不重不闪 | 同一会话连续开关浮层 5 次 | 每次列表内容一致，无重复项、无闪烁（验证 applyCommands 全量覆盖幂等 + in-flight 去重）（负面验证） | G3 |

单测（实施交付物，非验收替代）：`useCommandSync` composable 单测（触发点/去重/失败降级/分区写）+ CommandPopover 挂载与打开黑盒（mock api 层），遵循 TEST-STRATEGY.md 三视角；验收以上表真实场景为准。

---

## 5. 下一层拆分

**实施路径**：单 wave 一次交付（改动集中、无阶段依赖，拆多 wave 反而增加验收开销）。

**拆分清单**：

| 单元 | 内容 | justification | 呼应验收 |
|---|---|---|---|
| W1 | `useCommandSync.ts` 新建 + `CommandPopover.vue` 接线（3 触发点 + handler sid 修正）+ 单测 | 渲染端闭环的三个改动点（拉/写分区/handler）共享同一验收面，拆开则任一子单元单独不可验收（拉了不写没意义、写了不拉没数据） | S1-S6 |
| W2 | ~~changeset~~ → 无需 changeset（`@xyz-agent/frontend` 在 `.changeset/config.json` ignore 名单——changeset 只管发布的 npm 包，应用版本走 merge 流程 bump）+ 手动验收记录 | 文档流程项，独立于代码 | — |

**文件改动地图**：

- 新增：`packages/renderer/src/composables/panel/useCommandSync.ts`（与 `useCommandPopoverTrigger.ts` 同目录，api 调用归 features/panel 编排层，符合「组件不直接调 api」铁律的既有例外先例——`useFileSearch` 同构）
- 修改：`packages/renderer/src/components/panel/CommandPopover.vue`（setup 接线 + 订阅 handler 第二参数）
- 测试：`packages/renderer/src/components/panel/__tests__/`（CommandPopover 既有测试同位置；具体文件名实施期按现有命名惯例定）
- 无 runtime / shared / 协议改动

**待验证检查点（实施期确认，不阻塞设计）**：

1. CommandPopover 既有测试的 mock provide 形态（`SLASH_COMMAND_SOURCE_KEY` 注入方式）——实施期读现有测试对齐。
2. open 触发 watch 与既有 `loadCandidates`（文件候选 onMounted 拉取）是否合并 watch——倾向独立，实施期按代码简洁度定。
3. P10 探针：打开浮层的 RPC 实测延迟（预期 ms 级；>100ms 走降级路径「仅空表时拉」）。
