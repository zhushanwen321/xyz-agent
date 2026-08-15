# pi-subagent-workflow：worktree 模式 git 子进程调用全异步化设计

## 1. 背景与目标

worktree 模式下所有 git 子进程调用（创建/清理 worktree、收集 patch、孤儿回收）统一走 `execFileSync`，**每条命令执行期间 pi 主进程事件循环完全阻塞**。表现为：spawn / finalize 一个 worktree subagent 时 TUI 冻结、其他并发 subagent 的 stdout 事件泵停摆、notifier flush 停摆。本文档设计将这些调用全链路异步化，使 worktree 生命周期管理不再阻塞主进程。

**目标**：

1. worktree 模式 spawn / finalize / reaper 期间，pi 主进程事件循环不被 git 子进程调用阻塞（可观测验证）
2. 保持现有全部功能语义不变：spawn 临界区顺序（worktree 必须先于子进程 spawn 完成）、patch 回收、孤儿回收、错误传播格式
3. 明确调用链上每个同步签名调用方的改造方式与新增竞态的处理

**非目标**：

- 不改变 worktree 目录布局（tmpdir + encodeCwd 作用域）、注册表格式、pid 死活判据
- 不优化 git 命令本身的耗时（worktree add 在大 repo 上的秒级 checkout 是 git 固有成本，只能并行化/不阻塞，不能消除）

## 2. 现状与问题分析

结论：`WorktreeManager` 的 5 个公共方法（`create` / `cleanup` / `collectPatch` / `scan` / `registerPid`）中前 4 个内部共 11 处 git 调用全部经 `gitRun`（`execution/worktree-manager.ts:273-287`）走 `execFileSync`，单条超时上限 30s（`GIT_TIMEOUT_MS`，`worktree-manager.ts:37`）；调用方分布在 4 条链路上，其中 2 条链路的调用点处于同步签名的函数内，这是异步化的真正难点。

### 2.1 调用链时序（文字链路）

**链路 A：spawn 临界区**（`subagent-service.ts:616-675` execute，及 `:1119-1207` executeAndAwait）

```
execute(worktree: true)
 ├─ resolveIdentity（async）
 ├─ createRecordForMode + emitPendingRegister          // record 进 store，状态 running
 ├─ worktreeManager.create(cwd, recordId)               // ← 同步，内部 3 个串行 execFileSync
 │   ├─ git status --porcelain     （assertCleanTree，worktree-manager.ts:61→292）
 │   ├─ git rev-parse HEAD         （worktree-manager.ts:63）
 │   ├─ git worktree add -b ...     （worktree-manager.ts:82，大 repo 秒级 checkout）
 │   ├─ registry.add（同步 fs，worktree-registry.ts:84）
 │   └─ symlink node_modules（同步 fs）
 ├─ kickOffBackground → runAndFinalize → runSpawn
 │   ├─ buildEnvBlock（execFileSync git branch，session-runner.ts:499；有 branchCache，
 │   │   仅 cache miss 时阻塞，超时上限 2s）
 │   ├─ spawn(pi 子进程)（session-runner.ts:894，cwd = worktree.path）
 │   └─ onWorktreePid(branch, child.pid)（session-runner.ts:906-908，spawn 返回后同步补 pid）
 └─ return ExecutionHandle
```

顺序约束：**worktree create 必须在 spawn 之前完成**——`runSpawn` 用 `opts.worktree?.path` 作 spawn cwd（`session-runner.ts:797`）。当前由 execute 函数内语句串行天然保证。

**链路 B：finalize**（`finalize-record.ts:67-178` doFinalizeRecord，async 函数内的同步调用）

```
runAndFinalize CAS 抢锁成功（subagent-service.ts:1421）→ doFinalizeRecord
 ├─ Step 0: collectPatch   （同步 2 git：add -A、diff --cached，worktree-manager.ts:183,188）
 ├─ Step 1-2: completeRecord + store.archive（内存操作）
 ├─ Step 3: cleanup        （同步 2 git：worktree remove --force、branch -D，worktree-manager.ts:148,156）
 │           + registry.remove（同步 fs）
 └─ Step 4: writeManifest（已 async，best-effort）
```

顺序约束：collectPatch（Step 0）必须在 cleanup（Step 3）前完成，否则 diff 无从取（D-017 时序，`finalize-record.ts:5-7`）。

**链路 C：cancel / dispose（同步签名调用方，难点所在）**

```
cancel(id): boolean（subagent-service.ts:690）
 └─ cancelBackground(record): boolean（:1501）
     └─ worktreeManager.cleanup（:1536，同步调用）

disposeAllRecords(reason): number（subagent-service.ts:410，同步签名，返回计数）
 ├─ 被 onParentFork（:447）/ onParentNew（:454）/ dispose（:500）调用
 └─ 每个带 worktreeHandle 的 record 同步 cleanup（:433，N 个 record = N×2 条同步 git）
```

**链路 D：orphan reaper**（`index.ts:281` session_start handler）

```
session_start（async handler，index.ts:281）
 ├─ ...（前面已有多个 await：recoverManifestTmpFiles 等）
 └─ wtm.scan()（index.ts:406，同步：load registry + 逐孤儿 2 条 git，
     N 个孤儿 = 2N 条同步 git，串行遍历 worktree-manager.ts:218-228）
```

### 2.2 阻塞量化

| 链路 | 单次同步 git 条数 | 典型耗时 | 极端上限 |
|---|---|---|---|
| spawn（链路 A） | 3 串行 | 小 repo 100-300ms；大 repo worktree add 1-3s+ | 3×30s |
| finalize（链路 B） | 4 串行 | 100-400ms（diff 随改动量增大） | 4×30s |
| cancel（链路 C） | 2 串行 | 50-150ms | 2×30s |
| dispose（链路 C） | 2×N 串行 | N 个 worktree record 数十 ms-秒级 | 2N×30s |
| reaper（链路 D） | 2×N 串行 | 孤儿多时秒级 | 2N×30s |

wave 场景（8 action 并行）多个 worktree subagent 同时 spawn/finalize 时，这些同步调用在主进程单线程上排队串行执行，阻塞时间叠加；期间 TUI 帧冻结、并发 subagent 的 stdout data 事件（`session-runner.ts:1015` 的 stdout pump）无法回调、pending-notifications flush 停摆。

### 2.3 顺带发现的问题

1. **`git status --porcelain` 与 `git rev-parse HEAD` 串行但相互独立**（`worktree-manager.ts:61-63`）：rev-parse 的结果只用于填充 `handle.baseCommit`（供 collectPatch 的 `diff --cached <baseCommit>` 用），`worktree add` 用的是字面量 `HEAD` 而非 baseCommit——两条命令可并行，省一个 RTT。
2. **错误对象属性丢失**：`gitRun` 把 `ExecFileException` 包装成裸 `new Error("git <sub> failed: " + err.message)`（`worktree-manager.ts:281-286`），原对象的 `code`（exit code）/ `stderr` / `killed` 属性丢弃，只剩 message 链。异步化时顺带保留这些属性可增强诊断（如区分「超时被杀」与「git 报错退出」）。
3. **`buildEnvBlock` 的 execFileSync**（`session-runner.ts:499`，git branch，超时 2s）：有 branchCache 按 cwd 缓存，仅每个 cwd 首次 spawn 阻塞。属同类问题但量级小，列为顺带项。

## 3. 解决方案

结论：推荐**方案 A（整链 async 化）**，是长期方案；按两期落地，Phase 1 范围即方案 C（仅 finalize + reaper 异步化），风险最小的部分先行。方案 B（worker_threads 隔离）复杂度高一个量级且收益相同，否决。

### 3.1 方案 A：整链 async 化（gitRun → execFile）【长期方案，推荐】

`gitRun` 改为 `gitRunAsync`（`execFile` + 手写 Promise 包装），`create` / `cleanup` / `collectPatch` / `scan` 公共签名全部改 async，调用链逐点 await。`registerPid` 保持同步（见 3.4）。

**长期合理性**：git 子进程调用本质是 IO，async 是 Node 中它的正确形态；数据/逻辑归位到该在的层（IO 调用方持有 Promise 而非阻塞事件循环）；不引入新执行机制（无 worker、无线程），未来 pi 若迁移到别的进程模型无需推翻。三个月后回看，这就是「本来就该这么写」的代码。

**关键设计点**：

1. **gitRunAsync 的错误包装**。`execFile` reject 出的 `ExecFileException` 与 `execFileSync` throw 的**同构**（message 同为 `"Command failed: <cmd>\n<stderr>"`，`encoding: "utf-8"` 时 `stdout`/`stderr` 为 string，`code` 为 exit code，超时时 `killed: true` + `signal: "SIGTERM"`）。因此：
   - 包装 message 格式保持 `git <subcommand> failed: <原因>` 不变——下游 `DirtyWorktreeError` 判定（`worktree-manager.ts:292-299`）与测试 `toThrow` 匹配零改动
   - 顺带把 `exitCode` / `stderr` 挂到包装错误上（新增属性，非破坏性）
   - 不用 `util.promisify(execFile)`：它对多返回值 resolve 成 `[stdout, stderr]` 数组，调用方要解构且易错。手写 10 行 Promise 包装
2. **create 内部时序重排**：`Promise.all([assertCleanTree(status), rev-parse HEAD])` 并行（脏树校验语义不变，仍先于 `worktree add`）→ 串行 `worktree add` → registry.add / symlink（同步 fs 保留，见 3.4）→ MF#3 回滚路径（`worktree-manager.ts:112-126`）async 化（`await` remove / branch -D，各自 best-effort，原始 err 仍外抛）。
3. **spawn 临界区顺序保证 + 新增竞态守卫**。顺序保证机制不变：execute 是 async 函数，`await create` 之后才 kickOffBackground → runSpawn 读 worktree.path 作 spawn cwd，await 串行天然保证「worktree 先于 spawn」。但 async 化打开了一个新竞态窗口——**create await 期间 event loop yield，cancel / dispose 可以插入**：
   ```
   execute:
     record = createRecordForMode(...)          // record running，已进 store
     worktreeHandle = await wtm.create(...)     // ← yield 点：cancel(id) / disposeAllRecords 可达
     record.worktreeHandle = worktreeHandle     // cancel 时刻此值还是 undefined！
     kickOffBackground(...)
   ```
   若 cancel 在 create 进行中到达：`cancelBackground` 的 `tryTransition` CAS 成功，但其 cleanup 分支（`subagent-service.ts:1534`）读到 `record.worktreeHandle === undefined` 而跳过 → create 返回后 handle 才被赋值 → worktree 泄漏（只能等 reaper 60s 宽限后兜底），且 `runAndFinalize` 会白跑整个子进程（末尾 CAS 失败跳过 finalize，`subagent-service.ts:1421`）。**守卫**：create 返回并赋值 `record.worktreeHandle` 后，立即检查 record 状态是否已被转终态（closed）；是则主动 `await cleanup(worktreeHandle)` + 走 early-failed 返回（execute 返回 `buildEarlyFailedHandle`，executeAndAwait throw 原语义不变），不进 kickOffBackground。dispose 同理由该守卫覆盖。
4. **并发行为变化与 per-repo 串行队列**。`execFileSync` 因单线程天然全局串行；async 化后同一时刻可有多个 git 进程并发（wave 并行 spawn 多个 worktree subagent）。git 对 `.git/config.lock`、refs 锁是 **fail-fast 不是等待**——并发 `worktree add` 同一 repo 会偶发 `Unable to create ... config.lock` 直接失败。处理：在 WorktreeManager 内加 per-repo mutex（`Map<repo, Promise>` 链式串行），把**写类命令**（`worktree add` / `worktree remove` / `branch -D` / `add -A`）按 repo 串行化；读类（`status` / `rev-parse` / `diff`）不加锁。行为从「全局意外串行」收敛为「同 repo 写操作显式串行、跨 repo 与读操作真并发」。
5. **同步签名调用方（链路 C）的处理**：
   - `cancelBackground` / `cancel` 的同步 boolean 返回语义保留（CAS 抢锁结果同步可得，tool 层依赖）：cleanup 改 fire-and-forget（`void this.worktreeManager.cleanup(handle).catch(err => bestEffort(err, ...))`）。安全性：cleanup 只消费冻结的 WorktreeHandle，不依赖 record 后续状态；record 已 archive 不影响清理正确性
   - `disposeAllRecords` / `dispose`：同样 fire-and-forget。dispose 在进程退出路径上本就不等待子进程回收（`killAllSpawnedChildren` 也不 await，`session-runner.ts:226`）；若进程先退，残留 worktree 由下次 session_start 的 reaper 兜底（pid 死活判据，`worktree-manager.ts:233-249`），与现有崩溃恢复语义一致
6. **reaper 触发时机**：session_start handler 本就是 async（`index.ts:281`），内部已有多个 await（如 `index.ts:394`）。`wtm.scan()` 直接改 `await wtm.scan()`，无障碍。scan 内部逐孤儿**串行** await（保持现有 for 循环串行语义，防止一次 reaper 打出 N 个并发 git）。

**短期成本**：WorktreeManager 公共 API 签名全变（4 个方法 async 化），调用点 6 处改造，测试面较大（见 §5）。改动集中、机械，但有 2 处需要仔细设计（竞态守卫、per-repo mutex）。

**风险**：
- 竞态窗口漏防（已识别 cancel/dispose 两处，守卫集中在一个检查点，可单测覆盖）
- git 并发 fail-fast（per-repo mutex 覆盖写类命令；读类无锁可容忍）
- 测试改造引入回归（现有测试契约清晰，mock 层面机械替换）

### 3.2 方案 B：worker_threads 隔离【长期方案，否决】

WorktreeManager 实现不动（继续 execFileSync），整体挪进 worker thread，主线程通过 async 消息接口调用。

- **表面优点**：主线程完全不执行 git 调用；WorktreeManager 内部逻辑零改动
- **否决理由**：
  1. **收益与方案 A 完全相同**（都是主进程不阻塞），但引入一整套新边界：WorktreeHandle 跨线程序列化（可序列化，但错误对象跨线程丢类型——worker 里的 `ExecFileException` postMessage 到主线程退化为 plain object，`instanceof Error` 与属性保真要手工处理）
  2. **worker 生命周期管理**：extension dispose（session_shutdown）时 terminate worker，正在执行的 `worktree add` 被腰斩的善后（半建 worktree 的回滚）比进程内 Promise 取消复杂
  3. **TS 加载环境风险**：pi extension 以 TS 源码直接运行（import 使用 `.ts` 后缀，依赖 Node type stripping），worker 内 import 同源 TS 文件需要 loader flags 正确传播到 worker，pi 的启动环境下未经验证
  4. registry 同步 fs IO 若留在主线程则与 worker 内 git 操作分属两线程，「add 成功后 registry.add」的顺序保证要跨线程消息往返，原子性论证（`worktree-registry.ts:14-18`）被破坏；若 registry 也挪进 worker，主线程其他调用方（registerPid 在 spawn 回调链里同步调）又要跨线程
- 三个月后回看：为「把 execFile 写成 async」这个一行级改动引入的双线程架构，维护成本不成立

### 3.3 方案 C：仅 finalize + reaper 异步化，create 保持同步【短期方案，作为方案 A 的 Phase 1】

只改链路 B（finalize 的 collectPatch/cleanup）与链路 D（reaper scan），create/cleanup 的其余调用点不动。

- **短期收益**：finalize 4 条 + reaper 2N 条同步 git 解除阻塞，改动面小（doFinalizeRecord 已是 async 函数，scan 在 async handler 里，两处纯 await 化，无签名传染），无新竞态
- **为何只能算短期**：spawn 临界区的 3 条同步 git（含最重的 worktree add 秒级 checkout）原样保留——用户感知最强的「spawn 时 TUI 冻结」没有解决。且 WorktreeManager 出现 sync/async 双轨 API（create 同步、cleanup 异步），是过渡态
- **定位**：不作为终点，作为方案 A 的分阶段落地策略——Phase 1 先交付方案 C 范围（立刻消除 finalize/reaper 阻塞，验证 execFile 包装与测试改造），Phase 2 完成 create 异步化 + 竞态守卫 + 并行化 + per-repo mutex，收敛到方案 A 终态

### 3.4 顺带项决策：worktree-registry 同步 IO——不改

**保留同步**。理由：

1. 注册表是单文件小 JSON（<10KB 量级，几十个条目），`readFileSync + writeFileSync + renameSync`（`worktree-registry.ts:131,153-154`）总耗时 <1ms，与 git 子进程（百 ms-秒级）不在一个量级，不构成阻塞源
2. `registerPid` 在 spawn 返回后的同步回调链上被调（`session-runner.ts:906-908` 经 `ctx.onWorktreePid`），改 async 会把回调签名传染进 session-runner；保持同步让 pid 补全保持「spawn 返回即可得」的时序（这是 2026-08-11 reaper 误删事故的修复语义，`session-runner.ts:901-905` 注释）
3. registry 的并发安全论证（「Node 单线程保证 sync read-modify-write 在一个 event loop turn 内原子」）**不受调用方 async 化影响**——同步操作本身原子，与调用链上层是否 await 无关

`buildEnvBlock` 的 execFileSync（`session-runner.ts:499`）：列入 Phase 2 顺带项。改 async 后 `runSpawn`（`session-runner.ts:810` 调用点）加 await；branchCache 命中路径零开销。收益是每个 cwd 首次 spawn 少一次最多 2s 的阻塞（挂载盘上 git 慢时才显著），优先级低。

## 4. 验收

结论：三层验收——单测/集成测试全绿；本地 pi CLI 真实模型实测 worktree subagent 全生命周期，用**并发 subagent 的 session jsonl 时间戳连续性**作为阻塞消除的客观证据；功能回归（patch 回收、worktree/branch/注册表清理干净）。

### 4.1 测试层

- `cd extensions && pnpm extensions:test`（vitest）全绿，重点文件：worktree-manager / execute-and-await-worktree / finalize-record / session-start-reaper / worktree-pid-registration.integration
- `pnpm extensions:typecheck` + `pnpm extensions:lint` 通过

### 4.2 本地 pi CLI 实测（阻塞消除的可观测证据）

环境：dev-link 启用本地源码版 pi-subagent-workflow；测试模型 `xiaomi-token-plan-cn/mimo-v2.5-pro`；repo 用大 working tree 的仓库（如 xyz-agent 主仓，保证 worktree add 秒级、阻塞可观测）。测试框架遵守项目规范：vitest 跑单测，真实场景用 `pi --mode rpc` + stdin JSONL 或 interactive 手动驱动。

**观测方法（核心证据：并发 subagent 的事件时间戳连续性）**：

1. **并发事件流不中断**。主 agent 先 spawn 普通模式 subagent B（task 让其持续产出，如循环 bash 输出，每 0.2s 一条），B 运行中再 spawn worktree 模式 subagent A。A 的 spawn（create 3 git）与 finalize（4 git）窗口必须与 B 的 streaming 重叠。证据：读 B 的 session jsonl（`~/.pi/agent/subagents/<enc>/sessions/`）逐 entry 时间戳，**相邻 entry 间隔无 >500ms 的空洞**横跨 A 的 git 窗口（`PI_EXT_DEBUG=1` 日志可定位 A 的 worktree add 起止）。改造前对照：同一场景 B 的 jsonl 在 A 的 worktree add 期间出现秒级时间戳空洞（stdout pump 停摆的直接证据）
2. **主进程 timer 不停摆**。reaper 场景：预置孤儿条目（kill -9 一个带 worktree 的 pi 主进程，或手动向 worktrees.json 注入 pid 已死条目），启动 pi 触发 session_start reaper，reaper 清理期间（多孤儿时秒级）statusline/其他扩展的周期事件持续更新（TUI 或日志时间戳连续）
3. **TUI 交互响应**。interactive mode 下 A spawn 期间按 ESC / 输入字符即时响应，无冻结感（改造前 worktree add 期间输入无回显）

**功能回归（每项必须通过）**：

1. A 完成后 `record.patchFile` 存在且 `git apply --check` 通过（改动回传不丢）
2. `git worktree list` 与 `git branch` 无 `pi-sub-*` 残留；tmpdir 下 checkout 目录已删
3. `<agentDir>/subagents/worktrees.json` 条目清空（对应 branch）
4. 竞态守卫：在 create 的 git 命令中人为加延迟（临时 mock 或大 repo），延迟窗口内 cancel 该 record → worktree 被守卫主动清理（而非等 reaper 60s），子进程不白跑
5. per-repo mutex：并发 spawn 2+ 个同 repo worktree subagent，全部成功（无 config.lock 冲突报错）
6. 错误形态：脏树 spawn 仍抛 `DirtyWorktreeError` 且 message 格式不变；git 失败时包装错误含 exitCode/stderr 属性

### 4.3 对照基线

改造前先跑一轮 4.2 的场景 1/3 留存基线（jsonl 时间戳空洞、TUI 冻结现象），改造后同场景复跑对比。两者差异即「阻塞消除」的可复查证据。

## 5. 下一层拆分（按文件）

结论：9 个实现任务 + 6 组测试改造，按 Phase 1（T1/T3/T7/T8/T9/T10）→ Phase 2（T2/T4/T5/T6/T11）两期交付。

### 实现任务

| # | 文件 | 任务 | 期 |
|---|---|---|---|
| T1 | `extensions/subagent-workflow/src/execution/worktree-manager.ts` | `gitRun` → `gitRunAsync`：`execFile` 手写 Promise 包装（不用 promisify，规避 multi-args resolve）；message 格式不变；包装错误补挂 `exitCode`/`stderr` 属性。同步引入 per-repo mutex（`Map<repo, Promise>` 链）供写类命令（worktree add/remove、branch -D、add -A）串行 | P1 |
| T2 | 同上 | `create` async 化：`Promise.all([status, rev-parse HEAD])` 并行 → worktree add → symlink/registry（同步 fs 保留）→ MF#3 回滚路径 async 化（`worktree-manager.ts:112-126`） | P2 |
| T3 | 同上 | `cleanup` / `collectPatch` / `scan` / `cleanupOrphan` / `assertCleanTree` async 化（内部逐条 await；scan 保持逐孤儿串行） | P1 |
| T4 | 同上 | 并发守卫单测配套的 per-repo mutex 验证（与 T1 同落地，此处指行为验证收尾） | P2 |
| T5 | `extensions/subagent-workflow/src/execution/subagent-service.ts` | execute 的 worktree 分支（`:652-662`）：`await create` + **终态守卫**（create 返回后发现 record 已 closed → 主动 cleanup + 返回 `buildEarlyFailedHandle`） | P2 |
| T6 | 同上 | executeAndAwait 的 worktree 分支（`:1151-1163`）：同 T5（失败 throw 语义不变） | P2 |
| T7 | 同上 | `cancelBackground`（`:1534-1540`）：cleanup 改 fire-and-forget（`void ...catch(bestEffort)`），boolean 返回语义不变 | P1 |
| T8 | 同上 | `disposeAllRecords`（`:430-437`）：cleanup 改 fire-and-forget | P1 |
| T9 | `extensions/subagent-workflow/src/execution/finalize-record.ts` | Step 0 `collectPatch`（`:88`）与 Step 3 `cleanup`（`:133`）await 化；Step 0→3 顺序与 best-effort 结构不变 | P1 |
| T10 | `extensions/subagent-workflow/src/index.ts` | session_start 内 `wtm.scan()`（`:406`）改 `await`（handler 已 async） | P1 |
| T11 | `extensions/subagent-workflow/src/execution/session-runner.ts` | `buildEnvBlock`（`:483-513`）async 化，`runSpawn` 调用点（`:810`）await；cache 命中路径零开销 | P2（顺带，可独立砍） |

不改：`worktree-registry.ts`（§3.4 决策）；`registerPid` 签名（spawn 同步回调链）。

### 测试改造点

| 文件 | 改造 |
|---|---|
| `execution/__tests__/worktree-manager.test.ts` | `vi.mock("node:child_process")` 的 `execFileSync` → `execFile`（callback 风格 mock：`(cmd, args, opts, cb) => cb(null, "stdout")`，`:16-18`）；全部 create/cleanup/collectPatch/scan 调用 await 化；`expect(() => ...).toThrow` → `await expect(...).rejects.toThrow`。**新增**：终态守卫（cancel-during-create，配合 T5）、per-repo 并发写串行化、包装错误 exitCode/stderr 属性断言 |
| `execution/__tests__/finalize-record.test.ts` | worktreeManager mock 的 collectPatch/cleanup 返回 Promise |
| `execution/__tests__/execute-and-await-worktree.test.ts` | execFileSync mock（`:43`）→ execFile；create mock 返回 Promise；`rejects.toThrow` 断言（`:161-163` 用例） |
| `execution/__tests__/subagent-service.test.ts` | worktreeManager.create mock async 化（`:392-510` 区域的 worktree 分支用例） |
| `execution/__tests__/session-start-reaper.test.ts` / `index-session-start.test.ts` | WorktreeManager mock 的 `scan` 返回 Promise（`:45-48` / `:111-116`）；调用断言不变 |
| `execution/__tests__/worktree-pid-registration.integration.test.ts` | 真实 git 集成用例：`wtm.create` / `wtm.scan` 调用 await 化（`:150-200` 区域），断言不变（该测试是功能回归的主力，Phase 1/2 各跑一轮） |

T11 落地时另需同步改 mock `execFileSync`（buildEnvBlock 用）的测试：`run-spawn-integration.test.ts`、`recursive-visibility-*.test.ts`、`consume-confirmation.test.ts`、`chatmode-round-notify-real-chain.test.ts`。T11 若砍则这些不动。

### 提交策略

Phase 1 一个 commit（T1/T3/T7-T10 + 测试），Phase 2 拆两个 commit（T2/T4/T5/T6 + 竞态守卫测试；T11 顺带项独立）。每期完成后跑 `pnpm extensions:test && pnpm extensions:typecheck && pnpm extensions:lint`，并按 §4.2 实测留证。
