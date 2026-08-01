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
- [11. 可行性审查发现（轮次 10）](#11-可行性审查发现轮次-10)
- [12. 决策与实现路径（轮次 11）](#12-决策与实现路径轮次-11)
- [13. 第二轮可行性审查发现（轮次 12）](#13-第二轮可行性审查发现轮次-12)
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
7. **轮次 9**：确认每次 agent() spawn 独立子进程（崩溃隔离）+ 内置 3 次重试。确认 cw 可提供 frontier 幂等查询基础。三个问题（gate 时机/崩溃半径/幂等拉取）全部正面解答。架构闭环。
8. **轮次 10（可行性审查）**：3 个 subagent 从 cw 侧 / workflow 侧 / 端到端走查三个维度独立审查，发现 4 个致命阻断点（agent() 无 worktree 支持、cw store worktree 断裂、frontier 不存在、双树混淆）+ 3 个高估项（childDeliveryConsistency 伪校验、budget 累积、design-review 不刹质量）。§4 的 5 个"✅已解"标注过于乐观。详见 §11。
9. **轮次 11（决策与收敛）**：用户 6 个回应解除 5 个阻断/高估——agent() 加 worktree（验证 ExecuteOptions 已有字段，改造仅 3 处约 10 行）、cw project key 分离、agent 写 cw + schema 转派发指令（消除双树，frontier 降级为崩溃恢复专用）、retrospect 读子 agent session jsonl（伪校验→真实复盘）、budget 无限、workflow 确定性派发保证 review。三个关键决策：每 action 一个 agent、按任务复杂度选起点层（不跳层）、frontier 一起做完。详见 §12。
10. **轮次 12（第二轮审查）**：3 个 subagent 从 §12 架构数据流 / 改动点代码级核实 / 端到端逐 action 走查三个维度审查 §12 新设计。发现 §12 的 4 个关键技术假设被源码证伪：(1) `executeAndAwait`（workflow 入口）根本不消费 `worktree===true`——改动 1A 是空操作；(2) wave 的 9 个 agent 无法共享 worktree（决策 A 与 worktree 隔离粒度冲突）；(3) cw execute 返回值不含全部子 unit id；(4) agent() 消息层丢弃 sessionFile。引入 2 致命 + 2 高危新阻断，但解法方向清晰（接缝处实现细节需补，非推翻重来）。详见 §13。
11. **轮次 13（W3 实测 + 决策 D）**：实测验证 `git rev-parse --git-common-dir` 的 dirname 在 8 种 worktree 场景下一致（W3 方案成立，go/no-go 分水岭通过）。实测发现必须用 `fs.realpathSync` 解析符号链接（macOS `/var`→`/private/var`）。用户决策 D：保持 worktree 隔离方案（不退回同 cwd 串行），集成测试先不做（未来在 slice 层增加集成 test gate，当前不设计）。接受"各 wave 单独 test 通过但 merge 后可能冲突"的残余风险，靠依赖感知调度（有 dependsOn 的 wave 串行）缓解。

---

## 11. 可行性审查发现（轮次 10）

> 3 个 subagent 从 cw 侧 / pi workflow 侧 / 端到端走查三个维度独立审查，全部结论经主 agent 亲自核实关键代码确认。本节如实记录所有阻断点与高估项，作为 §4 "难点分析"的勘误与补充。**§4 的 5 个"✅"标注是基于"cw 已有能力 + pi workflow 已有能力"的乐观推断，没验证两者的接缝。接缝处才是真正的问题。**

### 11.1 致命阻断点（4 个，已在轮次 11 全部解除，解法见 §12）

#### 阻断 1：`agent()` 无法创建 worktree（spec §5.1 决策 5 的地基不存在）

**问题**：`AgentCallOpts`（`orchestration/models/types.ts:70`）没有 `fork`/`worktree` 字段；worker 注入的 `_knownFields` 白名单（`worker-script-builder.ts:207`）不含它们；`mapToExecuteOptions`（`execute-options-mapper.ts:45-64`）只透传 `cwd`。worktree 创建逻辑（`worktree-manager.ts`）只被 `subagent` tool 路径触发（`opts.worktree === true`），workflow 的 `agent()` 完全绕过。

**后果**：spec §8.2 的"每个 wave 专属 worktree"无法实现。并发 wave 在同一 cwd 写代码 → `.git/index.lock` 冲突。

**核实结论（轮次 11）**：断裂点比预想窄得多。`ExecuteOptions`（`execution/types.ts`）**已有** `fork`/`worktree`/`cwd` 字段，`SubagentService.executeAndAwait` 完整消费它们（`subagent-service.ts:422-448,669-695`），worktree 创建/隔离/cleanup 全套已实现。**只需在 AgentCallOpts 加字段 + mapToExecuteOptions 透传 + _knownFields 放行，共 3 处约 10 行。** 详见 §12 改动 1A。

#### 阻断 2：worktree 下 cw store 断裂 + testRunner cwd 不对

**问题**：
- cw store 路径按 `encodeCwd(cwd)` 编码（`schema.ts:130-132`），worktree 的 cwd 不同 → 不同 store → wave agent 进 worktree 后 `cw handoff` 返回 unit not found。
- `CwDeps.workspacePath`（`cli.ts:650`）从 cwd 派生，testRunner/gitValidator 绑定在 cw 进程的 cwd 跑。
- **核心矛盾**：store/锁要 per-project（共享），test/git 要 per-worktree（隔离）。当前 cw 把它们全绑在同一个 `workspacePath`。
- **worktree 无 node_modules**（`worktree-manager.ts:80` 的 `git worktree add HEAD` 是新 checkout，`:97` 的 symlink 是 best-effort）→ wave 在 worktree 跑测试 → module not found → test gate 系统性失败。

**后果**：wave agent 进 worktree 后断线（拿不到 handoff）+ 测试系统性失败。

**核实结论（轮次 11）**：核心是"多 worktree 识别为同一项目"。解法是引入 `resolveProjectKey(cwd)` 分离两个 cwd 语义——store/锁用 projectKey（per-project），workspacePath 仍用 cwd（per-worktree）。详见 §12 改动 1B。node_modules 问题靠 agent prompt 约束（"新增依赖先在主 worktree 安装"）+ worktree-manager 现有 symlink 兜底。

#### 阻断 3：`cw frontier` 不存在 + 层语义未定义

**问题**：
- `grep -rn "frontier" src/` 零命中，C1/C3/C4 三个"必需未实现"。
- `status=executing`（planning 层 execute 后等子层完成）的节点，status→action 映射说 nextAction=retrospect（`render.ts:520`），但此时子层没做完，retrospect gate（all-waves-closed）必 fail。**frontier 必须做"子层完成度感知"——查 findChildren 判断是否全终态。**
- BFS（workflow frontier）与 DFS（cw crossLayer.descend/sibling/ascend）导航主导权冲突。

**核实结论（轮次 11）**：用户的 schema 派发设计（回应 3）让 frontier 从"调度必需"降级为"崩溃恢复专用"——正常 BFS 由 agent 返回的 schema children 驱动，不需要回头查 frontier。但用户决策 frontier 一起做完（崩溃恢复需要）。frontier 实现需额外做子层完成度检查（两遍扫描）。详见 §12 改动 3B。

#### 阻断 4：schema children vs cw execute 双树混淆

**问题**：spec §6.2 说 agent 返回 schema children 推入 BFS，但 §7.1 又说"frontier 重新拉取含新创建子层"——BFS 到底消费哪棵树？cw execute 按 plan.split 建子层（树 A），schema 返回的 children（树 B），两者关系未理清。

**核实结论（轮次 11）**：用户的回应 3 彻底解决——**schema children 不是"第二棵树"，是 cw 树的"派发投影"**。agent 调 cw execute 时 cw 按 plan.split 建子层 unit（cw 是 SSOT），agent 返回的 schema 只是把"cw 拆出来的 split 列表"翻译成 workflow 能消费的下一层 agent prompt 数组。两者不冲突。详见 §12 架构不变式。

### 11.2 高估项（3 个，spec §4 标"✅已解"但实际需补救）

#### 高估 1：`childDeliveryConsistency` 是伪校验（§4.2 标"✅已有解"）

**问题**：retrospect gate 校验"agent 填的主观验收 vs cw 自动 rollup 的客观状态"。但 slice agent 没执行过 wave，它的"主观验收"只能读 cw 客观数据抄录 → 自己抄自己必然一致。若 agent 真做主观判断与 cw 不一致 → gate fail → agent 被强制改判断对齐 cw → 主观判断被完全压制。

**补救（轮次 11 回应 4）**：让 retrospect agent 读子 wave agent 的 session jsonl（完整工具调用记录）做真实复盘。`AgentResult.sessionFile`（`types.ts:186`）可拿到 session 文件路径，workflow 脚本记录它，retrospect 时传给 retrospect agent。这让 retrospect 从"抄 cw 状态"升级为"读执行轨迹复盘"。需处理的张力：gate 强制 status 一致 vs retrospect agent 想给更细的主观评价（建议 childUnitIdsEvidence 加 qualityNote 字段，gate 只校验 status 不校验 qualityNote）。

#### 高估 2：budget 单 run 累积会杀掉整个 BFS（§4.5 标"✅已解"）

**问题**：BFS 整棵树的所有 agent() 调用累加到同一个 Budget（`lifecycle.ts:159` 单例）。大树必然 budget_limited 终止（`error-recovery.ts:362`），这是正常终态不是崩溃，不会自动重跑。

**补救（轮次 11 回应 5）**：budget 调成无限（maxTokens=0 或 isExhibited 直接返回 false）。代价是失去"防 token 爆炸"保护，但递归验证阶段可接受。

#### 高估 3：design-review 不是"结构性刹车"（§4.3 标"部分缓解"）

**问题**：gate 只校验结构（非空/id 存在/无环），不校验内容质量。垃圾拆分能过 gate；`dependsOn` 漏标（不是环）完全不检测，且 cw 不按 dependsOn 调度执行。

**补救（轮次 11 回应 6）**：workflow 确定性派发保证 review 的 agent() 一定执行。每个 review 由独立 agent 做（每 action 一个 agent），没有前序步骤的"沉没成本"偏见，更客观。

### 11.3 审查新发现的阻碍（spec 完全没提）

| # | 阻碍 | 证据 | 处理 |
|---|------|------|------|
| 新1 | **cw subagent-guidance 禁止 planning retrospect 委派** | `subagent-guidance.ts:102-133` PLANNING_RULES retrospect=forbidden | 需改 cw subagent-guidance，承认递归场景下 retrospect 必须委派 |
| 新2 | **崩溃恢复撞状态机非法重入**——executing 状态重入 guardPlanning("execute") → illegal_transition | `state-machine.ts:310` execute.from=[design-reviewed] | frontier 重建时按 status→action 映射走（不重调 execute），executing 节点的 action 是 retrospect |
| 新3 | **并发 wave 语义依赖产出不可合并**——wave B dependsOn wave A，worktree 隔离下 B 看不到 A 的改动，patch 合并冲突 | worktree HEAD 是同一个 base commit | 依赖感知调度：有 dependsOn 的 wave 串行，无依赖的并行。详见 §12 取舍 |
| 新4 | **feature 层 FR/AC 强制对中小任务是纯开销** | `design-review.ts:639` ac-non-empty | 按任务复杂度选起点层（用户决策 2）：小任务从 slice/wave 起，不走 feature/epic |
| 新5 | **workflow reentry 锁**——同一时刻只能一个 workflow run | `tool-workflow.ts:272` | 接受。大树跑期间不并发其他 workflow |
| 新6 | **实际并发=4**（ConcurrencyGate maxConcurrency=4） | `lifecycle.ts:190` | spec §8 的"8 并发"高估，实际 4。不影响正确性，并发收益打折 |
| 新7 | **notifyDone 8k 截断与"走 cw store"冲突**——workflow run 完成时 helpers.ts:97-100 必然把 scriptResult 截断注入主 agent | `helpers.ts:26,97-100` | BFS 脚本 return 极简 stub（如 `{status:"done", epicId}`），主 agent 据此调 cw 读全量 |
| 新8 | **跨层 id 引用依赖 handoff 暴露父层 id**——agent 填 inheritedItemIds 需读父层条目 id | `design-review.ts:296-317` inheritedItemIdsValid | 已验证 handoff 五段式含"已定决策"段，渲染 plan/clarifications/judgments。需验证 upstream scope 是否完整暴露父层条目 id |

---

## 12. 决策与实现路径（轮次 11）

> 基于审查发现（§11）+ 用户 6 个回应 + 3 个关键决策，收敛出的最终架构与实现路径。本章取代 §4-§9 中被审查证伪的部分（§4 的乐观"✅"、§7 的 frontier 调度依赖、§9 的部分改动点描述）。

### 12.1 六个回应的评判

| 回应 | 评判 | 对阻断/高估的影响 |
|------|------|--------------|
| 1. agent() 加 worktree | ✅ 成立，改造仅 3 处约 10 行（ExecuteOptions 已有字段） | **解除阻断 1** |
| 2. worktree 同项目识别 | ✅ 方向正确，引入 project key 分离 | **解除阻断 2**（中等改造）|
| 3. agent 写 cw + schema 转派发指令 | ✅ 优雅，消除双树混淆 | **解除阻断 4**，降低阻断 3 优先级 |
| 4. retrospect 读 session jsonl | ⚠️ 可行有价值，需处理 status vs 质量评价张力 | **补救高估 1**（伪校验→真实复盘）|
| 5. budget 无限 | ✅ 直接解决 | **解除高估 2** |
| 6. workflow 保证 review 确定性 | ✅ 逻辑正确，粒度需权衡 | **补救高估 3** |

### 12.2 三个关键决策

#### 决策 A：每个 action 一个 agent（用户决策 1）

每个 cw action（clarify/plan/design-review/execute/test/exec-review/retrospect/closeout）由一个独立的 `agent()` 调用执行。每个 agent 的终极目标是"完成该 action 并通过 gate"。

**时序可行性（已验证）**：agent B 调 `cw handoff` 时，handoff 五段式含"已定决策"段（`render.ts:546-579`），渲染前序 action 填的 plan/clarifications/judgments。**cw store 是 agent 间信息传递的唯一媒介，handoff 是读取入口**。每个 agent 读 handoff 获取前序产出，执行自己的 action，写回 store。

**价值**：
- gate 闭合在 agent 内（agent 调 cw → gate fail → 同一 agent 修 → 重调）
- review 类 action（design-review/exec-review/retrospect）由独立 agent 做，无前序步骤的沉没成本偏见，更客观（补救高估 3）
- 每个 agent 上下文轻（单一目标），不爆炸

**代价**：agent() 调用数大幅增加。一棵 20 wave 的树，每个 wave 9 步 = 180+ agent() 调用。每个是独立 pi 子进程 spawn（几秒 + LLM 调用）。**接受这个代价**——正确性优先于性能，且单 call 有内置 3 次重试。

#### 决策 B：按任务复杂度选起点层，不跳层（用户决策 2）

cw 固定 4 层（epic/feature/slice/wave），但不同复杂度的任务起点不同：
- **小任务**：从 `slice` 或 `wave` create 开始（1-2 层即可）
- **中型任务**：从 `feature` 开始（3 层：feature→slice→wave）
- **大型任务**：从 `epic` 开始（完整 4 层）

**不跳层**：一旦确定起点，后续严格按相邻层推进，不支持跨层跳。

**起点判断在进入 workflow 之前**：由主 agent（或用户）判断任务复杂度，决定起点层，作为参数传入 workflow 脚本。workflow 脚本支持 `startLayer` 参数（epic/feature/slice/wave）。

**价值**：避免中小任务走四层的纯开销（feature 层 FR/AC 强制编造，补救新发现 4）。

#### 决策 C：frontier 一起做完（用户决策 3）

虽然 schema 派发设计（回应 3）让正常 BFS 不需要 frontier，但崩溃恢复需要它。用户决定一起做完。

**frontier 的两层用途**：
1. **崩溃恢复**（必需）：worker 崩溃后 schema 内存态丢失，从 cw store 重建 BFS 队列
2. **状态查询**（附带）：供主 agent / 用户查看递归进度（`cw frontier --root <epicId>`）

**实现要点**（比 spec §9 C1 描述的复杂）：
- 不只是"findChildren + status 过滤 + status→action 映射"三步
- **需额外做子层完成度检查**：planning 层 executing 节点的 nextAction 取决于子节点是否全终态。全终态→retrospect（可派）；有非终态→阻塞（不可派，但不消失）
- **两遍扫描**：先扫所有节点状态，再判定哪些 planning executing 节点的子层已全终态

#### 决策 D：保持 worktree 隔离，集成测试推迟（用户决策，轮次 13）

**背景**：worktree 隔离下，各 wave 在独立 worktree 测试自己的代码（单元测试自洽），但"多个 wave 的产出 merge 后是否冲突"未被验证——cw 当前只有 wave 层有 test gate，slice/feature/epic 的 retrospect 不做集成测试。

**决策**：
1. **保持 worktree 隔离方案**（W1-W4 仍为 MVP 必需）。不退回"同 cwd 串行"。
2. **集成测试先不做**。各 wave 独立 test pass 即视为该 wave 交付。slice retrospect 仍只验"子层全 closed + 主客观一致"（伪校验问题靠 §12 改动 3C retrospect 读 session jsonl 补救，不做集成 test）。
3. **未来在 slice 层增加集成 test gate**（方向 1：slice retrospect 时 merge 子 wave commit 到集成分支跑测试）。这是后续迭代，当前不设计。

**取舍记录**：
- 接受"各 wave 单独 test 通过但 merge 后可能冲突"的风险。缓解依赖：依赖感知调度（§12.5 R2——有 dependsOn 的 wave 串行，B 的 worktree 从 A 的 commit 创建，B 能看到 A 的代码）。
- 无依赖的 wave 仍可能改同一文件（间接冲突），但概率低于有依赖的。MVP 阶段接受这个残余风险。

### 12.2.1 W3 验证结果（轮次 13 实测）

**验证目标**：`git rev-parse --git-common-dir` 的 dirname 是否在所有 worktree 场景下一致（projectKey 方案可行性）。

**实测脚本**：覆盖 8 个场景——普通 repo + worktree、bare repo + worktree、monorepo 子包、非 git 目录、detached HEAD worktree、submodule、worktree 内嵌 worktree、远离 repo 的 tmpdir worktree。

**结果**：**全部 PASS，方案成立。**

| 场景 | 结果 | 说明 |
|------|------|------|
| 普通 repo + 2 worktree | ✅ | main/wt-a/wt-b key 一致 |
| bare repo + worktree | ✅ | feat/fix key 一致，projectKey = workspace 根（`.bare` 父目录）|
| monorepo 子包 | ✅ | root/sub key 一致 |
| 非 git 目录 | ✅ | 降级为 NOT_A_GIT_REPO |
| detached HEAD worktree | ✅ | 与 main 一致 |
| submodule | ℹ️ | 独立 key（指向 `.git/modules/xxx`）——正确行为，submodule 是独立项目 |
| worktree 内嵌 worktree（wave 子 worktree）| ✅ | 与父 worktree 一致 |
| 远离 repo 的 tmpdir worktree（pi 模式）| ✅ | 与 main 一致——**关键，pi worktree-manager 把 wave worktree 建在 os.tmpdir() 下** |

**实现注意事项（实测发现）**：
1. **必须用 `fs.realpathSync`（或 `pwd -P`）解析符号链接**。macOS 的 `/tmp`→`/private/tmp`、`/var`→`/private/var` 会导致未解析路径不一致。`resolveProjectKey` 实现必须 `fs.realpathSync(dirname(commonDir))`，不能裸 `dirname`。
2. **projectKey 与分支无关**——`git rev-parse --git-common-dir` 返回物理仓库路径，不参与分支计算。不同分支的 worktree 解析出同一 key（已验证 detached HEAD）。无分支混淆风险。
3. **bare repo 下 projectKey = workspace 根**（`.bare` 父目录），不是 bare repo 本身。这是正确的——所有 worktree 共享同一棵 cw 树。
4. **submodule 有独立 key**——submodule 的 common-dir 指向 `.git/modules/xxx`，与主 repo 不同。正确行为（submodule 是独立项目，应有独立 cw store）。

### 12.3 最终架构（取代 §6 的部分描述）

#### 核心数据流（取代 §6.2，消除双树混淆）

```
workflow 脚本（BFS 协调者，单 worker 进程）
  │
  ├──[初始化] cw create <startLayer> → 拿到 root unitId
  │
  ├── BFS 循环：
  │   ├──[派] 对 queue 中每个节点、每个 action：
  │   │     agent({
  │   │       prompt: "完成 unitId=X 的 action=Y，读 cw handoff 拿上下文",
  │   │       schema: 该 action 的结构化输出,
  │   │       fork: true,           // 继承父上下文（看到任务定义）
  │   │       worktree: isWave,     // 只有 wave 用 worktree 隔离写入
  │   │       cwd: $WORKSPACE       // worktree 创建基准 cwd
  │   │     })
  │   │       │
  │   │       ├── agent 读 cw handoff --unitId X（获取前序 action 产出 + 下一步 guidance）
  │   │       ├── agent 执行 action（拆分/写代码/测试）
  │   │       ├── agent 调 cw <action>（gate 校验，fail 则修后重调——闭环）
  │   │       └── agent 返回 schema 结果
  │   │
  │   ├──[收] 对每个 agent 的 schema 结果：
  │   │     ├── 叶子 action（wave 的 closeout）：业务字段（commitHash/summary）
  │   │     └── planning 的 execute：children 数组（cw 已自动建子层 unit，
  │   │         schema children 是"派发投影"——含子 unitId + 下一层 prompt）
  │   │
  │   └──[推进] queue = 收集的 children（schema 驱动，不需查 frontier）
  │
  ├──[完成] BFS 队列空 + cw 所有节点终态
  │         BFS 脚本 return 极简 stub（{status:"done", rootUnitId}）
  │         主 agent 收 notifyDone 后调 cw tree 读全量结果
  │
  └──[崩溃恢复] worker 重启 → cw frontier 重建 queue → 继续
```

#### 架构不变式（取代 §6.3，修订）

1. **cw 是唯一树 SSOT**。agent 调 cw execute 时 cw 按 plan.split 建子层 unit。agent 返回的 schema children 不是"第二棵树"，是 cw 树的"派发投影"（把 cw split 翻译成下一层 agent prompt）。**禁止**让 schema children 独立于 cw 建 second source of truth。
2. **每 action 一个 agent**。agent 读 handoff 获取前序产出，执行单一 action，调 cw 推进（gate 闭环在 agent 内），返回 schema。agent 间不共享上下文，靠 cw store 传递。
3. **agent 自己调 cw**（用 bash 工具，有 permission hook 把关）。**禁止** agent 在 schema 里返回 cw 命令字符串让脚本执行（安全边界外泄）。
4. **结果走 cw store 不走对话注入**。BFS 脚本 return 极简 stub，主 agent 按需调 cw 读取。notifyDone 的 8k 截断只影响 stub（不含业务数据）。
5. **cw store per-project**（projectKey 分离）。worktree 下共享同一 store。test/git 仍 per-worktree。
6. **单 call 失败靠 infra 重试**（3 次 + 指数退避，已实现）。不在脚本层重做重试。
7. **budget 无限**（maxTokens=0 或 isExhibited 返回 false）。

### 12.4 实现路径（三阶段，每阶段可独立验证）

#### 阶段一：打通 worktree（解除阻断 1 + 2）

**改动 1A：给 `agent()` 加 worktree 支持（pi/subagent-workflow 侧，约 10 行）**

| 文件 | 改动 |
|------|------|
| `orchestration/models/types.ts:70` AgentCallOpts | 加 `fork?: boolean` + `worktree?: boolean` |
| `execution/execute-options-mapper.ts:51-63` mapToExecuteOptions | 透传 `fork: opts.fork` + `worktree: opts.worktree` |
| `orchestration/worker-script-builder.ts:207` _knownFields | 加 `"fork"` `"worktree"` |

之后 workflow 脚本可写 `agent({prompt, schema, cwd, fork:true, worktree:true})`。ExecuteOptions 已有字段，SubagentService 已完整消费，worktree-manager 已实现创建/隔离/cleanup。**零改动复用 worktree 全套逻辑。**

注意：worktree 要求 `fork===true`（`subagent-service.ts:422`）。fork 深度计数 `MAX_FORK_DEPTH=10`，4 层 cw 用到 4，离上限有距离。

**改动 1B：cw store per-project（cw 侧，中等改造）**

引入 `resolveProjectKey(cwd)`，分离两个 cwd 语义：

```
当前：getCwJsonPath(cwd) → ~/.cw/<encodeCwd(cwd)>/store.json
     workspacePath = cwd（一个值干所有事）

改造后：
  projectKey = resolveProjectKey(cwd)
    // git -C <cwd> rev-parse --git-common-dir → common .git 路径 → repo root
  storePath = ~/.cw/<encodeCwd(projectKey)>/store.json   ← store/锁 用 projectKey
  workspacePath = cwd                                    ← test/git 用原 cwd（worktree 路径）
```

受影响的 cwd 绑定点：

| 环节 | 当前绑定 | 改造后 |
|------|---------|--------|
| store.json 路径 | encodeCwd(cwd) | encodeCwd(projectKey) — per-project |
| 文件锁 lockfile | 同 store 目录 | 跟随 store — per-project |
| testRunner cwd | workspacePath | workspacePath（cwd）— per-worktree |
| gitValidator | workspacePath | workspacePath（cwd）— per-worktree |
| extractChangedFiles | workspacePath | workspacePath（cwd）— per-worktree |
| repoMeta.worktreePath | 创建时 cwd | 记录各自 cwd — per-worktree |

**验证里程碑**：两个 git worktree 里分别调 `cw status`，能看到同一棵 WorkUnit 树。worktree A 里 `cw create wave`，worktree B 里 `cw tree` 能看到它。

#### 阶段二：单层验证（证明每-action-一个-agent + gate 闭环跑得通）

用单层（直接从 slice create，一个 slice 拆 2 个 wave）验证核心闭环。

**改动 2A：编写单层 workflow 脚本 + 各 action 专用 agent 定义**

```js
// recursive-split.js（单层验证版）
const meta = { name: "recursive-split", description: "..." }
const task = $ARGS.task
const startLayer = $ARGS.startLayer ?? "slice"  // 决策 B：起点层参数

phase("create")
const root = await agent({
  prompt: `调 cw create ${startLayer} 创建根节点，目标：${task}。返回 unitId。`,
  schema: { unitId: "string" },
  cwd: $WORKSPACE
})

// 走完根节点的 planning 流程（每 action 一个 agent）
const actions = ["clarify", "plan", "design-review", "execute"]
let currentUnitId = root.unitId
let children = []
for (const action of actions) {
  phase(action)
  const result = await agent({
    prompt: `完成 unitId=${currentUnitId} 的 ${action}。
      读 cw handoff --unitId ${currentUnitId} 拿上下文和 input schema。
      执行后调 cw ${action} 推进状态。gate fail 就修，重调。`,
    schema: action === "execute"
      ? { children: [{ unitId: "string", prompt: "string" }] }
      : { done: "boolean" },
    fork: true,
    cwd: $WORKSPACE
  })
  if (action === "execute") children = result.children
}

// wave 层：每个 wave 独立 worktree，每 action 一个 agent
phase("wave")
const waveActions = ["clarify", "plan", "design-review", "execute", "test", "exec-review", "retrospect", "closeout"]
const waveResults = await parallel(
  children.map(child => (async () => {
    for (const action of waveActions) {
      await agent({
        prompt: `完成 unitId=${child.unitId} 的 ${action}。
          读 cw handoff 拿上下文。执行后调 cw ${action}。gate fail 就修。`,
        schema: action === "closeout"
          ? { commitHash: "string", summary: "string" }
          : { done: "boolean" },
        fork: true,
        worktree: true,    // ← 每个 wave 独立 worktree
        cwd: $WORKSPACE
      })
    }
  })())
)
return { status: "done", rootUnitId: root.unitId }
```

**验证里程碑**：跑真实任务（如"加 winston 日志"），观察：
- 每个 action agent 能否读 handoff 拿到前序产出
- design-review gate 的 layerSpecific 字段 agent 能否填对（可能需要几轮 gate fail 试错）
- wave agent 在 worktree 里能否走完 9 步（含 test gate）
- gate fail 闭环是否工作

#### 阶段三：完整 BFS 递归 + frontier 崩溃恢复

**改动 3A：扩展为通用 BFS（支持任意起点层 + 递归到 wave）**

```js
// recursive-split.js（完整版）
const startLayer = $ARGS.startLayer  // epic/feature/slice/wave
const LAYER_ORDER = { epic:0, feature:1, slice:2, wave:3 }
const startDepth = LAYER_ORDER[startLayer]

// 创建根节点
const root = await agent({ prompt: `cw create ${startLayer} ...`, schema:{unitId} })

// BFS
const PLANNING_ACTIONS = ["clarify", "plan", "design-review", "execute"]
const WAVE_ACTIONS = ["clarify", "plan", "design-review", "execute", "test", "exec-review", "retrospect", "closeout"]

let queue = [{ unitId: root.unitId, depth: startDepth, prompt: $ARGS.task }]
while (queue.length > 0) {
  const node = queue.shift()
  const isWave = node.depth === 3  // wave 是叶子
  const actions = isWave ? WAVE_ACTIONS : PLANNING_ACTIONS

  // 同层无依赖节点可并发（parallel），有 dependsOn 的串行
  // 此处简化：逐节点串行执行其 action 序列；并发优化见取舍
  for (const action of actions) {
    await agent({
      prompt: `完成 unitId=${node.unitId} 的 ${action}...`,
      schema: (!isWave && action === "execute")
        ? { children: [{ unitId, prompt }] }
        : (isWave && action === "closeout")
          ? { commitHash, summary }
          : { done: "boolean" },
      fork: true,
      worktree: isWave,
      cwd: $WORKSPACE
    })
  }
  // planning execute 后收集 children 入队
  if (!isWave) { /* 从最后一次 execute 的 schema 拿 children 入队 */ }
}
return { status: "done", rootUnitId: root.unitId }
```

**改动 3B：cw frontier 命令（崩溃恢复 + 状态查询）**

```
cw frontier --root <unitId> [--format json]
  输出：所有非终态节点 + 各自 nextAction + 是否阻塞
  实现：
    1. 递归 findChildren 从 root 收集所有节点
    2. 过滤掉 closed/aborted
    3. 两遍扫描：
       a. 第一遍：标记每个 wave 节点的 status→action
       b. 第二遍：对 planning executing 节点，查其 children 是否全终态
          全终态→nextAction=retrospect（可派）
          有非终态→blocked=true（不可派，等子层）
    4. 输出 JSON：[{ unitId, scope, status, nextAction, blocked, parentUnitId }]
```

**改动 3C：retrospect 读 session jsonl（补救高估 1）**

- workflow 脚本在每次 agent() 返回后，记录 `result.sessionFile`（`AgentResult.sessionFile`，`types.ts:186`）
- retrospect agent 的 prompt 含子 wave 的 sessionFile 路径，agent 用 bash 读 jsonl 做真实复盘
- 建议给 cw 的 `childUnitIdsEvidence` 加 `qualityNote` 字段，gate 只校验 status、不校验 qualityNote

**验证里程碑**：BFS 执行中途 kill worker，重启后 `cw frontier` 重建队列继续执行。

### 12.5 剩余取舍点（实现时需决策）

| # | 取舍 | 选项 | 建议 |
|---|------|------|------|
| R1 | 并发策略 | 全串行 / 同层无依赖 parallel / 依赖感知拓扑 | 阶段二串行验证，阶段三按 dependsOn 做"有依赖串行、无依赖 parallel"（需读 cw 的 Split.dependsOn 做拓扑排序）|
| R2 | wave 间语义依赖（新发现 3）| worktree 隔离下 B 看不到 A 改动 | 有 dependsOn 的 wave 串行执行（B 等 A closeout 后再开始，B 的 worktree 从 A 的 commit 创建）。无依赖的 wave 并发 |
| R3 | design-review 的 layerSpecific 字段 agent 填不对 | agent 靠 gate fail 试错 / 在 handoff guidance 里明确字段名 | 改 cw guidance 模板，在 design-review 的 guidance 里列出该层 layerSpecific 的具体字段名 |
| R4 | cw subagent-guidance 禁止 planning retrospect 委派（新发现 1） | 改 cw subagent-guidance / 忍受劝退 | 改 cw subagent-guidance，递归场景下 retrospect 必须委派 |
| R5 | worktree 的 node_modules | symlink 主 repo（现有 best-effort）/ worktree 内 npm install / 主 repo 先装 | agent prompt 约束"新增依赖先在主 worktree 安装"+ worktree-manager 现有 symlink 兜底。若 symlink 失败则 worktree 内 npm install |
| R6 | frontier 的层语义 | 按 scope 分组 / 按可并发性分组 | 按"阻塞/非阻塞"二分（blocked 的不派，非 blocked 的可派），同层非阻塞节点由 workflow 脚本决定并发 |

---

## 13. 第二轮可行性审查发现（轮次 12）

> 3 个 subagent 从「§12 架构数据流可行性」/「§12 改动点代码级核实」/「端到端逐 action 走查」三个维度独立审查 §12 的新设计。结论：**§12 方向正确（schema 派发投影、每 action 一个 agent、project key 分离、retrospect 读 jsonl 都是好设计），但 4 个关键技术假设被源码证伪，引入 4 个新阻断点（2 致命 + 2 高危）。** 解法方向都存在且清晰，属于"接缝处实现细节需补"，不是推翻重来。两个独立 agent 分别从代码核实和走查到达相同结论，置信度高。

### 13.1 致命阻断（2 个）

#### 致命阻断 A：`executeAndAwait` 根本不消费 worktree——§12 改动 1A 是空操作

**§12 的假设**：改动 1A 说"ExecuteOptions 已有 fork/worktree 字段，SubagentService 已完整消费，零改动复用 worktree 全套逻辑"。

**源码事实（证伪）**：`SubagentService` 有两个入口，worktree 创建逻辑只在其中一个：
- `execute()`（subagent-tool 路径，`:419-458`）——**有**完整 worktree 创建（MF#7 守卫 `worktree===true && !fork` 抛错 + `worktreeManager.create(this.cwd, record.id)`）
- `executeAndAwait()`（workflow 路径，`:505-554`）——**完全没有** worktree 创建逻辑

workflow 的 `agent()` 经 `SubprocessAgentRunner.run`（`subprocess-agent-runner.ts:108`）委托的是 `executeAndAwait`。`runAndFinalize`（`:668-671`）只处理 `typeof opts.worktree === "object"`（预创建 WorktreeHandle），**当 `worktree === true`（boolean）时分支不命中，worktreeHandle 保持 undefined → spawnCwd 落回 ctx.cwd → 零隔离**。

**后果**：按 §12 改完那 3 处后，`agent({worktree:true})` 在 workflow 里**静默 no-op**——不创建 worktree、不报错、不隔离。§11 阻断 1 实际未被解除。

**修正改动范围**（不止 3 处）：

| # | 文件 | 改动 | §12 是否提到 |
|---|------|------|-------------|
| 1 | `types.ts` AgentCallOpts | 加 fork/worktree 字段 | ✅ |
| 2 | `execute-options-mapper.ts` | 透传 fork/worktree | ✅ |
| 3 | `worker-script-builder.ts` _knownFields | 放行 | ✅ |
| **4** | **`subagent-service.ts` runAndFinalize（:667-671）** | **加 `else if (opts.worktree === true) { worktreeHandle = this.worktreeManager.create(...) }` 分支** | ❌ **遗漏** |
| **5** | **`subagent-service.ts` executeAndAwait** | **补 MF#7 守卫（worktree===true && !fork 抛错），或确保 fork 被正确设置** | ❌ **遗漏** |

**解法**：把 `execute()` 里的 worktree 创建块（:440-458）抽成共享方法供 `executeAndAwait` 也调；或在 `runAndFinalize` 的 worktree 解析处补 `worktree===true` 分支。

#### 致命阻断 B：wave 的 9 个 agent 无法共享 worktree——决策 A 与 worktree 隔离根本冲突

**§12 的假设**：决策 A（每 action 一个 agent）+ 每个 wave action 的 agent() 用 `worktree:true` 隔离。

**源码事实（证伪）**：`worktree-manager.create`（`:51-124`）**每次调用都建新 worktree**（`git worktree add HEAD`，branch 名 `pi-sub-${recordId}` 唯一），无"按 key 复用"机制。`ExecuteOptions.worktree` 支持 `WorktreeHandle`（对象，复用外部已创建的），但：
- `WorktreeHandle` 是主线程的不可序列化对象
- worker 线程的 `agent()` 只发消息（postMessage），无法把 handle 对象传给后续 agent()

**后果**：wave 的 9 个 action = 9 个 agent()。若每个都 `worktree:true`，则 9 个独立 worktree：
```
execute agent → worktree-A（写代码 + commit 到本地分支 pi-sub-xxx）
test agent    → worktree-B（从 HEAD 新建，看不到 execute 的 commit）→ npm test 找不到代码 → gate fail
```
test gate 系统性失败。这是 §12 决策 A（每 action 一个 agent）与 worktree 隔离粒度的根本冲突。

**解法**：worktree 生命周期绑 wave（不是 action）。
- 同 wave 的 9 个 agent() 复用同一 worktree path（第一个 action 的 agent() 用 `worktree:true` 建 worktree 拿到路径，后续 action 的 agent() 不传 `worktree` 但传 `cwd: <那个 worktree 路径>`）
- 但这要求 worker 脚本能拿到 worktree 路径——而路径在主线程生成（tmpdir 下），worker 拿不到（跨线程）。**需要新增跨线程协议**：workflow 脚本用"worktree group key"（字符串，如 wave unitId），主线程按 key 复用/创建。第一个 agent() 返回 worktree 路径，后续 agent() 用该路径做 cwd。
- closeout 后销毁 worktree（引用计数或显式 cleanup）

### 13.2 高危阻断（2 个）

#### 高危阻断 C：cw execute 返回值不含全部子 unit id——schema 派发投影无法填全

**§12 的假设**：§12.3 说"agent 调 cw execute 后 cw 按 plan.split 建子层 unit，agent 返回的 schema 含子 unitId"。

**源码事实（证伪）**：`ActionResult`（`handlers/types.ts:87-111`）**没有 `executeResult`/`childUnitIds` 字段**。cw execute 的 JSON 只返回 `nextAction.crossLayer.targetUnitId`（第一个 child，`slice/execute.ts`、`feature/execute.ts` 都只取 `childUnitIds[0]`）。

agent 无法从 cw execute 的返回值拿到全部子 unit id。要填全 schema children（含全部子 unitId + prompt），agent 必须**额外调 `cw tree`**。

**解法**（二选一）：
- (a) cw execute 的 ActionResult 加 `childUnitIds: string[]` 字段（改 cw，小改动）
- (b) agent prompt 契约里强制 execute 后调 `cw tree` 收集子 id 填 schema（不改 cw，但要写进 agent prompt 约定）

#### 高危阻断 D：sessionFile 传递通道断裂——retrospect 读 jsonl 不可行

**§12 的假设**：改动 3C 说"workflow 脚本在每次 agent() 返回后记录 `result.sessionFile`"。

**源码事实（证伪）**：`worker-script-builder.ts:144`：`pending.resolve(msg.result.parsedOutput ?? msg.result.content)`——agent() 只 resolve 业务字段（parsedOutput/content），**丢弃了 AgentResult.sessionFile/sessionId 等所有元数据**。

`AgentResult.sessionFile` 字段确实存在（`types.ts:196`，`agent-result-mapper.ts:39` 透传），但**被 worker 消息层丢弃**，workflow 脚本拿不到。

**后果**：retrospect 读 jsonl 方案当前不可行。retrospect agent 退化为抄 cw 状态（§11.2 高估 1 的伪校验复活）。

**解法**（三选一）：
- (a) worker-script-builder 的 agent() resolve 改为返回完整对象 `{parsedOutput, content, sessionFile, sessionId}`——破坏所有现有 workflow 脚本（它们期望 agent() 直接返回值）
- (b) 新增 `agent({returnMeta:true})` 模式，设了返回 `{value, sessionFile}`，不设返回单值（向后兼容）
- (c) 放弃 sessionFile 路径，retrospect agent 自己用 `cw` 查询子 wave 的 record（subagents session 目录可按 recordId 定位）。更符合"cw 是 SSOT"不变式，但 retrospect agent 要自己找 session 文件。

### 13.3 走查暴露的其他问题（4 个）

| # | 问题 | 证据 | 严重度 |
|---|------|------|--------|
| E | **handoff 不渲染 FeatureSpec（FR/AC）**——design-review agent 填 `frAcCoverageNote` 时看不到 FR/AC，被迫编造 | `render.ts:840-899` renderDecisionsSection 只渲染 clarifications.resolution，丢弃 spec 容器；`render.ts:999-1085` renderArtifactsSection planning 分支只渲染 split/techChoices/interfaces | 高 |
| F | **design-review schema 不注入 layerSpecific 字段名**——agent 不知道该填哪些 key，靠 gate fail 试错 | `feature-internal.ts:75` 注入基类 DesignReviewJudgment（layerSpecific:Record<string,string>），不注入 FeatureDesignReviewLayerSpecific；gate 里 key 名写死（`design-review.ts:699-714`）| 中 |
| G | **dependsOn 不驱动执行**——BFS 伪代码纯顺序处理，无拓扑排序。当前偶然安全（schema children 顺序=split 顺序），parallel 后必然错乱 | §12.4 BFS 伪代码无拓扑逻辑；cw 的 dependsOn 只用于判环（`design-review.ts:399`）| 中 |
| H | **npm install 经 symlink 污染主 repo node_modules**——worktree 的 node_modules 是主 repo 的 symlink，wave agent 在 worktree 里 npm install 实际改主 repo | `worktree-manager.ts:80-97` symlink 逻辑 | 中 |

### 13.4 §12 假设被证伪的完整清单

| §12 假设 | 源码事实 | 涉及阻断 |
|---------|---------|---------|
| "ExecuteOptions 有字段 = SubagentService 会消费" | `executeAndAwait`（workflow 入口）不消费 `worktree===true` | 致命 A |
| "worktree:true 能隔离 wave" | 每 action 新建 worktree，同 wave 9 步互不可见 | 致命 B |
| "agent() 返回 sessionFile" | 消息层（:144）丢弃 sessionFile，只透传 parsedOutput/content | 高危 D |
| "cw execute 返回全部子 unit id" | ActionResult 无 childUnitIds，只有 crossLayer 第一个 | 高危 C |
| "handoff 暴露前序 action 产出" | 不渲染 FeatureSpec（FR/AC），layerSpecific 字段名不注入 | E、F |

### 13.5 修正后的实现路径（在 §12.4 基础上补强）

基于第二轮审查，阶段一（打通 worktree）的改动范围修正为：

**改动 1A（修正版）：给 agent() 加 worktree 支持（5 处，非 3 处）**

在 §12.4 改动 1A 基础上补：
- 改动 4：`subagent-service.ts` `runAndFinalize` 加 `else if (opts.worktree === true) { worktreeHandle = this.worktreeManager.create(...) }` 分支
- 改动 5：`subagent-service.ts` `executeAndAwait` 补 MF#7 守卫
- **前置验证**：实现后必须实测 `agent({worktree:true})` 在 workflow 里是否真的 spawn 到独立 worktree（检查 spawnCwd），否则阶段一里程碑必然失败

**改动 1B（补充）：wave 内 worktree 复用机制**

- worktree 生命周期绑 wave（不是 action）。同 wave 的 9 个 agent() 复用同一 worktree
- 需新增跨线程协议：workflow 脚本用"worktree group key"（如 wave unitId），主线程按 key 复用/创建。第一个 agent() 返回 worktree 路径，后续 agent() 用该路径做 cwd
- 或简化：wave 的第一个 action（clarify）用 `worktree:true` 建 worktree，agent prompt 要求它在返回 schema 时附上 worktree 路径字段；workflow 脚本把该路径作为后续 8 个 action 的 `cwd` 传入

**改动 1C（补充）：cw execute 返回 childUnitIds（高危阻断 C 解法）**

- cw 的 `ActionResult` 加 `childUnitIds?: string[]` 字段（`handlers/types.ts`）
- 各 execute handler 填入 `unit.executeResult.childUnitIds`
- 或不改 cw，agent prompt 强制 execute 后调 `cw tree` 收集子 id

**改动 1D（补充）：sessionFile 传递通道（高危阻断 D 解法）**

- 推荐 (b) `agent({returnMeta:true})` 模式：设了返回 `{value, sessionFile}`，不设返回单值（向后兼容）
- 或 (c) 放弃 sessionFile 路径，retrospect agent 自己查 cw 拿子 wave 的 record 定位 session 文件

**改动 1E（补充）：handoff 渲染 FeatureSpec + layerSpecific 字段名（问题 E/F 解法）**

- `render.ts` renderDecisionsSection 或新增段渲染 FeatureSpec 的 FR/AC（至少 id+title）
- 各层 `get{Scope}SchemaText("design-review")` 改为注入该层 LayerSpecific interface（feature→FeatureDesignReviewLayerSpecific）

### 13.6 对 §12.2 决策 A 的修正建议

决策 A（每 action 一个 agent）本身有价值（gate 闭环、review 客观性），但与 worktree 隔离粒度冲突（致命阻断 B）。修正方向：

- **planning 层（epic/feature/slice）**：每 action 一个 agent，共享主 cwd（不 worktree 隔离——planning 不写代码）。✅ 无冲突。
- **wave 层**：worktree 隔离粒度绑 wave。同 wave 的 9 个 action 不是"9 个独立 agent 在 9 个 worktree"，而是"9 个 agent 复用同一 wave worktree"。agent 粒度仍是每 action 一个（保留 gate 闭环），但 worktree 生命周期绑 wave（第一个 action 建、closeout 后销毁、中间复用）。

这不改变决策 A 的"每 action 一个 agent"语义，只改变 worktree 的绑定对象（从 action 提升到 wave）。
