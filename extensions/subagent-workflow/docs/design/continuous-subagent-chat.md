# 可持续对话 subagent（Continuous Chat）设计文档

> **一句话结论**：把 subagent 从「一次性执行」扩展为「可持续对话」——用 **`record.id` 作持久句柄 + session 文件作状态源 + resume 重开（`--session <file> --mode rpc`）+ `prompt` 命令续聊**，不引入 broker/通信通道。三项关键能力（resume 上下文保留、prompt 续聊、steer/follow_up 完成后无效）均已本地 pi 实测验证。**不新增 wait action**（回复经现有 notify 异步送达，阻塞等待是负收益）；**不扩展 ExecutionMode**（对话模式用独立标志，避免波及模式消费点）。

## 层声明

- **当前层**：功能设计（subagent 工具的执行语义扩展 + 接口扩展）
- **下一层**：可实现的接口/数据模型/技术方案 + 具体代码任务
- 涉及运行时行为、进程数据流、错误处理 → 设计准则 5（数据流图）/ 6（错误恢复）/ 7（探针）全部 P0 适用

---

## §1 背景目标

### SCQA

- **S（情境）**：pi-subagent-workflow 提供 spawn 子进程式 subagent 工具，一次调用完成一次任务，结果经通知回流主 agent。
- **C（冲突）**：subagent 是**一次性的**——发完任务只能等最终结果；任务中途想追问、想改方向、想在回复前补充信息，全都不行。多轮协作任务（分阶段实现、多轮 review、边做边确认）只能反复 spawn 全新 subagent，上下文每次归零，主 agent 被迫在消息里搬运所有历史。
- **Q（问题）**：怎么让 subagent 变成**可持续对话的伙伴**——分派后能等待回复、能再次向它对话、回复前还能插入新消息，且对话状态不随进程结束而丢失？
- **A（答案）**：核心不是加通信机制，而是**消除「终态即销毁」的假设**——保留句柄与 session 状态，续聊 = 重开同一 session 再驱动一轮。本文展开这个答案。

### 系统是什么

pi-subagent-workflow 的 subagent 工具（`interface/subagent-tool.ts`）当前支持 3 个 action：`start`（spawn 一个 pi 子进程跑任务，detached 立即返回）、`list`（列出 subagent）、`cancel`（取消运行中的）。子进程是 `pi --mode rpc` 长驻进程，通过 stdin 发 JSONL 命令驱动、stdout 收 JSONL 事件流。任务跑完（`agent_end`）后子进程被 SIGTERM，记录归档，会话文件留在磁盘。

### 设计目标（从使用者体验倒推）

| # | 目标 | 使用者（主 agent）体验 |
|---|---|---|
| G1 | 分派后可等待回复 | 分派任务后，subagent 每轮回复经现有 notify 机制异步送达（triggerTurn 唤醒），主 agent 无需轮询 |
| G2 | 可再次对话 | 对同一 subagent 再次发消息，它带着之前的上下文继续工作（多轮） |
| G3 | 回复前可插入新消息 | 不等回复，连续发多条消息，subagent 按序处理（排队语义） |
| G4 | 对话可恢复 | 进程/会话重启后，仍能找到之前的 subagent 并续聊（句柄持久化） |
| G5 | 不误伤现有模式 | 一次性 subagent（默认行为）不受影响；对话模式是显式 opt-in |

### In-scope / Out-of-scope

**In-scope**：
- subagent 工具新增 action：`message`（续聊/插入）、`close`（结束对话）
- start 新增对话模式选项（`mode:"conversation"`）；record 生命周期扩展「对话中」语义
- resume 重开逻辑（spawn 参数 + session 定位 + 进程句柄映射）
- 归属守卫（防跨 session 驱动他人 subagent）
- 对话模式的 sidecar/重建/reaper/notifier 适配

**Out-of-scope**：
- agent 间自由互发消息（任意对任意）——那是未来的多 agent 网格，需要时再设计通道（见 §3.3 决策 4）
- 跨机器/跨进程树通信
- pi-intercom 式本地 broker
- 对话 UI（TUI 渲染）——本期只做工具语义，UI 后置
- 阻塞式 `wait` action——G1 已由 notify 覆盖，见 §3.3 决策 7

---

## §2 现状与问题分析

### 2.1 使用者视角现状（真实工具行为）

主 agent 现在能做的：

```
# 分派（唯一方式）
{"action":"start","task":"review record-store.ts 的重建逻辑","slug":"review-rs","agent":"reviewer"}
→ { mode:"background", subagentId:"sa-abc123", sessionFile:"...", details:{...} }
# 之后只能：
{"action":"list"}          → 看状态/结果摘要
{"action":"cancel","cancelParam":{"subagentId":"sa-abc123"}}   → 杀掉
```

分派后主 agent 能做的最多就是等 `subagent-bg-notify` 通知（子进程完成时 triggerTurn 唤醒，消息文本携带结果摘要）。**没有第二个动词**。

### 2.2 真实失败模式

- **F1 多轮任务无法做**：想要「实现功能 → review → 按反馈修 → 再 review」的循环，只能每轮 spawn 新 subagent，把上一轮结果全文塞进新 task 文本。上下文靠手工搬运，超长后截断，效果逐轮劣化。
- **F2 中途无法干预**：subagent 跑偏了（方向错误、误解需求），主 agent 只能等它跑完或 cancel 重来。cancel 丢全部上下文。
- **F3 无法补充信息**：分派后想起漏了关键约束（「注意还有个 legacy 接口」），没有任何途径送进去。
- **F4 无对话句柄**：subagent 结束后，`subagentId` 只在 `list` 里有展示价值，不能用来做任何事。会话文件（sessionFile）明明在磁盘上且内容完整，但扩展没有任何代码路径能重新打开它。

### 2.3 根因

根因是**「完成即终态」的执行模型**，三处互相咬合：

1. **进程必杀**：`session-runner.ts` 的 `agent_end` 分支——无活跃后代（pending:register−unregister 差集为空）即 `child.kill("SIGTERM")`。进程是对话上下文的载体，进程没了对话就没了。
2. **记录即归档**：`record-store.ts` 的终态 record 立即从内存 `archive`（`findRecord`/`getMutable` 只查 running）。没有「已结束但可恢复」的中间态。
3. **状态机无中间态**：`ExecutionStatus = "running" | "done" | "failed" | "cancelled" | "crashed"`——没有「对话中/空闲可续」状态。

### 2.4 物理数据流（当前）

```
主 agent (LLM)
  │  subagent 工具调用
  ▼
subagent-workflow 扩展（主 pi 进程内）
  │  spawn("pi --mode rpc --session-dir <agentDir>/subagents/<enc>/sessions")
  │  stdin: {type:"prompt", message}
  ▼
pi 子进程（rpc mode，长驻）
  │  stdout JSONL 事件流（message_start/.../agent_end/agent_settled）
  ▼
subagent-workflow 扩展：spawn-event-adapter 泵事件 → record 更新 → notifier 通知主 agent
  │  agent_end 且无后代
  ▼
child.kill("SIGTERM")  →  record archive →  worktree cleanup
  │
  ▼
磁盘：<agentDir>/subagents/<enc>/sessions/<ts>_<sessionId>.jsonl
      + 同名 .alive / .cancelled / .finalized sidecar   ← 完整对话历史，但无人再打开它
```

**关键事实**：session 文件是完整的状态源（含全部消息、身份 entry），sidecar 文件（`.alive`/`.cancelled`/`.finalized`）是终态判定依据。但这组文件在这条链路的末端是「死文件」——只被 `session-reconstructor.ts` 只读重建用于 list 展示。

---

## §3 解决方案

### 3.1 终态（使用者视角）

#### 成功路径：多轮 review 对话

```
[主 agent] {"action":"start","task":"review record-store.ts 的重建逻辑","slug":"review-rs","agent":"reviewer","mode":"conversation"}
→ { mode:"conversation", subagentId:"sa-abc123", sessionFile:"...", status:"running" }

[subagent 完成第一轮 review]  →  notify 唤醒主 agent："review-rs 完成，发现 3 个问题：..."

[主 agent] {"action":"message","subagentId":"sa-abc123","text":"第 2 个问题（重建矩阵兜底 crashed）请给出具体修复方案，先不要改代码"}
→ { delivered:true, status:"running" }     ← 非阻塞，立即返回；若进程已回收则自动 resume 重开

[subagent 回复]  →  notify 唤醒主 agent，携带修复方案

[主 agent] {"action":"message","subagentId":"sa-abc123","text":"方案可以，开始改。改完跑测试。"}
→ { delivered:true, status:"running" }

[subagent 改完]  →  notify："修复完成，测试通过"

[主 agent] {"action":"close","subagentId":"sa-abc123"}
→ { closed:true, status:"done" }           ← 显式结束，走现有 finalize 路径
```

#### 插入消息路径（回复前补充信息）

```
[subagent 正在跑第一轮 review]（主 agent 想补充约束）
[主 agent] {"action":"message","subagentId":"sa-abc123","text":"补充：忽略测试文件，只看生产代码"}
→ { delivered:true, queued:true }          ← busy：写活进程 stdin（pi 原生排队，当前轮后按序处理）

[subagent 已完成、进程已回收]（idle）
[主 agent] {"action":"message","subagentId":"sa-abc123","text":"继续：把发现的第 1 个问题也修了"}
→ { delivered:true, resumed:true }         ← idle：resume 重开 session 后 prompt
```

#### 失败路径与恢复指引

| 失败 | 现象 | 恢复指引 |
|---|---|---|
| subagent 不存在 / 已 close / 非本 session 所有 | `subagent not found or not owned: sa-abc123` | `list` 确认 id；若已 close 需重新 `start`；非本 session 所有则无法操作 |
| 进程忙且 stdin 写入失败 | `subagent sa-xxx process unavailable, queued for resume` | 消息已入扩展侧队列，当前轮结束后 resume 投递；或稍后重发 |
| 进程崩溃 / 会话文件损坏 | `session file missing or unreadable: <path>` | `list` 确认状态；`close` 清理句柄后重新 `start` |
| 续聊后 subagent 无限循环 | `message` 每次都能投递，无自然停止 | 用 `close` 显式结束；或 `cancel`（同一次性模式） |
| 排队消息因主 agent 重启丢失 | 重启后 `message` 重发 | 重发消息即可；排队消息不持久化（见 §3.3 决策 6 限制声明） |

### 3.2 多方案对比

| 方案 | 长期架构合理性 | 短期实现成本 | 风险 | 裁决 |
|---|---|---|---|---|
| **B：resume 重开（选）** | ✅ 会话文件是唯一状态源，进程可随意重建，天然崩溃恢复；与 pi 的 session 模型一致；后续多 agent 场景同样适用 | 中：spawn 参数改造 + record 恢复语义 + 新 action + sidecar/reaper/notifier 适配 | 低：核心能力已实测通过；resume 加载开销（~1.5s + 上下文重放） | ✅ 主路径 |
| **A：进程保活** | ⚠️ 上下文在进程内存，进程没了对话就没了；需要额外 TTL/回收机制 | 低：改 kill 分支 + stdin 写入（已有 sendPromptCommand） | 中：常驻 ~150MB/agent（实测）；崩溃丢对话；需防误杀改造 | ❌ 后置为快路径 |
| **C：A+B 混合** | ✅ 完整但冗余 | 高：两套机制 | 高：两套 kill/恢复逻辑互相咬合 | ❌ 第一版不做 |

**被否方案的实际效果**：

- **若用方案 A（进程保活）**：上文的「重启恢复」场景变成——主 agent 会话重启后，所有对话中的 subagent 子进程已被 `killAllSpawnedChildren` 清理，对话全部丢失；且每开一个对话就常驻 150MB 内存（实测 RSS），5 个对话 = 750MB。它只解决了「同一次会话内的连续对话」，没解决「对话可恢复」。
- **若用方案 C（混合）**：同一功能两条代码路径，kill 语义、守卫、状态机各一份，三个月后维护者需要理解两套「为什么进程还活着/为什么重开了」。收益（保活的低延迟）在 resume 已实测 ~1.5s 加载成本面前不成立。

### 3.3 关键决策与权衡

#### 决策 1：续聊命令用 `prompt`，不用 steer/follow_up —— 实测证据

- **选择**：resume 重开后，续聊消息一律通过 `prompt` 命令（`{type:"prompt", message}`）驱动。
- **被否**：`steer` / `follow_up` 命令——实测两者在 agent 完成后**只入队不触发新 run**（60s 无新 `agent_end`）。
- **证据**：pi 源码 `agent.ts` 的 `steer()`/`followUp()` 只 `enqueue`；`agent-session.ts` 的 `_runAgentPrompt` 的 `while (_handlePostAgentRun())` 循环在 agent_end 发出后**同步**检查完队列并退出（`agent_end` 事件尚未到达 rpc 客户端）。唯一能消费队列的是 agent_end extension handlers 在进程内入队的消息。`prompt` 命令走 `session.prompt()` → `agent.prompt()` → 新 run，实测两轮续聊上下文正确累积（42 → 42+7=49）。
- **探针**：§3.4 P-1/P-2/P-3。

#### 决策 2：句柄 = `record.id`（持久化 agent_id），非运行时对象

- **选择**：对话句柄就是现有 `record.id`（`sa-<uuid>`，`subagent-service.ts:707`）。message/close 按 id 定位：内存 running record 优先，否则从磁盘重建。
- **被否**：进程引用/管道对象——进程死了引用即失效，违背 G4（可恢复）。
- **证据**：Kimi 的持续对话即「`agent_id` 字符串 + resume 调用」，重开 session 后 agent 重建、wire journal 恢复、resume 依旧可寻址；Claude Code 的 resume 同样基于磁盘 transcript。三家（含 pi 自身 session 文件）一致：**文件是状态源，句柄是文件的可寻址名**。

#### 决策 3：归属守卫用 `rootSessionId`（非 parentRecordId）

- **选择**：`message`/`close` 前校验 record 的 **`rootSessionId`**（递归链同值 = 发起主 session 的 id，`execution-record.ts:154`）必须等于当前 session id。
- **被否**：`parentRecordId`——它是**父 subagent 的 record id**（层级树构建用），顶层 subagent 的 parentRecordId 恒为 `undefined`，用它做守卫会导致所有顶层 subagent 都无法通过校验。
- **跨进程判定**：`collectRecords` 默认按 `rootSessionId` 过滤（`record-store.ts:301`），跨 session 的 message 会在过滤层直接查不到——归属判定必须**绕过过滤查询磁盘全集**，再比对 rootSessionId，才能给出「not owned」而非误导性的「not found」。
- **证据**：`collectRecords`/`reconstructAll` 的 rootSessionFilter 参数即现有归属语义实现；Kimi `requireOwnedSubagent` 同款校验已在生产验证。

#### 决策 4：不引入 broker / 通信通道 —— 三方证据

- **选择**：零新增通道。父子进程用现有 stdin/stdout；「跨进程恢复」用 session 文件。
- **被否**：本地 broker（pi-intercom 式）——它解决的是「多个独立用户 session 互发消息」，不是 subagent 场景；Claude Code 跨进程（独立 CLI 进程）只靠文件 mailbox + 轮询，无中心服务；Kimi 同进程直接函数调用。**当且仅当**未来做「agent 间任意对任意自由通信」时才需要通道层，届时先文件 mailbox（Claude 方案）后升 broker，当前设计不为其预留（§1 out-of-scope）。
- **探针**：P-1/P-2 已证明父子直连通道可完成全部所需语义（续聊/排队/通知），无缺口。

#### 决策 5：状态机与生命周期 —— idle 态 + `.idle` sidecar + reaper 豁免

- **选择**：`ExecutionStatus` 增加 `"idle"` 态（对话模式：一轮结束、进程已回收、等待下次 message）。终态语义：
  - 对话模式轮次完成（agent_end 无后代）→ **进程照常 SIGTERM 回收**（session-runner 的 kill 分支不改）；record **不 archive**、标记 `idle`；写 **`.idle` sidecar**（`{id, sessionFile, rootSessionId, round}` 单行 JSON，与 `.alive`/`.finalized` 同目录同格式族）；worktree **保留**
  - **重建矩阵扩展**：`record-store.ts` reconstructAll 现矩阵为 `.cancelled → cancelled / .finalized → done/failed / .alive+pid存活 → running / 兜底 → crashed`。idle 记录必须命中新分支 **`.idle` 存在 → idle**（不依赖 pid 死活）。兜底 crashed 保持不变——没有 `.idle` 的孤儿会话仍按崩溃处理
  - **worktree reaper 豁免**：`worktree-manager.scan()`（`index.ts:295`，session_start 时执行）现按「pid 死 = 孤儿」清理。idle 记录的 registry 条目需豁免——判据改为「pid 死 **且无 `.idle` sidecar**」才清理；对话模式 worktree 随 `.idle` 存在而保留
  - `close` → 正式终态（删 `.idle` sidecar + 走现有 finalize：archive + worktree cleanup）
  - 一次性模式（默认）行为完全不变
- **被否**：复用 `running` 表示对话中——list 状态无法区分「正在跑」和「在等下一轮」，且磁盘重建无法区分；`running` 语义被破坏。
- **影响**：`finalize-record.ts` 拆出「轮次完成（→idle，保留 worktree）」与「最终关闭（→done + 现有清理）」两条路径。

#### 决策 6：消息投递 —— busy 走活进程 stdin，idle 走 resume，两分支互斥

- **选择**：`message` 的投递路径按 record 状态分派：
  - **running（busy）**：直接写活进程 stdin（`{type:"prompt", message}`），排队语义由 pi 进程内 prompt 队列承担（rpc-mode 注释「Queued and immediately handled prompts also count as success」）。需要 **record→ChildProcess 映射**——现有 `spawnedChildren` Set（`session-runner.ts:211`）无 id 关联，改为 `Map<recordId, ChildProcess>`（或等价注册表），供 busy 投递定位
  - **idle / done（已回收）**：resume spawn（`--session <sessionFile> --mode rpc`）+ prompt
  - **两分支互斥**：busy 时进程活着只能走 stdin；idle 时进程必死只能走 resume。**同一 session 文件永不被两个进程并发打开**（by construction，无并发写风险）
- **排队消息不持久化**：busy 时若 stdin 写入失败（进程刚退），消息进扩展内存队列、当前轮结束后 resume 投递；主 agent 重启后未投递的排队消息丢失（限制声明，恢复指引见 §3.1 失败表）。第一版不落盘排队队列——落盘需要新的 sidecar 语义，收益低（窗口极窄）。
- **被否**：busy 时也 resume 重开——两个进程打开同一 session 文件，pi 无文件锁语义（未探针），并发写损坏风险不可接受。
- **探针**：P-4（busy 时 stdin 直写排队行为）、P-5（resume 后文件可见性）。

#### 决策 7：不新增 `wait` action —— 减法

- **选择**：删除设计中的阻塞 `wait`。G1「分派后可等待回复」由现有 notify（triggerTurn steer 异步唤醒）完整覆盖——subagent 每轮回复都唤醒主 agent，无需阻塞等待。
- **被否**：阻塞式 wait——(a) 语义矛盾：wait 等「回复」时 subagent 必然 running，但 running 时阻塞 tool call 挂起 LLM turn，主 agent 无法并行做任何事（与 G3「插入消息」直接冲突）；(b) 机制缺口：阻塞 tool 等异步 agent_end 需要事件桥接（tool handler 是同步执行的），且 wait 返回后 BgNotifier 的 triggerTurn 会重复注入 → 双通道重复消费；(c) 收益为零：notify 已送达。
- **证据**：现有 `subagent-bg-notify`（`notifier.ts` doSend：`triggerTurn:true + deliverAs:"steer"`）即「完成即唤醒」的现成机制。

#### 决策 8：不扩展 ExecutionMode —— 独立 chatMode 标志

- **选择**：对话模式**不**新增 ExecutionMode 值，`mode` 仍为 `"background"`；改用 record 上的独立字段（如 `chatMode: boolean`）标记对话模式，随 identity entry 持久化（`.idle` sidecar 也带该标志）。
- **被否**：扩展 ExecutionMode——会命中全部消费点：`session-reconstructor.ts` isIdentityData 校验 `mode ∈ {sync, background}`（对话 record 重启后重建直接失败 → list 看不到）、`subagent-service.ts:757` pooled 判定、`cancelHandler` 的 `mode !== "background"` 抛 unsupported、`hasRunningBackground` 统计、`record-store.ts` STATUS_PRIORITY 排序。每个都要改且语义互相纠缠。
- **附带决策**：对话模式照常占并发槽位（pool acquire/release 不变）；轮次间 idle 不占槽（轮次结束 release，resume 时重新 acquire）——实现细节在 M2 验证。

#### 决策 9：notifier 对话模式豁免 dedup + 状态守卫扩展

- **选择**：`BgNotifier` 的 60s dedup TTL（`notifier.ts` DEDUP_TTL_MS=60000，同 subagentId 60s 内第二次 notify 静默跳过）对对话模式**豁免**——按「轮次」去重而非按 subagentId（`.idle` sidecar 的 round 序号或通知计数）；`toNotifyRecord` 的 status 守卫（现只放行 done/failed/cancelled）增加 idle 分支。
- **被否**：对话模式继续走 60s dedup——快速多轮（message → 回复间隔 <60s）第二条回复通知被吞，父 agent 永远等不到回复，G1/G2 断裂。
- **证据**：`notifier.ts` 现有 dedup 语义（一次性模式防抖）；对话模式的回复是**每轮必须送达**的语义，两者冲突。

### 3.4 探针清单（运行时断言 → 证据）

| ID | 验证的行为 | 探针 | 状态 |
|---|---|---|---|
| P-1 | resume 后上下文保留 | kill 进程 → `--session <file> --mode rpc` 重开 → 问「秘密数字」→ 答 42 | ✅ 实测 PASS |
| P-2 | prompt 续聊触发新 run | 保活进程第二轮 prompt → startCount 2→4、答 42 | ✅ 实测 PASS |
| P-3 | steer/follow_up 完成后不触发 | agent_end 后 3s 发 follow_up → 60s 无新 agent_end | ✅ 实测 FAIL（符合预期，决策 1 依据） |
| P-4 | busy 时 stdin 直写 prompt 排队行为 | 子进程运行中（长任务）写第二条 prompt → 观察第二条是否当前轮后处理、顺序保持 | ⛔ 实施期 M2 前 |
| P-5 | resume 后 worktree 内文件可见 | 对话模式 subagent 改过文件 → resume 重开 read 同路径 | ⛔ 实施期 M2 前 |
| P-6 | idle 记录跨重启可寻址 | 主 agent 重启后 `list` → 对话中 subagent 显示 idle（`.idle` sidecar 重建） | ⛔ 实施期 M3 前 |
| P-7 | 归属守卫拦截 | 用别的 sessionId 驱动某 subagent → 拒绝 not owned | ⛔ 实施期 M3 前 |
| P-8 | resume 后 session 文件续写同一文件 | resume 后新消息的 entry 写入同一 `<ts>_<sessionId>.jsonl`（文件名不变） | ⛔ 实施期 M1 前 |
| P-9 | identity entry 重复 append 无害 | resume 多轮后 reconstructFromFile 正常（last-wins，数据相同） | ⛔ 实施期 M1 前 |

> 探针规则（准则 7）：✅ = 已实测；⛔ = 实施期对应阶段前必须跑通的门槛，跑不通则该断言从文档移除、设计需重审。

---

## §4 验收（真实场景，非单测非 mock）

**改动规模**：大（新功能 + 行为变更 + 接口扩展）。以下每个场景回溯 §1 目标。

### 场景 A：多轮 review 对话（回溯 G1 + G2）

- **上下文**：真实项目（本 worktree），目标文件 `extensions/subagent-workflow/src/execution/record-store.ts`（真实存在）。
- **步骤**：① `start {task:"review record-store.ts 的重建逻辑", agent:"reviewer", mode:"conversation"}`；② 等 notify 拿到第一轮 review 结果；③ `message {subagentId, text:"针对你发现的矩阵兜底问题给出修复方案，先不改代码"}`；④ 等 notify；⑤ 检查第二轮回复。
- **通过标准**：第二轮回复明确引用第一轮的具体发现（如提到「兜底 crashed」或同一函数），证明上下文跨轮保留；全程只 spawn 了一个子进程（`list` 中 subagentId 不变）；**机制侧断言**：第二轮 message 后，session 文件含第一轮全部 entry（`get_entries` 或直接读 JSONL 验证），不依赖 LLM 表现判定。
- **注意**：若模型未引用第一轮内容（压缩/偷懒），以机制侧断言（session 文件 entry 完整）为通过标准，LLM 引用仅作参考。

### 场景 B：回复前插入消息（回溯 G3）

- **上下文**：让 subagent 跑一个长任务（如「分析 `extensions/subagent-workflow/src/execution/` 目录的文件职责」）。
- **步骤**：① start（对话模式）；② 在它运行中（`list` 显示 running）连发两条 `message`（补充约束）；③ 等 notify；④ 检查最终结果是否体现补充约束。
- **通过标准**：两条 message 均返回 `delivered:true`（非阻塞）；subagent 最终结果体现后发的约束（说明排队按序处理）；无报错。

### 场景 C：会话重启后恢复（回溯 G4）

- **上下文**：对话进行中（subagent 已完成一轮、idle）。
- **步骤**：① 重启主 agent 会话（新 pi 进程、同 session-dir）；② `list` 应显示该 subagent（`.idle` sidecar 重建，状态 idle）；③ `message` 续聊；④ 等 notify。
- **通过标准**：续聊回复引用重启前的对话内容（上下文保留）；无「subagent not found」；重启后 session 文件仍是同一文件（P-8）。

### 场景 D：归属守卫与清理（回溯 G5 + 决策 3）

- **上下文**：两个主 agent 会话（两个 pi 进程、同 session-dir）。
- **步骤**：① 会话 1 spawn 对话模式 subagent；② 会话 2 对该 subagentId 发 `message`；③ 会话 1 发 `close`；④ 再对已 close 的 id 发 `message`。
- **通过标准**：② 被拒（`not owned`，含恢复指引）；③ 正常关闭；④ 被拒（`not found`，含恢复指引）；close 后 `.idle` sidecar 删除、磁盘记录归档、worktree 清理（与一次性模式一致）。

### 场景 E：一次性模式无回归（回溯 G5）

- **上下文**：与现状相同的用法。
- **步骤**：不传 `mode:"conversation"` 的 start → 行为与现在完全一致（跑完通知、archive、worktree cleanup）。
- **通过标准**：现有一次性用例（`run-spawn-integration.test.ts` 等）全绿；手动跑一次普通 start，`list` 显示 done 且无 idle 残留。

### 场景 F：错误恢复路径（回溯 G4 + §3.1 失败表）

- **上下文**：对话中 subagent 的 session 文件被手动删除（模拟损坏/GC）。
- **步骤**：① 删除 `<sessionFile>`；② 对该 id 发 `message`。
- **通过标准**：返回 `session file missing or unreadable` + 恢复指引（`close` 后重新 `start`）；`list` 不崩溃。
- **上下文 2**：排队消息场景——subagent busy 时发 message（`queued:true`），随即主 agent 重启。
- **通过标准 2**：重启后该消息不投递（限制声明），重发消息正常；不崩溃。

> 单元测试仅作回归辅助，不计入验收。验收以场景 A-F 在真实环境实跑为准。

---

## §5 下一层拆分

### 实施路径（分阶段，每阶段可独立验收）

| 阶段 | 交付 | 对应验收/探针 |
|---|---|---|
| M1：resume spawn 基建 | spawn 支持 `--session <file>` 重开 + 恢复 record 上下文（sessionFile 已知时跳过 handshake 创建） | P-8/P-9 + 场景 C 前半 |
| M2：对话模式执行语义 | start 的 `mode:"conversation"`（chatMode 标志）；轮次完成 → 进程回收 + 写 `.idle` sidecar + record 标记 idle（不 archive）；message/close action；record→child 映射 | P-4/P-5 + 场景 A/B |
| M3：守卫、重建与展示 | rootSessionId 归属守卫；reconstructAll 加 `.idle` 分支；worktree reaper 豁免；notifier dedup 豁免 + idle 守卫；list/format/gui-mappers idle 展示 | P-6/P-7 + 场景 C/D/E/F |

### 拆分清单

1. **spawn resume 支持**（`pi-invocation.ts` + `subprocess-agent-runner.ts`）：args 组装支持 `--session <sessionFile>`；`get-state-handshake` 适配「已存在 session」路径（sessionFile 提前已知，握手只验证不创建）。理由：一切续聊的地基，独立可测。
2. **状态机扩展**（`execution/types.ts`）：`ExecutionStatus` 增加 `"idle"`；`finalize-record.ts` 拆「轮次完成（→idle：写 `.idle` sidecar、保留 record 与 worktree、release 并发槽）」「最终关闭（→done：删 `.idle`、走现有 finalize 清理）」。理由：终态语义是「完成即销毁」假设的核心，必须先立。
3. **chatMode 标志**（`execution/execution-record.ts` identity entry）：record 持久化 `chatMode: boolean`，随 identity entry 写入 session 文件；不扩展 ExecutionMode（决策 8）。理由：避免波及 mode 消费点（isIdentityData 校验等）。
4. **新 action**（`interface/subagent-tool.ts` + `subagent-actions.ts`）：`message`（定位 record → busy 走 stdin / idle 走 resume → prompt）、`close`（finalize）。**无 wait**（决策 7）。理由：使用者可见的全部新能力，依赖 1+2。
5. **record→child 映射**（`execution/session-runner.ts`）：`spawnedChildren` Set → `Map<recordId, ChildProcess>`，busy 投递定位活进程。理由：busy 时消息必须写活进程 stdin（决策 6），现有结构无 id 关联（`spawnedChildren` Set 定义于 `session-runner.ts:193`）。
6. **归属守卫**（`subagent-actions.ts`）：`rootSessionId` 比对（决策 3）；跨进程定位需绕过 collectRecords 过滤查磁盘全集。理由：并发安全，依赖 4 的定位逻辑。
7. **重建矩阵 + reaper 豁免 + notifier 适配**（`record-store.ts`、`worktree-manager.ts`/`worktree-registry.ts`、`notifier.ts`）：`.idle` 分支重建；reaper 判据「pid 死且无 `.idle`」；notifier dedup 按轮次 + 状态守卫加 idle。理由：G4 可恢复性与 G1 通知可靠性的三块基石，互相独立可分批验证。
8. **list/状态展示**（`record-store.ts` collectRecords + `interface/subagents.ts` + `interface/format.ts` + `interface/gui-mappers.ts` + `interface/list-component.ts`）：idle 态合并展示；format statusIcon/gui-mappers 字符串匹配补 idle case（否则 idle 落入 running/done 错误语义）。理由：G4 的用户可见面，依赖 2+7。

### 文件改动地图

| 文件 | 改动 |
|---|---|
| `execution/pi-invocation.ts` | spawn args 支持 `--session` |
| `execution/subprocess-agent-runner.ts` | resume 路径（sessionFile 已知） |
| `execution/get-state-handshake.ts` | 已存在 session 的握手适配 |
| `execution/types.ts` | ExecutionStatus + `"idle"` |
| `execution/execution-record.ts` | identity entry + `chatMode` 字段 |
| `execution/finalize-record.ts` | 轮次完成 vs 最终关闭分流 + `.idle` sidecar 写删 |
| `execution/session-runner.ts` | `spawnedChildren` → `Map<recordId, child>`（kill 分支不改） |
| `interface/subagent-tool.ts` | schema：action 枚举 + `mode` 参数 + message/close 参数 |
| `interface/subagent-actions.ts` | 新 action handler + rootSessionId 守卫 |
| `execution/record-store.ts` | idle 态不进 archive；重建矩阵 `.idle` 分支；STATUS_PRIORITY 补 `idle` 键（`Record<ExecutionStatus, number>` 字面量缺键触发 TS2741） |
| `execution/worktree-manager.ts` + `worktree-registry.ts` | reaper 判据加「无 `.idle` 才清理」 |
| `execution/notifier.ts` | 对话模式 dedup 按轮次 + status 守卫加 idle |
| `interface/format.ts` / `gui-mappers.ts` / `list-component.ts` / `subagents.ts` | idle 展示语义 |

### 待验证检查点（实施期）

- P-4：busy 时 stdin 直写 prompt 的排队行为（顺序保证、与 abort 交互）
- P-5：resume 后 worktree 文件可见性（`--session` 打开时 cwd 是否保持）
- `cancel` 在对话模式下的语义（取消当前轮 vs 结束整个对话）——第一版取「取消当前轮，进程退出，会话文件保留可 resume」（与现状 cancel 一致），实施时验证
- resume 的执行参数（maxTurns/graceTurns/fork/appendSystemPrompt）持久化——第一版**不恢复**执行约束（resume 只带 session 不带约束），后果：maxTurns 每轮重置为全量预算；若后续需要再持久化到 identity entry
- 30 天 session 文件 GC（`session-file-gc.ts` TTL_DAYS=30）与 G4 的边界：idle 超过 30 天的对话 session 文件被删 → 句柄失效——第一版接受该寿命上限（恢复指引：重新 start），后续可豁免对话模式

---

## 附录：调研与实测记录（背景，不参与设计裁决）

- **参考实现**：pi-intercom（ask 挂起 + reply 配对，跨 session broker）；nicobailon/pi-subagents（子→父 contact_supervisor 桥接）；Kimi Code CLI（同进程 DI + `agent_id` resume 句柄 + 归属/idle 双守卫，`agent-core-v2/src/session/swarm/`）；Claude Code Agent Teams（文件 mailbox + 轮询，in-process teammate 常驻 loop / transcript resume，`src/utils/teammateMailbox.ts` + `src/tools/SendMessageTool/SendMessageTool.ts`）。
- **实测**：本地 pi CLI（`--mode rpc`，mimo-v2.5-pro）：resume 上下文保留 PASS；prompt 续聊多轮累积 PASS；steer/follow_up 完成后不触发 FAIL（即正确行为）；idle 进程 RSS ~147MB / CPU 0%。
- **审查**：设计经对抗式审查一轮（9 must-fix 全部修复：归属字段 parentRecordId→rootSessionId、idle 重建矩阵 `.idle` sidecar、worktree reaper 豁免、notifier dedup 豁免、删除 wait、验收上下文改真实文件、idle 进程语义裁定 kill+resume、record→child 映射、ExecutionMode 不扩展）。审查报告见同目录 `continuous-subagent-chat.review.md`。
- **结论**：三家一致支持「文件为状态源 + resume 为持续对话主路径」；无一家依赖中央 broker。
