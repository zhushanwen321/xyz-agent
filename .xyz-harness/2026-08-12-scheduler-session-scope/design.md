# pi-scheduler 修复设计：once 回显误导 + 任务跨 session 干扰（v3）

> **层声明**：当前层 = pi-scheduler extension 行为修复设计；下一层产物 = 可实现的代码改动（`extensions/scheduler/src/` 下 backend/runtime/index/service/tool 的修改 + 测试用例）。性质：**技术方案设计类**，涉及数据流、错误处理、运行时行为断言，准则 5/6/7 全部适用。

**一句话结论**：两个独立问题——① once 任务创建回显无条件列出 5 次未来运行（实际只执行 1 次，纯误导）；② 任务存储按 cwd 共享且每个 session 启动时无条件加载并调度，导致同 cwd 的其他 session 显示任务、到期时甚至重复触发。修复：once 回显按 kind 裁剪为 1 次；任务状态改用 **pi 原生 CustomEntry 存储（`pi.appendEntry` + `getEntries()` 重放，event sourcing 最小版）**——任务物理存在于创建它的 session JSONL 内，归属成为结构性质，v2 分片方案的迁移/GC/原子写/降级机制全部不需要。

> **版本历史**：v1（共享文件 + owner 字段过滤）两轮审查抓出 6 缺陷（persist 互删、复核删内存等），推翻。v2（session 分片文件）审查验证方向正确但抓出 5 个 must-fix（GC 臆断论证、编码矛盾、迁移双副本、降级振荡、/clone 遗漏），v2.1 修复后仍保留约 200 行自建存储机制（分片/迁移/GC/原子写）。**v3 推翻 v2 的存储层**：核实 pi SDK 原生支持扩展持久化（CustomEntry 注释原文 "Persist extension state across session reloads"），任务直接存 session JSONL——v2 的自建文件机制全部消失（~40 行重放折叠替代 ~200 行机制代码），且"session 删除任务即消失""subagent 物理隔离""resume 天然继续"成为结构性质。**v3.1 细化事件协议**：核实 append-only 下 recurring 任务 dispatch 后 nextRunAt 推进必须 append 新 entry（否则 resume 重放回退 → 重复触发），据此把协议从 upsert/delete/run 改为 upsert/advance/toggle/delete（advance 兼任推进 nextRunAt + 记录执行），并补 D10（entry 增长控制）/D11（TUI renderer）；修正 v3 遗留的探针编号漂移（D2/D5/D7）。v1/v2 文档不再维护。

---

## §1 背景目标

### SCQA 开篇

- **情境**：`@zhushanwen/pi-scheduler` 是 pi 的定时任务扩展。用户通过 `schedule` 工具创建任务（如 `schedule { prompt: "git pull origin main", schedule: "1h", kind: "once" }`），任务到期时向当前 pi session 注入一条消息。任务持久化在磁盘，关闭重开 session 后仍会触发。
- **冲突**：创建 once（单次）任务时，回显却显示 "Next 5 runs: in 1h / in 2h / ... / in 5h"——但任务实际只执行 1 次；更严重的是，同 cwd 打开另一个 pi session 时，该 session 的状态栏也出现 `[scheduler] 1 scheduled · git pull origin m... in 59m`，且任务到期时**每个开着且空闲的 session 都会各自触发一次**，任务被重复执行并注入到非创建 session。
- **问题**：回显误导用户对任务行为的预期；任务归属语义不清（cwd 级 vs session 级），其他 session 被干扰、任务重复触发。
- **答案**：once 任务回显只显示首次执行时间；任务状态存进创建它的 session 的 JSONL（CustomEntry），仅该 session 加载与调度；session 关闭后 entry 保留，resume 后重放继续。

### 系统是什么

pi-scheduler 是 pi extension（`extensions/scheduler/`），提供：`schedule` 工具（创建 interval/cron 定时任务，kind 分 once/recurring）、`schedule_control` 工具（list/toggle/delete/run）、`/schedule` 命令、状态栏 widget（`[scheduler] 2 scheduled · build-check in 4m · 1 overdue`）、30s tick 调度（到期经 `pi.sendMessage` 注入消息）。

架构链：`index.ts`（factory，session 生命周期装配）→ `service.ts`（业务入口）→ `runtime.ts`（内存态 + tick 调度）→ `backend.ts`（pi/FS/时间源抽象，可注入 mock）→ 存储（v3 起 = session JSONL CustomEntry，经 pi SDK）。

### 设计目标（从使用者体验倒推）

| # | 目标 | 使用者体验表述 |
|---|------|---------------|
| G1 | once 回显准确 | 创建 once 任务时，回显只显示 1 次执行时间，与任务实际行为一致 |
| G2 | 任务只影响创建它的 session | 同 cwd 的其他 session（含 subagent）不显示该任务、不执行该任务、不因它产生任何提示 |
| G3 | 任务跨进程重启保留 | 创建任务的 session 关闭后任务不丢失，重开（resume）同一 session 后继续按计划触发 |
| G4 | 升级平滑 | 旧版 cwd 共享 store 中的已有任务升级后不丢失，归位后可继续触发 |
| G5 | 无重复触发 | 同一任务在任意时刻最多被触发一次，且注入到它所属的 session |
| G6 | 无孤儿状态 | 创建任务的 session 被删除后，任务随之消失，无残留（结构性质） |

### In-scope / Out-of-scope

**In-scope**：once 创建回显；存储迁移到 CustomEntry（appendEntry + 重放折叠）；fork 隔离（owner 字段过滤）；旧 store 导入；顺手修复（service 时间源、widget/tick 定时器合并、debounce 死代码、pending 契约）；README 产品定位；单测 + 真实环境实测。

**Out-of-scope**：
- 同一 session 文件被两个 pi 进程同时 resume 导致的重复触发（任何方案无锁无解，现状一致）
- dispatch 的 at-least-once 语义消除（见 D9，文档化不修）
- 系统级 cron（pi 进程不开 = 不触发，产品定位为"session 存活期间的 AI 提醒器"）

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

任务声明是 "once in 1h"，回显却列出 5 次运行——第 2~5 次永远不会发生。

**例 2：同 cwd 第二个 session 打开时的状态栏**（用户实测）：

```
[scheduler] 1 scheduled · git pull origin m... in 59m
```

更隐蔽的是执行层：两个 session 各自跑 30s tick，任务到期时**各自** dispatch——若两个 session 同时空闲，任务消息被注入两次。

### 2.2 失败模式

| # | 失败模式 | 触发条件 | 用户可见影响 |
|---|---------|---------|-------------|
| F1 | once 回显列出 5 次运行 | 创建 kind=once 任务 | 用户以为任务重复执行 5 次；实际只执行 1 次 |
| F2 | 其他 session 显示任务 widget | 同 cwd 打开第二个 pi session | 无关 session 状态栏出现任务提示 |
| F3 | 任务重复触发 | 同 cwd 两个 session 同时空闲且任务到期 | git pull 等副作用操作被执行两次 |
| F4 | 任务注入错误 session | 创建 session 忙/离线，另一个 session 空闲 | 指令注入到无关 session，上下文错乱 |
| F5（隐蔽变种） | subagent 会话被任务污染 | 派 subagent（镜像加载扩展）时任务到期 | 干净的后台 agent 被别人的定时任务注入 |

### 2.3 根因分析

**问题 1（once 回显）根因**：`service.ts` create() 无条件 `computeNextRuns(task.schedule, now, 5)`，不看 `task.kind`（service.ts:70）；执行路径 `runtime.ts` dispatchTask() 中 once 任务 dispatch 一次即删除（runtime.ts:214）。**回显逻辑与执行逻辑对 kind 的认知不一致**。

**问题 2（跨 session 干扰）根因**（两个独立事实叠加）：
1. **store 按 cwd 共享**：`store.ts getStorePath()` → `~/.pi/agent/scheduler/<cwd>/scheduler.json`，同 cwd 所有 session 读写同一文件，无 session 维度
2. **每个 session 无条件成为调度者**：`index.ts` session_start 无条件 `loadTasks()` + `startScheduler()`，tick 无跨 session 互斥

**概念层判断**：存储维度选了 cwd、执行维度是 session——两个维度错配。即使加互斥协议（leader 选举）做成"cwd 级 cron 守护"，依然错：**任务 prompt 的语义依赖创建时的对话上下文**（哪个分支、刚才做到哪），注入到别的 session 根本无法正确执行。任务归属 session 是本质正确，不是可选优化。

**分层判断**：业务逻辑的四层分层本身合理——`service`（统一业务入口 + 结构化 ServiceResult）、`runtime`（内存态 + tick 调度，290 行承担 CRUD + 调度 + dispatch 状态机，无需再拆）、`backend`（FS/pi/时间源抽象，注入 mock 是可测试性前提）各司其职。复杂度**全部集中在 store 层**：自建私有文件格式带来了版本迁移兜底、gc、debounce（死代码），按 v2 实施还会加分片/迁移/GC/原子写（~200 行机制税）。v3 把存储换成 pi 原生 CustomEntry 后，`store.ts` 整体删除——业务分层不动，错的只是存储维度。"是否过于复杂"的答案取决于存储选型，而选型答案就是 §3.2。

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
  → pi.sendMessage({...}, {deliverAs:'followUp', triggerTurn:true})  ← F3/F4/F5 在此产生：
  → 注入到「当前 tick 所在的 session」                               每个 idle session 都注入一次
```

### 2.5 顺手修复点（与存储选型无关的既有问题，v3 一并处理）

| # | 问题 | 位置 | 影响 |
|---|------|------|------|
| W1 | `service.ts` 用 `Date.now()` 而非注入时间源 | service.ts:84 `computeNextRuns(..., Date.now(), 5)` | 与 runtime 全程 `backend.now()` 不一致；service 层测试无法注入固定时间 |
| W2 | widget 与 tick 两个独立 30s 定时器 | index.ts `widgetTimer` vs runtime `tickTimer` | 不同步，倒计时显示最多滞后 30s；无任务时 widgetTimer 空转 |
| W3 | store debounce persist 死代码 | store.ts `persist()`/`DEBOUNCE_MS`/`debounceTimer` | backend.ts R1 修正后统一走 persistSync，debounce 只剩测试在用 |
| W4 | tickScheduler pending 契约隐性 | runtime.ts tickScheduler 步骤 3 filter 只看 pending 不看 enabled | 靠 dispatchTask 第一行兜底，功能没错但契约需显式化 |

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

**例 2（修复后）：同 cwd 第二个 session 打开**——状态栏无 `[scheduler]` 提示。

**例 3（修复后）：任务到期**——只有创建它的 session 收到注入消息。

**例 4（失败路径 + 恢复指引）**：创建任务的 session 被删除 → 任务随 JSONL 消失（G6 结构性质，无残留）。任务在"新 session 首个 turn 内创建后进程立刻崩溃"时可能丢失（pi 延迟写入窗口，见 D5）——概率极低，无恢复手段，文档化。

### 3.2 方案对比（存储层）

| 方案 | 长期架构合理性 | 短期实现成本 | 风险 | 裁决 |
|---|---|---|---|---|
| **v3. CustomEntry 存储（选）** | 归属 = 结构性质（任务物理存在于创建 session 的 JSONL）；**复用 pi 官方持久化通道**（CustomEntry 注释原文 "Persist extension state across session reloads"），不自建存储系统；session 删任务即消、subagent 物理隔离、resume 天然继续全部免费 | 低：重放折叠 ~40 行 + fork 过滤 + 旧 store 导入（rename 收敛），替代 v2 的 ~200 行机制 | 延迟写入窗口（首 turn 建任务 + 崩溃丢任务）；fork 继承需 owner 字段过滤；依赖 pi SDK（appendEntry/getEntries 已实测存在，0.82.1） | ✅ |
| v2. session 分片文件 | 归属 = 物理文件隔离，正确但**自建存储系统**（分片路径/两步迁移/GC/原子写/降级），约 200 行机制代码；"三个月后回看"这些代码全是 v3 的债 | 中-高 | v2.1 审查已闭环但机制多；触发可达性与 v3 相同（都只随 owner session） | ❌ |
| v1. 共享文件 + owner 过滤 | 归属靠运行时过滤维持，不变量脆弱 | 高（两轮审查 6 缺陷） | 已证伪 | ❌ |

**被否方案效果**：v2 若实施，`store.ts` 将长成分片/迁移/GC/原子写四套机制（代码量从 ~1200 行涨到 ~1600 行），而 v3 核实 SDK 后这些全部不需要——v2 是"在错误的维度自建存储系统"的税。

**v2 → v3 机制消失清单**（存储层换成 pi SDK 通道后，下列机制及其代码路径全部不需要存在）：

| v2 分片要写的机制 | v3 如何消失 |
|---|---|
| sessionFile 短哈希 + 内嵌 sourceSessionFile 反查 | 任务 entry 就在 session JSONL 内，映射本身不存在 |
| 两步原子 rename 迁移（旧 store → 分片） | 旧 store 导入简化为单次 rename（见 D3） |
| 孤儿 GC（mtime 24h + existsSync 探活） | session 文件删 = 任务消失，孤儿状态物理不可能存在 |
| ephemeral 降级文件（`--no-session` 兜底） | `--no-session` 时 pi 不落盘，appendEntry 无操作，语义自动一致 |
| 唯一 tmp + rename 原子写 | pi SessionManager 统一负责写入 |
| 规则 7.5「重开可见」双链路适配 | dispatch 注入的 followUp message + custom entry 天然在 JSONL，重开即恢复 |
| store.ts 全文件（17 字段默认值 + 版本迁移兜底） | 重放折叠协议替代，store.ts 删除 |

### 3.3 关键决策与权衡

**D1：存储 = pi 原生 CustomEntry（appendEntry + getEntries 重放）**
- 选择：任务状态以 `type:"custom"` entry 写入 session JSONL，event sourcing 最小版。**关键约束：append-only 不能改旧 entry，recurring 任务 dispatch 后 nextRunAt 推进必须 append 新 entry 持久化**——否则 resume 重放回退到创建时的 nextRunAt → 重复触发（at-least-once 恶化）。协议 4 类 op（统一 customType `pi-scheduler:task`，op 字段区分；run history 不单独写 customType，由 advance 携带）：
  ```
  upsert:  appendEntry('pi-scheduler:task', { op:'upsert',  taskId, ownerSessionFile, task:{...全快照, 含 nextRunAt 初值} })
  advance: appendEntry('pi-scheduler:task', { op:'advance', taskId, nextRunAt, at, status })   // dispatch 后推进 nextRunAt + 记录本次执行
  toggle:  appendEntry('pi-scheduler:task', { op:'toggle',  taskId, enabled })
  delete:  appendEntry('pi-scheduler:task', { op:'delete',  taskId })
  ```
  重放折叠（`session_start` → `getEntries()` → 按 customType 过滤 → **per taskId 按 entry 顺序折叠**）：
  - `upsert` → `tasks[id] = {...快照}`（last-write-wins，含 ownerSessionFile / nextRunAt 初值）
  - `advance` → `tasks[id].nextRunAt = entry.nextRunAt`；`lastRunAt = entry.at`；`runCount++`；`history.push({at,status})` 并裁剪 20 条
  - `toggle` → `tasks[id].enabled = entry.enabled`
  - `delete` → 该 id 标记已删，后续该 id 的 op 忽略；once 任务 dispatch 后运行时 append delete，重放即消失
  - 末态 = per taskId 最后一个非 delete op 的结果。运行时（发起方）每次操作内存态后立即 appendEntry 对应 op，内存态与 entry 顺序一致
- 事实链（pi 0.82.1 源码实测）：`pi.appendEntry` 存在（extensions/types.d.ts:917、ExtensionActions:1165、runner.js:161 注入）；`ctx.sessionManager.getEntries()` 在 ReadonlySessionManager Pick 内（session-manager.d.ts:140）；CustomEntry 注释明示持久化用途 + "Does NOT participate in LLM context"；实现 `sessionEntryToContextMessages` 对 custom 无 case（flatMap 过滤，session-manager.js:166-186）——**任务数据零污染 LLM context**；compaction 只 append summary 不删物理 entry，getEntries 全量不受影响
- **navigate 语义实测修正**：`getEntries()` 返回全部 fileEntries（不按分支过滤，session-manager.js:980-982），navigate 只改 leafId 指针 → **任务不随 navigate 消失**（比初判行为更好）
- 运行时断言：⛔实施期门——resume 后重放任务状态与关闭前一致（探针：S5 实测）

**D2：fork 隔离——task entry 带 ownerSessionFile，重放过滤**
- 事实：`forkFrom` 复制 fork 点前的全部 entries（含 custom）到新 session 文件 → **fork 出的 session 天然继承任务副本**，若不处理会重复调度（F3 回归）
- 选择：upsert 的 task 快照内含 `ownerSessionFile`（创建时的 `ctx.sessionManager.getSessionFile()`）；重放时过滤 `ownerSessionFile !== 本 sessionFile` 的任务——fork 出的 session 不加载、不执行、不显示继承的任务；原 session（sessionFile 不变）resume 后照常
- 语义：任务归属创建 session（G2 一致）；fork 出的分支是"对话副本"而非"任务副本"
- 运行时断言：⛔实施期门——fork 后新 session 的 list 为空、任务到期不注入；原 session resume 任务仍在（探针：S11 实测）

**D3：旧 store 导入——rename 原子收敛（单成功者）**
- 选择：session_start 检测 `<cwd>/scheduler.json` 存在 → `fs.renameSync(scheduler.json, scheduler.json + '.imported')`（原子，失败 ENOENT = 别人已导入 → 跳过）→ 成功者读 `.imported` 逐任务 appendEntry upsert → 删 `.imported`
- 崩溃恢复：rename 后、删前崩溃 → `.imported` 残留 → 下次任一 session 检测到（且 `scheduler.json` 不存在）→ 读它导入自己 session → 删（幂等；与 v2 D3 同构）
- 归属语义：旧任务无 owner 信息 → 归第一个完成导入的 session（无更好近似，与 v2 一致，README 说明）
- **导入后任务立即触发语义**：旧任务若 nextRunAt 已过期，导入后首个 tick 立即 dispatch（once 立即注入、recurring 补跑）——README 说明

**D4：无孤儿状态——G6 成为结构性质**
- 不写代码：任务 entry 在 session JSONL 内，session 文件删除 = 任务消失；无分片残留、无 GC、无 mtime 保护（v2 的 D4 整节删除）
- 对比 v2 的论证负担：v2 需证明 GC 不误删活跃任务（mtime 保护 + 首 turn 窗口分析）；v3 无此机制即无此问题

**D5：延迟写入窗口——诚实标注 + 探针**
- 事实（源码实测）：`appendEntry` → `_appendEntry` → `_persist`（session-manager.js:724-731）——fileEntries 无 assistant entry 时**不落盘**（flushed=false，等 assistant 到达全量写）。因此**新 session 首个 turn 内创建的任务 entry 在进程崩溃时丢失**（窗口 = 首 turn 内 appendEntry 之后到 message_end 之间）
- 对比：v2 分片创建即写盘（独立文件），耐久性更好；v3 依赖 pi flush 时机
- 裁决：接受并文档化。窗口窄（首 turn 内 + 进程立刻崩溃）、概率极低；缓解不可行（appendEntry 无强制 flush 选项，不 hack pi 内部）。**README 明示**
- 运行时断言：⛔实施期门——探针确认窗口存在且仅限首 turn（S13/S14 实测：首 turn 建任务后立即 kill 进程 → 任务丢失；已有 assistant 消息的 session 建任务后 kill → 任务保留）

**D6：once 回显裁剪为 1 次**
- 选择：create() 中 `computeNextRuns(..., count)` 按 kind 传 1 或 5；once 文案 "Next run: in 1h"，recurring 保持 "Next 5 runs:"；`nextRuns` 数据同步裁剪。`computeNextRuns(spec, from, count)` 已有 count 参数（parsing.ts:215）
- 同步改：`tool.ts` scheduleGuidelines "next 5 run times" → "next run time(s)"（tool.ts:24）

**D7：xyz-agent 读取链路兼容（已实测，无需改动）**
- `session-history.ts`（文件路径）：白名单放行 message/compaction/custom_message/branch_summary，**`type:"custom"` 被过滤** → 历史显示不崩、不误显 ✓
- `message-converter.ts`（RPC 路径）：处理 role:'custom'（那是 CustomMessage 的 role，与 CustomEntry 不同路径）✓
- 结论：xyz-agent 对 custom entry 零感知。仍补一条验收（S15）验证 dev app 打开含 custom entry 的 session 历史正常
- 运行时断言：⛔实施期门——dev app 中打开含任务 entry 的 session，历史列表无异常条目（探针：S15 实测）

**D8：顺手修复四项（W1-W4）**
- W1：service 构造接收 `now` 函数（runtime 透传 `backend.now()`），create() 的 `computeNextRuns(..., Date.now(), 5)` 改注入时间源
- W2：runtime 暴露 `onAfterTick` 回调，index.ts 注册 refreshWidget，删除独立 widgetTimer
- W3：删除 store.ts 的 debounce 死代码（v3 下 store.ts 整体由 importer 模块替代，debounce 随文件删除）
- W4：tickScheduler 步骤 3 filter 显式加 `t.enabled`，契约自文档化（不依赖 dispatchTask 兜底）。**pending 标记保留**：它表达"已到期但 dispatch 未成功"（busy / rate-limited 时 `return false` 不清 pending，下个 tick 重试），与 enabled 过滤正交——单阶段遍历 Set 也能防同一 tick 内重复 dispatch，但 pending 额外支撑跨 tick 的重试语义，故不删

**D9：README 产品定位与语义**
- 任务归属创建它的 session；**只在 owner session 打开时触发**（每天开新 session 的用户，昨天建的"明早检查 CI"不会响，除非 resume）——显著位置写明，防止"任务丢了"误报
- **非系统 cron**：pi 进程不开 = 不触发；电脑睡眠 = 不触发。产品定位 = "session 存活期间的 AI 提醒器"
- **at-least-once**：dispatch 成功后内存更新 nextRunAt，appendEntry 在 dispatch 后立即执行（窗口缩小到 append 之前）；进程崩溃可能重复注入一次——可接受，README 写明
- once 任务忽略 expires 参数（现状语义，文档化）

**D10：session JSONL 增长控制（custom entry append-only 必然增长）**
- 事实：custom entry append-only（pi 依赖 JSONL 物理保留维持 session tree 的 parentId 链），scheduler 无法物理删除旧 entry。每个任务 = 1 upsert + 每次 dispatch 1 advance + toggle/delete。recurring `1h` 任务运行一年 ≈ 8760 条 advance（~100B/条 ≈ 876KB），长期 session 累积可观
- 影响面：① custom entry 不进 LLM context（D1 已实测），**不影响 token / 模型上下文**；② session JSONL 文件增大，pi 文件读取与 xyz-agent `session-history.ts` 解析成本随文件增长（但相对对话消息本身的体量，scheduler entry 占比很小）；③ pi 原生 TUI 历史/树视图节点增多（见 D11）
- 裁决：**不做物理裁剪**（append-only 天然约束 + pi 依赖物理保留）；advance entry 是 nextRunAt 正确性的必要记录，不可省；history 内存裁剪 20 条（现状，重放时同样裁）。量级可接受，README 注明"长期 session 的 scheduler entry 会累积"。未来若成问题，方向是等 pi 提供 compaction hook（现未对 custom entry 提供），不是本 extension 自建裁剪
- 运行时断言：⛔实施期门——长期 session 文件增量在可控范围（探针：S17 实测连续 dispatch 后文件增量）

**D11：pi 原生 TUI 的 custom entry 渲染（registerEntryRenderer）**
- 事实：pi 提供 `pi.registerEntryRenderer(customType, renderer)`——在 pi CLI 原生 TUI 的树/历史视图里自定义 custom entry 的显示形态。不注册时 TUI 对 custom entry 使用默认渲染（可能显示 raw 字段或空行）
- 影响面：**仅 pi CLI 原生 TUI 用户受影响**。xyz-agent 走自有前端，`session-history.ts` 白名单过滤 custom entry（D7 已实测零感知），不受影响
- 裁决：**v3 第一版不注册 renderer**（保持聚焦于存储迁移，renderer 是体验增强非正确性需求）。留为后续可选增强：注册后可让 pi CLI 用户看到友好格式（如 `[scheduler] task created: git pull... → in 1h` / `→ ran at 10:30 ✓`）。当前 TUI 默认渲染可接受（custom entry 不崩、不污染 context）
- 不注册的已知后果：pi CLI 用户在历史视图看到 scheduler custom entry 显示为默认/raw 形态——README 不强调（xyz-agent 是主场景）

---

## §4 验收（真实场景）

> 验收环境：本地 pi CLI（`pi --mode rpc --session-dir <dir> --model xiaomi-token-plan-cn/mimo-v2.5-pro --approve --extension <scheduler 路径>`）+ stdin JSONL 发 `prompt` 命令，配合 `PI_EXT_DEBUG=1` 检查 `~/.pi/agent/logs/` 扩展日志。多 session 场景用两个独立 pi 进程（同 cwd、同 session-dir 分别指定不同 session 文件）。测试模型用 mimo-v2.5-pro（AGENTS.md 规则：禁止 kimi 做测试）。

| # | 场景（谁/做什么/看到什么） | 步骤 | 通过标准 | 回溯目标 |
|---|---|---|---|---|
| S1 | 用户在 session A 创建 `kind:"once", schedule:"1h"` 任务 | A 中调 schedule tool；读回显 | 回显含 `Next run: in 1h` 且**仅 1 条** run 行；不含 `Next 5 runs:` | G1 |
| S2 | 用户在 session A 创建 `kind:"recurring", schedule:"10m"` 任务 | A 中调 schedule tool；读回显 | 回显仍含 `Next 5 runs:` 且 5 条 | G1（不回归） |
| S3 | session A 有 1 个任务，用户同 cwd 打开 session B | 启动 B，观察状态栏；B 中调 schedule_control list | B 状态栏**无** `[scheduler]` 提示；B 的 list 返回 "No scheduled tasks." | G2 |
| S4 | session A 创建 `schedule:"1m"` 任务，A、B 同 cwd 同时打开且都空闲 | 等 1 分钟到期 | A 收到注入消息；B 全程无消息注入；A 中 list 不再显示该任务（once 已删） | G2、G5 |
| S5 | session A 创建任务后**关闭 A**；到期后 resume A | 重开 A（同 session 文件），**保持空闲** | 任务仍在 A 的 list 中（重放恢复）；A 空闲后的首个 tick 收到注入消息 | G3 |
| S6 | 升级前已有旧任务（cwd 共享 scheduler.json），升级后打开 session A | 预置旧 store 文件；启动 A | A 的 list 显示该任务；`scheduler.json` 已 rename 为 `.imported` 后删除；任务 entry 已写入 A 的 JSONL（cat 核对 customType=pi-scheduler:task）；任务到期只在 A 触发 | G4 |
| S7 | 同一任务在 A 中创建后，A 忙（streaming）期间到期 | A 创建 `schedule:"1m"` 任务后立即让 A 持续输出；B 同时空闲 | 到期时 B 不触发；A 空闲后的下一个 tick 触发 | G2、G5 |
| S8 | session A 创建任务后，同 cwd 启动一个后台 subagent（走 extension 加载） | A 建任务；派 subagent；等任务到期 | 任务只注入 A；subagent 的 list 返回 "No scheduled tasks."；subagent 退出后 A 的任务仍在且可触发 | G2、G5 |
| S9 | 删除 session A 的 session 文件，重启 session B（同 cwd） | 手动 rm A 的 session 文件；启动 B | A 的任务**不存在**（随 JSONL 消失，无残留文件、无 GC 需要）；B 的 list 为空 | G6 |
| S10 | 预置旧共享 store（含无主任务），两个 pi 进程**并发**启动 | 预置旧 store；同时启动 A、B | **仅一个 session 导入该任务**（rename 原子独占）；cat 双方 JSONL：任务 entry 只在 winner 的 session 里；到期触发次数 = 1 | G4、G5 |
| S11 | **fork 隔离**：session A 创建任务后 fork 出新 session | A 建任务；在 A 中执行 /fork 或 forkFrom；观察新 session | fork 出的 session list 为空、任务到期不注入（owner 字段过滤）；原 session A resume 任务仍在 | G2、G5 |
| S12 | **重放正确性**：A 中 upsert/advance/toggle/delete 多次后关闭重启 | A 建 recurring 任务 → 等 dispatch（append advance）→ toggle off/on → 删 → 再建 → 关闭 → resume | resume 后 list 只显示最后存在的任务；**recurring 任务 nextRunAt = advance 后的值（非创建初值，不回退）**；history 折叠 ≤20 条；delete 过的任务不复活 | G3、G5 |
| S13 | **延迟写入窗口探针**：新 session 首 turn 建任务后 kill 进程 | A 全新启动，首个 prompt 里建任务（不等 message_end）；kill 进程 | **记录行为**：任务丢失（窗口存在，README 已明示）——通过标准 = 行为与文档一致，不 panic | G3（已知例外） |
| S14 | **窗口外耐久**：已有 assistant 消息的 session 建任务后 kill 进程 | A 正常对话后建任务；kill 进程；resume A | 任务保留（entry 已落盘） | G3 |
| S15 | **xyz-agent 兼容**：dev app 打开含任务 entry 的 session | 用 pi 建任务；xyz-agent dev app 打开同一 session；看历史 | 历史列表正常显示、无 custom entry 误显、不崩（session-history 白名单过滤） | G2（生态兼容） |
| S16 | 同一 session 双开（两个进程 resume 同一 session 文件），任务到期 | 两个进程加载同一 session；等任务到期 | 记录行为：可能双触发（Out-of-scope，与现状一致）——**文档化，不修** | G5（已知例外） |
| S17 | **entry 增长探针**（D10）：recurring 任务连续 dispatch 后看 JSONL | A 建 `schedule:"1m"` 任务；连续 dispatch 10 次（或加速 mock tick）；cat A 的 session JSONL | custom entry 数 = 1 upsert + 10 advance（线性增长）；文件增量 ≈ 1KB 量级，可控；advance entry 含 nextRunAt 字段且逐条递增 | D10 |

单测补充（不替代上述真实场景，只锁实现细节）：once 回显 1 条断言（service.test.ts）；重放折叠（upsert/advance/toggle/delete 折叠正确性、nextRunAt 重放恢复、fork owner 过滤）；旧 store 导入 rename 单成功；延迟写入探针 mock（backend 注入 fake flush 时序）；时间源注入（service 固定 now 断言回显）。

---

## §5 下一层拆分

### 实施路径（按依赖序，每步可独立验证）

1. **once 回显 + W1 时间源**（独立，先行）：`service.ts` create() 按 kind 裁剪 + now 注入 → `tool.ts` guidelines 文案 → `service.test.ts`
2. **CustomEntry 存储**（核心，单一 commit）：`backend.ts` 废弃全量 persist，loadTasks 改委托 `replay.ts`（`getEntries()` 重放折叠）；`runtime.ts` 在 addTask/toggle/delete/dispatch 成功后按 op 调 `pi.appendEntry`（upsert/toggle/delete/advance）；新增 `replay.ts`（折叠协议 + fork owner 过滤）；`runtime.ts` 挂 onAfterTick（W2）与 enabled 显式过滤（W4）；`index.ts` session_start 重放装配 + widget 改 tick 回调
3. **旧 store 导入**（数据层）：`importer.ts`（rename `.imported` 原子收敛 + 崩溃恢复 + 逐任务 upsert）；删除 `store.ts`（W3 死代码随文件消失）
4. **文档**：`README.md` 产品定位与语义（D9）
5. **真实环境实测**：§4 S1-S17 全场景跑通

### 拆分理由

- 1 与 2 无依赖：once 回显是纯显示层修复，可独立合入；W1 时间源是 service 层内小改，同 commit
- 2 先行于 3：重放是存储核心，导入依赖 appendEntry 通道；2+3 同属存储迁移，但 3 可独立验收（S6/S10）故独立 commit
- 5 必须最后：所有行为修复只有真实 pi 环境能验证

### 文件改动地图

| 文件 | 改动 |
|---|---|
| `src/backend.ts` | loadTasks → 委托 replay（经 ctx.sessionManager.getEntries()）；persist 废弃（改由 runtime 按 op 调 pi.appendEntry）；now 注入不变 |
| `src/replay.ts`（新增） | 折叠协议（upsert/advance/toggle/delete，含 nextRunAt 重放恢复）+ fork owner 过滤 |
| `src/importer.ts`（新增） | 旧 store 导入（rename 原子收敛 + 崩溃恢复） |
| `src/runtime.ts` | dispatchTask 成功后 append advance entry（D1）；toggle/delete 时 append 对应 op；挂 onAfterTick（W2）；tickScheduler enabled 显式过滤（W4） |
| `src/service.ts` | create() 按 kind 裁剪 + now 注入（W1） |
| `src/tool.ts` | scheduleGuidelines 文案 |
| `src/index.ts` | session_start 重放装配 + widget 改 tick 回调（W2） |
| `src/store.ts` | **删除**（W3 死代码随文件消失，store.test.ts 相应删除/迁移） |
| `src/__tests__/*` | service.test.ts（once 断言 + 时间源）；replay.test.ts（新增）；importer.test.ts（新增）；runtime.test.ts（onAfterTick/enabled） |
| `README.md` | 产品定位与语义（D9） |

### 待验证检查点（设计阶段无法确定，诚实标注）

- **V1**：D1 重放时序——`getEntries()` 在 session_start 时是否已包含磁盘全部 entry（含上次会话 append 的），实测 S5/S12 确认
- **V2**：D2 fork 场景——forkFrom 复制 custom entry 的确切行为（复制范围 = fork 点之前全部？），S11 实测记录
- **V3**：D5 延迟写入窗口——S13/S14 实测确认窗口边界（首 turn 内丢失、已有 assistant 后保留）
- **V4**：`pi.appendEntry` 在 RPC mode 下可用性（xyz-agent 集成场景），S15 实测确认
- **V5**：advance 重放恢复 nextRunAt 的正确性——`getEntries()` 返回的 custom entry 顺序与 append 顺序一致，且 advance 的 nextRunAt 字段被折叠逻辑正确取用，S12 实测确认
