# D3+D4：Git 统一状态服务（异步执行 + 缓存 + 失效）

> **一句话结论**：git 子进程调用散在 4 个模块、各维护各的缓存/失效，其中两条热路径用**同步** `execSync`/`execFileSync` 阻塞 runtime 事件循环——`file-change-reconciler` 在 turn 开始、每个写工具结束、turn 结束时都同步跑 `git status` + `git diff --numstat`（**两者都是 execSync，后者常被误判为纯函数**），`git-service.getStatus` 每请求串行 3 个同步子进程。定案：抽 **GitStateService**（port + 实现）统一 git 执行：异步 `execFile`、in-flight 去重、TTL 缓存（**键 = sessionId+cwd 组合**）、写操作失效钩子；file_changes 的 baseline 改用 promise 时序保证「首个写工具 diff 前就绪」，并加**帧序不变量**（ready 恒为链尾、迟到 accumulating 丢弃）保住 ADR-0024 全集替换语义。

**当前层 → 下一层**：技术方案设计（下一层产物 = 可实现的接口/数据模型/时序契约）。涉及运行时行为与数据流，准则 5/6/7 全适用。

---

## §1 背景目标

### SCQA

- **情境**：runtime 是单进程 Node 服务，事件循环被阻塞则所有 session 的消息处理全部停顿。git 是 runtime 的「事实来源」（ADR-0024：file_changes 变更集、git 状态面板、session 摘要的 branch/worktree 标记都来自 git CLI）。
- **冲突**：4 处 git 调用点中，两条高频路径用同步子进程：`file-change-reconciler` 的 `execSync('git status')` **与 `computeLineCounts` 内部的 `execSync('git diff --numstat HEAD')`**（file-change-reconciler.ts:92/:168）在 turn-start + 每个 write/edit/bash 工具结束 + agent_end 都被触发；`git-service.getStatus` 每次请求串行 `execFileSync` 3 个命令（status → numstat → branch）。实测小仓库单次 status ~30ms——但这是**阻塞事件循环**的 30ms，streaming 期间的后续 token 全部排队等待；大仓库可达数百 ms~秒级。
- **问题**：**同步 git 子进程在事件流热路径上**。turn 内 K 个写工具 = K+2 次同步阻塞（1 baseline + K accumulating + 1 ready，每次还叠加 numstat 阻塞）；`git.status` 无缓存、多 panel 同 cwd 重复跑 3 个命令。
- **答案**：统一为异步 GitStateService，把 status 与 numstat 的同步阻塞全部移出事件循环；缓存 + in-flight 去重消除重复 spawn；用 baseline promise 保住 file_changes 帧序契约，并加帧序不变量防「迟到 accumulating 覆盖 ready」。

### 系统是什么（最小背景）

| 概念 | 说明 |
|---|---|
| file_changes | ADR-0024 定义的变更集通道：runtime 在 turn 内把 pi 改动的文件清单推给前端（`message.file_changes`）。生产实现 `isFullSet` 恒 true——每次推全量 baseline-diff 结果，前端全集替换。 |
| baseline | turn 开始时的 git status 快照（`FileChangeSnapshot = Map<filePath, status>`）。turn 内每次 diff 都是「当前 status vs baseline」。
| 4 个调用点 | ① `git-service.getStatus`（前端 git.status RPC：status/numstat/branch 三命令，无缓存）② `file-change-reconciler`（turn 内 diff，execSync，无缓存）③ `git-info-reader`（session 摘要 branch 标记，5min TTL 缓存）④ `workspace-detector`（worktree UI 操作才 spawn git，摘要链路走纯 fs） |

### 设计目标

1. **事件循环零阻塞**：streaming 期间不再有同步 git 子进程（status **与 numstat 两者**）卡住 token 流。
2. **重复执行消除**：同 cwd 并发请求共享一次执行（in-flight 去重）；结果按需 TTL 缓存（键不含会话错位语义，见 D4-3）。
3. **帧序契约保持**：`message.file_changes` 的 accumulating → tool_call_end → ready 顺序与「baseline 在首个写工具 diff 前就绪」约束不变；**ready 帧恒为回合最后一帧**（迟到 accumulating 不覆盖 ready），误报不增加。
4. **写操作后即时**：stage/commit/checkout 等 git 写操作后，下一次读取拿到新结果（缓存正确失效）。

### In / Out scope

- **In**：GitStateService 接口与实现、两条热路径（① ②）的收编、baseline promise 时序、缓存与失效钩子、非 git 仓库短路记忆。
- **Out**：③ ④ 两处低频调用点的收编（第二步，可后置）；git 输出解析逻辑重写（沿用现有 parser）；前端 git.status 的调用频率治理（前端侧）。

---

## §2 现状与问题分析

### 2.1 使用者视角的现状

1. **streaming 卡顿**：agent 每结束一个 write/edit/bash 工具，runtime 主线程被 `git status` 同步阻塞几十 ms~数百 ms（大仓库）。此期间 pi 后续的 token 事件、其他 session 的消息、插件消息全部排队。用户看到：工具执行间隙的 token 输出卡顿，多 session 时互相拖累。
2. **git 面板慢**：打开/切回一个 session 时 `git.status` 串行跑 3 个命令；两个 panel 同一仓库会重复跑同样的命令。

### 2.2 探明事实（含实测）

| 事实 | 数据 |
|---|---|
| 小仓库实测（本 worktree，4568 tracked 文件） | `git status --porcelain`（**裸参数，reconciler 实际命令**）≈ 30ms；`git diff --numstat HEAD` ≈ 10ms；`git branch --list` ≈ 5-10ms。getStatus 的 `--porcelain=v1 -z -b --untracked-files=all`（git-service 实际命令）成本高于裸命令，串行三命令合计 ≈ 45ms 且每次请求阻塞事件循环 |
| 口径说明 | 总纲 F7 的「git status 0.35s」为**启动期首扫**（冷缓存 + -uall 全量展开，非本热路径）；本文 30ms 为热路径下 reconciler 裸 `--porcelain`。两口径不冲突：异步化收益按热路径 30ms/次 × (K+2) 计 |
| 大仓库推断 | status（--untracked-files=all 需扫全工作树）是主要开销，可达数百 ms~秒级 |
| 调用频率 | ② file-change-reconciler：turn-start 1 次 + 每个写工具结束 1 次 + agent_end 1 次（每回合 O(工具数) 次，每次 diff 后还同步 numstat）；① getStatus：每 session 进入 1 次 + 每回合结束 1 次 + 每次 git 写操作后 1 次 |
| 缓存现状 | ①② 无缓存；③ 5min TTL + LRU 500；④ 摘要链路零 spawn |
| 失败语义 | ① 非仓库 → notRepoResult 降级；② 失败 → null → 跳过 diff；③ 失败 → undefined 缺省；④ 失败 → not-repo 兜底 |

### 2.3 帧序契约（异步化的核心约束）

探明结论：`event-interpreter.ts` 的时序是——turn-start 同步采 baseline（`:219-221`）→ 每个写工具 tool-call-end 先推 `file_changes(accumulating)` 再推 `tool_call_end`（`:362-381`）→ turn-end 推 `file_changes(ready)`（`:410`）。前端 `changeset.ts` 按 messageId 全量替换（isFullSet 恒 true）。

**关键约束**：baseline 快照必须在**首个写工具结束触发 diff 之前**就绪。当前 execSync 天然满足；异步化后若 baseline 未就绪，`diffSnapshots(null, current)` 会退化为「current 全集」（`file-change-reconciler.ts:131-134`），把 turn 前已有的 dirty 文件误报为本 turn 改动。

### 2.4 物理数据流（现状）

```
pi 事件流（stdio）
  ├─ turn_start ──→ [同步 execSync git status] ──→ baseline（阻塞：后续 delta 排队）
  ├─ text_delta × N ──→ （被 git 阻塞，排队等待）
  ├─ tool_call_end(write) ──→ [同步 git status + execSync numstat] ──→ file_changes(accumulating)
  └─ agent_end ──→ [同步 git status + execSync numstat] ──→ file_changes(ready)

前端 git.status RPC ──→ [execFileSync status → numstat → branch 串行] ──→ reply（45ms 阻塞）
```

---

## §3 解决方案

### 3.1 终态（使用者视角先行）

**streaming 场景**：turn 开始后，runtime 在后台异步采集 git baseline；期间 token 流不受任何影响。每个写工具结束时，diff 计算 await「baseline promise」——若 baseline 已完成则正常 diff 推帧，若尚未完成则跳过本次 accumulating（ready 帧会推全量兜底）。agent_end 时推 ready 全集，**且 ready 恒为该回合最后一帧**（在途 accumulating 先于 ready 完成，迟到的 accumulating 被丢弃）。用户看到：token 连续输出，变更集卡照常在工具后更新，无卡顿、徽章不回退。

**git 面板场景**：打开 session 时 `git.status` 异步执行，结果秒回（缓存命中时零 spawn）；同 cwd 两个 panel 并发请求只跑一次 git；stage/commit 后刷新即时拿到新状态。

**非 git 仓库**：第一次判定「非仓库」后被记住（cwd 级缓存），后续 turn 不再重复 spawn git 探测。

**失败路径 + 恢复指引**：git 不可用/超时 → 与现状同语义（file_changes 跳过 / git 面板降级提示），runtime 不崩溃；缓存不会因失败写入错误值。

### 3.2 多方案对比

| 方案 | 长期架构合理性 | 短期实现成本 | 风险 | 裁决 |
|---|---|---|---|---|
| **A：GitStateService 异步统一（选）**：port + 实现，异步 execFile + in-flight 去重 + TTL 缓存 + 失效钩子；baseline 用 promise 时序 | ✅ 缓存/去重/失效只写一次；事件循环零阻塞；后续任何模块需要 git 只依赖一个入口 | 中：新模块 + 两条热路径改造 + baseline 时序调整 | 中：baseline 异步化的帧序风险（3.3 D3-2 有明确对策） | ✅ |
| B：保持同步 + 4 处各自加缓存 | ❌ 4 套缓存与失效逻辑（各有 TTL/键/失效点差异）；同步阻塞天花板无法突破 | 中 | 低 | ❌ 若用它：§3.1 终态的 streaming 场景仍是「每个写工具结束阻塞几十 ms」，只是少了重复 spawn——治标不治本 |
| C：全异步但不保 baseline 时序（fire-and-forget 乱序推帧） | ⚠️ 破坏 accumulating/ready 契约与 isFullSet 全集替换语义 | 低 | 高：误报 turn 前 dirty 文件（§2.3） | ❌ 若用它：变更集卡会把 turn 前就存在的未提交改动误列为本 turn 改动，用户看到错误的变更列表 |

**推荐 A**。理由：这是「架构优化简化性能优化」的典型——统一服务后缓存/失效各只写一次；异步是唯一能突破同步阻塞的方案；baseline promise 用最小机制（一个 Promise）保住契约，无需重排事件流。

### 3.3 关键决策与权衡

**D3-1：执行模型 = 异步 `execFile`（数组参数、不经 shell）+ 单命令超时**。
- 选择：`child_process.execFile`（异步）替代 `execSync`/`execFileSync`；保留数组参数形式（`infra/git-executor.ts` 现有防注入约束）。
- **超时沿用各调用方现状值（初稿「status 8000 / diff 5000」口径有误，已修正）**：`snapshotStatus` 与 `numstat` 沿用 reconciler 现状 **5000ms**（file-change-reconciler.ts:96/:172 两处皆 5000）；`getStatus` 沿用 `GitExecutor.GIT_TIMEOUT_MS = 8000ms`（git-executor.ts:18）。不存在「status 8000 / diff 5000」的现成组合。
- 证据：`execFileSync` 虽在 async 方法内，仍同步阻塞事件循环（探明事实 2.2）；异步化后超时语义不变（kill 子进程 + reject）。

**D3-2：baseline promise 时序（file_changes 异步化的核心设计）**。

> **[已废弃（plan.md R-09 裁决 + W18 实施定案，2026-08-16）]** 本决策整段不作实施——排查发现 baseline 对 `diffSnapshots` 输出零影响（差集语义早在 dirty 漏报修复时移除，两个分支均输出 current 全集），「baseline promise 门」防御的问题不存在；W18 按 R-09 裁决**直接删除 turn-start 的 baseline 采集**（turn-start 零采集，不引入「异步化且不 await」形态），权威记录见 plan.md R-09 及 `file-change-reconciler.ts:88-92` [HISTORICAL] 注释。**D3-3 帧序三件套保留不动**（它防御的 accumulating/ready 乱序与 baseline 无关）。

- 设计：`EventInterpreter` 的 `statusBaseline` 从「同步快照值」改为「`Promise<StatusSnapshot> | null`」。turn-start 时立即发起异步采集（不 await）；写工具结束时 `await this.statusBaseline`（超时/失败 → null → 按现状「跳过或全集」语义处理）；ready 帧同样 await。
- 边界决策：**await 不阻塞 token 流**——turn-start 与写工具结束之间隔着模型思考 + 工具执行（秒级），baseline 在这期间完成；即使极端情况未完成，await 挂起的是 interpreter 的该条处理链，pi 的后续事件仍在（interpreter 的 `handle` 对 tool-call-end 是 `void this.handleToolCallEnd(ev)` 异步路径，不阻塞 `translate` 循环）。实施时以真实场景验证（V1）。
- 被否：同步等待（回到现状）；不等待（方案 C 的误报问题）。
- 运行时断言（⛔实施期门）：「首个写工具结束前 baseline 必已就绪」在小仓库（~30ms）恒成立；大仓库需实测（baseline 采集耗时 vs turn-start 到首个写工具结束的间隔），若实测不成立，fallback 为「跳过 accumulating 帧，仅 ready 推全集」——该 fallback 在 §3.1 终态已声明为可接受行为。

**D3-3：帧序不变量（异步化的正确性护栏，初稿缺失，本次新增）**。
- 问题：`handleToolCallEnd` 已是 fire-and-forget（`void this.handleToolCallEnd(ev)`，event-interpreter.ts:237），异步化后每个写工具触发的 accumulating 各自独立 `execFile` 完成，与 turn-end 的 ready 帧（`handleTurnEnd` 内，event-interpreter.ts:410）之间**无完成顺序保证**。前端 `changeset.ts:117-123` 是全集替换（isFullSet 恒 true）、`changeSetStatuses` 最后到达者胜且**序敏感**——迟到 accumulating 会把已到 ready 的卡状态写回 `accumulating`（「待审查」→「生成中」徽章回退），并把 turn 前 dirty 误报/漏报本 turn 改动，破坏 ADR-0024。
- 设计（per-session 串行 diff 链 + 回合代际守卫）：
  1. **单飞串行链**：`sendDiffFileChanges` 的 diff 计算入 per-session promise 链（`this.diffChain = this.diffChain.then(compute)`）——同一回合内 accumulating 按触发序串行完成，**ready 恒为链尾**（turn-end 时把 ready 排到链尾，天然晚于所有在途 accumulating）。
  2. **回合代际守卫**：turn-start 时 `turnGen++`；每次 diff 捕获当前 gen，链上执行时 `gen !== this.turnGen → 丢弃`——上一回合残留的迟到 diff 不落新回合。
  3. **turnFinalizing 压制**：turn-end 置 `turnFinalizing = true`，其后再来的 `sendDiffFileChanges('accumulating')` 直接 no-op（同回合迟到的 tool-call-end 处理器不产生新 accumulating）；下一 turn-start 复位。
- 纵深防御（前端）：`changeSetStatuses` 增加单向守卫——status 只允许 accumulating → ready 单向推进，禁止 ready → accumulating 回退；防御未来任何顺序漏洞（不属于本设计文件改动地图，U3 备注联动）。
- 与 `message.complete` 的次序：`handleTurnEnd` 现状是同步 `send(message.complete)`（:396）后调 `sendDiffFileChanges('ready')`（:410）。异步化后 ready 走串行链 fire-and-forget（**禁止 await——await 会阻塞 turn-end 处理链**），complete 仍同步先发，**complete 先于 ready 的次序保持不变**；列为 ⛔ 断言。
- 被否：前端「按 status 字段自行收敛」（如 ready 之后忽略 accumulating）——只修表象，runtime 侧乱序仍在，且把正确性责任推给消费方；runtime 链式串行是 by-construction 的保证。
- 证据：前端 isFullSet 恒 true + 状态机序敏感（changeset.ts:117-123）；handleToolCallEnd 的 fire-and-forget（event-interpreter.ts:237）；handleTurnEnd 同步次序（:396/:410）。

> **[实施定案 2026-08-16，W18 对抗式审查后]**
>
> 1. **turnGen 粒度 = assistant message**（非 agent run）：turn-start 翻译自 assistant `message_start`（event-adapter handleMessageStart，一个 agent run 内工具循环每轮 assistant 消息都 emit），turn-end 翻译自 `agent_end`（run 结束一次）。故一个 run 内 turnGen 递增多次：中间消息段的 accumulating 若被后续 message_start 抢先（turnGen++）即丢弃，文件最终落在**最后一条消息的 ready 卡**上——与 D3-2 的 fallback「跳过 accumulating 仅推 ready」取舍一致（丢增量帧无损，ready 全集兜底）。
> 2. **代际守卫仅作用于 accumulating，ready 恒推**（本条修正上文第 2 条「迟到 diff 不落新回合」的未区分表述）：审查实证竞态——turn N 的 ready 排链尾后（fire-and-forget，等前序链段 + status/numstat spawn，大仓库数百 ms~秒级），pi followUp 续跑（extension triggerTurn 机制）立即开新 turn（message_start → turnGen++）→ ready 链段被 gen 静默丢弃 → 卡片**永久**停在 accumulating（前端无恢复路径：markChangeSetsSuperseded 仅 git.commit 触发、hydrate 不写 changeSetStatus）。定案：ready 链段绕过 gen 守卫仍发出，挂排链时捕获的旧 messageId（前端按 messageId 分区 + 单向守卫幂等）；accumulating 保持代际丢弃（上文 §3.1 授权）。配套纵深防御：前端单向守卫扩展为「ready 不覆盖 partially-reviewed/resolved/superseded」（迟到的 ready 可能晚于用户审查操作到达），ready→ready 幂等重放放行。
> 3. **writeContents 是保护无数据流经路径的机制**：pi 现状 `tool_execution_end` 从不带 writeContent（见 event-adapter handleToolExecutionEnd 注释），writeContents Map 恒空、untracked 行数回退当前不生效（untracked 行数靠 numstat 对已跟踪文件 + untracked 缺行数）。该机制是给「pi 未来透出 writeContent」预留的通路——若 pi 在 tool_execution_end 附带 content，此机制自动激活，无需改动。

**D4-1：服务接口（port 先行）**。
```
interface IGitStateService {
  // 状态快照（file_changes 用）：cwd → 不透明 StatusSnapshot（null = 非仓库）
  snapshotStatus(cwd: string, opts?: { force?: boolean }): Promise<StatusSnapshot>
  // numstat 行数（file_changes 用）：已跟踪文件 add/del 行数 map（异步，替代 reconciler 内 execSync）
  numstat(cwd: string): Promise<Map<string, NumstatEntry> | null>
  // 前端 git.status 面板用：一次调用内并发执行 status + numstat + branch，聚合返回
  getStatus(sessionId: string): Promise<GitStatusResult>      // 保留既有返回形状
  // 写操作后失效（stage/commit/checkout/branch/create/worktree add-remove 等调用方主动触发）
  invalidate(sessionId: string): void                          // 键与缓存键同构，见 D4-3
}
```
- **`StatusSnapshot` 是不透明类型（opaque handle）**：port 定义在 services 层，**不 import infra 类型**——沿用现有 `IFileChangeDiff` port 的先例（file-change-diff.ts:6-8 用 `FileChangeSnapshot = unknown` 封装 infra 的 `Map<string, FileChangeStatus>|null`）。infra 实现与 reconciler 消费端各自持有真实类型，port 接口上以 unknown 传递、组合根注入具体实现。理由：services 不 import infra 是项目层敏感约定（ADR-0027 三层 port 范式），`Map<string,FileChangeStatus>` 直接出现在 port 签名即违约。
  **[勘误（W16 实施裁决，2026-08-16）]** 本段措辞被实施推翻——实际 port 暴露具体类型 `StatusSnapshot = Map<string, FileChangeStatus> | null`（`services/ports/git-state.ts` 类型注释，非 unknown 不透明句柄）。依据：`FileChangeStatus` 来自 `@xyz-agent/shared`（shared/message.ts，非 infra 类型），port 签名出现具体 Map 不违反 ADR-0027「services 不 import infra」；且同 port 的 numstat 返回具体 Map，快照独用 unknown 会造成同一接口风格割裂。裁决记录见 plan.md W16 任务书「注意事项」与 `services/ports/git-state.ts` 的「类型裁决（W16 实施定案）」注释。
- **git 参数逐方法定案（初稿未声明，统一服务可能引入粒度漂移）**：`snapshotStatus` 沿用 reconciler 现状裸 `git status --porcelain`（保持 file_changes 的 untracked 目录折叠语义与现有测试基线不变）；`getStatus` 沿用 `--porcelain=v1 -z -b --untracked-files=all`（AGENTS.md #15 强制 -uall，git-service.ts:106）。两者语义不同是有意的——file_changes 增量集合不需要目录展开；git 面板徽章需要文件级展开。**不做统一参数合并**，各自保住现状语义。
- 选择：两个方法对应两条热路径（② snapshotStatus + numstat、① getStatus 聚合），各自独立的缓存策略（见 D4-3）；`invalidate` 是写操作失效钩子的唯一入口。
- 证据：现有 `IFileChangeDiff` port（`services/ports/file-change-diff.ts`）与 `IGitExecutor` port 已有雏形，本服务在其上收敛而非新增第三套抽象。

**D4-2：in-flight 去重**。
- 选择：`Map<cwd, Promise>` 级别的单飞去重——同 cwd 并发请求共享同一个执行 Promise；结果自然被各自 await。
- 被否：只做 TTL 缓存不做单飞——并发窗口（同 cwd 两个 panel 同时刷新）仍会重复 spawn，而单飞是几行代码的确定性收益。
- 证据：探明事实「两个 panel 同一仓库会重复跑同样的命令」。

**D4-3：缓存分层（不同调用方不同新鲜度要求）**。
- `snapshotStatus`（turn 内 diff）：**不缓存**（每次 diff 需要当前真实状态，缓存会导致变更漏报），只做单飞去重。单飞窗口 = 单次调用生命周期。
- `getStatus`（前端面板）：**短 TTL 缓存（如 2s），缓存键 = `sessionId + cwd` 组合**（初稿按 cwd 单键，存在会话串扰缺陷，已修正）。修正依据：`GitStatusResult` 内嵌 `sessionId`（git-service.ts:145-155），`git-message-handler.ts:46-47` 把 result **原样 reply 回传**，前端按内嵌 sessionId 路由——若两个 session 共享同一 cwd 且按 cwd 键缓存，命中会返回首调方的 sessionId，路由到错 session（跨 session 状态串扰）。键含 sessionId 后：同 cwd 不同 session 各自命中各自结果（去重收益下降，但正确性优先）；`invalidate(sessionId)` 按同构键失效。**被否的替代**：命中分支用调用方 sessionId 重写返回对象——能修路由，但缓存语义隐式携带「改写」，且同 cwd 双 panel 本应共享执行的去重收益仍在，组合键方案更直白。
- 「非仓库」判定：cwd 级负缓存（TTL 较长，如 60s），避免非仓库场景每次 turn 都 spawn git 探测失败——这是对「每次工具结束都重跑 git」的最大节省（非仓库用户完全跳过）。
- 证据：探明事实——「非 git 仓库」场景当前每次工具结束都重跑 `git status` 探测失败；`git-info-reader` 的 5min TTL 缓存是现成的分层参考实现。

**D4-4：分两步收编**。
- 第一步（本设计主体）：统一 ① `git-service` + ② `file-change-reconciler` 两条热路径。
- 第二步（后置）：③ `git-info-reader` / ④ `workspace-detector` 的缓存并入（低频，各自 TTL 缓存已工作正常，并入收益小）。
- 证据：探明事实——③④ 已带 5min TTL 缓存且低频，不阻塞热路径。

**D4-5：reconciler 的 diff 计算纯函数化（初稿把 computeLineCounts 误判为纯函数，已修正）**。
- 事实核实：`computeLineCounts` **不是纯函数**——其内部 `execSync('git diff --numstat HEAD', {timeout:5000})`（file-change-reconciler.ts:168）是阻塞 IO，且 `sendDiffFileChanges` 在每个 accumulating 帧与 ready 帧都调它（event-interpreter.ts:434，仅当 `changes.length>0`）。只异步快照、不异步 numstat，则每次写工具结束仍同步阻塞 ~10ms+（大仓库更多），目标 1「零阻塞」与 V2 实际无法达成。
- 选择：**numstat 采集并入 GitStateService（`numstat(cwd)` 异步方法）**；`computeLineCounts` 改为**真正的纯函数**——签名改为接收注入的 numstat 结果（`computeLineCounts(changes, numstatMap, writeContents?)`），只做行数填充与 untracked 的 writeContents 回退，不再 spawn 任何进程。`diffSnapshots` 维持纯函数不变（现有测试覆盖）；采集动作（status + numstat）全部收进注入的 `IGitStateService`。
- 证据：ADR-0027 的三层 port 范式；解析逻辑（parseGitStatusPorcelain / parseNumstatEntries 等）已有测试；reconciler 现状 5000ms 超时与降级语义（numstat 失败 → 行数靠 writeContents 回退）在异步化后保持不变。

---

## §4 验收（真实场景）

| # | 场景 | 步骤 | 通过标准 | 回溯目标 |
|---|---|---|---|---|
| V1 | 本仓库（小仓库）真实会话：让 agent 连续改 3 个文件 + 跑 1 条命令 | 观察 streaming 与变更集卡 | token 输出无卡顿；变更集卡在工具后正常出现且**文件清单准确**（只含本 turn 改动，无 turn 前 dirty 误报）；ready 帧在回合结束出现 | 目标 1、3 |
| V2 | 事件循环阻塞验证 | streaming 期间用探针记录 runtime 主线程阻塞时长（改造前后对比，或 `process.hrtime` 打点） | 改造后 streaming 期间无 >10ms 的同步阻塞，**含 numstat**（改造前每次写工具结束 ~30ms status + ~10ms numstat 阻塞；探针须覆盖写工具结束时刻） | 目标 1 |
| V3 | 打开一个 session 的 git 面板，连续快速切换两个 panel（同 cwd） | 观察 git.status 响应与子进程数 | 第二次请求命中缓存（响应即时）；并发切换时只 spawn 一次 git（单飞生效，可用 `ps` 或日志验证）；**两个 panel 各自显示自己的 sessionId 路由结果，无串扰** | 目标 2 |
| V4 | git 面板中 stage 一个文件 | 观察面板状态 | stage 后刷新立即显示新状态（invalidate 生效，无 2s 延迟） | 目标 4 |
| V5 | 在一个非 git 目录开 session 跑 agent turn | 观察 runtime 是否重复 spawn git | 首个 turn 判定非仓库后，后续 turn 零 git spawn（负缓存生效） | 目标 2 |

> **[V5 locale 前提（W16 实施定案，2026-08-16）]** 负缓存仅在 stderr 匹配**英文**官方文案 `not a git repository` 时写入（判据 = exitCode 128 且 stderr 正则命中，`git-state-service.ts` `maybeMarkNotRepo`，:317-332 注释与判据）——zh_CN 等本地化环境输出「致命错误：不是 git 仓库」不匹配 → 不写负缓存 → 每 turn 一次探测 spawn，本场景验收在 zh_CN locale 下不成立（属保守取舍：防 wrapper 输出误写、不注入 LC_ALL 强制英文以免 stderr 用户可见出口回归）。验证本场景须以 `LC_ALL=en_US.UTF-8`（或等价英文 locale）环境运行。
| V6 | 连续多写工具回合 + 回合间快速切换：让 agent 在一回合内改多个文件，并在 agent_end 后立即开下一回合 | ws 层打点记录 file_changes 帧的到达序（changeSetStatus 序列）+ 观察变更集卡徽章 | **确定性断言：每回合 ready 帧是该回合最后一帧，ready 之后不再出现该回合的 accumulating 帧**；徽章单向推进无「生成中」回退；下一回合的 accumulating 不串帧 | 目标 3 |

---

## §5 下一层拆分

实施路径：两阶段（先建服务收编 getStatus，再动 file_changes 时序），每阶段独立可验收：

| # | 拆分单元 | justification | 文件改动地图 |
|---|---|---|---|
| U1 | GitStateService port + 实现（异步 execFile + 单飞 + 分层缓存 + invalidate） | 基础设施先行，独立可测 | 新增 `services/git/`（或 `infra/git/`）模块；`git-executor.ts` 改造为异步实现 |
| U2 | `git-service.getStatus` 收编 + 写操作路径挂 invalidate | 第一条热路径替换，行为不变 | `git-service.ts`（改用服务）；git-message-handler 相关写操作调用点补 invalidate（stage/unstage/commit/checkout/branch；**worktree add/remove 若走独立 spawn 不经服务，必须同步挂 invalidate——列入 U2 检查点**） |
| U3 | `file-change-reconciler` 采集异步化（status + numstat）+ 帧序不变量（~~baseline promise~~——R-09 裁决删除 baseline 采集，见 D3-2 废弃标注） | 第二条热路径 + 核心时序改造 | `file-change-reconciler.ts`（采集注入、computeLineCounts 纯函数化）、`file-change-diff-adapter.ts`、`event-interpreter.ts`（turn-start/tool-call-end/turn-end 三处 + diffChain/turnGen/turnFinalizing）；前端 `changeset.ts` 状态单向守卫（纵深防御，备注联动） |
| U4 | 负缓存（非仓库记忆） | 非仓库用户的最大节省 | GitStateService 内部 |
| U5 | （第二步，后置）收编 git-info-reader / workspace-detector | 低频点统一，收益小可延后 | 两个模块的缓存改为委托服务 |

**待验证检查点**：
- 大仓库下「baseline 在首个写工具结束前完成」是否恒成立（D3-2 的实施期门；不成立则启用「跳过 accumulating 仅推 ready」fallback）。
- **帧序门（⛔）**：串行链 + turnGen + turnFinalizing 的等价性——用 V6 的 ws 打点断言「ready 恒为链尾、无跨回合串帧」；`message.complete` 先于 ready 的次序保持（event-interpreter.ts:396 vs :410 现状次序）。
- **numstat 异步化等价性（⛔）**：`computeLineCounts` 纯函数化后行数填充结果与现状一致（现有 reconciler 测试同步更新基线）；numstat 失败时 writeContents 回退语义不变。
- worktree 写操作（worktree add/remove）是否在 U2 前就挂 invalidate（否则 step 1 期间 worktree 操作后 getStatus 面板可能显示 2s 陈旧状态——明确决策：挂 invalidate 或声明接受陈旧）。
