# Context 用量一致性：修复 + 护栏设计（父文档）

> **层性质声明**：本文档是技术方案设计（下一层产物 = 可实现的接口/数据模型 + 具体代码任务），准则 5/6/7 全部 P0 适用。
>
> **文档结构**：本文档为父文档，含全局问题定义、方案裁决与验收；两个子文档各自深入一个护栏的设计：

| 文档 | 内容 |
|---|---|
| 本文 | 根因分析、修复方案（D1-D4）、护栏概览（D5）、不做什么（D6）、验收、实施拆分 |
| [context-consistency-lint-rule.md](./context-consistency-lint-rule.md) | 护栏 G1：taste-lint 反模式规则 `no-instance-level-session-state` 的检测模式与误报面 |
| [context-consistency-equivalence-test.md](./context-consistency-equivalence-test.md) | 护栏 G2：「switch ≡ snapshot」等价性测试的分层设计与断言形态 |

---

## §1 背景目标

**一句话结论**：修复「切换 session 后 Composer 上下文用量显示变横线」的直接缺陷，并建立四层护栏，使同类「session 级状态在切换后丢失/串台」的问题从「用户发现」前移为「CI 红灯 / pre-commit 拦截」。

**SCQA**：

- **S（情境）**：xyz-agent 的每个 session 有一组「session 级标量状态」（context 用量、modelId、thinkingLevel、commands…），由 runtime 从 pi 拉快照持有（ReplicatedState 实例），经 MessageBus 推送给 renderer，各消费组件自行订阅展示。
- **C（冲突）**：用户在对话中切换到别的 session 再切回后，Composer 工具条的上下文占用（如「6.9万 · 6.9%」）经常变回「—」（横线）；偶尔还会显示**另一个 session** 的占用（串台）。历史上同形状的时序 bug 已修复多轮（见 §2.4），但仍在复发。
- **Q（问题）**：为什么反复修复后还会发生？缺陷是单点的还是结构性的？如何一次修掉并防止未来同类问题再现？
- **A（答案）**：根因是三个缺陷叠加（协议把「未知」编码为 0 / renderer 无切回恢复腿 / 组件把 session 级状态存在实例本地 ref）。本设计：① 修复三处（D1-D4）；② 建立四层护栏（D5，lint 规则 + 等价测试 + 约束登记 + dev 漂移检测器）；③ 显式记录更大的结构收敛（L6 状态仓库）暂不做及其重新评估条件（D6）。

### 系统是什么（给未接触过本链路的读者）

被设计的对象是 **session 级状态从 pi 进程到用户眼前的复制链路**，只涉及 context 用量这一种状态（其他状态仅作背景）：

1. **pi 进程**（每 session 一个）：真正的权威源。`get_session_stats()` RPC 返回 `contextUsage = { tokens, contextWindow, percent }`。tokens 可为 null——**新 session 未跑过 turn、或 compact 后无新 turn 时，pi 自己也不知道用量**（合法「无值」态）。
2. **runtime 的 ReplicatedState 实例**（`packages/runtime/src/services/session/replicated-state.ts`）：per-session 的快照缓存，事件（turn_end/agent_end/compaction）只做失效，防抖后重新拉取。实例随 session 创建而注册播种、随 session 销毁（含 pi 进程退出）而销毁。
3. **MessageBus**（`packages/runtime/src/services/message-bus/message-bus.ts`）：runtime 内的发布订阅中枢。state 类消息写入 per-session 的 `stateSnapshot`（last-value 语义），renderer 首次 `session.subscribe` 时随 reply 回放一次。
4. **renderer 订阅链**：`ensureStreamSubscription`（幂等：每 session 只 subscribe 一次）→ stateSnapshot 回放 → `events.on(sid)` 通道分发到组件。
5. **消费组件** `ContextCapacityPopover`（`packages/renderer/src/components/panel/ContextCapacityPopover.vue`）：Composer 工具条上的容量按钮，hover 出完整容量浮层。

### 设计目标（从使用者体验倒推）

| # | 目标 | 使用者体验表述 |
|---|---|---|
| G1 | 切走再切回，用量显示保持 | 用户在 session A 看到「69K · 6.9%」，切到 B 再切回 A，仍显示「69K · 6.9%」（或更新的真值），不退化成「—」 |
| G2 | 无值是合法且诚实的显示 | 新建 session / 刚 compact 完，显示「—」是**正确**行为；此时切走再切回，仍是「—」（不闪真值也不报错） |
| G3 | 不串台 | 切到 B 期间无论 B 发生什么，A 的显示数据不被 B 的帧污染 |
| G4 | 回归防护 | 未来任何改动让「切回后显示 ≠ owner 快照」时，CI（等价测试）或 pre-commit（lint）在合入前拦截；已合入的漂移在 dev 模式控制台立刻冒头 |

### In / Out of Scope

**In**：

- 修复 context 用量丢失/串台（D1 协议收敛、D2 renderer 分区、D3 恢复腿、D4 防御哨兵）
- 护栏：G1 lint 规则、G2 等价测试、G3 约束登记与 checklist 扩边界、G4 dev 漂移检测器

**Out**：

- **L6 结构收敛（per-session 标量状态仓库）**：把所有 session 级标量状态收进统一状态仓库 + live/回放共喂 reducer 的结构性改造。显式不做，理由与重新评估条件见 D6。
- 其他状态类型（modelId/thinkingLevel/commands…）自身的既有 bug 修复（它们若无此问题则不动；护栏覆盖它们未来的新增消费方）。
- MessageBus 传输层自身的 seq/gap 机制（已有三轮修复与测试，不在本次范围）。

---

## §2 现状与问题分析

### 2.1 使用者视角的现状（真实场景）

**场景 1（丢失 → 横线）**：用户在 session A 对话中，Composer 工具条显示 `69K · 6.9%`。点侧栏切到 session B（B 是刚新建的，还没跑过 turn），再切回 A。工具条显示 `—`。没有任何报错；用户在 A 里再发一条消息、等 turn 跑完，数字才回来。

**场景 2（串台）**：切到 session B（B 已有对话，占用 12 万 tokens）再切回 A，工具条短暂或持续显示 B 的 `120K · 40%`。

**场景 3（合法无值被误读为故障）**：新建 session 从未跑 turn，显示 `—` 是正确的——但当前实现里，「合法无值」和「状态丢失」显示成同一个 `—`，用户（和开发者）无法区分。

### 2.2 真实失败模式与根因

横线 = `ContextCapacityPopover` 内部 `stats.used === 0`（`hasUsage` computed 为 false）。以下三层缺陷叠加，任何单层修补都不完备（论证见 §3.2 方案对比）：

**层 1 — runtime 发出「0 基线」帧，把「未知」编码成合法值 0**

`session-service.ts` 的 `buildStateChangedPayload`（约 L2275-2290，HEAD 798967133）：

```ts
usagePercent: usage?.usagePercent ?? 0,   // usage 快照缺失 → 0
inputTokens:  usage?.inputTokens  ?? 0,
contextLimit: usage?.contextLimit ?? 0,
```

`session.state_changed` 是 modelId/thinkingLevel/usage 三实例的组合投影帧。usage 快照未就绪时（播种竞速、pi 重启后重建、fetch 失败退避窗口），**帧照发**，usage 三字段全 0。而组件对 `context.update` 与 `session.state_changed` 用**同一个 handler** 消费，0 值帧直接覆盖 stats。

关键对比：`publishContextFromSnapshot`（`session-service.ts` 约 L1834-1850）对 `context.update` 帧的语义是「**无值不发**」（usage 三字段任一 undefined 即 return，对齐 pi tokens=null 语义）。**同一个数据，两条帧，两种空值语义**——这是 ADR-0062「空值语义登记」治理在**发布层**的结构缺口（登记表只覆盖了 fetch/merge 层）。

同样问题存在于 `session.getContext` RPC 的 reply（`session-message-handler.ts` L416-421）：`fetchContext()` 返回 null 时 reply `{ inputTokens: 0, contextLimit: 0, usagePercent: 0 }`——把「无值」降级成 0 发给前端。

usage 快照缺失的高频场景：新建 session（pi tokens=null → 空快照）、pi 进程退出后 restore 重建（`removeSessionEntry` 销毁全部实例 + bus `clearSession`，重播种竞速窗口）、usage fetch 失败退避（1s/5s/15s）窗口、thinkingLevel 的 30s 周期兜底重拉反复触发发布挂钩。

**层 2 — renderer 无切回恢复腿**

历史上有兜底：`selectSession` 主动调 `session.getContext` RPC（W2，commit 39a0b97df）。`wave:remove-bandaids` 删除了它，押注 stateSnapshot 回放。但 `subscribeSession` 的幂等守卫（`subscribed` 标记）使 **stateSnapshot 每 session 只回放一次**——LRU 窗口内切回的 session 什么都不发。这恰好违反 AGENTS.md 登记的历史约定「renderer 切换 session 后需立即消费的 session 级状态必须主动拉取，不可依赖 broadcast」——删兜底时未对「切回场景」做等价性验证。

**层 3 — 组件把 session 级状态存在实例本地 ref（ADR-0049 盲区）**

`stats` 是组件实例级 `ref`，切 session 只重订订阅（`useSessionEvents` 的 watch 重订），**不重置、不分区**。切到 B 期间 B 的帧合法覆盖 stats；切回 A 后残留 B 的值（串台）。ADR-0049 的 reviewer checklist 只覆盖「composable」，组件内 ref 是覆盖盲区。

### 2.3 物理数据流图（修复前）

```
pi 进程 (get_session_stats)
  │ tokens 可为 null（新 session / compact 后无新 turn = 合法无值）
  ▼
runtime ReplicatedState「usage」实例（per-session，事件只做失效+防抖重拉）
  │ 快照缺失场景：播种竞速 / pi 重启重建 / fetch 失败退避 / 30s poll 触发
  ├─► publishContextFromSnapshot ──► context.update 帧 ──► 「无值不发」✔ 语义正确
  └─► publishStateChangedFromSnapshot ──► session.state_changed 帧
        │ usage 缺失 → ?? 0 基线 ✘ 「未知」被编码为 0
        ▼
      MessageBus（stateSnapshot last-value，随 subscribe reply 回放一次）
        ▼
      WS → renderer events.on(sid) 通道
        ▼
      ContextCapacityPopover：实例级 stats ref（无分区 ✘）
        ├─ 0 值 state_changed 帧到达 → stats 被清零 → 「—」
        ├─ 切走（订阅 B，stats 被 B 帧覆盖）→ 切回（无任何重喂）→ 串台或「—」
        └─ session.getContext 主动拉取腿已被 remove-bandaids 删除 → 无自愈路径
```

三个 ✘ 标记即三层根因的位置。注意 usage 数据在两条帧（context.update / state_changed）里**冗余存在**——两帧同数据是「第二个写入者」问题在传输层的变体。

### 2.4 时序问题史：为什么修了很多轮还在发生

| 时间 | 修复 | 修在哪层 |
|---|---|---|
| 早期 | 「Runtime broadcast 时序竞争 [HISTORICAL]」→ 定约「切 session 必须主动拉取」 | 约定层 |
| 2026-07-15 | W2（39a0b97df）：selectSession 补 subagent/workflow 主动拉取兜底 | renderer 拉取腿 |
| 2026-08 中 | wave:remove-bandaids：删除上述拉取腿，改押 stateSnapshot 回放 | renderer 拉取腿（反向） |
| 2026-08-19 | ADR-0062：runtime owner 化 + 事件只做失效 + 空值语义登记 | runtime 数据层 |
| 2026-08 下 | messagebus 三轮竞态修复（seq 去重 / gap 检测 / in-flight 去重 / 重连基线） | 传输层 |

模式：**拉取腿被加了又删**（腿的形式在演进，「每个格子人工对齐」的结构未变）；**ADR-0062 的治理只覆盖 runtime owner 层**，renderer 消费层无对应机制。本设计的护栏（D5）针对此结构性缺口。

### 2.5 术语定义

| 术语 | 定义 | 锚定例子 |
|---|---|---|
| **无值（no-value）** | pi 权威源也不知道用量的合法状态（tokens=null） | 新建 session 未跑 turn；compact 后无新 turn。UI 应显示 `—` |
| **0 基线帧** | runtime 在快照缺失时把 usage 三字段填 0 发出的帧 | `session.state_changed` 的 `?? 0`。物理上不可能是真值（任何模型 contextWindow > 0） |
| **分区** | per-session 的状态存储单元（Map<sid, state>），切 session 不串扰 | `useSessionScopedState` 工厂产物 |
| **恢复腿** | 切回 session 后重新获得当前值的路径（拉取 RPC 或快照回放） | `session.getContext` RPC |
| **stateSnapshot** | MessageBus 的 state topic last-value 数组，仅随首次 `session.subscribe` reply 回放一次 | `subscription-state.ts` 的 `subscribeSession` |

---

## §3 解决方案

### 3.1 终态（使用者视角）

**场景 1 修复后**：A 显示 `69K · 6.9%` → 切到 B → 切回 A → 仍显示 `69K · 6.9%`。若 A 在切走期间跑了新 turn，显示新值。全程无横线闪现。（示例值按 UI 实际格式化形态 K 制；原设计稿「万」制示例系虚构形态，实施时 journey 断言按实际输出锚定）

**场景 2 修复后**：切到 B 再切回 A，A 显示的始终是 A 的数据。B 的任何帧（含 0 基线残帧）写不进 A 的分区。

**场景 3 修复后**：新建 session 显示 `—`（合法无值，分区 status='no-value'，不反复重拉）；跑一个 turn 后显示真值。

**开发者视角的终态**（护栏生效样例）：

- 有人新写一个组件，在 `onMessage` handler 里直接写组件本地 ref → **pre-commit lint 红灯**，报错信息指向本文档与迁移范式（composable 化分区）
- 任何改动导致「切回后显示 ≠ owner 快照」→ **等价测试红灯**（属性测试随机交错序列 / journey 断言）
- dev 模式下漂移发生 → 控制台 `[context-usage] drift detected` warn，带两个值与 sessionId

### 3.2 方案对比

| 方案 | 内容 | 长期架构 | 短期成本 | 风险 | 裁决 |
|---|---|---|---|---|---|
| **A：三处单点止血** | renderer 加 0 帧哨兵 + selectSession 加回 getContext 拉取 + 组件 watch(sid) 重置 stats | 差：三处修补互相独立，「加腿/删腿」人工矩阵模式延续；stats 仍是实例级，串台只在部分路径被堵 | 最低（~3 处小改） | 高：下一个状态类型/消费方/切换路径（fork/handoff/backflow）出现时同样问题再现 | ❌ |
| **B：协议 optional + 分区 + 恢复腿** | state_changed 的 usage 三字段改 optional（无值省略 key）；stats 迁分区 composable；切回拉取腿 | 中：消除 0 基线，但 usage 仍在两条帧冗余存在，「有时有有时无」的字段形态是协议债；未来消费方可从两帧读到不一致窗口的数据 | 中 | 中：optional 字段的消费方容易漏判 undefined；两帧冗余继续累积 | ❌ |
| **C：协议收敛单帧贯穿 + 分区 + 恢复腿 + 护栏** | **state_changed 删除 usage 三字段**（usage 只经 context.update 一条帧贯穿：广播 / stateSnapshot / getContext reply 同型）；stats 迁分区 composable；切回拉取腿；四层护栏 | 好：单帧单数据（传输层的「单一 owner」）；TS 删字段强制编译期迁移所有消费方；空值语义统一为「字段缺失 = 无值」 | 中（协议改动牵动 runtime 测试适配，量级可控，消费方仅 2 处见下） | 低：消费方影响面已核实（§3.3 D1） | ✅ |

**若用方案 A，§3.1 场景会怎样**：场景 1 大部分好转，但 B 活跃且有真值时切回 A 仍显示 B 的数（stats 未分区）；下一个新增状态类型（如未来的 quota 常驻态）需要再人工记一次「加哨兵加拉取加重置」三件套。

**若用方案 B，§3.1 场景会怎样**：三个场景都修复，但未来某个消费方直接订 state_changed 读 usage 时，会拿到「有时缺失」的字段，且与 context.update 存在双帧读到不同值的不一致窗口——协议债转嫁给每个未来消费方。

### 3.3 关键决策与权衡

#### D1：协议收敛——usage 从 `session.state_changed` 删除，`context.update` 空值语义统一为「字段缺失」（选定）

- **采用**：
  1. `packages/shared/src/protocol.ts`：`'session.state_changed'` payload 删除 `usagePercent/inputTokens/contextLimit` 三字段（保留 sessionId/modelId/thinkingLevel）；`'context.update'` payload 的 usage 三字段改 optional（`?:`），「字段缺失 = 无值」。
  2. runtime `buildStateChangedPayload`：删除 usage 投影与 `?? 0`；`SessionStateChangedBaseline`/`stateChangedPayloadEquals` 同步缩为 modelId/thinkingLevel 两字段 diff。
  3. runtime `session.getContext` reply（`session-message-handler.ts` L416-421）：`fetchContext()` 返回 null 时 reply `{ sessionId }`（删除 0 fallback）。
  4. `publishContextFromSnapshot` 补「无值占位帧」：**仅在 fetch 成功且投影为空快照 `{}`**（pi tokens=null 的合法无值）时，发布一条仅含 sessionId 的 context.update 帧（typeKey='context' 的 last-value 显式登记「无值」态），使切回的 stateSnapshot 回放能区分「该 session 无值」与「从未收到帧」。**「从未 fetch 成功」（`.get()` 为 undefined，退避重试窗口）不发占位帧**——此刻值可能马上就来，发占位帧会让消费方误写 no-value。此帧 renderer 侧写入分区 no-value。
  5. 登记 `docs/architecture/data-source-registry.md`：组合投影/发布层与 fetch/merge 层 obey 相同空值语义（「字段缺失 = 无值」，禁止 ?? 0 编码），#3 行同步改写。
  6. 连带清理（D1 完整性边界，均为「来源已删但形态残留」的协议债）：① renderer mock 层 `api/mock/index.ts` 的 getContext 返回类型同步新形状（实施核实：mock 层无 state_changed 产生点，无需同步）；② `SessionViewSnapshot`（protocol.ts）的 `usagePercent/inputTokens/contextLimit` 三字段删除——session store 注释明证其不落盘、全库无生产写方（仅 mock），留着即本设计批判的「类型存在、来源已删」形态；③ protocol.ts 的 state_changed 注释（「前端据 usage 三字段刷新 ContextCapacityPopover」已过时）与 useChat state_changed handler 的「含按新 contextWindow 重算的用量」注释同步改。③ 的同类清偿实施时另覆盖 `model-service.ts` switchModel docstring、`session-service.ts` fetchAndBroadcastContext docstring、`session-lifecycle.ts` restore 兜底注释、core session store applySnapshot docstring 四处（均残留「state_changed 含 usage / selectSession 主动拉 getContext」旧表述）。
- **被否**：
  - 「保留双帧 + optional」（方案 B）：冗余腿保留，optional 字段形态是协议债。
  - 「renderer 忽略全 0 帧就够了」（方案 A 的层 1 止血）：0 帧在物理上恒为假值，正确语义是源头不发，不是消费方猜。
- **证据**（消费方影响面，HEAD 798967133 已核实）：
  - `session.state_changed` 的 usage 字段消费方全代码库仅 `ContextCapacityPopover.vue`（本次重构对象）；
  - `packages/core/src/domain/chat/useChat.ts` L269 的 handler 只读 modelId/thinkingLevel，已有 `!== undefined` 展开守卫，零影响；
  - 测试适配面（实施后核实）：`w10-usage-switchmodel-race.test.ts`（改断言 context.update 帧）、`w12-owner-snapshot-publish.test.ts`（无值态改占位帧断言）、`broadcast-getstate.test.ts`、runtime `test/session-service.test.ts`（switchModel 用例 usage 断言迁移）；`session-trace.test.ts` / `message-bus.test.ts` 经核实无 usage 字段引用，零改动（原设计稿预估失准）。
- **效果**：G2（无值诚实显示）、G3（单帧单数据消除双帧不一致窗口）成立；「未知≠0」成为类型层不变量。

#### D2：renderer 分区——新建 `useContextUsage` composable，组件纯读（选定）

- **采用**：新建 `packages/renderer/src/composables/features/model/useContextUsage.ts`（与 `useQuotaDisplay` 同域）。内部三件事：
  1. `useSessionScopedState(sessionIdRef, init)` 建 per-session 分区，分区形态：

     ```ts
     interface UsagePartition {
       status: 'unknown' | 'no-value' | 'ok'
       used: number; total: number; percent: number
     }
     ```

     `unknown` = 从未收到帧也未拉过（拉取 in-flight 中的过渡态）；`no-value` = 权威源明确说无值（占位帧或 RPC resolve 无值）；`ok` = 有真值。**分区缓存的角色 = RPC 往返期间的显示初值 + RPC 失败时的兜底显示**（防闪横线），不是「切回不拉」的依据（理由见 D3 后台 turn 论证）。
  2. `useSessionEvents(sessionIdRef)` 订阅 `context.update`（不再订 state_changed），handler 用**第二参数 sid**（订阅时捕获的消息所属 session）调 `updateFor(sid, ...)` 写消息所属分区——ADR-0049 范式，结构性消除切 sid 竞态。
  3. `registerSessionCleanup((sid) => scoped.cleanup(sid))` 挂进 `useSidebar.deleteSession` 的清理编排（registry 已存在，`use-session-scoped-state.ts` L56）。
- **被否**：组件内直接 `useSessionScopedState`（不经 composable 封装）——订阅编排、恢复腿、清理编排散在组件里，其他 usage 消费方（未来 statusbar 等）无法复用；且订阅 handler 必须在组件 setup 同步注册（useSessionEvents 的 getCurrentInstance 守卫），封装成 composable 后组件只需一行调用。
- **证据**：`useSessionScopedState` API（`packages/core/src/foundation/use-session-scoped-state.ts` L103-210：current/updateFor/cleanup）；ADR-0049 checklist 原文「持有 per-session 状态的 composable 必须用 useSessionScopedState 工厂」。
- **效果**：G3（串台结构性消除——B 的帧物理上写不进 A 分区）成立；`ContextCapacityPopover` 删除内部 stats ref 与 onMessage 注册，改为 `const { current } = useContextUsage(...)` 纯读。

#### D3：切回恢复腿——composable 自治拉取，切回无条件拉（非 selectSession 编排点）（选定）

- **采用**：composable 内 `watch(sessionIdRef, { immediate: true })`：**每次进入该 sid 视图都调一次** `session.getContext(sid)`：reply 有 usage 字段 → 写 ok；无字段 → 写 no-value。RPC 往返期间 UI 先显示分区缓存值（无缓存显 `—`）；RPC 失败保留缓存值不降级。live `context.update` 帧到达时直接覆盖分区（帧即真相）；RPC resolve 写入前若发起后已有更新的合法帧落地则跳过写入（seqAtIssue recency 判定，防陈旧采样回滚新帧）。**in-flight 去重机制**：模块级 Map，条目 = Promise 本体 + 发起时该 sid 的 live 帧序号 seqAtIssue（多实例 await 同一 Promise 后各写各分区——per-instance 的 useSessionScopedState 契约下若存回调则第二实例分区永不更新；seqAtIssue 必须随条目而非 attach 时捕获，否则复用条目的第二实例会以陈旧 recency 基准误跳合法写入）；resolve 即清条目（下次切入重拉），组件 remount 触发的重复拉取接受（幂等查询）。模块级簿记 Map 按 W24-EX-C 机制在 data-source-registry #3 例外列登记（非 GUI 数据技术结构）。
- **为什么 no-value 也要重拉（不能做「无值缓存住不拉」的优化）**：切走期间该 session 的后台 turn 可能完成——bus 级订阅虽在（`ensureStreamSubscription` 幂等保留，useChat 的 handler 照常写 chat store），但 `useContextUsage` 的**组件级订阅**（useSessionEvents）已随视图切换退订，后台 turn 的 context.update 帧进不了组件分区；切回时若 no-value 不拉，分区永远停在陈旧的 no-value → 显示 `—` 而实际已有值。恢复腿无条件拉是把「切回一致性」建立在 RPC（必然可达）而非「切走期间没错过帧」（不可保证）上——这正是「必须主动拉取，不可依赖 broadcast」约定在本状态的落实。
- **成本论证**：getContext 是毫秒级廉价 RPC（pi get_session_stats）；触发频率 = 用户切换 session 的频率（人工操作级），无风暴风险。
- **被否**：
  - 「恢复腿放 selectSession 编排点」（像 fileTree 的 `void useFileTree().loadTree(id)`）：延续「每加一个状态类型就往编排点加一行」的人工矩阵模式——这正是护栏要消除的结构；且 selectSession 不覆盖全部切换路径（panel split、fork 后切视图）。
  - 「subscribeSession 幂等守卫放开，切回重新拉 stateSnapshot」：动传输层核心机制，影响面大（gap 检测/seq 基线全部要重审），且 stateSnapshot 是 last-value 语义，放开重订的收益/风险比不划算。
- **证据**：`session.getContext` handler 现存（`session-message-handler.ts` L417）；`fetchContext` 返回 null 语义 = pi tokens=null（`session-internal.ts` L81 注释「restoreSession 兜底用」）；拉取是毫秒级廉价 RPC（get_session_stats）。
- **效果**：G1（切回保持）成立——显示初值来自分区缓存（无闪横线），真值由 RPC/落地的 live 帧收敛；后台 turn 场景（切走期间 A 产生新值）切回后也能拿到新值。

#### D4：renderer 0 帧防御哨兵（defense-in-depth，选定）

- **采用**：D2 的 handler 内一行判断：收到 usage 三字段全 0 的帧 → 忽略 + `console.warn('[context-usage] dropping impossible all-zero frame', sid)`（dev 冒泡，生产静默忽略）。依据：物理不变量——任何模型 contextWindow > 0，全 0 帧必为假值。
- **被否**：不做（信任 D1 已堵死源头）——协议演进期或未来 regression 时，这一行是用户看不到横线的最后防线；成本一行，保留。
- **证据**：contextWindow 下界（各模型 context window 恒 ≥ 数千 tokens）。
- **效果**：即使 D1 的 runtime 不变量被未来改动破坏，G1/G2 仍成立（防御纵深，非依赖项）。

#### D5：四层护栏（选定，概览；细节见子文档）

| 护栏 | 挡什么 | 形态 | 细节 |
|---|---|---|---|
| G1 lint 规则 | 新消费方再写「onMessage 直写组件本地 ref」反模式 | taste-lint 新规则 `no-instance-level-session-state`，error 级，pre-commit 拦截 | [子文档 1](./context-consistency-lint-rule.md) |
| G2 等价测试 | 任何写法导致「切回显示 ≠ owner 快照」 | renderer 包属性测试（随机交错序列，与 useContextUsage 同包）+ journey 断言 + runtime w10 等价测试族扩展 | [子文档 2](./context-consistency-equivalence-test.md) |
| G3 约束登记 | CR 时无人提醒检查 session 级状态三问 | constraints.json 新增约束（enforcement=review+machine）+ ADR-0049 checklist 边界从「composable」扩到「持 sessionId prop 的组件」 | 本节 |
| G4 dev 漂移检测器 | 已合入的漂移静默到用户眼前 | `XYZ_AGENT_DEBUG=1` 时恢复腿 resolve 后对账（复用 in-flight Promise，不额外发 RPC）：分区值 ≠ reply 值则 console.warn 带两值与 sid（精确口径见下） | 本节 |

G3 约束登记内容（「session 级 renderer 状态三问」，新增 `ServerMessageType` 的 renderer 消费方 / 新增 `useSessionEvents` 调用点时 CR 必查）：**存哪里（分区 store/composable）？切走谁清（cleanup 编排）？切回谁喂（恢复腿）？** 三问都有明确归属才放行。

G4 检测器精确口径（实施后修订——原文「分区值 ≠ reply 则 warn」会误报，按序四判）：①发起后该分区已有更新的合法 live 帧落地（seqAtIssue recency 判定，帧即真相）→ 跳过对账**并跳过写入**（陈旧 reply 不得回滚新帧）；②分区 status = unknown（首拉未完成）→ 跳过对账；③仅对当前视图 sid 对账（非视图分区无 UI 意义且无读取 API）；④其余情形分区值 ≠ reply 值则 warn（带两值与 sid），warn 后照常写 reply 自愈。已知理论窗口（自愈、接受不修）：发起后落地 no-value 占位帧而 resolve 携带更新真值 → 真值被跳过写入，分区停 no-value 至下次切入（「—」是诚实态）；split panel 双实例时第二实例 attach 复用条目以其自身帧序号为 recency 基准，特定时序下判定可能相反于第一实例（短暂陈旧显示，下次切入自愈）。

- **被否**（护栏整体）：「只靠 CR review 不加机器护栏」——constraints.json 现有 69 条约束中 45 条 enforcement 仅有 review、无机器兜底，纯 review 覆盖率有限（本 bug 恰是 review 盲区产物）；「只加 lint 不加等价测试」——lint 只挡已知反模式，挡不住未知写法。
- **效果**：G4 成立；「矩阵格子缺腿」从用户发现前移为 CI/pre-commit/控制台三级拦截。

#### D6：L6 结构收敛（per-session 标量状态仓库）显式不做（选定）

- **采用**：不做统一状态仓库（所有标量状态 Map 分区 + live/回放共喂 reducer + 组件全纯读的结构收敛）。
- **被否原因**：当前仅 context usage 一个状态有实证缺陷，其余标量状态消费方现状工作正常；统一仓库是一次大迁移（~5 状态类型 × 各消费方），在单一实证缺陷下启动收益/风险比不足，且应等本次 D2 试点验证范式后再评估。
- **重新评估触发条件**（满足其一）：① L1 lint 规则上线后存量命中 ≥ 3 处（说明反模式已成面）；② 6 个月内再出现任何非 context 状态的同形状丢失/串台 bug；③ 新增标量状态类型时主动按 D2 范式建 composable 的成本显式变高（团队抱怨/CR 反复）。
- **效果**：scope 控制在本缺陷 + 护栏；D2 的 `useContextUsage` 是未来仓库的第一个试点样本。

---

## §4 验收

> 实施完成后按以下真实场景验证（真实依赖：真实 runtime + pi 进程，非 mock；mock 模式不覆盖订阅/bus 链路）。每个场景标注回溯的 §1 目标。

### A1：切走再切回，显示保持（回溯 G1）

1. `pnpm dev` 启动真实应用；在 session A 发一条消息，等 turn 完成，确认工具条显示真值（如 `21K · 3.5%`）。
2. 切到另一个 session B（任意已有历史的会话；「新建但不发言」构不成 session 实体，见 A2 注），再切回 A。
3. **通过标准**：工具条立即显示 `21K · 3.5%`（或 A 若有后台更新则新值），全程无 `—` 闪现；等待 2s 后仍是真值。

### A2：合法无值诚实显示（回溯 G2，负面-合法态）

> 构造方式注意：「新建 session 不发言」构不成有效场景——NewTaskFlow 是延迟 create（首发消息才建 session 实体，`useSidebarNew.ts` newSession 的 `if (!created)` 分支），无实体则无 sessionId、无 RPC 可验。合法 no-value 的稳定构造路径是 **compact 后无新 turn**（pi `contextUsage.tokens = null` → fetchContext 返回 null）。

1. 选一个有历史的 session C，执行手动 compact（等压缩完成），不发言，进入 C 视图。
2. **通过标准**：工具条显示 `—`（非「闪旧值后归零」）；devtools Network → WS → Messages 按 `session.getContext` 过滤计数（getContext 是 WS 命令帧，不在 HTTP 列表——原稿「Network 面板」措辞会找错地方），切到 C 时恰好一次（in-flight 去重生效，G4 检测器复用同一次 RPC 不额外发），reply payload 无 usage 字段（仅 sessionId）。
3. 在 C 发一条消息完成 turn → 显示真值；再切走切回 → 保持真值。

### A3：不串台（回溯 G3）

1. session A（真值 2 万）与 session B（真值 12 万）交替切换 3 轮。
2. **通过标准**：每次显示的都是当前 session 自己的值；WS Messages 按 `session.getContext` 过滤（同 A2）无对同 sid 的重复 getContext 风暴（in-flight 去重生效）。

### A4：0 帧防御哨兵（回溯 G1/G2 的防御纵深）

1. 实施期门：dev 模式下人为构造（临时在 runtime publish 处注入一条全 0 context.update 帧的调试代码，验证后删除）。
2. **通过标准**：控制台出现 `[context-usage] dropping impossible all-zero frame` warn，工具条不被清成 `—`。

### A5：护栏生效（回溯 G4）

1. **lint**：在一个测试组件里写 `const stats = ref(...)` + `onMessage('context.update', (m) => { stats.value = ... })` → `pnpm run lint` 红灯，报错信息含迁移指引；pre-commit 同样拦截。
2. **等价测试**：人为把 handler 的 `updateFor(sid, ...)` 改成 `update(...)`（引入切 sid 竞态）→ 等价测试红灯（此为红蓝验证：护栏先红后蓝，实施期门）。
3. **dev 检测器**：临时让分区跳过一次 context.update 写入 → dev 控制台出现 drift warn 带两值。
4. **通过标准**：三项护栏在注入缺陷时全部红灯/冒泡，修复后全绿。

### A6：正常链路回归（回溯 G1-G3 不破坏既有行为）

1. 真实对话中连续 3 个 turn：工具条用量随 turn 完成实时增长。
2. 手动 compact 一个 session → 工具条按 pi 新口径更新或诚实显示 `—`（compact 后无新 turn），不报错不卡死。
3. 切模型（触发 switchModel → state_changed 无 usage 版本）→ 模型名正常切换，用量显示不被清零。
4. **通过标准**：以上全部符合现状正确行为；`pnpm extensions:typecheck && pnpm run lint` 与受影响包 `pnpm test` 全绿。

---

## §5 下一层拆分

### 实施路径（三阶段，各自可独立验证/回滚）

**Phase 1 — 协议与 runtime（D1）**：先立不变量，消费方尚在旧形态也能兼容（旧 handler 读不到 usage 字段只是暂时不更新，不崩溃——全 0 帧消失后旧 stats 只是「不被错误清零」）。

| 单元 | 改动 | justification |
|---|---|---|
| 1.1 shared 协议 | `protocol.ts`：state_changed 删 usage 三字段；context.update 三字段 optional | 类型先行，编译器驱动后续迁移（准则：接口先行） |
| 1.2 runtime 投影 | `session-service.ts`：buildStateChangedPayload 删 usage；Baseline/diff 缩两字段；publishContextFromSnapshot 补「无值占位帧」 | D1 主体 |
| 1.3 runtime RPC | `session-message-handler.ts` L417-421：getContext reply 删 0 fallback | D1 主体 |
| 1.4 runtime 测试适配 | w10 / w12 / broadcast-getstate / session-service 等测试改断言（session-trace / message-bus 经核实零改动）；W1-W4 不变量断言落新文件 `d1-usage-protocol-invariants.test.ts`（见子文档 2 层 2） | 先修测试护栏再动 renderer |

**Phase 2 — renderer 修复（D2/D3/D4）**：

| 单元 | 改动 | justification |
|---|---|---|
| 2.1 新建 composable | `composables/features/model/useContextUsage.ts`：分区 + 订阅 + 恢复腿 + in-flight 去重 + cleanup 注册 + 0 帧哨兵 | D2/D3/D4 主体，单文件可独立单测 |
| 2.2 组件改造 | `ContextCapacityPopover.vue`：删内部 stats/onMessage，改 `useContextUsage` 纯读 | 消费面唯一，改造封闭 |
| 2.3 单测 | composable 分区写入/切 sid/无值/去重/哨兵行为单测（vitest；实施核实：实现内无 timer——去重靠 Promise 原语，in-flight 窗口以受控 deferred + macrotask 排空覆盖，fake timers 无对象可 fake） | 分层测试策略（纯逻辑先行） |

**Phase 3 — 护栏（D5）**：

| 单元 | 改动 | justification |
|---|---|---|
| 3.1 lint 规则 | taste-lint `no-instance-level-session-state` + 规则单测 + base.mjs 注册（error 级）；存量豁免登记 | 子文档 1 |
| 3.2 等价测试 | w10 族适配 + `d1-usage-protocol-invariants.test.ts`（W1-W4）+ renderer 层 1 属性测试 + journey 断言（J1/J2 新文件，fast-fork harness 不支持 selectSession 流程故未并入） | 子文档 2 |
| 3.3 约束登记 | constraints.json 新增「session 级 renderer 状态三问」约束（machine=3.1 规则，review=pr-cr-fix data-governance 维度）+ `node scripts/render-constraints.mjs` 重生成 md；ADR-0049 checklist 扩边界段落 | G3 |
| 3.4 dev 检测器 | `XYZ_AGENT_DEBUG=1` 时 selectSession 后异步对账 warn（挂在 useContextUsage 内，不新建文件） | G4 |

### 文件改动地图（实施后修订 2026-08-24，原设计稿预估与实际差异：原列 `services/session/__tests__/*.test.ts` 实际零改动删除；W1-W4 落新文件而非并入 w10；补列实际涟漪文件）

```
packages/shared/src/protocol.ts                                       改（D1 类型）
packages/runtime/src/services/session/session-service.ts              改（D1 投影/发布 + D1.6③ 注释）
packages/runtime/src/services/session/session-lifecycle.ts            改（D1.6③ 注释同步）
packages/runtime/src/services/model-service.ts                        改（D1.6③ 注释同步）
packages/runtime/src/transport/session-message-handler.ts             改（D1 reply）
packages/runtime/test/session-service.test.ts                         改（1.4 适配）
packages/runtime/src/__tests__/equivalence/w10-*.test.ts              改（1.4 适配）
packages/runtime/src/__tests__/equivalence/w12-owner-snapshot-publish.test.ts  改（1.4 适配——无值态改占位帧断言）
packages/runtime/src/__tests__/equivalence/broadcast-getstate.test.ts 改（1.4 适配）
packages/runtime/src/__tests__/equivalence/d1-usage-protocol-invariants.test.ts 新（W1-W4 不变量）
packages/renderer/src/composables/features/model/useContextUsage.ts   新（2.1）
packages/renderer/src/components/panel/ContextCapacityPopover.vue     改（2.2；3.1 落地期曾加 taste:allow 过渡豁免，重构后消失）
packages/renderer/src/__tests__/panel/context-capacity-*.test.ts      改（2.2 适配：popover 断言迁移 + quota 补 session mock）
packages/renderer/src/__tests__/panel/context-usage-journeys.test.ts  新（3.2 journey，J1/J2）
packages/renderer/src/__tests__/composables/use-context-usage.test.ts 新（2.3 定向 + 3.2 层1属性）
packages/renderer/src/__tests__/session-state-changed-sync.test.ts    改（D1.6 fixture 删 usage 字段）
packages/renderer/src/api/domains/session.ts                          改（D1.6 getContext 返回类型 optional）
packages/renderer/src/api/mock/index.ts                               改（D1.6 getContext mock 形状；mock 层无 state_changed 产生点）
packages/core/src/domain/chat/useChat.ts                              改（D1.6③ 注释同步）
packages/core/src/domain/session/store.ts                             改（D1.6③ 注释同步）
taste-lint/rules/no-instance-level-session-state.mjs                  新（3.1）
taste-lint/rules/no-instance-level-session-state.test.mjs             新（3.1）
taste-lint/base.mjs                                                   改（3.1 注册）
docs/constraints.json + docs/constraints.md                           改（3.3）
docs/architecture/data-source-registry.md                             改（D1.5 登记 + W24-EX-C in-flight 簿记例外）
docs/adr/0049-session-isolation-map-partition.md                      改（3.3 扩边界）
```

### A7：后台 turn 场景（回溯 G1 的 D3 论证）

1. session A 发一条长任务消息（如让它读多个文件），turn 进行中切到 B。
2. 等 A 的 turn 在后台完成（侧栏可见完成态）。
3. 切回 A。**通过标准**：工具条显示 turn 完成后的新用量（不是 `—` 也不是切走前的旧值）——无条件恢复腿拿到后台产生的值。

### A8：WS 断连重连 / runtime 重启后切回（回溯 G1 的断连路径，历史故障模式）

1. session A 有真值显示中；dev 模式下杀掉 runtime 子进程（或重启 app）触发重连，等重连完成（侧栏会话列表恢复）。
2. 切到 B 再切回 A。
3. **通过标准**：工具条恢复 A 的正确用量——重连路径的 stateSnapshot 重放（resubscribeAll 会重置守卫重新回放，与常态「只回放一次」不同）与无条件恢复腿 RPC 兕底协同生效，无横线无串台；控制台无未消化的 drift warn。

### 待验证检查点（实施期门，设计阶段无法确定）

1. **无值占位帧的 stateSnapshot 交互**：D1.4 新增的「仅含 sessionId 的 context.update」写入 stateSnapshot typeKey='context' 后，是否与既有 gap/seq 测试假设冲突——Phase 1 跑全量 runtime 测试确认。
2. **多 panel 同 sid 双实例**：split mode 下两个 Composer 同时挂载，in-flight 去重是否覆盖「一实例拉取中另一实例 watch 触发」——Phase 2.3 单测 + A3 场景实测。
3. **lint 规则存量命中数**：规则跑全仓的误报/命中清单——Phase 3.1 落地时统计，若命中 > 预期（>5 处）先逐个人工确认是否为同类 latent bug。
