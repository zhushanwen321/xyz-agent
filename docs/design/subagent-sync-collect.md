# subagent 同步收集（sync collect）设计

> **层声明**：本文是**技术方案层**设计——当前层 = 需求与现状分析 → 技术方案选型；下一层产物 = 可实现的接口/数据模型/错误规格 + 拆分清单（交付给 `subagent-sync-collect.impl-plan.md`）。不跨层到具体测试代码。

**一句话结论**：`subagent start` 新增 `collect` 参数（`async`=现状默认 / `sync`=攒批单通知），sync 模式在执行层用「批缓冲 + 全员终态触发一次批量通知」实现，批内容带 per-item 预算、超预算走 `session_read` 新 `result` action 取回全文；账本 at-least-once 与崩溃恢复语义完整延续。

## 1. 背景目标

**SCQA**：

- **S（情境）**：`subagent` 工具支持一轮消息里派发 N 个后台 one-shot subagent（并发池默认 6，pi/zcode 双引擎共用），完成时逐条以 `triggerTurn` steer 通知唤醒主 agent。
- **C（冲突）**：subagent 耗时天然错峰（如 1min / 5min / 12min）。主 agent 派发完通常 STOP 等待；每条完成通知到达时主 agent 空闲，立即投递 → **N 个 subagent = N 次独立唤醒 = N 个完整 turn**，每次唤醒都向模型重发全量上下文，而其中 N-1 次的回复只是"收到，继续等"。
- **Q（问题）**：如何让派发方在派发时声明**通知粒度**——"这批结果等全齐了再一次告诉我"？
- **A（答案）**：把「执行并行度」与「通知粒度」解耦——`start` 增加 `collect` 参数；sync 模式下完成通知被扣留缓冲，全员终态后合并为**单条**批量通知；批内结果按预算截断，超预算提供 `session_read action:result` 直读 subagent 最终结果的取回通道。

### 1.1 系统是什么（受众背景补足）

subagent-workflow extension（`extensions/universal/subagent-workflow/` + 核心包 `packages/subagent-core/`）在 pi 之上自实现了全部 subagent 能力（pi 本体无 subagent API，实装 grep 证实）：

```
subagent 工具 (interface/subagent-tool.ts)
  → startHandler (packages/subagent-core/src/execution/subagent-actions-core.ts) → SubagentService.execute
    → 引擎适配 (engine/pi spawn 子进程 | engine/zcode appserver)
    → 并发池 DefaultConcurrencyPool (maxConcurrent=6，双引擎共用)
  完成时：
    → notifyComplete → notifier.notify(record)          [结果全文，不截断]
      → notify-ledger 写账 → settled 边沿投递            [at-least-once]
        → pi.sendMessage({customType:"subagent-bg-notify"}, {triggerTurn:true})
          → 主 agent steer 队列 → 新 turn
```

关键现状语义（后文 §2 展开）：one-shot 完成通知的 LLM 可见文案为 `Subagent "{agent}" ({id}) completed. Result:\n{result 全文}`；账本投递发生在主 agent settled 边沿（+120s 看门狗 + isIdle 复查），busy 期间到达的多条会自然合批。

### 1.2 设计目标（使用者体验倒推）

| # | 目标 | 使用者可感知形态 |
|---|------|----------------|
| G1 | 一轮派 N 个独立 one-shot 且结果需合并综合时，**一次派发一次回收** | 主 agent 派 4 个 explorer 后 STOP，只被唤醒 1 次，通知含 4 段结果 |
| G2 | 结果总量大时不撑爆单轮注入，且有**低成本取回通道** | 超预算条目截断 + 指针行；`session_read action:"result"` 一参数取全文 |
| G3 | **异步现状零变化** | 默认 `collect:"async"`；现有单条通知文案逐字节不变（G4 golden 锁） |
| G4 | 批语义在崩溃/重启下**不丢不重** | 延续 C-ext-19 确认式送达：批通知持久账本 + 幂等键 + 重启重放 |
| G5 | pi / zcode 双引擎行为一致 | collect 路由在引擎无关的 service 层 |

**In scope**：`start`（one-shot background）的 collect 参数；批通知格式与预算；`session_read` result action；config 默认值；崩溃恢复。

**Out of scope（v1 明确不做，见 §3.3 D8）**：conversation 模式（`conversation:true`）的 sync；`message` 轮次批收；workflow 域（map-reduce 已有自己的聚合）改造；fail-fast（成员失败立即通知）选项；批级超时；GUI 专项改造（复用现有 batch 渲染，仅核对）。

## 2. 现状与问题分析

**首句结论**：现状的通知粒度是「每 subagent 一条、60s 机会性合批」——错峰完成且主 agent 空闲时必然逐条唤醒，根因是派发 API 没有表达通知粒度的参数。

### 2.1 通知投递的真实时序（取自代码，不编造）

一条完成通知的生命周期（`packages/subagent-core/src/execution/notifier.ts` + `notify-ledger.ts` + `packages/session-delivery/src/delivery.ts`）：

1. subagent 终态 → `notifyComplete` → `notifier.notify(record)`；LLM 文案由 `buildLlmContent` 生成（`notifier.ts:113-157`）：
   ```
   Subagent "explore-subagent-dispatch" (bg-f6f731) completed. Result:
   {result 全文——无任何长度限制}
   ```
2. 生产路径（账本装配）：写账先于一切投递 → courier 在 **settled 边沿**（主 agent 空闲瞬间）+ isIdle 二次复查 + 120s 看门狗投递；busy 期间积压的多条在投递时合并为单条（content 以 `\n\n---\n\n` join，details 为 `{batch:true, items:[...]}`，`notify-ledger.ts mergeItems`）。
3. `pi.sendMessage(..., {triggerTurn:true})` 进入主 agent steer 队列。pi 0.84.4 实装（dist bundle `PendingMessageQueue`）：steering 默认 **one-at-a-time**——队列里多条消息每 turn 只 drain 一条。

**已经存在的攒批**（两层，均为机会性）：

- busy 期间到达的多条 → settled 边沿合并成一条 ✓
- 内核降级路径的 60s 滑动窗口（`mergeWindowMs:60_000`）✓

**覆盖不到的场景**（本设计要解决的）：主 agent **空闲**时错峰到达——第 1 条到达即投递即唤醒；主 agent 处理完这条再 settle，第 2 条又到达……60s 窗口只在「内核降级路径」存在且只 merge 到达间隔 <60s 的条目，账本路径 idle 即投。

### 2.2 真实失败模式：token 演算

典型场景：中型会话上下文 60K tokens，主 agent 一轮派 6 个 subagent（explorer/reviewer 各异，耗时 1~15min 错峰），派发完 STOP：

| 模式 | 唤醒次数 | input token 消耗 | 附带伤害 |
|------|---------|------------------|---------|
| 现状（逐条） | 6 次 | ≈ 6 × 60K = **360K** | 5 条"收到/继续等"ack assistant 消息**永久驻留会话历史**，之后每一轮 input 都重复支付；session 可读性被噪声污染 |
| sync collect（本设计） | 1 次 | ≈ 60K + 批内容 | 无 |

省 ≈ 83% input token，且随上下文变大、N 变多线性放大。**诚实边界**：若主 agent 派发后一直在忙别的（不 STOP），busy 期间到达的通知现状已会在 settled 边沿合批，sync 收益缩小为「错峰且空闲」场景——但"派发完 STOP 等结果"正是工具 prompt 明文鼓励的模式（`DO useful non-overlapping work, otherwise STOP`），是主场景。

另一个隐性代价：每次唤醒主 agent 面对的是**部分结果**，容易诱发过早综合/提前行动；错峰通知也使 session 历史里结果与 ack 交错，复盘困难。

### 2.3 根因分析

1. **API 层**：`start` 的参数表达了执行形态（model/fork/worktree/…）却没有任何通知粒度声明——"怎么并行执行"可配，"何时告知结果"不可配。
2. **机制层**：合批是投递侧的机会性行为（时间窗/边沿对齐），不是派发侧的语义承诺。派发方无法表达"这 N 个是一批"。
3. **结果大小**（用户预判的次生问题）：one-shot 通知本来就无预算全文注入。sync 批只是把 N 份全文挤进**同一条消息**，总量不变但单轮注入形态更极端——这恰好是引入预算层与取回通道的正确时机（仅批模式加，异步路径 G4 字节锁不动）。

### 2.4 现状物理数据流

```
[subagent 子进程] ──终态──▶ RecordStore（pi session JSONL appendEntry + manifest 落盘，result 全文持久化）
                              │
                              ▼ notifyComplete（每个 subagent 各一次）
                         notifier.notify(record) ──▶ ledger 写账 ──▶ settled 边沿投递
                              │                                        │
                              │      （busy 期间到达的多条在此合并）        ▼
                              │                          pi.sendMessage(triggerTurn) ×N 次
                              ▼                                     │
                                                        主 agent steer 队列（one-at-a-time）
                                                                       ▼
                                                        N 次独立唤醒 turn（每次全量上下文重发）
```

## 3. 解决方案

### 3.1 终态（使用者视角先行）

#### 3.1.1 成功路径（主场景）

主 agent 交互样例（本地 pi CLI 真实语义）：

```
主 agent（一轮消息内 3 个 start，collect:"sync"）:
  subagent {"action":"start","task":"侦查 runtime 层日志机制","slug":"explore-runtime","collect":"sync"}
    → {"kind":"bg","subagentId":"bg-aaa","mode":"background",
       "message":"detached, will notify on completion (auto-injected message, do not poll)",
       "collect":{"mode":"sync","pendingSyncCount":1}}
  subagent {"action":"start","task":"侦查 renderer 层…","slug":"explore-renderer","collect":"sync"}
    → {…"subagentId":"bg-bbb","collect":{"mode":"sync","pendingSyncCount":2}}
  subagent {"action":"start","task":"…","slug":"explore-ext","collect":"sync"}
    → {…"subagentId":"bg-ccc","collect":{"mode":"sync","pendingSyncCount":3}}
  （主 agent 停止。三台 subagent 分别在 2min / 7min / 12min 完成——期间无任何唤醒）

12min 时刻，单条注入（1 次唤醒）：
  Subagent batch completed: 3 finished, 0 failed, 0 cancelled.
  ---
  Subagent "explore-runtime" (bg-aaa) completed. Result:
  {结果全文或按预算截断}
  ---
  Subagent "explore-renderer" (bg-bbb) completed. Result:
  …
  ---
  Subagent "explore-ext" (bg-ccc) completed. Result:
  …

主 agent 在同一 turn 内拿到全部三份结果 → 直接综合产出。
```

#### 3.1.2 失败与逃生路径

- **成员失败**：批头变为 `3 finished, 1 failed, 0 cancelled`；失败条目正文为 `Subagent "x" (bg-xx) failed: {error 全文}`——与异步单条通知同构（复用 buildLlmContent，无首行截取；多行 error 整段呈现）。批照常一次唤醒（不 fail-fast，见 D6）。
- **成员挂死**：批迟迟不闭合。逃生：`list` 可见仍在跑的成员（list 不投影 collect 标识与 pendingSyncCount——计数回显仅在 start 响应；list 投影 collect 信息列为 v2 候选）→ 主 agent/用户对挂死成员 `cancel` → 该成员转终态计入批 → 批闭合唤醒。
- **结果超预算**：条目正文先按 perItemChars 截断；若各条目截断后总和仍超 totalChars，则按总量预算**再压缩**——每条目有效预算降为 `effectivePerItem = clamp(floor(totalChars / n), 200, perItemChars)`（n = 批成员数；200 为绝对下限，低于它该条目退化为「头行 + 指针行」的纯清单形态）。截断尾接指针行：
  ```
  Subagent "explore-runtime" (bg-aaa) completed. Result:
  {前 4000 字符}…
  [truncated 11,234 of 15,234 chars — full result: session_read {"action":"result","session":"bg-aaa"}]
  ```
  主 agent 在被唤醒的同一 turn 里按需 `session_read` 取回个别全文，其余不取。
  **总量超限演算例**（默认配置）：7 个成员各 6000 字符结果 → per-item 截断后 7×4000=28000 > 24000 → `effectivePerItem = floor(24000/7) = 3428` → 每条截至 3428 字符 + 指针行，总量回到预算内，仍是单条通知单次唤醒（全员结果在场、只是更紧凑）。**totalChars 口径**：仅计各条目结果正文（截断后）之和；批头/头行/指针行/分隔符等包装开销为有界常量不入预算（量级 ≈ n×170 字符，n=7 时 ~1.2K——演算例实际注入 ≈25.2K）。**分配策略权衡**：刻意放弃按剩余预算的瀑布分配（先足额短条目、余量给长条目——非确定、依赖条目顺序），统一收紧换确定性可单测（U4 锁定）。**纯清单退化阈值**：n > totalChars/200（默认 120）时 effectivePerItem 触 200 下限进入纯清单形态；触发后全量取回需 ceil(n/10) 次 `session_read`（批量上限 10/次）——该规模远超并发池 6 + 常规排队，属极端边界的可接受退化。
- **崩溃/重启**：批等待中主进程崩溃 → 重启后恢复逻辑补发（见 3.1.5）。

#### 3.1.3 API 与数据模型

**`subagent` 工具 `start` 新参数**（拍平顶层，与 task/slug 同级）：

```ts
collect?: "async" | "sync"   // 缺省 = config 默认（默认 "async"）。one-shot 专用；
                             // 与 conversation:true 组合 → immediate 校验错（见错误规格）
```

start 的 tool result 响应追加 `collect` 段（如上样例：mode + 当前 pendingSyncCount，让派发方确认批已登记）。**pendingSyncCount 口径** = 当前未闭合批的 sync 成员总数（含本条；跨轮派发续累不重置，与 D2 隐式批一致）。

**config.json 新增节**（与 `maxConcurrent` / `defaultEngine` 同文件同 sanitize 风格，坏值回默认不炸启动）：

```json
{
  "collectSync": {
    "default": "async",
    "perItemChars": 4000,
    "totalChars": 24000
  }
}
```

`default` 新 session 生效（与 engine 配置时机一致）；两个预算值 flush 时热读。预算先例：workflow scriptResult 有界序列化 8000 字符（`interface/helpers.ts MAX_RESULT_LENGTH`）。预算算法（两段式，确定性）：① per-item 截断（每条目 ≤ perItemChars）；② 总量再压缩（Σ 超过 totalChars 时按 `effectivePerItem = clamp(floor(totalChars/n), 200, perItemChars)` 统一收紧，n = 批成员数；clamp 下限 200 以下退化为纯清单条目）。

**批身份 = 隐式 pending 集合**（D2）：不引入 batchId。批 = 当前所有「`collectMode:"sync"` 且尚未批量通知」的 record。闭合条件：running-sync 计数为 0 且缓冲非空。后续轮次再派发的 sync subagent 自然加入未闭合批（语义："等所有 sync 待收项"）。

**ExecutionRecord 新增字段**：`readonly collectMode?: "sync"`（缺省 = async，不落盘旧记录零迁移）+ `batchFinalized?: boolean`（**离开批的终局标记**，两出口统一落标：① 批闭合 flush 写账成功后；② E9 dispose 转换逐条写 async 账后；均 appendEntry 持久化）。E1 恢复钩子重建扫描**只收「collectMode=sync 且无 batchFinalized」的成员**。**标记读取通路（必须钉死，否则静默失效）**：落标 entry 写入的是**主 session 文件**，而 RecordStore 标准扫描 `collectRecords` 走 light 路径只读**子 session 文件** identity 头 + sidecar——主 session 落标 entry 对它不可见（存储域错位）。E1 重建扫描必须走**主 session 文件「每 id 末条 subagent-record entry」**通路（`collectLastRecordEntries` 同构，last-writer-wins 与两出口 append-only 时序自洽）；`rebuildEntryRecord` 投影白名单扩展含 **collectMode/batchFinalized + 终态五字段 status/endedAt/closedReason/result/error**（现实现硬编码 status:"running" 且不投影终态——不扩展则 E1 重建成员恒被视为 running，「全员终态→补发」判定永假、补发内容缺失，整条补发路径成死代码）；补发内容来源 = 末条 entry 终态快照（record-entry.ts 已含 result，零新增数据源）；该通路与账本 recoverFromSession 同文件域，flush 快照天然同源。幂等窗口：批闭合「写账成功、落标前」崩溃 → E1 重建出同成员集批 → notifyBatch 同 hash → 账本 record 幂等拒绝重发（同 notifyId 已在账，notify-ledger 实装确认）→ E1 事后无论账本接受或拒绝统一补标，窗口自愈（「同 hash 幂等」仅对「同成员集重建」成立；E9 部分转换后崩溃 → 重建集已缩小、hash 随之变化——行为正确，已转换成员本就不应再入批）；**E9 出口残余窗（披露）**：async 单成员 notifyId 与批 hash 键域不同，账本跨键不拦——flush 边界恰好切开「E9 转账 entry 已 flush / 落标 entry 未 flush」的强杀窗口内，resume 重放 async 条目 + E1 重建批再送达 = 同成员重复通知（重复方向在 at-least-once 语义下良性，与 PS-17 同族已接受面；彻底闭合可选 E1 逐成员查账本任意形态已送达条目作第二道排除，v1 不做）。E1 补标动作自身崩溃：每次重启要么幂等无操作要么推进，无振荡收敛。

**批通知 notifyId**（幂等键，进账本）：`sync-batch:<sha1(sorted member ids)>`——重启重放时凭此去重；**且必须作为批 entry details 的顶层键**。批 details 形状 = `{batch:true, notifyId:"sync-batch:<hash>", items:[...]}`（items 复用现有批量渲染，顶层 notifyId 键对 extractBatch 透明）；账本回执销账 `collectDeliveredNotifyIds` 按 `details.notifyId` / `details.items[].notifyId` 匹配——批身份键若不在顶层可达，批 entry 永不销账、重投至放弃。

**`session_read` 新 action `result`**（session-reader extension）：

```
session_read {"action":"result","session":"bg-aaa"}            // 单个
session_read {"action":"result","session":"bg-aaa,bgc,ccc"}    // 批量（≤10）
→ 每条返回该 subagent session 的最终 assistant 正文（与通知 record.result 同源），
  可选 limit 参数（默认 8000 字符/条，超出截断 + 提示读原文件）
```

定位复用既有发现机制（`sa-xxx`/uuid 片段/路径 → `subagents/**/records/*.json` manifest 反查 sessionFile），不新造目录或文件。

#### 3.1.4 终态数据流

```
[subagent ×N (collect:sync)] ──各自终态──▶ RecordStore（collectMode 随 record 持久化）
                              │
                              ▼ notifyComplete ──▶ collectCoordinator 路由
                              │                        ├─ async record → notifier.notify(record)   （现状，字节不变）
                              │                        └─ sync record  → 批缓冲（内存）
                              │                                     │ running-sync==0 && 缓冲非空
                              │                                     ▼
                              │                        notifier.notifyBatch(records)
                              │                          · 逐条 buildLlmContent + per-item/total 预算
                              │                          · 批头行 + \n\n---\n\n join
                              │                          · details {batch:true, notifyId:"sync-batch:<hash>", items:[...]}
                              │                            （notifyId 顶层键 = 账本回执销账匹配键，缺它批 entry 永不销账；items 复用现有批量渲染）
                              │                          · notifyId = sync-batch:<sha1(sorted ids)>
                              ▼                                     ▼
                          ledger 写账（单 entry）──▶ settled 边沿投递 ──▶ pi.sendMessage ×1（triggerTurn）
                                                                      ▼
                                                          主 agent 单次唤醒，全量结果在一条消息里
```

#### 3.1.5 崩溃恢复（错误规格表）

| # | 场景 | 行为 | 恢复指引 |
|---|------|------|---------|
| E1 | 批等待中主进程崩溃，重启 | session_start 恢复钩子扫描**主 session 文件「每 id 末条 subagent-record entry」**（collectLastRecordEntries 同构 + 投影扩展含 collectMode/batchFinalized **及终态五字段**（补发判定与内容依赖）；不走 collectRecords light 路径——它只读子文件 identity 头，主 session 落标 entry 不可见）：只收 collectMode=sync 且无 batchFinalized 标记的成员（排除已通过批 flush 或 E9 转换离场的成员）重建缓冲与 running 集；若全员终态且账本中无该批 notifyId 的已送达记录 → 立即 notifyBatch 补发（内容 = 末条 entry 终态快照）；仍有 running → 等其自然终态走正常流；补发尝试后统一补 batchFinalized 标记（补标崩溃重入幂等收敛） | 无需人工干预；账本幂等键防重发；E9 跨键残余重复窗见 §3.1.3（PS-17 同族）；〔注 2026-09-05 探针裁决〕kill 形态可构造，补发不可达：worker 与宿主 SIGKILL 共亡（产线前提缺口而非探针缺陷；同 §4 A6 注），真实 kill -9 后通知可达性依赖未证实的 orphan 兜底——本行经 §3.3 D5 备选门满足（U5 集成测试；探针留痕 `scripts/probes/subagent-sync-collect/RESULTS.md`） |
| E2 | 批已投递后崩溃重启 | 账本 recoverFromSession 现有语义：已销账条目零重发 | — |
| E3 | sync 成员进程异常（orphan 判定） | 现有 orphan 判定（record-store.ts orphanJudged）转终态 → 计入批 → 批闭合 | 结果以 failed/crashed 条目出现在批内 |
| E4 | `conversation:true` + `collect:"sync"` | start 立即校验错（immediate throw，不产生半启动 record——与 skillPath 路径守卫同风格） | 错误文案指引：sync 仅支持 one-shot，去掉 conversation 或 collect |
| E5 | config 坏值（负数/非枚举） | sanitize 回默认（与 maxConcurrent 同判），不炸启动 | 修正 config.json |
| E6 | 批成员被 cancel / close | 转 cancelled 终态 → 计入批（批头计数 +1 cancelled）→ 可能触发闭合 | — |
| E7 | 重启后缓冲批 + 新派发 sync 合并 | 语义一致（"所有 sync 待收"一批），文档化行为 | — |
| E8 | `fork-from` 恢复断联 sync 成员 | 新 subagent 默认 async（不属任何批）；旧成员终态计入原批 | 需要 sync 时对新 id 显式传 collect:"sync" |
| E9 | session 正常退出（`/exit` / `/fork` / `/new` 触发 dispose）时批未闭合 | dispose 把缓冲中**已终态**未通知成员逐条转 async 语义写账（放弃攒批），**并在成员 record 落 batchFinalized 标记**（E1 重建扫描据此排除，防双重通知），交由既有 shutdown flush / resume 重放兜底；仍在跑的成员走现有退出路径（与 async 一致） | 原 session resume 时未送达条目按现状重放；新 fork/new session 不受旧批影响 |

### 3.2 多方案对比

| 维度 | 方案 0：引导改用 map-reduce workflow | 方案 A：阻塞式 collect action | **方案 B：延迟批量通知（推荐）** |
|------|-------------------------------------|-------------------------------|--------------------------------|
| 机制 | 不改代码；workflow 脚本域内 parallel/map-reduce 天然聚合，run 结束单条 notifyDone | 新增 `action:"collect"`：tool 调用阻塞 await 全员终态，结果作为 tool result 同 turn 返回 | start 加 `collect:"sync"`；完成通知扣留缓冲，全员终态后单条批量通知 |
| 长期架构合理性 | 低：workflow 是脚本编排域（需写 JS、走 run 生命周期），不是交互式派发；通知 boundedPrettySerialize 8000 字符丢细节；学习成本转嫁给模型 | 中：Promise.all 语义直觉，但把"等待"塞进 tool execute 与「start 恒 background + 否则 STOP」的现有用法契约冲突 | **高**：通知粒度回归派发侧声明；复用账本/批量渲染/steer 通道全部现有机制，新增面最小 |
| 短期实现成本 | 零代码，但每次使用都要把任务改写成 workflow 脚本 | 高：pi 无工具超时（已实证）技术上可行，但 in-flight tool call 的 abort/crash 恢复、TUI 长挂显示、agent 无法 STOP 都要新机制 | 中：service 层批缓冲 + notifier.notifyBatch + 恢复钩子 + session-reader action |
| 风险 | 不解决根本问题（交互派发仍是逐条通知） | 中断/恢复语义复杂；结果仍无预算层全量进 context；与现有 60s 窗口/账本投递时机互相纠缠 | 批等待期无中间信号（靠 D6 逃生）；新增缓冲的崩溃一致性需 E1 覆盖 |

**若用方案 0**，§2.2 的例子变成：主 agent 把 6 个侦查任务改写成 map-reduce workflow 脚本 → 派发本身变重（脚本编写+run 状态机）、结果被 8000 字符有界序列化截断、且日常"顺手派 2 个 subagent"场景不会为它写 workflow——逐条唤醒照旧。

**若用方案 A**，§2.2 的例子变成：派 6 个后主 agent **必须**再调一次 `collect` 并在 tool 调用里挂 12 分钟（不能 STOP——违背工具 prompt 现有的 `otherwise STOP` 指引）；期间用户 steer 排队、TUI 显示悬挂工具；ESC 中断后批状态悬空。token 上省得同样多，但用法契约与恢复复杂度代价不成比例。

**推荐：方案 B**。它是唯一同时满足 G1-G5 且不新增"长阻塞原语"的方案；方案 0 保留给结构化流水线场景（工具 prompt 中并行引导），方案 A 的被否理由记入 D7 谱系。

### 3.3 关键决策与权衡

**D1 API 形态：per-start 参数 vs 独立 collect 工具/action**
选择：`start` 顶层参数 `collect`。被否：独立 action（多一次调用、批身份要么显式 batchId 要么隐式引用"最近的 start"，LLM 出错面更大）。证据：用户原始诉求即"派发时指定"；顶层拍平是既有惯例（task/slug/agent/model…）。探针 ✅：e2e 验证 LLM 一次消息内 3 连 start 带 collect。

**D2 批身份：隐式 pending 集合 vs 显式 batchId**
选择：隐式（批 = 全部未通知的 sync record）。被否：batchId——LLM 需自己管理 id 的生成/复用，孤儿批（id 拼错永不闭合）是必然出现的失败模式；隐式集合下"批"只是投递时机，无身份可错。代价：①同轮混派多批语义不可表达（后派 sync 并入 pending 批）——v1 接受并文档化；②**批饥饿**：主 agent 持续不 STOP、不断派新 sync，pending 永不为空 → 最早结果被无限扣留——逃生 = `list` 观察仍在跑的成员 + 对已有条目 cancel/close 逼闭合（pendingSyncCount 回显仅在 start 响应，list 不投影 collect 信息；投影列为 v2 候选，不作为 v1 逃生依赖）。探针 ✅：单测覆盖"分两轮派发 2+1 sync → 仍单条通知含 3 段"。

**D3 结果预算：仅批模式加 vs 全局加**
选择：仅批内容加预算（perItemChars/totalChars）。被否：全局预算——异步单条通知文案有 golden snapshot 字节锁（`notifier-golden-snapshot.test.ts` G4），且 G3 要求现状零变化。批是新文案，新 golden。探针 ✅：新 golden 锁批格式；旧 golden 不动全绿。

**D4 溢出通道：session_read result action vs 临时文件**
选择：`session_read` 新 `result` action。被否：结果写临时文件——引入第二存储（结果已持久在 subagent session JSONL + record manifest）、文件生命周期/清理/路径白名单（pre-commit 检查硬编码路径）三重新增面；session-reader 已有 sa-xxx manifest 反查机制，"直接读最终结果"只是补一个 action。代价：超大结果取回多一次工具调用（可接受——仅超预算条目需要）。证据：session-reader 现无"取最终结果"专用参数（侦查报告 A），outline/detail 需拼 turn 参数正是用户说的"复杂参数"。探针 ✅：e2e 超预算条目 → 主 agent `session_read action:result` 取回与 record.result 逐字节一致。

**D5 分层：批缓冲在执行层（service）vs 账本层（ledger）**
选择：service 层缓冲，flush 时**单条** batch entry 进账本。被否：账本感知批（成员级 held entry + 全员闭合才投）——把"何时发"的执行语义塞进"必达"的账本层，账本复杂度（at-least-once 状态机）本已高；单 entry 进账本后账本零改动即继承幂等/重放/看门狗。代价：缓冲期间（成员终态→批闭合）的崩溃需 E1 恢复钩子兜底——批成员身份与终态都已持久化在 record store，可完整重建。探针 ⛔实施期门：kill -9 崩溃恢复 e2e（kill -9 主进程于批等待中 → 重启单条补发、二次重启零重发）；**降级路径**：若该时序无法稳定构造（子进程回收/session flush 窗口抖动），以集成测试模拟重启序列（dispose → 重建 service → session_start 恢复钩子断言补发与幂等）为备选门，二者至少其一通过。

**D6 失败与超时语义：批内披露 + 无批级超时**
选择：failed/cancelled/crashed 全部计入批（批头计数），不 fail-fast；不设批级超时。论据：①成员失败通常改变编排决策，但早通知省下的 token 有限（失败通知本就短），而 fail-fast 会让"批"退化为逐条通知（违背 G1）；②挂死风险由现有 per-subagent 守卫兜底（settled-watchdog / turn-limiter / maxTurns / orphan 判定，`subagent-core-unbounded-wait-audit.md` 已普查无界等待），批级超时与其重叠；逃生 = list（可见在跑成员；pendingSyncCount 见 start 响应）+ cancel。被否：批级 timeoutMs（v2 视真实使用再加，config 已留节）。探针 ✅：单测 cancel 挂死成员 → 批闭合且计数含 cancelled。

**D7 等待形态：延迟通知（steer 通道）vs 阻塞工具调用（tool-result 通道）**
选择：延迟通知。被否：阻塞式 collect action——pi 无工具超时（0.84.4 dist 实证）技术上可行，但①主 agent 必须留在 turn 里不能 STOP，与工具 prompt `otherwise STOP` 契约冲突；②in-flight tool call 的 abort/crash 恢复是新语义（pi 重启后悬挂 toolCall 的 session 状态无既有处理）；③TUI 长挂显示差。延迟通知完全复用现有 steer/账本/批量渲染三套机制。谱系：方案 A（§3.2）+ 本条。

**D8 v1 scope 裁剪**
明确不做（减法）：conversation 模式 sync（chatMode 轮次通知是对话回流，语义不同，强行批收破坏 G1 对话连贯）；message 轮次批收；workflow 域改造；fail-fast 选项；批超时；GUI 改造（bg-notify-render 批量分支已存在，gui-mappers 对 batch details 的映射仅核对）。每项都有独立价值，但 v1 以最小面达成 G1-G5，避免一次引入 5 个新语义。

### 3.4 与登记约束的一致性

| 约束 | 一致性 |
|------|--------|
| C-ext-19 结果通知确认式送达（持久账本+幂等键） | 批通知 = 账本单 entry + `sync-batch:<hash>` 幂等键，机制原样继承 |
| C-ext-13 引擎抽象单向依赖 | collectCoordinator 在引擎无关的 service 层，pi/zcode 天然一致 |
| C-ext-17 非 pi 引擎终止链不留孤儿 | 不改终止链；zcode 成员终态走既有路径入批 |
| C-sw-01 每 session JSONL 单写进程 | 不新增写入方；record 持久化沿用 appendEntry |

## 4. 验收（真实场景，非单测/mock）

实施完成后在**本地 pi CLI**（`pi --mode rpc --extension <path>`，AGENTS.md MANDATORY 通道）+ xyz-agent dev 双环境验证。每个场景回溯 §1.2 目标。

| # | 场景 | 步骤 | 通过标准 | 回溯 |
|---|------|------|---------|------|
| A1 | 错峰全成功单唤醒 | RPC 起 pi，发一条含 3 个 `collect:"sync"` start 的 prompt（任务里让三台 sleep 10s/30s/60s 再返回），等待 | session JSONL 中 `subagent-bg-notify` custom entry 恰好 **1 条**（批头 `3 finished`）；批闭合前主 agent 无任何新增 turn；三段结果在同一条消息 | G1 |
| A2 | token 对比探针 | 同一任务分别以 async（不传 collect）与 sync 各跑一次，从最后 assistant usage 统计 input tokens | sync 的总 input tokens 低于 async；async 路径产生 ≥2 条中间 ack turn，sync 为 0（数字记录进验收报告作参考基线，3 subagent 规模下通常差距 ≥40%，**非门**） | G1 |
| A3 | 成员失败入批 | 3 个 sync，其一 task 为"直接 throw/失败" | 仍单条通知，批头 `2 finished, 1 failed`，失败条目含 error 全文（与异步单条通知同构，无首行截取） | G1 |
| A4 | 超预算截断 + 取回 | ① 1 个 sync，task 要求输出 >10K 字符结构化报告；② 7 个 sync 各输出 ~6K 字符（触发总量超限） | ① 该条目截断至 perItemChars 且尾行含 `session_read {"action":"result",...}` 指引；② 各条目截至 `effectivePerItem = floor(24000/7) = 3428`、总量回预算内且仍单条通知；随后真实调 `session_read action:result` 取回内容与 record.result 逐字节一致 | G2 |
| A5 | 异步零回归 | 不传 collect 跑既有单 subagent 流程 | 单条通知文案与改动前 golden 逐字节一致（旧 golden 测试全绿）；`list`/`cancel`/`message` 不变 | G3 |
| A6 | 崩溃恢复不丢不重 | ① 2 个 sync（sleep 60s）派发后 kill -9 主 pi；重启同 session；② 正常 `/exit` 于批未闭合时（2 已终态 + 1 在跑）再 resume | ① 恢复后补发单条批通知（若已全终态）、二次重启零重发（账本幂等键生效）——〔注 2026-09-05 探针裁决〕kill 形态可构造，补发不可达：worker 与宿主 SIGKILL 共亡（产线前提缺口而非探针缺陷，探针留痕 `scripts/probes/subagent-sync-collect/RESULTS.md` + `diag-survive.mjs`）；真实 kill -9 后通知可达性依赖未证实的 orphan 兜底——本条经 §3.3 D5 备选门满足（U5 集成测试）；② resume 后 E9 转换的两条经 async 重放送达、**零重发**，恢复补发只含在跑成员（batchFinalized 排除生效） | G4 |
| A7 | zcode 一致性 | 配置 engine 路由到 zcode，重复 A1 | 行为与 pi 引擎一致（单条批通知） | G5 |
| A8 | 混派正交性 | 同轮 2 sync + 1 async | sync 对合并为 1 条批通知；async 各自单独通知（或与批在 settled 边沿自然合并——允许 2~3 条，但 sync 部分恒 1 条） | G1/G3 |

**验收就绪判定**：以上场景全部可执行即设计就绪；A1/A4/A6 为实施完成门（DoD），A2 数字仅记录不设硬阈值（模型/上下文差异大）。

## 5. 下一层拆分

拆分原则：每个单元独立可验收（呼应 §4），账本/渲染复用面（U3）先行打通最小闭环，恢复钩子（U5）与取回通道（U6）随后，文案/引导（U7）收尾。

| 单元 | 内容 | 文件改动地图 | justification | 验收挂钩 |
|------|------|-------------|---------------|---------|
| U1 参数与配置面 | schema 加 `collect`；config `collectSync` 节 + sanitize；start 响应带 collect 段 | `subagent-tool-schema.ts`、`subagent-actions-core.ts`、`packages/subagent-core/src/execution/config.ts`、`types.ts`（ExecutionRecord.collectMode） | API 面最先冻结，后续单元依赖它 | A1 前置 |
| U2 collectCoordinator 路由 | notifyComplete 全部调用点（kickOffBackground.then / cancelBackground / orphan 等）统一过协调器：sync→缓冲，async→现状 | `subagent-service.ts`（新协调器模块或内嵌） | 「散落 if」是本类改动的最大实现风险，集中路由是结构性防线 | A5 |
| U3 批缓冲 + notifyBatch | pending 集/缓冲/闭合判定；`buildBatchLlmContent`（批头 + join + 预算）；notifyId 规则 | `notifier.ts`、`subagent-service.ts`、（只读复用）`bg-notify-render.ts` 批量分支 | 最小闭环：无恢复无截断也能单唤醒 | A1/A3/A8 |
| U4 预算截断 + 指针 | 两段式预算（per-item 截断 + totalChars 再压缩 effectivePerItem 算法）、截断尾行（session_read 指引）、config 热读 | `notifier.ts`（批内容组装处） | 与 U3 同文件但独立可测（纯函数）；总量超限算法必须确定性可单测 | A4 |
| U5 崩溃恢复钩子 + dispose 转换 | session_start 扫描**主 session 末条 entry 通路**（collectLastRecordEntries 同构，rebuildEntryRecord 投影扩展 collectMode/batchFinalized + status/endedAt/closedReason/result/error——禁走 collectRecords light 路径）只收无标记 sync 终态成员重建；全终态未投递→补发（与 ledger recoverFromSession 同文件域协同）；dispose 时未闭合缓冲逐条转 async 写账 + 落 batchFinalized（E9）；批 flush 两出口统一落标 + 幂等窗口补标 | `extensions/universal/subagent-workflow/src/index.ts`（现有恢复编排处）、`subagent-service.ts`（dispose 路径）、`record-store.ts`（末条 entry 通路 + 投影扩展 + 标记 appendEntry） | E1/E9 的机制载体；批语义完整性（G4）；E9×E1 缝隙闭合点与读取通路钉死（含终态投影，否则补发路径死代码） | A6 |
| U6 session_read result action | 新 action：manifest 反查 → 最终 assistant 正文（与 record.result 同源）+ 批量 id + limit | `extensions/universal/session-reader/src/tool-handler.ts`、`index.ts`（schema） | G2 取回通道；独立 extension 独立发布面 | A4 |
| U7 工具 prompt 与引导文案 | subagent 工具 description：collect 用法（≥2 独立 one-shot 要综合→sync；对话/需早响应→async）；「You cannot」节措辞更新；config skill 文档 | `subagent-tool.ts` description、`skills/subagent-ext-config/SKILL.md` | LLM 不会用 = 功能不存在；参数文档同步 | A1/A2 |
| U8 测试与探针 | 新批 golden；协调器/闭合/预算单测（subagent-core vitest）；崩溃恢复集成测试（**标记可见性断言必须走真实文件通路**：主 session JSONL 写入→扫描重建，禁 mock record 直接断言）；A1-A8 真实 CLI 脚本化（探针落 `.agents/` 或 scripts，用后归档按仓库惯例处理） | `packages/subagent-core/src/execution/__tests__/`、`extensions/universal/subagent-workflow/src/__tests__/`、session-reader `__tests__/` | 三视角 + 真实场景门；读取通路错位是第 3 轮审查抓出的静默失效形态，mock 测不出 | 全部 |

**待验证检查点（诚实标注）**：

1. ⛔ gui-mappers 对 `{batch:true, items}` details 的 GUI 映射是否完整（TUI 已确认支持，GUI 侧仅核对——若缺，属于既有批量渲染缺口，单独修，不入本特性 scope）。
2. ⛔ ledger 对同一 notifyId 重复 record 的确切行为（设计依赖其幂等拒绝；实施期以现有 `notify-ledger.test.ts` 语义为准，必要时补断言）。
3. ⛔ 池排队中的 sync record 在 record store 中的 status 精确值（闭合判定需把它计入 running；以 `concurrency-pool.ts` + `subagent-service.ts` 实装为准）。
4. ⛔ zcode 引擎成员终态是否全部汇聚到 notifyComplete 同一入口（parent-child-matrix 测试为参照；若有旁路，U2 路由需覆盖）。

---

### 附：被否谱系汇总（供后续轮次审查者）

| 被否方案 | 击穿反例/理由 |
|---------|--------------|
| map-reduce workflow 替代（方案 0） | 交互式派发不会为它写脚本；8000 字符有界序列化丢细节 |
| 阻塞式 collect action（方案 A / D7） | 不能 STOP 违背用法契约；in-flight tool call 恢复无既有语义；TUI 长挂 |
| 显式 batchId（D2） | LLM 管理 id 必产孤儿批（拼错永不闭合） |
| 临时文件溢出（D4） | 第二存储 + 清理 + 路径白名单三重新增面，结果本已持久化 |
| 账本感知批（D5） | 执行语义侵入 at-least-once 状态机，复杂度错层 |
| fail-fast 批（D6） | 批退化为逐条通知，G1 失效 |
| 全局结果预算（D3） | 打破异步路径 G4 字节锁，违背 G3 |
