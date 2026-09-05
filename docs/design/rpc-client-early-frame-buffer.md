# rpc-client 早期帧缓冲（pi spawn→attach 空窗丢帧根治）

> **层声明**：本文档 = 机制层设计；下一层产物 = 可实施的接口/数据模型变更（PiRpcClient 帧分发模型 + session 创建时序），拆分见 §5。tech-design 红线 5/6/7（运行时断言/数据流/错误规格）全适用。
>
> **来源**：bridge-rewrite-pi-0.84.impl-plan §7 残留③（「session_start 观察帧 attach 空窗丢失——根治 = rpc-client 早期帧缓冲，后续架构改进项」）；bridge 设计 §3.3-D5 的 R1 自愈登记（sync 通道级 2s timeout 的存在本身就是本设计的动机证据）。

## 1. 背景目标

**一句话结论**：把 PiRpcClient 的帧消费模型从「无消费者 = 丢弃」改为「无消费者 = 缓冲、首个消费者到达即重放」——根治 pi spawn 到 runtime adapter attach 之间所有主动帧的无条件丢失；session_start 观察链路恢复完整，bridge 启动 sync 从「每 session 恒丢首帧 + 2s 退避自愈」变为「首帧命中缓冲、毫秒级完成」。

**SCQA**：

- **S（情境）**：runtime 为每个会话 spawn 一个 pi 子进程，经 stdin/stdout JSONL 通信。pi 启动序列里会**主动**向 stdout 输出帧：扩展加载后立即发出 extension_ui_request（如 plugin-bridge 的启动 sync 请求、事件转发）和事件帧（session_start 等经 toJsonEvent）。runtime 侧的帧消费者（EventAdapter）在 `initializeManagedSession` 时才注册到 PiRpcClient。
- **C（冲突）**：spawn 到 attach 之间存在必然空窗（中间隔着 `await getState()` RPC 往返，百 ms 量级），期间到达的帧在 PiRpcClient.handleMessage 里因 listeners 为空被**无条件丢弃**（rpc-client.ts listener 分发循环空转）。
- **Q（问题）**：早期帧丢失的根治方案是什么？
- **A（答案）**：PiRpcClient 增加早期帧缓冲——listener 空集期间到达的非 response 帧进缓冲队列，首个 listener 注册时按序重放，之后直通（§3）。

**系统是什么**（受众假设：会用 xyz-agent 但不懂 runtime 内部的开发者）：runtime（Node WebSocket 服务）管理 pi 子进程的生命周期。每个 session 创建流程：`session-lifecycle.create` → `pm.createSession`（spawn pi + 建 PiRpcClient）→ `await client.getState()`（拿真实 session id）→ `initializeManagedSession`（建 EventAdapter 并 `adapter.attach(client)` 注册帧监听）。pi 侧对应序列：进程启动 → 加载 extensions（含 mandatory 的 plugin-bridge）→ emit session_start（扩展 handler 触发 bridge:sync / bridge:event 请求帧）→ 处理 runtime 命令。**两侧序列并行推进，pi 的早期输出先于 runtime 的消费者就绪。**

**设计目标**（从插件作者与用户视角倒推）：

- **G1 session_start 观察完整**：插件注册 `onPiEvent` 后，在 session 创建流程中能收到 session_start 事件（与后续事件无差别），不因 attach 时序丢失。
- **G2 启动提速**：bridge 启动 sync 首帧命中缓冲（不再依赖 2s timeout 退避自愈），spawn → 工具注册完成的时间从 ~4.5s（恒丢首帧 + 2s timeout + 2s 退避 + 重试往返，bridge 设计 v4.1 Gate B 实测值；r2 复审 S1 修正 v1 的 ~2.2s 算术错误——2s timeout 之外还有同值 2s 退避）降到接近 spawn→getState 的固有耗时。
- **G3 零重复零乱序**：缓冲重放不产生重复帧（同一帧只到达消费者一次）、帧序与 pi 输出序一致。
- **G4 有界**：缓冲有上限与生命周期（不随 listener 永不到达而无限增长）；异常路径（spawn 失败/初始化异常）缓冲随 client 销毁释放。

**In-scope**：PiRpcClient 帧分发模型（handleMessage / onEvent）；`session_start` 观察链路的恢复验证；bridge sync 自愈路径的保留性验证（缓冲命中后 timeout 仍在但不再触发）；缓冲的生命周期与上限。

**Out-of-scope**：pi 侧行为（不修改 pi）；`getState` 往返本身的耗时优化（固有 RPC 成本）；双通路 onPiEvent 重复触发问题（§2.4 登记，独立处理）；SessionScanner / 前端会话列表。

## 2. 现状与问题分析

### 2.1 现状：一次 session 创建的帧丢失旅程

物理时序（时间从左到右，两行分别是一个 session 创建时 runtime 侧与 pi 侧的并行进度；全部锚点已行级核实 ✅）：

```
runtime 侧            ──spawn──▶          ──get_state──▶          ──attach──▶
(pm.createSession)    PiRpcClient 建立      await RPC 往返           EventAdapter 注册
listeners = ∅         listeners = ∅        listeners = ∅           listeners = {adapter}
                       │                    │                       │
pi 侧     进程启动 → 加载 extensions（含 plugin-bridge）→ emit session_start
           │                                              │
           ├─ toJsonEvent(session_start) ── 事件帧 ──▶ rpc-client 丢弃（listeners 空）
           ├─ extension_ui_request(bridge:sync) ─帧──▶ rpc-client 丢弃 ─▶ pi 侧 dialog 挂起
           └─ extension_ui_request(bridge:event[session_start]) ─▶ 同上丢弃
```

三个丢帧点（rpc-client.ts:440-444，非 response 帧进 `for (const listener of this.listeners)` 空集循环，直接落空 ✅核实；r1 审查 SG-7 行号精化）：

1. **pi 原生事件帧**（rpc-mode.js:266 `output(toJsonEvent(event))` ✅核实）——session_start 事件本身；
2. **bridge:event 转发帧**——plugin-bridge 的 session_start observe 转发（fire-and-forget）；
3. **bridge:sync 首帧**——plugin-bridge 的启动同步请求。

### 2.2 三个受害者的现状命运

**受害者 1：session_start 观察事件（双路全灭）**。plugin-service 的 `onPiEvent` hook 有两条触发通路：路径 A = pi 原生事件帧 → EventAdapter（hook kind 中间事件）→ event-interpreter `executeHooks('onPiEvent')`（event-interpreter.ts:364-366 ✅核实）；路径 B = bridge:event 转发帧 → bridge-handler → `handleBridgeEvent` → observe 快捷路径（bridge-interop.ts:212-230 ✅核实）。**两条通路都以被丢弃的帧为输入**——插件注册的 `onPiEvent` 永远收不到 session_start（每个 session 如此），后续事件（agent_start 等，发生在 attach 之后）正常。这就是 impl-plan 残留③登记的现象。

**受害者 2：bridge 启动 sync（靠 2s timeout 自愈的补丁）**。bridge 首帧被丢弃后，pi 侧 dialog 挂起；plugin-bridge 的 R1 修复（sync 请求带通道级 2s timeout）让挂起折叠为失败、退避重试，重试帧到达时 attach 已完成——自愈成立。**代价：每个 session 的工具注册恒定延迟 ~2.2s**（首帧丢弃 + 2s 等待 + 重试往返），且 R1 修复的本质是「用下游超时补偿上游丢帧」——补丁而非根治（bridge 设计 D5 自述该 timeout 是「attach 空窗丢帧」的自愈闸）。

**受害者 3（潜在）：任何未来扩展的早期帧**。extension 在加载/factory 阶段发起的早期 select（如未来的初始化握手）同样命中空窗——每个新扩展都要自带超时重试才能工作，架构级税。

### 2.3 根因：帧消费模型的不对称

pi 的 extension_ui_request 在 pi 侧有 pending 表**等待回包**（rpc-mode pendingExtensionRequests），事件帧的消费者假设是「订阅者始终在线」。而 PiRpcClient 的分发模型是「listener 空集 = 丢弃」——**上游等待（或事实丢失）+ 下游丢弃**的不对称。空窗本身在本方案下不消除（getState 先拿真实 session id 再 attach——真实 id 先行的成本低于另一条路 tempId 先 attach + rekey 重绑：后者需 EventAdapter 构造期固定的 sessionId 改可变 + 早期帧带 tempId 的 WS 路由连锁改动，r1 审查 SG-2 补记为被否 alternative），**本方案消除的是丢弃**：空窗期间帧被保留到消费者就绪。

### 2.4 顺带登记：双通路 onPiEvent 的重复触发面（范围外）

同一 session_start 事件理论上可经路径 A（pi 原生帧）与路径 B（bridge:event 转发）**双发**到 `onPiEvent`，且两路 context.data 形状不同（A：`{event, ...data}`；B：`{eventName, data, sessionId}`）✅核实两处实装。本设计恢复双路的早期帧后，session_start 可能出现重复通知（现状因双路早期帧全丢而「隐性不可见」）。这是 bridge 重写落地后的既有交叠面，**不是本设计引入**——登记为独立跟进项（统一形状或去重，涉及 plugin-service 契约，超出本文 scope），本设计的验收（§4）以「至少一次到达」为准。

## 3. 解决方案

### 3.1 终态（插件作者与用户视角）

**插件作者视角**：注册 `onPiEvent` 后，新创建 session 的生命周期事件从 session_start 起完整可观察（与 agent_start/turn_end 无差别），无需关心 runtime attach 时序。

**用户视角**：创建 session 后插件工具立即可用的时间缩短（bridge sync 首帧命中缓冲，毫秒级应答；现状每 session 恒等 ~2.2s 退避）。

**失败路径**：若 pi 进程在 attach 前崩溃（spawn 失败/getState 超时），走既有 safeDestroy → kill 链，进程死后无新帧、缓冲随对象 GC 释放（kill 无需显式清缓冲），无泄漏；listener 永不到达的异常形态由缓冲上限兜底（§3.3-D3）。

### 3.2 多方案对比

| | 方案 A：PiRpcClient 早期帧缓冲 | 方案 B：runtime 合成 session_start | 方案 C：维持现状（登记接受） |
|---|---|---|---|
| 形态 | listener 空集期间非 response 帧进 FIFO 缓冲，首个 listener 注册时按序重放后转直通 | attach 完成点由 runtime 向 plugin-service 补发一次合成 session_start 通知 | 不改代码，bridge:sync 保留 2s timeout 自愈，session_start 丢失登记接受 |
| **长期架构合理性** | 高：修的是根因（消费模型不对称）——所有早期帧（现在与未来扩展）一次性治；帧序保真（pi 输出序重放）；pi 侧行为事实完整到达消费者 | 低：治一个症状——合成事件不是 pi 事实（时序/载荷由 runtime 编造），bridge:event 早期帧仍丢（受害者 2/3 不治）；未来扩展早期帧仍需自带重试 | 低：三受害者维持现状；R1 补丁永久化；每个新扩展交架构税 |
| **短期实现成本** | 中低：PiRpcClient 单文件改动（handleMessage 缓冲分支 + onEvent 重放），session 创建链路零改动；测试矩阵（缓冲/重放/上限/销毁） | 低：一个补发调用——但语义争议大（合成 vs 事实），审查成本高 | 零 |
| **风险** | 重放时机（listener 注册回调内同步重放——新帧与重放交错的顺序性需构造保证）；缓冲上限边界的帧丢弃策略需定案（丢弃谁：最旧 or 新到） | 双发面扩大（合成 + 若未来帧恢复则三发）；插件依赖合成事件后，未来真修复时行为再变一次 | 已知功能缺口永久化；G1 不达成 |
| **被否反例**（若用它，§2.2 会怎样） | — | 受害者 2（sync 延迟 2.2s）依旧、受害者 3 依旧；且合成 session_start 的 data 载荷只能编造（pi 侧真实 payload 在被丢弃的帧里，runtime 拿不到）——合成本身建立在丢失之上 | 三受害者照旧 |

**推荐 A（长期方案）**。B 只治受害者 1 且以编造事实为代价；C 是不作为。A 的实现面集中在单文件（PiRpcClient），风险点（重放顺序性/上限策略）在 §3.3 逐项定案。

### 3.3 关键决策与权衡

**D1 缓冲与重放机制：首个 listener 注册时同步按序重放**

- 选择：PiRpcClient 增加 `earlyFrameBuffer: PiMessage[]`（FIFO）。handleMessage 的 listener 分发分支改为：listeners 非空 → 直通（现状不变）；listeners 空且缓冲未关闭 → push。`onEvent` 首次注册 listener 时：**注册回调返回前**先按序重放缓冲帧给该 listener（同步循环调用），清空缓冲，标记缓冲关闭（后续帧恒直通）。
- **顺序性论证**：Node 单线程事件循环保证 handleMessage 与 onEvent 不会并发交错；重放发生在首个 listener 生效的同一同步块内，重放期间不可能有新帧插入（stdout 'data' 事件排队在后）。因此「重放帧（旧）→ 直通帧（新）」的全序与 pi 输出序一致。
- **后续 listener 语义（r1 审查 SG-1 补）**：= 现状 Set 语义（不重放、只收直通帧）——已核实真实调用形态恒定：event-adapter attach 恒为首 listener，handoff-service（srcClient 经 ensureActive）到达时 adapter 已 attach、恒为后续 listener，无行为回归。
- 被否：异步重放（`setImmediate`/微任务）——引入重放与新帧交错窗口，顺序性论证复杂化，无收益。
- 效果：G3（零重复零乱序）构造性成立。

**D2 重放范围：仅非 response 帧（与直通分支同集）**

- 选择：缓冲与直通覆盖同一帧集——handleMessage 里的非 response 分支帧（事件帧 / extension_ui_request / 非 pending 的带 id 帧）。response 帧（pending 命中）与 timedOutIds 帧不进缓冲（它们有独立语义：请求-响应配对与迟到丢弃，与 listener 无关）。
- 被否：缓冲全部帧——response 帧的消费者是 pending 表（注册于 sendCommand 时，早于任何帧到达），不存在空窗，缓冲无意义且徒增内存。
- 效果：改动面最小（只动既有 listener 分支），response 语义零触碰。

**D3 缓冲生命周期与上限**

- 选择：**上限 = 256 帧**（超限丢最旧，warn 日志一次含丢弃计数——帧是 KB 级 JSONL，256 帧约数百 KB，覆盖任何合理启动序列；实际启动序列 <10 帧——**估计值（r1 审查 SG-5 标注），实施期 B2 观测顺带核实**）。**关闭时机**：①首个 listener 注册（正常路径，D1）；②client 随进程 kill 后无新帧（kill 无需显式清缓冲——RpcClient 无 destroy 方法，释放靠对象 GC；r1 审查 SG-4 表述修正）。**缓冲是一次性的（r1 审查 SG-3 补）**：关闭后 listeners 再次空集（detachSession 真实存在——首 listener 注册后 adapter.detach）→ 恢复现状直通丢弃语义，无回归。**永不到达 listener 的兜底**：上限机制兜住内存（满 256 后恒丢最旧，不再增长），此时 pi 侧 dialog 帧照旧挂起（与现状同——不劣化）。
- 量级校准（规则 19）：256 帧上限是防泄漏的回收层有界兜底（允许默认有界），非任务级超时；正常路径（百 ms 空窗 <10 帧）永不触及。
- 被否：无上限缓冲（spawn 后 listener 永不到达 = 无界增长）；超限丢最新（丢最旧保序语义更直觉：重放的是最近 256 帧的连续窗口）。

**D4 bridge sync 的 2s timeout 保留（防御降级，不拆除）**

- 选择：plugin-bridge 的 sync 通道级 2s timeout（R1 修复）**保留不动**。缓冲修复后正常路径首帧命中（timeout 不触发），但 timeout 仍是防御层（未来 attach 前异常/新丢帧面）。plugin-bridge 代码零改动。
- 效果：G2 达成（正常路径无退避延迟）；R1 的自愈能力作为纵深防御保留——「正常路径快 + 异常路径有兜底」双层结构，与超时默认原则的正/兜底分层一致。

**D5 错误规格**

| 错误场景 | 行为 | 恢复指引 |
|---|---|---|
| 缓冲超限（>256 帧，listener 未到） | 丢最旧 + warn 一次（含累计丢弃数） | 查 runtime 日志——listener 迟到/未注册属异常，检查 session 初始化链 |
| spawn 失败 / getState 超时（既有 catch） | 既有 safeDestroy → kill 链；kill 后无新帧，缓冲随 GC 释放（无显式清理，r1 审查 SG-4） | 既有恢复链（session 创建失败 toast + 可重试） |
| 重放期间 listener throw | 单帧隔离（try-catch per 帧，对齐 EventAdapter.attach 的整批隔离先例），后续帧照常重放 | 查 event-adapter interpret 失败日志（既有 logInterpretFailure 链路） |
| attach 后 pi 崩溃（既有） | 不受本设计影响（缓冲已关闭，直通路径现状语义） | 既有 pi 进程监控恢复链 |

**D6 探针与运行时断言**

| 断言 | 探针 | 状态 |
|---|---|---|
| listeners 空集时非 response 帧被丢弃（现状根因） | rpc-client.ts:440-444 直读（r2 复审 S4） | ✅ 已核（§2.1） |
| pi 启动序列主动输出 session_start 事件帧 + bridge 早期帧 | rpc-mode.js:266 + R1 Gate B 实证（每 session 恒 2 sync 帧 = 首帧丢弃证据） | ✅ 已核 |
| 重放全序 = pi 输出序 | D1 顺序性论证（单线程事件循环 + 同步重放） | ✅ 论证（实施期单测构造交错验证） |
| 缓冲命中后 spawn→sync 完成时延 | 实施期探针：session 创建后 runtime 日志 sync 应答时间戳对比（现状 ~2.2s → 预期 <100ms） | ⛔ 实施期门 |
| 插件 onPiEvent 收到 session_start | 实施期 W 场景（§4） | ⛔ 实施期门 |

### 3.4 终态数据流（实现后）

```
runtime 侧           ──spawn──▶           ──get_state──▶           ──attach──▶
(pm.createSession)   PiRpcClient 建立       await RPC 往返            onEvent(listener)：
                     buffer=[]             buffer=[s_start 事件帧,    ① 同步按序重放 3 帧
                                            bridge:sync 帧,            给 listener
                                            bridge:event 帧]          ② buffer 关闭
                       │                    │                        │
pi 侧     进程启动 → 加载 extensions → emit session_start            │
           ├─ toJsonEvent(session_start) ─▶ 入缓冲                   ├─▶ 重放：session_start
           ├─ ext_ui_req(bridge:sync) ────▶ 入缓冲  ←─ 2s timeout 不再触发（毫秒级应答）
           └─ ext_ui_req(bridge:event) ───▶ 入缓冲                   ├─▶ 重放：sync 请求→立即应答
                                                                        └─▶ 重放：event 转发
                                             之后新帧 ──直通──▶ listener（现状分支不变）
```

## 4. 验收

| 场景 | 回溯目标 | 真实流程 | 通过标准 |
|------|---------|---------|---------|
| **B1 session_start 观察恢复** | G1 | standalone runtime + 测试插件注册 `onPiEvent`（记录收到的 event 名到插件日志/sessionData）；创建新 session；**另跑 restore 路径（重开已关闭 session，r1 审查 SG-6 补——restore/fork 同走 spawn → RPC → initializeManagedSession 且空窗更长，机制层天然覆盖但需验收兜底）** | 新建与 restore 两形态插件均收到 `session_start`（至少一次，§2.4 双通路登记）；与随后收到的首个后续事件（如 agent_start）顺序正确 |
| **B2 启动提速（sync 首帧命中）** | G2 | standalone runtime 创建新 session；runtime 日志观测 bridge:sync 帧到达与应答时间戳 | **主判据：每 session 恒 1 个 sync 帧**（现状恒 2——首帧丢弃+退避重试；它同时证明首帧未丢与 timeout 防御未触发）。**辅判据（r1 审查 MF 修正量纲——起点从「spawn→」改为帧级对照）**：①首帧到达 runtime → 应答完成 <100ms（重放路径毫秒级论证的可观测面）；②同机对照：spawn → 工具注册完成相对现状缩短 ≥4s（现状 ~4.5s 构成 = 2s timeout + 2s 退避 + 重试往返，消除 timeout 等待与退避即得；r2 复审 S1 修正 v2 照抄的算术错误） |
| **B3 帧序保真** | G3 | 测试插件 onPiEvent 记录事件序；一轮对话（含工具调用） | 事件序列与 pi 输出序一致（session_start → agent_start → … → agent_end），无重复帧（同一 eventType+时间戳不双发；§2.4 双通路形状差异不在本场景断言面） |
| **B4 异常路径无泄漏** | G4 | 构造 spawn 失败（如 pi binary 路径无效）与正常 destroy session；create/destroy 循环 20 次 | 进程退出；无超限 warn 日志；循环后缓冲数组为空（内部观测——r1 审查 INFO-2 修正：rss 受 GC 时机影响不作判据） |
| **B5 既有行为零回归** | G4/G2 | 重跑 bridge 设计 §4 的 V2/V5 场景（工具超时 / miss 重同步）与 timeout 文档 V1b（sleep-tool 90s 不误杀） | 与 Gate B 验收时行为一致 |

> 环境基准同 bridge 设计 §4（standalone runtime :3311 + 隔离数据目录）。B2 的「恒 1 个 sync 帧」是最强判别断言——它同时证明首帧未丢（不需退避）与 timeout 防御未被触发。单测层（实施期）：缓冲命中/重放序/上限丢最旧/销毁释放/重放 throw 隔离——不替代上表真实场景。

## 5. 下一层拆分

| 单元 | 内容 | justification | 领地 |
|------|------|--------------|------|
| R1 帧 | 缓冲分支（handleMessage listener 分支前加缓冲判定）+ onEvent 首注册重放（同步循环 + per-帧隔离）+ 上限与关闭标记；单测（命中/序/上限/throw 隔离/**缓冲一次性：关闭后 listeners 再空集（detach 形态）不重放陈旧帧——r2 复审 S3 补，防「关闭」被错做成「空集重新武装」**） | 全部行为集中单文件单分发点；session 创建链路（lifecycle/session-service）零改动是本方案的成本优势 | packages/runtime/src/infra/pi/rpc-client.ts + packages/runtime/test/ 下新增测试 |
| R2 验收探针与文档回写 | §4 B1-B5 真实场景执行；impl-plan 残留③收口回写；bridge 设计 D5 的 R1 自愈注记补「缓冲修复后 timeout 转防御层」 | 验收与登记闭环（C-proc-10：登记即债务修复即清账） | docs/ 回写 + /tmp 探针脚本 |

实施顺序：R1 → R2。plugin-bridge / event-adapter / session 链路**零代码改动**（本设计的改动面就是它的架构优势）。

**待验证检查点（实施期门）**：

1. B2 辅判据 ②的「缩短 ≥4s」在同机对照下测量（spawn→注册完成含 getState 往返与冷启动 jiti 编译等 pi 侧固有耗时——对照跑法消除该噪声）；主判据「恒 1 sync 帧」不受任何时延噪声影响。**辅判据 ① 的观测点今天不存在（r2 复审 S2）——探针形态 = bridge:sync case 临时加 debug 日志（runtime logger 行自带 ISO 时间戳），与帧到达侧 piSessionLog 数帧配合**。
2. 重放期间 per-帧 throw 隔离对 EventAdapter 的实际效果（adapter.attach 已有整批隔离，per-帧隔离是否冗余——实施期按先例对齐，冗余则简化为整批；顺带确认 r1 INFO-1：直通路径 listener 调用现状无 try-catch，重放隔离强于直通属已知不对称，非本设计引入）。

---

## 变更历史

- v1（2026-09-05）：初版。Step 0 事实重钉（三丢帧点 + 三受害者命运 + 消费模型不对称根因 + 双通路登记）；方案对比 A/B/C（推荐 A：PiRpcClient 早期帧缓冲）；决策 D1-D6（同步重放顺序性论证 / 缓冲上限 256 / R1 timeout 降级为防御层保留）；验收 B1-B5（B2「恒 1 sync 帧」最强判别）。
- v2（2026-09-05）：**第 1 轮对抗式审查修复**（1 MF/7 SG/2 INFO 全修，报告 .review/rpc-client-early-frame-buffer-design-review-r1.md；方案本体经对抗检验成立——D1 顺序性论证独立验证通过（readline 同步行 emit + onEvent 普通调用 + 单线程事件循环）、多 listener 无行为回归、pi 侧 select timeout 原生支持核实）。①MF（B2 时延判据量纲错误）：「spawn→sync 应答 <100ms」把重放路径耗时误当 spawn 起点全程——判据改主辅分明：主 = 恒 1 sync 帧（无时延噪声），辅 = 帧级对照（首帧到达→应答 <100ms）+ 同机对照（spawn→注册完成缩短 ≥2s）；检查点 1 同步；②SG-1：D1 补第二 listener 语义（= 现状 Set 不重放；调用形态 event-adapter 恒首/handoff 恒后续已核实）；③SG-2：§2.3 补被否 alternative「tempId 先 attach + rekey 重绑」（需 adapter sessionId 可变化 + tempId WS 路由连锁）；④SG-3：D3 补缓冲一次性声明（关闭后 listeners 再空集恢复现状直通丢弃，detachSession 形态无回归）；⑤SG-4：销毁表述修正（RpcClient 无 destroy，kill 后 GC 释放，无需显式清理；「铜毁」错别字）；⑥SG-5：<10 帧标注估计值 + B2 观测核实；⑦SG-6：B1 补 restore 路径验收；⑧SG-7：listener 循环行号 :437-443→:440-444；INFO 采纳：B4 rss 判据改「无超限 warn + buffer 空观测」、检查点 2 顺带确认直通路径无 try-catch 的既有不对称。
- v3（2026-09-05）：**第 2 轮聚焦复审 0 must-fix / 4 SG / 1 INFO，当轮全修收口**（报告 .review/rpc-client-early-frame-buffer-design-review-r1.md 同目录 r2；两轮收敛 1→0 MF，r1 全部 10 项修复验证成立——B2 主判据观测通道真实（piSessionLog 默认启用）、「恒 1」良定义（runSyncLoop 成功即 return））。①S1（最强，边缘 P0-11）：「现状 ~2.2s」算术错误——SYNC_RETRY_MS=2000 同时用于 timeout 与退避，现状 = 2s+2s+往返 ≈ 4.5s（bridge 设计 v4.1 Gate B 实测）——全文四处 ~2.2s/≥2s 修正为 ~4.5s/≥4s（实际改善更大，门槛更稳）；②S2：B2 辅判据①观测点今天不存在——探针形态写明（bridge:sync case 临时 debug 日志，logger ISO 时间戳）；③S3：R1 单测清单补「缓冲一次性」场景（关闭后 listeners 再空集不重放陈旧帧，防错实现「空集重新武装」）；④S4：D6 探针表行号 :437-443→:440-444 漏网处；⑤INFO：变更历史 v2 重复序号 ⑦→⑧。**设计就绪。**
- v4（2026-09-05）：**Gate B 真实场景验收回写（u-r2，§4 B1-B5 全部 pass）**。环境 = standalone runtime + 真实 pi（mimo-v2.5-pro）+ onPiEvent 观察插件，证据 `/tmp/r2-accept/`（探针脚本 / 结果 JSON / runtime 与 piSessionLog / plugin-bridge 日志）。**B1**：session_start 在 create 与 restore 双形态均到达插件（attach 重放点 = spawn+801ms / +562ms），且先于首个后续事件（agent_start）。**B2**：主判据——create 型 23/23 session 恒 1 sync 帧（同机同配置 A/B 基线恒 2，基线 = `git archive 842a3fc5d^` 影子仓实跑）；辅②——spawn→工具注册完成 4550ms→550ms（**缩短 4.0s，≥4s 达标**；create 型 sync attempt failed 基线 5/5 → 修复后 0——修复侧残余 attempt 记录全部来自 restore 后 stale 周期，见偏差②）；辅①——重放处理→应答 0ms×3（<100ms；bridge:sync case 临时探针测得，已拆除并 shasum 核验字节级还原）。**B3**：bridge-handler 层 11 次转发与 pi 输出序 1:1、零重复零乱序（含 bridge:tool_execute 插件工具调用的一轮对话；数字口径注记：observer 口径为 7，此前误写的 19 = B1 create/restore 两化身跨场景聚合，一致性审查复核后以 B3 场景单独口径 11 为准）。**B4**：20 次 create/destroy 循环全绿、0 超限 warn、无跨 session 陈旧帧；spawn 失败形态（无效 pi binary → EACCES 报错链、runtime 存活——恢复指引由 D5 错误规格表/上层呈现承载，E2E 未覆盖该文案面）。**B5**：restore 后一轮对话 message.complete、事件流有序、无前化身陈旧帧。偏差登记：①B4「buffer 数组空」无运行时 inspector 通道，以结构性保证（重放即搬空，u-r1 单测覆盖内部状态）+ E2E 无陈旧帧/无超限 warn 佐证；②附带发现（非本设计引入）：restore 形态 bridge 第 2 个 sync 周期（resume 触发）命中 pi 侧「extension ctx is stale after session replacement」→ 30 次重试 60s Degraded——bridge×switch_session 既有交互，缓冲修复使第 1 周期成功（restore session 工具已注册），跟进归 bridge 设计侧。行号时点注记：§2.1/D6 引用的 rpc-client.ts:440-444 为基线 d3f808248 行号，实施后缓冲分支漂移至 :494、直通分支 :499-503。
