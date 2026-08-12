# pi-scheduler 修复设计：once 回显误导 + 任务跨 session 干扰

> **层声明**：当前层 = pi-scheduler extension 行为修复设计；下一层产物 = 可实现的代码改动（`extensions/scheduler/src/` 下 types/store/backend/index/service/tool 的修改 + 测试用例）。性质：**技术方案设计类**，涉及数据流、错误处理、运行时行为断言，准则 5/6/7 全部适用。

**一句话结论**：两个独立问题——① once 任务创建回显无条件列出 5 次未来运行（实际只执行 1 次，纯误导）；② 任务存储按 cwd 共享且每个 session 启动时无条件加载并调度，导致同 cwd 的其他 session 显示任务、到期时甚至重复触发。修复：once 回显按 kind 裁剪为 1 次；任务记录 owner session（sessionFile），SchedulerRuntime 方法层按 owner 过滤（内存持全部任务、持久化全量写回），dispatch 前磁盘 owner 复核收敛迁移窗口，仅 owner 显示与执行。

> 2026-08-12 对抗式审查两轮修正：第一轮（review.md）——原方案「loadTasks 入口过滤」有致命副作用：runtime.persist() 全量覆盖共享 store 文件，双 session 并存时各自 persist 互删对方任务（破坏 G3/G4）。改为「内存全量 + runtime 方法层过滤 + 全量写回」，补 dispatch 前磁盘 owner 复核（D3）、store 原子写（D7）。第二轮（review-2-closure.md）——复核失败改「内存副本 owner 改为磁盘 owner」而非删除（删除打破内存全量不变量，全量写回即删他人任务）；addTask 显式打 ownerSessionFile；D7 tmp 名唯一化；收敛表述改为「首次到期 ≤2 次、第二次起单触发」。

---

## §1 背景目标

### SCQA 开篇

- **情境**：`@zhushanwen/pi-scheduler` 是 pi 的定时任务扩展。用户通过 `schedule` 工具创建任务（如 `schedule { prompt: "git pull origin main", schedule: "1h", kind: "once" }`），任务到期时向当前 pi session 注入一条消息。任务持久化在磁盘，关闭重开 session 后仍会触发。
- **冲突**：创建 once（单次）任务时，回显却显示 "Next 5 runs: in 1h / in 2h / ... / in 5h"——但任务实际只执行 1 次；更严重的是，同 cwd 打开另一个 pi session 时，该 session 的状态栏也出现 `[scheduler] 1 scheduled · git pull origin m... in 59m`，且任务到期时**每个开着且空闲的 session 都会各自触发一次**，任务被重复执行并注入到非创建 session。
- **问题**：回显误导用户对任务行为的预期；任务归属语义不清（cwd 级 vs session 级），其他 session 被干扰、任务重复触发。
- **答案**：once 任务回显只显示首次执行时间；任务归属到创建它的 session（owner），仅 owner session 显示与执行；owner session 关闭后任务保留在磁盘，重开后继续按计划触发。

### 系统是什么

pi-scheduler 是 pi extension（`extensions/scheduler/`），提供：

- **`schedule` 工具**：创建定时任务（interval 时长或 cron 表达式，kind 分 once/recurring，可选 expires/force/name）
- **`schedule_control` 工具**：list / toggle / delete / run
- **`/schedule` 命令**：同一业务入口（SchedulerService）的命令行封装
- **状态栏 widget**：`[scheduler] 2 scheduled · build-check in 4m · 1 overdue`
- **磁盘 store**：任务持久化到 `~/.pi/agent/scheduler/<cwd 路径>/scheduler.json`（按 cwd 隔离，跨 session 重启保留）
- **调度循环**：每个 session 启动时加载任务并启动 30s tick，到期任务通过 `pi.sendMessage(..., { deliverAs: 'followUp', triggerTurn: true })` 注入消息

架构链：`index.ts`（factory，session 生命周期装配）→ `service.ts`（业务入口）→ `runtime.ts`（内存态 + tick 调度）→ `backend.ts`（FS/pi 抽象，可注入 mock）→ `store.ts`（JSON 文件读写）。

### 设计目标（从使用者体验倒推）

| # | 目标 | 使用者体验表述 |
|---|------|---------------|
| G1 | once 回显准确 | 创建 once 任务时，回显只显示 1 次执行时间，与任务实际行为一致 |
| G2 | 任务只影响创建它的 session | 同 cwd 的其他 session 不显示该任务、不执行该任务、不因它产生任何提示 |
| G3 | 任务跨进程重启保留 | 创建任务的 session 关闭后任务不丢失，重开（resume）同一 session 后继续按计划触发 |
| G4 | 升级平滑 | 已有任务（无归属信息）升级后不丢失、不失效，被接管后行为与新建任务一致 |
| G5 | 无重复触发 | 同一任务在任意时刻最多被触发一次，且注入到它所属的 session |

### In-scope / Out-of-scope

**In-scope**：once 创建回显；任务归属（owner）字段与迁移；loadTasks 过滤；README 行为描述更新；相关单测 + 真实环境实测。

**Out-of-scope**：
- 孤儿任务自动 GC（owner session 文件被删除后残留的不可见任务——低频、无害，见决策 D4）
- 同一 session 文件被两个 pi 进程同时 resume 导致的重复触发（极端场景，原设计同样存在）
- 定时任务的持久化机制本身（store 按 cwd 隔离的路径结构不变）

---

## §2 现状与问题分析

### 2.1 使用者视角现状（真实例子）

**例 1：创建 once 任务的回显**（`service.ts` create() 生成，2026-08-12 实测输出）：

```
Task "git pull origin main。然后使用 d..." (b3bda0ab) created.
Schedule: once in 1h
Kind: once
Expires: never
Force: no

Next 5 runs:
  1. in 1h
  2. in 2h
  3. in 3h
  4. in 4h
  5. in 5h
```

任务声明是 "once in 1h"（`formatSchedule` 对 once 正确显示为单次），回显却列出 5 次运行——第 2~5 次永远不会发生。

**例 2：同 cwd 第二个 session 打开时的状态栏**（用户实测）：

```
[scheduler] 1 scheduled · git pull origin m... in 59m
```

用户只在一个 session 里创建了任务，另一个 session 也被提示。更隐蔽的是执行层：两个 session 各自跑 30s tick，任务到期时**各自**检查 `now >= nextRunAt` 并 dispatch——若两个 session 同时空闲，任务消息会被注入两次（分别注入两个 session）。

### 2.2 失败模式

| # | 失败模式 | 触发条件 | 用户可见影响 |
|---|---------|---------|-------------|
| F1 | once 回显列出 5 次运行 | 创建 kind=once 任务（interval 或 cron schedule） | 用户以为任务会重复执行 5 次；实际只执行 1 次，其余 4 次静默不发生 |
| F2 | 其他 session 显示任务 widget | 同 cwd 打开第二个 pi session | 无关 session 状态栏出现任务提示，制造困惑（"这不是我的任务"） |
| F3 | 任务重复触发 | 同 cwd 两个 session 同时空闲且任务到期 | 任务消息注入 2 个 session：git pull 等副作用操作被执行两次 |
| F4 | 任务注入错误 session | 任务到期时创建它的 session 忙/离线，另一个 session 空闲 | 指令注入到与任务无关的 session，上下文错乱 |

F3/F4 同根：**每个 session 都是独立调度者**，无归属概念。

### 2.3 根因分析

**问题 1（once 回显）根因**：`service.ts` create() 无条件调用 `computeNextRuns(task.schedule, now, 5)`，不看 `task.kind`。`computeNextRuns`（`parsing.ts`）对 interval 模式就是简单累加 `now + intervalMs × (1..5)`。而实际执行路径 `runtime.ts` dispatchTask() 中 `if (task.kind === 'once') this.tasks.delete(task.id)`——once 任务 dispatch 一次即删除。**回显逻辑与执行逻辑对 kind 的认知不一致**。

**问题 2（跨 session 干扰）根因**（两个独立事实叠加）：

1. **store 按 cwd 共享**：`store.ts getStorePath()` 生成 `~/.pi/agent/scheduler/<cwd>/scheduler.json`，同 cwd 的所有 session 读写同一文件。cwd 隔离的设计意图是"不同项目互不干扰"，但**没有 session 维度**。
2. **每个 session 无条件成为调度者**：`index.ts` session_start 中，每个 session 都执行 `runtime.loadTasks(backend.loadTasks())` + `runtime.startScheduler()`。loadTasks 不区分任务归属，tick 调度无跨 session 互斥。

### 2.4 物理数据流（现状）

```
[创建] agent 调 schedule tool
  → SchedulerService.create → SchedulerRuntime.addTask
  → PiSchedulerBackend.persist → ~/.pi/agent/scheduler/<cwd>/scheduler.json   ← 按 cwd 共享

[任意 session 启动] session_start
  → PiSchedulerBackend.loadTasks()   ← 读同一 store 文件，无归属过滤
  → runtime.loadTasks → runtime.startScheduler()（30s tick）
  → refreshWidget → 状态栏显示全部任务                               ← F2 在此产生

[到期] 每个 session 的 tick 独立执行 dispatchTask
  → pi.sendMessage({...}, {deliverAs:'followUp', triggerTurn:true})  ← F3/F4 在此产生：
  → 注入到「当前 tick 所在的 session」，而非「创建任务的 session」     每个 idle session 都注入一次
```

### 2.5 抽象术语定义

- **owner session**：创建任务的 pi session。用 **sessionFile 绝对路径**标识（`ctx.sessionManager.getSessionFile()`，SDK 已确认可用）。同一 session 关闭重开（resume）sessionFile 不变，因此"重开继续触发"可判定；fork 出新 session 会生成新 sessionFile，不继承任务归属。
- **孤儿任务**：owner session 文件已被删除（用户删除 session / 清空 session 目录）的任务。磁盘上残留，无任何 session 会加载它。

---

## §3 解决方案

### 3.1 终态（使用者视角先行）

**例 1（修复后）：创建 once 任务回显**

```
Task "git pull origin main。然后使用 d..." (b3bda0ab) created.
Schedule: once in 1h
Kind: once
Expires: never
Force: no

Next run: in 1h
```

**例 2（修复后）：同 cwd 第二个 session 打开**——状态栏无 `[scheduler]` 提示（该 session 没有任何属于自己的任务，widget 为空）。

**例 3（修复后）：任务到期**——只有 owner session 收到注入消息；另一个同 cwd session 全程无感（不显示、不执行、无提示）。

**例 4（失败路径 + 恢复指引）**：owner session 已删除（孤儿任务）时，任务静默不触发。恢复指引：任务不可见且不可管理（list 只显示 owner 任务），可手动清理 store 文件 `~/.pi/agent/scheduler/<cwd>/scheduler.json` 中对应条目（`schedule_control` 无孤儿管理入口，Out-of-scope）。

### 3.2 方案对比

#### 问题 2（跨 session 干扰）方案对比

| 方案 | 长期架构合理性 | 短期实现成本 | 风险 | 裁决 |
|---|---|---|---|---|
| **A. owner 归属 + runtime 方法层过滤（选）** | 归属语义正确归位：任务 = session 级资源，持久化保留；过滤集中在 runtime 单一类（所有读/写/调度路径的 chokepoint），持久化全量写回天然正确 | 中：types 加 1 字段 + store 迁移默认值 + runtime 6 处过滤/校验 + backend 构造传 sessionFile + dispatch 复核 + 原子写，约 6-8 处小改 | 迁移窗口并发接管（复核机制收敛 ≤2 tick，见 D3）；孤儿任务残留（无害） | ✅ |
| B. cwd 共享 + 跨 session 执行互斥（文件锁/leader 选举） | 保持"调度器 = cwd 守护进程"模型，但互斥机制需锁文件、心跳、staleness 处理，复杂度高 | 高：新增锁协议 + 崩溃恢复，远超本问题规模 | 锁过期/竞争窗口仍可能双触发；**不解决 F2（其他 session 仍显示任务）**，不符合用户明确期望 | ❌ |
| C. session 私有存储（任务文件按 session 隔离，不共享） | 语义最干净（任务 = session 临时状态），但**推翻 README 承诺的"关闭重开仍触发"持久化语义**，且 store 路径结构重构 | 中：store 路径带 session 标识，涉及路径迁移 | 用户已确认要保留持久化（owner 关闭后 resume 继续）；关闭即消失与 G3 冲突 | ❌ |

**被否方案效果**：若用 B，例 2 中第二个 session 仍会显示 `[scheduler] 1 scheduled`（用户明确反对的行为），只是执行加了锁；若用 C，用户关掉创建任务的 session 后，"1 小时后 git pull" 的任务直接消失（用户已选择保留）。

#### 问题 1（once 回显）方案对比

| 方案 | 说明 | 裁决 |
|---|---|---|
| **A. 按 kind 裁剪回显（选）** | once → 显示 1 次（"Next run: in 1h"）；recurring → 保持 "Next 5 runs:"。信息量最大化：recurring 用户仍可见 5 次排期 | ✅ |
| B. 统一只显示下次运行 | once/recurring 都只显示 1 次。实现最简，但 recurring 用户失去 5 次排期的既有信息（行为回退） | ❌ |
| C. 保持 5 次但标注"仅首次生效" | 不改代码只改文案。仍然展示不存在的运行，误导残留 | ❌ |

### 3.3 关键决策与权衡

**D1：owner 标识 = sessionFile 绝对路径**
- 选择：`ctx.sessionManager.getSessionFile()`（唯一、跨进程重启稳定、resume 不变）
- 被否：session id（`getSessionId()`，语义是 leaf/分支节点 id，随 fork/navigate 变化，不适合作归属键）
- 证据：SDK 类型 `ReadonlySessionManager` 含 `getSessionFile/getSessionDir/getSessionId`（dist/core/session-manager.d.ts:140），三选一，sessionFile 唯一满足"跨重启稳定"

**D2：隔离点 = SchedulerRuntime 方法层 owner 过滤（内存全量 + 持久化全量写）**
- 选择：`loadTasks()` 加载**全部**任务到内存（不过滤）；runtime 持 `ownerSessionFile` 成员，所有方法按 owner 过滤/校验：`listTasks()` 只返回自己的任务（widget 同步受限）、`tickScheduler()` 过期清理与 pending 标记只作用于自己的任务、`dispatchTask()` 只 dispatch 自己的任务、`toggleTask()/deleteTask()/runTaskNow()/getTask()` 非 owner 返回 false、`addTask()` 创建任务时**显式写入 `ownerSessionFile: 本 session`** 且配额只算自己的任务（D5 降级路径保持 undefined，后续 session 按迁移逻辑接管——即降级模式下的既有共享行为）。持久化 `persist()` 全量写回（内存本为全量，天然不丢任务）
- **被否：loadTasks 入口过滤（内存只持自己的任务）**——致命副作用：`runtime.persist()`（runtime.ts:249-262）写 `Array.from(this.tasks.values())` **全量覆盖**共享 store 文件，且 `tickScheduler()` 每 30s 无条件 persist（runtime.ts:166）。两 session 同 cwd 并存时，A 的每次 persist 把 B 的任务从磁盘抹掉、反之亦然，文件在双方任务集间振荡；B 关闭后 A 的任务已不在磁盘——**直接破坏 G3/G4**。选此方案则 persist 必须改合并语义（含删除 tombstone 处理），复杂度与竞态面反而更大
- 运行时断言：⛔实施期门——session A、B 各创建任务并各自 tick ≥1 轮后，store 文件仍含**双方**任务（探针：cat store 文件核对两个任务 id 都在，见验收 S8）

**D3：旧数据迁移——无 owner 任务接管 + dispatch 前磁盘 owner 复核（收敛双触发）**
- 选择：loadTasks 发现 `ownerSessionFile` 缺失的任务时，在**内存中**将 owner 置为当前 sessionFile 并持久化（全量写回后磁盘同步）
- 理由：一次性迁移，无感升级；迁移后旧任务获得与新建任务一致的隔离行为
- **风险（对抗式审查修正）**：升级瞬间两个 session 并发启动、各自读到无主任务、各自接管写回——**双方内存都持有该任务**。若无复核，对 **recurring** 任务这不是"双触发一次"：双方各自 dispatch、各自重算 nextRunAt、各自 persist（磁盘 owner 交替覆盖），**双 session 存活期内每次到期都双触发**，无运行时收敛机制（原稿"自愈"表述错误，已修正）
- **复核机制（收敛，第二轮审查修正）**：`dispatchTask()` 开头读盘（backend 接口新增 `readAllTasks()`）校验 `ownerSessionFile === 本 sessionFile`；**不符 → 不删内存**（删内存会打破 D2「内存全量」不变量，后续全量写回会把该任务从磁盘抹掉），而是**将内存副本 owner 改为磁盘 owner**（list/tick 过滤自然排除）并跳过本次 dispatch；**读盘失败/任务缺失 → 保守跳过 dispatch、不动内存**（store 瞬态损坏不引发删任务）。删除只允许 owner 自身的 deleteTask。两进程同时复核通过仍可能各触发一次（无锁，上界 2 次），但复核在**下次到期**时必有一方发现磁盘 owner 非己而修正——**保证：首次到期触发 ≤2 次，第二次到期起仅 owner 触发**（注意：非「2 tick 内收敛」——1h 间隔任务双持有持续整周期，期间无触发、无危害）。复核读盘频率 = 每次 dispatch（tick 30s 一次，读几 KB JSON，开销可忽略）
- 结论：接受迁移窗口内首次到期 ≤2 次的触发上界；复核后收敛。实测验证见 §4 S9、§5 V1

**D4：孤儿任务不自动 GC**
- 选择：不实现。孤儿任务残留磁盘 JSON，无任何 session 加载（无副作用，仅占几行磁盘空间）
- 被否：loadTasks 时扫描 session 目录、删除 owner 文件不存在的任务——pi 的 session 文件**延迟写入**（首次 assistant 消息前文件不存在，AGENTS.md 规则 6），"owner 文件不存在"≠"owner session 不存在"，误删活跃任务的风险大于孤儿残留的收益
- 证据：AGENTS.md「pi session 文件延迟写入」条目（SessionManager._persist 首次 flush 前 sessionFile 不存在）

**D5：sessionFile 不可得时保守降级（带告警）**
- 选择：`getSessionFile()` 返回 undefined/空串/异常时退回现状（不设 owner、加载全部任务、不过滤），不抛错，但 `console.warn('[scheduler] ownerSessionFile unavailable, running in legacy shared mode')` 显式告警
- 理由：归属信息缺失时无法隔离，保守不破坏；告警使降级路径可发现（否则 F2-F4 静默回归且排障无迹）。SDK 类型为 `getSessionFile(): string | undefined`（dist/core/session-manager.d.ts:208），正常 session 必有值，此路径仅异常环境触发

**D6：once 回显裁剪为 1 次**
- 选择：create() 中 `computeNextRuns(..., count)` 按 kind 传 1 或 5；once 文案 "Next run: in 1h"，recurring 保持 "Next 5 runs:"；`nextRuns` 数据同步裁剪（once 只返回 1 个）
- 同步改：`tool.ts` scheduleGuidelines "the response includes task id and next 5 run times." → "the response includes task id and next run time(s)."
- 覆盖 once + cron：count=1 取下一次 cron 命中，语义正确

**D7：store 写盘原子化（tmp + rename）**
- 选择：`store.ts writeSync()` 改为写**每次唯一命名**的同目录临时文件（`${storePath}.${pid}.${seq}.tmp`）+ `fs.renameSync()` 原子替换。tmp 名必须每次唯一（第二轮审查修正）：固定名（如 `scheduler.json.tmp`）下并发进程交错写同一 tmp 文件仍会损坏，且 rename 会把损坏内容**原子固化**——D7 声称消除的缺陷原样复现。唯一 tmp 名保证并发写互不交错、各自 rename 原子、last-writer-wins 无损坏；同目录写已保证无 EXDEV。注：rename 原子只防并发损坏，非断电持久化保证（原实现亦无，非回归）；权限继承边缘（rename 后为新文件 umask 权限）可接受
- 理由：多 session 并发 `writeFileSync` 同一 JSON（现状已存在，D3 接管写回提高写频次），交错 open/truncate/write 可致文件损坏 → load catch 降级空 store → **全部任务丢失**（store.ts:60-70 降级路径）。tmp+rename 使读者永远看到完整文件（旧版或新版）
- 运行时断言：⛔实施期门——两进程各 50 次交错 persist 后 store 文件可正常 JSON.parse 且内容完整（探针：并发写脚本验证）

**D8：subagent 会话纳入模型（owner 过滤天然隔离）**
- 选择：不做特殊处理。subagent 进程镜像 `--extension` 加载扩展（AGENTS.md 明文），同样触发 session_start → loadTasks → tick；其 sessionFile 位于 `~/.pi/agent/subagents/`。D2 的 owner 过滤下：subagent 不显示/不执行主 session 任务 ✓；其 persist 全量写回（内存含主 session 任务但未改动）无害 ✓
- 已知限制（诚实标注）：迁移窗口内无主任务可能被 subagent 接管（owner=subagent sessionFile），到期注入 subagent 会话而非主会话；随 subagent 会话清理变孤儿。与 D3 同源，复核机制同样收敛（主 session 复核发现磁盘 owner 非己则移除）
- 结论：不引入"仅主会话可接管"的特殊逻辑（无法可靠区分主/子会话），文档明示。实测验证见 §4 S10

---

## §4 验收（真实场景）

> 验收环境：本地 pi CLI（`pi --mode rpc --session-dir <dir> --model xiaomi-token-plan-cn/mimo-v2.5-pro --approve --extension <scheduler 路径>`）+ stdin JSONL 发 `prompt` 命令，配合 `PI_EXT_DEBUG=1` 检查 `~/.pi/agent/logs/` 扩展日志。多 session 场景用两个独立 pi 进程（同 cwd、同 session-dir 分别指定不同 session 文件）。测试模型用 mimo-v2.5-pro（AGENTS.md 规则：禁止 kimi 做测试）。

| # | 场景（谁/做什么/看到什么） | 步骤 | 通过标准 | 回溯目标 |
|---|---|---|---|---|
| S1 | 用户在 session A 创建 `kind:"once", schedule:"1h"` 任务 | A 中调 schedule tool；读回显 | 回显含 `Next run: in 1h` 且**仅 1 条** run 行；不含 `Next 5 runs:` | G1 |
| S2 | 用户在 session A 创建 `kind:"recurring", schedule:"10m"` 任务 | A 中调 schedule tool；读回显 | 回显仍含 `Next 5 runs:` 且 5 条 | G1（不回归） |
| S3 | session A 有 1 个任务（once 或 recurring），用户同 cwd 打开 session B | 启动 B，观察状态栏；B 中调 schedule_control list | B 状态栏**无** `[scheduler]` 提示；B 的 list 返回 "No scheduled tasks." | G2 |
| S4 | session A 创建 `schedule:"1m"` 任务，A、B 同 cwd 同时打开且都空闲 | 等 1 分钟到期 | A 收到注入消息（git pull 指令出现在 A 对话流）；B 全程无消息注入；A 中 schedule_control list 不再显示该任务（once 已删） | G2、G5 |
| S5 | session A 创建 `kind:"once", schedule:"1h"` 任务后**关闭 A**；1 小时后 resume A | 重开 A（同 session 文件） | 任务仍在 A 的 list 中；A 启动后 30s 内（tick）收到注入消息 | G3 |
| S6 | 升级前已有旧任务（store 中无 ownerSessionFile 字段），升级后打开 session A | 预置旧 store 文件；启动 A | A 的 list 显示该任务；任务到期只在 A 触发；store 文件已含 ownerSessionFile=A 的 sessionFile | G4 |
| S7 | 同一任务在 A 中创建后，A 忙（streaming）期间到期 | A 创建 `schedule:"1m"` 任务后立即让 A 持续输出（长 prompt）；B 同时空闲 | 到期时 B 不触发（非 owner）；A 空闲后的下一个 tick 触发 | G2、G5 |
| S8 | session A 创建任务 T1、session B 创建任务 T2（同 cwd 同时打开），各自 tick ≥1 轮 | A、B 各建任务；等 ≥1 分钟（≥2 个 tick）；cat store 文件；关 A；resume A | 磁盘 store 文件**同时含 T1 与 T2**（双方任务均未被对方 persist 抹掉）；A resume 后 list 仍显示 T1；B 的 list 显示 T2 不显示 T1 | G2、G3、G5 |
| S9 | 预置无 owner store（模拟升级），两个 pi 进程并发启动 | 预置旧 store；同时启动 A、B | 观察并记录：接管归属（谁显示该任务）、**首次到期触发次数、第二次到期触发次数**——通过标准：**首次到期触发 ≤2 次，第二次到期起仅 owner 触发**（长间隔任务双持有持续整周期是预期行为，不判失败）；收敛后 cat store：任务仍在磁盘且 owner 字段正确；关闭失败方后任务仍存在且 winner 可触发 | G4、G5 |
| S10 | session A 创建任务后，同 cwd 启动一个后台 subagent（走 extension 加载） | A 建任务；派 subagent；等任务到期 | 任务只注入 A；subagent 对话流无注入、无 widget 提示；subagent 退出后 A 的任务仍在磁盘（subagent persist 未破坏） | G2、G5 |

单测补充（不替代上述真实场景，只锁实现细节）：once 回显 1 条断言（service.test.ts）；runtime 各方法 owner 过滤/权限校验（runtime.test.ts：非 owner 任务 list 不可见、delete/toggle/run 返回 false、tick 不 dispatch 非 owner、过期清理不动非 owner、dispatch 复核移除）；loadTasks 无主接管写回 + readAllTasks（backend.test.ts）；store roundtrip 含 ownerSessionFile（store-roundtrip.test.ts）；原子写后文件可解析（store.test.ts）。

---

## §5 下一层拆分

### 实施路径（按依赖序，每步可独立验证）

1. **once 回显**（独立，先行）：`service.ts` create() 按 kind 裁剪 → `tool.ts` guidelines 文案 → `service.test.ts` 补 once 断言
2. **owner 字段**（数据层）：`types.ts` ScheduledTask 加 `ownerSessionFile?: string` → `store.ts` load 迁移补默认值 → `store-roundtrip.test.ts` 补字段
3. **归属隔离**（行为层，整链单一 commit）：`backend.ts` PiSchedulerBackend 构造接收 sessionFile + `SchedulerBackend` 接口新增 `readAllTasks()` → `runtime.ts` 持 owner 成员 + 各方法 owner 过滤/校验 + dispatchTask 开头磁盘复核 → `store.ts` writeSync 原子化 → `index.ts` session_start 传 `ctx.sessionManager.getSessionFile()`（不可得时 warn 降级）→ `backend.test.ts`/`runtime.test.ts`/`store.test.ts` 用例
4. **文档**：`README.md` 行为描述更新（任务归属 session、其他 session 无感、owner 关闭保留 resume 继续、孤儿任务说明）
5. **真实环境实测**：§4 S1-S7 全场景跑通

### 拆分理由

- 1 与 2/3 无依赖：once 回显是纯显示层修复，可独立合入；owner 是数据模型变更，牵动 store/backend/index 三层，必须整链一起改（单一 commit，避免中间态 store 格式不一致）
- 2 先行于 3：隔离逻辑依赖字段存在；store 迁移与隔离在同 commit 完成（旧数据升级路径完整）。隔离、复核、原子写必须整链同 commit——分开提交会产生"已过滤但 persist 全量覆盖互删任务"的中间态
- 5 必须最后：所有行为修复只有真实 pi 环境能验证（mock 单测不回答"真实工作里好用吗"）

### 文件改动地图

| 文件 | 改动 |
|---|---|
| `src/types.ts` | +`ownerSessionFile?: string` |
| `src/store.ts` | load 迁移补字段默认值；writeSync 原子化（tmp + renameSync，D7） |
| `src/backend.ts` | PiSchedulerBackend 构造 +sessionFile；`SchedulerBackend` 接口新增 `readAllTasks()`（D3 复核用）；loadTasks 无主接管（内存设 owner + 写回） |
| `src/runtime.ts` | 持 owner 成员；**addTask 创建时打 ownerSessionFile**；listTasks/tickScheduler/dispatchTask/toggleTask/deleteTask/runTaskNow/getTask 按 owner 过滤/校验；addTask 配额按 owner 计；dispatchTask 开头磁盘复核——**复核失败改内存 owner 而非删除**（D2/D3） |
| `src/index.ts` | session_start 取 `ctx.sessionManager.getSessionFile()` 传 backend；不可得时 warn 降级（D5） |
| `src/service.ts` | create() 按 kind 裁剪 nextRuns 与文案 |
| `src/tool.ts` | scheduleGuidelines 文案 |
| `src/__tests__/service.test.ts` | +once 回显 1 条断言 |
| `src/__tests__/runtime.test.ts` | +owner 过滤/权限/复核用例 |
| `src/__tests__/backend.test.ts` | +接管写回、readAllTasks 用例 |
| `src/__tests__/store.test.ts` | +原子写用例 |
| `src/__tests__/store-roundtrip.test.ts` | +ownerSessionFile 字段 roundtrip |
| `README.md` | 行为语义章节更新（含 once 无过期、孤儿任务说明） |

### 待验证检查点（设计阶段无法确定，诚实标注）

- **V1**：D3 复核收敛——升级后两个 session 并发启动、同时接管同一批无主任务，dispatch 前磁盘复核是否保证「首次到期触发 ≤2 次、第二次到期起仅 owner 触发」（S9 实测记录）
- **V2**：RPC mode 下 `getSessionFile()` 是否总是非空（D5 触发条件概率）——实测 S3/S4 时顺带确认
- **V3**：resume 场景下 sessionFile 是否与创建时完全一致（S5 通过即证明）
