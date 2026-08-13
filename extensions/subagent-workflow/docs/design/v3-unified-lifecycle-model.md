# Subagent 生命周期统一模型技术方案（V3 三层模型）

> **一句话结论**：当前 subagent 生命周期的 13 个已知问题（idle 中间态矛盾、跨重启续聊坏、one-shot 不能续聊、fork 后 subagent 被杀且失联、compact 吞 subagentId 引用等）不是 13 个孤立 bug，而是同一个根因的投影——**record 逻辑状态、进程物理状态、session 归属**三件事缠在一起，没有分层模型。本方案建立三层正交模型（L1 record 逻辑态 / L2 进程物理态 / L3 归属与恢复）+ 父子联动矩阵 + `before_agent_start` 状态注入，把 13 个问题归位到 8 个子方案（SP-1~SP-8）分两期落地。核心取舍：**保留 chatMode 作为 start 时的续聊许可声明（新增 upgrade 转换），不一步到位取消 chatMode 二元**——取消是已识别的终态方向，但它要求重写 archive/GC 语义，不该与互斥/恢复修复捆绑。

## 层声明

- **当前层**：技术方案设计（生命周期统一模型 + 父子联动策略 + 子方案划分）
- **下一层产物**：8 个子方案（SP-1~SP-8）各自的技术方案 / 实现计划
- **性质**：涉及运行时行为（进程生命周期、并发互斥、hook 注入时机）、数据流（record 状态 / session 文件 / 注入消息流）、错误处理（双写者、EPIPE、级联关闭）→ 设计准则 5/6/7 全部 P0 适用
- **与既有文档关系**：
  - `v2-step5-idle-state-removal.md`（删 idle + 互斥 + 跨重启恢复）：本文 SP-1/SP-2 直接承接其方案 B 的 B-1/B-2，不重复设计，只把它们放进三层模型坐标系
  - `v2-defense-ii-orphan-reaping.md`（孤儿收割）：本文 SP-7 承接其方案 B，补充 parentPid 链校验增强项，触发条件不变（spawn 改 detach）
  - `subagent-continuous-chat-v2.md`（V2 SSOT）：本文是 V2 之后的演进；V2 已落地的（进程长驻、统一投递、identity entry）不动

---

## §1 背景目标

### SCQA

- **S（情境）**：V2 持续对话范式已验证（chatMode 进程长驻 + 热路径 prompt + 冷路径 resume 兜底）。围绕它已产出两份设计（删 idle、孤儿收割），代码侧已有 idle timer（5min 超时回收）、ceiling 8 + LRU、EOF 级联自杀、归属守卫等机制。
- **C（冲突）**：设计讨论暴露出 13 个缺口（§2.2），散落在 idle 语义、并发互斥、跨重启恢复、fork/clone、compact、资源策略各处。逐个修补会重蹈「轻量 idle 中间态」覆辙——上一个补丁制造下一个矛盾（文档 v2-step5 的 idle 守卫身兼两职就是补丁叠补丁的产物）。
- **Q（问题）**：要不要建立一个统一的生命周期模型，把这些问题归位分层，再按层分子方案落地？模型怎么切分才能既解决存量缺口、又不引入新的中间态？
- **A（答案）**：三层模型——L1 record 逻辑态（可交互/已关闭/已归档，与进程死活无关）、L2 进程物理态（absent/spawning/alive{busy,idle}/dead，纯性能缓存层）、L3 归属与恢复（rootSessionId + session 文件 + 父事件联动矩阵）。13 个问题按层归位为 8 个子方案（§5）。

### 系统是什么（给不懂内部的人）

`@zhushanwen/pi-subagent-workflow` 让主 pi 进程 spawn 独立子进程跑 subagent（`pi --mode rpc`），父子经 stdin/stdout 管道通信。每个 subagent 有两个持久化物：① 子进程自己的 **session 文件**（JSONL，对话历史，resume 的凭证）；② 主进程侧的 **record**（ExecutionRecord，内存 + manifest，记录状态/pid/rootSessionId/chatMode 等元数据）。

当前实现里三个概念纠缠：

| 概念 | 当前载体 | 纠缠点 |
|---|---|---|
| 「这个 subagent 能不能继续聊」 | record.status（running/idle/done/failed/...）+ chatMode 布尔 | idle 既是「record 可续聊」又暗示「进程空闲活着」；done 对 chatMode 不是终态、对 one-shot 是终态 |
| 「进程活没活」 | getChildByRecord + child.killed + .alive sidecar | record.status="running" 不代表进程活（跨重启后是 crashed）；进程死不代表 record 死（可冷 resume） |
| 「这个 subagent 归谁」 | record.rootSessionId（spawn 时盖章，终身不变） | 主 session /fork 后 id 变更，旧 record 归属断裂，变成「进程可能活着但任何 session 都够不到」 |

V3 模型要做的就是把这三者拆成三个正交层，各自有独立状态机，交互只通过明确定义的路由函数。

### 设计目标

| # | 目标（使用者 = 主 agent / 用户视角） | 当前状态 |
|---|---|---|
| G1 | **续聊能力可预测**：任何非 closed 的 subagent 都能 message，进程保活只是透明的性能优化；one-shot 完成后可显式 upgrade 续聊 | ❌ one-shot done 后 message 报 not found/ended |
| G2 | **父事件语义明确**：主 session fork/new/compact/删除/崩溃时，subagent 的遭遇有定义、可预期、被告知 | ⚠️ /fork /new 隐式全杀且归属断裂（P5）；compact 丢引用（P6） |
| G3 | **并发安全不依赖状态字面量**：单写者不变量由显式互斥锁承担，不靠 idle 守卫兼职 | ⚠️ 当前靠 idle 守卫 CAS（文档 v2-step5 问题 A） |
| G4 | **主 agent 始终知道活跃 subagent 清单**：compact 后引用不丢，能正确 message/close | ❌ compact 摘要可吞 subagentId |
| G5 | **资源有界且可调**：idle timeout、ceiling 可配置；默认值有依据（prompt cache TTL） | ⚠️ 5min/8 硬编码 |
| G6 | **跨重启/崩溃恢复可用**：主进程重启后能续聊（承接文档 v2-step5 G3/G4） | ❌ 当前坏（hydrateIdleRecord 死路径） |

### In-scope / Out-of-scope

**In-scope**：三层模型定义与落地路线；父子联动矩阵（fork/new/compact/删除/退出/崩溃）；before_agent_start 状态注入；one-shot upgrade；activation 互斥 + EPIPE 兜底；idle timeout/ceiling 配置化；跨重启恢复（承接 v2-step5）。

**Out-of-scope**：
- spawn 改 detach（触发条件未到，届时 SP-7 激活）
- pi 上游 session 文件锁（非本项目可控，V2 附录 B；本项目只维护单写者不变量）
- 嵌套全树可见性深度 ≥2 断裂（存量 bug，subagent-service.ts:239 注释已承认，SP-8 单独修，非模型问题）
- 多主 agent 挂靠同一 subagent（明确否决：record 状态跨进程分裂 + 双写者变种）
- pi-context-engineering 已废弃，其压缩规则不在考虑范围；compact 仅指 pi 内建 compaction

---

## §2 现状与问题分析

### 2.1 现状：一次 message 的真实旅程（物理数据流）

```
[主 agent LLM] 发出 tool call: {action:"message", messageParam:{subagentId:"sa-x", text:"继续"}}
        │
        ▼
messageHandler (subagent-actions.ts:334)
        │  ① getRecordForAction(id)：内存 store 找 record，
        │     校验 record.rootSessionId === this.sessionRootId（归属守卫，:761）
        │     —— 不匹配即 "not found or not owned"（不区分，防探测）
        ▼
  record.chatMode? ────┬── true → deliverMessage：判进程死活（getChildByRecord+child.killed）
        │              │            ├─ 活 → 热路径：stdin 写 prompt+streamingBehavior（毫秒级）
        │              │            └─ 死 → 冷路径 resumeRound：spawn 新进程 --session 重开（秒级）
        │              └── false → 按 status 分流：running→busy 投递 / idle→resumeRound / 终态→throw ended
        ▼
[子进程 pi] 串行消费 stdin 行；busy 时 followUp 排队 / steer 抢占；idle 时直接开新 turn
        │  session 文件由子进程单线程顺序 append（单进程内无并发写）
        ▼
轮次完成 agent_settled → onRoundSettled：record.status="idle" + round+=1 + armIdleTimer(5min)
        │  idle timer 超时 → SIGTERM 回收进程（进程死，record 仍 idle）
        ▼
notify 主 agent：isIdle()=false 时退避等 idle 再发（triggerTurn 只在非 streaming 生效），
达退避上限强制发（notifier.ts:43-68 已覆盖「主 agent busy 时不抢」）
```

**当前进程绑定的两道保险**（已核实，文档 v2-defense-ii §2.2）：父进程正常退出 → dispose 显式 kill 全部 spawned children（两层兜底）；父进程被 SIGKILL → stdin 管道写端关闭 → 子进程 EOF 自杀，嵌套场景级联（主死→子 EOF 自杀→孙 EOF 自杀，Unix 管道语义自动完成）。当前 spawn 配置（piped stdio）下孤儿近乎不可能泄漏。

### 2.2 问题清单（13 项，全部经代码核实）

| # | 问题 | 真实失败模式（触发条件 → 现象） | 根因层 |
|---|---|---|---|
| P1 | idle 是自相矛盾的中间态 | 纯内存态（idle-marker.ts 已删）却保留磁盘水合函数 hydrateIdleRecord（死路径，永远返回 undefined） | L1/L2 混 |
| P2 | 跨重启续聊坏 | chatMode 对话中重启主进程 → record 变 crashed → message throw "has ended"，对话丢失 | L1/L2 混 |
| P3 | 单 activation 互斥靠 idle 守卫兼职 | resumeRound 的 idle 检查+CAS 是唯一防双 spawn 机制；删 idle 即失去互斥 → 双写者毁 session 文件 | L2 缺位 |
| P4 | one-shot 不能续聊 | 非 chatMode done 后 archive，message 报 not found；想基于已完成的探索继续问，只能全新 start（上下文从头来） | L1 过严 |
| P5 | 主 session /fork、/new 杀全部 subagent 且归属断裂 | pi fork 创建新 sessionId（session-manager.js:1133 已核实）→ dispose 杀全部子进程 → revive 后 sessionRootId 变更 → 旧 record 归属守卫拒绝 → subagent「被杀 + 失联」双输 | L3 缺位 |
| P6 | compact 吞 subagentId 引用 | 主 agent 上下文超限触发 pi compaction → LLM 摘要不保证保留 subagentId 与「它还活着」的事实 → 主 agent 忘记有活 subagent，重新 start 重复的 | L3 缺位 |
| P7 | deliverMessage 判活→写之间的 EPIPE 窗口 | getChildByRecord 判活后、写 stdin 前进程死亡 → EPIPE 异常 ⛔ 当前是否有兜底未核实（SP-1 探针） | L2 缺位 |
| P8 | idle timeout 5min 硬编码 | 长间隔多轮协作场景进程被回收，每轮付冷启动税；5min 默认值与 Anthropic prompt cache TTL 撞车是双刃剑（见 D8） | 资源策略 |
| P9 | conversation 场景引导不足 | tool description 已写成本与「Always close」，但未给「什么场景该用」的正反清单，主 agent 选择随意 | 资源策略 |
| P10 | ceiling 8 在嵌套树下乘积无控制 | 每进程 8 个活进程额度，深度 N 嵌套树理论峰值 8^(N+1) 进程 | 资源策略 |
| P11 | turn-limiter 在 chatMode 语义未定义 | maxTurns 对无限续聊的 chatMode 是每轮 reset 还是全程累计？graceTurns 呢？未定义 | 资源策略 |
| P12 | worktree 生命周期未绑定 record | worktree-manager 有 cleanup(handle)（remove+branch -D+注册表移除），但 record close/级联杀/fork 时是否触发清理 ⛔ 未核实 | L3 缺位 |
| P13 | notify 投递策略 | ✅ 已覆盖（notifier busy 退避），仅需文档化——不算缺口，列出以防重复立项 | — |

另有一项存量 bug 不计入模型问题：嵌套场景 enc(worktree) 下全树可见性深度 ≥2 断裂（subagent-service.ts:239 注释承认）→ SP-8 单独修。

### 2.3 根因：三个缺失

13 个问题归到三个根因：

- **R1（L1/L2 不分）**：record 状态机把「逻辑上能不能续聊」和「物理上进程活没活/闲没闲」混在一个 status 字段里。idle 身兼「可续聊」「进程空闲」「activation 互斥锁」三职；done 对两种模式含义不同。→ P1/P2/P3/P4/P7
- **R2（L3 缺位）**：归属在 spawn 时静态盖章（rootSessionId），之后父 session 的任何生命周期事件（fork/new/compact/删除）都没有定义对 subagent 的策略。归属是「盖章时正确」，不是「全程正确」。→ P5/P6/P12
- **R3（资源策略硬编码）**：timeout/ceiling/turn 限制是常量，不与场景匹配，也无配置出口。→ P8/P9/P10/P11

---

## §3 解决方案

### 3.1 终态（使用者视角）

主 agent 是首要使用者（它调 subagent tool），用户是最终受益者。以下样例中「机制」行对主 agent 透明。

**场景 A：one-shot 完成后想追问（G1，新增能力）**

```
[主 agent] start {task:"摸一下 auth 模块的调用链", slug:"explore-auth"}
           → sa-a1b2，完成后 notify（one-shot，进程已退出，lastResult=success）
[主 agent] message {subagentId:"sa-a1b2", text:"再看下 refresh token 的旋转逻辑"}
[机制]   record 非 closed → L2 进程 absent → 冷路径 resume（--session 重开，上下文完整）
         → 本轮起 record 标记为可续聊（upgrade 自动发生，无需预先声明 conversation）
[主 agent] 收到续聊轮次的 notify，引用首轮探索结果继续答
```

**场景 B：高频多轮协作（G1 热路径，现状保留）**

```
[主 agent] start {task:"迭代 review 这个 diff", slug:"review", conversation:true}
           → 每轮完成后进程保持（idle timer arm，超时回收）
[主 agent] message "第二轮：修好那 3 个 must-fix" → 热路径 prompt（毫秒级，无 spawn）
[机制]   距上轮 <5min：provider prompt cache 大概率命中（默认 timeout 的依据）
[主 agent] close {subagentId} → 显式释放（进程回收、record closed、worktree 清理）
```

**场景 C：主 session fork（G2，新语义）**

```
[用户] 在 pi CLI 对主 session /fork（分支平行对话）
[机制] fork 前：所有活跃 subagent 收到级联 close（record 标 closed{reason:"parent-fork"}，
       进程回收，worktree 清理）；fork 后新 session 的 list 干净
[用户] 看到告知："2 个活跃 subagent（sa-a1b2, sa-c3d4）已随 fork 关闭；
       👉 如需在新分支继续其工作：重新 start 并附原 task 摘要，或用 subagent session 文件冷克隆（未来 SP-7 后可选）"
```

**场景 D：compact 后引用恢复（G4，新增能力）**

```
[主 agent] 长对话中触发 pi compaction，摘要吞掉了 sa-a1b2 的存在
[机制] 下一轮 agent loop 开始，before_agent_start hook 注入对话流消息（display 可选）：

  [subagent-status] 2 active subagents (compact-safe snapshot):
  - sa-a1b2 (explore-auth): resumable, 2 rounds, last: "auth 调用链已梳理"
  - sa-c3d4 (review): running, started 3m ago
  Use action:"message" to follow up; action:"close" when done.

[主 agent] 正确 message 续聊 / close 释放，不再重新 start 重复 subagent
```

**场景 E：并发 message 不双写（G3，承接文档 v2-step5）**

```
[主 agent] LLM 同一 turn 并发两个 tool call message 同一 record（进程刚死）
[机制] acquireActivateLock 串行化：msg1 持锁 spawn → 注册 → 放锁；msg2 等锁 →
       拿到锁发现进程已活 → 转热路径 prompt。session 文件单写者成立。
[失败路径] msg1 spawn 异常 → finally 放锁 + 30s 锁超时兜底；msg2 不永久挂起，
       👉 超时报错信息含 "retry action:'message'" 恢复指引
```

**场景 F：EPIPE 透明兜底（G3，新增）**

```
[机制] 热路径写 stdin 时进程恰好死亡（EPIPE）→ 捕获 → 自动转冷路径 resume + 原消息重放
[主 agent] 无感知（只看到本轮延迟略高）；连续 EPIPE 2 次 → 报错
       👉 "subagent sa-x process unstable; action:'close' and start a new one"
```

**场景 G：跨重启续聊（G6，承接文档 v2-step5 场景 2，修复 P2）**

```
[用户] chatMode 对话 ≥2 轮后重启主进程（同 session-dir）
[机制] 子进程 EOF 自杀；重启后 reconstructAll 识别「session 文件在 + chatMode」→ 可恢复
[主 agent] message → 冷路径 resume → parentId 链连续，引用重启前对话
```

### 3.2 多方案对比（整体路线）

| 方案 | 长期架构合理性 | 短期实现成本 | 风险 | 裁决 |
|---|---|---|---|---|
| **A 全统一**：取消 chatMode 二元，所有 record 完成后默认可续聊（进程保活策略正交化为 keepAlive 参数） | ✅ 终态最干净：L1 只剩 active/closed，「能不能续聊」不再是模式 | 高：done 语义重写——archive 时机、list 过滤、notifier、GUI 显示、GC 策略全部重设计；向后兼容破裂 | 中-高（archive 语义重写牵一发动全身） | 🔵 **已识别为终态方向，本期不做** |
| **B 三层模型 + 保留 chatMode + upgrade**（本方案） | ✅ 三层分离成立（R1/R2/R3 全解）；chatMode 退化为「start 时的续聊许可 + 进程保活 hint」，upgrade 弥合 one-shot 鸿沟 | 中：SP-1/SP-2 承接已有设计（v2-step5 方案 B），新增 SP-3/SP-4 为独立模块 | 中（互斥接入死锁风险，有超时兜底） | ✅ **本期推荐** |
| **C 点状修复**：只修 P2/P5/P6 等痛点，不建模型 | ❌ 13 个问题的根因（三层纠缠）还在，下一个缺口会出现；补丁叠补丁（idle 守卫身兼两职就是这么来的） | 低（每项独立小改） | 中（技术债累积） | ❌ 否决 |

**被否方案 C 的具体后果**（若用它，§2.2 的例子会变成）：P2 单独修（reconstructAll 加分支）后，P5 的 fork 场景再造一个「record 重建但归属断裂」的变体；P6 单独修（compact 保留规则）后，hook 注入需求仍会在别的引用丢失场景出现。每个修复都正确，但没有一个让「下一个问题」更容易——模型缺位时，问题数量随功能增长线性增长。

**A 与 B 的关系**：B 落地后，chatMode record 与 upgrade 后的 one-shot record 行为完全同构（都可续聊、都走 L2 路由），届时取消 chatMode 标志只剩「改默认值 + 重写 archive 语义」一件事，A 成为低风险收尾。B 是通往 A 的安全路径，不是与 A 竞争的终点。

### 3.3 三层模型定义

**L1 — record 逻辑状态机（「能不能交互」）**

```
        start
          │
          ▼
      ┌────────┐   close / cancel / 父事件级联关闭    ┌────────┐   GC/tombstone   ┌───────────┐
      │ active │ ──────────────────────────────────→ │ closed │ ───────────────→ │ archived  │
      └────────┘                                     └────────┘                  └───────────┘
```

- active 期间**任何 message 合法**（L2 决定走热还是冷）；「上一轮结果」是 record 的属性（lastResult: success/failure/cancelled），不是状态。
- chatMode 是 start 时的声明：① active 期间允许 message（许可）；② 轮次完成后进程保活策略（hint）。one-shot 的 message 触发 upgrade（置许可位），之后与 chatMode 同构。
- **idle/done/failed 从 L1 删除**。failed 轮次后 record 仍 active（可重试）；closed 是唯一终态入口。
- 现状迁移：ExecutionStatus 的 done/failed/cancelled/crashed → closed 的 reason 子枚举 + lastResult 属性；UI/排序从「status 字面量」改为「L1 状态 + L2 派生 + lastResult」。

**L2 — 进程物理状态机（纯性能缓存层，与 L1 正交）**

```
  absent ──spawn──→ spawning（acquireActivateLock 持锁）──spawned──→ alive ──exit/kill/EOF──→ dead ──→ absent
                                       │                               │
                                       └──异常──→ finally 放锁          ├─ busy（turn 进行中）
                                       + 30s 超时兜底                    └─ idle（hasIdleTimer 派生）
```

- message 路由 = f(L1, L2)：L1=active × L2=alive → 热路径；L1=active × L2∈{absent,dead} → 冷路径（经 spawning 持锁）；L1=closed/archived → not found/ended + recovery 指引。
- **busy/idle 由 hasIdleTimer 派生，不存字面量**（v2-step5 决策 2）。
- 单写者不变量：同一 record 任意时刻至多一个 alive 进程——由 spawning 态互斥锁保证，不依赖任何 L1 字面量。
- EPIPE 兜底：热路径写失败 → 进程按 dead 处理 → 转冷路径重放原消息（连续 2 次失败才报错）。

**L3 — 归属与恢复（「谁够得到它、它凭什么恢复」）**

- 归属不变量：record.rootSessionId = 真 ROOT session id（嵌套时 env 贯穿，现状保留）。**父事件改变 sessionRootId 时，必须先对活跃 record 执行联动策略，再允许变更生效**（§3.4 D6 矩阵）。
- 恢复凭证 = session 文件（JSONL）：文件在 + L1=active → 可冷 resume；与进程死活、pid、.alive sidecar 无关（sidecar 只判定「热路径可行否」）。
- 跨重启：reconstructAll 把「session 文件在 + 非 closed」的 record 重建为 L1=active / L2=absent（不再有 crashed 字面量；「进程怎么死的」记入 lastResult.reason）。

**父子联动矩阵（L3 核心表）**

| 父事件 | subagent 策略 | record 标记 | 用户/主 agent 告知 |
|---|---|---|---|
| 正常退出（SIGTERM/dispose） | 级联关闭（现状已有 killAll） | closed{reason:"parent-shutdown"} | 无需（进程都要没了） |
| 崩溃（SIGKILL/断电） | EOF 级联自杀（现状）；重启后可恢复 | 重启后 active（L2=absent） | 重启后 list 显示 resumable |
| compact | 无直接影响（subagent 独立 session 文件） | 不变 | before_agent_start 注入快照（D5） |
| /fork | 级联关闭（fork 生效前执行） | closed{reason:"parent-fork"} | 显式告知 + 恢复指引 |
| /new | 级联关闭（同上） | closed{reason:"parent-new"} | 同上 |
| session 删除（xyz-agent） | pi 进程被杀 → EOF 级联（现状） | —（进程没了，record 随 manifest 残留，GC 收） | — |
| message | L1 守卫 + L2 路由 | — | — |

**被否的 fork 替代策略**：(b) 归属过继（改写 rootSessionId 给新 session）——活子进程 env 里的 ROOT 不可改，热进程归属分裂，实现复杂且语义混乱（fork 的语义是平行分支，两个分支若都恢复则共享 subagent = 双写者变种）；(c) 冷克隆（新 session start + resume 同一 subagent session 文件）——要求旧进程死透，本质是「复制 subagent」，可作为未来的显式操作（非 fork 默认行为）。

### 3.4 关键决策与权衡

**D1：三层模型（L1/L2/L3 正交）**
- 选择：如 §3.3。依据：13 个问题的根因归类（R1/R2/R3）与三层一一对应；deliverMessage 现有的「按进程死活分流」已是 L1/L2 分离的雏形，模型是把事实显式化。
- 被否：两层（record+进程合并）——就是现状，R1 根因；四层（再拆 UI 层）——UI 是派生消费方，不是状态源，准则 8 减法。

**D2：保留 chatMode + upgrade，不一步到位取消（方案 B 核心取舍）**
- 选择：chatMode = start 时声明（许可 + 保活 hint）；one-shot 首次 message 自动 upgrade。
- 依据：取消 chatMode 要求重写 archive/GC 语义（record 何时真正死亡：close？超时 GC？session 结束？），这是独立大决策；与互斥/恢复修复捆绑会放大 PR 风险（v0.3.8 PR #61 一 commit 多改动引入双 bug 的事故教训）。
- 被否：一步到位取消（方案 A）——见 §3.2；不做 upgrade（维持 P4）——用户场景「探索完后追问」真实存在，冷 resume 基础设施已具备，成本只是放开 L1 守卫。

**D3：activation 互斥 = acquireActivateLock + finally 放锁 + 30s 超时兜底**
- 承接文档 v2-step5 决策 1，不重复设计。本文补充：锁的语义归入 L2 spawning 态（状态机显式化），不再依赖 idle 守卫 CAS。
- 探针（⛔ 实施期）：并发双 message 只 spawn 一次；spawn 异常放锁不死锁；超时兜底生效。

**D4：跨重启恢复 = 「session 文件在 + 非 closed」即可恢复，crashed 字面量删除**
- 承接文档 v2-step5 决策 3。本文补充：crashed 从 L1 删除后，「进程非正常死亡」降为 lastResult.reason，可恢复性只看恢复凭证（session 文件）与 L1 状态——语义从「记录怎么死的」变为「记录还能不能用」，与使用者意图对齐。
- 探针（⛔）：重启后续聊 parentId 链连续；无孤儿残留。

**D5：compact 引用恢复 = before_agent_start 每 loop 注入活跃 subagent 快照（主方案）；session_before_compact 自定义摘要（二期增强）**
- 选择：注册 before_agent_start hook（types.d.ts:865 已核实存在，xyz-system-prompt-extension.js 已示范用法），有活跃 subagent 时返回 `message`（customType:"subagent-status"，content 如 §3.1 场景 D；无活跃 subagent 时不注入，零成本）。
- 依据：① BeforeAgentStartEventResult.message 机制已存在（types.d.ts:794 已核实），注入对话流 = 进入 LLM 上下文且随历史持久化；② 每 loop 重注入 = compact 后下一个 loop 自动恢复引用，**不依赖 compact 摘要质量**（摘要质量是 LLM 行为，不可控；hook 注入是 extension 行为，可控）；③ 附带收益：快照提醒主 agent「不用的记得 close」，缓解 P9 的泄漏习惯。
- 成本控制：最多 10 条，每条一行；超过显示 "+N more, use action:'list'"。
- 被否：仅 session_before_compact 自定义摘要（types.d.ts:435 已核实存在）——依赖 CompactionPreparation 可注入结构，且摘要仍是 LLM 生成，保留不可控；作为二期增强（compact 时把 subagent 清单塞入保留指令），非替代。
- 探针（⛔ 实施期）：P-inject-1 注入消息出现在 LLM 上下文且持久化到 session 文件；P-inject-2 compact overflow 自动 retry 的 turn 是否触发 before_agent_start（决定 compact 后第一个 retry turn 有无快照；若无，快照从下一个用户 loop 起生效——可接受，需文档化）；P-inject-3 无活跃 subagent 时零注入零开销。

**D6：父 fork/new = 级联关闭 + 告知（矩阵见 §3.3 L3）**
- 依据：fork 语义是平行分支，subagent 的对话上下文属于旧分支；过继制造双写者变种（§3.3 被否 b/c）。
- 实现要点：pi 的 /fork /new 路径触发 session_shutdown→dispose（现状已杀进程，revive 注释已核实），本决策的增量是：① record 标记从「下次重启 reconstruct 成 crashed」改为 dispose 时主动写 closed{reason}（语义正确化）；② 告知消息（fork/new 后主 agent 第一轮可见）。
- 探针（⛔）：/fork 后旧 subagent 进程全灭（ps 无残留）；record 在旧 session list 显示 closed 而非 crashed；新 session list 干净。

**D7：session 删除（xyz-agent）维持现状（EOF/信号级联），不做归属过继**
- 依据：删除是不可逆操作，级联死亡是唯一合理解。record manifest 残留由既有 GC（session-file-gc）收。
- 探针（⛔）：xyz-agent 删除主 session 后 ps 无 subagent 残留。

**D8：idle timeout 配置化（默认维持 5min）；ceiling 配置化（默认 8）；嵌套乘积不做树级控制**
- 选择：timeoutMs 从 start 参数透传（armIdleTimer 已支持参数，只缺透传）+ 全局 env 默认覆盖（如 PI_SUBAGENT_IDLE_TIMEOUT_MS）；ceiling 同理。
- 默认 5min 的依据（防拍脑袋改 30min）：5min = Anthropic prompt cache TTL。timeout 内续聊吃双红利（免 spawn + cache 命中省 input token）；timeout 外即使进程活着，cache 已过期，热路径只剩免 spawn 红利。调大到 30min 的收益仅限「免 spawn」，代价是内存窗口 ×6 + ceiling 更容易触顶（LRU 挤出别的活跃进程）。
- 嵌套乘积（P10）：每进程 8 × 深度 N = 8^(N+1) 理论峰值。裁决：known limitation 文档化，不做树级总量控制（嵌套深度本身有限制；树级控制需要跨进程协调，复杂度不成比例——准则 8 减法）。
- 探针（⛔）：start 传 idleTimeoutMs 生效；env 覆盖默认值生效。

**D9：turn-limiter 语义（P11）**
- 选择：chatMode 下 maxTurns 按「每轮 reset」（一轮 = 一次 message 到 agent_settled），graceTurns 同；全程累计不做（续聊本质是无限轮，累计上限违背 G1）。
- 细化归 SP-8。

**D10：worktree 绑定（P12）**
- 选择：record 进入 closed（任何路径：close/cancel/级联）时触发 worktree cleanup（worktree-manager.cleanup(handle) 已存在：remove + branch -D + 注册表移除）。
- ⛔ 待核实：当前 close/dispose 路径是否已触发 cleanup（若已触发，本决策退化为「覆盖级联关闭路径」）。
- 细化归 SP-4。

**D11：notify 策略维持现状 + 文档化（P13 关闭）**
- 现状已核实：busy 退避（isIdle()=false 等 idle 再发）+ 退避上限强制发（notifier.ts:43-68）。无抢占主 agent busy turn 的问题。仅需在扩展文档中写明该语义，防止未来误改。

**D12：EPIPE 兜底（P7）**
- 选择：热路径 stdin 写捕获 EPIPE/ERR_STREAM_DESTROYED → 进程按 dead 处理 → 自动冷路径 resume + 重放原消息；同一 record 连续 2 次失败才报错（恢复指引见 §3.1 场景 F）。
- ⛔ 待核实：stdin-writer 当前对写失败的现有处理（可能已有部分兜底，SP-1 探针确认后补齐）。

---

## §4 验收（真实场景，非单测）

**验收环境**：本地 pi CLI 实测（AGENTS.md [MANDATORY]：pi extension 优先在本地 pi 验证，不优先在 xyz-agent）——`pi --mode rpc --session-dir <dir> --model xiaomi-token-plan-cn/mimo-v2.5-pro --approve --extension <ext-path>`，stdin JSONL 发 prompt，检查 session 文件 + `PI_EXT_DEBUG=1` 日志。改动规模：大（状态机重构 + 新 hook + 联动矩阵），以下场景全部真实环境验证，单测仅回归辅助。

### S1：one-shot upgrade 续聊（回溯 G1，SP-5）

- 步骤：① rpc 模式 start 一个 one-shot subagent（task="列出 extensions/ 下所有包名"）；② 等完成 notify；③ message 追问「这些包里哪些有 workflows 目录」；④ 再 message 第三轮。
- 通过标准：③自动冷 resume（新 pid），回答引用首轮结果（证明上下文连续）；④同记录续聊正常；list 显示该 record 可续聊态；全程 spawn 次数 = 2（首 start + 首次 message 冷启动），③之后若进程活则热路径。

### S2：高频多轮热路径不回归（回溯 G1，SP-1）

- 步骤：conversation:true 起 reviewer subagent，连发 3 轮 message，/subagents list 观察。
- 通过标准：spawn 次数 = 1；parentId 链连续；每轮 notify 到达；进程空闲显示由 hasIdleTimer 派生（无 idle 字面量——grep ExecutionStatus 无 "idle"）。

### S3：并发 message 单写者（回溯 G3，SP-1）

- 步骤：① chatMode record 空闲（进程活）；② kill 子进程；③ 同一 turn 并发两条 message。
- 通过标准：spawn 次数 = 1；session 文件 parentId 链完整（无双写交错）；第二条等锁后走热路径。再注入 spawn 异常 mock → 锁释放，后续 message 不挂起，错误信息含恢复指引。

### S4：EPIPE 透明兜底（回溯 G3，SP-1）

- 步骤：chatMode 进程空闲时，用脚本在 message 发出的瞬间 kill 子进程（制造判活→写之间的死亡窗口，可循环 50 次提高命中）。
- 通过标准：message 不报错，自动冷 resume 后正常完成本轮；session 文件无错乱；日志记录 EPIPE→冷路径转换一次。

### S5：跨重启续聊（回溯 G6，SP-2）

- 步骤：① chatMode 对话 2 轮；② kill -9 主进程；③ 同 session-dir 重启；④ message 续聊。
- 通过标准：无 "has ended"；续聊引用重启前对话（parentId 链连续）；ps 无孤儿残留；list 显示 resumable 而非 crashed。

### S6：compact 引用恢复（回溯 G4，SP-3）

- 步骤：① 起 2 个 subagent（一个完成一个 chatMode 空闲）；② 主 agent 进行超长对话直到触发自动 compaction（可用低 context 阈值模型或灌长文本加速）；③ compact 后让主 agent「继续之前 subagent 的工作」。
- 通过标准：compact 后第一个 loop 的对话流中出现 subagent-status 快照消息（含正确 id）；主 agent 用正确的 sa-id 调 message（不重新 start 重复 subagent）；无活跃 subagent 时全程无注入。

### S7：fork 级联关闭语义（回溯 G2，SP-4）

- 步骤：① chatMode subagent 空闲中；② 主 session /fork；③ 观察进程与 record。
- 通过标准：fork 后旧 subagent 进程全灭（ps 验证）；record 标 closed{reason:"parent-fork"}（非 crashed）；新 session list 干净；告知消息出现且含恢复指引。/new 同法验证。

### S8：资源策略配置化（回溯 G5，SP-6）

- 步骤：① 设 PI_SUBAGENT_IDLE_TIMEOUT_MS=60000 起 chatMode subagent；② 65s 内观察进程存活；③ start 时透传 idleTimeoutMs=10000，11s 后观察。
- 通过标准：①65s 时进程已回收（非 5min）；③11s 时回收；未配置时默认 5min。

### S9：worktree 级联清理（回溯 G2，SP-4）

- 步骤：start 带 worktree 参数的 subagent → close（先）/ 主进程 SIGTERM（后）两条路径各验一次。
- 通过标准：git worktree list 无残留、分支已删、注册表清空；两条路径行为一致。

---

## §5 下一层拆分

### 5.1 子方案清单（依赖序）

| SP | 子方案 | 目标（回溯） | 关键决策来源 | 验收 | 依赖 |
|---|---|---|---|---|---|
| SP-1 | **L1/L2 状态机重构**：删 idle/done/failed/crashed 字面量 → L1 active/closed + lastResult；L2 显式化（spawning 互斥锁 + EPIPE 兜底 + hasIdleTimer 派生）；16+ 处 idle 消费替代 | G1/G3 | D1/D3/D12 + v2-step5 方案 B（B-1/B-3/B-4 直接承接） | S2/S3/S4 | 无（**最先做**） |
| SP-2 | **跨重启恢复**：reconstructAll 重建为 L1=active/L2=absent + 删 hydrateIdleRecord 死路径 | G6 | D4 + v2-step5 B-2 | S5 | 无（可与 SP-1 并行；= v2-step5 方案 C 止血子集） |
| SP-3 | **before_agent_start 状态注入**：hook 注册 + 快照格式 + 成本控制 + compact retry 探针 | G4 | D5 | S6 | 无（独立模块，随时可做） |
| SP-4 | **父子联动矩阵落地**：fork/new 级联关闭语义化（closed reason + 告知）+ worktree 绑定清理 + notify 策略文档化 | G2 | D6/D7/D10/D11 | S7/S9 | SP-1（closed reason 依赖 L1 重构） |
| SP-5 | **one-shot upgrade**：message 对非 chatMode active record 放开（L1 守卫调整 + identity 补写 + archive 时机调整） | G1 | D2 | S1 | SP-1 + SP-2 |
| SP-6 | **资源策略配置化**：idleTimeoutMs 透传 + env 默认覆盖 + ceiling 配置 + conversation 场景化 description（正反清单） | G5 | D8 + P9 | S8 | 无 |
| SP-7 | **孤儿收割增强（deferred）**：文档 v2-defense-ii 方案 B + 增强项（.alive sidecar 记 parentPid 链，收割前校验「pid 是 pi 子进程 且 父链无存活」） | G3（detach 场景） | v2-defense-ii D1 + 本文增强 | 见该文档 §4 | **触发条件：spawn 改 detach**；当前不实施 |
| SP-8 | **存量语义修正**：turn-limiter chatMode 语义（D9）+ 嵌套可见性断裂修复（存量 bug） | G1/G2 | D9 | 单测 + 嵌套真实场景 | 无 |

**分两期**：
- **一期（本分支目标）**：SP-1 → SP-2 → SP-3 → SP-6（SP-2/SP-3/SP-6 互相无依赖，可并行；SP-1 是最大块）。
- **二期**：SP-4 → SP-5 → SP-8。SP-7 挂起等触发条件。

### 5.2 为什么这样拆（justification）

- **SP-1 最先且独立成块**：它是 L1/L2 的地基，SP-4/SP-5 的 closed reason / upgrade 都依赖它；它自身 = v2-step5 方案 B 的既有设计（B-1/B-3/B-4）+ EPIPE 兜底，设计已成形，不需要再等本方案的其他部分。
- **SP-2 独立**：它是唯一「用户可感知的功能修复」（跨重启续聊），且是 v2-step5 方案 C 的止血子集，可与 SP-1 并行先合。
- **SP-3 独立**：纯新增 hook 模块，不碰状态机，风险隔离。
- **SP-5 依赖 SP-1+SP-2**：upgrade 的冷 resume 依赖 L2 路由与跨重启水合的正确性（upgrade 后 record 要能被 reconstruct 识别为可续聊）。
- **SP-4 依赖 SP-1**：级联关闭的 record 标记（closed{reason}）依赖 L1 重构完成（当前 status 枚举没有 closed）。
- **SP-6 随时可做**：参数透传 + 文案，无状态机依赖，适合穿插。
- **SP-7 deferred 的理由**：v2-defense-ii 已论证当前 spawn 配置下孤儿不泄漏；本方案只给它补了 parentPid 链增强项，触发条件不变。提前实施 = 在不可能触发的场景投入中等复杂度（该文档 §3.2 方案 A 裁决）。

### 5.3 文件改动地图（一期）

| 文件 | SP | 改动 |
|---|---|---|
| `execution/types.ts` | SP-1 | ExecutionStatus 重构（L1/L2 分离 + lastResult + closed reason 枚举） |
| `execution/lifecycle-manager.ts` | SP-1 | acquireActivateLock 接入 + 超时兜底 |
| `execution/subagent-service.ts` | SP-1/SP-2 | deliverMessage 锁 + EPIPE 兜底；resumeRound 删 idle 守卫；hydrateIdleRecord 删除 + 水合重写；onRoundSettled 改 arm-only |
| `execution/record-store.ts` | SP-1/SP-2 | reconstructAll 可恢复识别；STATUS_PRIORITY 删 idle；collectRecords 按新 L1 过滤 |
| `execution/notifier.ts` | SP-1 | dedup 回归纯 id（v2-step5 决策 4）；status union 更新 |
| `execution/finalize-record.ts` | SP-1 | 删 doFinalizeRoundToIdle；终态化改 closed 语义 |
| `execution/session-runner.ts` | SP-1 | 删 pendingMessages 三环（v2-step5 决策 5） |
| `interface/subagent-actions.ts` | SP-1/SP-5 | messageHandler 按新 L1/L2 路由重写 |
| `interface/gui-mappers.ts` / `format.ts` | SP-1 | 显示改 L1+L2 派生 |
| `src/index.ts` | SP-3 | before_agent_start hook 注册（有活跃 subagent 时注入快照） |
| `execution/subagent-service.ts` | SP-3 | 新增 snapshot 格式化（复用 list 数据） |
| `interface/subagent-tool.ts` | SP-6 | conversation description 场景化 + idleTimeoutMs 参数 |
| `execution/lifecycle-manager.ts` | SP-6 | timeoutMs 透传 + env 默认 |

### 5.4 待验证检查点（设计阶段无法确定，实施期门）

1. **EPIPE 现状**：stdin-writer 对写失败是否已有兜底（决定 D12 是新增还是补齐）。
2. **compact retry 触发**：pi overflow recovery 的 retry turn 是否触发 before_agent_start（决定 D5 快照对 compact 后第一个 turn 的覆盖）。
3. **worktree 清理现状**：close/dispose 路径是否已触发 worktree cleanup（决定 D10 范围）。
4. **dispose 时 record 持久化时机**：dispose 杀进程后 record manifest 是否来得及写 closed（进程退出窗口短——可能需要 best-effort + 重启时 reconcile）。
5. **互斥锁退出路径全覆盖**：runSpawn 的 close/error/abort/chatMode resolve 四路都过 finally（v2-step5 已列，SP-1 实施期逐一验证）。
6. **upgrade 后 identity 补写**：one-shot 子进程 session 文件的 identity entry chatMode=false，upgrade 冷 resume 时子进程 session_start 补写 true 的机制（env 传入 or resume 参数）——SP-5 设计时定。
7. **净行数**：SP-1 落地后对比 v2-step5 预估的净减 270-330 行。

---

## 附录：与既有文档的关系

- **v2-step5-idle-state-removal.md**：其方案 B 被本文 SP-1/SP-2 完整承接（B-1→SP-1 互斥、B-2→SP-2、B-3/B-4→SP-1、B-5→SP-1 收尾）。本文新增：idle/done/failed/crashed 的替代不只是「删字面量」，而是 L1/L2 两层状态机重构（v2-step5 决策 2 的 hasIdleTimer 派生归入 L2）；其「防线 iii 冗余」结论的更新承诺（idle 删除后互斥由 acquireActivateLock 承担）由 SP-1 兑现。
- **v2-defense-ii-orphan-reaping.md**：结论与触发条件不变（当前 deferred，spawn 改 detach 时激活）。本文 SP-7 补充一个增强项：.alive sidecar 记录 parentPid 链，收割校验从「pid 是 pi 子进程」加强为「且父链无存活进程」（detach+setsid 后 OS 父子关系断裂，需 sidecar 记录显式父链）。
- **subagent-continuous-chat-v2.md（V2 SSOT）**：进程长驻、统一投递、identity entry、归属守卫全部保留。本文的 L1/L2 分离是对 V2「deliverMessage 按进程死活分流」既有事实的模型化显式，不是推翻。
