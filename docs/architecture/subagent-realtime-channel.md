# subagent drawer 实时渲染通道实施设计（E 方案：runtime 托管 spawn + stdio 代理 CLI）

> **层声明**：本文档是「E 方案实施层」的设计，下一层产物是**可编码的实施清单与测试用例**（E-1 代理 CLI / E-2 runtime 基建 / E-3 extension 接入 / E-4 前端接入四个单元），接口与数据流规格已给到字段级，不跨层到逐行实现。
>
> **来源声明**：细化自 `fix-drawer-subagent-render` worktree 初稿 `docs/architecture/subagent-realtime-channel.md`（只读参照，本文自包含，不要求读者先读它）+ 本分支已落地的引擎抽象结构（设计 [subagent-engine-abstraction.md](subagent-engine-abstraction.md)，代码 `extensions/universal/subagent-workflow/src/execution/engine/`，P1-P5 已落地）。初稿的「一期 A 止血 → 二期 E」路径已由主 agent 决策调整为**跳过 A 直接做 E 终态**；A/D 方案内容保留为附录 A（历史记录 + E 受阻退路），不作为实施计划。
>
> 状态：已实施——E-0..E-4 全部落地（2026-08-25，分支 `feat-support-zcode`：E-0 relay channel env/protocol SSOT `433ca061f` → E-1 代理 CLI `3df593816` → E-2 runtime 基建 `6d5965251` → E-3 extension 接入 `9cfd8635d` → E-4 前端接入 `f4373ab45`；设计文档本体 `7915ac2e4`）。对抗式审查待进行。

## 1. 背景与根因

**一句话结论**：subagent drawer「停留在某个阶段」的根因是实时通路只覆盖首轮 text_delta 且不可回放——E 方案让 runtime 经代理 CLI 托管 subagent spawn 后持有子进程 stdio，drawer 数据通路与主对话流构造性同构（同一 event-adapter 翻译 + 同一 applyEntry reducer），三根因同时消解；spawn 目标切换收敛为 PiEngine launcher 层的一个环境条件分支，session-runner 与编排层零改动。

### 1.1 SCQA

- **S（情境）**：drawer 对话流靠两条通路供数——静态快照（`getSubagentHistory` RPC 直读子进程 JSONL）+ 实时增量（extension 的 `SubagentStream` 把 `text_delta` 经 `setWidget("subagent-stream-<recordId>")` 私货通道发出，runtime event-adapter 前缀短路翻译为 `subagent.stream_delta` transient 帧推前端）。
- **C（冲突）**：drawer 会停在某个阶段不再更新。三个根因：R1 chatMode 续聊轮 stream 通道永久销毁；R2 工具执行期间零推送；R3 前端订阅决策依赖陈旧缓存且 transient 帧丢失不可回放（§1.3）。
- **Q（问题）**：为什么修补 widget 通道不够？用哪条数据通路让 drawer 获得与主对话流同构的实时性，且不为多引擎架构（已落地的引擎抽象）制造返工？
- **A（答案）**：E 方案——extension spawn 一个 stdio 代理 CLI（字节级扮演 pi 子进程），代理经本地 socket 把 spawn 请求与 stdio 字节流转发给 runtime，runtime spawn 真实 pi 并 tee 一份事件流给既有翻译/广播链。pi RPC 协议「不存在 host→extension 推流命令」的硬约束被数据流向倒转消解：extension 始终只从自己 spawn 的进程 stdout 拉数据。

### 1.2 系统是什么（现状通路全景）

xyz-agent 是「Electron GUI + Node runtime + pi 主进程」三层架构。subagent 是 pi extension（`@zhushanwen/pi-subagent-workflow`，跑在主 pi 进程内）spawn 的无头 pi 子进程（`--mode rpc`）。子进程 stdout 由 extension 的 session-runner 消费（自实现 RPC 客户端），runtime 只持有主 pi 进程的管道，不直接持有子进程管道。drawer 是 GUI 展示 subagent 对话流的只读视图。

现状数据流（含已落地的引擎抽象结构）：

```
[extension（主 pi 进程内）]
  SubagentService.executeAndAwait（编排：record/worktree/生命周期）
    → session-runner.runSpawn（:1336 spawn 子进程）
        ├─ buildSpawnInvocation（:974 组装 spawnArgs）
        │    └─ getPiInvocation（pi-invocation.ts，spawn 目标解析 SSOT）
        ├─ buildChildEnv（:925，{...process.env} + PI_SUBAGENT_* 身份）
        └─ stdout pump → spawn-event-adapter → AgentEvent
             ├─ updateFromEvent → 内存 record（全量，实时）
             ├─ text_delta 且仅 text_delta → SubagentStream → setWidget 私货
             │    → 主 pi stdout → runtime event-adapter 前缀短路（:419）
             │    → subagent.stream_delta（transient，不可回放）→ 前端 drawer
             └─ 终态迁移 → appendEntry(subagent-record) → runtime 防抖重拉
                  → session.subagents（state 帧）→ 前端 records 列表
[引擎抽象（P1-P5 已落地）] routing.ts 三层路由 → PiEngine（薄适配，run 委托 executeAndAwait）
[runtime reload 腿] getSubagentHistory：record.engine='pi' → JSONL 直读（零变化）；
  非 pi → subagent-engine-history.ts 三级降级（P5）
[前端] 虚拟分区 subagent:<mainSid>:<subId>（shared/virtual-session-id 工厂 SSOT）
  + core applyEntry reducer（live ≡ reload 构造性成立的既有范式）
```

### 1.3 三根因（证据锚点已按现状代码重新核对）

| # | 根因 | 机制 | 现状锚点（已核对） |
|---|------|------|------------------|
| R1 | 续聊轮 stream 永久销毁 | `SubagentStream` 仅 `kickOffBackground` 首轮创建；`runAndFinalize` finally 即 `stream?.dispose()`（每轮）；续聊轮 `deliverMessage` 热路径不重建，onDelta 被 `disposed` 静默丢弃；前端无重订阅机制 | `subagent-service.ts:1508`（初稿写 1504，引擎抽象改动后漂移 +4 行，dispose 语义仍在）、`stream-sink.ts:57,63`、`SubagentTab.vue:183`（subscribeStream 仅随 selectedSubagentId 切换） |
| R2 | 工具执行期间零推送 | agentEvent 统一出口只把 `text_delta` 分流进 stream 通道；tool_start/tool_end/thinking 事件不进任何实时通路 | `session-runner.ts:787`（锚点与初稿一致） |
| R3 | 订阅决策依赖陈旧缓存 | `isRunning` 读 records 分区（切会话/切 tab 才首拉 + state 帧推送），`openSubagent` 不刷新；transient 帧丢失不可回放 | `stores/subagent.ts:152`、`message-bus.ts:102`（`subagent.stream_delta: 'transient'`） |

三根因的共同上位根因：**实时通路是一条「只覆盖 text_delta、不可回放、生命周期与 record 状态机脱钩」的私货旁路**，而主对话流早已确立「实时帧与持久化 entry 喂同一 reducer，live ≡ reload 构造性成立」的纪律（项目关键规则 9）。修补旁路（A 方案）只能治 R1；让 drawer 接入与主对话流同构的通路（E 方案）才能同时消解三个根因。

### 1.4 设计目标（从使用者体验倒推）

1. **drawer 全类型实时可见**：打开 drawer 看 running subagent，文本逐字流出、工具块出现与完结可见、续聊多轮全程不冻结，与主对话流体感一致（覆盖 R1/R2/R3）。
2. **live ≡ reload**：经 relay 的实时帧与重开 session 的 P5 extractor 读取链产出一致（对齐 `apply-entry-equivalence` 测试范式与项目关键规则 9）。
3. **主对话流零争抢**：subagent 全量事件改走本地 socket，主 pi stdout 卸载 widget 私货流量；主对话流打字机无可感知卡顿。
4. **TUI / 纯 pi 零回归**：relay env 不存在时 spawn 目标即真实 pi 二进制，行为与现状逐字节一致；universal 包自足性不被新通道绑架。
5. **引擎抽象资产化**：relay 以引擎抽象的 launcher 层变体落地（§2.1），zcode 等粗粒度引擎不走 relay 也不损失首期能力（§2.5）；conformance 契约经 relay 变体也转绿（§2.3）。

**in scope**：E 方案全部组件的实施设计——代理 CLI 协议与实现形态、runtime relay 基建、extension 侧 spawn 切换、前端接入与 widget 通道退役、错误规格、实施拆分与验收。

**out of scope**：逐行实现与测试代码（下一层）；A 方案与 D 方案的实施细节（附录 A 仅保留架构级描述作退路）；zcode 的 relay 托管增强（§2.5 标注为后续可选）；drawer UI 视觉设计；引擎抽象本身（既有文档，本文只引用）。

### 1.5 演进路径决策（跳过 A 直达 E）

初稿推荐「一期 A 止血（1-2 天）→ 二期 E（1-2 周）」，本设计按主 agent 决策调整：**直接实施 E**。理由：①A 只修 R1，R2/R3 原样留存，drawer「工具期黑屏」继续存在，止血价值有限；②A 的改动（续聊轮重建 SubagentStream + 前端重订阅）在 E 落地后全部拆除——A 是为 E 制造的临时结构，违反「演进不返工」原则；③E 的 extension 侧改动收敛为一个 spawn 分支（§5），风险低于 A 的 stream 生命周期重造。代价：E 落地前 R1 继续存在（drawer 续聊轮冻结），由使用侧规避（重开 drawer 刷新快照）。

## 2. 与引擎抽象的精确接点（五个）

引擎抽象设计（§2.4 初稿分析 + 本分支落地结构）与本方案正交：抽象解决「spawn 谁」，E 解决「数据怎么到 drawer」。五个接点如下，每条含「已落地代码中的落点 + 改动形态」。

### 2.1 接点一：launcher 变体归属——推荐「同一 PiEngine 内的 spawn 通道参数」

E 的 spawn 目标切换有两种归属形态，对比：

| | 形态 a：PiEngine 内 spawn 通道参数（推荐） | 形态 b：独立 RuntimeHostedEngine adapter |
|---|---|---|
| 概念 | pi 引擎身份不变，spawn 经由谁是一个**环境条件分支**（relay env 齐备 → 经代理 spawn） | 新 engine id（如 `runtime-pi`），registry 登记第二个 adapter |
| 与 D9 路由语义的关系 | 引擎选择三层优先级（调用参数 > frontmatter > 全局默认）不受影响——用户配置的还是 `pi`，relay 是宿主环境能力，静默升级拓扑 | 「pi → runtime-pi」需要路由层旁路自动升级，违反「引擎选择是配置决策」的单一权威；用户显式 `engine: pi` 时是否升级产生歧义 |
| record.engine / handle | 恒 `pi`，P5 读取链（session-service.ts:1005 分协议路由）零感知 | record.engine 变为 `runtime-pi`，P5 三段链要为它新增「实为 pi」的投影别名，journal engineId、conformance golden 目录全部连带 |
| capabilities 声明 | 不变（30+ 事件流、sessionRead: full——relay 字节级转发，能力面无差异） | 新 adapter 要么复制 PiEngine 全部声明（重复），要么声明漂移 |
| conformance | 同一套 C1-C8 契约加 relay 变体跑一遍（§2.3），证明「同一引擎、两条 spawn 通道、同一契约」 | relay adapter 独立跑契约，与 PiEngine 的等价性需要额外证明 |
| TUI 零回归 | relay env 不存在 → 分支不激活，现状路径逐字节不变 | registry 多一个条目，TUI 不受影响但「何时该用它」的判定仍要 env 条件分支——没省掉分支，只是把它挪进了路由层 |
| 改动面 | pi-invocation.ts 加一个前置分支 + buildChildEnv 加 2 个 env（§5） | 新 engines/runtime-hosted/ 目录 + registration + routing 旁路 + P5 别名 |

**推荐形态 a**，关键论据：relay 改变的是**进程拓扑**（spawn 经由谁），不是**引擎身份**（spawn 谁、事件语义、session 格式全都不变）。引擎抽象的 adapter 边界按「引擎身份」划分（D10 MVP 集 = {pi, zcode}），把拓扑变体做成第二个 adapter 会制造「实际是 pi 但叫别的名字」的引擎——record、journal、golden、P5 链全部要为这个别名付代价。形态 a 同时是**可复制的模式**：未来 claude-code 等流式引擎要 relay 时，在其 adapter 的 invocation 组装层加同样的环境分支即可，复用的是 runtime relay 基建（§4）而非 pi 特例 hack。

**已落地代码落点**：`extensions/universal/subagent-workflow/src/execution/pi-invocation.ts`（`getPiInvocation` 三分支决策链，被 session-runner `buildSpawnInvocation`（session-runner.ts:1006）与 PiEngine.probe（pi-engine.ts:165）两处消费）。

**改动形态**：`getPiInvocation` 增加可选第二参 `opts?: { relay?: boolean }`，默认 relay 判定开启（四个 relay env 齐备时返回 `{ command: <relay JS runtime>, args: [<relay script>, ...userArgs] }`，与现有「分支 1：node + script」形态同构）；probe 调用点显式传 `{ relay: false }` 探 pi 本体。详见 §5.2。

### 2.2 接点二：relay env 通道——XYZ_ 前缀已覆盖，注入链全程已核实

**env 名（5 个，全部 `XYZ_` 前缀，`ENV_WHITELIST_PREFIXES`（`packages/shared/src/constants.ts:72`，含 `'XYZ_'`）已覆盖，无需新增登记）**：

| env 名 | 值 | 注入方 |
|---|---|---|
| `XYZ_SUBAGENT_RELAY_SOCKET` | relay socket 路径（per-runtime-instance，§4.1） | runtime |
| `XYZ_SUBAGENT_RELAY_NODE` | 代理脚本执行器路径（dev=node；打包版=Electron 二进制 + `ELECTRON_RUN_AS_NODE=1`，§3.2） | runtime |
| `XYZ_SUBAGENT_RELAY_SCRIPT` | relay.mjs 绝对路径（staged 资产，§3.2） | runtime |
| `XYZ_SUBAGENT_RELAY_SESSION_ID` | 帧归属：主 session id（与 `PI_SUBAGENT_ROOT_SESSION_ID` 同源 = ctx.sessionRootId，嵌套 spawn 时孙进程仍归属真 ROOT 会话） | extension（buildChildEnv） |
| `XYZ_SUBAGENT_RELAY_RECORD_ID` | 帧归属：record id（= 虚拟分区 subId，与 shared `subagentVirtualId` 三段式第三段一致） | extension（buildChildEnv） |

**注入链（已逐段核实）**：

```
runtime relay server 启动（创建 socket + 计算脚本/runtime 路径）
  → process-manager.createSession 的 RpcClient 构造 env 入参（process-manager.ts:215
    组装处，与 XYZ_AGENT_DATA_DIR 同点）传入 3 个 runtime 侧 env
  → rpc-client buildSafeEnv（rpc-client.ts:14-27）：显式 extras 无条件加入
    （XYZ_ 前缀同时在白名单，双保险）→ 主 pi 进程 env
  → 主 pi 进程内 extension 的 process.env 持有
  → session-runner buildChildEnv（session-runner.ts:930 `{ ...process.env }`）
    自动继承 3 个 runtime 侧 env + 显式写入 2 个归属 env
  → 代理进程 env → 代理从自身 env 组装握手帧（§3.1）
```

设计要点：runtime 侧只注入「基础设施 env」（socket/执行器/脚本），extension 侧只注入「归属 env」（session/record）——每类信息由其权威所有者注入，代理握手帧是两者的汇合点，extension 不做任何路径推导。

### 2.3 接点三：conformance 契约套件加 relay 变体

**已落地代码落点**：`extensions/universal/subagent-workflow/src/execution/engine/__tests__/conformance/`（agent-event-invariants.ts、contract.{probe,agent-events,abort,read-degradation}.test.ts、engine-conformance.live.test.ts（`ENGINE_CONFORMANCE_LIVE=1` 手动门）、golden-replay.{pi,zcode}.test.ts、`__fixtures__/`）。

**改动形态**：新增 `contract.relay.test.ts`（golden 回放层，免 LLM）+ `engine-conformance.live.test.ts` 加 relay describe（run 层，手动门）。断言口径：**同一契约，spawn 通道不同**——

1. relay 变体 C2：经 relay spawn 跑简单任务，outcome 无 error、engineId 仍为 `pi`（relay 不是引擎身份）。
2. relay 变体 C3：事件不变量五条（agent-event-invariants.ts 既有断言）对「经代理转发的子进程 stdout」逐一成立——代理是字节级转发，翻译层产出的 AgentEvent 序列应与直连 spawn 全等（同一 parser 消费同一字节流）；live 层用真实 LLM 任务实录比对，golden 层用固定 fixture 字节流经伪 relay（本地 socket 环回）回放比对。
3. relay 变体 C4：运行中 cancel → SIGTERM 代理 → 代理退出 → socket 断 → runtime 杀真实 pi；断言无僵尸（代理 pid 与真实 pi pid 双扫描）。
4. 环境回归：relay env 部分缺失（如只注入 SOCKET 不注入 NODE）→ spawn 回落真实 pi 二进制，无半激活状态（`getPiInvocation` 判定是全有或全无）。

套件有牙的既有负例机制（故意破坏不变量断言转红）自然覆盖 relay 变体，无需额外元测试。

### 2.4 接点四：P5 reload 腿是 E 的降级保底，live ≡ reload 对齐既有测试范式

**已落地代码落点**：`packages/runtime/src/services/session/subagent-engine-history.ts`（P5 三段链：①引擎原生共享 reader → ②宿主 event journal 重放 → ③outcome-only）；`packages/runtime/src/services/session/session-service.ts:996-1015`（`getSubagentHistory` 分协议路由——record.engine='pi' 走既有 JSONL 直读链零变化，非 pi 走三段链）；`packages/core/src/domain/chat/apply-entry.ts`（reducer 本体）+ `packages/core/src/domain/chat/__tests__/apply-entry-equivalence.test.ts`（等价性测试范式）+ `packages/runtime/src/__tests__/equivalence/live-reload.test.ts`（live ≡ reload store 级同构，真实 pi 子进程）。

**E 与 reload 腿的关系（两条不变量）**：

1. **E 不改 reload 腿**：relay 不改变 record.engine（恒 pi）与子进程 JSONL 落盘行为，`getSubagentHistory` 的 pi 直读链（session-service.ts:1011 起）零改动。子进程 session 文件仍是唯一权威源——tee 是旁路视图，tee 翻译失败时 drawer 降级为快照 + 重开读取（§7 第 4 条），P5 直读链是兜底。pi 引擎不走 P5 三段链（A1 守护），但三段链证明的「读取降级」哲学对 E 同样成立：E 的 live 腿挂了，reload 腿还在。
2. **live ≡ reload 的一致性由同一 reducer 构造性保证**：E 的 tee 侧产出（经 event-adapter 翻译 → entry 化 → WS 帧）与 reload 侧产出（JSONL 直读 → convertPiHistory → lift → entry）**喂同一个 `applyEntry` reducer**（`packages/core/src/domain/chat/apply-entry.ts`，前端虚拟分区消费）。E 新增一条等价性测试：经 relay 的 live entry 序列与同 session 重开后 P5 直读链的 entry 序列，replayEntries 产出 state 全等——测试形态对齐 `apply-entry-equivalence.test.ts`（同序列两次喂入 deep equal）与 `live-reload.test.ts`（真实子进程双通路），落点在 `packages/runtime/src/__tests__/equivalence/` 新增 relay 用例（§9 E-重开场景是其真机面）。

### 2.5 接点五：zcode 等粗粒度引擎不走 relay，也不损失首期能力

**已落地代码落点**：`extensions/universal/subagent-workflow/src/execution/engine/engines/zcode/`（zcode-engine.ts 编排四件套；launcher.ts argv-only spawn `node <zcode.cjs> --json --prompt ...`，stdin='ignore'；parser.ts stdout 有界收集 → 单 JSON 终态 → coarse 事件合成）。

**论证**：relay 对引擎的 GUI 价值 = tee 子进程事件流给翻译层。zcode spawn 单轮模式的 stdout 是「终态单 JSON」——没有流可 tee，中途零事件，relay 无法产生任何实时增量。zcode 首期的 drawer 能力由引擎抽象既有设计承载：`capabilities.eventGranularity: 'coarse'` → D11 四级处置的「显示降级」（GUI 阶段态卡片，引擎侧信息不存在，永不弹错），D6 三级降级链保证重开可读。因此 relay 接入判定锚定 **「pi 引擎 + rpc 流式 spawn」**，不做引擎中立泛化。

**后续可选增强（标注，不进本期）**：relay 对粗粒度引擎有一个非 GUI 价值——**进程托管**（runtime 持有子进程 → app 崩溃/退出时注册表清理无孤儿）。若未来 zcode 出现流式输出模式（app-server 常驻形态）或孤儿进程成为实测问题，ZcodeEngine 的 launcher 层可按 §2.1 形态 a 加同样的环境分支复用 relay 基建——模式可复制，无需提前建设。

## 3. 代理 CLI 规格

### 3.1 协议

**角色**：代理是「extension 眼中的 pi 子进程」与「runtime 眼中的 relay 客户端」的双面字节泵。对 extension：stdio pipe 语义与 spawn 真实 pi 字节级同构（pid/kill/exit code 可用）；对 runtime：本地 socket 客户端，先握手后转发。

**握手帧（代理 → runtime，socket 连接后第一帧，单行 JSONL）**：

```json
{"v":1,"kind":"handshake","mainSessionId":"<XYZ_SUBAGENT_RELAY_SESSION_ID>","recordId":"<XYZ_SUBAGENT_RELAY_RECORD_ID>","argv":["--mode","rpc",...],"env":{"PI_SUBAGENT_*":...,"XYZ_SUBAGENT_RELAY_*":...},"cwd":"/path/to/worktree"}
```

字段语义：

| 字段 | 来源 | 消费方（runtime）用途 |
|---|---|---|
| `v` | 协议版本常量（1） | 版本协商（见下） |
| `mainSessionId` / `recordId` | 代理自身 env（extension 注入） | 注册表键 + tee 帧归属 → WS 帧路由到虚拟分区 `subagent:<mainSessionId>:<recordId>`（关键规则 7：runtime → 前端消息必须带 sessionId） |
| `argv` | `process.argv.slice(2)`（= 原 pi spawnArgs，extension 传给代理的 userArgs 原样） | runtime spawn 真实 pi 的 argv（`buildPiSpawnCommand(argv)` = 经 pi-invocation 同款决策链解析 command/args） |
| `env` | 代理自身 env 全量（已含 buildChildEnv 的 PI_SUBAGENT_* 身份与白名单继承） | runtime spawn 真实 pi 的 env（**原样使用**——身份贯穿/schemaEnv/worktree 标志全在其中，runtime 不增删；XYZ_SUBAGENT_RELAY_* 由 runtime 剥离后注入，防孙进程嵌套 relay 时旧值误导） |
| `cwd` | `process.cwd()`（extension spawn 代理时的 spawnCwd，即 worktree checkout 或 ctx.cwd） | runtime spawn 真实 pi 的 cwd |

**转发语义（握手成功后双向字节泵）**：

- extension stdin 写 → 代理 stdin 收 → socket 下行帧 → runtime 写真实 pi stdin（prompt/steer/abort RPC 命令）。
- 真实 pi stdout 字节 → runtime 读 → ①socket 上行帧 → 代理 → 代理 stdout 写 → extension stdout pump 消费（**编排通路，字节级保真**）；②tee 分支 → event-adapter 子进程实例（**GUI 通路，翻译失败单事件隔离**，§4.3）。
- 帧格式：JSONL `{"v":1,"kind":"data","dir":"up"|"down","b64":"<base64 字节>"}`——stdin/stdout 是二进制不安全通道（虽然现状 RPC 是 JSONL 文本，协议层不假设文本，base64 封装保字节精确）。
- stderr：真实 pi stderr → runtime 转发同款上行帧（`dir:"up-stderr"`）→ 代理写自身 stderr（extension 的 stderrBuffer 累积语义不变）。
- 退出传播：真实 pi exit（code/signal）→ runtime 发 `{"kind":"exit","code":C,"signal":S}` 帧 → 代理以相同 code/signal 退出（extension 的 collectResult/收尾逻辑看到的行为与直连一致）。

**版本协商与拒绝行为**：握手帧 `v` > runtime 支持版本 → runtime 回 `{"kind":"reject","reason":"version","supported":[1]}` 帧并关连接 → 代理以退出码 **10**（版本不匹配专用）退出，stderr 打印「relay protocol version mismatch: agent vN, runtime supports [1]。Recovery: 升级 xyz-agent（runtime 与代理资产同包分发，版本不一致意味着安装损坏，重装应用）」。socket 连接失败（runtime 未就绪/路径过期）→ 代理以退出码 **11** 退出，stderr 打印 socket 路径 + 「relay socket unreachable（runtime 未运行或已重启）。Recovery: 重试任务；持续失败请重启 xyz-agent」。两种失败都表现为 extension 眼中「子进程非零退出」→ 走既有子进程启动失败路径（record 正常收尾，§7）。runtime 侧 `v` < 代理版本不对称场景不存在（§3.2 决策 B 使代理脚本与 runtime 同包同版本）。

### 3.2 实现形态决策——推荐「宿主 JS runtime + 纯 JS 脚本」

三个候选：

| | A. node SEA standalone 二进制 | **B. 宿主 JS runtime + 纯 JS 脚本（推荐）** | C. 依赖系统 node |
|---|---|---|---|
| 形态 | node Single Executable Application 构建平台产物，随 resources 分发（pi binary 先例：prepare-pi-resources.sh） | relay.mjs 一个零依赖脚本 + env 声明执行器：dev = runtime 的 node；打包版 = Electron 二进制 + `ELECTRON_RUN_AS_NODE=1`（runtime 注入 `XYZ_SUBAGENT_RELAY_NODE` 指向二者之一） | spawn `node <relay.mjs>` 依赖 PATH |
| 分发矩阵 | 每平台构建产物（darwin-arm64/x64、linux-x64/arm64、win-x64），构建管线 + postject 注入 + 产物校验 | 脚本经 builtin extension staged 资产机制分发（pi-permission 的 wasm 先例：bundle-extensions.mjs 拷贝资产 → resources/extensions → electron-builder extraResources，apps/electron/electron-builder.yml:74），零新增构建管线 | 零分发 |
| 打包版无 node 约束 | ✅ | ✅（Electron 二进制内嵌 node；ELECTRON_RUN_AS_NODE 是 Electron 官方支持的纯 node 模式，VS Code helper 同款） | ❌ 违反（用户机器无 node 保证） |
| 版本矩阵 | SEA 固化 node 版本，与宿主解耦——但 SEA API 仍 experimental，跨版本行为有漂移史 | 跟随宿主：dev=node 开发机、打包=Electron 内嵌 node，**代理与 runtime 恒同源同版本**（版本不匹配场景构造性消失） | 用户机器 node 版本不可控（14/16/20+ 行为差异） |
| 杀软/签名 | 新二进制：Windows SmartScreen 未签名拦截风险、macOS 需公证；「无签名的自构建二进制」是杀软高敏形态 | 无新二进制——Electron 二进制已随应用公证/签名；脚本文件无杀软面 | 无新二进制 |
| 实现复杂度 | SEA 构建管线接入 CI + 三平台产物矩阵维护 + 失败面 | env 注入（E-2）+ 零依赖脚本（E-1）；待验证项见 §10（runtime 打包形态下 process.execPath 的可用性） | 最低但不可用 |

**推荐 B**。核心理由：**代理与 runtime 同包同版本**使协议版本协商（§3.1）从「运行时协商问题」降级为「安装完整性问题」——builtin extension staged 机制已经解决了「资产随包分发且与宿主同版本」的工程问题，B 直接继承；A 为同一问题引入新的三平台构建管线与杀软面，唯一的收益（零宿主依赖）在「宿主必然存在（relay 只在 xyz-agent runtime 存在时激活）」的前提下没有价值。**B 被证伪时的退路是 A**：待验证检查点（§10-1）若发现 ELECTRON_RUN_AS_NODE 在目标 Electron 版本/平台不可用，按 pi binary 同款机制（prepare-pi-resources.sh 模式）构建 SEA——协议与注册表设计不受形态切换影响。

### 3.3 崩溃矩阵（三场景进程链与清理责任方）

进程链（正常运行）：`extension(主 pi) —spawn→ 代理 —socket→ runtime(注册表) —spawn→ 真实 pi`。

| 场景 | 进程链演变 | 清理责任方 | 孤儿防护 |
|---|---|---|---|
| ① 主 pi 崩溃（extension 宿主死） | 代理变孤儿（父进程死，OS 不杀子）→ **reaper 杀代理**（lifecycle-manager 孤儿扫描记的是代理 pid——extension spawn 的就是代理，record.pid/alive marker 天然指代理）→ 代理死 → socket 断 | extension 侧 reaper（既有机制，记代理 pid，原位工作）；socket 断后 runtime 注册表杀真实 pi（§4.2 断连即杀） | 真实 pi 无孤儿：代理死 → runtime 兜底杀。worktree reaper 同链（onWorktreePid 记代理 pid，杀代理等效触发） |
| ② runtime 崩溃 | socket 断 → 代理检测到 socket close/EOF → 代理自身退出（协议内置：socket 连接是代理的生命线，socket 断 = 退出码 12）→ extension 感知「子进程死亡」→ 走既有子进程死亡收尾（record 正常 finalize） | 代理自杀（协议语义）；真实 pi 变孤儿——runtime 死后无人持有其管道，**OS 进程组兜底**：runtime spawn 真实 pi 时归入 runtime 进程组（或 detached:false + runtime 退出信号传播），runtime 崩溃即整树收割；残留场景由 runtime 重启后的 stale socket 清理（§4.1）+ 注册表持久 pid 文件扫描兜底 | 双保险：进程组传播（主）+ 重启扫描（兜底，pid 文件含 spawn 时间戳防 pid 复用误杀） |
| ③ 代理崩溃（代理自身异常死） | extension 感知子进程非零退出（'error'/'close' 事件）→ 走既有失败路径（record 收尾 + collectResult 合成 error） | extension 走既有失败路径；runtime 侧 socket 断 → 注册表杀真实 pi（断连即杀，§4.2） | 真实 pi 无孤儿：断连即杀语义覆盖 |

三场景共性：**extension 侧的全部生命周期机制（alive marker/reaper/watchdog/EPIPE 计数/dispose 兜底 kill）作用于代理进程，语义原位成立**——这是 E-D1 选「独立代理进程」而非「extension 内直连 socket」的根本回报：进程语义靠 OS 保证，无需应用层协议模拟。chatMode idle 保活进程的交互补充见 §10-4。

## 4. runtime relay 基建规格

**新增模块归属**：`packages/runtime/src/infra/relay/`（relay-server.ts / relay-registry.ts / relay-tee.ts），与 `infra/pi/` 平级——relay 是跨会话基础设施（不属单一 session）。

### 4.1 socket server

- **路径**：`<getDataDir()>/run/relay-<runtimePid>.sock`——per-instance 唯一（多 app 实例共存时互不串扰；路径含 pid 使崩溃残留可识别归属）。动态推导（getDataDir()），符合「禁止写死绝对路径」排查规则。
- **平台差异**：darwin/linux 用 unix domain socket（`node:net`）；win32 用 named pipe（`\\.\pipe\xyz-agent-relay-<pid>`，node API 形态同 `net.createServer({ path })` 传 pipe 名）。路径经 env 注入（§2.2），extension/代理零平台感知。
- **权限**：unix socket 默认受目录权限保护（`<getDataDir()>` 属当前用户 0700）；server 侧再校验握手帧 mainSessionId/recordId 非空 + `env` 必含 `XYZ_SUBAGENT_RELAY_*`（缺失拒绝，防任意本地进程挂载借道 spawn）。**不引入认证 token**——本地 socket + 用户目录权限已是边界，加 token 是为不存在的攻击面加复杂度（socket 创建到握手完成窗口内的本地同 uid 进程本就可伪造任何东西）。
- **生命周期**：runtime 启动即 listen（lazy 也行——首个主 pi spawn 前创建即可，早建早发现权限问题）；runtime 关停（SIGTERM/SIGINT 优雅退出）→ 对所有已注册子进程走杀链（SIGTERM → grace → SIGKILL）→ 删 socket 文件。启动期发现残留 socket（上次崩溃）→ 尝试 connect 探活：连不上则删除重建（旧 runtime 已死）；连得上则报错退出（实例冲突，错误信息含两个 pid）。

### 4.2 子进程注册表（连接 → spawn → 断连即杀）

- **注册**：socket 连接 + 合法握手帧 → runtime 解析 argv/env/cwd → 经与 pi-invocation 同款决策链（**runtime 侧复刻 `buildPiSpawnCommand(argv)`**：dev=resources/pi 的 pi 二进制、打包=process.cwd()/pi/，即 process-manager.ts findPiExecutable 既有逻辑抽出复用）spawn 真实 pi → 登记条目 `{conn, mainSessionId, recordId, child, pidFile, tee, log}`（`log` 为 up 方向 stdout 原始字节镜像写入器——落盘 `<getDataDir()>/logs/pi-relay-<date>-<recordId>.jsonl`，对照主 pi 的 `pi-<date>-<sessionId>.jsonl` 模式，架构约定「pi 卡死时唯一证据」对 relay 子进程同款覆盖；写失败降级 warn 不连坐转发主链，cleanupEntry 时 end 流）。
- **断连即杀**：socket close（任何原因——代理死/主 pi 崩溃/extension kill）→ 对 child 走杀链（SIGTERM → grace 3s → SIGKILL；语义对齐 extension 侧 common/kill-chain 但**独立实现**——依赖方向纪律（引擎抽象 §3.3.1 贯穿纪律④：runtime 不 import adapter 运行时件），runtime 不引 extension 包的 kill-chain）。杀链完成 → 删 pid 文件 → 注销条目。
- **pid 文件**：`<getDataDir()>/run/relay-children/<recordId>.pid`（内容 pid + spawn 时间戳）——runtime 崩溃重启后的残留进程兜底扫描依据（§3.3-②），扫描时核对时间戳 + /proc 或 kill -0 探活，活的按孤儿收割。
- **并发**：多 subagent 并行 = 多条 socket 连接多注册条目，天然并发（registry 内 Map，无共享可变态）；背压由 node stream 默认机制处理（tee 与转发共用同一次读取顺序分发，见 §4.3）。

### 4.3 tee 翻译层（event-adapter 子进程流实例化）

- **实例化**：`infra/pi/event-adapter.ts` 是纯翻译器（「Each session gets its own adapter instance」既有先例，文件头注释）——每个注册的子进程流 new 一个 adapter 实例（+ 对应的 entry 化管线实例），**不与主 pi 会话的 adapter/interpreter 共享任何状态**。
- **帧归属**：握手帧的 `mainSessionId` + `recordId` 是 tee 产物的路由键——所有经 tee 产出的 WS 帧必须带 sessionId（关键规则 7），虚拟分区 ID = `subagentVirtualId(mainSessionId, recordId)`（shared 工厂 SSOT，`packages/shared/src/virtual-session-id.ts`）。
- **管线形态**：tee 字节流 → event-adapter（PiEvent → PiTranslatedEvent）→ **复用主对话流的 entry 化管线**（翻译事件 → PiEntry 重构，与 event-interpreter 的 GUI 广播产出同构，但不经过 interpreter 的 session 状态回写——tee 是只读旁路）→ 新 WS 帧 `session.subagentEntriesAppended {sessionId: <mainSid>, subagentId: <recordId>, entries: PiEntry[]}` 广播（message-bus topic 表登记为 **state** 类的 **state-no-key 混合形态**：分配 seq 但刻意**不入 ring、不入快照**——增量 entry 流不是 last-value 语义，快照覆盖会丢中间 entry；subagent 长任务高频帧入 ring 会冲刷主对话流的可回放缓冲制造主流 gap。重连对账不靠快照/ring：renderer reducer 按 entry id 幂等去重 + 重开 session 时经 fetchAndInject 拉全量快照，实装语义见 `message-bus.ts` 的 STATE_TYPE_KEY_MAP「例外登记」段；本节初稿括注「可回放对账」与实装不符，已按实装修订）。
- **text_delta 中间态**：tee 侧翻译出的 text_delta 增量续用既有 `subagent.stream_delta` 帧（event-interpreter.ts:367 路径 A-1 形态，payload 归属改经握手帧路由）——打字机效果不等待 entry 帧。
- **翻译失败隔离**：单事件 try-catch（对齐 interpreter W1 per-event 隔离范式）——翻译异常的**单个事件**丢弃 + warn 日志（含 recordId 与原始字节 tail），不连坐后续事件、不影响编排通路（转发分支独立）、不杀进程。连续 N 条失败（如 ≥50）→ 放弃该子进程的 tee 分支（转纯转发），drawer 降级为快照 + reload（§2.4 保底）。
- **资源纪律**：子进程退出（exit 帧发出）→ 注册表注销时同步销毁 tee 实例（adapter/entry 管线/缓冲全释放）；内存影响评估见 §10-3。

### 4.4 与现有 process-manager / pi 进程体系的关系（不重复造进程管理）

- **process-manager.ts**（`packages/runtime/src/infra/pi/process-manager.ts`）管「runtime 直接发起的主 pi 会话进程」（RpcClient 生命周期：createSession/attach/销毁）——relay 子进程的**发起方是 extension**（经代理转交），runtime 只是受托执行人，**不进 RpcClient 体系**（无 RPC 会话语义、无 attach 需求）。两套进程表并列：RpcClient 表（主 pi 会话）+ relay 注册表（受托 subagent 子进程）。
- **复用面**：`findPiExecutable`（pi 二进制定位，dev/resources 与打包路径分流）抽出为共享函数供注册表 spawn 用；杀链语义对齐但实现独立（§4.2 依赖方向）；日志落盘纪律对齐（relay-server/registry 事件进 `<getDataDir>/logs/` 既有轮转体系，新增 relay logger 前缀）。
- **不碰面**：relay 不改 RpcClient、不改 process-manager 既有方法签名、不参与主 pi 会话生命周期——E-2 是纯新增模块 + process-manager 一处 env 注入（§2.2）+ findPiExecutable 抽取重构。

## 5. extension 侧接入规格

### 5.1 spawn 目标切换条件（env 存在性，全有或全无）

**唯一判定**：`XYZ_SUBAGENT_RELAY_SOCKET && XYZ_SUBAGENT_RELAY_NODE && XYZ_SUBAGENT_RELAY_SCRIPT` 三者同时非空 → relay 激活；任一缺失 → 现状路径（spawn 真实 pi），无中间态。激活时 spawn 形态：

```
command = XYZ_SUBAGENT_RELAY_NODE（+ env 注入 ELECTRON_RUN_AS_NODE=1 当执行器为 Electron）
args    = [XYZ_SUBAGENT_RELAY_SCRIPT, ...原 pi spawnArgs]
```

归属 env（SESSION_ID/RECORD_ID）由 buildChildEnv 同点写入（§5.2 第 2 条），不参与激活判定（缺失只影响 tee 归属，代理握手帧对它们做空值校验：缺失 → 代理拒绝启动退出码 13，防无归属帧污染广播）。

**probe 排除**：PiEngine.probe（pi-engine.ts:165 `getPiInvocation(["--version"])`）显式传 `{ relay: false }`——探针意图是 pi 本体可解析性，经 relay 探到的是 runtime 健康，语义错位。

### 5.2 函数级改动形态（精确到函数）

| # | 落点（文件:函数） | 改动 |
|---|---|---|
| 1 | `pi-invocation.ts:getPiInvocation(userArgs, opts?: { relay?: boolean })` | 新增前置分支（opts.relay !== false 且三 env 齐备时返回 relay invocation，形态与分支 1「node + script」同构）；现有三分支不动（fallback 语义原样） |
| 2 | `session-runner.ts:buildChildEnv` | 追加 2 行 env 写入：`XYZ_SUBAGENT_RELAY_SESSION_ID = ctx.sessionRootId`、`XYZ_SUBAGENT_RELAY_RECORD_ID = record.id`（对齐 PI_SUBAGENT_ROOT_SESSION_ID/SELF_RECORD_ID 既有四元组的命名与同源性）；relay 未激活时写 undefined（`{...process.env}` 继承值保持，子 pi 进程内这些 env 无消费者，无害）——**注意**：这两行只在 relay 激活（同 §5.1 判定）时写入实际值，避免无 relay 环境下子 pi 进程携带误导性 env |
| 3 | `session-runner.ts:buildSpawnInvocation` | 零改动（它只是透传 userArgs 给 getPiInvocation，relay 分支在 getPiInvocation 内） |
| 4 | 新增 `execution/relay-env.ts`（约 30 行） | relay env 名常量 + `isRelayActive(env)` 判定函数（单一权威，§5.1 判定 + buildChildEnv 条件 + 测试三处消费；env 名常量与 runtime 侧镜像一致由 conformance relay 变体断言锁定） |

改动总量：1 个文件加分支 + 1 个文件加 2 行 + 1 个新 30 行模块。

### 5.3 session-runner 零改动承诺的验证方式

**承诺的精确边界**：session-runner.ts 的 spawn 执行段（spawn 调用 :1336、stdout pump attachStdoutPump、get_state 握手、watchdog、EPIPE handler、close handler、collectResult）与编排层（subagent-service/subprocess-agent-runner/PiEngine）**零行改动**——relay invocation 与直连 invocation 是同形 `PiInvocation`（command + args），下游全链路（spawn → stdio pipe → 逐行解析 → 握手）对目标无感知。

**验证方式（三道门，进 E-3 验收）**：

1. **diff 门**：E-3 PR 中 `git diff` 确认 `session-runner.ts` 仅有 buildChildEnv 的 2 行 env 写入（§5.2-2）——这是 env 组装函数的追加，不是 spawn 执行段改动；spawn 执行段行号区间 diff 为零。
2. **测试门**：session-runner 既有测试家族（`__tests__/` 下 session-runner 相关 + chatmode/spawn 系列）全绿零修改——它们 mock spawn 层或不注入 relay env，行为路径与改动前逐字节一致。
3. **真机门**：relay 激活下完整跑一个 subagent 任务（E-验收 §9），get_state 握手、record 收尾、worktree reaper 注册全部正常——证明「代理字节级扮演」成立（握手帧经 socket 往返后 byte-equal，stdout pump 无感知）。

## 6. 前端接入规格

### 6.1 虚拟分区 applyEntry 接入点

**已落地代码落点**：`packages/shared/src/virtual-session-id.ts`（三段式工厂 SSOT，INVAR-1.1「任何写入 messages 的 subagent key 必须经此工厂」）；`packages/renderer/src/stores/subagent.ts`（fetchAndInject :247 / subscribeStream :258 / isRunning :152）；`packages/renderer/src/components/panel/SubagentTab.vue`（drawer 自治：fetchAndInject + subscribeStream，STREAM_SCOPE token）；`packages/core/src/domain/chat/apply-entry.ts`（reducer）。

**改动形态**：

1. **新增 entry 帧消费**：`session.subagentEntriesAppended` 帧（§4.3）到达 → 解析 `{sessionId, subagentId, entries}` → `applyEntry` 逐条喂入虚拟分区 `subagentVirtualId(sessionId, subagentId)` 的消息列表——接入点在 chat store 的帧处理面（与 message.* 帧同层），经 subagent store 回调注入（store 不互 import 铁律，对齐 W4 收口范式：新增 `applySubagentEntries` 回调类型）。
2. **分区惰性创建**：帧先于 fetchAndInject 到达（drawer 未打开）时，仍写入 chatStore.messages Map 分区（Map 支持任意 key，零成本）——drawer 打开时 fetchAndInject 的快照与已累积 entry 帧经 reducer 幂等去重（§6.2），「打开即完整」。
3. **订阅简化**：SubagentTab 打开即消费 entry 帧（不再依赖 isRunning 判定订阅时机——R3 根因的消解点）；frame 到达即更新，与 record 状态机解耦。

### 6.2 text_delta 与 entry 帧去重语义

沿用源文档 D-D4 语义（E 继承）：**entry 帧是终态权威，delta 是中间态**——

- `subagent.stream_delta`（tee 侧 text_delta 续用，§4.3）驱动打字机中间态：向虚拟分区当前 assistant 消息追加未定稿文本（applySubagentStreamDelta 既有形态）。
- `session.subagentEntriesAppended` 携带该消息的定稿 entry（message_end 重构）→ reducer 按 piEntryId/确定性派生 id 匹配并**覆盖**中间态——delta 内容被 entry 定稿取代，不重复渲染。
- reducer 幂等去重继承 applyEntry 既有语义（同 entry id 二次喂入 no-op）：state 帧回放（重连/对账）与 live 帧交错天然安全（源文档错误规格第 5 条）。

### 6.3 widget 私货通道退役步骤（三步，可独立回滚）

**退役的精确含义**：GUI 链路的「`setWidget("subagent-stream-*")` → 主 pi stdout → event-adapter 前缀短路 → stream_delta」链路退役；**TUI 行为零变化**（TUI 下 setWidget 显示在终端 widget 行，SubagentStream 继续服务 TUI 用户——universal 包自足性）。

| 步 | 改动 | 回滚边界 |
|---|---|---|
| 1. 前端切源 | SubagentTab/subagent store 停止消费 `subagent.stream_delta`，打字机改由 tee 侧同帧驱动（§6.2——帧名不变、产出方从 extension widget 变 runtime tee，前端零感知切换） | 前端回退订阅即恢复旧链 |
| 2. extension 停发（GUI 模式） | relay 激活（§5.1 判定）+ `resolveHostMode(mode)==='gui'`（host-mode.ts 既有判定）时 kickOffBackground 不创建 SubagentStream（省 setWidget 流量，主 pi stdout 卸载）——TUI 与 relay 未激活环境原样创建 | 判定条件删除即恢复 |
| 3. runtime 短路拆除 | event-adapter.ts:419-421 前缀短路段删除（此时 GUI 链路已无产出方，短路是死代码）——在步骤 1/2 全量发布一个版本后执行 | 不需回滚（拆除前两步已独立成立） |

## 7. 错误规格表（源文档五条 × 引擎抽象 11 条映射）

**结论先行**：E 不新增引擎层错误 code——代理层失败全部表现为「子进程非零退出」，自然落入 `engine_run_failed` 的既有语义；runtime 侧 tee 失败是旁路降级，不进引擎错误面。逐条映射（引擎抽象 11 条见其 §3.3.3）：

| # | 错误场景（源文档 §3.5） | 进程/链路表现 | 引擎抽象错误规格映射 | 恢复指引（错误文本必备要素） |
|---|---|---|---|---|
| 1 | 代理连接失败（socket 连不上） | 代理退出码 11，extension 视角 = 子进程非零退出 + stderr 详情 | **`engine_run_failed`**（进程已创建后失败族——代理进程存在过，exit code + stderr 尾部落入其「stdout 尾部 2000 字 + exit code」语义；不设独立 code，理由：对模型/用户而言「经 relay 的 pi 启动失败」与「pi 启动失败」的恢复动作相同——重试/重启 app，独立 code 只增加分流噪声） | stderr 含 socket 路径 + 「重试任务；持续失败重启 xyz-agent」 |
| 2 | runtime 中途崩溃 | socket 断 → 代理退出码 12 → extension 走子进程死亡收尾（合成终态，record 正常 finalize） | **`engine_run_failed`** 的「宿主合成终态」形态（运行中失败不 reject、record 必须收尾——引擎抽象 §3.3.5 run 错误语义②③）；真实 pi 由进程组传播收割（§3.3-②） | error 文本注明「runtime 连接中断」；用户侧重启 app 后重开 session 验证 record 状态 |
| 3 | 代理协议版本不匹配 | 代理退出码 10 | **`engine_run_failed`**（同 1 映射；版本不匹配在同包分发下意味着安装损坏，不是可协商的运行时状态） | stderr 含「重装应用」指引（§3.1） |
| 4 | tee 翻译失败（契约漂移等） | 单事件隔离丢弃 + warn（§4.3）；编排通路（转发分支）不受连坐 | **不映射引擎错误**——tee 是 GUI 旁路，编排层 AgentEvent 消费走代理转发（不经 tee），引擎 outcome 不受影响。GUI 降级 = 快照 + reload（P5 直读链，§2.4）。对齐 interpreter W1 per-event try-catch 隔离范式 | 前端无感（drawer 停在最后一致点，重开刷新）；日志含 recordId + 原始字节 tail 供排查 |
| 5 | 前端帧乱序（state 回放 × live 交错） | reducer 按 entry id 幂等 | 非错误（applyEntry 既有去重语义） | 无需恢复动作 |

**与 11 条的交叉核对结论**：`engine_not_found`/`engine_probe_failed`/`engine_credential_missing`/`nested_spawn_rejected`/`schema_emulation_failed`/`engine_timeout`/`engine_capability_unsupported`/`engine_session_not_resumable`/`model_not_available`/`prompt_too_large` 十条与 relay 正交（relay 不改变引擎身份/准备期/能力面语义）。唯一交叉增强：`engine_timeout` 与 abort 杀链（D1 abort 分级②公共杀链）作用于**代理进程**——杀代理 → socket 断 → 注册表杀真实 pi，杀链目标换人但语义原位成立（E-3 conformance relay C4 断言此链）。`engine_session_not_resumable` 在场景 ② 后天然触发（idle 子进程死 handle 续聊拒绝，引擎抽象 A13 场景覆盖）。

## 8. 实施拆分（E-1..E-4，可并行 wave）

依赖图（无环）：**协议定稿（E-1 前置段）→ {E-1, E-2} 并行 → E-3（依赖 E-1+E-2）；E-4 依赖 E-2 的帧形态，与 E-3 并行**。

| 单元 | 内容 | 改动文件清单 | 依赖 | 验收挂钩（§9） | 与引擎抽象收尾的关系 |
|---|---|---|---|---|---|
| E-0 协议定稿 | 握手帧/转发帧 schema 常量 + env 名 SSOT（relay-env.ts 的接口面；代理侧内嵌一份镜像常量，一致性由 E-3 conformance 断言锁定——代理是零依赖脚本不能 import workspace 包） | `extensions/universal/subagent-workflow/src/execution/relay-env.ts`（新增）；协议常量段内嵌于 relay.mjs | 无 | E-3 C-relay | 立即可做（引擎抽象已收敛） |
| E-1 代理 CLI | relay.mjs（零依赖纯 JS）：握手 + 双向字节泵 + 版本协商 + 退出码语义（10/11/12/13）+ socket 断即退；单测（本地环回 socket + 伪 runtime） | `extensions/universal/subagent-workflow/relay/relay.mjs`（新增）+ `__tests__/relay-agent.test.ts`；bundle-extensions.mjs 登记资产拷贝（staged 分发，§3.2） | E-0 | E-TUI（未激活路径）+ 代理单测 | **可并行**（纯新增，零接触既有代码） |
| E-2 runtime 基建 | socket server（§4.1）+ 注册表（§4.2，含 findPiExecutable 抽取复用）+ tee 翻译层与 entry 帧（§4.3）+ env 注入（§2.2）+ 优雅关停/残留清理 + message-bus topic 登记 + tsup noExternal 核对（如 tee 引入新依赖） | `packages/runtime/src/infra/relay/`（relay-server/relay-registry/relay-tee 新增）；`process-manager.ts`（env 注入 + findPiExecutable 抽取）；`message-bus.ts`（topic 一行）；`packages/shared/src/protocol.ts`（帧类型）；`packages/shared/src/constants.ts`（无需改——XYZ_ 已在白名单，若 AMBIENT 类比需要则只加注释） | E-0 | E-崩溃矩阵（runtime 侧）+ E-主流 | **可并行**（infra/pi 不改语义；process-manager 仅 env 追加） |
| E-3 extension 接入 + conformance relay 变体 | §5.2 三处改动 + probe 排除 + conformance relay 用例（§2.3）+ session-runner 零改动三道门 | `pi-invocation.ts`（分支）；`session-runner.ts`（buildChildEnv 2 行）；`engine/__tests__/conformance/contract.relay.test.ts` + `engine-conformance.live.test.ts`（describe 追加） | E-1 + E-2 | E-工具/E-崩溃矩阵（extension 侧）/E-conformance-relay | **须在 E-1/E-2 合入后串行**（同仓叠加，无跨分支冲突面） |
| E-4 前端接入与 widget 退役 | §6 全部：entry 帧消费 + applySubagentEntries 回调 + 分区惰性创建 + 订阅简化 + 退役步骤 1（步骤 2 随 E-3、步骤 3 延后一版）；live ≡ reload relay 等价测试 | `stores/subagent.ts`、`stores/chat.ts`（帧处理面）、`SubagentTab.vue`；`packages/runtime/src/__tests__/equivalence/`（relay 用例）；`api/events.ts`（帧订阅） | E-2（帧形态）；不依赖 E-3 | E-重开（live ≡ reload）/E-工具（前端断言） | 与 E-3 **并行**（前端只消费 E-2 的帧） |

**并行 wave 编排**：wave 1 = {E-0}；wave 2 = {E-1, E-2, （E-4 的 store 骨架可提前）}；wave 3 = {E-3, E-4 收尾}。E-3/E-4 各自独立可验收，合入顺序无强制。

## 9. 验收场景表（真实环境：pnpm dev + 真实 LLM，非 mock）

执行环境：`pnpm dev` 真实 xyz-agent + 真实模型驱动的 subagent 任务；E-3/E-4 合入后 relay 全链激活。每条回溯 §1.4 目标。

| # | 场景 | 可操作步骤 | 通过标准（断言） | 回溯目标 |
|---|------|-----------|----------------|---------|
| E-工具 | 工具执行期可见（R2 证据） | 派「读 5 个文件并总结」任务给 subagent，任务执行期间打开 drawer 盯工具块 | 每个读文件工具块在开始（pending 态）/结束（结果态）实时出现；事件源是 tee entry 帧（DevTools WS 帧断言 `session.subagentEntriesAppended` 含 tool 类型 entry），非 widget 通道 | 目标 1 |
| E-主流 | 主对话流零争抢且卸载 | 主 agent streaming 长回复期间并行派高频工具活动的 subagent；抓 runtime 日志 | 主对话流打字机无可感知卡顿；主 pi stdout 日志（pi tee 落盘 jsonl）中无 `subagent-stream-` widget 私货行（退役步骤 2 生效断言） | 目标 3 |
| E-重开 | live ≡ reload（relay × P5 一致性） | ①运行中关闭 drawer 重开；②切走 tab 切回；③任务结束后重启 app 重开 session 打开同一 subagent | 三路径 drawer 内容一致（含全部工具块完整历史）；等价测试（`packages/runtime/src/__tests__/equivalence/` relay 用例）断言：live entry 帧序列 replayEntries 与 getSubagentHistory（pi JSONL 直读链）产出 state deep equal——E 的 live 腿与 P5 直读 reload 腿共用 reducer 的一致性证明 | 目标 2 |
| E-续聊 | chatMode 多轮全程实时（R1 证据） | 主 agent 与同一会话型 subagent 往返 3 轮（conversation 模式），drawer 全程打开 | 每轮文本逐字流出、工具块实时出现；第 2/3 轮无冻结（relay 下 stream 生命周期问题构造性不存在——tee 帧不经 SubagentStream） | 目标 1 |
| E-崩溃矩阵 | §3.3 三场景进程链 | ①kill 主 pi 进程；②kill runtime 进程；③kill 代理进程（按握手帧/pid 文件定位）——各场景跑一次 subagent 任务中途击杀 | 每场景后 `ps` 扫描断言：无存活的代理进程 + 无存活的 pi 子进程（pid 记录对照）；record 状态最终非 running（正常收尾/合成终态）；场景②后重启 app，残留 pid 文件被清理且无「复用 pid 误杀」日志 | 目标 1/4 |
| E-TUI | relay 不激活零回归 | 纯 pi CLI（无 xyz-agent）跑同等 subagent 任务；日志级断言 | spawn 目标为真实 pi 二进制（pi-invocation 决策日志/strace 断言），无 socket 连接尝试、无 relay env 消费；行为与合入前逐字节一致（快照对比） | 目标 4 |
| E-conformance-relay | 契约经 relay 转绿 | `ENGINE_CONFORMANCE_LIVE=1` 跑 conformance run 层（relay env 注入环境）；CI 跑 golden 回放层 + 伪 relay 环回 | C2（outcome 无 error、engineId='pi'）/C3（事件不变量五条经代理转发全等）/C4（cancel 无僵尸双 pid 扫描）全绿；env 部分缺失回归用例（回落直连）通过 | 目标 5 |
| E-降级 | tee 失败连坐防护 | 注入损坏的 tee 翻译（测试桩改动一个事件类型断言失败），任务照常跑 | 编排通路完好（record 正常收尾、result 正确）；drawer 停在最后一致点不崩溃；runtime 日志含隔离 warn（单事件丢弃），无进程死亡 | 目标 1/2 |

## 10. 风险与未决

1. **代理执行器可用性（形态 B 的核心待验证项，E-2 前置探针）**：打包版 runtime 的 `process.execPath` 形态待实测——runtime 是 Electron fork 的子进程时 execPath 可能为 Electron 二进制（需配 `ELECTRON_RUN_AS_NODE=1`）或独立 node；`XYZ_SUBAGENT_RELAY_NODE` 注入值必须实测「能以纯 node 语义执行 relay.mjs」（探针：spawn 执行器跑 `--eval "process.exit(0)"`）。**被证伪则切形态 A（SEA）**——协议/注册表/前端全部设计不受影响，仅分发机制换轨（§3.2）。
2. **socket 平台差异**：win32 named pipe 的权限语义（默认同 session 可连，跨会话需 ACL）——首期支持 darwin（unix socket 成熟），linux/windows 进矩阵但标注「实测后放开」；握手帧校验（§4.1）是平台无关的第二道门。`<getDataDir()>/run/` 目录的创建权限（首次运行 mkdir）纳入 E-2。
3. **tee 双份 event-adapter 的内存/性能**：每个 running subagent 一份 adapter + entry 管线实例（与主对话流每会话一份同构，单实例静态内存 KB 级）；风险点是**大 payload tool result 的双份缓冲**（转发分支 + tee 翻译各持一份）——缓解：tee 侧翻译消费即释放（不整轮缓存）、tool result 字节超过阈值（如 256KB）时 tee 只投递截断摘要 + 完整内容留给 reload 腿（P5 直读有全量）。实测项进 E-2 验收（长任务内存曲线对比直连基线）。
4. **与 chatMode conversation 模式（idle 保活）的交互（源文档未覆盖，本设计补）**：idle 子进程经代理存活（轮终不退、socket 保持）——①idle 期间无字节流动，unix socket 本地长连接无 keepalive 需求，但 runtime 侧**不得**因空闲回收该子进程（注册表无 idle 超时，生命周期完全跟随 socket 连接，与 extension 侧 idle timer 单一权威不冲突）；②续聊 deliverMessage 的 stdin 写入经 relay 双跳，延迟增量 = 本地 socket 往返（亚毫秒级，无感）；③runtime 崩溃场景下 idle 进程死亡 → 死 handle 续聊被 `engine_session_not_resumable` 拒绝（引擎抽象 A13 语义已覆盖，冷 resume 指引照常给出）；④**close 语义**：extension kill 代理（既有 dispose 兜底）→ socket 断 → runtime 杀真实 pi——close 链与崩溃矩阵 ③ 同构，无需新机制。
5. **代理协议常量双份的一致性**（relay-env.ts ↔ relay.mjs 内嵌）：无编译期约束，靠 conformance relay 用例断言锁定（握手帧字段名/版本号不齐即转红）——E-3 验收必含。
6. **多 app 实例并存的 socket 冲突**：per-pid 路径已隔离；残余风险 = 同机 stale socket 文件名碰撞（pid 复用）——启动探活机制（§4.1）覆盖，探活连得上时报错退出而非覆盖（防误杀他人注册表）。
7. **未决（不在本期）**：zcode relay 托管增强（§2.5）；relay 通道的加密/认证升级（若未来 socket 暴露到非本机场景——目前本地 only，无此面）；D 退路是否永久废弃（E 全量验收通过后，附录 A 降级为纯历史记录）。

## 附录 A：历史方案 A / D（退路保留，非实施计划）

初稿的三方案对比结论保留备查（细化自源文档 §3.1/§3.3，锚点未重核——本附录不作为实施依据）：

- **方案 A（widget 通道修补）**：续聊轮重建 SubagentStream + dispose 延迟 + 前端重订阅。仅修 R1；R2/R3 留存；widget 私货语义继续加深。E 落地路径上无残留依赖——已被 §1.5 决策跳过，若 E 整体被否（relay 不可行且形态 A 退路也失败）才重启。
- **方案 D（appendEntry 信令 + 文件补拉）**：离散事件（tool_start/end、turn_end、message_end）→ `appendEntry('subagent-activity', {subagentId, seq})` → runtime 防抖直读子进程 JSONL 增量 → `session.subagentEntriesAppended` 帧 → 前端虚拟分区同一 applyEntry。三根因全覆盖，与 W18/A33「失效信号 + 权威拉取」同构；E 受阻于「代理分发或 runtime 基建不可行」时启用。**D 与 E 的前端接入层完全共用**（§6 即 D-D4 的 E 化实现），D 启用时仅换数据源（extension 信令 + runtime 补拉替代 tee），前端零改动——这是 D 保留价值不沉没的结构保证。已知竞态（信令先于落盘 → 游标对账 + 追赶重试）与节流设计（200ms 防抖、≤2KB/轮 JSONL 增量）见源文档 §3.3 D-D2/D-D3。
- **概念归位清单**（源文档附录）：`setWidget` 回归 pi 传输原语语义；`subagent-stream-` 前缀在退役步骤 3 后从 GUI 链路消失；subagent 实时通路命名 **subagent activity feed**（tee entry 帧 + stream_delta 中间态 + P5 reload 合称）。

## 附录 B：证据锚点核对表（初稿 → 现状）

| 初稿锚点 | 现状核对结果 | 结论 |
|---|---|---|
| `subagent-service.ts:1504`（R1 finally dispose） | `subagent-service.ts:1508` | 漂移 +4 行（引擎抽象 P1 改动所致），dispose 语义原样，R1 成立 |
| `stream-sink.ts:63`（disposed 静默丢弃） | `stream-sink.ts:63` | 精确一致 |
| `session-runner.ts:787`（text_delta 独分流） | `session-runner.ts:787` | 精确一致 |
| `SubagentTab.vue` watch selectedSubagentId | `SubagentTab.vue:183,214`（U8 scope token 化后的 subscribeStream/stopStream） | 行号演进、语义一致（订阅仍仅随 tab 切换驱动，R3 的「openSubagent 不刷新」现状保持） |
| `stores/subagent.ts` / `message-bus.ts` topic | `stores/subagent.ts:152` / `message-bus.ts:102` | 一致 |
| 「extension 零改动 / session-runner 零改动」（初稿 §3.1） | 引擎抽象落地后精确化：session-runner 有 buildChildEnv 2 行 env 追加（§5.2），spawn 执行段零改动（§5.3 三道门） | 初稿表述在引擎抽象结构下修正为「spawn 执行段与编排层零改动」 |
| pi 通道盘点（setWidget 透传 / appendEntry 不进 LLM 上下文 / RPC stdin 命令集封闭） | event-adapter.ts:419-421 前缀短路、W18/W25 既有契约测试、rpc-mode 命令集 | 一致（初稿 §2.1 结论在本仓仍成立） |
