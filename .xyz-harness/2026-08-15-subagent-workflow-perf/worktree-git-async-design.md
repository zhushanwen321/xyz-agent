# pi-subagent-workflow：worktree 模式 git 子进程调用全异步化设计

> **层级声明**：本文档处于**技术方案层 → 实现任务层**——回答「怎么改」并拆到可直接实施的代码任务清单为止，不深入到每个任务的逐行实现。
>
> **受众假设**：会用 subagent-workflow（调 `subagent` tool 派 subagent、跑过 wave 并行编排）但未读过其内部实现的开发者。涉及内部机制处均附最小背景。

**一句话结论**：worktree 生命周期管理全部 git 调用从 `execFileSync` 整链改为 `execFile` 异步化（方案 A），配套 create-await 竞态守卫与 per-repo 写串行队列，按两期落地，使 worktree spawn/finalize/reaper 不再冻结 pi 主进程事件循环。

**SCQA 开篇**：

- **S（情境）**：pi-subagent-workflow 的 worktree 模式为每个 subagent 创建独立 git worktree（隔离 checkout + 独立分支），改动以 patch 回传主 repo；主 agent 常并发派发多个（wave 场景 8 action 并行），而所有 subagent 的子进程 stdout 事件泵、TUI 渲染、notifier 定时器都跑在 pi 主进程唯一的 Node 事件循环上。
- **C（冲突）**：worktree 生命周期管理（创建/清理 worktree、收集 patch、孤儿回收）当前全部走 `execFileSync` 同步等 git 子进程——每条命令执行期间主进程事件循环完全冻结，并发 subagent 流式输出停摆、TUI 按键无响应，且这些调用在 wave 并发下排队串行、阻塞时间叠加。
- **Q（问题）**：怎么让 worktree 生命周期管理不再阻塞主进程，同时保住 spawn 临界区顺序（worktree 必须先于子进程 spawn 完成）、错误传播格式与清理正确性？
- **A（答案）**：方案 A——整链 async 化（`gitRun` → `execFile`），同步签名的调用方改 fire-and-forget，新增 create-await 竞态守卫与 per-repo 写串行队列；两期落地，Phase 1 先交付风险最小的 finalize + reaper 异步化。

## 1. 背景与目标

结论：本设计要达成「并发 subagent 互不阻塞」这一使用者可感知的目标，同时零语义回归；改动范围严格限定在 git 子进程调用形态及其直接竞态面，不触碰目录布局与注册表设计。

**系统是什么**（给未读内部实现的读者）：pi 主进程是单进程单事件循环。派发 subagent 时，`execute(worktree: true)` 会先在 `<tmpdir>/pi-subagents/<enc>/` 下创建一个独立 worktree（`git worktree add -b pi-sub-<recordId>`），再把 subagent 作为 pi 子进程 spawn 进该 worktree 执行；结束后收集改动为 patch、删除 worktree 与分支。这套生命周期由 `WorktreeManager`（`extensions/subagent-workflow/src/execution/worktree-manager.ts`）管理。

**使用者与体验倒推的设计目标**。使用者 = 并发跑 subagent 的用户与父 agent：

1. **（对应用户体验「其他 subagent 不停摆」）** worktree 模式 spawn / finalize / reaper 期间，pi 主进程事件循环不被 git 子进程调用阻塞——同一个 pi 里跑着的其他 subagent 流式输出连续、TUI 按键即时回显（可观测验证，见 §4.2）
2. **（对应父 agent 语义不变）** 保持现有全部功能语义不变：spawn 临界区顺序（worktree 必须先于子进程 spawn 完成）、patch 回收、孤儿回收、错误传播格式——父 agent 与 tool 层看到的成功/失败形态零变化
3. **（对维护者）** 明确调用链上每个同步签名调用方的改造方式与新增竞态的处理，不留隐性双轨 API 终态

**In-scope**：`WorktreeManager` 全部 git 子进程调用的 async 化；4 条调用链（spawn / finalize / cancel-dispose / reaper）上调用方的适配；async 化打开的 create-await 竞态窗口的守卫；并发 git 写命令的串行化。

**Out-of-scope（非目标）**：

- 不改变 worktree 目录布局（tmpdir + encodeCwd 作用域）、注册表格式、pid 死活判据
- 不优化 git 命令本身的耗时（worktree add 在大 repo 上的秒级 checkout 是 git 固有成本，只能并行化/不阻塞，不能消除）
- worktree-registry 的同步 fs IO 不改（决策见 §3.6）

## 2. 现状与问题分析

结论：`WorktreeManager` 的 5 个公共方法（`create` / `cleanup` / `collectPatch` / `scan` / `registerPid`）中前 4 个内部共 11 处 git 调用全部经 `gitRun`（`execution/worktree-manager.ts:273-287`）走 `execFileSync`，单条超时上限 30s（`GIT_TIMEOUT_MS`，`worktree-manager.ts:37`）；调用方分布在 4 条链路上，其中 2 条链路的调用点处于同步签名的函数内，这是异步化的真正难点。

### 2.0 使用者视角：阻塞发生时用户看到什么

真实场景（wave 并行编排的典型体验）：主 agent 在 xyz-agent 主仓上并行派发 8 个 worktree subagent（`subagent` tool `worktree: true`）。用户在 TUI 里观察到的现象：

1. subagent B 正在流式输出分析结论，输出忽然整段卡住数秒——不是模型在思考，而是同一时刻另一个 subagent A 正在 `worktree add`（大 repo 秒级 checkout），B 的 stdout 数据事件在主进程事件循环上排队等不到回调（stdout pump 见 `session-runner.ts:1015`）
2. 用户按 ESC / 敲字符无回显——TUI 的 stdin 处理同样排在冻结的事件循环后面
3. wave 全部 action 结束前的收尾期（多个 finalize 同时跑 `worktree remove` + `branch -D`），上述冻结再次出现

「其他 subagent 停摆」不是推测：主进程是单线程，B 的 stdout `data` 事件、TUI stdin、notifier 的定时器回调**全部依赖同一个事件循环轮转**，而 `execFileSync` 在 git 子进程退出前不归还控制权——这就是根因（不是「git 慢」，而是「同步等 git」）。

> **术语**：**临界区** = 必须顺序保证、不可交叠执行的代码段（本文特指「worktree 创建必须先于子进程 spawn 完成」，因为 spawn 要用 worktree 路径作 cwd）。**CAS 抢锁** = compare-and-swap 式的一次性状态转移（`tryTransition(record, "closed", ...)` 只对 running 态的 record 成功一次），用于防止 cancel 与正常收尾对同一 record 执行两次清理副作用。

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
   │   ├─ buildEnvBlock（execFileSync `rev-parse --abbrev-ref HEAD` 取分支名，session-runner.ts:499；
   │   │   有 branchCache，仅 cache miss 时阻塞，超时上限 2s）
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

**同步 git 执行点在事件循环上的位置**（改造前，一次 wave 并发 spawn 的物理时序；`▓` = 事件循环被 `execFileSync` 占死，事件只能排队）：

```
事件循环 tick ────────────────────────────────────────────────────────▶ 时间
[execute A] ▓ git status ▓ rev-parse ▓ worktree add(1-3s) ▓ │ [execute B] ▓ status ▓ ...
                                                              │
排队等待中的事件（全部延迟到 ▓ 结束才处理）：                     │ spawn C 的 execute 调用
  · subagent B 的 stdout "data" 回调  → B 的流式输出停摆       │
  · TUI stdin 按键回调               → 按键无回显              │
  · notifier/statusline 定时器        → 状态栏冻结              │
  · B 的 finalize 定时器、pending flush → 全部停摆              │
```

关键事实：每个 `▓` 段内主进程**单线程阻塞**，Node 无法切换到任何其他回调；wave 场景（8 action 并行）多个 worktree subagent 同时 spawn/finalize 时，这些同步段在事件循环上排队串行执行，阻塞时间叠加——8 个 spawn 各含 1 条 1-3s 的 `worktree add`，最坏情况下其他事件的延迟以秒×N 计。

### 2.3 顺带发现的问题

1. **`git status --porcelain` 与 `git rev-parse HEAD` 串行但相互独立**（`worktree-manager.ts:61-63`）：rev-parse 的结果只用于填充 `handle.baseCommit`（供 collectPatch 的 `diff --cached <baseCommit>` 用），`worktree add` 用的是字面量 `HEAD` 而非 baseCommit——两条命令可并行，省一个 RTT。
2. **错误对象属性丢失**：`gitRun` 把 `ExecFileException` 包装成裸 `new Error("git <sub> failed: " + err.message)`（`worktree-manager.ts:281-286`），原对象的 `code`（exit code）/ `stderr` / `killed` 属性丢弃，只剩 message 链。异步化时顺带保留这些属性可增强诊断（如区分「超时被杀」与「git 报错退出」）。
3. **`buildEnvBlock` 的 execFileSync**（`session-runner.ts:499`，`rev-parse --abbrev-ref HEAD` 取分支名，超时 2s）：有 branchCache 按 cwd 缓存，仅每个 cwd 首次 spawn 阻塞。属同类问题但量级小，列为顺带项。

## 3. 解决方案

结论：推荐**方案 A（整链 async 化）**，是长期方案；按两期落地，Phase 1 范围即方案 C（仅 finalize + reaper 异步化），风险最小的部分先行。方案 B（worker_threads 隔离）复杂度高一个量级且收益相同，否决。

### 3.1 终态（使用者视角先行）

改造完成后，重放 §2.0 的 wave 场景（8 个 worktree subagent 并行派发），使用者可观测到的变化：

1. **subagent B 流式输出连续**：A 的 `worktree add` 进行中（PI_EXT_DEBUG=1 日志可见其起止），B 的输出持续逐条到达——B 的 session jsonl 相邻 entry 时间戳无秒级空洞（验收判据见 §4.2 场景 1）
2. **TUI 即时响应**：A spawn / finalize 期间按 ESC、输入字符立即回显，无冻结感
3. **失败路径语义不变（父 agent 视角）**：脏树 spawn 仍抛 `DirtyWorktreeError` 且 message 格式不变，`worktree: true` + 脏工作区时父 agent 收到的错误与改造前逐字一致（tool 层零改动）。若 git 真失败（非脏树），错误 message 前缀 `git <subcommand> failed:` 不变，新增 `exitCode`/`stderr` 属性供诊断——恢复指引：按 message 内 stderr 内容修 git 侧问题（如分支残留）后重试 spawn；worktree 若残留，由下次 session_start 的 reaper 60s 宽限后自动回收，或手动 `git worktree list` 定位后 `git worktree remove --force <path>`
4. **cancel 不再冻结界面**：用户 cancel 一个 worktree subagent（2 条 git）时 TUI 与其他 subagent 不停摆；worktree 清理异步完成，`git worktree list` 稍后无 `pi-sub-*` 残留

### 3.2 方案对比总表

| 方案 | 长期架构合理性 | 短期实现成本 | 风险 | 裁决 |
|---|---|---|---|---|
| **A 整链 async 化**（`gitRun` → `execFile`，调用链逐点 await） | 高：git 子进程本质是 IO，async 是 Node 中的正确形态；不引入新执行机制 | 中：4 个公共 API 签名改 async、6 处调用点改造、测试面大但机械 | 竞态窗口漏防（守卫集中一点，可单测）；并发 git 锁行为（per-repo 串行队列覆盖） | **✅ 推荐（两期落地）** |
| **B worker_threads 隔离**（WorktreeManager 挪进 worker 线程） | 低：为「execFile 写 async」这个一行级改动引入双线程架构，跨线程错误退化 + 生命周期善后 | 高：跨线程序列化边界、worker 生命周期管理、TS 加载环境未验证 | 错误对象跨线程丢类型；worker 腰斩善后复杂；pi 启动环境下 loader flags 未经验证 | ❌ 否决（详见 §3.4） |
| **C 仅 finalize + reaper 异步化**（create 保持同步） | 低：终态是 sync/async 双轨 API，过渡态 | 低：两处纯 await 化，无签名传染，无新竞态 | 无新增风险，但 spawn 阻塞原样保留 | 作为方案 A 的 **Phase 1**（详见 §3.5） |

三个方案详述如下。

### 3.3 方案 A：整链 async 化（gitRun → execFile）【长期方案，推荐】

`gitRun` 改为 `gitRunAsync`（`execFile` + 手写 Promise 包装），`create` / `cleanup` / `collectPatch` / `scan` 公共签名全部改 async，调用链逐点 await。`registerPid` 保持同步（见 3.6）。

**长期合理性**：git 子进程调用本质是 IO，async 是 Node 中它的正确形态；数据/逻辑归位到该在的层（IO 调用方持有 Promise 而非阻塞事件循环）；不引入新执行机制（无 worker、无线程），未来 pi 若迁移到别的进程模型无需推翻。三个月后回看，这就是「本来就该这么写」的代码。

**关键设计点**：

1. **gitRunAsync 的错误包装**。✅已测（探针 P-errshape，验证方法见 §3.7 探针清单）：`execFile` callback 出的错与 `execFileSync` throw 的错 **message 格式同构**（非零退出路径两者均为 `"Command failed: <cmd>\n<stderr>"`；超时路径 `killed: true` + `signal: "SIGTERM"`），但**属性不同构**——实测（Node 24）`execFile` 的 `err.stderr` 为 `undefined`（stderr 在 callback 第三参）、退出码在 `err.code`（数字）；而 `execFileSync` 的异常 `e.code` 为 `undefined`（退出码在 `e.status`）、`e.stderr` 为 string。因此：
   - 包装 message 格式保持 `git <subcommand> failed: <原因>` 不变——下游 `DirtyWorktreeError` 判定（`worktree-manager.ts:292-299`，只检查 status 输出非空转 throw）与测试 `toThrow` 匹配零改动
   - 顺带把 `exitCode` / `stderr` 挂到包装错误上（新增属性，非破坏性）。**实现注意（探针结论）**：`stderr` 必须从 callback 第三参取（`err.stderr` 是 undefined），`exitCode` 取 `err.code`（数字时）——直接照抄旧代码的 `err.stderr` 会拿到 undefined
   - 不用 `util.promisify(execFile)`：它对多返回值 resolve 成 `[stdout, stderr]` 数组，调用方要解构且易错。手写 10 行 Promise 包装
2. **create 内部时序重排**：`Promise.all([assertCleanTree(status), rev-parse HEAD])` 并行（脏树校验语义不变，仍先于 `worktree add`）→ 串行 `worktree add` → registry.add / symlink（同步 fs 保留，见 3.6）→ MF#3 回滚路径（`worktree-manager.ts:112-126`）async 化（`await` remove / branch -D，各自 best-effort，原始 err 仍外抛）。
3. **spawn 临界区顺序保证 + 新增竞态守卫**。顺序保证机制不变：execute 是 async 函数，`await create` 之后才 kickOffBackground → runSpawn 读 worktree.path 作 spawn cwd，await 串行天然保证「worktree 先于 spawn」。但 async 化打开了一个新竞态窗口——**create await 期间 event loop yield，cancel / dispose 可以插入**：
   ```
   execute:
     record = createRecordForMode(...)          // record running，已进 store
     worktreeHandle = await wtm.create(...)     // ← yield 点：cancel(id) / disposeAllRecords 可达
     record.worktreeHandle = worktreeHandle     // cancel 时刻此值还是 undefined！
     kickOffBackground(...)
   ```
   若 cancel 在 create 进行中到达：`cancelBackground` 的 `tryTransition` CAS 成功，但其 cleanup 分支（`subagent-service.ts:1534`）读到 `record.worktreeHandle === undefined` 而跳过 → create 返回后 handle 才被赋值 → worktree 泄漏（只能等 reaper 60s 宽限后兜底），且 `runAndFinalize` 会白跑整个子进程（末尾 CAS 失败跳过 finalize，`subagent-service.ts:1421`）。**守卫**：create 返回并赋值 `record.worktreeHandle` 后，立即检查 record 状态是否已被转终态（closed）；是则主动 `await cleanup(worktreeHandle)` + 走 early-failed 返回（execute 返回 `buildEarlyFailedHandle`，executeAndAwait throw 原语义不变），不进 kickOffBackground。dispose 同理由该守卫覆盖。⛔实施期门（探针 P-guard，§3.7）：该竞态路径的时序断言（yield 点可达 cancel/dispose）目前基于代码结构推理，Phase 2 落地时以单测（cancel-during-create）+ 人为延迟实测双验证。
4. **并发行为变化与 per-repo 串行队列**。`execFileSync` 因单线程天然全局串行；async 化后同一时刻可有多个 git 进程并发（wave 并行 spawn 多个 worktree subagent）。**并发 git 写命令是否锁冲突——原假设「fail-fast 直接失败」已被实测修正**：✅已测（探针 P-lock，git 2.52.0，验证方法见 §3.7）：同一 repo 8 并发 `worktree add`（2000 文件 checkout，长写窗口）+ 8 并发 `branch` 创建，16/16 全部成功、零 `config.lock`/refs 锁冲突——现代 git 对锁竞争有内置重试，旧版本 git 的 fail-fast 场景在 2.52 未复现。但该行为**无兼容性承诺**（git 未文档化并发 worktree add 的安全性；旧 git、网络文件系统、packed-refs rewrite 场景未测），不能作为正确性依据。处理：在 WorktreeManager 内加 **per-repo mutex**（定义：以 repo 路径为 key 的互斥队列——`Map<repo, Promise>` 链式串行，后来的写命令 `await` 前一个的 Promise 尾部，即「同一 repo 的写命令排队执行、不同 repo 与读命令并发」；例如 wave 并发 spawn 时 8 个 `worktree add` 在同一 repo 上按到达顺序逐个执行），把**写类命令**（`worktree add` / `worktree remove` / `branch -D` / `add -A`）按 repo 串行化；读类（`status` / `rev-parse` / `diff`）不加锁。该队列的三重收益：a) 不依赖 git 锁实现细节（对未验证场景防御）b) 并发限流——wave 8 并发 spawn 不再同时打 8 份 checkout 的磁盘 IO c) 行为确定性可测（§4.2 场景 5）。行为从「全局意外串行」收敛为「同 repo 写操作显式串行、跨 repo 与读操作真并发」。
5. **同步签名调用方（链路 C）的处理**。**fire-and-forget**（定义：发起异步操作后不 await 其完成、调用方立即返回；失败只能靠 `.catch` 记日志，不能向调用方传播——例：`void this.worktreeManager.cleanup(handle).catch(err => bestEffort(err, ...))`）：
   - `cancelBackground` / `cancel` 的同步 boolean 返回语义保留（CAS 抢锁结果同步可得，tool 层依赖）：cleanup 改 fire-and-forget（`void this.worktreeManager.cleanup(handle).catch(err => bestEffort(err, ...))`）。安全性：cleanup 只消费冻结的 WorktreeHandle，不依赖 record 后续状态；record 已 archive 不影响清理正确性
   - `disposeAllRecords` / `dispose`：同样 fire-and-forget。dispose 在进程退出路径上本就不等待子进程回收（`killAllSpawnedChildren` 也不 await，`session-runner.ts:226`）；若进程先退，残留 worktree 由下次 session_start 的 reaper 兜底（pid 死活判据，`worktree-manager.ts:233-249`），与现有崩溃恢复语义一致。恢复指引：若观察到 `pi-sub-*` 残留（`git worktree list`），等待下次 pi 启动的 reaper 自动回收，或手动 `git worktree remove --force <path> && git branch -D <branch>`
6. **reaper 触发时机**：session_start handler 本就是 async（`index.ts:281`），内部已有多个 await（如 `index.ts:394`）。`wtm.scan()` 直接改 `await wtm.scan()`，无障碍。scan 内部逐孤儿**串行** await（保持现有 for 循环串行语义，防止一次 reaper 打出 N 个并发 git）。

**短期成本**：WorktreeManager 公共 API 签名全变（4 个方法 async 化），调用点 6 处改造，测试面较大（见 §5）。改动集中、机械，但有 2 处需要仔细设计（竞态守卫、per-repo mutex）。

**风险**：
- 竞态窗口漏防（已识别 cancel/dispose 两处，守卫集中在一个检查点，可单测覆盖）
- 并发 git 依赖未承诺行为（实测 git 2.52 零冲突，但跨版本/文件系统场景未验证；per-repo mutex 覆盖写类命令，读类无锁可容忍——探针 P-lock）
- 测试改造引入回归（现有测试契约清晰，mock 层面机械替换）

### 3.4 方案 B：worker_threads 隔离【长期方案，否决】

WorktreeManager 实现不动（继续 execFileSync），整体挪进 worker thread，主线程通过 async 消息接口调用。

**若用它，§2.0 的例子会变成什么样**：主线程视角症状同样消失——TUI 不冻结、B 的流式输出不停摆（git 阻塞发生在 worker 线程，不占主线程事件循环），用户层面的收益与方案 A 无差别。代价藏在维护者一侧：下述 4 条新边界每一个都是新的失败面与排障面，且「§4.2 的验收证据链」要跨线程采集。

- **表面优点**：主线程完全不执行 git 调用；WorktreeManager 内部逻辑零改动
- **否决理由**：
  1. **收益与方案 A 完全相同**（都是主进程不阻塞），但引入一整套新边界：WorktreeHandle 跨线程序列化（可序列化，但错误对象跨线程丢类型——worker 里的 `ExecFileException` postMessage 到主线程退化为 plain object，`instanceof Error` 与属性保真要手工处理）
  2. **worker 生命周期管理**：extension dispose（session_shutdown）时 terminate worker，正在执行的 `worktree add` 被腰斩的善后（半建 worktree 的回滚）比进程内 Promise 取消复杂
  3. **TS 加载环境风险**：pi extension 以 TS 源码直接运行（import 使用 `.ts` 后缀，依赖 Node type stripping），worker 内 import 同源 TS 文件需要 loader flags 正确传播到 worker，pi 的启动环境下未经验证
  4. registry 同步 fs IO 若留在主线程则与 worker 内 git 操作分属两线程，「add 成功后 registry.add」的顺序保证要跨线程消息往返，原子性论证（`worktree-registry.ts:14-18`）被破坏；若 registry 也挪进 worker，主线程其他调用方（registerPid 在 spawn 回调链里同步调）又要跨线程
- 三个月后回看：为「把 execFile 写成 async」这个一行级改动引入的双线程架构，维护成本不成立

### 3.5 方案 C：仅 finalize + reaper 异步化，create 保持同步【短期方案，作为方案 A 的 Phase 1】

只改链路 B（finalize 的 collectPatch/cleanup）与链路 D（reaper scan），create/cleanup 的其余调用点不动。

- **短期收益**：finalize 4 条 + reaper 2N 条同步 git 解除阻塞，改动面小（doFinalizeRecord 已是 async 函数，scan 在 async handler 里，两处纯 await 化，无签名传染），无新竞态
- **若用它（且停在 Phase 1 不前进），§2.0 的例子会变成什么样**：例 2（spawn 期间按键无回显）与例 1 的前半段（A 的 worktree add 进行中 B 停摆）**原样保留**——spawn 临界区的 3 条同步 git（含最重的 worktree add 秒级 checkout）没动，用户感知最强的「spawn 时 TUI 冻结」没有解决；只有收尾期（例 3）的冻结消失。且 WorktreeManager 出现 sync/async 双轨 API（create 同步、cleanup 异步），是过渡态
- **定位**：不作为终点，作为方案 A 的分阶段落地策略——Phase 1 先交付方案 C 范围（立刻消除 finalize/reaper 阻塞，验证 execFile 包装与测试改造），Phase 2 完成 create 异步化 + 竞态守卫 + 并行化 + per-repo mutex，收敛到方案 A 终态

### 3.6 关键决策：worktree-registry 同步 IO——不改

**选择**：registry 保持同步 IO。**被否**：随调用链一起 async 化（`readFileSync/writeFileSync/renameSync` → fs/promises）。**证据**：

1. 注册表是单文件小 JSON（<10KB 量级，几十个条目），`readFileSync + writeFileSync + renameSync`（`worktree-registry.ts:131,153-154`）总耗时 <1ms，与 git 子进程（百 ms-秒级）不在一个量级，不构成阻塞源——async 化解决不了任何 §2.0 的例子，纯增改动面
2. `registerPid` 在 spawn 返回后的同步回调链上被调（`session-runner.ts:906-908` 经 `ctx.onWorktreePid`），改 async 会把回调签名传染进 session-runner；保持同步让 pid 补全保持「spawn 返回即可得」的时序（这是 2026-08-11 reaper 误删事故的修复语义，`session-runner.ts:901-905` 注释）
3. registry 的并发安全论证（「Node 单线程保证 sync read-modify-write 在一个 event loop turn 内原子」）**不受调用方 async 化影响**——同步操作本身原子，与调用链上层是否 await 无关

`buildEnvBlock` 的 execFileSync（`session-runner.ts:499`）：列入 Phase 2 顺带项。改 async 后 `runSpawn`（`session-runner.ts:810` 调用点）加 await；branchCache 命中路径零开销。收益是每个 cwd 首次 spawn 少一次最多 2s 的阻塞（挂载盘上 git 慢时才显著），优先级低。

### 3.7 探针清单（运行时行为断言的验证状态）

本文档全部运行时行为断言及验证状态。✅ = 设计期已实测；⛔ = 实施期门（标注哪期前必须跑通，未跑通不得合入该期）：

| ID | 验证的行为 | 探针方法 | 状态 |
|---|---|---|---|
| P-lock | 并发 git 写命令是否锁冲突失败（原「config.lock fail-fast」断言） | /tmp 测试 repo：8 并发 `worktree add`（2000 文件 checkout）+ 8 并发 `branch`，统计 exit code 与 stderr | ✅已测：git 2.52.0 下 16/16 成功零冲突——原 fail-fast 断言**不成立**，§3.3 设计点 4 已按实测改写（mutex 保留，理由改为防御+限流+确定性） |
| P-errshape | `execFile` 与 `execFileSync` 错误对象 message 格式与属性形态 | Node 24 探针脚本：ENOENT / 非零退出（exit 128）/ 超时三路径，dump message/code/killed/signal/stderr 类型 | ✅已测：message 格式同构、超时 `killed:true`+`SIGTERM`；**属性不同构**（`execFile` 的 `err.stderr` undefined、退出码在 `err.code`；`execFileSync` 的 `e.code` undefined、stderr 在 `e.stderr`）——§3.3 设计点 1 已按实测修正包装实现细节 |
| P-errtimeout | execFile 超时路径 killed/signal 形态 | `execFile("sleep",["3"],{timeout:200})` | ✅已测：`killed:true`、`signal:"SIGTERM"`、`code:null`（同 P-errshape 一并跑出） |
| P-block | 同步 git 期间并发 subagent stdout 停摆（§2.0 根因链） | §4.3 对照基线：改造前跑 §4.2 场景 1，B 的 session jsonl 时间戳空洞对照 `PI_EXT_DEBUG=1` 日志中 A 的 git 窗口 | ⛔ Phase 1 合入前留基线 |
| P-guard | create await 窗口 cancel/dispose 插入 → worktree 泄漏，守卫兜住 | 单测 cancel-during-create（create 的 git mock 加延迟）+ §4.2 功能回归场景 4（人为延迟实测） | ⛔ Phase 2 合入前 |
| P-ffcleanup | fire-and-forget cleanup 的失败可观测 + 进程先退时 reaper 兜底 | dispose 场景实测：kill 主进程 → 重启 pi 触发 session_start reaper → worktree 回收 | ⛔ Phase 1 合入前（随功能回归场景 2） |
| P-mutex | per-repo 队列使同 repo 写命令串行且无饥饿 | 单测：并发 N 个 create 全部成功且时间上互斥（§5 测试改造点）；实测 §4.2 场景 5 | ⛔ Phase 2 合入前 |

## 4. 验收

结论：三层验收——单测/集成测试全绿；本地 pi CLI 真实模型实测 worktree subagent 全生命周期，用**并发 subagent 的 session jsonl 时间戳连续性**作为阻塞消除的客观证据；功能回归（patch 回收、worktree/branch/注册表清理干净）。

### 4.1 测试层

- `cd extensions && pnpm extensions:test`（vitest）全绿，重点文件：worktree-manager / execute-and-await-worktree / finalize-record / session-start-reaper / worktree-pid-registration.integration
- `pnpm extensions:typecheck` + `pnpm extensions:lint` 通过

### 4.2 本地 pi CLI 实测（阻塞消除的可观测证据）

环境：dev-link 启用本地源码版 pi-subagent-workflow；测试模型 `xiaomi-token-plan-cn/mimo-v2.5-pro`；repo 用大 working tree 的仓库（如 xyz-agent 主仓，保证 worktree add 秒级、阻塞可观测）。测试框架遵守项目规范：vitest 跑单测，真实场景用 `pi --mode rpc` + stdin JSONL 或 interactive 手动驱动。

**观测方法（核心证据：并发 subagent 的事件时间戳连续性）**：

1. **并发事件流不中断**（回溯 §1 目标 1「其他 subagent 流式输出连续」）。主 agent 先 spawn 普通模式 subagent B（task 让其持续产出，如循环 bash 输出，每 0.2s 一条），B 运行中再 spawn worktree 模式 subagent A。A 的 spawn（create 3 git）与 finalize（4 git）窗口必须与 B 的 streaming 重叠。证据：读 B 的 session jsonl（`~/.pi/agent/subagents/<enc>/sessions/`）逐 entry 时间戳，**相邻 entry 间隔无 >500ms 的空洞**横跨 A 的 git 窗口（`PI_EXT_DEBUG=1` 日志可定位 A 的 worktree add 起止）。改造前对照：同一场景 B 的 jsonl 在 A 的 worktree add 期间出现秒级时间戳空洞（stdout pump 停摆的直接证据）
2. **主进程 timer 不停摆**（回溯 §1 目标 1，reaper 链路）。reaper 场景：预置孤儿条目（kill -9 一个带 worktree 的 pi 主进程，或手动向 worktrees.json 注入 pid 已死条目），启动 pi 触发 session_start reaper，reaper 清理期间（多孤儿时秒级）statusline/其他扩展的周期事件持续更新（TUI 或日志时间戳连续）
3. **TUI 交互响应**（回溯 §1 目标 1，用户直接感知）。interactive mode 下 A spawn 期间按 ESC / 输入字符即时响应，无冻结感（改造前 worktree add 期间输入无回显）

**功能回归（每项必须通过；均回溯 §1 目标 2「父 agent 语义不变」或目标 3「新增竞态处理明确」）**：

1. patch 回收不丢（→目标 2）：A 完成后 `record.patchFile` 存在且 `git apply --check` 通过（改动回传不丢）。失败恢复：patchFile 缺失时检查 `PI_EXT_DEBUG=1` 日志中 collectPatch 的 best-effort 错误，改动仍在 worktree checkout 删除前可用 `git -C <checkout> diff` 手动导出
2. 资源清理干净（→目标 2）：`git worktree list` 与 `git branch` 无 `pi-sub-*` 残留；tmpdir 下 checkout 目录已删。失败恢复：残留时手动 `git worktree remove --force <path> && git branch -D pi-sub-*`，并检查 worktrees.json 条目
3. 注册表清空（→目标 2）：`<agentDir>/subagents/worktrees.json` 条目清空（对应 branch）
4. 竞态守卫（→目标 3，探针 P-guard）：在 create 的 git 命令中人为加延迟（临时 mock 或大 repo），延迟窗口内 cancel 该 record → worktree 被守卫主动清理（而非等 reaper 60s），子进程不白跑
5. per-repo mutex（→目标 3，探针 P-mutex）：并发 spawn 2+ 个同 repo worktree subagent，全部成功，且 `PI_EXT_DEBUG=1` 日志显示同 repo 的写类 git 命令在时间上互斥串行（mutex 生效的直接判据；「无 config.lock 冲突」不再是判据——P-lock 实测 git 2.52 本就不冲突）
6. 错误形态（→目标 2）：脏树 spawn 仍抛 `DirtyWorktreeError` 且 message 格式不变；git 失败时包装错误含 exitCode/stderr 属性

### 4.3 对照基线

改造前先跑一轮 4.2 的场景 1/3 留存基线（jsonl 时间戳空洞、TUI 冻结现象），改造后同场景复跑对比。两者差异即「阻塞消除」的可复查证据。

## 5. 下一层拆分（按文件）

结论：11 个实现任务 + 6 组测试改造，按 Phase 1（T1/T3/T7/T8/T9/T10）→ Phase 2（T2/T4/T5/T6/T11）两期交付。**Phase 划分依据**：Phase 1 只含「无新竞态」的部分（finalize/reaper 纯 await 化 + cancel/dispose 的 fire-and-forget），先行验证 execFile 包装与测试改造这套基础设施；Phase 2 才打开 create 的竞态窗口，守卫（T5/T6）与 mutex 行为验证（T4）必须与 create 异步化（T2）同期交付，不允许 create 异步化先行裸奔。

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

不改：`worktree-registry.ts`（§3.6 决策）；`registerPid` 签名（spawn 同步回调链）。

**逐任务 justification（为什么这么拆 + 验收呼应）**：

| 任务 | 拆分理由 | 呼应验收 |
|---|---|---|
| T1 | 地基任务：包装形态（message 格式 + exitCode/stderr 属性）决定所有调用点与测试的错误断言；mutex 与 gitRun 同文件同 commit，避免 per-repo 队列后续二次重构 | §4.2 功能回归 5/6 |
| T2 | create 的 Promise.all 重排涉及脏树校验语义保真，与纯 await 化性质不同，独立成任务便于单独回归脏树路径 | §4.2 功能回归 6 |
| T3 | 与 T1 同期使 finalize/reaper 立即受益（Phase 1 收益主体）；scan 保持逐孤儿串行是行为决策（防 N 并发 git），拆出可独立审查 | §4.2 场景 2 + 功能回归 1/2/3 |
| T4 | mutex 的行为验证（串行性 + 无饥饿）依赖 T2 落地后的真实并发路径，单列收尾避免与实现混在一起自证 | §4.2 功能回归 5 |
| T5/T6 | Phase 2 核心新增逻辑（终态守卫），execute 与 executeAndAwait 是两条独立调用链（返回 handle vs throw），分别拆分保证失败语义分别回归 | §4.2 功能回归 4 |
| T7/T8 | 同步签名保留的最小侵入路径（fire-and-forget）；cancel 与 disposeAllRecords 调用方不同（tool 层 vs 生命周期钩子），分任务验证 boolean 语义与计数语义各自不变 | §4.2 场景 3 + 功能回归 2 |
| T9 | Phase 1 收益主体（finalize 4 条 git 解除阻塞），doFinalizeRecord 已 async，纯 await 化风险最低 | §4.2 场景 1（finalize 窗口） |
| T10 | 一行改动（handler 已 async），独立成任务保证 reaper 验收独立可测 | §4.2 场景 2 |
| T11 | 顺带项：有 branchCache，仅首次 spawn 阻塞，收益低；独立可砍（砍则连带 5 个测试文件不动） | §1 目标 1（弱关联） |

### 测试改造点

（单测/集成测试是 §4.1 测试层验收的改造对象，非 §4.2 的替代；worktree-manager.test 的新增用例是 §4.2 功能回归 4/5/6 的单测层前哨——真实场景实测仍按 §4.2 执行）

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
