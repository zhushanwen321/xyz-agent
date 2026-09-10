# subagent 完成回收可靠性根修（agent_end 处置翻转 + sessionFile 双路获取 + pi 通道原语收敛）

> **一句话结论**：把「subagent 完成后不通知主 agent」的根因——get_state 握手一次性失败导致 sessionFile 永久缺失、agent_end 处置误入无限保守等待——从正常路径上消灭：迟到应答照收（它必然会到）、sessionDir 扫描兜底（文件必然在）、处置默认翻转（读不出不再无限等）。三件互相独立、可分批落地，合并预期把「读不出」分支的触发率打到接近零、残余失败的最坏等待从 30 分钟 / 无限收敛到 15 秒。

## 0. 层声明

当前层 = 技术方案层（缺陷根修 + 架构收敛的设计）。下一层产物 = 可实施的代码任务（§5 拆分单元），非需求规格。涉及运行时行为 / 数据流 / 错误处理，准则 5/6/7 全适用（最严格档）。

与既有文档的关系：

- `docs/design/subagent-core-unbounded-wait-audit.md`（下称 audit）：缺陷普查 + 修复方向。其 T1 主题（agent_end 惰性回补）已作为 U-T1 单元交付（8.8.0），是本设计的基础设施。本设计在其之上做两件事：①补 T1 未覆盖的失败路径（迟到接受 + 扫描兜底，audit P-T1 备注中「sessionDir 后缀扫描未启用，保留为 LC-4/PS-9 修复面」正是本设计 D2——扫描接入**两个**点：agent_end 决策回补链 + close 收尾反查链（`backfillSessionFileByLookup` 的 lookupId 缺失形态），后者覆盖「握手窗口内子进程被提前 kill、不产生 agent_end」的 LC-4/PS-9 原生修复面）；②新增一个 audit 未建模的架构决策（处置默认翻转，D3）。audit §5 根因三裁决中的裁决 2（保守 = 不限时）由 D3 直接收口。
- 实施落地后按 C-proc-10 回写 audit 的登记与变更历史。

---

## 1. 背景目标

### SCQA

- **S（情境）**：taiji.app 中每个 subagent 是独立的 `pi --mode rpc` 子进程，跑完任务后不主动退出，由 host（subagent-core）在收到 `agent_end` 事件时判定「杀还是等」，杀掉（或确认死亡）后 `runSpawn` 才返回，结果回收、完成通知才会发生。
- **C（冲突）**：判定「该不该等」需要读子进程 session 文件里的 pending 差集（有没有活跃后代），而 session 文件路径只有一个获取通道——spawn 后 7 秒内的一次性 get_state 问答。并发 spawn 时 pi 子进程冷启动（加载全部 extensions）被 CPU/IO 争抢拖过 7 秒，问答错过，**迟到的应答会被 host 丢弃**，路径永久缺失。缺失被处置逻辑当作「可能有后代」，无限保守等待——进程不杀、`runSpawn` 不返回、通知整条链冻结。
- **Q（问题）**：如何在正常路径上让「sessionFile 缺失」几乎不可能持续存在，并让「读不出」的残余情形有秒级而非小时级的收敛？如何消除同一套 pi 通道原语在 Runtime 与 subagent-core 两处实现、修复不传播的分叉？
- **A（答案）**：三条根修（D1 迟到接受 / D2 扫描兜底 / D3 处置翻转）+ 一条架构收敛蓝图（D4 通道原语归一）。

### 系统是什么（受众补认知）

subagent 派发的两条入口，汇到同一个执行器 `runSpawn`（`packages/subagent-core/src/execution/engine/engines/pi/session-runner.ts`）：

```
主 pi 进程（用户对话的主 agent，加载 @zhushanwen/pi-* extensions）
├─ 工具路径：主 agent LLM 调 "subagents" 工具（spawn）
│    sync 形态阻塞返回；background 形态完成后异步通知主 agent
└─ workflow 路径：主 agent 调 "workflow" 工具 → Worker Thread 跑 JS 脚本
     → 脚本调 agent() → postMessage(agent-call) 给主线程
     → 主线程 dispatchAgentCall → executeAgentCall → runSpawn
     → 完成后 postAgentResult 回 worker，脚本继续
```

`runSpawn` 生命周期七阶段（派发 → spawn+握手 → 执行 → **agent_end 处置** → 结果收尾 → 完成通知 → 回收）。**阶段 4 是本设计的主战场**：rpc mode 子进程永不主动退出，host 必须主动决策。

### 生产事故（真实失败模式，carbon 2026-09-09，4 次复现）

Stock 月报 workflow（6 路并发 subagent）在 carbon PROD 全部 90 分钟墙钟超时耗尽。证据链：

| 时刻 | 事件 |
|---|---|
| 21:28:25→38 | 串行预热第 1 只 subagent 36s 正常完成（机器空闲，握手成功） |
| 21:28:42-43 | 批 1 的 6 只并发 spawn（session 文件创建证明 spawn 成功） |
| 21:28:59 | 6 只全部完成（session 均含最终 assistant 输出） |
| 此后 90 分钟 | **零结果回收**：workflow state 的 calls 恒 1 条、零新派发，直到 5400s 超时 |

根因链（每环均已代码实锚）：

```
6 路并发 spawn → pi 冷启动互相拖慢
→ get_state 7s 窗口集体错过（命令在 stdin 排队不丢，pi 就绪后必答）
→ host 侧 resolver resolved=true，迟到应答被丢弃
  （get-state-handshake.ts:104-116 `if (resolved) return`）
→ record.sessionFile 永久缺失
→ agent_end 处置：readActivePendingFromSessionFile(undefined) 返回 error
  （session-pending.ts:111-112）
→ error 归入「可能有后代」保守不杀（session-runner.ts:1938）
→ 8.6.0 该形态无任何 timer → 子进程 idle 永活 → close 永不到
→ runSpawn 永不返回 → postAgentResult / notifyComplete 整条下游不存在
```

「串行 OK、并发全丢」的机制：同一根因在并发负载下的概率放大——不是新竞态（6 只的 sessionFile 均为 undefined，`accumulatePendingEntries` 入口即返 error，无共享竞态面）。「机器负载拉长 pi 启动时间」是 carbon 事故证据链的推断（串行 36s 正常 / 并发 6 只全超时的对照），非探针实证——audit 探针 P-RC1（并发握手失败原因实锤）状态为 ⛔ 修复验收时执行，本设计 S1 场景兼作其执行载体。

版本归属（`git merge-base --is-ancestor` 验证）：carbon 装的 8.6.0（commit 22ec5e276）上，惰性回补 / no-progress watchdog / OR-3 等修复**全部不存在**；8.8.0+ 已有 30min no-progress 兜底（到期杀掉、结果按成功回收），故最新版症状从「永久挂」缓解为「白等 30 分钟」。**但正常路径（握手/回补）仍是一次性，失败仍走 30min 慢路径**——本设计要消灭的就是这个慢路径的存在意义。

### 设计目标（从使用者体验倒推）

- **G1**：并发派发（≥6 路）的 workflow / background subagent 在子进程完成后 **15 秒内**完成结果回收与通知，不依赖任何超时兜底。
- **G2**：递归编排（层主 + 后台后代）的 keep-alive 语义不回归——**证实**有后代的等待行为与现在完全一致（动态 watchdog / no-progress 复核 / steer 唤醒全部保留）。
- **G3**：「读不出」这一记账失败与「有活跃后代」这一合法等待在处置语义上分家：前者秒级收敛（杀，行为可见、成果不丢、外部回收通道对残余 keep-alive 保持有效），后者保留现有等待。
- **G4**：pi 通道原语（spawn 组装 / 行读取 / 命令写入 / id 路由 / 迟到帧处理 / kill 链 / get_state 问答）长期归一为单一实现，消除「同类修复只落一边」的双轨分叉。本次事故的核心机制（迟到 get_state response 被丢弃）**两侧各自独立存在**——Runtime 以 timedOutIds 丢弃、subagent-core 以 resolved 标志丢弃，处置语义相同、失败恢复能力不同（Runtime 可硬失败重来 safeDestroy，subagent-core 挂死）——任何一侧的单边修复都覆盖不了另一侧的形态，这是双轨的普适教训。

### In-scope / Out-of-scope

**In-scope**：subagent-core 的 get_state 握手迟到接受；sessionFile 扫描兜底；agent_end 处置默认翻转与无后代判据；pi 通道原语归一的**完整实施**（含 Runtime 侧切换为消费方——本设计交付全部拆分单元 U1-U7，无遗留项）。

**Out-of-scope**：

- 通知下游（notify ledger / 重投 / 幂等）的改造——已健壮，本设计不动（断链点清单见 §2.4，均在 `runSpawn` resolve 之后的下游）。
- worker 侧 OR-3 per-call timeout 的默认开启——维持 opt-in（超时默认原则：任务级正常路径禁止自带墙钟超时；本设计正是要把「需要靠超时兜底」的正常路径修掉）。
- sessions-index 治理、zsw 引擎侧同步（沿 audit 口径）。

---

## 2. 现状与问题分析

### 2.1 agent_end 处置现状（物理数据流）

```
pi 子进程 stdout: agent_end(willRetry=false)
  → routeAgentEnd（session-runner.ts:2189）
  → runAgentEndDisposition（:1917，异步化决策点）
      ① record.sessionFile 缺失且进程未 killed
         → backfillSessionFileViaGetState（:1953，单次 get_state，1s 预算，失败不重试）
      ② readActivePendingFromSessionFile(record.sessionFile)（:1937）
         ├─ count > 0 ──────────── → keepAliveOnAgentEnd（:1992）不杀
         │                            └ timer：maxTurns/env → 动态 watchdog(≥30min)
         │                                    裸缺省 → 30min no-progress（8.8.0+）
         │                                    显式 opt-out → 无 timer（无限）
         ├─ error（含 undefined）→ keepAliveOnAgentEnd 同上 ← 【误判入口】
         ├─ recentUnregister ──── → keepAliveForWakeupGrace（:2049）15s 后杀
         └─ count === 0 ────────── → kill → close → runSpawn 返回 → 通知链启动
```

keep-alive 的唯一合法理由：**递归编排的层主**——层主派了后台后代后结束本轮等唤醒，唤醒（steer/triggerTurn）要往层主活进程的 stdin 写命令，杀了进程唤醒链断（session-pending.ts 头注释：「若 runSpawn 在 agent_end 无条件 kill，进程被回收、steer 唤醒送不到，递归树断」）。判定要读 session 文件的原因：后代是层主**进程内**的 extension 自己 spawn 的，主进程内存无此账目，唯一全局记录是层主 session 文件里的 `pending:register − unregister` 差集。

### 2.2 握手现状（D1 的靶子）

- spawn 后无条件启动 `performGetStateHandshake`（get-state-handshake.ts:69）：3 次重试 × 2s 超时 + 2 × 0.5s 间隔 ≈ 7s 总预算。
- pi 侧 stdin reader 在**全部初始化完成后**才挂载（rpc-mode.ts 初始化尾部 `attachJsonlLineReader`）——窗口内命令在管道缓冲排队**不丢失**，pi 就绪后逐条应答。
- host 侧三次超时后 `resolved=true`；迟到的 response 经 stdout pump 到达 resolver，`if (resolved) return` 丢弃（:106）。`record.sessionFile` 从此永久缺失，**此后无任何机制再触发获取**（除 agent_end 时 1s 单次回补）。
- rpc mode 无 header 行（session-runner.ts:2173-2174），get_state 是唯一通道；pi 协议无「就绪主动上报」帧，且本项目不得修改 pi（上游约束）。

### 2.3 双轨分叉现状（D4 的靶子）

同一套「pi 进程通道」原语，Runtime 与 subagent-core 各实现一份，行为已分叉：

| 原语 | Runtime（packages/runtime/src/infra/pi/） | subagent-core（execution/engine/engines/pi/） | 分叉 |
|---|---|---|---|
| 事件帧空窗（spawn → listener 挂载间的事件帧） | early-frame-buffer：非 response 帧入 FIFO，首个 listener 注册时重放（rpc-client.ts:354/:601/:619） | stdout pump spawn 后即挂载，无空窗 | 机制差异（Runtime 有空窗问题、subagent-core 没有） |
| 迟到 response（已超时请求的应答） | timedOutIds：丢弃，不当 event 广播（rpc-client.ts:351/:594-599） | 握手 resolved 标志：`if (resolved) return` 丢弃（get-state-handshake.ts:106） | **同丢弃语义**——事故机制两侧同构；真差异在失败恢复（Runtime 超时可 safeDestroy 硬失败重来，session-lifecycle.ts:460；subagent-core 挂死） |
| LF 行读取器 | attachLfOnlyLineReader（:32，注释自认 pi 同款思路） | session-runner 手写 buffer split | 两份 |
| stdin 写入 + EPIPE | rpc-client sendCommand | stdin-writer.ts + EPIPE 计数 | 两份 |
| kill 升级链 | rpc-client 自带（stream error / timeout → 立即 SIGKILL，:532-540/:1066） | common/kill-chain.ts SIGTERM→30s→SIGKILL 升级（D3-① 只合一了 subagent-core 内部） | 两份且语义不同 |
| get_state 问答 | sendCommand('get_state')（session-lifecycle.ts:454 读回） | get-state-handshake.ts 自含提取/重试 | 两份 |

**双轨的真实成本不是代码重复，是修复不传播**：迟到 response 丢弃这一事故机制两侧同构，但两侧各自独立演化（Runtime 侧演化出「超时硬失败 + 会话重建」的失败恢复，subagent-core 侧没有），任何关键修复只落在自己那份实现上。subagent-core 侧的处境差异（任务级 vs 连接级）是真差异，但**原语层不存在真差异**——D4 归一时迟到处理与失败处理必须做成策略注入（两侧策略不同，见 D4），不能按单点机制理解。

### 2.4 通知下游健康度（本设计不动的部分）

`runSpawn` resolve 之后的完成通知链（one-shot / chatMode / sync 批三路径）经子代理逐环核查：ledger 写账 + 120s 重投 ×5 + 崩溃恢复重放齐备，已知断链点均有日志（"notification abandoned" / "notify ledger not bound"）。唯一无日志的吞点是 isIdle 放行门在显式 `idleTimeoutMs<=0` 下的形态（触发面窄，F-R2 注释已自证），不在本次故障路径上，登记为残留观察项不动。

### 2.5 根因归纳

audit §5 三条系统性裁决在本次事故的投影：

1. **乐观假设承重**（裁决 1）：sessionFile 回填是一次性操作，却被当作后续关键决策（agent_end 处置）的永久前提，决策点不做现场重获取（惰性回补只有 1s 单次）。
2. **保守 = 不限时**（裁决 2）：读不出 / 判不出时保守不杀是对的，但不区分「合法等待（有活跃后代）」与「记账失败（文件读不出）」，后者落入无上界等待。8.8.0 的 30min no-progress 是向「读不出终有一杀」的妥协，但量级错误（记账失败应秒级收敛，不是 30 分钟）。
3. **兜底 opt-in 默认关**（裁决 3）：OR-3 per-call timeout 缺省不启用——符合超时默认原则，本身不改；要改的是让兜底的触发率归零（正常路径修好后，audit S-A 验收判据「守卫降级条目计数 = 0」即此意）。

---

## 3. 解决方案

### 3.1 终态（使用者视角）

**场景 A：并发 workflow（原事故场景）**。用户在 taiji.app 或 pi CLI 跑一个 6 路并发 subagent 的 workflow。机器负载把每只 pi 冷启动拖到 10 秒。终态行为：6 只全部完成 → **每只在完成后数秒内**（最坏 15s）结果回发 worker、`parallel()` 返回、脚本推进——期间日志可见 `sessionFile backfilled via late get_state response`（迟到应答被收下）或 `sessionFile located via sessionDir scan`（扫描兜底命中），**没有** `keep-alive no-progress watchdog fired`。workflow 总时长回到任务本身耗时。

**场景 B：递归编排（防回归场景）**。层主 subagent 派 2 个后台后代后结束本轮。终态行为：层主 agent_end 时 pending 差集读出 count=2 → keep-alive 等待（与今天完全一致：动态 watchdog 保护、后代完成 steer 唤醒、心跳刷新）。后代全部完成后层主被唤醒、汇总、下一次 agent_end 判 count=0 → 正常杀 → 通知链启动。**G2 不回归**。

**场景 C：记账失败的残余形态（翻转后的兜底）**。极端情形：握手失败 + 迟到应答也异常（进程 rpc 半死）+ 扫描也找不到文件（如 sessionDir 被外力清空）。终态行为：agent_end 后进入 **15s 回补重试窗口**（get_state + 扫描交替），窗口耗尽仍无 sessionFile → 杀（SIGTERM→30s→SIGKILL）→ `runSpawn` 以成功语义返回（被信号终止视为正常完成，结果内容来自 stdout 事件累积，不依赖 sessionFile）→ 通知照发。误杀的层主（假阴性——真有后代但读不出）的后代终态，**如实描述**：后代进程不级联（SIGTERM 只杀层主），继续跑完自身任务，成果留在其 session 文件（session-reader 可查）；但层主死后其完成通知**投递目标已不存在**——挂账重投耗尽后 abandoned（有日志），不会自动回流；`/subagents list` 仅 record 层可见（manifest 磁盘重建），孤儿记账由根进程孤儿恢复终态化（仅记账不杀进程）；层主 session 文件在盘，resume 可续聊。**代价有界、行为可见（日志链完整）、成果不丢**——对比现状的「全链冻结 90 分钟」。

**场景 D：无后代能力的 subagent（新快路径）**。tools 白名单不含派生工具（subagents / workflow）**且不含 bash** 的分析型 agent（事故中的 dims-llm 即是；bash 经 base-tool-enhance 后台模式同样进 pending 记账，见 D3a 边界声明）：agent_end → **零判定直接杀** → 秒级回收。不进入任何等待分支。

### 3.2 方案对比

**方案 A：全靠超时兜底（OR-3 默认开启 + watchdog 全覆盖）**——把 per-call timeout 缺省改为开启，让 worker 侧每 agent() 调用有界。
- 长期合理性：**差**。违反超时默认原则（任务级正常路径禁止自带墙钟超时，AGENTS.md 架构约定 19 / audit 裁决 3 的正确半边）：兜底变成正常路径的一部分，timeoutMs 取值没有正确答案（长任务误杀 / 短任务浪费），且每个被超时打断的调用都要重试烧 token。
- 短期成本：低（改一个缺省值）。
- 风险：高——用 A 的话，§1 场景 A 变成「每次并发冷启动都吃满 timeoutMs 才回收」，事故从「挂死」变成「常态化慢 + 重试烧钱」。
- **否**。

**方案 B：kill-always 无差别 + resume-on-demand**——所有非 chatMode subagent 在 agent_end 一律杀，需要续聊/汇总时 resume 重开 session 文件。
- 长期合理性：**中**。大幅简化（三分支 / keep-alive watchdog / descendant sweep 大部分可删），进程零残留；resume 基建现成（`--session` 续写 + resumeColdRound 实践）。
- 短期成本：中——但递归编排的 steer 唤醒链断：层主死后无人收后代完成唤醒，需要新增「后代完成 → 冷 resume 层主 + 注入通知」的编排器，这是新机制新故障面。
- 风险：层主误杀后重派/重开要重载上下文（fork 的大 session 加载耗时 + LLM 重新进入状态），递归场景 token 与延迟双升；planning-agent 模板的 L1 closeout 语义（等唤醒后汇总）整体重写。
- **否（作为无差别方案）**——但其「默认杀、需要时 resume」的姿势被方案 C 吸收为翻转后的默认。

**方案 C（推荐）：分层翻转 + 双路获取 + 原语归一**——D1 迟到接受 + D2 扫描兜底把「读不出」触发率打到近零；D3 处置翻转让残余读不出秒级收敛；D4 蓝图消除双轨。
- 长期合理性：**好**。正常路径自愈（迟到应答必然会到、文件必然在盘上——两个「必然」都有机制保证），兜底回归兜底位（audit S-A「守卫降级计数 = 0」可验收）；keep-alive 的合法场景原样保留；通道原语单一权威后 pi 升级适配从两处变一处。
- 短期成本（四要素）：源码改动集中在 session-runner.ts / get-state-handshake.ts / session-pending.ts 周边约 4 个文件 + 新增 2 个（spawn-channel.ts / session-file-locator.ts）；**连带测试改写**：D3b 翻转 error 分支使锚定旧行为的既有用例红（keep-alive-no-progress.test.ts 的「unreadable → keep alive conservative」断言族、get-state-handshake.test.ts / fr4-get-state-handshake.test.ts、descendant-sweep 族、robustness 系列，约 5-6 个测试文件、以断言族计数十处），改写方式 = 断言从「保守不杀」翻转为「15s 窗口后杀」，随对应单元（U3/U4）同 commit 交付，验证方式 = 各子包 vitest；D4 第一阶段只动 subagent-core 侧。
- 风险：见 §3.4 竞态推演与 §3.3 D3 的误杀代价分析——均有界且可恢复。
- **采用**。

### 3.3 关键决策

#### D1：握手迟到接受（幂等 late-binding）

**选择**：`performGetStateHandshake` 的 response resolver 迟到路径不再丢弃——提取字段后幂等回填 `record.sessionFile`（复用 `finishHandshake` 的 `!record.sessionFile` 守卫语义）+ 写 alive marker；同时把 `sessionId` 补入 `handshakeResult`（对齐既有回填面）。close 时 `clearGetStateListeners` 统一清理的既有语义不变。

**被否**：①拉长握手窗口（7s→30s）——治标，慢机器仍可越过，且 spawn 串行链被拉长；②握手失败后周期重发 get_state——引入常驻 timer 与新生命周期管理，迟到接受已覆盖同一目标（答案必然会到，无需再问）。

**证据**：pi 侧 stdin 排队不丢（rpc-mode.ts attachJsonlLineReader 逐行处理存量命令）；P-T1 探针实证 idle 子进程 get_state 应答 0.3-0.4ms（预算 1s，2500 倍余量）——迟到应答的到达性由管道语义保证。**探针门**：⛔实施期补一个「spawn 后抑制首个 7s 窗口、放开后断言迟到应答被回填」的真实场景探针（对应 §4 S2）。

**效果边界（诚实声明）**：D1 只让 sessionFile「迟到可得」，不主动触发已做出的处置重判——迟到回填若发生在 agent_end 决策之后，需 D3 的重试窗口来消费（回填后下一轮重试直接命中已回填的 sessionFile）。D1 单独交付即已消除「永久缺失」，但「决策点拿不到」要 D1+D3 组合才完整。

#### D2：sessionDir 扫描兜底（第二路获取，两个接入点）

**选择**：新增纯函数 `locateSessionFileByScan(record, sessionDir, sinceMs)`：扫 `getSubagentSessionDir`（spawn 时已知）下 mtime > spawn 时刻的 JSONL，逐个读**文件内 identity entry**（子进程 session_start hook 必写，含 `PI_SUBAGENT_SELF_RECORD_ID` 派生的 record id）匹配 `record.id`，命中即返回路径。**接入两个点**：

1. **agent_end 决策回补链**：backfill 失败后调扫描；D3 重试窗口每轮交替尝试 get_state 与扫描。
2. **close 收尾反查链**：`backfillSessionFileByLookup` 的现有反查依赖 lookupId = `sessionHeader?.id ?? handshakeResult?.sessionId`（session-runner.ts:2591）——rpc mode 无 header 行且握手全失败时两者皆无，反查不可达。此形态在 lookupId 缺失时按 `record.id` 调扫描兜底。执行时机 = close 收尾链内、collectResult 之前的同步点（session-runner.ts:2812 附近），与既有反查同段衔接。这覆盖的是 **agent_end 链完全不经过的形态**：握手 7s 窗口内子进程被提前 kill（abort / spawn watchdog / dispose）→ 不产生 agent_end → D1 的「迟到应答必然会到」随管道关闭失效、D3b 窗口不挂——close 收尾是该形态唯一的获取机会，也正是 audit LC-4/PS-9 的原生修复面（finalize marker / alive marker / identity 写入依据 = record.sessionFile）。

**覆盖边界（诚实声明）**：接入点 2 的命中前提是子进程死前已写入 identity entry（session_start hook 已跑）。极早期 kill（extensions 加载完成前，hook 未跑、session 文件可能未创建）扫描返回 undefined——此时记账缺失是**正确语义**（进程从未开始工作，finalize 按 crashed 记账），不属于缺陷。

**被否**：①fs.watch 长驻观察者——扫描是决策点按需调用，无观察者生命周期负担；②按「mtime 最新」猜文件——并发 spawn 多只时必拿错，identity 精确匹配是安全前提；③alive marker 反查——marker 本身是握手成功才写的，与要兜底的失败同链。

**被否谱系**：①初版 IO 约束「读到 identity entry 即停 + 头部窗口读」——「identity 在文件头部区域」先验被同仓实测击穿（identity 实测靠尾部，subagents.ts:17-18，第 2 轮审查），废弃；②二版「尾行定长读」——被同一实测文件内的生产遥测击穿：64KB 尾窗覆盖率仅 93.4%（3203/3430，subagents.ts:233/:292），约 6.6% 真实文件的 identity 不在尾部窗口且 miss 集中在大任务 / fork 大文件形态（第 3 轮审查）——定长窗口在规模化下有结构性 miss 面，废弃，改整文件前向读 + 命中即停。

**证据**：pi session 文件在**首条 assistant 消息时落盘**（AGENTS.md 关键规则 6 登记的延迟写入行为）——agent_end 时刻子进程必有 assistant 输出（这就是完成的定义），故文件必然已在盘上；identity entry 由 session_start hook 必写（hook 已跑即已在文件内，**落点不固定**——见 IO 声明），扫描对「文件在盘 + identity 已写」的命中率结构性接近 100%。identity entry 机制现成（buildChildEnv 的 `PI_SUBAGENT_SELF_RECORD_ID` 注入 + 子进程 hook 写入，session-runner.ts:1783-1787 注释锚定）。Runtime 侧 restore 路径的 `scanSessions` 是同一模式在生产验证多年的先例（session-lifecycle.ts:767）。

**错误规格**：目录不存在 / 无匹配文件 / 文件读失败 → 返回 undefined（调用方继续走 D3 重试或最终翻转分支），warn 留痕含 record.id 与尝试的目录。匹配到多个（理论不可达——record.id 全局唯一）→ 取第一个 + warn。

**IO 量级声明**：mtime 过滤（statSync）把候选压到「spawn 后新建/修改」的文件，正常为个位数。**候选按 mtime 降序读**——agent_end / close 收尾时刻本 record 的文件是最新修改者，首候选即命中，消除并发形态下「兄弟文件全读 miss 链」（与被否②「按 mtime 猜文件」不冲突：彼处无内容匹配、此处只决定读取优先级，命中仍以 identity 精确匹配为准）。单文件 identity 读取 = **整文件前向读 + 行扫描命中即停**（对齐 session-pending 的值匹配快速路径：非 pending 行 includes 跳过 JSON.parse，identity 行同理）。**落点不固定的如实声明**：identity 通常靠尾部（session-reader 实测单例 71/71 行），但其后追加的对话 entry 可把它推出尾部窗口——生产遥测（subagents.ts:233/:292）显示 64KB 尾窗仅覆盖 93.4%（3203/3430），miss 集中在大任务 / fork 大文件形态；故任何定长窗口读都有规模化 miss 面，整文件读是一切落点模型下正确且期望成本最优的选择。同步读量级：mtime 降序后通常首候选命中（1 次全读）× 单文件全读（subagent session 通常 KB 到 MB 级；fork 大文件上限数十 MB ≈ 数十毫秒），正常形态毫秒级、最坏组合（降序不命中时退化为个位数候选 × 数十 MB × 15s 窗口 3 轮）为数百毫秒到秒级（冷态 / HDD）——该最坏组合要求「降序全部 miss ∧ 大文件」，被 D1/D2 命中率压到近零；close 收尾接入点 2 为一次性单轮（无窗口重试），排序后 ≈ 1 次命中读。若实施期探针（⛔）实测大文件形态占比显著，可在实施层改异步流式读（不改变本设计契约）。

#### D3：agent_end 处置默认翻转 + 无后代判据

**D3a 无后代判据（快路径）**：spawn 链路新增派生标志 `descendantCapable`——tools 白名单**未限制**（undefined / 空数组，pi 默认全工具，物理上具备派生能力，必须判 true）或白名单**含** pending 记账可达工具（`subagents`、`workflow`、`bash`）时为 true。**判据落点 = session-runner spawn 链内**（两条入口——subagents 工具路径与 workflow 路径——的 tools 汇合点：`agentTools = opts.agentConfig?.tools` 已由 SubagentService.resolveIdentity 注入解析，session-runner.ts:1847，execute/executeAndAwait 两派发路径共享），派生结果存 `state` 供 `runAgentEndDisposition` 入口消费：`descendantCapable === false` → 直接 final kill，零判定零等待。派生/记账工具清单常量在单点维护 + 守卫测试（枚举已知工具断言判据）。

**边界声明**：`bash` 进清单的原因——base-tool-enhance 的 bash 后台模式是一等记账面：`spawn-background.ts` 启动任务时 `pi.events.emit("pending:register", {type:"bash"})`（spawn-background.ts:107 + notify.ts:99-107），pending-notifications 监听落盘（index.ts:142），host 侧差集计数可见——「白名单含 bash 不含 subagents/workflow」的分析型 subagent 跑后台任务时现状走**合法 keep-alive**（等进程内 poller 检测任务完成 → sendMessage 唤醒），D3a 若将其判 false 会零判定误杀并杀掉进程内 poller，G2 实质回归。bash 理论上还可「间接」起 pi 进程（spawn 命令），此类进程不在差集记账的 *register−unregister* 生命周期内（无对应 unregister 写入者），但后台 bash 记账本身已把该面覆盖在 keep-alive 保护之下，无需单列。

**被否谱系**：①初版判据「白名单不含 subagents/workflow ⇒ false」——被反例击穿：bash 后台任务是差集记账一等面（上述链路），含 bash 白名单的分析型 agent 现状合法等待会被翻转为误杀（第 1 轮审查 MF1），已废弃；②初版判据落点 agent-opts-resolver——被层级事实击穿：其唯一生产调用方是 workflow 路径的 dispatchAgentCall（worker-message-pump.ts:746），subagents 工具路径不经过；且 tools 由 resolveIdentity 在其后注入（models/types.ts：agent ref 的 tools「Not handled by resolveAgentOpts」），该时刻判据无从计算——「分析型 agent 全覆盖」对半边入口失效（第 2 轮审查），落点改 session-runner 汇合点，已废弃。

**D3b error 分支翻转（慢路径→秒级）**：`descendantCapable === true` 且 sessionFile 读不出（error）时，不再进入无限 keep-alive，改为 **15s 回补重试窗口**（对齐既有 `WAKEUP_GRACE_MS` 量级）：窗口内每 5s 交替「get_state 单查 / D2 扫描」，任一命中即以真实 sessionFile 重新走三分支判定；窗口耗尽仍读不出 → **直接 kill**（SIGTERM→30s→SIGKILL）→ close → `runSpawn` 以成功语义返回（被信号终止视为正常完成，resolveRunOutcome 既有分支，:2668-2671）。

**被否谱系**：①读不出维持无限等（现状）——§2.5 裁决 2 已论证；②读不出立即杀（零宽限）——极端慢盘 / 高负载下 15s 内扫描可能合理地需要多轮，零宽限把误杀率推高，15s 是「误杀代价 ≈ 0 且总收敛 ≤15s」的平衡点（对齐 MF-3 对 WAKEUP_GRACE_MS 的量级论证）；③「窗口耗尽置 sweepDescendantsOnClose」——被结构性空转击穿：sweep 入口 `sweepDescendantsOfSession` 首行 `if (!rootSessionFile) return`（session-runner.ts:693），而窗口耗尽 = sessionFile 恒 undefined，sweep 必然零操作，置位是无效安慰剂（第 1 轮双审一致），已废弃——后代清理本就不靠 sweep（见误杀代价分析）。

**误杀代价分析（假阴性：真有后代但 15s 内读不出，四要素）**：

- **量级**：层主被杀 → 后代进程不级联（P-T2b NO-CASCADE：SIGTERM 不传播），继续跑完自身任务。孤儿后代此后**无回收通道**：host 已死（watchdog/心跳/kill 链都在 host 进程）、孤儿恢复只终态化记账不杀进程、alive marker 无人刷新——每误杀一只层主遗留 N 个 idle pi 进程（各自全量加载 extensions）的内存驻留，直至外力（重启 / 手工 kill）。
- **恢复路径**：后代成果**不丢**——留在其 session 文件，session-reader 可查；但其完成通知投递目标已死，挂账重投耗尽后 abandoned（有日志），不自动回流。层主 session 文件在盘，resume 可续聊。**限制如实声明**：若 resume 后以编排形态（runSpawn 复管该 session）续作，层主 agent_end 读到**脏差集**（孤儿后代的 register 永无 unregister——写者已死）→ keep-alive → 30min no-progress 复核 `hasLiveActiveDescendant` 按后代 pid 探活（session-runner.ts:1446-1462，readAliveMarker 不做新鲜度过滤）恒 true → 无限重挂。该形态是「误杀已发生 ∧ 孤儿永活 ∧ resume 编排续作」的三重叠加，D1/D2 将第一环打到近零后为极小概率残余；行为**可见**（keep-alive 日志 + marker 心跳）且**外部可回收**（killChildWithEscalation / abort / dispose / 外层墙钟对 keep-alive 全部有效，hasLiveActiveDescendant 注释自证），不静默冻结——登记为已知残余风险，S5 增补推演验收。
- **重审触发条件**：若生产日志出现「15s 窗口耗尽」条目（S7 统计非零），或误杀后孤儿进程驻留被用户报告，重开本决策权衡「差集带后代存活语义」的复合判据改造。
- **显式判定**：接受上述残余风险，理由：对照现状误等代价（全链冻结、外层墙钟烧光、不可恢复），翻转后代价有界、可见、成果不丢，方向严格改善。

此代价已在 §3.1 场景 C 向使用者声明。「后代进程在 host 死后继续存活跑完」的行为依据是 P-T2b 探针（SIGTERM 不级联），但 P-T2b 验证的是 host 主动 kill 形态，「host 死后 stdout 读端关闭 → 后代 EPIPE 行为」无探针——列入 ⛔ 实施期探针。

**与既有 timer 的关系**：翻转分支的 15s 窗口是 error 分支**专属**新 timer（收尾统一 clearTimeout，对齐 state.watchdog 清理点）；`count > 0`（证实有后代）分支的 keep-alive 全部原样保留——**翻转只动「读不出」，不动「证实有」**。30min no-progress watchdog 保留为最后兜底（覆盖「证实有后代但后代集体挂死」的既有场景，与本设计正交）。

#### D4：pi 通道原语归一（完整实施，分三批交付、无遗留）

**选择**：共享层归宿 subagent-core `execution/engine/engines/pi/` 下新模块（暂名 `spawn-channel.ts`），收敛七件原语：invocation 组装 / LF 行读取 / stdin 命令写入 + EPIPE / response id 路由 / 迟到帧策略位（**两个独立机制点**，见下）/ kill 升级链 / get_state 客户端。机制一份，**策略各持**——归一面的差异清单分三类（语义分叉 / 参数面 / 单侧附加面），「行为不变替换」按下述逐项可对照（S8 验收）：

**语义分叉（四维策略注入）**：

1. **事件帧空窗策略**：Runtime 注入「非 response 帧缓冲、首个 listener 注册时重放」（其有空窗问题）；subagent-core 注入「直通」（stdout pump spawn 后即挂载，无空窗）。
2. **迟到 response 处置策略**：Runtime 注入「丢弃（timedOutIds 语义，不当 event 广播）」——行为不变；subagent-core 注入「幂等回填（D1 迟到接受）」。注意两侧现状对迟到 response **同为丢弃**，D1 只翻转 subagent-core 侧；Runtime 侧保持丢弃是行为不变替换的一部分。
3. **失败处理策略**：Runtime 注入「超时/错误 → safeDestroy 硬失败 + 会话重建」；subagent-core 注入「容错 + 决策点降级路径」。
4. **kill 语义策略**：共享默认 = SIGTERM→30s→SIGKILL 升级链；Runtime 注入「即时 SIGKILL」保留其 stream error / timeout 加速死亡形态（rpc-client.ts:532-540/:1066）——合一时两侧 kill 语义均不回退。

**参数面（显式参数化，两侧各持现值 = 行为不变）**：get_state 客户端的超时预算与重试节奏（Runtime `sendCommand` per-request timeout 含 ≤0 不限时逃生门 + timedOutIds 5s TTL，rpc-client.ts:340-351；subagent-core 3×2s+0.5s 握手 / 1s 单查）、buffer 上限（Runtime 早期帧缓冲 EARLY_FRAME_BUFFER_MAX 同类）——「机制一份」若不把节奏显式参数化，会把某一侧的节奏焊死使另一侧行为漂移；归一后两侧以参数注入保持现值，不做统一取值（统一取值是行为变更，超出本设计范围）。

**单侧附加面（声明归宿，防 U7b 静默丢失）**：①Runtime 的 stdout JSONL tee 落盘（`piSessionLog`，rpc-client.ts:392-393）——AGENTS.md 架构约定的「pi 卡死时唯一证据」通道，挂在行读取路径上但不属七件原语语义——归宿：随行读取原语暴露挂接 hook，Runtime 切换时把 tee 作为 hook 消费方接回，S8 逐项对照含 tee 文件持续落盘断言；②subagent-core 的 EPIPE 计数——归失败处理策略，计数状态随策略注入保留。

依赖方向已验证单向可行：subagent-core 零 runtime 依赖（package.json 实锚）；runtime 侧前置**现状已就绪**——workspace 依赖（`@zhushanwen/subagent-core: workspace:*`）与 tsup `noExternal`（tsup.config.ts:54）均已存在，批 3 只需消费切换 + 策略接线，反向不可行。

**被否**：①共享层放 runtime——subagent-core 要跑在任意 pi 环境（用户本机 / carbon 服务器），够不着 runtime；②抽全新 npm 包——多一个发布单元，收益不抵（subagent-core 本就是两边可依赖的叶子）。

**交付批次（全部在本设计范围内，分批仅为控制单 PR 验收面）**：

- 批 1 = D1 落地即共享语义第一块（U1，与 D4 解耦先行）；
- 批 2 = 原语合并进 subagent-core 的 `spawn-channel.ts`（U7a）；
- 批 3 = Runtime 切换为消费方 + 四维策略接线（U7b，行为不变替换，靠 runtime 现有测试链守卫 + 打包三阶段验收）。

### 3.4 竞态推演（审查重点预答）

| # | 竞态场景 | 推演 | 结论 |
|---|---|---|---|
| 1 | 迟到回填 vs close 收尾竞态：close handler 已跑完（record 已终态、`backfillSessionFileByLookup` 已反查），迟到 response 才到达 | 回填有 `!record.sessionFile` 守卫；record 已终态后写入 sessionFile 字段无消费者（finalize 已读过）；close 时 `clearGetStateListeners` 已把 resolver 清掉——close 之后的迟到 response 到不了 resolver | 安全 |
| 2 | D3 重试窗口内进程被外部 kill（abort / dispose） | 重试 timer fire 回调先查存活（`child.exitCode/signalCode` 双 null，对齐 A1-3 判据），已死则直接返回交由 close 收尾 | 安全（复用既有判据） |
| 3 | 扫描拿错文件（并发 6 只同时落盘） | identity entry 的 record.id 全局唯一精确匹配；文件只读不写 | 安全 |
| 4 | D2 扫描读到半行 JSONL（pi appendFileSync 进行中） | identity entry 是完整行；读到截断行按坏行跳过（对齐 session-pending 坏行容忍语义），下一轮重试窗口再扫 | 安全 |
| 5 | D3b 窗口内迟到回填与重试判定交错（回填发生在两轮重试之间） | 每轮重试先查 `record.sessionFile` 是否已被 D1 回填，已回填直接走三分支，不重复获取 | 安全 |
| 6 | 翻转 kill 与后代完成 steer 唤醒交错（15s 窗口最后一刻后代 unregister 到达） | 误杀形态已在 D3b 代价分析按四要素覆盖（成果留 session 文件可查、通知 abandoned 有日志、外部回收通道有效）；发生率 = 「后代恰在窗口尾完成 ∧ 三路获取全失败」的联合概率，D1/D2 修复后接近零 | 有界可接受 |
| 7 | D3a 判据时效：子进程运行中 tools 变化 | tools 在 spawn argv 注入后进程内固定，无运行时变更通道 | 静态安全 |
| 8 | 同 record 多次 agent_end（层主被唤醒后多轮汇总）触发多个重试窗口 | 窗口 timer 挂 `state`（per-run 单例），重复 arm 先清旧（对齐 keepAliveNoProgressTimer 的 arm 幂等模式） | 安全（chatMode 在 routeAgentEnd 提前返回、不进处置链，不构成此场景；多次 agent_end 来自递归层主被后代唤醒后的多轮） |

### 3.5 错误规格总表

| 路径 | 错误形态 | 处置 | 恢复指引（日志文案内嵌） |
|---|---|---|---|
| D1 迟到接受 | 迟到 response 字段缺失/畸形 | 提取不到就跳过，不留痕噪音 | —（正常路径无错误面） |
| D2 扫描 | 目录不存在 / 无匹配 / 读失败 | 返回 undefined + warn（含 record.id、目录、原因） | 「sessionDir scan found no match for <id>; will retry in window / fall back to disposition flip」 |
| D2 扫描（close 收尾形态） | 提前 kill + 握手全失败，极早期 kill 下 identity entry 未写 | 返回 undefined，finalize 按 crashed 记账（正确语义，见 D2 覆盖边界） | 「sessionFile unobtainable (process killed before handshake settled); record finalized as crashed; results were never produced」 |
| D3b 窗口耗尽 | 三路（迟到/回补/扫描）全失败 | kill（SIGTERM 升级链）+ runSpawn 成功返回 | warn「sessionFile unobtainable after 15s recovery window (handshake suppressed? sessionDir missing?); process terminated, result recovered from stdout events; descendants (if any) remain on disk, queryable via session reader」 |
| D3b 误杀（假阴性） | 后代完成时父已死 | 后代跑完，成果留其 session 文件；完成通知挂账重投耗尽后 abandoned（有日志）；孤儿记账由根进程孤儿恢复终态化 | session-reader 查后代 session 文件取成果；`/subagents list` 看 record 层状态；resume 层主续聊（注意：编排形态续作遇脏差集会 keep-alive 等待，kill/abort 可回收，见 D3b 代价分析） |
| D3a 判据 | 派生/记账工具清单漂移（未来新增 spawn 类工具或后台记账面忘登记） | 清单常量在 session-runner 单点维护 + 注释标注「新增派生工具/后台记账工具必须同步」 | 清单测试守卫（枚举已知派生工具 + bash 后台记账面断言判据） |

---

## 4. 验收

> 全部真实场景（真实 pi 子进程、真实 LLM 或最小 prompt 回环、真实文件系统），单测仅作回归辅助不计入验收。每个场景标注回溯目标。

| # | 场景 | 步骤 | 通过标准 | 回溯 |
|---|---|---|---|---|
| S1 | 并发冷启动压力（原事故复现） | 本地起 6 路并发 spawn 的最小 workflow（每只 subagent 一个小 prompt），同时 CPU 压测制造负载（`yes > /dev/null &` × N）使 pi 启动 >7s；若无真实慢启动则用 wrapper 抑制首个窗口的 get_state response 行（`node filter.js -- pi --mode rpc` 过滤器，对齐 audit S-B 注入先例） | 6 只全部在**完成后 15s 内**完成结果回收（workflow state 的 calls 全部 done、脚本推进）；日志出现迟到接受或扫描兜底的回填痕迹；**零** `keep-alive no-progress watchdog fired`、零 `sessionFile unobtainable` | G1 |
| S2 | 迟到接受单元真实场景 | S1 的 wrapper 改为「前 10s 丢弃 get_state response、之后透传」 | 10s 后日志出现 `backfilled via late get_state response`；该 subagent 的 agent_end 处置走真实三分支（非翻转分支） | G1 / D1 |
| S3 | 递归编排防回归 | 真实跑一个层主 + 2 后台后代的最小编排（planning-agent 模板或 cw wave 单元），层主正常等待-唤醒-汇总 | 层主 keep-alive 行为与现状一致：等待期 alive marker 心跳持续、后代完成后层主被唤醒、最终 agent_end 正常杀；全程无 15s 窗口触发（层主 sessionFile 三路获取之一在窗口前已命中——层主是长驻早期握手成功形态） | G2 / D3 只动读不出 |
| S4 | 无后代快路径 | 真实 spawn 两个 subagent：① tools 白名单不含派生工具与 bash（如 `--tools read,grep`）；② 白名单含 bash（如 `--tools read,grep,bash`）且派一个真实 background bash 任务，正常完成 | ① agent_end 后**立即** kill（无任何等待 timer 挂载，日志可断言），进程零残留（`ps` 无孤儿）；② 不走快路径（descendantCapable=true），background 任务记账面使差集 count>0 → keep-alive 等待与现状一致，任务完成后被唤醒正常回收——防 G2 回归 | G1 / D3a |
| S5 | 翻转兜底 + 误杀恢复（含 resume 续后处置） | 注入三路全失败（wrapper 持续丢 get_state response + 测试钩子 env 把扫描目标目录重定向到空目录；钩子落点 = locateSessionFileByScan 的 sessionDir 入参来源，U2 实现时留测试钩子，生产不设 env 恒 no-op，测试空目录用 mkdtemp 自建对齐测试禁触真实数据目录红线）；层主已派一个真实后台后代 | 15s 窗口日志链完整（重试 ×3 → 耗尽 → 终止）；层主被杀但 `runSpawn` 成功返回、结果内容完整（来自 stdout 累积）；后代跑完且成果可经 session-reader 从其 session 文件读出（通知 abandoned 有日志）；**续后处置推演**：resume 层主并以编排形态续作 → agent_end 读脏差集 → keep-alive 挂载（行为符合 D3b 代价分析声明的残余风险形态）→ abort/kill 外部回收通道仍可终止层主（不静默冻结） | G3 / D3b |
| S6 | 通知端到端 | 真实 pi CLI 会话起一个 background subagent（正常路径），等完成 | 主 agent 在完成后数秒内收到含 `session_read {...}` 指针行的完成通知并触发新轮 | G1 |
| S7 | 守卫降级归零（audit S-A 对齐） | S1 场景连续跑 20 轮，统计 30min no-progress watchdog 与 15s 翻转窗口的触发次数 | no-progress 触发 = 0；翻转窗口触发 = 0（三路获取应全部命中）；若翻转窗口非零，日志归因并回写本表 | G1 / 兜底归位 |
| S8 | Runtime 通道切换回归（U7b 行为不变验证） | 真实 `pnpm dev` 起 taiji.app：新建会话 → 发消息收流式回复 → 切换/恢复会话 → 关闭应用；再跑 `bash scripts/validate-runtime-bundle.sh` + runtime 包全量测试 | 全程主 agent 会话行为与切换前逐项一致（消息流 / 会话切换 / session 路径显示正常）；stdout tee 落盘（`pi-<date>-<sessionId>.jsonl`）在切换后仍持续写入（诊断证据通道不丢）；validate-runtime-bundle 与 runtime 测试全绿；早期帧缓冲语义不回归（spawn 后立即有输出帧的场景无丢帧） | G4 / D4 |
| S9 | 提前 kill 形态（D2 接入点 2） | 前者：wrapper 持续抑制 get_state response（sessionFile 缺失）+ **轮询子进程 session 文件出现 identity entry**（session_start hook 已跑；轮询上界 30s——覆盖慢冷启动 + 延迟落盘裕量，超时 = 照常 abort、预期 crashed-finalize，并入对照组流）→ abort 杀进程（此时 sessionFile 缺失 ∧ lookupId 缺失 = 扫描分支可达且 identity 已在盘）。对照组：spawn 后立即 abort（extensions 加载完成前，hook 未跑、session 文件未创建） | 前者：close 收尾链扫描兜底命中，record.sessionFile 回填，finalize 记账完整（marker 落盘）；后者：扫描返回 undefined，finalize 按 crashed 记账（正确语义），日志含 unobtainable warn，无异常抛出 | G3 / D2 |

**验收前置**：carbon 生产换 8.9.0+（版本对齐是独立前置，用户已知，不属本设计交付物）。

---

## 5. 下一层拆分

| 单元 | 内容 | 文件改动地图 | justification | 验收映射 |
|---|---|---|---|---|
| U1 | D1 迟到接受 | `get-state-handshake.ts`（resolver 迟到路径）、`session-runner.ts`（finishHandshake 回填面复用） | 最小改动最大收益；独立于其余单元可先行交付 | S2 |
| U2 | D2 扫描兜底（两个接入点） | 新 `session-file-locator.ts`（locateSessionFileByScan 纯函数 + identity 整文件前向读/行扫描命中即停 + 测试钩子 env）、`session-runner.ts`（agent_end 决策点接入 + close 收尾 collectResult 前同步点 `backfillSessionFileByLookup` lookupId 缺失分支接入） | 纯函数 + 独立文件，可单独单测后接入；接入点 2 补齐 LC-4/PS-9 修复面 | S1/S5/S9 |
| U3 | D3a 判据 | `session-runner.ts`（descendantCapable 派生 @ tools 汇合点 agentTools 注入处 + 快路径分支 + 派生/记账工具清单常量单点：subagents/workflow/bash + tools-undefined 语义）、`types.ts`（state 字段）、清单守卫测试、既有测试改写（快路径使部分「保守等待」断言族需按新判据重申） | 消灭最大悬挂面（分析型 agent 全覆盖——两条入口汇合点统一派生），零等待零判定 | S4 |
| U4 | D3b 翻转 + 重试窗口 | `session-runner.ts`（runAgentEndDisposition 改造 + 窗口 timer 生命周期）、竞态 #2/#5/#8 守卫、**既有测试改写**（keep-alive-no-progress.test.ts「unreadable → keep alive conservative」断言族翻转、descendant-sweep 族、robustness 系列） | U1/U2 之后实施（窗口消费它们的产物） | S1/S5 |
| U5 | 可观测性 | 上述各路径的 warn/debug 文案 + `docs/troubleshooting.md` 排查词条（三特征串：迟到回填 / 扫描兜底 / 窗口耗尽） | 排障先于事故；与既有 LC-9 可见性原则对齐 | 全场景 |
| U6 | 文档回写 | `subagent-core-unbounded-wait-audit.md`（D2 两接入点落地后关闭「LC-4/PS-9 修复面」备注；登记翻转决策为新条目）、变更历史 | C-proc-10 设计文档同步纪律 | — |
| U7a | D4 批 2：通道原语合并 | 新 `spawn-channel.ts`（七件原语 + 四维策略位 + 参数面/单侧附加面清单：get_state 超时预算/重试节奏/TTL/buffer 上限显式参数、tee hook + EPIPE 计数归宿）、`session-runner.ts` / `get-state-handshake.ts` / `stdin-writer.ts` 改为消费共享层 | 机制一份消除双轨；先在 subagent-core 内部切换（行为等价，现有测试守卫） | S1-S6 回归 |
| U7b | D4 批 3：Runtime 切换 + 策略接线 | **subagent-core 侧**：`package.json` exports 面（spawn-channel 进主 barrel 或新增 `./spawn-channel` 受控子入口，exports + publishConfig 双面，semver 契约面改动，changeset minor）+ dist 构建验证；**runtime 侧**：`rpc-client.ts` 消费切换 + 四维策略注入 + 参数现值注入 + tee 落盘 hook 消费接回（piSessionLog 不丢）+ EPIPE 计数随失败策略保留（workspace 依赖与 tsup noExternal **现状已就绪**，仅需确认不回退） | 完成归一闭环（G4）；行为不变替换按 D4 三类清单逐项可对照，runtime 独立验收链 | S8 |

**实施顺序**：U1 → U2 → U3 → U4 → U5/U6 → U7a → U7b（U3 可与 U1/U2 并行，无依赖；U7a 依赖 U1 的迟到语义落地，U7b 依赖 U7a）。每个单元独立 commit 独立验证（对齐「打包子系统逐个 commit 逐个验证」纪律）。**全部单元均在本设计交付范围内，无遗留项。**

**待验证检查点（诚实标注）**：

- ⛔ S1 的 wrapper 注入可行性（stdout 行过滤器对 get_state response 的精确匹配）——实施期先跑注入探针再写正式场景（audit S-B 先例同款流程）。
- ⛔ pi 冷启动在本机负载下的真实延迟分布——决定 S1 是否需要 wrapper 辅助（不依赖结论，D1/D2 有效性不受影响，仅影响复现手段）。
- ⛔ D3a 派生/记账工具清单的完备性核对（`subagents`/`workflow`/`bash` 之外是否还有 spawn 类工具或会 emit `pending:register` 的后台记账面）——实施期 grep tools 注册面 + pending:register emit 面核对。
- ⛔ identity entry 落点分布实测（观察时机钉死 **agent_end 终态**——非任意时刻采样，且样本须含 fork 大文件形态）：验证整文件读的量级假设（subagent session 体积分布），若大文件形态占比显著则在实施层改异步流式读（不改变本设计契约，见 IO 声明）。
- ⛔ 误杀形态下「host 死后 stdout 读端关闭 → 后代 EPIPE 行为」探针（P-T2b 验证的是 host 主动 kill 的 SIGTERM 不级联，非此形态）——实施期与 S5 一并验证。

---

## 附：术语表

| 术语 | 定义（首次出现 §） |
|---|---|
| 握手 | spawn 后 host 向子进程发 `get_state` 问答获取 sessionFile 路径的一次交互（§1） |
| sessionFile | subagent 的 pi session JSONL 文件（对话 + pending 记账载体），路径由 pi 子进程自定（§1） |
| 处置三分支 | agent_end 时 host 的 kill/keep-alive 决策：有后代等 / 无后代杀 / 读不出保守（§2.1） |
| 迟到接受 | 握手窗口关闭后到达的 get_state 应答仍被采纳回填（D1） |
| 扫描兜底 | 不经子进程、直接扫 sessionDir 按 identity entry 匹配定位 sessionFile（D2） |
| 处置翻转 | 「读不出」分支的默认姿势从无限保守等待改为短窗口重试后回收（D3b） |
| 无后代判据 | tools 未限制或白名单含派生工具（subagents/workflow）或 bash（后台记账面）⇒ 保持三分支；仅「白名单非空且三者均不含」才走零判定快路径（D3a） |
| 通道原语 | 与 pi 子进程通信的底层机制集合：spawn 组装/行读取/命令写入/id 路由/迟到帧/kill 链/get_state（§2.3） |

---

## 变更历史

| 日期 | 事件 |
|------|------|
| 2026-09-10 | 实施完成：U1-U7b 对应实施单元 u1-acquire / u2-descendant / u3-flip / u4-spawn-channel / u5-runtime-switch 全部 committed（状态与证据见 impl-plan §6），u6-obs-docs 本次回写收口（troubleshooting 词条 + audit 回写 + 本节）。Gate B 真实场景验收（S1-S9）与 ⛔ 探针五条待执行，完成度以 impl-plan §6 状态表为准 |

### 实施期偏差登记（文档与实现的最终对齐记录）

以下为实施与本文正文的差异，如实登记（含未切换项及理由）；正文保留原文不改写——本节即差异的权威登记处。

**D3a 判据落点**：`descendantCapable` 在 `session-runner.ts` 内 tools 汇合点就地派生并存入 `SpawnRunState`，`models/types.ts` 未动——`SpawnRunState` 实际定义在 session-runner.ts，§3.3 D3a / §5 U3 写的「types.ts（state 字段）」按实际类型归属就地吸收，无跨文件新字段。

**D3b 窗口三处细化**：

1. **绝对收敛上界 16s**：= 15s 窗口 + 入口惰性回补段 1s（agent_end 入口先做一次 get_state 单查 `backfillSessionFileViaGetState`，失败才进窗口）。§3.3 D3b「总收敛 ≤15s」的口径按「窗口 arm 起算 15s、入口段另计 1s」实现；
2. **窗口重判仍 error → tick 续窗不重置**：窗口内每轮 tick 重判若仍读不出（unreadable），不清已排定的下一轮 timer、不重置窗口——保证单次 arm 的窗口内耗尽点确定（= arm + 15s）。**多轮 agent_end 重入的如实表述**：递归层主被唤醒后多轮 agent_end 重复进入 error 分支时，每次按幂等 arm 语义 disarm 旧窗口 + 重挂重计（测试锚定的预期行为，竞态 #8 守卫）——重置仅由真实新事件触发，活动停止后窗口必然正常耗尽，不构成退化回无限等待（「不重置」的原始声称仅覆盖 tick 重判路径，首次登记时表述过宽，2026-09-10 一致性审查修正）；
3. **轮节奏固定 5s**（`DISPOSITION_RETRY_STEP_MS`）：不被轮内获取耗时顺延，保证耗尽点的墙钟确定性。

**D2 多匹配**：实现为「全候选收集 + 按 mtime 降序取最新 + warn」（§3.3 D2「匹配多个取第一个 + warn」的等价实现——候选按 mtime 降序读，最新修改者即首候选；warn 文案含命中数与所选路径）。

**D4 / u5 七件原语切换盘点（如实，六件未切换及理由）**：实际切换仅 **LF 行读取**一件（runtime `rpc-client.ts` 行读取改经 spawn-channel 消费；tee 经 `onStdoutLine` hook 接回，piSessionLog 落盘不丢——S8 断言点已就位，待 Gate B 执行）。其余六件按 u4/u5 盘点保持现状，理由：

- **invocation 组装**：两侧身份域不同轨（Runtime 连接级 session 域 / subagent-core record 域），合并无净收益；
- **stdin 写入**：Runtime 的 randomUUID 命令 id 是 Runtime 行为锚，替换即行为变更（违反行为不变替换边界）；
- **id 路由**：Runtime pending 形状带 rejectAll 遍历（abort 广播语义），subagent-core 为单请求 resolver 形状——机制同构但状态面不同；
- **kill 链**：Runtime 即时 SIGKILL（stream error/timeout 加速死亡）以「语义不回退」为前提保留；策略注入后净收益不抵接线成本；
- **get_state 客户端**：Runtime 硬失败 safeDestroy 策略与既有会话重建路径深度耦合，抽换风险大于双份成本；
- **迟到帧策略**：两侧以既有代码路径表达（Runtime timedOutIds 丢弃 / subagent-core D1 迟到接受），机制点已在 spawn-channel 登记为策略位。

策略接口最终形态 = 类型契约（`SpawnChannelPolicies`）+ `SUBAGENT_CORE_SPAWN_POLICIES` 默认值登记（u5 注入对照基准），非运行时注入对象——六件不切则注入面收缩为类型级契约与默认值登记。spawn-channel 以受控子入口 `./spawn-channel` 发布（exports + publishConfig 双面，changeset minor：`.changeset/subagent-core-spawn-channel-subpath-export.md`）。

**既有测试改写**：`run-spawn-edges.test.ts` 断言族按翻转后语义改写（无 skip）；新增 disposition-retry-window（窗口轮序 / 耗尽 / 竞态守卫）、agent-end-descendant-fast-path（快路径判据守卫）、spawn-channel 形状测试（四维策略默认值锚定）等。§3.2 预告的「约 5-6 个测试文件」实际集中度更高（断言族多数落在 run-spawn-edges 一处）。

**待办清理项（登记，不阻塞本次收口）**：

1. runtime `rpc-client.ts` 的 `attachLfOnlyLineReader` deprecated 测试锚（30 行）——行读取已切 spawn-channel，旧函数保留为测试锚，待后续迁移删除；
2. `eslint.config.mjs` session-runner.ts 双 max-lines 规则并存——复杂度债务豁免组的 `'off'`（flat config 前段）与单列提额的 `'warn'@1400`（后段，实际生效）待收敛为一条。
