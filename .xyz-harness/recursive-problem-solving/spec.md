# 递归问题求解（Recursive Problem Solving）— 架构 Spec

> **状态**：方案探讨阶段，未进入实现。本文档沉淀 2026-07-31 共 9 轮讨论的全部结论。
> **分支**：`feat-recursive-problem-solving`
> **性质**：长期方案探讨。所有"改动点"均为待决策的候选，非已批准的实现计划。

---

## 0. 文档导航

- [1. 目标与非目标](#1-目标与非目标)
- [2. 业务用例](#2-业务用例)
- [3. 现状盘点：已有什么、缺什么](#3-现状盘点已有什么缺什么)
- [4. 难点分析（五个）](#4-难点分析五个)
- [5. 解决方案与选型取舍](#5-解决方案与选型取舍)
- [6. 最终整体架构](#6-最终整体架构)
- [7. 执行流程：通用流程图](#7-执行流程通用流程图)
- [8. 执行流程：Demo 示例](#8-执行流程demo-示例)
- [9. 详细改动点列举](#9-详细改动点列举)
- [10. 遗留待决策问题](#10-遗留待决策问题)
- [附录 A. 关键代码证据索引](#附录-a-关键代码证据索引)

---

## 1. 目标与非目标

### 1.1 目标

实现一种 agent 架构：面对过大的问题时，agent 自动拆分为多个子任务，分派给多个子 agent 执行；子 agent 若仍认为问题过大，继续拆分，递归到适合的粒度；各子 agent 解决各自问题后，结果层层聚合回来，最终解决整个问题。

核心诉求：**递归、自动、可聚合**。

### 1.2 非目标

- **不追求无限深度递归**。业界共识（CMU 实证 CMU-CS-25-132 + Claude Code fan-out 事故）是固定有界深度（≤3-5 层）优于动态无限递归。本方案采纳有界模型。
- **不在 xyz-agent runtime 层重造编排引擎**。执行能力（spawn 子进程、隔离、唤醒）由 pi/subagent-workflow 提供，流程骨架由 cw 提供。runtime 仅（可选地）提供 GUI 可见性增强。
- **不把 GUI 可见性作为递归能工作的前提**。递归机制在 CLI 层（pi + cw）即可跑通，runtime 可见性是并行的体验增强（见 §10.1）。

---

## 2. 业务用例

### 用例 1：大型功能开发（递归拆分的主场景）

> 输入："给我的博客系统加完整的评论功能（评论、回复、点赞、@通知、后台审核）"

这是个远超单上下文窗口、且天然可分层的大任务。期望行为：

```
epic（评论系统）
├── feature：评论 CRUD         → slice：后端 API + slice：前端列表
├── feature：回复与嵌套         → slice：数据模型 + slice：递归渲染
├── feature：点赞              → slice：并发计数 + slice：防重
└── feature：通知与审核         → slice：@解析 + slice：审核流 + slice：通知投递
```

每个 wave（叶子）是可独立实现、可独立测试的施工单元。多组 wave 并发执行，结果聚合为完整功能。

### 用例 2：大型重构（保留行为的大范围改写）

> 输入："把 state-management 目录从 Vuex 迁移到 Pinia"

跨多文件、有依赖顺序（先改 store 定义、再改组件引用、再改测试）、需保持行为不变。递归拆分能按模块边界切分，处理依赖。

### 用例 3：调研 + 实现混合任务

> 输入："评估三个状态管理库，选一个，然后用它重写现有状态层"

前半是调研（只读，可并行多路），后半是实现（写入，需串行或按依赖）。递归拆分能区分只读/写入阶段，分别用不同并发策略。

---

## 3. 现状盘点：已有什么、缺什么

xyz-agent 技术栈中已有两套正交系统，经 9 轮讨论确认它们**天然互补**：

### 3.1 pi + subagent-workflow extension（执行引擎层）

**已具备**（代码证据见附录 A）：

| 能力 | 机制 |
|------|------|
| 递归 spawn 子 agent | `subagent-tool.ts` 的 `subagent` 工具；子进程经 `argv-mirror.ts` 透传 `--extension`，加载同一 extension，天然能再调 `subagent` |
| 深度护栏 | `MAX_FORK_DEPTH = 10`（`session-context-resolver.ts:22`），双轨计数（fork 链 + 通用嵌套），第 11 层优雅失败 |
| 自动续跑 | 子完成 → `notifier.ts:195-206` 调 `sendMessage({triggerTurn:true, deliverAs:"steer"})` → pi 核心唤醒父 agent 下一 turn |
| 进程隔离 | 每次 `agent()` 调用 spawn 独立 pi 子进程（`SubprocessAgentRunner`，`execute-agent-call.ts:114`），崩溃不波及 workflow worker |
| 单 call 重试 | `executeAgentCall` 内置 3 次重试 + 指数退避（`execute-agent-call.ts:168-178`），infra 层完成，脚本无感知 |
| worktree 隔离 | `fork + worktree` 模式，每个子 agent 独立 git checkout，避免 `.git/index.lock` 冲突（`worktree-manager.ts`）|
| 分层并发配额递减 | `effectiveMaxConcurrent = max(1, pool.maxConcurrent - depth)`（`subagent-service.ts:651`）|

**pi workflow（orchestration 子能力，关键发现）**：

| 能力 | 机制 |
|------|------|
| 可编程 JS workflow 引擎 | workflow 是 `.js` 脚本，注入 `agent()`/`parallel()`/`pipeline()`/`workflow()`/`phase()`/`log()` 全局函数，**非声明式 DAG，是任意 JS 程序**（`worker-script-builder.ts`）|
| 动态生成 workflow | `workflow-script generate` 工具把 LLM 写的脚本写入 `.pi/workflows/.tmp/`，立即可被 `workflow run` 发现执行（`tool-workflow-script.ts:241`）|
| 嵌套执行 | `workflow(name, args)` 在脚本内调子 workflow，带循环检测（`launcher.ts:264-368`）|
| 结构化聚合（脚本内） | `agent({schema})` 返回 `parsedOutput` 结构化对象（`worker-script-builder.ts:144`），`parallel()` 返回 `{status,result}[]`，不受 8k 截断 |
| budget 共享 + signal 继承 | 嵌套 workflow 复用父 Budget，父 abort → 子 abort（`launcher.ts:316-324`）|

### 3.2 cw (coding-workflow)（流程状态机层）

**已具备**：

| 能力 | 机制 |
|------|------|
| 四层 WorkUnit 模型 | epic/feature/slice/wave，扁平存储 + `parentUnitId` 外键组成树（`workunit.ts`，`schema.ts:62-72`）|
| 状态机 | wave 10 态 + planning 8 态，`guardWave`/`guardPlanning` 防跳步（`state-machine.ts`）|
| 机器检查 gate | test（commit-exists + tests-all-pass）/ closeout（artifacts-drift）/ design-review（DAG 无环 + 结构完整）/ retrospect（all-waves-closed + childDeliveryConsistency）。**不信任 agent 声明，只信机器证据** |
| 结构化聚合（rollup） | 子单元终态时自动回写父单元 `evidence.childDelivery`（`rollup.ts:110-145`），retrospect gate 交叉校验主客观一致性 |
| replan + 级联 abort | `computeImpactCascade` 迭代到不动点算影响面，递归 abort 受影响子孙（`replan.ts:155-217`）|
| 跨层导航 | crossLayer（descend/sibling/ascend），深度优先树遍历（`cross-layer.ts:60-96`）|
| 只读查询 | `cw tree`（递归 findChildren + status）/ `cw handoff`（五段式重入上下文）/ `cw status`（含 status→nextAction 映射，`render.ts:497-521`）|

**两套系统的正交关系**：

| 维度 | pi/subagent-workflow | cw |
|------|---------------------|-----|
| 本质 | 进程管理 + turn 调度 | 状态机编排 + 机器校验 |
| 控制流 | 有状态进程编排（子完成自动唤醒父） | 无状态请求-响应（一次 `cw <action>` = 一次 CLI 调用）|
| 信号通道 | `sendMessage(triggerTurn)` 自动推 | CLI stdout，调用方独占 |
| 是否 spawn agent | 是 | **否**（agent-agnostic，PRODUCT.md 非目标第 1 条）|

### 3.3 缺口总结

经讨论逐项确认，**大部分缺口在"pi workflow 做编排 + cw 做状态"的组合下被消解**，真正剩余的缺口收敛为工程实现项（见 §9），而非架构阻断点。

---

## 4. 难点分析（五个）

以下五个难点是讨论中识别的，按"是否已解"标注最终状态。

### 4.1 难点一：可见性黑盒 → 降级为可选的体验增强

**问题**：pi/subagent 的 session 存在 `~/.xyz-agent/pi/agent/subagents/<cwd>/sessions/`，runtime 的 `scanPiSessions` 只扫主 sessions 目录，对 subagent 树不可见。

**讨论结论**：可见性是 GUI 体验问题，**不是递归能工作的前提**。递归机制在 CLI 层（pi + cw）可独立跑通。是否做 runtime 可见性取决于产品形态（GUI 产品则需做，纯 CLI 则不需要）。

**状态**：✅ 降级为并行可选项，不阻断主架构。

### 4.2 难点二：上下文聚合失真 → 由 cw 结构化聚合 + schema 输出解决

**问题**：纯文本 notify 经多层压缩会"电话传话"失真。

**讨论结论**：
- cw 的 rollup（结构化 childDelivery + retrospect 一致性 gate）比纯文本摘要强——它防"agent 谎报/遗漏"，但不改变"聚合有损"的信息论事实。
- 真正的突破是 `agent({schema})` 返回结构化对象，结果走 cw store（文件）而非对话注入，主 agent 按需调 `cw` 读取——绕开了 8k 截断。
- 业界共识（Anthropic/Cognition）：聚合只能"蒸馏摘要 + 关键产物落地"，不可能无损。接受有损。

**状态**：✅ 已有解（schema + cw store）。

### 4.3 难点三：fan-out 与拆分质量 → 由 cw 四层 + gate 缓解

**问题**：Claude Code 放开递归后出现指数级 agent 树烧 token（issue #68110）。

**讨论结论**：
- cw 的固定 4 层 + design-review gate（DAG 判环 + 拆分 rationale 强制）天然给递归加了"结构性刹车"。
- 拆分质量仍靠 LLM 判断 + AGENTS.md 软约束，cw 无法判断"该拆 3 个还是 10 个"。
- 与业界"有界递归 + 硬深度上限"共识一致。

**状态**：✅ 部分缓解（结构性约束到位，质量靠 prompt）。

### 4.4 难点四：缺失编排层 → 由 pi workflow 承担（关键突破）

**问题**：最初判断需要"独立 broker 层"编排 cw 与 subagent。

**讨论结论**：深入调研 pi workflow 后推翻此判断。pi workflow 是可编程 JS 引擎，能动态生成、嵌套、结构化聚合、自带重试与 budget 共享。**它本身就是比独立 broker 更好的编排层**，无需新建独立组件。

**状态**：✅ 已解（pi workflow 承担编排，无需独立 broker）。

### 4.5 难点五：崩溃恢复与失败处理 → 由进程隔离 + 内置重试 + cw 幂等查询解决

**问题**：单 worker 单 run 的 BFS 自驱模型，崩溃是否全毁？

**讨论结论**（关键发现）：
- **每次 `agent()` 调用都 spawn 独立 pi 子进程**（进程隔离），单个 agent 崩溃只影响那一次 call，不波及 worker。
- **单 call 失败 infra 层自动重试 3 次 + 指数退避**（`execute-agent-call.ts:168-178`），无需脚本层重试。
- **worker 主线程崩溃是罕见场景**，靠 cw store 近似恢复（见 §7.3）。

**状态**：✅ 已解（分级恢复机制）。

---

## 5. 解决方案与选型取舍

### 5.1 关键选型决策（逐条记录取舍理由）

#### 决策 1：编排层用 pi workflow，不新建独立 broker

| 候选 | 结论 | 理由 |
|------|------|------|
| 独立 broker 层 | ❌ 否决 | pi workflow 已具备编排能力（动态生成/嵌套/聚合/重试），新建 broker 是重复造轮子 |
| pi workflow 做编排 | ✅ 采纳 | 可编程 JS 引擎，原生支持 BFS/parallel，自带 budget/重试 |

#### 决策 2：递归驱动方式——"每层每 action 一个 agent"（而非脚本完全自驱）

讨论中涌现的关键设计。agent 不只产出结构化结果让脚本代调 cw，而是**agent 自己执行 action + 自己调 cw**。

| 候选 | 结论 | 理由 |
|------|------|------|
| 脚本完全自驱（脚本代 agent 调 cw） | ❌ 否决 | 打破 gate 闭环：脚本调 cw 时若 gate fail，agent 已退出无法修 |
| **每 action 一个 agent，agent 自己调 cw** | ✅ 采纳 | gate 闭合在 agent 内：agent 调 cw → gate fail → 同一 agent 修 → 重调。这是 cw 设计的原始闭环 |
| LLM 驱动每层宏观决策 | ✅ 采纳 | 顶层拆分、关键 replan 决策由 LLM 做；每 action 执行可 agent 化 |

**gate 闭环的精确含义**（§8.2 详述）：agent 调 `cw test`，cw 跑 gate，fail 返回 mustFix，**agent 还在同一 turn 内**，直接修代码再调 `cw test`。循环到 pass 或熔断。

#### 决策 3：最后一公里文本化——结果走 cw store 文件，不走对话注入

| 候选 | 结论 | 理由 |
|------|------|------|
| 经 pi sendMessage 文本注入主 agent | ❌ 否决 | 8k 截断 + 多层压缩失真 |
| **结构化结果写 cw store，主 agent 按需调 cw 读取** | ✅ 采纳 | 无数据量限制；cw store 是持久化文件 |
| agent 输出 schema 含 cw 命令字符串让脚本执行 | ❌ 否决（安全） | 把 bash 执行权交给 agent 字符串 = 绕过 permission hook/sandbox，注入风险 |

#### 决策 4：递归深度——有界 4 层（cw 固定），不追求开放深度

| 候选 | 结论 | 理由 |
|------|------|------|
| 泛化 cw 为开放深度 WorkUnit | ❌ 否决 | 推翻 cw 核心设计（4 层语义不对称）；CMU 实证 max-depth=3 最优；工程量等于重写 |
| **cw 固定 4 层 + pi 的 fork 深度做 wave 内部技术细分** | ✅ 采纳 | 符合业界"有界递归"共识；cw 管"语义拆分"，pi 管"单层内执行" |

#### 决策 5：worktree 隔离 + cw store 同源 key

| 候选 | 结论 | 理由 |
|------|------|------|
| 非 worktree（同 cwd） | ❌ 否决 | 并发写 `.git/index.lock` 冲突 |
| worktree（隔离 cwd）+ cw store per-cwd | ❌ 否决 | worktree 改 cwd → cw store 断裂，子 agent 看不到父建的工作单元树 |
| **worktree + cw store 改 per-project（同源 key）** | ✅ 采纳 | 隔离写入 + 共享流程状态，两全；需改造 cw 存储模型 |

#### 决策 6：并发策略——BFS 层级并行 + 写入串行（渐进演进）

| 候选 | 结论 | 理由 |
|------|------|------|
| 全串行（接受 cw 现状） | MVP 起点 | 零新增，先让递归跑通；代价是慢 |
| **BFS 层级 parallel + 只读/写入区分** | ✅ 目标形态 | `parallel()` 并发同层无依赖节点；Cognition 收敛方案"只读并行/写入串行"最稳 |
| 完整 DAG 拓扑调度 + patch 合并 | ❌ 暂不做 | 过度工程，等递归验证有效后再考虑 |

### 5.2 被否决方案的教训记录

- **"独立 broker 层"被否决**：源于对 pi workflow 能力调研不足。教训——下结论前必须穷尽已有系统的能力（AGENTS.md 规则 #17 的延伸：跨层排查要穷尽所有层）。
- **"agent schema 输出 cw 命令字符串让脚本执行"被否决**：看似优雅的 intent/execution 分离，实则把 bash 执行权外泄给 agent 字符串，绕过所有安全防线。教训——架构设计必须把安全边界作为第一约束。

---

## 6. 最终整体架构

### 6.1 分层职责

```
┌─────────────────────────────────────────────────────────────┐
│  workflow 脚本层（递归调度器，JS BFS）                          │
│  职责：读 cw frontier → 派 agent → 收 children → 推进层         │
│  形态：单个 .js workflow，单 worker 进程内 BFS 迭代              │
├─────────────────────────────────────────────────────────────┤
│  agent 层（每 action 一个 agent，进程隔离）                     │
│  职责：执行实际 action（拆分/写代码/测试）+ 自己调 cw 推进状态    │
│  gate 闭合在此层：gate fail → agent 修 → 重调 cw               │
├──────────────────────────┬──────────────────────────────────┤
│  cw（流程状态机）          │  pi/subagent-workflow（执行引擎）  │
│  - 四层 WorkUnit 树        │  - spawn 独立 pi 子进程            │
│  - gate 机器校验           │  - 单 call 3 次重试 + 退避         │
│  - rollup 结构化聚合       │  - worktree 隔离                  │
│  - frontier 只读查询       │  - budget/signal 共享              │
│  - handoff 重入上下文      │                                    │
└──────────────────────────┴──────────────────────────────────┘
```

### 6.2 三层间的数据流

```
workflow 脚本（BFS 协调者）
  │
  ├──[读]── cw frontier ──→ 拿到当前所有非终态节点 + 各自 nextAction
  │
  ├──[派]── agent({prompt, schema, cwd: worktree}) ──→ spawn 独立 pi 子进程
  │           │
  │           ├── agent 内部：读 cw handoff 拿重入上下文
  │           ├── agent 内部：执行 action（写代码/拆分）
  │           ├── agent 内部：调 cw <action> 推进状态（gate 在此校验）
  │           │     └── gate fail → agent 修 → 重调 cw（闭环）
  │           └── agent 返回 schema 结构化结果（含 children? / 业务字段）
  │
  ├──[收]── agent 的 schema 结果
  │           ├── 叶子节点：业务字段（commitHash/summary/artifacts）
  │           └── 非叶子：children 数组 → 推入 BFS 下一层队列
  │
  └──[循环] 直到 BFS 队列空 + cw 所有节点终态
```

### 6.3 设计不变式（实现时必须遵守）

1. **gate 闭环在 agent 内**：agent 调 cw，gate fail 由同一 agent 修，不让脚本代调。
2. **agent 字符串不接触 bash 执行权**：cw 命令由 agent 自己用 bash 工具调（有 permission hook 把关），不由脚本执行 agent 提供的命令字符串。
3. **结果走 cw store 不走对话注入**：结构化结果落 cw store，主流程按需 `cw` 读取。
4. **cw store 同源 key（per-project）**：worktree 下共享同一 store，不按 cwd 隔离。
5. **单 call 失败靠 infra 重试**：不在脚本层重做重试逻辑。

---

## 7. 执行流程：通用流程图

### 7.1 workflow 脚本内部的 BFS 执行（核心）

```
recursive-split.js 启动（单 worker 进程）
  │
  ▼
┌───────────────────────────────────────────┐
│ 初始化：cw create epic <task>              │
│ （由主 agent 或脚本调 cw 创建根节点）        │
└──────────────────┬────────────────────────┘
                   ▼
┌───────────────────────────────────────────┐
│ BFS 循环                                    │
│                                             │
│  frontier = cw frontier --root <epicId>     │
│  （幂等只读：所有非终态节点 + nextAction）    │
│                                             │
│  WHILE frontier 非空：                      │
│    ┌─────────────────────────────────────┐ │
│    │ 按层（scope）分组 frontier            │ │
│    │ 对当前层所有节点：                     │ │
│    │   parallel(                            │ │
│    │     frontier.map(node =>              │ │
│    │       agent({                          │ │
│    │         prompt: 执行 node 的 action,  │ │
│    │         schema: 结构化输出,            │ │
│    │         cwd: node 对应 worktree        │ │
│    │       })                               │ │
│    │     )                                  │ │
│    │   )                                    │ │
│    │   ↑ 每个 agent 内部：                   │ │
│    │     1. 读 cw handoff 拿上下文           │ │
│    │     2. 执行 action                     │ │
│    │     3. 调 cw <action>（gate 校验）      │ │
│    │     4. gate fail → 修 → 重调（闭环）    │ │
│    │     5. 返回 schema 结果                │ │
│    └──────────────────┬──────────────────┘ │
│                       ▼                     │
│    收集 parallel 结果                       │
│    对每个结果：                              │
│      ├── 叶子（无 children）→ 结果已在 cw     │
│      └── 非叶子（有 children）→              │
│            cw 已在 agent 调 execute 时       │
│            自动创建子层 unit                 │
│                                             │
│    frontier = cw frontier --root <epicId>   │
│    （重新拉取，含新创建的子层）               │
│  END WHILE                                  │
└──────────────────┬────────────────────────┘
                   ▼
┌───────────────────────────────────────────┐
│ 完成：cw tree 全部 closed                   │
│ 主流程调 cw 读取最终聚合结果                 │
└───────────────────────────────────────────┘
```

**关键点**：
- BFS 不用 `workflow()` 嵌套调自己（避开循环检测 `chain.includes(name)`），而是单 worker 进程内 `while` 迭代。
- `parallel()` 并发同层节点。每个 agent call 是独立 pi 子进程（崩溃隔离 + 3 次重试）。
- `cw frontier` 幂等只读，每轮循环重新拉取真实状态（cw 自动创建子层 unit 是在 agent 调 `cw execute` 时发生的）。

### 7.2 单个 agent 内部的执行（gate 闭环）

```
agent 进程启动（被 workflow 的 parallel() 派发）
  │
  ▼
┌─────────────────────────────────────────────┐
│ 1. 读 cw handoff --unitId <nodeId>           │
│    → 五段式上下文：目标 / 已定决策 /           │
│      当前位置 / 下一步命令 + guidance /        │
│      涉及文件与契约                           │
└──────────────────┬──────────────────────────┘
                   ▼
┌─────────────────────────────────────────────┐
│ 2. 执行 guidance 指示的 action               │
│    （拆分：调 cw plan；                       │
│     写代码：编辑文件；                         │
│     测试：跑 npm test）                       │
└──────────────────┬──────────────────────────┘
                   ▼
┌─────────────────────────────────────────────┐
│ 3. 调 cw <action> --unitId <nodeId>          │
│    → cw 跑 gate                              │
│                                               │
│    IF gate pass:                             │
│      → cw 推进 status                        │
│      → 若是 execute 且有子层，cw 自动建子 unit │
│      → 返回 ok=true                          │
│                                               │
│    IF gate fail:                             │
│      → 返回 ok=false + gateResults + mustFix │
│      → agent 读 mustFix，回到步骤 2 修正      │
│      → 重调步骤 3（gate 重验）                │
│      → 循环到 pass 或熔断（5 次建议 abort）   │
└──────────────────┬──────────────────────────┘
                   ▼
┌─────────────────────────────────────────────┐
│ 4. 返回 schema 结构化结果                     │
│    （叶子：commitHash/summary/artifacts；     │
│     非叶子：children 描述供 BFS 下层消费）     │
└─────────────────────────────────────────────┘
```

### 7.3 崩溃恢复流程

**失败域分级**：

| 失败域 | 触发 | 影响 | 恢复机制 | 状态 |
|--------|------|------|---------|------|
| 单个 agent call | pi 子进程 crash/timeout/OOM | 仅该次 call | infra 层 3 次重试 + 指数退避（自动）| ✅ 已实现 |
| gate fail | agent 声称完成但机器校验不过 | agent 卡在该 action | 同一 agent 修代码重调 cw（闭环）| ✅ 机制已备 |
| workflow worker 主线程 | worker OOM/未捕获异常（罕见）| 整个 BFS run | 重启 worker + cw frontier 重建 | ⚠️ 需新增 cw frontier 命令 |

**worker 崩溃恢复**：

```
worker 重启
  │
  ▼
cw frontier --root <epicId>（幂等只读）
  → 重建所有非终态节点 + 各自 nextAction
  │
  ▼
对每个非终态节点：
  cw handoff --unitId <nodeId>
  → 拿重入上下文（该节点 cw status 告诉 agent "你在哪"）
  │
  ▼
从断点 status 对应的 action 继续 spawn agent
  （不重跑已完成的 action，cw status 是唯一真相）
```

**近似恢复的边界**（cw 固定 4 层让树结构完全可重建，但 BFS frontier 是 worker 运行时态）：
- cw store 有：完整树拓扑 + 每节点精确 cw status + childDelivery
- cw store 无：BFS 已 dispatched 但未完成的节点（"在跑"vs"没 dispatch"不可区分）
- 应对：保守近似——重跑所有非终态节点，靠 worktree 隔离（每节点独立 worktree，崩溃残留局限自身）+ agent 幂等重入 + cw gate 兜底

---

## 8. 执行流程：Demo 示例

以"给博客系统加评论功能"为例，完整走一遍。

### 8.1 任务树（最终形态）

```
epic:comment-system [closed]
├── feature:comment-crud [closed]
│   ├── slice:backend-api [closed]
│   │   ├── wave:db-migration [closed]      commit:abc111
│   │   ├── wave:route-impl [closed]        commit:abc112
│   │   └── wave:validation [closed]        commit:abc113
│   └── slice:frontend-list [closed]
│       ├── wave:comment-component [closed] commit:abc114
│       └── wave:list-page [closed]         commit:abc115
├── feature:reply-nesting [closed]
│   └── ...（省略）
├── feature:like [closed]
│   └── ...（省略）
└── feature:notify-moderate [closed]
    └── ...（省略）
```

### 8.2 逐步执行轨迹

**第 0 步：启动**

主 agent（或脚本）创建根 epic：
```bash
cw create epic --objective "给博客系统加评论功能" --slug comment-system
# → 返回 unitId: epic:comment-system，status: created，nextAction: clarify
```

**第 1 轮 BFS：epic 层（clarify → plan → design-review → execute）**

`cw frontier` 返回 `[epic:comment-system, status:created, nextAction:clarify]`。

workflow 脚本派一个 agent：
```js
await agent({
  prompt: "你是 epic 规划者。用 cw handoff 拿上下文，走完 epic 的 clarify→plan→design-review→execute",
  schema: { features: [{ id, desc }] },  // execute 后的产出
  cwd: <主 worktree>
})
```

agent 内部轨迹：
```
agent 读 cw handoff --unitId epic:comment-system
  → 知道该从 clarify 开始
agent 调 cw clarify ... → ok
agent 调 cw plan --input '{split:[{slug:comment-crud,...},{slug:reply-nesting,...},...]}' 
  → ok，cw 存了 epic.plan.split
agent 调 cw design-review --input '{judgments...}' 
  → cw 跑 design-review gate（feature-split-* + DAG 无环）→ pass
agent 调 cw execute 
  → cw 自动创建 4 个 feature 子单元（comment-crud/reply-nesting/like/notify-moderate）
  → cw 返回 crossLayer.descend
agent 返回 schema: { features: [4 个 feature] }
```

**第 2 轮 BFS：feature 层（4 个并发）**

`cw frontier` 重新拉取，现在返回 4 个 feature 节点（status:created, nextAction:clarify）。

workflow 脚本并发派 4 个 agent：
```js
await parallel(
  features.map(f => agent({
    prompt: `你是 feature 规划者，负责 ${f.id}。走完 feature 的全流程`,
    schema: { slices: [{ id, desc }] },
    cwd: <主 worktree>   // feature 是规划层，不写代码，共享主 worktree
  }))
)
```

每个 feature agent 内部：clarify → plan（拆 slices）→ design-review → execute（cw 自动建 slice 子单元）。

以 comment-crud 为例，execute 后创建 backend-api、frontend-list 两个 slice。

**第 3 轮 BFS：slice 层（8 个并发，假设 4 feature × 2 slice）**

`cw frontier` 返回 8 个 slice 节点。并发派 8 个 agent。每个 slice agent：plan（拆 waves）→ design-review → execute（cw 自动建 wave 子单元）。

以 backend-api 为例，execute 后创建 db-migration、route-impl、validation 三个 wave。

**第 4 轮 BFS：wave 层（叶子，多 wave 并发）**

`cw frontier` 返回所有 wave 节点。这是实际写代码的层。

```js
await parallel(
  waves.map(w => agent({
    prompt: `你是 wave 执行者，负责 ${w.id}。走完 wave 9 步`,
    schema: { commitHash, summary, artifacts },
    cwd: <wave 专属 worktree>   // ← 关键：每个 wave 独立 worktree，隔离写入
  }))
)
```

以 db-migration wave 为例，agent 内部轨迹：
```
agent 读 cw handoff --unitId wave:comment-system::backend-api::db-migration
  → 知道该从 clarify 开始（wave 也有 clarify/plan/design-review）

agent 调 cw clarify / cw plan（填 testCases）/ cw design-review（gate 验 testCases 结构）
  → 全 pass

agent 调 cw execute
  → 记录即将产生的 commit（cw 的 wave execute 只记 commitHash 字段位）
  → 注意：cw 不写代码，agent 用 bash 工具写代码 + git commit

agent 写迁移文件，git commit -m "feat: comment db migration"
  → 拿到 commitHash: abc111

agent 调 cw test --input '{commitHash:abc111, testRunResult:...}'
  → cw 跑 gate：
     commit-exists: git cat-file -e abc111^{commit} → pass
     tests-all-pass: spawnSync npm test → pass
  → ok

agent 调 cw exec-review --input '{readability,architecture,verdict}'
  → gate 验结构 → pass

agent 调 cw retrospect --input '{lessonsLearned, childUnitIdsEvidence:[]}'
  → pass

agent 调 cw closeout --input '{summary:"...", artifacts:[{kind:commit,ref:abc111}]}'
  → cw 跑 drift-check（abc111 存在）→ pass
  → status: closed，evidence.frozenAt 写入
  → cw 自动 rollupChildDelivery：回写父 slice backend-api 的 childDelivery

agent 返回 schema: { commitHash:abc111, summary:"...", artifacts:[...] }
```

**gate fail 闭环示例**（假设 route-impl wave 的测试没过）：
```
agent 写完 route 代码，git commit abc112
agent 调 cw test
  → cw 跑 gate:
     commit-exists: pass
     tests-all-pass: npm test → FAIL（2 个测试失败）
  → 返回 ok=false, mustFix:"tests-all-pass: 2 failures in route.test.ts"

agent 读 mustFix，还在同一 turn 内
agent 修 route 代码，amend commit（或新 commit）
agent 重新调 cw test --input '{commitHash:abc112-new, ...}'
  → gate 重验 → pass
  → 继续 exec-review...
```

**聚合阶段**（cw 自动 + retrospect gate 校验）：

所有 wave closeout 后，cw 的 rollup 已自动把每个 wave 结果回写到父 slice 的 childDelivery。

以 backend-api slice 为例，它的 3 个 wave 全 closed 后：
```
cw frontier 显示 backend-api slice 的 nextAction 是 retrospect
workflow 派 agent 调 cw retrospect --unitId slice:...::backend-api
  → cw 跑 retrospect gate:
     all-waves-closed: 3 个 wave 全 closed → pass
     childDeliveryConsistency: agent 填的主观验收 vs cw 自动 rollup 的客观状态 → 一致 → pass
     splitFulfillmentCoversPlan: plan 的 3 个 split 都被覆盖 → pass
  → pass，slice 进入 exec-reviewed → closeout
```

逐层 ascend：slice closeout → feature retrospect（校验所有 slice closed）→ feature closeout → epic retrospect（校验所有 feature closed）→ epic closeout。

**最终**：`cw tree --root epic:comment-system` 全部 closed，主流程调 cw 读取最终聚合结果。

---

## 9. 详细改动点列举

以下为让本架构落地需要的新建/改造项，按系统分组。**均为候选改动，未批准**。

### 9.1 cw 侧（coding-workflow）

| # | 改动 | 类型 | 必要性 | 说明 |
|---|------|------|--------|------|
| C1 | **新增 `cw frontier`（或类似）只读命令** | 新增 | **必需** | 幂等列出所有非终态节点 + 各自 nextAction。是 workflow BFS 调度的依据，也是 worker 崩溃恢复的前提。实现：`findChildren` 递归 + status 过滤 + `status→action` 映射（`render.ts:497-521` 已有映射），纯只读封装 |
| C2 | **cw store 改 per-project（同源 key）** | 改造 | **必需**（若用 worktree） | 从 `~/.cw/<encodedCwd>/` 改为按 git root / workspace 根隔离。worktree 下共享同一 store。涉及 `schema.ts:85-88` encodeCwd + `getCwJsonPath`。需处理迁移 + 跨目录文件锁验证 |
| C3 | frontier 命令的"层"语义定义 | 设计 | **必需** | frontier 的层是 cw scope（epic/feature/slice/wave）还是 BFS 执行层？需明确映射。尤其"planning 层 execute 会动态创建子层"的时序 |
| C4 | `cw frontier` 输出格式（JSON）| 设计 | **必需** | 供 workflow 脚本消费的结构化输出，含 nodeId/scope/status/nextAction/parentUnitId |

### 9.2 pi/subagent-workflow 侧

| # | 改动 | 类型 | 必要性 | 说明 |
|---|------|------|--------|------|
| P1 | **编写递归调度 workflow 脚本** | 新增 | **必需** | 单个 `.js` workflow，实现 BFS 迭代 + `parallel()` 并发 + 读 cw frontier + 派 agent。是整个架构的核心组件 |
| P2 | 编写各层专用 agent 定义（.md） | 新增 | **必需** | epic-planner / feature-planner / slice-planner / wave-executor，各自工具集（planner 只读+bash 调 cw；wave-executor 有编辑+测试+bash）。agent 的 `tools` frontmatter 控制工具集 |
| P3 | wave-executor agent 的 prompt 工程 | 新增 | **必需** | 明确"读 cw handoff → 执行 → 调 cw → gate fail 则修 → 重调"的循环。这是 gate 闭合的关键，靠 prompt 约束 agent 行为 |
| P4 | worktree 与 wave 的绑定逻辑 | 新增 | **必需** | 每个 wave 分配独立 worktree，agent call 的 `cwd` 传 worktree 路径。复用 pi 现有 fork+worktree 机制（`worktree-manager.ts`）|

### 9.3 集成与协调

| # | 改动 | 类型 | 必要性 | 说明 |
|---|------|------|--------|------|
| I1 | workflow 脚本与 cw frontier 的对接协议 | 设计 | **必需** | 脚本如何解析 frontier 输出、如何分组、如何判断"层完成" |
| I2 | 主流程触发入口 | 设计 | **必需** | 主 agent 如何启动 recursive-split workflow（调 `workflow run recursive-split`）|
| I3 | worktree 下的 cw 调用路径 | 验证 | **必需** | worktree 子目录里调 `cw`，CWD 与 store 同源 key 的对齐（依赖 C2）|

### 9.4 可选（GUI 产品化时）

| # | 改动 | 类型 | 必要性 | 说明 |
|---|------|------|--------|------|
| G1 | runtime 扫描 subagent session 目录 | 新增 | 可选 | 让 GUI 展示 subagent 树。非递归能工作的前提 |
| G2 | runtime 订阅 workflow run 事件流 | 新增 | 可选 | GUI 实时展示 BFS 进度 |

---

## 10. 遗留待决策问题

### 10.1 产品形态：纯 CLI 还是 GUI 产品化？

递归机制在 CLI 层（pi + cw）可独立跑通。若 xyz-agent 要在 GUI 展示递归过程，需做 G1/G2（runtime 可见性）。

**决策影响**：决定 G1/G2 是否进 scope，以及 runtime 层的改动量。

### 10.2 `cw frontier` 命令的"层"语义

frontier 返回的节点如何分组为"BFS 的层"？两种理解：
- (a) 按 cw scope 分组（所有 epic 一组、所有 feature 一组...）—— 但 planning 层和 wave 层混在一起时，wave 要等 planning 全 execute 完？
- (b) 按"是否可并发"分组——无依赖的同 scope 节点并发，有依赖的串行。

cw 的 `dependsOn` 字段当前只用于 design-review 判环，**不驱动执行**。若要让 frontier 支持依赖感知的并发调度，需在 frontier 输出里带 `dependsOn`，由 workflow 脚本做拓扑排序。

**决策影响**：决定并发策略的复杂度（全同层并发 vs 依赖感知并发）。

### 10.3 wave-executor 的认知负载边界

当前设计：wave-executor agent 既要走 cw 9 步流程（clarify/plan/design-review/execute/test/exec-review/retrospect/closeout），又要实际写代码。

**问题**：9 步流程的认知开销是否过重？是否应该简化 wave 层的流程（如跳过 clarify/retrospect，只保留 plan/execute/test/closeout）？

**决策影响**：决定是否需要定制一个"轻量 wave 流程"，可能需要改 cw 的状态机（wave 的可选步骤）。

### 10.4 只读阶段与写入阶段的并发区分

用例 3（调研+实现）需要"只读并行、写入串行"。但 cw 的 wave 模型不区分只读/写入。

**问题**：是否在 cw 的 wave model 加"执行类型"字段（readonly/write）？还是靠 agent prompt 判断？

**决策影响**：决定是否改 cw schema。

### 10.5 replan 的触发权

cw 的 replan（级联 abort + 重走 plan）是重操作。在递归架构里，谁有权触发 replan？
- 单个 wave-executor agent 发现问题，能否触发其 feature 层的 replan（波及兄弟 wave）？
- 还是只能 abort 自己，由上层 agent 决策？

**决策影响**：决定 replan 权限的层级边界，影响失败处理的复杂度。

### 10.6 budget 在递归树的分配策略

pi workflow 的 budget 是共享的（嵌套 workflow 复用父 Budget）。递归树很大时，深层 wave 可能因 budget 耗尽而无法执行。

**问题**：是否按层分配 budget（每层固定额度）？还是全局共享由 workflow 脚本动态调控？

**决策影响**：决定递归深度与 budget 的权衡策略。

### 10.7 静态规划 vs 动态再拆

CMU 实证：静态单层规划 > 动态多层规划。当前架构是"BFS 逐层动态推进"（每层 execute 时才创建子层）。

**问题**：是否改为"顶层一次性规划整棵树（epic 到 wave 全 plan 完），再按树执行"？这能避开动态再拆的不确定性，但要求顶层 agent 一次性理解全貌（上下文压力）。

**决策影响**：决定是 BFS 动态推进还是静态全规划，影响顶层 agent 的上下文设计。

---

## 附录 A. 关键代码证据索引

> 所有结论的代码出处，便于实现期核对。

### A.1 pi/subagent-workflow

| 结论 | 文件:行 |
|------|--------|
| 递归 spawn 原生支持 | `extensions/subagent-workflow/src/interface/subagent-tool.ts:224-226`（工具描述含 Nested spawning 段）|
| MAX_FORK_DEPTH = 10 | `extensions/subagent-workflow/src/execution/session-context-resolver.ts:22` |
| 双重护栏（fork + 通用嵌套）| `extensions/subagent-workflow/src/execution/subagent-service.ts:411-417` |
| triggerTurn 自动续跑 | `extensions/subagent-workflow/src/execution/notifier.ts:195-206`（`sendMessage({triggerTurn:true, deliverAs:"steer"})`）|
| **每次 agent() spawn 独立 pi 子进程** | `extensions/subagent-workflow/src/orchestration/execute-agent-call.ts:114,139`；`models/types.ts:131-135`（child_process.spawn）|
| **单 call 3 次重试 + 指数退避** | `extensions/subagent-workflow/src/orchestration/execute-agent-call.ts:168-178` |
| workflow 是可编程 JS（agent/parallel/pipeline/workflow 注入）| `extensions/subagent-workflow/src/orchestration/worker-script-builder.ts:172-321` |
| 动态生成 workflow 文件 | `extensions/subagent-workflow/src/interface/tool-workflow-script.ts:241-308`（写 `.pi/workflows/.tmp/`）|
| 嵌套 workflow + 循环检测 | `extensions/subagent-workflow/src/orchestration/launcher.ts:264-368`（`chain.includes(name)` 拒绝同名递归）|
| schema 结构化输出（parsedOutput，不受 8k 截断）| `extensions/subagent-workflow/src/orchestration/worker-script-builder.ts:144` |
| parallel() 返回 {status,result}[] | `extensions/subagent-workflow/src/orchestration/worker-script-builder.ts:244-267` |
| budget 共享（嵌套复用父 Budget）| `extensions/subagent-workflow/src/orchestration/launcher.ts:316-324` |
| 崩溃隔离（agent 失败不 reject 到 worker）| `extensions/subagent-workflow/src/orchestration/worker-script-builder.ts:135-145`（失败 resolve 而非 reject）|
| worktree 隔离机制 | `extensions/subagent-workflow/src/execution/worktree-manager.ts`；`models/types.ts:131-135`（per-call cwd）|
| worker 无 fs 限制但有 child_process 能力 | `extensions/subagent-workflow/src/orchestration/worker-script-builder.ts:61`（require node:worker_threads），无对 child_process/fs 的拦截 |

### A.2 cw (coding-workflow)

| 结论 | 文件:行 |
|------|--------|
| 四层 WorkUnit（epic/feature/slice/wave）扁平存储 | `src/core/workunit.ts:53-90`；`src/store/schema.ts:62-72` |
| PlanningUnit vs ExecutionUnit（wave 是唯一产代码层）| `src/core/workunit.ts:102-111`（planning）/ `174-185`（execution）|
| 状态机（wave 10 态 + planning 8 态）| `src/rules/state-machine.ts:64-119`（WAVE）/ `292-332`（PLANNING）|
| gate 机器校验（不信任 agent 声明）| `src/rules/gates/test.ts`（commit-exists + tests-all-pass）/ `closeout.ts:57-104`（drift-check）|
| design-review gate（DAG 无环 + 结构完整）| `src/rules/gates/design-review.ts:399`（splitDagValid DFS 三色判环）|
| retrospect gate（all-waves-closed + childDeliveryConsistency）| `src/rules/gates/retrospect.ts:197-217`（all-waves-closed）/ `402-465`（一致性交叉校验）|
| **rollup 自动结构化聚合** | `src/handlers/rollup.ts:110-145`（子终态回写父 childDelivery）|
| closeout 触发 rollup | `src/handlers/closeout.ts:112-117` |
| crossLayer（descend/sibling/ascend）| `src/guidance/cross-layer.ts:60-96` |
| replan 级联 abort（迭代到不动点）| `src/rules/replan.ts:155-217`（computeImpactCascade）|
| **execute 自动创建子层 unit** | `src/handlers/slice/execute.ts:48-69`（按 plan.split 循环 createWave）|
| **status → nextAction 映射** | `src/readonly/render.ts:497-521`（status=created→clarify 等）|
| cw handoff（五段式重入上下文）| `src/readonly/render.ts:767+`；SKILL.md:210 |
| findChildren | `src/store/cw-store.ts:384` |
| cw store per-cwd（需改为 per-project）| `src/store/schema.ts:85-88`（encodeCwd）/ `130-132`（getCwJsonPath）|
| gate fail 熔断（5 次建议 abort，不阻断）| `src/guidance/failure-hint.ts` |
| subagent-guidance（三档委派建议，agent-agnostic）| `src/guidance/subagent-guidance.ts:47-133` |

### A.3 xyz-agent runtime（可见性，可选）

| 结论 | 文件:行 |
|------|--------|
| subagent session 不进主列表 | `packages/runtime/src/infra/pi/session-file-utils.ts:548`（scanPiSessions 只扫主目录）|
| subagent 存独立目录 | `packages/runtime/src/infra/pi/pi-paths.ts:103-104`（getSubagentSessionDir）|
| runtime 只旁观转发续跑事件 | `packages/runtime/src/services/session/event-interpreter.ts:468-498`（handleSubagentBgNotify 只更新状态不续跑）|

---

## 附录 B. 讨论收敛轨迹（9 轮关键转折）

1. **轮次 1-2**：摸清 pi/subagent 已支持递归（MAX_FORK_DEPTH=10 + triggerTurn），cw 是 agent-agnostic 状态机。识别五个难点。
2. **轮次 3-4**：确认 cw 四层本身就是"受控递归"，pi workflow 是被低估的编排引擎。难点四（缺编排层）被 pi workflow 解决。
3. **轮次 5**：深入三个缺口（桥接/并发/深度）。发现核心是"两套系统控制流模型不同导致信号错位"。
4. **轮次 6**：用户提出关键反驳——runtime 可见性非递归前提；worktree 同源 key；**pi workflow 做编排**。调研确认 pi workflow 是更好的编排层，推翻"独立 broker"结论。
5. **轮次 7**：用户提出递归 workflow 脚本自驱（BFS）+ schema 输出解决最后一公里。识别 worker 不能自生成文件 + 同名递归被循环检测拒绝的限制。收敛到"单 worker BFS + schema"。
6. **轮次 8**：用户提出"agent schema 返回 cw 命令字符串让脚本执行"。识别安全边界外泄问题。转向"agent 自己调 cw"（gate 闭环在 agent 内）。
7. **轮次 9（本档）**：确认每次 agent() spawn 独立子进程（崩溃隔离）+ 内置 3 次重试。确认 cw 可提供 frontier 幂等查询基础。三个问题（gate 时机/崩溃半径/幂等拉取）全部正面解答。架构闭环。
