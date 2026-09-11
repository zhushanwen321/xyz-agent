# 空闲 pi 进程回收（idle pi reclamation）

> **一句话结论**：pi 子进程一旦 attach 就常驻到 session 删除或 runtime 重启，30 天使用后进程群达数 GB 级常驻（实测 ~10 个 pi 进程 850MB+）。本设计在 runtime 内新增周期 reaper：空闲超阈值且不在豁免集的 session，经**最小摘除**编排回收其 pi 进程——只杀进程摘 Map，**保留** bus 分区（订阅连续、seq 连续）、历史缓存（恢复走增量——P7 收益门已实测兑现）等一切可复用状态，**不触发**死亡清理汇聚点（`removeSessionEntry`）的销毁副作用（PTY 连杀 / 插件 destroy 投递 / 订阅拆除）；用户下次使用时经既有 `ensureActive → restoreSession` 惰性恢复（典型 ~600ms-3s）。

## 开篇（SCQA）

- **S（情境）**：Taiji 里每个聊天 session 对应一个 pi 子进程（历史权威在磁盘 JSONL，进程只是运行时载体）；用户日常开几十个 session，app 连续运行 30 天不重启。
- **C（冲突）**：pi 进程只在 session 删除或 runtime 重启时销毁——没有空闲回收。实测快照（2026-09-09 晚）：TaiJi 33 进程 3080MB，其中约 10 个 `pi --mode rpc` 各 80-141MB（合计 850MB+）全部常驻，对应 session 多数已数小时无人使用。在 20 天 uptime、swap 11GB/12GB 的系统背景下，app 自身足迹直接推高整机 OOM 概率（2026-09-09 renderer 崩溃即发生于该背景）。
- **Q（问题）**：如何让空闲 session 的 pi 进程被安全回收、用户下次使用时无感恢复，且绝不误杀有在途工作的 session？
- **A（答案）**：runtime 内周期 reaper（5 分钟一拍）+ 空闲阈值（默认 2h）+ 七类信号豁免集 + **最小摘除**拆链 + 既有惰性恢复。本文展开。

## 1. 背景目标

**本章结论**：目标从「30 天老用户的日常体验」倒推三条；本设计是长跑稳定性阶段一（根治）在**进程维度**的对应物（数据内存维度见 [long-run-stability-prevention-deep-dive.md](long-run-stability-prevention-deep-dive.md) O2/O3 项），对应架构文档 O4-A。

### 1.1 系统是什么（本设计涉及的现状机制）

xyz-agent 的 runtime（Node 子进程）为每个活跃 session spawn 一个 pi 子进程并持有 `RpcClient`（stdin/stdout JSONL RPC）。四个既有事实是本设计的地基：

1. **session 权威状态在磁盘**：pi 把 entry 流式写入 session JSONL 文件；进程死亡/被杀不丢已写入历史；`restoreSession`（`session-lifecycle.ts:890`）可重新 spawn + `switchSession` 附着旧文件恢复对话——日常冷启动恢复路径，非新机制。
2. **主动杀是静默的**：`RpcClient.kill()` 置 `_killing` 标志后走 SIGCONT→SIGTERM→2s→SIGKILL（`rpc-client.ts:1160-1195`）；exit handler 对 `_killing` 跳过 `writeCrashLogIfNeeded` 与 `exitCallbacks` 多播（`rpc-client.ts:489-504`）——「计划内杀」在既有语义里就不产生崩溃记录与死亡广播。
3. **侧栏对「持久化但未附着」的 session 已有天然表示**：scanner 投影 `status = outcome ?? 'idle'`（done/error/stopped/idle，`session-scanner.ts:66-87`）——runtime 重启后全部 session 就是这个形态。
4. **renderer 是全量订阅**：侧栏 list 内每个 session 都在 MessageBus 订阅（加入 list 即订阅、移除才退订，切 pane 不退订，`useSessionStreamSync.ts:59-99` 的 `bindSessionStreamSync` watch 编排 + `packages/core/src/domain/chat/useChat.ts` `ensureStreamSubscription`（:476 起，模块级 `streamSubscriptions` Map 分区））——这个现状决定了「查看豁免」不能用订阅者信号（恒真），见 D2 #6。

> 术语锚定：**「回收（reclaim）」** = 本设计新增的计划内动作——静默终止空闲 session 的 pi 进程并把它从 runtime 内存态摘除（`processes`/`sessions` Map），session 本身（磁盘文件 + 侧栏条目 + renderer 已加载消息 + bus 分区）不动。**「最小摘除」** = 区别于死亡清理汇聚点 `removeSessionEntry`（九步销毁：PTY 连杀/插件 destroy 投递/bus 分区清除/历史缓存清除等）的回收专用编排——只做「停事件流 + 杀进程 + 摘 Map + 定向清两小项」，逐项声明被跳过步骤的归属（D3 表格）。**「豁免集」** = 回收判定时检查的「有在途工作」信号集合。**「惰性恢复」** = 既有 `ensureActive` 路径。

### 1.2 设计目标

- **G1 足迹有界**：30 天运行中 pi 进程数与总 RSS 不随历史 session 数单调增长——空闲即回收，进程数由「近期活跃 session 数」决定，存在平台期。
- **G2 回收绝对安全**：任何有在途工作的 session 绝不被回收；用户在 drawer 终端跑的工作（PTY）与 pi 进程无关，结构性不受回收影响。
- **G3 恢复无感**：被回收 session 的下次使用（发消息/切换）典型 ≤3s 恢复、历史完整、**新回复的流式事件正常到达 renderer**（广播流不断）；不出现 dead UI、错误 toast、崩溃日志。
- **G4 可观测**：每次回收与恢复都留痕（日志行，含空闲时长/RSS/豁免分布），回收频率与「候选因故跳过」分布可查。

**In-scope**：runtime 侧 reaper（判定 + 最小摘除编排 + 日志）、RpcClient 空闲时间戳（含维护通道排除）、relay 按 mainSessionId 只读查询、switch 查看时间戳、dispatcher 入口 touch、restore 耗时日志、相关单测与集成测试。**renderer 零改动**（见 D3——bus 分区保留使订阅/seq 连续性不受影响）。
**Out-of-scope**：
- renderer 内存与数据路径治理（deep-dive O2/O3，E6 范围）；
- pi 进程内部内存优化（上游，不可改）；
- 阈值的用户设置 UI（常量 + env 覆盖先行）；
- 自愈/看门狗（架构文档阶段三）。
- **层声明**：本设计是**子系统技术方案层**——下一层产物 = 实现计划（任务拆分 + 测试用例），本文不写函数签名。

## 2. 现状与问题分析

**本章结论**：现状没有任何空闲回收机制；30 天维度下进程只增不减是结构性缺口；且「用死亡清理汇聚点做回收」的直觉方案与三个既有机制冲突（PTY 连杀 / bus 分区清除致广播断流 / 插件 destroy 语义污染），必须走最小摘除。

### 2.1 使用者视角的现状（真实数据）

一个典型工作日：用户上午开了 session A（重构讨论）、B（调研）、C（写代码），下午又开了 D、E……每个 session attach 一个 pi 进程（Bun 运行时，实测各 80-141MB RSS）。下班时 A/B/C 早已无人使用，但它们的 pi 进程全部活着——**直到用户手动删除 session 或重启 app**。30 天累计：几十个进程、数 GB 常驻。系统内存紧张时（本机实测背景：swap 11GB/12GB、物理空闲 ~170MB），这些死重直接参与制造整机 OOM。

对照：runtime 重启后的世界是干净的——全部 session 回到「持久化但未附着」，用户点击才恢复。**问题不是「没有恢复机制」，而是「正常运行中没有任何路径把闲置进程送回这个干净状态」。**

### 2.2 物理数据流（attach 之后的生命终点现状）

```
session attach（create/restore/fork）
   → pi 进程常驻（80-141MB/个）
   → 唯三出口：① 用户删除 session（lifecycle.delete → removeSessionEntry 全量销毁）
              ② runtime 重启（shutdown destroyAll / 孤儿收割）
              ③ pi 自己崩（session.exited → dead UI）
   → 30 天轨迹：出口①③偶发、②不发生 → 进程数 ≈ 历史活跃 session 数（无上界）
```

### 2.3 失败模式与既有耦合（根因分析）

**失败模式 A（主体）**：无空闲回收——`ManagedProcess` 只有 `{ client, cwd, createdAt }`（`process-manager.ts:17-21`），没有活动时间语义。

**失败模式 B（耦合 1：后台任务收殓）**：`removeSessionEntry` 是后台任务收殓触发面（`session-service.ts:1070-1078`）——pi 内 extension 的 detached 后台 bash 任务按 `ownerPiPid` 判孤儿（`background-task-reaper.ts:408-455`）。**回收一个尚有 running 任务的 pi，那些任务会被判孤儿杀掉**——豁免集硬约束。

**失败模式 C（耦合 2：relay 在途 subagent）**：subagent 经 relay 通道 spawn（注册表按 `mainSessionId` 关联主 session）。主 pi 被杀后 relay 代理**不会**可靠连坐死亡（`relay.mjs` 显式忽略 stdin EOF，`relay.mjs:264`）。查询缺口：RelayRegistry 原无按 mainSessionId 查询 API（该查询已于 u1b/u3a 落地——`hasByMainSessionId`）。

**失败模式 D（耦合 3：死亡清理汇聚点做回收的三重冲突）**：直觉方案「回收 = 调 `removeSessionEntry`」与三个既有机制冲突：
1. **PTY 连杀**：onSessionDelete 腿绑 `terminalService.destroyPty(sid)`（`index.ts:706-709`）——用户在 drawer 终端跑的 dev server/watch 会被静默杀掉，且 PTY 工作不属于任何 pi 侧豁免信号；
2. **广播断流**：尾步 `bus.clearSession`（`session-service.ts:1108`）拆除服务端订阅者集合——而 renderer 侧订阅失效钩子 `invalidateStreamSubscription` **只在 `session.exited` handler 内调用**（`useMessageEffects.ts` `handleSessionExited`，:82 起、调用在 :88，注释原文预言了此故障）；回收若不发 `session.exited`，恢复后新事件 publish 到空订阅者集合 → UI 卡「进行中…」；且新分区 seqCounter 从 0 起与 renderer 旧基线冲突（基线重置仅存在于 WS 重连路径）；
3. **插件 destroy 语义污染**：`didDestroy` 定向投递（`plugin-service.ts:445-447`）让插件把「回收」当「销毁」处理 per-session 状态——而回收后同 sid 恢复，插件状态本应连续（sessionData 是磁盘 KV，与进程解耦，`session-data-store.ts:41-60`）。

## 3. 解决方案

### 3.1 终态（使用者视角）

**场景一（日常回收）**：用户上午用了 session A/B/C，午饭前转向别的工作。两小时后 reaper 一拍：B、C 空闲超阈值且无在途工作 → 静默回收（日志 `[pi-reaper] reclaimed sid=… idleMs=7980000 runtimeRssMB=96`——实装格式，`idleMs` 毫秒数 + `runtimeRssMB` 记 runtime 进程水位，见 D7）；A 因有一台后台 bash 任务在跑而豁免。侧栏 B/C 状态从 active 回落 idle/done，消息流不动，**无任何报错提示**。

**场景二（无感恢复，含广播流连续）**：下午用户点回 session B：侧栏点击触发既有 `session.switch` → runtime `getSummary` miss（Map 已摘）→ 既有 `ensureActive → restoreSession`（典型 ~600ms，大 session 数秒）→ 对话继续。**用户发新消息，新回复的流式 delta 正常到达 UI**（bus 分区未清，订阅与 seq 连续）。被回收期间 renderer 已加载的消息原样保留（回收从不触碰 renderer 状态）。

**场景三（豁免优先）**：session A 的后台任务还要跑 40 分钟——每拍豁免；任务完成后下一拍（空闲时长达标）才回收。drawer 终端里的 dev server 与回收完全无关（最小摘除不动 PTY）。

**场景四（不该发生的都不发生）**：回收不产生 `session.exited`、不写 `pi-crash-*.log`、不弹 toast、不杀 PTY、不向插件投递 destroy、不动 renderer 已加载消息；生成中/压缩中/在途 subagent/交接中/有后台任务的 session 在任何时序下不被回收。

### 3.2 方案对比

| 方案 | 长期架构合理性 | 短期实现成本 | 风险 | 裁决 |
|---|---|---|---|---|
| **A. runtime 周期 reaper + 全信号豁免 + 最小摘除 + 既有惰性恢复**（推荐） | 高：回收 = 「把闲置进程送回 runtime 重启后的干净状态」，但比重启更优——保留 bus 分区/历史缓存等可复用状态，广播流不断、恢复走增量（增量收益经 P7 收益门实测兑现，见 D5）；reaper 用 DI 形态可纯单测（reap-orphan-pi 先例） | 低-中：一个 reaper 模块 + lifecycle 最小摘除函数 + RpcClient 时间戳 + relay 查询 + switch 时间戳；无协议变更、renderer 零改动 | 中：豁免集遗漏 = 误杀在途工作（豁免全清单 + 全链占座 + 验收反向场景压制） | ✅ |
| **B. 冻结而非回收**（SIGSTOP 空闲 pi，按需 SIGCONT） | 低：RSS 不完全释放（wired 页驻留），macOS 仅将页面置于可换出——swap 本身就是本案背景，冻结把压力转移进 swap 而非消除；与孤儿收殓/kill 链/liveness 语义冲突；冻结中 extension 定时器（scheduler）行为未定义 | 低 | 高：未验证断言面大 | ❌ |
| **C. renderer 驱动声明式**（前端上报活跃 pane 集合，其余回收） | 中：把「用户意图」放前端有道理，但多客户端一致性（split 两 pane、断线重连）需新协议；后端已拥有全部豁免信号，前端意图只是「查看」这一项的启发式 | 中：新协议面 + 前后端同步 | 中：协议漂移新故障面 | ❌ |
| **D. 回收复用 `removeSessionEntry`（死亡清理汇聚点）** | 低：§2.3 失败模式 D 的三重冲突（PTY 连杀 / 广播断流 / 插件 destroy 污染）全部命中；且历史缓存被清使恢复退化为全量重建 | 低 | 高：直接违背 G2/G3 | ❌（被否谱系：直觉方案，被源码事实击穿） |

被否方案落到 §2 的例子：若用 D，场景二里用户发新消息后 UI 卡「进行中…」（广播断流），场景三里 drawer 终端的 dev server 被杀——两个都是用户直接可感的回归；若用 B，30 天 swap 耗尽背景反而加剧。

### 3.3 关键决策与权衡

**D1：空闲信号 = RpcClient 双向 touch + 维护通道排除（选定）**

- **采用**：`RpcClient` 新增 `lastActivityAt`，两个唯一咽喉各 touch——出站 `sendCommand()`（`rpc-client.ts:765-831`）、入站 `handleMessage()`（`:617-665`）。`sendRaw`（`:751`）不在 touch 咽喉内——它是 `extension_ui_response` 的无回执生产通道（pi 对该命令不回 RPC reply，`sendExtensionUiResponse` 经它写入，`:1144-1155`）：用户交互场景已由入站 `ui_request` 事件帧 touch + 豁免 #1 occupancy 双重覆盖，无需出站腿；**未来新增维护类命令若走 sendRaw 需另行排除**（`pending.maintenance` 标记机制只覆盖 sendCommand 的 pending 生命周期，不覆盖 sendRaw）。初值 = spawn 时刻（start 前 client 以构造时刻兜底）。**排除维护通道（双腿闭合）**：出站腿 = `promptReload` 的调用带 `{ maintenance: true }` 标记，`sendCommand` 跳过 touch；回程腿 = maintenance pending 被其 response 解析时入站同样跳过 touch（标记随 pending 注册携带——出站与回程同频，只闭出站腿则 skill 变更风暴下空闲时钟仍被回声重置）。标记经语义方法 `prompt` 透传至 `sendCommand`（promptReload 实际调用形态是 `client.prompt`）。skill 目录任一文件变动会对全部活跃 session 触发它（`skill-registry.ts:359-366` → `reload-orchestrator.ts:87-94`），若计入 touch，skill 开发常态（本仓库日常）下全部空闲时钟被周期性重置、回收饿死且不体现为豁免命中（日志看不到）。
- **被否**：① 复用 `IManagedSessionView.lastActiveAt`——只记「最后出站 prompt」（写点仅 dispatcher/delivery），语义不对；② 不排除维护通道 + 接受污染——饿死是静默失效，违背 G4 可发现原则。
- **证据**：pi 空闲期无周期性 stdout（ADR-0047 ping 只在 turn 内 `event-interpreter.ts:457-458`；gen-stats/trace-sync 均按需非周期）——用户态空闲判定干净；唯一污染源即维护通道，已双腿排除（出站 touch 跳过 + 回程 maintenance pending 的 response 跳过，一致性审查后补齐——初版只闭出站腿，回程回声同频重置时钟的缺口由审查发现并修复）。
- **效果**：场景一的 2h 判定成立；「被使用即活跃」by construction。

**D2：豁免集 = 七类信号全查（选定）**

- **采用**：回收判定前逐一检查，任一命中即本拍跳过：

  | # | 信号 | 来源 |
  |---|---|---|
  | 1 | occupancy 三维非 idle（turn ∈ dispatching/generating/settling，或 compacting，或 bash） | 现成：`session.occupancy`（事件驱动幂等投影，`event-interpreter.ts:68-81`）——含 smart-context 接管压缩（compaction 事件仍由 pi 发出，`:857-940`） |
  | 2 | 有 running 后台任务 | 现成查询：`BackgroundTaskService.listTasks(sid)`（`background-task-service.ts:162-165`）——失败模式 B 硬约束 |
  | 3 | 有在途 relay 子进程 | **新增只读查询**：`RelayRegistry.hasByMainSessionId(sid)`——失败模式 C |
  | 4 | handoff 进行中 | 现成：handoff-service `inflight` Map（`handoff-service.ts:124`，本就有界 10min） |
  | 5 | delivery 内核有排队投递（completion-backflow 回流） | 新增只读查询：`SessionDeliveryRegistry.hasDeliveryActivity`（`handle.depth()>0`——isIdle 同款判定在回收态 getSession miss 恒 not-idle 会饿死回收，且与豁免 #1 occupancy 同源无增量；depth() 恰覆盖『session 空闲但回流投递停在队列』窗口） |
  | 6 | 最近被查看：`lastViewedAt` ≤ 30 分钟 | **新增时间戳**：`session.switch` RPC 处理器记录（挂点 `session-message-handler.ts:380`，`handleSessionSwitch` 入口段），不依赖 RPC touch。**存储位置钉死 session-service 侧 per-sid Map**（先例：`ActiveSessionResolver` 的模块级可变全局收口形态，`session-api.ts:128-138`——禁止实施期随手挂模块级全局）；清理挂点 = lifecycle.delete（真删除时清条目；回收态保留是对的——非候选无害，恢复后继续有效；量级每 sid 一个数字）。**不能用 MessageBus 订阅者信号**——renderer 全量订阅侧栏 list（`useSessionStreamSync.ts:59-99`），`hasSubscribers(sid)` 恒真，reaper 会永不回收（§1.1 事实 4） |
  | 7 | restore / 回收自身进行中（占座） | 新增：reaper `ReclaimSeat` 占座（tryAcquire/release/waitRelease）+ 既有 restore join 注册表（`pi-respawn.ts`，并发调用 join 同一 in-flight Promise）+ dispatcher 入口 touch（D6-1，隐式覆盖「prompt 已发出但 hook 未跑完」窗口） |

- **被否**：① 订阅者信号（恒真，见上）；②「最近查看」用 renderer 上报活跃 pane 集合——新协议面，30 分钟 switch 时间戳已覆盖工作集（方案 C 的最小合理子集）。
- **证据**：hidden session 现状零创建方（publicSession 已移除，commit `7f704f8ba`）——豁免面不含，未来复活需同步登记。
- **效果**：G2 成立。**「长期显示但 30 分钟无交互的 pane 会被回收」是显式取舍**：renderer 消息不动、下次交互 600ms 恢复——显示态保鲜不值得进程常驻。

**D3：回收编排 = 最小摘除（新增专用函数，不复用 `removeSessionEntry`）（选定）**

- **采用**：lifecycle 层新增 `reclaimManagedSession(sessionId)`，七步（全程持占座）：

  1. `ReclaimSeat.tryAcquire(sid)`（占座，D6-2）；
  2. 最终豁免检查（同步块，零 await——原子性见 D6-1。复查面 = 条目存在性 + occupancy 三维 idle（#1），实装即只复查这两项；其余豁免项不进复查面，其窗口关闭归 D6-1 入口 touch（prompt 类活动）/ 第 5 步①②定向收殓（#2/#3 在检查与 kill 间隙的退出）/ D6-3 代际校验（并发重建））；
  3. `adapter.detach`（停事件流）；
  4. `pm.destroySession`（SIGCONT→SIGTERM→2s→SIGKILL，`_killing` 语义零 crash log 零 exitCallbacks；先删 pm 双 Map 再 kill，`process-manager.ts:242-257`）；
  5. kill 完成后两个定向收尾（**fire-and-forget，`setImmediate` 先例同后台任务收殓——移出占座区间，不可杀的 D 状态子进程等极端阻塞不拖累占座释放**）：① relay 尾扫（`hasByMainSessionId` 复查，新条目 `killRelayChild`——scheduler 类 extension 可在 pi 空闲期经 relay socket spawn，不经 RPC touch，检查与 kill 之间可能落地。**实现前提（单段快照语义）**：复查读取与 kill 目标列表须同步一次完成，异步执行阶段禁止再查再杀——两段式（异步 kill 后二次复查再杀）可能误杀 restore 后新 session 经 relay 合法 spawn 的子进程。**快照采集点在代际校验（第 6 步，D6-3）通过之后**——校验失败（并发重建取消）路径零采集零杀，新 session 的 relay 条目天然不在任何快照里，fail-safe）；② 该 sid 的后台任务收殓检查（复用 background-task-reaper 的单 session 入口——正常情况豁免 #2 已保证无 running 任务，此步兜「任务在检查与 kill 间的毫秒窗口退出/registry 写半截」的边角）；
  6. 最小摘除：lifecycle `sessions` Map 删条目 + `ReloadOrchestrator` 定向清该 sid 的 `pendingReload`（**防御性 no-op**：pendingReload 有条目 ⇒ session busy ⇒ 恒非回收候选；真发生的窗口极窄，且回收态不在 `getActiveSessionIds()` 内不会被 skill 变更重新通知——恢复时 spawn 新进程天然加载最新 skills，无需自愈）；
  7. **try/finally 释放占座**（占座只持有第 1-6 步的有界步骤——判定/detach/kill（≤2s 超时）/摘除；任一步抛异常 finally 兜底释放，等待中的 `ensureActive` 不会因占座泄漏永久挂起）；随后 `broker.broadcast(config.sessions)`（**按拍合并一次**——一拍回收 N 个 session 只广播一次，避免 N 次 scanner 全量读盘 + 侧栏 N 次重渲染，广播在占座外执行）+ 日志行。

  **被跳过的 `removeSessionEntry` 步骤及归属声明**（接管面逐段判定）：

  | 步骤 | 归属判定 |
  |---|---|
  | `bus.clearSession`（订阅/分区清除） | **刻意跳过**：分区保留 = 订阅者集合 + seqCounter + ring 全部连续——恢复后新事件 publish 到既有订阅者、seq 无断裂、断线回放可用。代价：分区 ring（≤1000 帧）与空闲期不再增长的存量常驻——与「分区随订阅创建、从未按 session 清理」的现状同构，无新增无界面 |
  | `terminalService.destroyPty` | **刻意跳过**：PTY 是用户终端工作，与 pi 进程无关——结构性安全（G2），无需豁免信号 |
  | 插件 `didDestroy` 投递 | **刻意跳过**：回收不是销毁；sessionData 是磁盘 KV 与进程解耦（`session-data-store.ts:41-60`），插件 per-session 状态在恢复后同 sid 连续复用 |
  | history/trace/projection/records 四域 `onSessionDisposed` | **刻意跳过**：四域 sid 键控可复用。其中 **projection 是带定时器的实例组**（`session-state-projection.ts:166`）——三型定时器在保留态均无活性副作用（事件驱动防抖 / 有界退避序列 [1s,5s,15s] 自耗尽 / 周期 pollTimer 机制在但配置全关，`replicated-states.config.ts:11,109`），恢复无双实例（register 幂等先 dispose 旧实例，`:301-309`）。**前提约束（登记 C-state-12）**：保留态安全依赖「replicated state 周期 pollTimer 全关」的配置事实——未来任一 replicated state 启用周期 poll，回收态会留下「周期 poll → 死进程 reject → backoff → 再 poll」循环；启用周期 poll 前必须先给回收态加结构性收尾（R 态实例 dispose 定时器保留数据）或取消该域跳过。**约束已登记 `docs/constraints.json`**（scope=runtime replicated-state，AGENTS.md「新增约束先登记再写代码」）。**历史缓存**保留的条件收益已兑现（P7 真机实测 incremental：恢复后 leafId 命中空增量短路零重建，见 D5 裁决）；「门失败时缓存白驻留 + 注定失败的增量 RPC」的条件代价未触发；records 防抖为事件驱动一次性 setTimeout（`session-records.ts:166-168`） |
  | `sessionDelivery.dispose`（`index.ts:554`） | **刻意跳过**：handle 的 `isIdle` 经 `deps.getSession` 动态查（`session-delivery-registry.ts:118-121`）——回收态 get miss 恒 not-idle、无投递行为；恢复后经 `getOrCreateDelivery` 复用既有 handle（`:143-149`）且 getSession 复原 → 语义连续。sid→handle 映射保留与 bus 分区同构（有界：一 handle/回收 session） |
  | genStats `modelBySid` 映射清（已内聚 `gen-stats-service.ts`，装配经 `registerSessionCleanup` 注册，`index.ts:659`） | **刻意跳过（有益）**：映射保留使恢复后 gen-stats 降级链②直接命中（`gen-stats-service.ts:135` 读点），无需重建 |
  | 挂起 UI 请求清理 | **跳过**：**ui_request 无超时自清理**（超时机制已整体取消——`extension-timeout-manager.ts:91-93`（2026-07-16 注释）：confirm/select/input/editor/ask-user 统一不超时、block 等待用户决策，`registerTimeout` 体内不再排定时器；5min 常量仅保留供单测）。跳过安全的真实依据是**双重保护**：①挂起 ask-user ⇒ pi turn 进行中 ⇒ occupancy=generating ⇒ 豁免 #1 拦截；②ui_request 事件经 pi stdout 到达 ⇒ 入站 touch 刷新空闲时钟 ⇒ 2h 阈值不满足——回收候选基本不可能带挂起弹窗（极端形态：turn 外 extension 主动弹窗且挂起超 2h，保护①的 turn 绑定假设不成立——后果经核极轻：回收后弹窗滞留 renderer、恢复后经 `pendingRequests` 的「session 重新激活时推送」重推，与未回收行为等价，无崩溃无数据损失）。条目残留由下一次真删除清理（`clearForSession` 挂在本汇聚点），量级恒小（每挂起请求一条） |
  | 后台任务 unwatch + 收殓触发面 | **改为定向触发**（第 5 步②）：不再经汇聚点连带，只在 kill 后定向检查该 sid；unwatch 保留至真删除（回收态保留 watch 无行为副作用——pi 死后 registry 不再变化，恢复后 watch 仍有效） |
  | `respawn.cancel`（取消 pending 自动恢复 timer） | **刻意跳过**：回收的主动 kill 走 `_killing` 静默链、不经 onSessionExit，不排 respawn timer——回收态无 pending timer 可取消（respawn timer 只在 pi 意外退出路径 schedule，`session-service.ts` `onSessionExit`）；恢复路径若真有在途 respawn，则被豁免 #7 `isRestoring` 拦在判定阶段，到不了本编排 |

- **被否**：① 复用 `removeSessionEntry`（方案 D——三重冲突见 §2.3/§3.2）；② 复用 `forceQuitSession`（`message-dispatcher.ts:481-501`）——它发 `session.exited` + 强写 stopped，是死亡语义；③ 只 destroy 不摘 sessions Map——`getSummary` 命中死条目直接 reply，`ensureActive` 永不触发（僵尸形态，[pi-exit-notification-and-respawn.md](../architecture/pi-exit-notification-and-respawn.md) 失败模式 A 的复刻）。
- **证据**：静默先例 = restoreSession 清场与 lifecycle.delete（零广播）；`destroySession` 的 exit 回调按 `clientToId` 无条目守卫静默跳过（`process-manager.ts:166-182`）。
- **效果**：场景四全项成立；场景二的广播流连续 by construction。

**D4：周期与阈值（选定）**

- **采用**：reaper 周期 5 分钟（`setInterval(...).unref()`，对齐 `BackgroundTaskService.start()` 形态，挂载进 `startup-background-init` 后台序列）；空闲阈值默认 **2 小时**；查看豁免窗口 30 分钟（D2 #6）；env 覆盖命名**钉死 `XYZ_RUNTIME_PI_RECLAIM_*` 前缀**（`ENV_WHITELIST_PREFIXES` 只放行 `XYZ_` 前缀进打包版 runtime，`apps/electron/main/supervisor/safe-env.ts:18` + `shared/constants.ts:72`——非此前缀的测试 env 在打包版静默失效），三旋钮实装为 `XYZ_RUNTIME_PI_RECLAIM_TICK_MS` / `_IDLE_MS` / `_VIEWED_WINDOW_MS`（SSOT = `shared/constants.ts`，解析收口 `resolveReclaimConfig`，非法/非正数回落默认）。默认值双源：shared SSOT（生产权威，装配恒传）+ reaper 模块内联兜底（仅 DI 单测场景），等值由守卫测试锁定（idle-pi-reaper.test.ts）。无「总进程数硬上限强制回收」——硬上限会把「用户真开很多活跃 session」误伤为异常。**实现辅助面**（idle-pi-reaper.ts）：`runOnce()` 手动一拍入口（测试与未来手动触发，与周期 tick 共用同一实现）+ 单拍重入保护 `inProgress` + post-reclaim broadcast try-catch 失败仅 warn（best-effort 通知不阻断回收主流程）。
- **被否**：30 分钟阈值——切换频繁的工作模式下回收/恢复抖动变常态；24 小时——对「午饭/会议」级离开太迟。
- **证据**：恢复成本 ~600ms 端到端（spawn ~500ms + RPC <1ms，`session-lifecycle.ts:731-732`）。
- **效果**：G1 平台期由「2h 内活跃 session 数 + 30min 内查看的 session 数」决定。

**D5：恢复 = 零新机制 + 条件性增量收益（选定）**

- **采用**：既有三入口全数生效——`session.switch`（getSummary miss → ensureActive，`session-message-handler.ts:366-407`）、`session.send`（dispatcher 第一步）、`session.restore`（显式）。新增：`restoreSession` 补 elapsed 耗时日志（现状无计时）。
- **历史缓存的条件性增量收益（P7 收益门，已裁决兑现）**：D3 保留历史缓存使恢复后的 `getHistory` 走 `getEntries(since=leafId)` 增量。设计阶段存在两方对立论证：反方 = `session-service.ts` 旧注释断言「pi 进程退出后缓存基线（lastLeafId）不再与新进程的 entry 集合对应，保留只会走 'Entry not found' fallback」+ restore 流程含 `normalizeInactiveSessionFileIfNeeded`（`session-lifecycle.ts:962`）可能改写尾部 entry 使 leafId 失效；正方 = `doGetHistory` 分支 1 只需 client 存在 + 缓存命中（`history-rebuild-cache.ts:385-391`），entry id 持久化于 JSONL。**裁决（2026-09-11 真机实测，u4 集成测试）**：gate_pass=incremental——回收 → restore 后 getHistory 走空增量短路零重建（证据日志 `[session-service] getHistory cache fresh (empty delta) ... returning 2 cached messages`，restore elapsed=535ms，G3 ≤3s 达标），缓存 leafId 跨 pi 进程存活；反方论证被实测推翻；「门失败 → 撤回收益声明 / 改回收时定向清缓存」降级路径未触发、不再启用。被推翻的旧注释已在实现侧修正（session-service.ts / history-rebuild-cache.ts，死亡路径清理理由保留）。
- **被否**：回收时预拉快照/预热——与最小改动相悖。
- **效果**：场景二成立；恢复路径唯一新断言是 elapsed 日志与 P7 门。

**D6：竞态防护 = 入口 touch + 全链占座 + 代际校验（选定）**

- **采用**：三件套：
  1. **dispatcher 入口同步 touch**：`sendPrompt` 函数入口（**任何 await 之前**）同步刷新 `lastActivityAt`（未附着态无需 touch：restore spawn 的新 client 初值 = spawn 时刻，空闲时钟天然不达标）。必要性：`markSessionActive` 置 occupancy=dispatching 位于 `await runBeforeSendHook`（插件 hook，单 handler 5s 超时）与 `await ensureActiveOrBroadcast`（restore 600ms-3s）**之后**（`message-dispatcher.ts:186-206, 282-298`）——入口 touch 使「prompt 已发出、hook/restore 执行中」的窗口内 reaper 判定不满足阈值（刚 touch 过），by construction 关闭窗口。
  2. **全链占座（有界 + finally，等待方永不抢跑）**：`ReclaimSeat` 占座从判定前持有到第 6 步摘除后（try/finally——任一步异常兜底释放）；占座区间只含有界步骤（判定 sync / detach sync / kill 硬上限 2s——`KILL_TIMEOUT_MS` 后 SIGKILL，`:134/1173-1177` / 摘除 sync），**区间天然有界（最坏 ~2-3s）且 finally 保证终将释放**。`ensureActive` 入口检查 `ReclaimSeat`——命中则**等待占座释放后走 restore**（等待是有界的：释放由 finally 保证；restore 的 existing 清场对已摘除条目是 no-op，无二次销毁）。等待超 5s 仅记 ERROR 观测（说明占座实现有 bug，不是抢跑信号）。**边界（显式 restore 不让路）**：用户显式 `session.restore`（handler 直调 `restoreSession`，不经 ensureActive）与 kill 窗口相撞时，触发的是用户主动请求的既有清场重建（发生于 reclaim 摘除之前）；随后 reclaim 的代际校验检出新条目返回 false，无双重销毁——该边界等价于回收前就存在的「对活跃 session 显式 restore」语义。**被否：超时抢跑直接调 restoreSession**——若占座者尚未完成第 6 步摘除（高载/高 swap 机器——正是本设计的问题背景——区间被拉过告警线完全可能），抢跑的 restoreSession 走 existing 清场分支（`session-lifecycle.ts:908-913`：`detach + safeDestroy + removeSessionEntry`）= 死亡清理汇聚点被完整触发：`bus.clearSession` 断流 + `destroyPty` 连杀 + `didDestroy` 投递，§2.3 失败模式 D 三重冲突一次全中且不可逆。「恢复优先」不靠抢跑实现，靠占座区间有界性实现。
  3. **代际校验**：第 6 步摘除前复查 pm/lifecycle 无该 sid 的新条目（未被并发路径重建）——占座的兜底，防御未来新增的绕过 `ensureActive` 的恢复入口。
- **被否**：给 relay 注册加「主 session 存在性校验」——扩大子系统耦合面（尾扫已兜）。
- **效果**：G2 在并发时序下成立；P6 探针覆盖三场景。

**D7：可观测（选定）**

- **采用**：每次回收一行结构化日志（sid / idleMs / runtime 进程 RSS 水位——pi 进程 RSS 不经 RPC 暴露，记 runtime 水位并归因到回收时刻）；每次恢复一行 elapsed；**每拍 info 级汇总**（scanned=候选数 / 回收清单 / 因阈值未满与各豁免项的跳过分布（含 noActivity / seatHeld / reclaimFailed 增量维度）/ runtime `process.memoryUsage()` 水位——「回收饿死」类问题（如维护通道污染若回归）在分布里可见；info 而非 debug：5 分钟一拍频率极低，prod 落盘保证可查，水位是代价声明 1 重审触发的观测手段）。阶段二台账落地后追加 `event=pi-reclaimed` 进 `runtime.jsonl`——本设计保证日志行格式可解析。
- **被否**：用户 toast 通知——回收是正常资源管理不是事件（与「自愈必须可见」不同：自愈对应故障、回收对应闲置）。
- **效果**：G4 成立。

**D8：测试策略（选定）**

- **采用**：reaper 照抄 `reap-orphan-pi.ts` 的 DI 形态（`:182-195`）做纯单测（vitest + fake timers）：判定矩阵（阈值边界 / 七类豁免各一例 / 维护通道不 touch / 入口 touch 关窗 / 占座与代际校验时序）；集成测试借 `relay-integration.test.ts` 真进程模式（`:1-60`）做端到端主干（真 pi → 空闲 → 回收 → restore → 历史完整 → 新回复流式到达）。
- **被否**：全真进程矩阵——慢且 flaky。

**代价声明（已接受，共两条）**：

1. **bus 分区与历史缓存保留的内存**：**正确论证 = 回收净效果**——释放 80-141MB/进程，保留项是**既有占用**（分区与缓存在回收前即已存在，回收不新增任何一份），且各自有界（ring ≤1000 帧/分区、空闲后不再增长；历史缓存受 LRU=8 换出约束——注意大 session 的缓存可达数百 MB，是既有的 E6 治理对象而非本设计引入）。**真实回收通道** = 用户真删除 session（lifecycle.delete → `bus.clearSession`）或 runtime 重启（`unsubscribe` 只动订阅者集合不删分区，`message-bus.ts` `unsubscribe`（:378-391）——分区仅 `clearSession` 删（:416-429））。重审触发 = D7 每拍汇总含 runtime `process.memoryUsage()` 水位（U3 落地），回收态存量导致水位长期不回落即重审保留策略；判定：**可接受**。
2. **缓存保留的净价值由 P7 收益门裁决**：门通过 → 恢复零重建（收益兑现）；门失败 → 退化为全量重建（量级 = 大 session 数秒 + 内存尖峰为文件量级，`getEntries` 全量 + entry 树重建）+ 缓存白驻留至 LRU 换出；恢复路径 = 门失败时改回收时定向清缓存（消除白驻留）；重审触发 = 大 session（>50MB）恢复 >5s 频繁发生时引入分级阈值；判定：**可接受**（两条路径行为均安全，悬而未决的只是收益大小；即便门失败，最小摘除相对方案 D 的 PTY/广播流/插件语义收益不变）。

### 3.4 探针清单

| ID | 验证的行为断言 | 探针方式 | 状态 | 失败时的降级路径 |
|---|---|---|---|---|
| P1 | 静默杀空闲 pi 后 session 文件完整、restore 复活历史无损 | 实施期实测：真 pi + 一轮对话 + 空闲 + 回收 + restore，比对 entry 数（先例佐证：restore 清场 safeDestroy 后再附着是日常路径） | ✅ u4 集成 + Gate B V1 真机（2026-09-11）：历史完整比对过、restore elapsed=544ms、零 crash log | 失败 → 回收前 RPC 触发 flush；仍失败 → 设计回炉（数据完整性不可妥协） |
| P2 | occupancy 对 handoff 直 prompt（不经 dispatcher）的覆盖窗口 | 实施期实测 handoff 全程 occupancy 曲线 | ✅ 免测（内建覆盖）——D2 #4 handoff 硬豁免已实装（`hasInflightHandoff` + 装配接线 + 真生命周期链用例），occupancy 覆盖窗口不再构成误回收面（2026-09-11 一致性审查裁决，实施计划 §7 登记） | — |
| P3 | 恢复后广播流连续：订阅者不丢新事件、seq 无断裂 | 实施期实测：回收 → restore → 发消息，断言 renderer 收到流式 delta 且无 gap 重连 | ✅ u4 集成 + Gate B V1 真机（2026-09-11）：流式 delta 实时到达 + per-sid seq 跨回收边界 gaps=0（D3 核心断言成立） | 失败 → 回收改发轻量 `session.detached` 通知触发 renderer 失效订阅（renderer 需小改，In-scope 同步修订） |
| P4 | scheduler 类 extension 空闲期经 relay spawn 的尾扫收殓 | 实施期实测：scheduler 定时任务在回收窗口触发，验证尾扫杀 relay 子进程并记日志 | ✅ 单测腿已实测（reclaim-orchestration 尾扫单段快照 kill + 不误杀用例）+ Gate B V4 真机无孤儿残留（2026-09-11；V4 的 subagent 为 pi 进程内 turn 形态，relay socket 形态未被真机触发——Gate B 观察登记②裁决两物种各自有防线无缺口）；scheduler relay 真机形态归 V6 长跑观察 | 失败 → relay 注册加主 session 存在性校验（D6 被否方案回炉） |
| P5 | 维护通道不污染 touch：skill 变更风暴下空闲时钟不被重置 | 单测锁定双腿（出站跳过 + maintenance pending 回程跳过 + 事件帧/非维护 response 照常 touch）+ 真机变更 skill 目录验证候选不被饿死 | ✅ 单测腿已实测（rpc-client-activity.test.ts 双腿用例）；真机腿归 V6 长跑观察 | 失败 → touch 排除面扩大（get_state 等其余维护 RPC 一并排除） |
| P6 | 竞态三窗口全部关闭 | 单测三场景：① dispatcher 入口 touch 关 hook 窗口；② kill await 期间并发 `session.switch`（占座让路、等待方不抢跑、释放后 existing 分支 no-op、无二次销毁）；③ 摘除前代际校验（注入重建竞态）。**另含尾扫不误杀**：restore 完成后新 session 经 relay 合法 spawn 的子进程不被迟到的尾扫命中（单段快照语义） | ✅ 单测三场景 + Gate B V7 真机（2026-09-11）：并发冒烟零僵尸 / 零双重销毁 / 零消息丢失，时序故障不复现 | 失败 → 对应窗口的兜底机制回炉（入口 touch 提前 / 占座范围扩大 / 校验强化 / 尾扫改两段式前的存在性校验） |
| P7 | **收益门（非仅验证）**：缓存 leafId 跨进程存活——回收 → 再进入的 getHistory 命中增量而非 "Entry not found" fallback（与 `session-service.ts` 旧注释的正冲突由此定案，见 D5） | 实施期实测：回收 → 再进入，日志断言 `getHistory incremental`；若走 fallback 则门失败 | ✅ 已实测 **PASS（incremental）**（2026-09-11，idle-pi-reclaim-integration.test.ts 阶段 4：`cache fresh (empty delta)`，restore elapsed=535ms；裁决登记实施计划 §7） | 已兑现，降级路径归档不启用（见 D5） |
| P8 | 大 session 恢复端到端耗时 | 50MB+/198MB 级真实 session 实测 restore + getHistory 全链 | ⛔ | 超 5s → 触发代价声明 2 的重审条件 |

## 4. 验收（真实场景，非单测非 mock）

**V1（验 G1+G3，基本回收与无感恢复，含广播流）**：打包版 app，`XYZ_RUNTIME_PI_RECLAIM_IDLE_MS` 调小（如 5 分钟）。开 session A/B/C 各完成一轮对话后闲置。通过标准：阈值后下一拍内 B/C 的 pi 进程消失（`ps` 验证）；全程**零**错误 toast / dead UI / `pi-crash-*.log` 新文件；侧栏 B/C 状态回落 idle/done 而条目与消息流不动；点回 B 后 ≤3s 恢复（日志 elapsed）、历史完整、renderer 已加载消息与 reconcile 一致；**恢复后发新消息，回复流式 delta 在 UI 实时可见**（P3 的真机形态——「可继续对话」必须包含流式可见，RPC 通道正常但广播断流的故障形态被此断言拦截）。**回溯 G1/G3。**

**V2（验 G2，豁免——生成中）**：session A 流式生成中，阈值到达。通过标准：A 不被回收（occupancy=generating）；生成完毕再闲置一个阈值后才被回收。

**V3（验 G2，豁免——后台任务）**：session A 经 bash 后台模式起 sleep 300 任务（registry 登记 running）后闲置超阈值。通过标准：A 全程不被回收；任务完成后下一拍被回收；**任务存活期间未被收殓误杀**（registry 状态与进程存活双验证）。**回溯 G2——失败模式 B 直接验收。**

**V4（验 G2，豁免——在途 subagent）**：session A 派出长任务 subagent（relay 在途），主 session 闲置超阈值。通过标准：A 不被回收；subagent 正常完成、结果回流；完成后 A 才可被回收；**回收后 `ps` 无孤儿 subagent 残留**（尾扫生效）。**回溯 G2——失败模式 C 直接验收。**

**V5（验 G2+G3，查看豁免与恢复路径）**：split 两 pane 显示 A/B，闲置超阈值但查看窗口内。通过标准：30 分钟内被 switch 过的 A/B 不被回收；超过查看窗口且无其它活动后可被回收；切回后恢复正常（renderer 消息未动）。**断线重连场景**：对已回收 session，WS 重连 resubscribe 建立空分区订阅不报错；随后 `session.switch`（getSummary miss → ensureActive）触发恢复——注意恢复腿在 **switch** 而非 subscribe（`session.subscribe` 只做 `bus.subscribe`，`session-message-handler.ts:585-627`），重连本身不产生错误态。**回溯 G2/G3。**

**V6（验 G1+G4，长跑足迹平台期 + 宿主不变量）**：真实日常使用 7 天（默认阈值）。通过标准：pi 进程数围绕「当日活跃 session 数」波动、存在平台期；app 重启后 session 列表/历史与回收前一致（回收从未触碰磁盘 session 文件）；每拍汇总日志齐全（回收数/跳过分布可见）；**drawer 终端跑的 dev server 在同 session 被回收后仍存活**（PTY 结构性安全的真机验证）。**回溯 G1/G4。**

**V7（并发冒烟，验 D6）**：真机把阈值调小，在回收拍即将到达时连续快速操作（发送消息 / 切换 session / 立即再发送）。通过标准：无僵尸 session（发消息不报 `pi process is not running`）、无双重销毁日志、无消息丢失；多等待者并发恢复命中 join 等待（无报错，等待后自动成功；既有行为非新回归）。P6 单测的时序在真机不复现故障。

**负面行为验证（贯穿 V1-V4）**：全程无 `session.exited` 广播（renderer 无 markDead）、无 crash log、无后台任务误杀、无 relay 孤儿、无 PTY 误杀（V6）、插件不收到该 sid 的 destroy 投递（可经插件日志抽查）。

## 5. 下一层拆分（实现计划的任务级拆分）

| # | 单元 | 内容 | 为什么这么拆 | 对应验收 |
|---|---|---|---|---|
| U1 | 空闲与查看信号基建 | RpcClient `lastActivityAt`（双向 touch + 维护通道排除 + dispatcher 入口 touch）；switch 处理器 `lastViewedAt`（**session-service 侧 per-sid Map**，lifecycle.delete 清理挂点）；`RelayRegistry.hasByMainSessionId` | 最小基建、无行为变更，先行合入零风险 | P5/P6-①、V1 判定基础 |
| U2 | reaper + 最小摘除 | `reclaimManagedSession` 七步编排（含占座 finally 化/有界区间/代际校验/尾扫与定向收殓 fire-and-forget/pendingReload 定向清）+ 判定矩阵 + 每拍汇总日志（含水位） | 核心逻辑，DI 纯单测主战场 | P2/P3/P4/P6、V1-V5/V7 |
| U3 | 挂载与配置 | startup-background-init 挂载 + `XYZ_RUNTIME_PI_RECLAIM_*` 常量（shared 登记，`XYZ_` 前缀钉死）+ restore elapsed 日志 + 按拍合并广播 + 每拍 `process.memoryUsage()` 水位（代价声明 1 的重审观测）+ **projection 前提约束登记 `docs/constraints.json`**（改 json 后跑 `node scripts/render-constraints.mjs`） | 接线与旋钮独立 | V1（env 调小）、V6（默认值） |
| U4 | 集成测试 + 真机验收 | relay-integration 模式端到端 + V1-V7 真机脚本 | 真进程验证独立于单测节奏 | V1-V7 |

**文件改动地图**：改写 `rpc-client.ts`（touch + 排除标记）、`session-message-handler.ts`（switch 记录 lastViewedAt）、`message-dispatcher.ts`（入口 touch）、`session-lifecycle.ts`（`reclaimManagedSession` + Map 最小摘除 + restore elapsed 耗时日志——restoreSession 体内）、`relay-registry.ts`（只读查询）、`session-service.ts`（ensureActive 占座让路）、`startup-background-init.ts`（挂载）、`packages/shared/src/constants.ts`（阈值常量）；新增 `packages/runtime/src/services/session/idle-pi-reaper.ts`（DI 形态）；登记 `docs/constraints.json`（projection 前提约束）。

**待验证检查点**：P4 的 scheduler relay 真机形态（V6 长跑自然触发）+ P8 大 session 恢复耗时；阈值 2h 与查看窗口 30min 的校准（V6 数据后复核）。P1/P3/P6 已由 u4 集成 + Gate B 真机闭环、P4 真机腿见探针表状态列（2026-09-11）。ui_request 超时机制疑点已在审查中定案（机制不存在，归属表已按双重保护改写）。

## 附录：与既有文档的关系

- 本文 = [long-run-stability-architecture.md](long-run-stability-architecture.md) 阶段一在进程维度的展开（deep-dive O4-A），建议实施时并入 E6 范围登记。
- 与 [pi-exit-notification-and-respawn.md](../architecture/pi-exit-notification-and-respawn.md)：lazy respawn 裁决不受影响；死亡通知传播链（session.exited）不被触碰。
- 与架构文档阶段三 D2（intentional-kill 抑制通道）：不依赖（`_killing` 语义已保证静默）；若阶段三先行，回收登记进 intentional-kill 集合保持口径一致。
- 被否谱系：方案 D（复用 removeSessionEntry）被 PTY 连杀 / 广播断流 / 插件 destroy 污染三重源码事实击穿——任何后续修订不得回到该方案，除非三重冲突全部有了独立解法。
