# Workflow 一次性生命周期收敛（废除 pause/resume）

> **一句话结论**：workflow run 收敛为一次性生命周期（`running → done` 两态）——删除 paused 状态、pauseRun/resumeRun、跨 pause 的 replay 机制与全部接口面入口；worker 崩溃重试（含 calls Map replay）**保留**（它保护的是已完成的 agent 调用投入，是真实价值）；kill-9 / session 切换时运行中的 run 统一转为 `done,failed`（kill-9 是现状既有语义，session 切换是已确认接受的行为变更，见 §3.2 边界声明）。净效果：状态机减一态、error-recovery 的 4 处执行级 paused 散布守卫删除、MUST_FIX 级竞态补丁（discardInFlightCalls 的 pause 场景）随状态一起消失。

## 层声明

- **当前层**：技术方案设计（workflow 子系统生命周期收敛）
- **下一层产物**：文件级改动规格（接口/数据模型/错误规格）——属「可实现的接口/数据模型/技术方案」，设计准则 5（物理数据流）/6（错误恢复指引）/7（运行时断言探针）全部 P0 适用
- **与既有文档的关系**：本方案独立于 subagent 侧的 V4 收敛（`v4-lifecycle-convergence.md`），只动 workflow 编排层（`src/orchestration/` + 接口面）；subagent 执行层（`src/execution/`）零改动

---

## §1 背景目标

### SCQA

- **S（情境）**：pi-subagent-workflow 的 workflow 子系统让 LLM 用命令式 JS 脚本编排多个 subagent：脚本跑在 Worker thread 里，`agent()` 调用经 IPC 桥回主进程、spawn 独立 pi 子进程执行。run 有快照持久化（`<sessionDir>/workflow-state/<runId>.jsonl`），支持 run / status / pause / resume / abort 五个操作。
- **C（冲突）**：pause/resume 是**消费场景极窄**的能力——唯一程序化消费方是 session 生命周期自动挂起（`session_tree`/`session_shutdown` 两个 handler 在 session 切换/关闭时 pause 全部 running run，index.ts:527-545/:594-607）；唯一真实用户链路是「切 session 自动挂起 → 回来手动 resume 续跑」，该场景经评估不重要、**「session 切换时运行中 run 直接作废」已被确认接受**（§3.2 边界声明）；cw 编排不经它、嵌套 workflow 只用 signal 继承。却持续征税：①「terminate worker + 重跑脚本 + callId 缓存 replay」机制要求**用户脚本逐字节确定性**——LLM 生成的脚本写个 `Date.now()`/`Math.random()` 重跑就走分叉、replay 错位；② paused 态在 error-recovery 里散布 4 处执行级守卫 + 多处注释分支，是一类「暂停期间消息乱入」的误伤面；③ `discardInFlightCalls`（lifecycle.ts:288）是 pause 竞态的补丁，代码里挂着 `MUST_FIX (round-4 #1)` 注释（源码原文，lifecycle.ts:265）。
- **Q（问题）**：能否在**不损失任何真实使用能力**的前提下，把 pause/resume 连同它的机制族整体剔除，让 workflow 生命周期收敛到与 subagent 同构的「一次性」语义？
- **A（答案）**：能，但性质要诚实——这是一次**有意识的行为变更**而非「现状诚实化」：删除后 session 切换时运行中的 run 从「自动挂起可 resume」变为「作废转 failed」（该后果已确认接受，§3.2 边界声明）。关键事实：kill-9 崩溃恢复现状本就只到 `done,failed`（jsonl-run-store.ts:211-213 的源码 D-4 标记注释：残留 running 在 session_start 转 failed，不存在真正的跨进程 resume）——pause/resume 是唯一真实的 resume 路径，而它唯一的价值场景（跨 session 续跑）评估为不重要。worker 崩溃重试（error-recovery 的 3 次指数退避 + rebuildRuntime + replay）是另一个独立机制，保护已完成的 agent 调用投入，**保留**。

### 系统是什么（给不懂内部的人）

`workflow` 工具让主 agent 启动一个**编排脚本**（普通 JS，顶层 await）：

```
主 agent: workflow { action:"run", name:"/abs/path/review-fix-loop.js", args:{...} }
  → Worker thread 里跑脚本（eval 内联，非子进程）
  → 脚本里 await agent({prompt:"...", schema:{...}}) ──IPC──> 主进程 spawn pi 子进程执行
  → 脚本 return {...}  →  run 转 done,completed，结果回主 agent
```

每个 run 有一份磁盘快照（观测 + 崩溃检测用）。当前 run 的状态机是 `paused/running/done` 三态（jsonl-run-store.ts:91 快照格式；runWorkflow 创建时先入 paused 再 assignRuntime 转 running，lifecycle.ts:178/:219）。

四个核心概念（本文反复使用，先定义）：

| 概念 | 定义 |
|---|---|
| **run** | 一次 workflow 执行（runId 标识），含脚本源码、args、calls Map、状态 |
| **calls Map / replay** | run 内每次 `agent()` 调用的结果缓存（callId → result）。worker 重建后脚本**从头重跑**，`agent()` 命中缓存直接返回旧结果不真执行——这是当前唯一的「恢复」机制 |
| **pause/resume（拟删除）** | pause = terminate worker + 快照保留；resume = 重建 worker 重跑脚本 + replay。跨 session 存续的唯一通道 |
| **worker 崩溃重试（保留）** | worker 进程级错误/异常退出时，error-recovery 自动 rebuildRuntime 重跑脚本（≤3 次，指数退避 1s/2s/4s），同样依赖 calls Map replay 保住已完成调用 |

### 设计目标（从使用者体验倒推）

| # | 目标 | 使用者（主 agent / 用户）体验 |
|---|---|---|
| G1 | **功能不回归**：run/status/abort、嵌套 workflow、token/time 预算、worker 崩溃重试、kill-9 残留检测全部保持（唯一例外：session 切换时 running run 从「挂起可续」变为「作废」——已确认接受的行为变更，§3.2 边界声明） | 现有 5 个内置 workflow 与自定义脚本行为完全不变 |
| G2 | **复杂度可量化削减**：状态机两态；paused 散布守卫清零；pause 族机制（terminate+重跑+discard 补丁）整体删除 | 维护者读 lifecycle/error-recovery 不再遇到 paused 分支与 MUST_FIX 注释 |
| G3 | **语义诚实**：工具/命令/UI/文档不再暴露不存在的能力；尝试 pause 得到明确错误 + 恢复指引 | 用户/LLM 不会被一个不维护的功能误导 |
| G4 | **可验收**：每项断言在真实 pi 环境验证（非单测非 mock） | 实施者知道「做完怎么证明做对了」 |

### In-scope / Out-of-scope

**In-scope**：`src/orchestration/`（lifecycle / workflow-run 状态机 / error-recovery 守卫 / jsonl-run-store）+ 接口面（tool-workflow / commands / command-actions / WorkflowsView / gui-mappers）+ 工具 description 与文档回写。

**Out-of-scope**（明确不做，附理由）：

- **subagent 执行层（`src/execution/`）任何改动**——conversation mode、marker、record 模型均不动；workflow 脚本内 `agent()` 本来就是一次性调用（`_KNOWN_FIELDS` 白名单无 conversation 字段，现状已满足「workflow 内不开放对话」，零改动）。
- **run 注册表进程级化**（run 跨 session 存活）——一次性化后 session 切换时运行中的 run 统一转 failed（见 §3.3 D-2）；「长 workflow 跨 session 存活」若成为真实需求，作为独立方案再做（届时配事件日志 checkpoint，不走本文删除的 pause 老路）。
- **快照 → append-only 事件日志改造**——恢复路径删除后，事件日志的动机只剩观测/审计，收益不足以支付格式迁移；快照式保留。
- **concurrency-gate 退化薄封装的清理**（已退化为 abort 包装，实际并发由 execution 层 pool 管）——与 pause 无关的独立死代码，另开改动。
- **内容寻址 callId / 确定性原语注入（$NOW/$RANDOM）**——那是「保留 replay 能力」路线（方案 B）的治理措施；本方案 replay 只剩 worker 崩溃重试一个场景（同一进程内、秒级窗口、脚本刚跑过同一代码），确定性风险窗口极小，不值得引入治理机制。若 §4 S7 验收暴露真实错位，再评估。

---

## §2 现状与问题分析

**本章结论：pause/resume 的三个机制（terminate+重跑 replay、paused 散布守卫、discard 竞态补丁）服务一个消费场景极窄的能力（唯一程序化消费方 = session 切换/关闭自动挂起，已确认接受作废）；且「跨进程恢复」在现状中本就不存在——一次性化是有意识的行为变更，不是诚实化也不是削减。**

### 2.1 现状：一次 pause/resume 的真实旅程（物理数据流）

```
[用户] /workflows pause wf-123
  → commands.ts:83 解析 verb → pauseRun (lifecycle.ts:251)
  → WorkflowRun.transition("paused")：releaseRuntime（A4 原子性：controller.abort() +
    worker.terminate() + gate 释放，lifecycle.ts:243-246）
  → discardInFlightCalls (lifecycle.ts:276→288)：清理被 abort 的在飞 call 的 failed 缓存
    ——否则 resume 重跑时这些「被 abort 的假失败」会被 replay 当成真实结果（MUST_FIX :265）
  → store.save：快照落盘 <sessionDir>/workflow-state/wf-123.jsonl（status:"paused"）

[用户] （切换到另一个 session）/workflows resume wf-123
  → 新 session 的 loadAll 从 session JSONL 的 workflow-state-link 指针读到快照
  → resumeRun (lifecycle.ts:312)：整重建 RunRuntime（G3-001：新 Worker eval 同一脚本源码）
  → **脚本从头重新执行**：每次 agent() 按 callId（脚本内自增计数）命中 calls Map 缓存
    直接返回旧结果；未缓存的调用真实 dispatch
  → 脚本跑完 → done,completed
```

这条链路的三个承重事实（全部经源码核实）：

1. **确定性契约**：replay 正确性依赖「重跑脚本逐字节走同一控制流」——callId 是脚本内自增序号，第 N 次 `agent()` 调用必须对应同一个逻辑调用。脚本里的 `Date.now()`、`Math.random()`、读文件、网络请求在重跑时产生不同结果 → 控制流分叉 → callId 错位 → 已完成的 A 调用结果被安到 B 调用头上。**对 LLM 生成的脚本，这不是边缘情况而是必然事件**。
2. **paused 态的散布成本**：error-recovery.ts 里执行级 `status === "paused"` 守卫 4 处（:178 stale 消息丢弃、:624 stale 完成守卫、:667 error 计数污染防护、:699 replay 判断），另有注释分支散布（:169/:177/:218/:346/:414/:453/:622/:698）；lifecycle.ts:374 abortRun 的 paused 防御分支、error-recovery.ts:736 scheduleRebuild 的重检都要为 paused 分支；lifecycle.ts:116 的时间预算 timer 要为 paused 重排；gui-mappers.ts:34 的状态映射、WorkflowsView 的按键分支（:435-446/:696-698）都带 paused。每一处都是「暂停期间异步消息乱入」的误伤面。
3. **「跨进程恢复」本就不存在**：jsonl-run-store.ts:211-213 注释自述——`WorkflowRun.reconstruct` 跳过 I1 校验（running ⟺ runtime 存在）因为「进程被杀后 worker 不可能还活着」，恢复逻辑（源码 D-4 标记，实现于 index.ts:453-465 session_start）把残留 running 转 `done,failed`。**kill-9 / 崩溃后的 run 从来不能续跑**；pause/resume 是唯一的 resume 路径，而它只服务 session 切换挂起场景（§2.2 P4）。

### 2.2 问题清单

| # | 问题 | 真实失败模式 | 根因 |
|---|---|---|---|
| P1 | **确定性契约对 LLM 脚本天然脆弱** | 用户脚本含 `Date.now()` → pause 后 resume 重跑走分叉 → callId 错位 → A 调用的结果被 replay 给 B 调用（静默错误，比崩溃更糟） | replay 用脚本内自增 callId 做顺序寻址，要求逐字节确定性 |
| P2 | **paused 态在错误处理层散布多处守卫**（执行级 4 处 + 注释分支 + lifecycle:374/scheduleRebuild:736 防御分支） | 每新增一个异步消息处理点都要记得补 paused 分支，漏一个就是「暂停期间消息乱入」类 bug | paused 是一个与异步事件流正交的状态，守卫只能点状分布 |
| P3 | **discardInFlightCalls 是 MUST_FIX 级补丁** | pause 时 abort 的在飞 call 留下 failed 缓存，resume 后 replay 命中 → 假失败当真结果（lifecycle.ts:265/:284 注释自认） | pause 的「abort + terminate」与 calls Map 缓存语义冲突 |
| P4 | **消费场景极窄** | 唯一程序化消费方是 session 生命周期自动挂起（session_tree/session_shutdown 在 session 切换/关闭时 pause 全部 running run，index.ts:527-545/:594-607）；其服务的唯一用户链路「切 session 挂起 → 回来 resume 续跑」经评估不重要（作废已确认接受，§3.2 边界声明）；cw 编排不经 pause；嵌套 workflow 用 signal 继承 | pause 是「run 挂 session 生命周期」逼出的跨 session 存续补救，而该存续场景本身价值有限 |

### 2.3 根因

**R（表达冗余）**：「暂停」这个概念的合法语义——「执行体挂起、工作进度可续」——在当前架构里被实现为一个**存储状态 + 一套重放机制 + 一族守卫**。但同一语义在 subagent 侧（conversation mode）已证明有更好的形态：**状态全派生，执行体生灭与 record 存续解耦**（进程死了 record 仍 resumable，message 到来冷路径重建）。workflow 侧若未来真需要「暂停后续跑」，正确形态是同一哲学（事件日志 checkpoint + 重建），而不是现在的 paused 存储态 + 重跑 replay。**本期不建这个未来形态（无需求），只删除现有错误形态。**

---

## §3 解决方案

**本章结论：推荐方案 A——彻底废除 pause/resume，run 状态机收敛为 running/done 两态；worker 崩溃重试与 calls Map replay 作为内部机制保留；接口面/持久化/文档同步清除。**

### 3.1 终态（使用者视角）

**场景 A：正常完成（回归基线）**

```
[主 agent] workflow { action:"run", name:"/abs/chain.js", args:{task:"分析这个仓库"} }
  → { runId:"wf-...", status:"running", stateFile:".../workflow-state/wf-....jsonl" }
[后台]   脚本三步 agent() 顺序执行 → return {...}
[主 agent] 收到完成通知（status:"done", reason:"completed", result 正确）
```

**场景 B：主动终止**

```
[用户] /workflows abort wf-123
  → abortRun：worker.terminate（幂等）+ 在飞 agent 调用的子进程 SIGTERM 回收
  → status:"done", reason:"aborted"
[验证] ps 无残留 worker / pi 子进程；list 显示 aborted
```

**场景 C：崩溃与 session 切换作废（行为变更，已确认接受）**

```
[用户] 长 workflow 运行中，主进程被 kill -9
[重启] session_start → loadAll 读到残留快照（status:"running" 无 runtime）
  → 直接转 done,failed
[用户] /workflows → 列表显示该 run failed；无 running 幽灵

[用户] 长 workflow 运行中，切换到另一个 session（或关闭当前 session）
[session_tree/session_shutdown handler] 运行中的 run 直接转 done,failed 落盘
  （替代现状的 pauseRun 挂起）
[用户] 切回原 session → 该 run 显示 failed（不再 resume 续跑）
```

**场景 D：尝试已删除的能力（失败路径 + 恢复指引）**

```
[主 agent] workflow { action:"pause", runId:"wf-123" }
  → ❌ 错误：Unknown action "pause". Supported actions: run, status, abort.
    👉 Workflow runs are one-shot: to stop a run early use action:"abort";
       to get a fresh result, start a new run.
[用户] /workflows pause wf-123 → 命令补全与解析中无 pause verb → 同语义提示
```

**场景 E：worker 崩溃自愈（保留机制回归）**

```
[后台] 长 workflow 第二个 agent() 调用进行中，worker 因基础设施错误退出
  → error-recovery：workerErrorCount=1 ≤3 → 指数退避 1s → rebuildRuntime
  → 新 worker 重跑脚本：第一个 agent() 命中 calls Map 缓存秒回（不重花 token），
    第二个重新 dispatch → 完成
[主 agent] 无感知（仅延迟 +1s）；若 3 次重试耗尽 → done,failed
```

### 3.2 多方案对比

| 方案 | 长期架构合理性 | 短期实现成本 | 风险 | 裁决 |
|---|---|---|---|---|
| **A 一次性化（本方案）**：删 paused 态 + pauseRun/resumeRun + pause 场景 replay；崩溃重试及 replay 保留；接口面清除；session 切换作废（已确认接受的行为变更） | ✅ 状态机两态与 subagent record 模型同构（active/closed + 派生态）；守卫清零；为极窄场景不征税 | 中：净删 ~400-500 行（lifecycle 两个函数 + error-recovery 守卫分支 + 接口面 + 视图 + index.ts 两处 handler），无新增机制 | 低-中：消费方已显式处置（作废确认）；崩溃重试独立保留；风险集中在「漏删某处 paused 引用」→ 编译期类型 + grep 验收兑底 | ✅ **推荐** |
| **B 保留 pause 并修复**：内容寻址 callId（hash 替代自增）+ 确定性原语（$NOW/$RANDOM 入日志）+ 事件日志替代快照 | ⚠️ 修复了 P1/P3 但 paused 散布守卫（P2）仍在；为一个消费场景极窄的能力新增三个机制（hash、原语注入、日志格式），方向与「减法优先」相反 | 高：三个新机制 + 迁移 | 中：机制增多、契约仍在（内容寻址容忍分叉但 replay 命中率下降时 token 重复消耗） | ❌ 否决 |
| **C 更激进一次性**：连 worker 崩溃重试也删（worker 死 → 直接 done,failed） | ⚠️ 最简，但丢弃真实价值：长 workflow 已完成 N 个 agent 调用（已花 token）因一次 worker 基础设施错误全部作废 | 低（删得更多） | 中：worker 崩溃在长任务中虽罕见但非零，发生时损失大；replay 机制本身经过验证（resumeRun 与重试共用），保留成本低 | ❌ 否决 |

**被否方案的具体后果**：用方案 B，§2.1 的旅程变成「pause 后 resume 时 $NOW 重放同值、hash 命中缓存」——功能对了，但 error-recovery 的 paused 守卫一处不少，且新增的三个机制每个都要长期维护；用户得到的却是一个价值场景极窄的能力。用方案 C，§3.1 场景 E 变成「worker 崩溃 → 已完成的 5 个 review 调用（~20 万 token）作废，用户重新跑」——省钱机制变烧钱机制。

**方案 A 与被删除能力的边界声明**：「暂停一个长 workflow、稍后继续」在删除后由两个已有能力承接——① 不重要：abort + 重新 run（agent 调用幂等性由调用方评估）；② 重要且反复出现：届时作为独立方案做「事件日志 checkpoint + 冷恢复」（正确形态见 §2.3 R），不走 pause 老路。

**被删能力唯一程序化消费方的处置（诚实声明）**：pause/resume 唯一的程序化触发是 session 切换/关闭（session_tree/session_shutdown handler 自动 pause，index.ts:527-545/:594-607）。删除后这两个场景的 run **从「挂起可续」变为「作废转 failed」**——已完成的 agent 调用 token 投入作废。这是**有意识的行为变更**（用户已确认接受：session 切换时 workflow 直接作废可接受），不是「现状诚实化」；设计依据是 §2.2 P4 的价值评估（该存续场景不重要），而非「不存在消费方」。

### 3.3 关键决策与权衡

#### D-1：状态机收敛 running/done，DoneReason 不变

- **选择**：`WorkflowRun` 状态删除 `paused`；保留 `running | done`（创建瞬态直接 running：现状 runWorkflow 先建 paused 再 assignRuntime 转 running 的两步（lifecycle.ts:178/:219）合并为「创建即 running 且绑定 runtime」一步，I1 不变式（running ⟺ runtime 存在）自然保持）。DoneReason 保留 6 种（completed/failed/aborted/budget_limited/time_limited/invalid_args），无新增。
- **依据**：两态与 subagent record 的 active/closed 模型同构（V4 B-1 方向在编排层的镜像——subagent 侧 record 状态收敛为 running/closed 两态、中间语义改由派生谓词表达）；「是否挂起」不再是状态——一次性语义下不存在挂起。
- **契约调整**：「创建即 running」合并撞上 `WorkflowRun.assignRuntime` 的 `requires status==="paused"` 前置校验（workflow-run.ts:222-224）——构造函数初始态与 assignRuntime 前置契约需同步调整（U1 改动点，编译期强制）。
- **被否**：保留 paused 但废弃入口（半吊子：状态还在，守卫还得留）。
- **探针**：⛔ S8 grep 断言：`src/` 下无 `pauseRun|resumeRun|"paused"` 运行时引用（允许 CHANGELOG/本文档/迁移注释提及）。

#### D-2：session 切换 / kill-9 的统一语义 = 转 failed（有意识的行为变更）

- **选择**：三个落点统一为「非 done 残留 → done,failed」：
  1. **session 切换/关闭当刻**（session_tree/session_shutdown handler，index.ts:527-545/:594-607）：删除原 pauseRun 调用，改为对每个 running run 直接 `transition("done","failed")` + 落盘（复用 abortRun 的 transition+save 骨架，或抽取「running → done,failed」小 helper 供两个 handler 共用）。字段落点对齐 session_start 恢复先例（index.ts:458-460）：`reason="failed"` + `state.error=<原因串>`，原因串为 session-switch 语义（如 "Session switched: run terminated"）。
  2. **进程重启后**（session_start 的 loadAll 恢复，index.ts:453-465）：现状已把残留 running 转 failed，逻辑不变。
  3. **快照格式**：paused 状态随状态机删除，SNAPSHOT_VERSION bump（D-5）。
- **依据**：这是**行为变更**——现状 session 切换是 pauseRun 挂起落盘、paused 可 resume 续跑（replay 保住已完成调用）；删除后 running run 直接 failed、token 投入作废。变更已确认接受（§3.2 边界声明）。与 kill-9 语义统一后，「跨 session 存续」不再有任何形态。
- **被否**：保留「session 切换时挂起」的过渡形态（与删 paused 态矛盾）；session_tree 静默跳过（跨 session 幽灵 running，S8 grep 断言通过后此缺口仍无人决策）。
- **探针**：⛔ S3：kill -9 与 session 切换双场景断言列表无 running/paused 幽灵；切换回原 session 后 run 显示 failed。

#### D-3：worker 崩溃重试保留，discardInFlightCalls 重新定位

- **选择**：error-recovery 的重试矩阵（worker error 与 script error 分账各 3 次、指数退避、rebuildRuntime）**原样保留**；calls Map replay 保留（重试重建后重跑脚本时命中缓存）。`discardInFlightCalls`（lifecycle.ts:288）**保留但改调用点与注释**：它清的是「重建前被 abort 的在飞 call 的假 failed 缓存」——该场景在崩溃重试的 rebuildRuntime 前同样存在（旧 runtime 的 controller.abort() 使在飞 executeAgentCall 以 failed 入缓存），与 pause 无关；注释中的 MUST_FIX (round-4 #1) 标记随 pause 场景消失而移除，改写为崩溃重建的正式步骤。
- **依据**：§3.2 方案 C 的否决理由；discard 的语义内核（「abort 产生的 failed 不是真实结果」）在崩溃重建路径独立成立。
- **被否**：随 pause 一起删 discard（崩溃重建后 replay 命中假失败 → 场景 E 变成「崩溃一次 = 在飞调用永远 failed」）。
- **探针**：⛔ S7：注入 worker 崩溃，断言已完成 call 不重复消耗 token、在飞 call 重跑而非 replay 假失败。

#### D-4：接口面清除（工具 / 命令 / 视图 / GUI）

- **选择**：
  - `index.ts`（pauseRun 的两个程序化调用方）：session_tree handler（:538）与 session_shutdown handler（:607）的 pauseRun 调用替换为 D-2 的「running → done,failed + 落盘」helper；注释同步重写（「切分支前 pause」→「切分支前终止」）。
  - `tool-workflow.ts`：action enum 删 pause/resume（:57-59/:64-66），保留 run/status/abort；`runId` 参数描述从 "Workflow run ID (pause/resume/abort)" 改 "abort action"；工具 description 增加一次性语义声明（runs are one-shot; abort is the only early-stop）。
  - `commands.ts` / `command-actions.ts`：/workflows 删除 pause|resume verb（:76-78 补全、:83 解析、:105-107 case），保留 `[runId]` 打开与 `abort <runId>`；报错文案带恢复指引（§3.1 场景 D）。
  - `WorkflowsView.ts`：ViewActions 删 pause/resume（:129-130），按键分支（:435-446/:696-698）只留 abort；详情状态行无 paused。
  - `gui-mappers.ts`：mapRunStatus 删 paused 分支（:34 注释同步）；RunStatus 类型收窄。
- **依据**：G3 语义诚实；接口面是「能力宣传」，删能力必须删宣传，否则 LLM 按 description 调 pause 得到运行时错误（体验断层）。
- **探针**：⛔ S4：真实工具调用 pause → 结构化错误 + 指引；命令补全无 pause/resume。

#### D-5：快照格式 bump `wf-run-v2`，旧文件静默跳过

- **选择**：`SNAPSHOT_VERSION` 从 `wf-run-v1` bump `wf-run-v2`（快照 status 枚举收窄为 running/done）；旧 v1 文件 loadAll 静默跳过——沿用现状 D-5 的不兼容策略（jsonl-run-store.ts:61-65 注释已确立「升级格式时 bump + 旧文件跳过」先例）。**边界声明**：v1 running 残留（kill-9 后未重开同 session）跳过 = 静默消失不显示（不转 failed）——概率低（bump 前最后窗口）、损失为一条历史失败记录的显示差异，接受。**快照内容本身不瘦身**（calls/trace 明细保留——TUI 运行中观测用；磁盘瘦身无收益，run 目录随 session-file-gc 的 30 天 TTL 清理）。
- **依据**：格式收窄与 bump 是同一变更的原子两半；不引入迁移逻辑（旧 run 早已终态，跳过零损失）。
- **被否**：保留 v1 兼容读（为早已终态的历史 run 写迁移代码，纯成本）。
- **探针**：⛔ S8：升级后启动，旧 v1 文件不崩不显示；新 run 快照为 v2。

#### D-6：文档与注释回写

- **选择**：① `workflows/README.md` 与工具 promptGuidelines 补一次性语义；② lifecycle.ts 头部模块注释（:8-9 的 pauseRun/resumeRun API 说明）重写；③ error-recovery.ts:151 的「时间预算静默失效（直到 pause/resume 才重排）」等 paused 相关注释清除；④ models 文件注释同步：run-runtime.ts:27（「lifecycle pauseRun 传 "pause"」）、budget.ts:103（「runWorkflow/resumeRun 内 setTimeout」）、trace.ts:156（「仅 lifecycle.pauseRun 清理」）；⑤ index.ts:587/:604 的 pause 语义注释重写；⑥ CHANGELOG 记录 breaking change（action enum 收窄是 API 变更）。
- **依据**：项目规则——文档-代码漂移是认知风险源（V4 P5 的同类教训——subagent 侧 v4 收敛时注释与代码漂移导致的一次定位事故）；action enum 收窄影响 LLM 可见 schema，必须在 CHANGELOG 声明。
- **探针**：⛔ S8 grep：源码注释无「pause/resume」的现役能力描述（历史/迁移说明除外）。

---

## §4 验收（真实 pi 环境，非单测非 mock）

**验收环境**：本地 pi CLI RPC mode（`pi --mode rpc --session-dir <dir> --model <m> --approve --extension <本包路径>`），测试模型 `xiaomi-token-plan-cn/mimo-v2.5-pro`；通过 stdin JSONL 发 prompt 驱动主 agent 调 workflow 工具，或直接调工具等价 RPC。内置 workflow 用本仓 `workflows/chain.js`（短）与 `workflows/review-fix-loop.js`（长）。

| # | 场景（回溯目标） | 步骤 | 通过标准 |
|---|---|---|---|
| S1 | **正常完成回归**（G1） | run chain.js（task="分析当前目录结构"）→ 等完成通知 | status 显示 done/completed；result 含三步产出；stateFile 快照 v2 格式 |
| S2 | **主动 abort**（G1/G3） | run review-fix-loop（targetType=text，长任务）→ 进行中 `/workflows abort <runId>` | done/aborted；`ps` 无残留 worker 与 pi 子进程；list 显示 aborted |
| S3 | **崩溃与 session 切换作废**（G1/G2/G3，D-2 核心） | ① run review-fix-loop → 进行中 `kill -9` 主进程 → 重启同 session；② run review-fix-loop → 进行中切换 session → 切回 | ① 残留 run 显示 done/failed（无 running/paused 幽灵）；含失败原因；list 可打开详情；② 切回后 run 显示 failed 且不可 resume；两场景行为一致 |
| S4 | **已删能力的错误指引**（G3） | ① 工具调 `{action:"pause",runId}` ② `/workflows pause <id>` | ① 结构化错误「Unknown action "pause". Supported: run, status, abort」+ 👉 指引；② 命令补全/解析无 pause verb，同语义提示 |
| S5 | **嵌套 workflow 回归**（G1） | 跑一个脚本内 `workflow("chain.js", {...})` 嵌套调用的自定义脚本 | 父子均完成；预算共享不回归（子消耗计入父 budget） |
| S6 | **预算终态回归**（G1） | run chain.js 带极小 tokens 预算 | done/budget_limited；无 pause 相关分支残留行为 |
| S7 | **worker 崩溃自愈**（G1/G2，D-3 核心） | 注入点定稿：测试脚本经 `$ARGS` 条件分支触发两类崩溃——① worker 异常退出：脚本内 `process.exit(1)`（worker thread 的 process 全局可用，脚本内联于 worker 代码执行；exit 非零码走 handleWorkerExit → workerErrorCount 重试）；② 脚本错误：顶层 `throw new Error(...)`（buildWorkerScript 的顶层 .catch 转 type:"error" → handleScriptError → scriptErrorCount 重试）。两类分别注入，观察各自 ≤3 次重试 | ≤3 次重试后完成或 failed；**已完成的 agent 调用不重复消耗 token**（对照子进程 session 文件数量/内容）；在飞被 abort 的 call 重跑而非 replay 假失败（discardInFlightCalls 在崩溃重建路径生效） |
| S8 | **静态断言**（G2/G3，D-1/D-5/D-6） | grep + 启动 | `src/` 无 `pauseRun\|resumeRun` 定义与调用、无 `"paused"` 状态引用（历史注释/CHANGELOG 除外）；旧 v1 快照文件启动不崩不显示；`pnpm extensions:typecheck` / `extensions:lint` / `extensions:test` 全绿 |

---

## §5 下一层拆分（文件级改动地图）

按「可独立 commit、独立验收」拆 4 个单元，依赖关系：U1 是核心（U2/U3 依赖其状态定义），U4 最后。

| 单元 | 内容 | 文件 | 验收 | justification |
|---|---|---|---|---|
| **U1 状态机核** | WorkflowRun 删 paused；构造与 assignRuntime 契约调整（创建即 running，撞 paused 前置校验的改动点，D-1 契约调整）；删 pauseRun/resumeRun；error-recovery 4 处执行级 paused 守卫 + 注释分支简化为 isTerminal 单判据（含 lifecycle:374 防御分支、scheduleRebuild:736 重检）；discardInFlightCalls 挪入崩溃重建路径 + 注释重写（移除源码 MUST_FIX (round-4 #1) 标记）；时间预算 timer 删 paused 重排分支 | `orchestration/lifecycle.ts`、`orchestration/models/workflow-run.ts`（状态定义与契约所在）、`orchestration/error-recovery.ts` | S1/S2/S7 + S8 grep | 核心语义变更，单独成 commit 便于回滚；replay 机制在此单元内验证保留（S7） |
| **U2 持久化** | SNAPSHOT_VERSION bump v2；快照 status 枚举收窄；deserializeRun 适配；旧 v1 文件跳过（D-5）；loadAll 恢复语义保持现状（D-2 落点 2 已在 index.ts，无需改） | `orchestration/jsonl-run-store.ts` | S3 + S8（旧文件） | 依赖 U1 的状态定义；格式变更是独立可验证单元 |
| **U3 接口面 + 生命周期 handler** | index.ts session_tree/session_shutdown 两处 pauseRun 替换为「running → done,failed + 落盘」helper（D-2 落点 1）；tool-workflow action enum + description；commands verb/补全/case；command-actions 纯函数；WorkflowsView ViewActions/按键；gui-mappers 状态映射；类型收窄 | `index.ts`、`interface/tool-workflow.ts`、`interface/commands.ts`、`interface/command-actions.ts`、`interface/views/WorkflowsView.ts`、`interface/gui-mappers.ts` | S4 + S1 + S3② | 依赖 U1 的函数删除；对外 API 变更单独成 commit 便于 CHANGELOG 对应 |
| **U4 文档** | workflows/README.md、promptGuidelines、模块头注释、CHANGELOG（breaking） | `workflows/README.md`、`interface/tool-workflow.ts`（description 部分若 U3 未含）、CHANGELOG.md | S8 | 最后做，核对代码终态后回写，防漂移 |

**待验证检查点**（实施期确认，设计阶段诚实标注）：

1. S7 注入点已定稿且源码核实可达（§4 S7：`process.exit(1)` / 顶层 `throw` 两路；worker-script-builder.ts 用 `new Worker(code, {eval:true})` 内联执行、无沙箱层，worker thread 的 process 全局标准可用）。
2. D-2 落点 1 的 helper 形态（复用 abortRun 的 transition+save 骨架 vs 抽取新 helper——以不引入循环依赖为准）。
3. `executeNestedWorkflow` 的轮询路径是否引用 paused 态（grep 未命中，实施时编译期确认）。

---

## 附：与 subagent 侧模型的同构关系（设计哲学备忘）

本方案完成后，两个子系统的生命周期模型同构：

| | subagent（conversation mode） | workflow（本方案后） |
|---|---|---|
| 存储态 | active / closed（V4 B-1 方向） | running / done |
| 执行体 | pi 子进程（生灭无损，session 文件是状态源） | worker thread（一次性，与 run 同生共死） |
| 「挂起」语义 | 派生态：进程死 + record 活 = resumable | **不存在**（已确认接受：session 切换作废；未来需求走事件日志 checkpoint 独立方案） |
| 崩溃/切换处置 | 跨重启重建矩阵 | kill-9 残留转 failed + session 切换当刻转 failed（D-2） |

差异的唯一理由是状态源是否免费：subagent 的对话历史由 pi 免费持久化（进程可杀可续），workflow 的脚本执行进度无免费载体（worker 死即终态）。两态模型是两侧共同的收敛点。
