# 可持续对话 subagent（Continuous Chat）设计文档

> **一句话结论**：把 subagent 从「一次性执行」扩展为「可持续对话」——用 **`record.id` 作持久句柄 + session 文件作状态源 + resume 重开（`--session <file> --mode rpc`）+ `prompt` 命令续聊**，不引入 broker/通信通道。三项关键能力（resume 上下文保留、prompt 续聊、steer/follow_up 完成后无效）均已本地 pi 实测验证。**不新增 wait action**（回复经现有 notify 异步送达，阻塞等待是负收益）；**不扩展 ExecutionMode**（对话模式用独立标志，避免波及模式消费点）。

## 层声明

- **当前层**：功能设计（subagent 工具的执行语义扩展 + 接口扩展）
- **下一层**：可实现的接口/数据模型/技术方案 + 具体代码任务
- 涉及运行时行为、进程数据流、错误处理 → 设计准则 5（数据流图）/ 6（错误恢复）/ 7（探针）全部 P0 适用

### 设计准则（贯穿全文）

**tool schema 是 LLM 的产品界面，不是底层机制的透传层。** LLM 该学的是「意图词汇」（打断还是排队、结束还是暂停），不该学 pi 的私有术语（prompt/steer/follow_up/resume/sidecar/cancelled）。技术调研越深入，越应该把复杂度封在底下——调研的目的是让底层自动选对实现，不是让 agent 参与选择。

执行细则（§3.3 决策 10）：
- schema 与 tool description 只出现意图词汇与行为承诺，机制词汇禁入
- 对外状态收敛为四态（active/waiting/ended/error），内部 ExecutionStatus 进 details
- 响应 payload 主字段只有意图与结果；机制痕迹（sessionFile/resumed/queued/steered）退到 details 与错误消息
- 错误消息用 agent 能行动的语言，不出现内部词汇

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
| G3 | 回复前可插入新消息（轮间插入 + 轮中干预） | 不等回复，连续发多条消息（busy 时排队，当前轮后按序处理）；subagent 跑偏时可立即打断干预（streaming 抢占，实测可行） |
| G4 | 对话可恢复 | 进程/会话重启后，仍能找到之前的 subagent 并续聊（句柄持久化） |
| G5 | 不误伤现有模式 | 一次性 subagent（默认行为）不受影响；对话模式是显式 opt-in |

### In-scope / Out-of-scope

**In-scope**：
- subagent 工具新增 action：`message`（续聊/插入）、`close`（结束对话）
- start 新增对话模式选项（`conversation:true`）；record 生命周期扩展「对话中」语义
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

#### 成功路径：多轮 review 对话（新 tool surface）

```
[主 agent] {"action":"start","task":"review record-store.ts 的重建逻辑","slug":"review-rs","agent":"reviewer","conversation":true}
→ { subagentId:"sa-abc123" }                          ← 主字段只有意图结果

[subagent 完成第一轮 review]  →  notify 唤醒主 agent："review-rs 完成，发现 3 个问题：..."

[主 agent] {"action":"message","subagentId":"sa-abc123","text":"第 2 个问题请给出具体修复方案，先不要改代码"}
→ { delivered:true }                                  ← 不打断（interrupt 默认 false），等当前轮说完

[subagent 回复]  →  notify 唤醒主 agent，携带修复方案

[主 agent] {"action":"message","subagentId":"sa-abc123","text":"方案可以，开始改。改完跑测试。"}
→ { delivered:true }

[subagent 改完]  →  notify："修复完成，测试通过"

[主 agent] {"action":"close","subagentId":"sa-abc123"}
→ { closed:true }                                     ← 优雅关闭：当前轮跑完再终态化
```

#### 插入消息路径（回复前补充信息 + 轮中打断）

```
[subagent 正在跑第一轮 review]（主 agent 想补充约束，不打断当前工作）
[主 agent] {"action":"message","subagentId":"sa-abc123","text":"补充：忽略测试文件，只看生产代码"}   ← interrupt 默认 false
→ { delivered:true }                        ← busy：底层发 follow_up（pi 原生排队，当前轮后按序处理）

[subagent 跑偏了，主 agent 要立即打断纠正]（streaming 抢占）
[主 agent] {"action":"message","subagentId":"sa-abc123","text":"方向错了！改为只分析错误处理部分","interrupt":true}
→ { delivered:true }                        ← busy：底层发 steer（实测：streaming 中抢占成功，原任务输出停止）

[subagent 已完成、进程已回收]（idle，两种 interrupt 同路径）
[主 agent] {"action":"message","subagentId":"sa-abc123","text":"继续：把发现的第 1 个问题也修了"}
→ { delivered:true }                        ← idle：底层 resume 重开 session 后 prompt（interrupt 自动退化，agent 无需感知）
```

#### 失败路径与恢复指引（错误消息只用行动语言）

| 失败 | 现象（agent 看到的） | 恢复指引 |
|---|---|---|
| subagent 不存在 / 已 close / 非本 session 所有 | `subagent not found or not owned: sa-abc123` | `list` 确认 id；已结束的用 `close` 清理后重新 `start`；非本 session 所有则无法操作 |
| 进程忙且 stdin 写入失败（进程刚退） | `delivery delayed, will retry` | 底层自动入队并在当前轮结束后补投；无需用户干预；若持续失败稍后重发 |
| 投递后进程死亡（竞态窗口，见决策 6） | （消费确认制自动补投，agent 无感） | 无需用户干预；若 resume 也失败按下行处理 |
| 进程崩溃 / 会话文件损坏 | `session unavailable: <path>` | `list` 确认状态；`close` 清理后重新 `start` |
| 并发槽位占满（resume 时） | `too many subagents running, retry later` | 稍后重试，或 `close` 不用的 subagent 释放槽位 |
| 续聊后 subagent 无限循环 | `message` 每次都能投递，无自然停止 | 用 `close`（或 `close force:true`）显式结束 |
| 排队消息因主 agent 重启丢失 | 重启后 `message` 重发 | 重发消息即可；排队消息不持久化（见决策 6 限制声明） |

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

#### 决策 1：续聊命令按 agent 状态分派 —— 完整能力矩阵（全部实测）

- **选择**：idle/完成后续聊用 `prompt` 命令；running 中插话用 `steer`（抢占）/ `follow_up`（排队）命令。
- **能力矩阵**（本地 pi CLI 实测 + xyz-agent 现成实现佐证）：

| 时机 | `prompt` | `steer` | `follow_up` |
|---|---|---|---|
| **running（streaming 中）** | ⚠️ 需 streamingBehavior 参数（xyz-agent 注释称 isStreaming 时强制，P-4 待实测）；无则可能被拒 | ✅ **抢占**（实测：streaming 中发 steer，原任务输出停止、回复切换为新问题） | ✅ 排队（pi 原生语义，xyz-agent Alt+⏎ 在用，P-4 待实测） |
| **idle（完成后）** | ✅ 触发新 run，上下文保留（实测 PASS） | ❌ 只入队不触发（实测 FAIL） | ❌ 只入队不触发（实测 FAIL） |

- **证据**：
  - idle 场景：pi 源码 `agent.ts` 的 `steer()`/`followUp()` 只 `enqueue`；`agent-session.ts` 的 `_runAgentPrompt` 的 `while (_handlePostAgentRun())` 循环在 agent_end 发出后**同步**检查完队列并退出。`prompt` 命令走 `session.prompt()` 触发新 run，实测两轮续聊上下文正确累积（42 → 42+7=49）。
  - running 场景：agent loop 的 `getSteeringMessages`/`getFollowUpMessages` 在**每轮 turn 之间 drain 队列**（`agent.ts` prepareNextTurn 回调）——运行中有效。实测：76 条 text_delta 后发 steer，最终回复切换为新问题（"1+1=2"）。
  - xyz-agent 佐证：composer 的 ⏎（isActive 时）→ `message.steer`、Alt+⏎ → `message.follow_up`、busy 时普通发送自动降级 steer（`useChat.ts:298-307`），runtime 纯透传（`rpc-client.ts:495-500` `sendCommand('steer'/'follow_up')`），效果依赖 pi 原生语义。
- **探针**：§3.4 P-1/P-2/P-3/P-4。

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
- **cancel 语义裁决（对话模式）**：`close` 是唯一终态动词（`close {force?}`，见决策 10）；对话模式**无独立 cancel 动词**。「停当前轮但保留对话」由 `message {interrupt:true}` 覆盖（打断必然带新指令）。一次性模式的旧 `cancel` 保留为 `close(force:true)` 的别名，不出现在 tool description 主路径。**被否**：「对话模式 cancel → 写 `.cancelled` 终态」（丢上下文，正是 F2 痛点）；「cancel → idle 但保留独立动词」（动词数与意图不匹配，agent 心智负担）。
- **被否**：复用 `running` 表示对话中——list 状态无法区分「正在跑」和「在等下一轮」，且磁盘重建无法区分；`running` 语义被破坏。
- **影响**：`finalize-record.ts` 拆出「轮次完成（→idle，保留 worktree）」与「最终关闭（→done + 现有清理）」两条路径。

#### 决策 6：消息投递 —— 状态 × interrupt 映射 + 消费确认制（消除 busy→kill 竞态丢消息）

- **选择**：`message` 的投递路径按 record 状态 × `interrupt` 布尔映射（agent 只表达意图，实现自动选择，见决策 10）：

| 状态 | interrupt=false（不打断） | interrupt=true（立即打断） |
|---|---|---|
| running（busy） | 写活进程 stdin `follow_up`（pi 原生排队，当前轮后按序） | 写活进程 stdin `steer`（pi 原生抢占，实测成功） |
| idle / done（已回收） | resume spawn + prompt | resume spawn + prompt（idle 无东西可打断，interrupt 自动退化） |

  - 需要 **record→ChildProcess 映射**——现有 `spawnedChildren` Set（`session-runner.ts:193`）无 id 关联，改为 `Map<recordId, ChildProcess>`（或等价注册表）
- **竞态窗口（必须正视，不能靠 "by construction 互斥"）**：kill 的触发点是 stdout pump 读到 `agent_end` 行时同步发出（`session-runner.ts:855` 起），而 message 写 stdin 走独立通道——存在窗口：① 扩展查 record 仍是 running（agent_end 行未消费）→ 走 busy 分支写 stdin 成功；② pump 随后读到 agent_end → SIGTERM；③ 消息随进程死亡静默丢失（写入成功 ≠ 被消费）。
- **裁决：消费确认制**——投递时把消息缓存进 `record.pendingMessages`（内存数组），投递后观察确认：
  - **不变式：`pendingMessages` 只在观察到该消息的消费确认（`message_start` 事件，user 消息）时清除**；进程退出时剩余未确认消息**一律** resume 补投；「2s 无确认且进程存活 → 视为成功」只约束工具调用返回值，**不动安全网**——确认语义跟随消费而非跟随投递（busy+queue 路径消费可能迟到数分钟，确认迟到无妨）
  - 消息与 message_start 的关联策略：按 subagentId 内 **FIFO 顺序匹配**（同一 subagent 的 message 按发送序消费；同文重发场景以投递时序为准，P-12 验证）
  - 未确认消息随主 agent 进程重启丢失（限制声明同前，不落盘）
- **被否**：busy 时也 resume 重开——两个进程打开同一 session 文件，pi 无文件锁语义（未探针），并发写损坏风险不可接受。
- **探针**：P-4（busy 时 follow_up 排队行为）、P-5（resume 后文件可见性）、P-12（消费确认制在竞态窗口下不丢消息）。

#### 决策 10：tool surface 只暴露意图词汇，机制词汇禁入

- **选择**：schema 与 tool description 层封装全部机制（底层决策 1-9 的实现细节），agent 只接触意图词汇。**最终 tool surface**：

```
start   { task, slug?, agent?, model?, conversation?: boolean }  → { subagentId }
message { subagentId, text, interrupt?: boolean }                → { delivered: true }
close   { subagentId, force?: boolean }                          → { closed: true }
list    { statusFilter? }                                        → { items: [{ subagentId, slug, state, summary }] }
```

- 执行细则：
  1. **interrupt 布尔**替代 `deliverAs`——agent 的意图只有「不打断，这轮说完再看」/「立即停下听我说」；idle 时 interrupt 自动退化（决策 6 映射表），agent 不需要知道「idle 时 steer 无效」这个坑
  2. **close {force}** 合并 cancel/close 两个动词——`force:false`（默认）当前轮跑完再终态化；`force:true` 立即终止；一次性模式的旧 `cancel` 保留为 `close(force:true)` 别名，不出现在 description 主路径
  3. **状态对外四态收敛**——`active`（running）/ `waiting`（idle）/ `ended`（done/cancelled）/ `error`（failed/crashed）；原始 ExecutionStatus 进 `details` 供调试；未来内部加态不影响对外
  4. **响应 payload 瘦身**——`start` → `{subagentId}`（sessionFile 移入 details，防诱导 agent 绕开工具读文件）；`message` → `{delivered:true}`；`close` → `{closed:true}`；resume 冷启 ~1.5s 的延迟预期写进 tool description（「对方不在线时唤醒需一两秒，属正常」），不作为返回值暴露
  5. **`conversation: boolean`** 替代 `mode:"conversation"`——语义是「声明资源生命周期」：轮次结束不回收 worktree、记录不归档、占用 idle 名额直到 close 或 GC；description 写明代价「会持续占用资源直到 close，记得用完 close」；布尔比枚举更难误用，未来出第三模式再升枚举不破坏布尔
  6. **错误消息只用行动语言**——失败表的文案已遵守（见 §3.1），内部词汇（sidecar/resume/pendingMessages/prompt）禁入
- **被否**：把机制选择暴露给 agent（deliverAs/prompt/steer/follow_up/sessionFile/queued/steered/resumed）——agent 被迫学习 pi 私有术语与「何时何命令有效」的矩阵，心智负担转移给使用者，且未来底层实现变更会破坏 agent 已形成的错误心智。
- **反向提醒（不封掉的东西）**：`list` 的 `summary`（每轮结果摘要）与 notify 的轮次送达是 agent 维持对话心智的必需反馈，不能封装；封装的原则是「主字段只有意图与结果，机制痕迹退到 details 和错误消息」。

#### 决策 7：不新增 `wait` action —— 减法

- **选择**：删除设计中的阻塞 `wait`。G1「分派后可等待回复」由现有 notify（triggerTurn steer 异步唤醒）完整覆盖——subagent 每轮回复都唤醒主 agent，无需阻塞等待。
- **被否**：阻塞式 wait——(a) 语义矛盾：wait 等「回复」时 subagent 必然 running，但 running 时阻塞 tool call 挂起 LLM turn，主 agent 无法并行做任何事（与 G3「插入消息」直接冲突）；(b) 机制缺口：阻塞 tool 等异步 agent_end 需要事件桥接（tool handler 是同步执行的），且 wait 返回后 BgNotifier 的 triggerTurn 会重复注入 → 双通道重复消费；(c) 收益为零：notify 已送达。
- **证据**：现有 `subagent-bg-notify`（`notifier.ts` doSend：`triggerTurn:true + deliverAs:"steer"`）即「完成即唤醒」的现成机制。

#### 决策 8：不扩展 ExecutionMode —— 独立 chatMode 标志

- **选择**：对话模式**不**新增 ExecutionMode 值，`mode` 仍为 `"background"`；改用 record 上的独立字段（如 `chatMode: boolean`）标记对话模式，随 identity entry 持久化（`.idle` sidecar 也带该标志）。
- **被否**：扩展 ExecutionMode——会命中全部消费点：`session-reconstructor.ts` isIdentityData 校验 `mode ∈ {sync, background}`（对话 record 重启后重建直接失败 → list 看不到）、`subagent-service.ts:757` pooled 判定、`cancelHandler` 的 `mode !== "background"` 抛 unsupported、`hasRunningBackground` 统计、`record-store.ts` STATUS_PRIORITY 排序。每个都要改且语义互相纠缠。
- **附带决策**：对话模式照常占并发槽位（pool acquire/release 不变）；轮次间 idle 不占槽（轮次结束 release，resume 时重新 acquire）——实现细节在 M2 验证。

#### 决策 9：notifier 对话模式豁免 dedup + 状态守卫扩展

- **选择**：`BgNotifier` 的 60s dedup TTL（`notifier.ts` DEDUP_TTL_MS=60000，同 subagentId 60s 内第二次 notify 静默跳过）对对话模式**豁免**——按「轮次」去重而非按 subagentId；`toNotifyRecord` 的 status 守卫（现只放行 done/failed/cancelled）增加 idle 分支。
- **轮次序号来源**：notify 发送（轮次完成时）与 `.idle` sidecar 写入的先后不定——**轮次计数用内存 record 的轮次字段（每轮完成 +1），不依赖 sidecar 读取**（sidecar 的 round 仅用于磁盘重建恢复计数）。
- **被否**：对话模式继续走 60s dedup——快速多轮（message → 回复间隔 <60s）第二条回复通知被吞，父 agent 永远等不到回复，G1/G2 断裂。
- **证据**：`notifier.ts` 现有 dedup 语义（一次性模式防抖）；对话模式的回复是**每轮必须送达**的语义，两者冲突。

### 3.4 探针清单（运行时断言 → 证据）

| ID | 验证的行为 | 探针 | 状态 |
|---|---|---|---|
| P-1 | resume 后上下文保留 | kill 进程 → `--session <file> --mode rpc` 重开 → 问「秘密数字」→ 答 42 | ✅ 实测 PASS |
| P-2 | prompt 续聊触发新 run | 保活进程第二轮 prompt → startCount 2→4、答 42 | ✅ 实测 PASS |
| P-3 | steer/follow_up 完成后不触发 | agent_end 后 3s 发 follow_up → 60s 无新 agent_end | ✅ 实测 FAIL（符合预期，决策 1 依据） |
| P-4 | busy 时 follow_up 排队行为 + **排队消息不被误杀** | 子进程运行中发 `follow_up`：顺序保持、当前轮后处理、**agent_end 不在该消息被消费前发出**（排队消息若被 pi post-run loop 在 agent_end 前 drain，进程自然续命；反之每个排队消息都要走 kill+resume 补投，"当前轮后按序处理"承诺失效）；顺带验证「isStreaming 时 prompt 强制要求 streamingBehavior」的 xyz-agent 断言 | ⛔ 实施期 M2 前 |
| P-5 | resume 后 worktree 内文件可见 | 对话模式 subagent 改过文件 → resume 重开 read 同路径 | ⛔ 实施期 M2 前 |
| P-6 | idle 记录跨重启可寻址 | 主 agent 重启后 `list` → 对话中 subagent 显示 idle（`.idle` sidecar 重建） | ⛔ 实施期 M3 前 |
| P-7 | 归属守卫拦截 | 用别的 sessionId 驱动某 subagent → 拒绝 not owned | ⛔ 实施期 M3 前 |
| P-8 | resume 后 session 文件续写同一文件 | resume 后新消息的 entry 写入同一 `<ts>_<sessionId>.jsonl`（文件名不变） | ⛔ 实施期 M1 前 |
| P-9 | identity entry 重复 append 无害 | resume 多轮后 reconstructFromFile 正常（last-wins，数据相同） | ⛔ 实施期 M1 前 |
| P-10 | resume 后模型保持 | 以非默认模型 spawn 的对话 subagent resume 后仍是原模型（`get_state` 验证，不落回 CLI 默认） | ⛔ 实施期 M1 前 |
| P-11 | 旧版扩展读 chatMode identity 兼容 | 属性级 type guard（isIdentityData）对带 `chatMode` 字段的 identity entry 不拒（新旧扩展混存场景） | ⛔ 实施期 M3 前 |
| P-12 | 消费确认制在竞态窗口下不丢消息 | 模拟 busy→kill 竞态（长任务中投递 message，进程被 agent_end 回收）→ 消息经 resume 补投，不静默丢失；**验证消息与 message_start 的 FIFO 关联策略**（同文重发、乱序到达场景） | ⛔ 实施期 M2 前 |

> 探针规则（准则 7）：✅ = 已实测；⛔ = 实施期对应阶段前必须跑通的门槛，跑不通则该断言从文档移除、设计需重审。

---

## §4 验收（真实场景，非单测非 mock）

**改动规模**：大（新功能 + 行为变更 + 接口扩展）。以下每个场景回溯 §1 目标。

### 场景 A：多轮 review 对话（回溯 G1 + G2）

- **上下文**：真实项目（本 worktree），目标文件 `extensions/subagent-workflow/src/execution/record-store.ts`（真实存在）。
- **步骤**：① `start {task:"review record-store.ts 的重建逻辑", agent:"reviewer", conversation:true}`；② 等 notify 拿到第一轮 review 结果；③ `message {subagentId, text:"针对你发现的矩阵兜底问题给出修复方案，先不改代码"}`；④ 等 notify；⑤ 检查第二轮回复。
- **通过标准**：第二轮回复明确引用第一轮的具体发现（如提到「兜底 crashed」或同一函数），证明上下文跨轮保留；全程只 spawn 了一个子进程（`list` 中 subagentId 不变）；**机制侧断言**：第二轮 message 后，session 文件含第一轮全部 entry（`get_entries` 或直接读 JSONL 验证），不依赖 LLM 表现判定。
- **注意**：若模型未引用第一轮内容（压缩/偷懒），以机制侧断言（session 文件 entry 完整）为通过标准，LLM 引用仅作参考。

### 场景 B：回复前插入消息 + 轮中干预（回溯 G3）

- **上下文**：让 subagent 跑一个长任务（如「分析 `extensions/subagent-workflow/src/execution/` 目录的文件职责」）。
- **步骤**：① `start {conversation:true}`；② 运行中（`list` 显示 active）连发两条 `message`（补充约束，interrupt 默认 false）；③ 再发一条 `interrupt:true` 的 message（改变方向/纠正）；④ 等 notify；⑤ 检查最终结果。
- **通过标准**：前两条 message 返回 `delivered:true`（非阻塞）；interrupt 消息在 streaming 中生效（原任务输出被打断，最终结果体现新方向）；最终结果体现补充约束（排队按序处理）；无报错。

### 场景 C：会话重启后恢复（回溯 G4）

- **上下文**：对话进行中（subagent 已完成一轮、idle）。
- **步骤**：① 重启主 agent 会话（新 pi 进程、同 session-dir）；② `list` 应显示该 subagent（`.idle` sidecar 重建，状态 idle）；③ `message` 续聊；④ 等 notify。
- **通过标准**：续聊回复引用重启前的对话内容（上下文保留）；无「subagent not found」；重启后 session 文件仍是同一文件（P-8）。

### 场景 D：归属守卫与清理（回溯 G5 + 决策 3）

- **上下文**：两个主 agent 会话（两个 pi 进程、同 session-dir）。
- **步骤**：① 会话 1 `start {conversation:true}`；② 会话 2 对该 subagentId 发 `message`；③ 会话 1 发 `close`；④ 再对已 close 的 id 发 `message`。
- **通过标准**：② 被拒（`not found or not owned`，含恢复指引）；③ 正常关闭；④ 被拒（`not found`，含恢复指引）；close 后 `.idle` sidecar 删除、磁盘记录归档、worktree 清理（与一次性模式一致）。

### 场景 E：一次性模式无回归（回溯 G5）

- **上下文**：与现状相同的用法（旧 `cancel` 动词仍可用，作为 `close(force:true)` 别名）。
- **步骤**：不传 `conversation` 的 start → 行为与现在完全一致（跑完通知、archive、worktree cleanup）；旧 cancel 调用路径回归。
- **通过标准**：现有一次性用例（`run-spawn-integration.test.ts` 等）全绿；手动跑一次普通 start，`list` 显示 ended 且无 idle 残留。

### 场景 F：错误恢复路径（回溯 G4 + §3.1 失败表）

- **上下文**：对话中 subagent 的 session 文件被手动删除（模拟损坏/GC）。
- **步骤**：① 删除 `<sessionFile>`；② 对该 id 发 `message`。
- **通过标准**：返回 `session file missing or unreadable` + 恢复指引（`close` 后重新 `start`）；`list` 不崩溃。
- **上下文 2**：排队消息场景——subagent busy 时发 message（`delivered:true`，排队中），随即主 agent 重启。
- **通过标准 2**：重启后该消息不投递（限制声明），重发消息正常；不崩溃。

> 单元测试仅作回归辅助，不计入验收。验收以场景 A-F 在真实环境实跑为准。

---

## §5 下一层拆分

### 实施路径（分阶段，每阶段可独立验收）

| 阶段 | 交付 | 对应验收/探针 |
|---|---|---|
| M1：resume spawn 基建 | spawn 支持 `--session <file>` 重开 + 恢复 record 上下文（sessionFile 已知时跳过 handshake 创建）+ **执行参数传递（model/thinkingLevel，见拆分 1）** | P-8/P-9/P-10 + 场景 C 前半 |
| M2：对话模式执行语义 | start 的 `conversation:true`（chatMode 标志）；轮次完成 → 进程回收 + 写 `.idle` sidecar + record 标记 idle（不 archive）；message/close action（interrupt/force 映射）；record→child 映射；消费确认制 | P-4/P-5/P-12 + 场景 A/B |
| M3：守卫、重建与展示 | rootSessionId 归属守卫；reconstructAll 加 `.idle` 分支；worktree reaper 豁免；notifier dedup 豁免 + idle 守卫；list 对外四态（active/waiting/ended/error）展示 | P-6/P-7/P-11 + 场景 C/D/E/F |

### 拆分清单

1. **spawn resume 支持**（`pi-invocation.ts` + `subprocess-agent-runner.ts`）：args 组装支持 `--session <sessionFile>`；`get-state-handshake` 适配「已存在 session」路径（sessionFile 提前已知，握手只验证不创建）。**执行参数传递**：resume spawn 从 record identity 读取 `model`/`thinkingLevel` 并继续传 `--model`/`--thinking`，防止多轮对话中途模型漂移（P-10）；maxTurns 等执行约束第一版不恢复（见待验证检查点）。理由：一切续聊的地基，独立可测。
2. **状态机扩展**（`execution/types.ts`）：`ExecutionStatus` 增加 `"idle"`；`finalize-record.ts` 拆「轮次完成（→idle：写 `.idle` sidecar、保留 record 与 worktree、release 并发槽）」「最终关闭（→done：删 `.idle`、走现有 finalize 清理）」。理由：终态语义是「完成即销毁」假设的核心，必须先立。
3. **chatMode 标志**（`execution/execution-record.ts` identity entry）：record 持久化 `chatMode: boolean`，随 identity entry 写入 session 文件；不扩展 ExecutionMode（决策 8）。理由：避免波及 mode 消费点（isIdentityData 校验等）。
4. **新 action**（`interface/subagent-tool.ts` + `subagent-actions.ts`）：`message`（状态 × interrupt 映射投递 + **消费确认制**：投递缓存 record.pendingMessages → 仅在 message_start 消费确认时清除 / 进程死亡 resume 补投）、`close {force}`（终态化；旧 cancel 保留为 force:true 别名）。**无 wait**（决策 7）。理由：使用者可见的全部新能力，依赖 1+2。
5. **record→child 映射**（`execution/session-runner.ts`）：`spawnedChildren` Set → `Map<recordId, ChildProcess>`，busy 投递定位活进程。理由：busy 时消息必须写活进程 stdin（决策 6），现有结构无 id 关联（`spawnedChildren` Set 定义于 `session-runner.ts:193`）。
6. **归属守卫**（`subagent-actions.ts`）：`rootSessionId` 比对（决策 3）；跨进程定位需绕过 collectRecords 过滤查磁盘全集。理由：并发安全，依赖 4 的定位逻辑。
7. **重建矩阵 + reaper 豁免 + notifier 适配**（`record-store.ts`、`worktree-manager.ts`/`worktree-registry.ts`、`notifier.ts`）：`.idle` 分支重建（判定优先级：`.idle` 存在 → idle，无视 pid 死活；无 `.idle` 且 `.alive`+pid 死 → 兜底 crashed 不变）；reaper 判据「pid 死且无 `.idle`」；notifier dedup 按轮次 + 状态守卫加 idle。理由：G4 可恢复性与 G1 通知可靠性的三块基石，互相独立可分批验证。
8. **list/状态展示**（`record-store.ts` collectRecords + `interface/subagents.ts` + `interface/format.ts` + `interface/gui-mappers.ts` + `interface/list-component.ts`）：**对外四态映射**（active/waiting/ended/error，决策 10 细则 3）+ 内部 ExecutionStatus 进 details；idle 态合并展示；format statusIcon/gui-mappers 字符串匹配补 idle case（否则 idle 落入 running/done 错误语义）。理由：G4 的用户可见面，依赖 2+7。

### 文件改动地图

| 文件 | 改动 |
|---|---|
| `execution/pi-invocation.ts` | spawn args 支持 `--session` |
| `execution/subprocess-agent-runner.ts` | resume 路径（sessionFile 已知） |
| `execution/get-state-handshake.ts` | 已存在 session 的握手适配 |
| `execution/types.ts` | ExecutionStatus + `"idle"` |
| `execution/execution-record.ts` | identity entry + `chatMode` 字段 + `pendingMessages` 在途消息缓存 |
| `execution/finalize-record.ts` | 轮次完成 vs 最终关闭分流 + `.idle` sidecar 写删（时序：SIGTERM → 删 `.alive` → 写 `.idle` → record idle；写 `.idle` 前崩溃落 crashed，保守可接受） |
| `execution/session-runner.ts` | `spawnedChildren` → `Map<recordId, child>`（kill 分支不改） |
| `interface/subagent-tool.ts` | schema：`start {conversation?}` / `message {text, interrupt?}` / `close {force?}` / `list {statusFilter?}`（机制词汇禁入，决策 10） |
| `interface/subagent-actions.ts` | 新 action handler + rootSessionId 守卫 + 旧 `cancel` 别名映射 |
| `execution/record-store.ts` | idle 态不进 archive；重建矩阵 `.idle` 分支；STATUS_PRIORITY 补 `idle` 键（`Record<ExecutionStatus, number>` 字面量缺键触发 TS2741） |
| `execution/worktree-manager.ts` + `worktree-registry.ts` | reaper 判据加「无 `.idle` 才清理」 |
| `execution/notifier.ts` | 对话模式 dedup 按轮次 + status 守卫加 idle |
| `interface/format.ts` / `gui-mappers.ts` / `list-component.ts` / `subagents.ts` | idle 展示语义 |

### 待验证检查点（实施期）

- P-4：busy 时 `follow_up` 排队行为（顺序保证、与 abort 交互、**agent_end 不在排队消息被消费前发出**）；顺带验证「isStreaming 时 prompt 强制要求 streamingBehavior」的 xyz-agent 断言（若属实，busy 投递**必须**用 follow_up/steer 命令而非 prompt）
- P-5：resume 后 worktree 文件可见性（`--session` 打开时 cwd 是否保持）
- P-8 上游依赖声明：**「句柄 = sessionFile 可寻址」依赖 pi `--session` 续写原文件**（若上游改为 fork 新文件，需加一层 indirection）——保留探针，但这是对 pi 上游行为的依赖假设
- **cancelHandler 改动范围（决策 5 已裁决，实施确认）**：对话模式无独立 cancel——旧 `cancel` action 保留为 `close(force:true)` 别名；`subagent-actions.ts:245` 的 mode 守卫从「非 background 抛 unsupported」改为「conversation 时映射到 close(force:true) 语义」
- resume 的执行参数（maxTurns/graceTurns/fork/appendSystemPrompt）持久化——第一版**不恢复**执行约束（resume 只带 session 与 model/thinkingLevel，不带约束），后果：maxTurns 每轮重置为全量预算；若后续需要再持久化到 identity entry
- **resume 槽位失败语义**：对话模式轮次间不占并发槽（release），resume 时重新 acquire——池满时**有界排队（30s）后返回 `too many subagents running` 错误**（含恢复指引：`close` 或稍后重试），不做无限等待
- 30 天 session 文件 GC（`session-file-gc.ts` TTL_DAYS=30）与 G4 的边界：idle 超过 30 天的对话 session 文件被删 → 句柄失效——第一版接受该寿命上限（恢复指引：重新 start），后续可豁免对话模式

---

## 附录：调研与实测记录（背景，不参与设计裁决）

- **参考实现**：pi-intercom（ask 挂起 + reply 配对，跨 session broker）；nicobailon/pi-subagents（子→父 contact_supervisor 桥接）；Kimi Code CLI（同进程 DI + `agent_id` resume 句柄 + 归属/idle 双守卫，`agent-core-v2/src/session/swarm/`）；Claude Code Agent Teams（文件 mailbox + 轮询，in-process teammate 常驻 loop / transcript resume，`src/utils/teammateMailbox.ts` + `src/tools/SendMessageTool/SendMessageTool.ts`）。
- **实测**：本地 pi CLI（`--mode rpc`，mimo-v2.5-pro）：resume 上下文保留 PASS；prompt 续聊多轮累积 PASS；steer/follow_up **完成后**不触发 FAIL（即正确行为）；**streaming 中 steer 抢占 PASS**（76 条 text_delta 后发 steer，原任务输出停止、最终回复切换为新问题）；idle 进程 RSS ~147MB / CPU 0%。
- **xyz-agent 佐证**：composer 的 ⏎（isActive 时）→ `message.steer`、Alt+⏎ → `message.follow_up`、busy 时普通发送自动降级 steer（`useChat.ts:298-307`）；runtime 纯透传 `sendCommand('steer'/'follow_up')`（`rpc-client.ts:495-500`），无 busy 预检、无竞态处理——「完成后无效」的规避全靠前端 isActive 路由（改走 prompt）。
- **审查**：设计经四轮对抗式审查迭代——第一轮 9 must-fix 全部修复（归属字段 parentRecordId→rootSessionId、idle 重建矩阵 `.idle` sidecar、worktree reaper 豁免、notifier dedup 豁免、删除 wait、验收上下文改真实文件、idle 进程语义裁定 kill+resume、record→child 映射、ExecutionMode 不扩展）；第二轮 9/9 闭合验证；第三轮 1 P0（busy→kill 竞态丢消息 → 消费确认制）+ 2 P1（busy 即时干预 → deliverAs 双语义，实测 steer 抢占；resume 参数传递 → model/thinkingLevel）+ 4 P2 全部裁决；第四轮 1 P1（cancel 语义自相矛盾 → 裁决：close{force} 合并动词、对话模式无独立 cancel、message{interrupt} 覆盖停轮）+ 1 P2（pendingMessages 清除不变式）+ 2 探针补强 + tool surface 意图词汇封装准则（决策 10：schema 只暴露意图词汇，机制词汇禁入）。首轮审查报告见同目录 `continuous-subagent-chat.review.md`。
- **结论**：三家一致支持「文件为状态源 + resume 为持续对话主路径」；无一家依赖中央 broker。
