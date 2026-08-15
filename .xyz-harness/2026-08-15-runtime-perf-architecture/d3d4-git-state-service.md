# D3+D4：Git 统一状态服务（异步执行 + 缓存 + 失效）

> **一句话结论**：git 子进程调用散在 4 个模块、各维护各的缓存/失效，其中两条热路径用**同步** `execSync`/`execFileSync` 阻塞 runtime 事件循环——`file-change-reconciler` 在 turn 开始、每个写工具结束、turn 结束时都同步跑 `git status`，`git-service.getStatus` 每请求串行 3 个同步子进程。定案：抽 **GitStateService**（port + 实现）统一 git 执行：异步 `execFile`、in-flight 去重、TTL 缓存、写操作失效钩子；file_changes 的 baseline 改用 promise 时序保证「首个写工具 diff 前就绪」。

**当前层 → 下一层**：技术方案设计（下一层产物 = 可实现的接口/数据模型/时序契约）。涉及运行时行为与数据流，准则 5/6/7 全适用。

---

## §1 背景目标

### SCQA

- **情境**：runtime 是单进程 Node 服务，事件循环被阻塞则所有 session 的消息处理全部停顿。git 是 runtime 的「事实来源」（ADR-0024：file_changes 变更集、git 状态面板、session 摘要的 branch/worktree 标记都来自 git CLI）。
- **冲突**：4 处 git 调用点中，两条高频路径用同步子进程：`file-change-reconciler` 的 `execSync('git status')` 在 turn-start + 每个 write/edit/bash 工具结束 + agent_end 都被触发；`git-service.getStatus` 每次请求串行 `execFileSync` 3 个命令（status → numstat → branch）。实测小仓库单次 status ~30ms——但这是**阻塞事件循环**的 30ms，streaming 期间的后续 token 全部排队等待；大仓库可达数百 ms~秒级。
- **问题**：**同步 git 子进程在事件流热路径上**。turn 内 K 个写工具 = K+2 次同步阻塞（1 baseline + K accumulating + 1 ready）；`git.status` 无缓存、多 panel 同 cwd 重复跑 3 个命令。
- **答案**：统一为异步 GitStateService，把同步阻塞移出事件循环；缓存 + in-flight 去重消除重复 spawn；用 baseline promise 保住 file_changes 帧序契约。

### 系统是什么（最小背景）

| 概念 | 说明 |
|---|---|
| file_changes | ADR-0024 定义的变更集通道：runtime 在 turn 内把 pi 改动的文件清单推给前端（`message.file_changes`）。生产实现 `isFullSet` 恒 true——每次推全量 baseline-diff 结果，前端全集替换。 |
| baseline | turn 开始时的 git status 快照（`FileChangeSnapshot = Map<filePath, status>`）。turn 内每次 diff 都是「当前 status vs baseline」。
| 4 个调用点 | ① `git-service.getStatus`（前端 git.status RPC：status/numstat/branch 三命令，无缓存）② `file-change-reconciler`（turn 内 diff，execSync，无缓存）③ `git-info-reader`（session 摘要 branch 标记，5min TTL 缓存）④ `workspace-detector`（worktree UI 操作才 spawn git，摘要链路走纯 fs） |

### 设计目标

1. **事件循环零阻塞**：streaming 期间不再有同步 git 子进程卡住 token 流。
2. **重复执行消除**：同 cwd 并发请求共享一次执行（in-flight 去重）；结果按需 TTL 缓存。
3. **帧序契约保持**：`message.file_changes` 的 accumulating → tool_call_end → ready 顺序与「baseline 在首个写工具 diff 前就绪」约束不变，误报不增加。
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
| 小仓库实测（本 worktree，4568 tracked 文件） | `git status --porcelain -z -b --untracked-files=all` ≈ 30ms；`git diff --numstat HEAD` ≈ 10ms；`git branch --list` ≈ 5-10ms；getStatus 串行合计 ≈ 45ms（每次请求阻塞事件循环 45ms） |
| 大仓库推断 | status（--untracked-files=all 需扫全工作树）是主要开销，可达数百 ms~秒级 |
| 调用频率 | ② file-change-reconciler：turn-start 1 次 + 每个写工具结束 1 次 + agent_end 1 次（每回合 O(工具数) 次）；① getStatus：每 session 进入 1 次 + 每回合结束 1 次 + 每次 git 写操作后 1 次 |
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
  ├─ tool_call_end(write) ──→ [同步 git status + numstat] ──→ file_changes(accumulating)
  └─ agent_end ──→ [同步 git status + numstat] ──→ file_changes(ready)

前端 git.status RPC ──→ [execFileSync status → numstat → branch 串行] ──→ reply（45ms 阻塞）
```

---

## §3 解决方案

### 3.1 终态（使用者视角先行）

**streaming 场景**：turn 开始后，runtime 在后台异步采集 git baseline；期间 token 流不受任何影响。每个写工具结束时，diff 计算 await「baseline promise」——若 baseline 已完成则正常 diff 推帧，若尚未完成则跳过本次 accumulating（ready 帧会推全量兜底）。agent_end 时推 ready 全集。用户看到：token 连续输出，变更集卡照常在工具后更新，无卡顿。

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
- 选择：`child_process.execFile`（异步）替代 `execSync`/`execFileSync`；保留数组参数形式（`infra/git-executor.ts` 现有防注入约束）；超时沿用现有值（status 8000ms / diff 5000ms）。
- 证据：`execFileSync` 虽在 async 方法内，仍同步阻塞事件循环（探明事实 2.2）；异步化后超时语义不变（kill 子进程 + reject）。

**D3-2：baseline promise 时序（file_changes 异步化的核心设计）**。
- 设计：`EventInterpreter` 的 `statusBaseline` 从「同步快照值」改为「`Promise<StatusSnapshot> | null`」。turn-start 时立即发起异步采集（不 await）；写工具结束时 `await this.statusBaseline`（超时/失败 → null → 按现状「跳过或全集」语义处理）；ready 帧同样 await。
- 边界决策：**await 不阻塞 token 流**——turn-start 与写工具结束之间隔着模型思考 + 工具执行（秒级），baseline 在这期间完成；即使极端情况未完成，await 挂起的是 interpreter 的该条处理链，pi 的后续事件仍在（interpreter 的 `handle` 对 tool-call-end 是 `void this.handleToolCallEnd(ev)` 异步路径，不阻塞 `translate` 循环）。实施时以真实场景验证（V1）。
- 被否：同步等待（回到现状）；不等待（方案 C 的误报问题）。
- 运行时断言（⛔实施期门）：「首个写工具结束前 baseline 必已就绪」在小仓库（~30ms）恒成立；大仓库需实测（baseline 采集耗时 vs turn-start 到首个写工具结束的间隔），若实测不成立，fallback 为「跳过 accumulating 帧，仅 ready 推全集」——该 fallback 在 §3.1 终态已声明为可接受行为。

**D4-1：服务接口（port 先行）**。
```
interface IGitStateService {
  // 状态快照（file_changes 用）：cwd → { filePath: 'A'|'M'|'D' } | null（非仓库）
  snapshotStatus(cwd: string, opts?: { force?: boolean }): Promise<StatusSnapshot>
  // 前端 git.status 面板用：一次调用内并发执行 status + numstat + branch，聚合返回
  getStatus(sessionId: string): Promise<GitStatusResult>      // 保留既有返回形状
  // 写操作后失效（stage/commit/checkout/branch/create 等调用方主动触发）
  invalidate(cwd: string): void
}
```
- 选择：两个方法对应两条热路径（② snapshotStatus、① getStatus 聚合），各自独立的缓存策略（见 D4-3）；`invalidate` 是写操作失效钩子的唯一入口。
- 证据：现有 `IFileChangeDiff` port（`services/ports/file-change-diff.ts`）与 `IGitExecutor` port 已有雏形，本服务在其上收敛而非新增第三套抽象。

**D4-2：in-flight 去重**。
- 选择：`Map<cwd, Promise>` 级别的单飞去重——同 cwd 并发请求共享同一个执行 Promise；结果自然被各自 await。
- 被否：只做 TTL 缓存不做单飞——并发窗口（同 cwd 两个 panel 同时刷新）仍会重复 spawn，而单飞是几行代码的确定性收益。
- 证据：探明事实「两个 panel 同一仓库会重复跑同样的命令」。

**D4-3：缓存分层（不同调用方不同新鲜度要求）**。
- `snapshotStatus`（turn 内 diff）：**不缓存**（每次 diff 需要当前真实状态，缓存会导致变更漏报），只做单飞去重。单飞窗口 = 单次调用生命周期。
- `getStatus`（前端面板）：**短 TTL 缓存（如 2s）**——面板刷新频率下 2s 内的重复请求直接命中；git 写操作路径（stage/unstage/commit/checkout/branch）调用 `invalidate(cwd)` 主动失效，保证写后即时。
- 「非仓库」判定：cwd 级负缓存（TTL 较长，如 60s），避免非仓库场景每次 turn 都 spawn git 探测失败——这是对「每次工具结束都重跑 git」的最大节省（非仓库用户完全跳过）。
- 证据：探明事实——「非 git 仓库」场景当前每次工具结束都重跑 `git status` 探测失败；`git-info-reader` 的 5min TTL 缓存是现成的分层参考实现。

**D4-4：分两步收编**。
- 第一步（本设计主体）：统一 ① `git-service` + ② `file-change-reconciler` 两条热路径。
- 第二步（后置）：③ `git-info-reader` / ④ `workspace-detector` 的缓存并入（低频，各自 TTL 缓存已工作正常，并入收益小）。
- 证据：探明事实——③④ 已带 5min TTL 缓存且低频，不阻塞热路径。

**D4-5：file-change-reconciler 的 diff 纯函数保持不变**。
- 选择：`diffSnapshots`/`computeLineCounts` 保持纯函数（现有测试覆盖），只把「采集」动作（snapshotGitStatus 的 execSync 部分）换成注入的 `IGitStateService.snapshotStatus`。
- 证据：ADR-0027 的三层 port 范式；解析逻辑（parseGitStatusPorcelain 等）已有测试。

---

## §4 验收（真实场景）

| # | 场景 | 步骤 | 通过标准 | 回溯目标 |
|---|---|---|---|---|
| V1 | 本仓库（小仓库）真实会话：让 agent 连续改 3 个文件 + 跑 1 条命令 | 观察 streaming 与变更集卡 | token 输出无卡顿；变更集卡在工具后正常出现且**文件清单准确**（只含本 turn 改动，无 turn 前 dirty 误报）；ready 帧在回合结束出现 | 目标 1、3 |
| V2 | 事件循环阻塞验证 | streaming 期间用探针记录 runtime 主线程阻塞时长（改造前后对比，或 `process.hrtime` 打点） | 改造后 streaming 期间无 >10ms 的同步阻塞（改造前每次写工具结束 ~30ms 阻塞） | 目标 1 |
| V3 | 打开一个 session 的 git 面板，连续快速切换两个 panel（同 cwd） | 观察 git.status 响应与子进程数 | 第二次请求命中缓存（响应即时）；并发切换时只 spawn 一次 git（单飞生效，可用 `ps` 或日志验证） | 目标 2 |
| V4 | git 面板中 stage 一个文件 | 观察面板状态 | stage 后刷新立即显示新状态（invalidate 生效，无 2s 延迟） | 目标 4 |
| V5 | 在一个非 git 目录开 session 跑 agent turn | 观察 runtime 是否重复 spawn git | 首个 turn 判定非仓库后，后续 turn 零 git spawn（负缓存生效） | 目标 2 |

---

## §5 下一层拆分

实施路径：两阶段（先建服务收编 getStatus，再动 file_changes 时序），每阶段独立可验收：

| # | 拆分单元 | justification | 文件改动地图 |
|---|---|---|---|
| U1 | GitStateService port + 实现（异步 execFile + 单飞 + 分层缓存 + invalidate） | 基础设施先行，独立可测 | 新增 `services/git/`（或 `infra/git/`）模块；`git-executor.ts` 改造为异步实现 |
| U2 | `git-service.getStatus` 收编 + 写操作路径挂 invalidate | 第一条热路径替换，行为不变 | `git-service.ts`（改用服务）；git-message-handler 相关写操作调用点补 invalidate |
| U3 | `file-change-reconciler` 采集异步化 + baseline promise 时序 | 第二条热路径 + 核心时序改造 | `file-change-reconciler.ts`（采集注入）、`file-change-diff-adapter.ts`、`event-interpreter.ts`（turn-start/tool-call-end/turn-end 三处） |
| U4 | 负缓存（非仓库记忆） | 非仓库用户的最大节省 | GitStateService 内部 |
| U5 | （第二步，后置）收编 git-info-reader / workspace-detector | 低频点统一，收益小可延后 | 两个模块的缓存改为委托服务 |

**待验证检查点**：
- 大仓库下「baseline 在首个写工具结束前完成」是否恒成立（D3-2 的实施期门；不成立则启用「跳过 accumulating 仅推 ready」fallback）。
- `event-interpreter` 的 tool-call-end 异步链与 ready 帧的并发关系：await baseline 后是否可能出现 accumulating 帧晚于 tool_call_end 到达（现设计 accumulating 先于 tool_call_end 推送，异步化后需确认顺序——若顺序被打破，评估前端是否依赖该顺序，探明显示前端按 messageId 全量替换、对相邻帧顺序不敏感，实施时以 V1 验证）。
