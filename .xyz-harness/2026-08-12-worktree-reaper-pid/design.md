# 设计文档：pi-subagent-workflow worktree reaper 误清活 worktree 修复

> 层性质声明：本文档为**技术方案层**（下一层产物 = 可实现的代码改动 + 测试用例）。涉及运行时行为与数据流，准则 5/6/7 全适用。
> 被修复对象：`extensions/subagent-workflow`（pi extension，本仓库维护）。同步配套 `extensions/cw-tool` 的错误消息改进。

---

## 1. 背景目标

**结论：pi-subagent-workflow 的 worktree orphan reaper 会在 RPC mode 下误清所有存活超过 60 秒的活 worktree，导致子进程 cwd 指向已删除目录、所有基于 cwd 的操作（spawn 子进程、bash 工具）返回 ENOENT。根因是一处接线错误：pid 补全代码挂在了一个 RPC mode 下永不执行的分支里。修复方向：把 pid 补全挪到 `spawn()` 返回后同步执行，并补齐端到端测试与可操作错误消息。**

### SCQA 开篇

- **情境**：pi-subagent-workflow 扩展支持 `worktree: true` 的子 agent 隔离模式——为每个子 agent 在 `os.tmpdir()/pi-subagents/<enc-cwd>/` 下创建 git worktree checkout，子进程以该目录为 cwd 运行，互不干扰文件系统。递归编排（pi-cw）大量依赖此模式：wave-agent 全部 `worktree: True`。
- **冲突**：2026-08-11 生产事故（session `019ff075-fdd2-7b39-a22a-f79e54ff4419`）中，4 个 wave-agent 的 worktree 在其启动约 64 秒后被扩展自带的 orphan reaper 删除，wave-agent 进程的 `process.cwd()` 指向虚空，`cw_wave` 内部 `spawn("cw", {cwd})` 全部 ENOENT，cw 递归编排从 wave 叶子层逐级枯萎至整树失活，烧掉 3.27M token 的诊断 subagent 全部南辕北辙。
- **疑问**：reaper 本应只清理「孤儿」（进程已死的 worktree），为什么把活进程的 worktree 也删了？为什么此前低频场景从未暴露？
- **回答**：reaper 的孤儿判据是「pid 死活」。worktree 创建时注册表条目 pid=0 占位，设计意图是 spawn 子进程后在 first header 时补全真实 pid。但**唯一的生产补全调用点挂在 `parsed.kind === "header"` 分支里，而 RPC mode（唯一实际使用的 mode）从不输出 header 行**——pid 永远补不上，恒为 0。`pid === 0 && 超 60s 宽限 → 判孤儿`，所以**任何存活超过 60 秒的 worktree 都是待决死刑犯，下一次任意 session_start 触发的 scan 就是行刑**。这不是竞态，是确定性行为。低频场景（偶尔 1 个 subagent、5 分钟内跑完）恰好避开 60s 阈值；cw 递归编排的高频并发 spawn 把它变成必然爆发。

### 设计目标

1. **活 worktree 永不被误清**：存活子进程的 worktree 目录在其生命周期内必须存在（这是本修复的核心验收点）
2. **真孤儿仍被回收**：进程崩溃/正常退出未 cleanup 的 worktree 仍由 reaper 回收，不引入泄漏
3. **错误消息可操作**：cwd 不存在导致的 ENOENT 必须指明 cwd 路径与恢复动作，杜绝「node 被卸载」类误诊
4. **结构性测试盲区闭合**：pid 补全链路必须有端到端测试，不再依赖 mock 掩盖

### In / Out of Scope

- **In**：`extensions/subagent-workflow` 的 worktree pid 注册时序修复；`extensions/cw-tool` 的 spawn ENOENT 错误消息改进；配套测试
- **Out**：3 个 slice planning-agent record 缺失问题（独立立项，与 reaper 无同源证据）；wave-agent 工具白名单调整（可选跟进项，见 §5）

---

## 2. 现状与问题分析

### 2.1 使用者视角的现状

递归编排的 wave-agent（`worktree: True`）启动后：

```
主进程 subagent-service
  └─ worktreeManager.create(cwd, recordId)
       ├─ git worktree add -b pi-sub-<recordId> <tmpdir>/pi-subagents/<enc>/pi-sub-<recordId>
       ├─ 注册表 worktrees.json 写入 {branch, checkout, pid: 0, createdAt}   ← pid 占位
       └─ 返回 handle
  └─ runSpawn → spawn(pi, ["--mode","rpc", ...], { cwd: worktree.path })
       └─ child.pid 同步可得（Node.js spawn() 返回后立即可读）
```

子进程以 worktree checkout 为 cwd 运行数分钟到数小时（wave-agent 跑设计/编码/审查全流程）。期间主进程与**每个子进程**（子进程镜像主进程 `--extension` flag，见 `session-runner.ts` buildSpawnArgs 的 mirrorFlags）的每次 `session_start` 都触发 reaper `scan()`（`index.ts:295`）。

### 2.2 根因：pid 补全挂在永不执行的分支

**核心事实（全部经源码核实，非推理）**：

| 事实 | 位置 | 核实 |
|---|---|---|
| 注册表条目 pid=0 占位，注释「session-runner first header 时补 pid」 | `worktree-manager.ts` create() → `registry.add({..., pid: 0})` | ✅ 属实 |
| `registerPid` 唯一生产调用点在 `if (parsed.kind === "header")` 分支内 | `session-runner.ts:811, 829-832`：`ctx.onWorktreePid?.(opts.worktree.branch, child.pid)` | ✅ 属实 |
| 该分支注释原文：「buildSpawnArgs 固定 --mode rpc，RPC mode 不发 header——此分支当前不触发，仅为未来 mode 回切（如 json mode 调试）保留」 | `session-runner.ts:834-836` | ✅ 属实，作者自己标注了不触发 |
| `buildSpawnArgs` 固定 `--mode rpc`（实际唯一使用的 mode） | `session-runner.ts:481` | ✅ 属实 |
| RPC mode 不输出 header 行（只有 json/print mode 输出） | `spawn-event-adapter.ts` 头部注释 | ✅ 属实 |
| `child.pid` 在 `spawn()` 返回后同步可得，无需等任何 stdout | `session-runner.ts:719` | ✅ 属实（Node.js ChildProcess.pid 同步属性） |
| reaper 判据：`pid === 0 && now - createdAt > SPAWN_GRACE_MS(60_000)` → 孤儿 | `worktree-manager.ts` isOrphan() | ✅ 属实 |
| reaper 每次 session_start 触发 | `index.ts:295`（session_start hook 内） | ✅ 属实 |
| 清理动作：`git worktree remove --force` + `branch -D` + 注册表移除 | `worktree-manager.ts` cleanupOrphan() | ✅ 属实 |
| 接线：`onWorktreePid → worktreeManager.registerPid` | `subagent-service.ts:1052` | ✅ 属实，接线本身正确，断点在调用侧 |

**机制推演**：`create()` 写 pid=0 → spawn 后本应补 pid，但补全代码在 header 分支（永不触发）→ pid 恒为 0 → 60 秒后 `isOrphan` 恒真 → 下一次任意进程的 `scan()`（主进程或子进程的 session_start 都触发）删除该 worktree。**只要 worktree 存活超过 60s，被删是必然事件，不是概率事件。** 事故中 wave-agent 11:50:42 启动、11:51:46 报 cwd 不存在，间隔 64 秒，与 60s 宽限吻合。

### 2.3 为什么是「确定性死亡」而非「竞态窗口」

handoff 原诊断称「registerPid 异步补全的竞态窗口内被误判」。**该诊断保守了**：不存在「补得慢」的竞态——RPC mode 下补全代码**一次都不会执行**，pid 从写入注册表那一刻起就是 0。这不是收窄窗口能解决的，必须让补全路径真正可达。这个区分直接决定方案选型（见 §3）：补丁式「加锁/二次确认」都是在给一个永不发生的补全加护栏，方向错了。

### 2.4 为什么长期没炸

reaper 触发点 = 任意 session_start。低频场景（偶尔 1 个 background subagent）下，subagent 通常 5 分钟内跑完并正常 cleanup（`finalize-record.ts:121`），在 60s 宽限内完成生命周期，pid=0 条目被正常移除，reaper 没有机会行刑。cw 递归编排是首个「4+ 个 worktree:True 子进程并发、单个 wave 任务远超 60s、期间不断有新的 session_start」的场景，把潜伏 bug 变成必然爆发。

### 2.5 物理数据流（现状，含故障点）

```
[主进程] subagent-service.execute
  │ ① create(cwd, recordId)
  │    ├─ git worktree add -b pi-sub-<id>  $TMPDIR/pi-subagents/<enc>/pi-sub-<id>
  │    ├─ worktrees.json ← {branch, checkout, pid: 0, createdAt}      [F1: pid 占位 0]
  │    └─ handle
  │ ② runSpawn → spawn(pi --mode rpc, {cwd: worktree.path})
  │    └─ child.pid 同步可得 ──→ 应该 registerPid，实际代码在 header 分支  [F2: 接线错误]
  │ ③ child.stdout 事件流：RPC mode 只有 event/response，无 header     [F3: 永不触发]
  ▼
[任意进程（主/子）] session_start hook
  │ ④ wtm.scan() → 遍历 worktrees.json
  │    └─ isOrphan: pid===0 && now-createdAt > 60s → true
  │       └─ git worktree remove --force + branch -D + 注册表移除       [F4: 误杀活 worktree]
  ▼
[wave-agent 子进程] 仍存活
  │ ⑤ process.cwd() 指向已删除目录
  │ ⑥ 任何 spawn(cw, {cwd}) / bash 工具 → ENOENT                      [F5: 整树失活]
```

### 2.6 现有测试为什么没拦住

`session-start-reaper.test.ts:52`、`crash-recovery.test.ts:72`、`index-session-start.test.ts:119` 全部 `registerPid = vi.fn()` mock。单测验证的是「mock 了补全回调后的 reaper 行为」，从未验证「真实调用链中补全回调是否被调用」。这是结构性的测试盲区：**任何把补全挂错位置的接线错误，现有测试层级永远无法发现**。

---

## 3. 解决方案

**结论：把 pid 补全从 header 分支移到 `spawn()` 返回后立即同步执行（保留 create 的 pid=0 占位作为崩溃兜底），`SPAWN_GRACE_MS` 语义收窄为「create 后 spawn 前崩溃」的回收兜底；同步改进 cw-tool 的 ENOENT 错误消息；补端到端测试。**

### 3.1 终态（修复后行为）

**成功路径**：`create()` 写 pid=0 占位 → `spawn()` 返回后**同一事件循环内**立即 `registerPid(branch, child.pid)` → 注册表条目 pid 从 0 变为真实 pid（毫秒级，宽限期完全覆盖）→ reaper 的 `isProcessAlive(pid)` 判活 → 活 worktree 永不被清。子进程正常完成 → finalize 时 cleanup 正常回收。

**崩溃路径**：`create()` 后、`spawn()` 前进程崩溃 → 条目 pid=0 超 60s → reaper 回收（这正是 SPAWN_GRACE_MS 存在的意义，语义未破坏）。`spawn()` 抛错（如 pi 二进制缺失）→ 调用链已有 cleanup 兜底（`finalize-record.ts` 对 worktreeHandle 统一 cleanup）。

**失败路径（cwd 不存在）**：`cw_wave` 等工具 spawn cw 前检查 cwd，不存在时返回可操作错误：

```
cwd 不存在：/var/folders/.../T/pi-subagents/.../pi-sub-sa-xxx
该 worktree 可能已被 orphan reaper 清理，或子 agent 已结束。
恢复：1) 检查 ~/.pi/agent/subagents/worktrees.json 中该 branch 的 pid 是否已补全；
      2) 若子 agent 仍在运行，重新派发（worktree 重建）；3) 若已结束，忽略此错误。
```

### 3.2 方案对比

| 方案 | 做法 | 长期架构合理性 | 短期实现成本 | 风险 |
|---|---|---|---|---|
| **A（推荐）** 补全点前移 | `session-runner.ts` spawn 返回后立即调 `ctx.onWorktreePid?.(...)`（与 header 分支调用并存，幂等）；保留 create 的 pid=0 占位与 SPAWN_GRACE_MS（收窄为 create→spawn 崩溃兜底） | 高：补全路径真实可达，pid=0 窗口从「分钟级/永不」缩到「毫秒级」，符合「占位 + 宽限」原设计意图；json mode 回切时 header 调用仍生效 | 极低：~5 行改动，无接口变更 | 低：updatePid 幂等（同 branch 覆盖写），双调用点无副作用 |
| **B** 消除 pid=0 状态 | create 不写注册表，spawn 后 add 真实 pid；SPAWN_GRACE_MS 退役 | 中：理念「让非法状态不可表示」正确，但 create→spawn 之间崩溃时注册表无条目 → **worktree 泄漏且 reaper 永远找不到**（现有崩溃兜底被破坏），需要另建泄漏回收机制 | 中：create 与 spawn 在两个文件，需处理 spawn 失败路径的显式 cleanup | 高：引入新的泄漏路径，需额外设计回收，收益（毫秒级窗口）与方案 A 相同 |
| **C** reaper 二次确认 | scan 遇 pid=0 超宽限时先检查 checkout 目录是否被进程持有（lsof/proc）再删 | 中：作为 defense-in-depth 有价值，但**它治的是「判错了怎么办」，主修复应该是「不会判错」**；且 lsof 跨平台差异（macOS/Linux）带来新维护面 | 中 | 中：主修复缺失时二次确认仍可能漏（lsof 不可用平台） |
| **D** 引用计数/flock | 子进程持有 worktree cwd 时加锁，reaper 遇锁跳过 | 低：pid 同步可得后 flock 边际价值为零；引入跨进程锁的新失败模式（死锁/锁泄漏） | 高 | 高：过度设计 |

**推荐 A**：补全路径真实可达（根治），保留现有崩溃兜底语义（不引入泄漏），改动最小。若用它替代 B：B 的「create 后崩溃泄漏」问题在 A 中不存在——A 保留了 create 写 pid=0 的占位，崩溃仍由宽限回收。

### 3.3 关键决策与权衡

**决策 1：pid 补全点 = spawn() 返回后同步执行（方案 A 核心）**

- 选择：`const child = spawn(...)` 后立即 `if (opts.worktree && child.pid) ctx.onWorktreePid?.(opts.worktree.branch, child.pid)`。保留 header 分支原调用（json mode 回切时仍能补，幂等无害）。
- 被否：仅收窄宽限（治标）、加锁（D，过度设计）、create 不写注册表（B，破坏崩溃兜底）。
- 证据：`child.pid` 是同步属性（Node.js 文档：spawn 成功返回后 pid 立即可用；失败时 undefined）。原代码把同步可得的数据挂到异步事件上，是本 bug 的全部根源。探针（实施期）：单测断言 spawn 返回后 `worktrees.json` 条目 pid === child.pid。

**决策 2：SPAWN_GRACE_MS 保留，语义收窄**

- 选择：保留 `60_000` 常量与 `isOrphan` 的 pid=0 分支，注释更新为「create 后 spawn 前崩溃的回收兜底」。触发即说明 create 后进程崩溃，此时删除是正确的。
- 被否：退役（方案 B 配套）——会失去 create→spawn 崩溃回收，引入泄漏。
- 权衡：修复后 pid=0 窗口仅存在于 create 返回与 spawn 返回之间（毫秒级），宽限 60s 远大于窗口，永不误伤；同时保留崩溃兜底，两条语义都成立。

**决策 3：测试策略 = 真实 spawn 集成测试 + 现有单测增强**

- 选择：新增集成测试（vitest）：真实 `spawn` 一个最小 RPC 子进程（mock pi 脚本即可，`--mode rpc` + 输出几行 event JSON 后退出），`opts.worktree` 传入真实创建的 worktree handle → 断言 spawn 返回后注册表条目 pid 已补全 → `vi.useFakeTimers()` 推进 60s+ → 触发 `scan()` → 断言活 worktree 未被清（checkout 目录仍存在）。
- 被否：只加单测断言 registerPid 被调用（仍是 mock 层，无法防接线错误回归）；手工复现脚本（不可进 CI）。
- 证据：现有 4 个测试文件全部 mock `registerPid`，接线错误零检测能力（§2.6）。探针（实施期）：新测试先红（当前代码下 spawn 后 pid 仍为 0、scan 后目录消失）再绿（修复后）。

**决策 4：cw-tool spawn 错误可操作化**

- 选择：`cw-spawn.ts` 的 `defaultCwSpawner` 在 `spawn` 前 `fs.existsSync(cwd)` 检查，不存在时返回含 cwd 路径 + 恢复指引的错误；`session-runner.ts` 的 spawn error handler（`child.on("error")`）同样把 `spawnCwd` 拼进错误消息（当前 ENOENT 只报 command 名，不报 cwd——本次事故 glm-5.2 误诊「node 被卸载」的直接原因）。
- 被否：只改 cw-tool 不改 session-runner（spawn 层同样有误导，同类问题同修）。
- 依据：AGENTS.md「错误信息必须可操作」：错误 → 权威源（worktrees.json）→ 重试闭环。

**决策 5：reaper 二次确认（方案 C）不纳入本次主修复**

- 选择：本次不做；在 reaper 清理孤儿时补一条 warn 日志（含 branch/checkout/pid/createdAt），作为未来诊断线索。
- 被否：作为主修复——主修复后 pid=0 仅表示崩溃孤儿，二次确认无区分度（活 worktree 的 pid 已补全，不会再走 pid=0 分支）；lsof 跨平台成本高。
- 权衡：若未来 pid 补全再次断链，warn 日志 + 端到端测试（决策 3）已提供检测面，不必现在引入平台相关代码。

---

## 4. 验收

> 验收 = 实施后在真实场景验证，不是单测/mock。以下场景全部回溯 §1 设计目标。

### 场景 1（目标 1+2）：本地 pi CLI 真实复现——活 worktree 不被清、真孤儿仍被回收

**验证场景**：本地 pi CLI（非 xyz-agent）加载修复后的 `extensions/subagent-workflow` + `extensions/cw-tool` 源码（dev-link 或 `--extension` 直接指定路径），模型 `xiaomi-token-plan-cn/mimo-v2.5-pro`。派一个 `worktree: True` 的子 agent，任务 = 「sleep 90 秒后写入一个标记文件」。期间制造 ≥2 次额外的 session_start（如再派一个短命子 agent）。

**步骤**：
1. `pi --mode rpc --session-dir /tmp/repro --model xiaomi-token-plan-cn/mimo-v2.5-pro --approve --extension <subagent-workflow-path> --extension <cw-tool-path>`，stdin 发 prompt 派 worktree:True 长任务
2. 子 agent 启动后立即读 `~/.pi/agent/subagents/worktrees.json`，确认条目 pid 已从 0 变为真实 pid（探针 1）
3. 等待 90 秒（超过 60s 宽限），期间触发额外 session_start
4. 检查 `$TMPDIR/pi-subagents/<enc>/pi-sub-<id>/` 目录仍存在（探针 2），子 agent 完成后标记文件存在（探针 3）

**通过标准**：探针 1 中 pid ≠ 0；探针 2 目录存在（活 worktree 未被误清）；探针 3 任务正常完成。反向场景：手动 kill 子进程后触发 session_start，60s+ 后该 worktree 被 reaper 回收（真孤儿仍删）。

### 场景 2（目标 1）：集成测试——真实 spawn + fake timers

**验证场景**：`extensions/subagent-workflow` 内新增集成测试（vitest），真实 spawn 最小 RPC 子进程 + 真实 worktree 创建。

**步骤**：`npx vitest run execution/__tests__/worktree-pid-registration.integration.test.ts`（或按仓库测试惯例命名）。

**通过标准**：测试在修复前红（pid 恒 0、scan 后 checkout 消失）、修复后绿（pid 补全、scan 后目录健在）；含反向用例（子进程退出后 scan 回收）。

### 场景 3（目标 3）：cwd 不存在时的可操作错误

**验证场景**：真实删除一个 worktree 目录（模拟 reaper 误删后的状态），然后调用 cw 工具（`cw_wave` 或任意 spawn cw 的路径）。

**步骤**：`rm -rf $TMPDIR/pi-subagents/<enc>/pi-sub-<id>` → 在 cwd 指向该目录的子进程内调 `cw_wave`（或直接调 `defaultCwSpawner` 的集成场景）。

**通过标准**：错误消息包含**完整 cwd 路径**（非仅「cw: ENOENT」）+ 恢复指引（查 worktrees.json / 重新派发）；错误经对话流展示给用户后，用户能据此判断是「worktree 被清」而非「环境坏了」。

### 场景 4（目标 4）：回归基线——现有单测全绿

**验证场景**：全量扩展测试。

**步骤**：`pnpm extensions:test`（仓库标准命令，`extensions/` 全部包 vitest）。

**通过标准**：exit 0。新增/修改的测试不破坏现有 4 个 mock registerPid 的测试（它们验证的 reaper 判据逻辑本身仍正确）。

---

## 5. 下一层拆分

> 拆分原则：每项可独立提交、独立验收，且尽量呼应 §4 验收场景。

### Task 1：pid 补全点前移（核心修复，~5 行）

- **改动**：`extensions/subagent-workflow/src/execution/session-runner.ts`，在 `const child = spawn(...)` 之后（约 719 行后、stdout handler 注册前）插入同步补全：
  ```ts
  // [reaper-fix] RPC mode 不输出 header，原补全点（header 分支）永不触发。
  // spawn 返回后 pid 同步可得，立即补全；header 分支调用保留（json mode 回切兜底，幂等）。
  if (opts.worktree && child.pid) {
    ctx.onWorktreePid?.(opts.worktree.branch, child.pid);
  }
  ```
- **同时**：更新 `worktree-manager.ts` create() 与 `worktree-registry.ts` 中「first header 时补 pid」的注释为「spawn 返回后同步补 pid」；`worktree-manager.ts` scan() 的 pid=0 分支补 warn 日志（含 branch/checkout/createdAt）。
- **验收**：§4 场景 1 探针 1、场景 2。
- **justification**：这是本 bug 的唯一根治点——让补全路径真实可达。其余 Task 均不解决「pid 永不补全」本身。

### Task 2：端到端集成测试（堵结构性盲区）

- **改动**：`extensions/subagent-workflow/src/execution/__tests__/` 新增集成测试：真实 spawn 最小 RPC 子进程（可用 `process.execPath` + 内联脚本或 mock pi 脚本，输出 `{"type":"event",...}` 几行后退出）+ `worktreeManager.create()` 真实建 worktree → 断言 spawn 返回后注册表 pid 已补全 → `vi.useFakeTimers()` 推进超 SPAWN_GRACE_MS → `scan()` → 断言 checkout 目录存在；反向：子进程退出后 scan 回收。
- **验收**：§4 场景 2。
- **justification**：现有测试全 mock `registerPid`（§2.6），接线错误零检测能力。此测试是唯一能防同类回归的层级，先红后绿验证其有效性。

### Task 3：cw-tool + session-runner spawn 错误可操作化

- **改动**：
  - `extensions/cw-tool/src/cw-spawn.ts` `defaultCwSpawner`：spawn 前 `fs.existsSync(cwd)`，不存在时返回含路径 + 恢复指引的错误（§3.1 的失败路径文案）
  - `extensions/subagent-workflow/src/execution/session-runner.ts` `child.on("error")`：错误消息拼接 `spawnCwd`（当前 ENOENT 只报 command 名）
- **验收**：§4 场景 3。
- **justification**：本次事故「烧 3.27M token 误诊」的直接原因是错误消息无 cwd 信息；同类 spawn 层错误同修，遵循「错误 → 权威源 → 重试」闭环。

### Task 4（可选跟进，不阻塞主修复）：wave-agent 工具白名单

- **改动**：`extensions/cw-tool/agents/wave-agent.md` 增加只读 bash（pwd/ls/which，禁止写）。
- **验收**：wave-agent 遇环境故障可自证 cwd/PATH，而非靠 LLM 推理误判。
- **justification**：本次事故 wave-agent 因无 bash 只能盲猜环境问题。独立小改，与 reaper 无耦合，可后置。

### 拆分顺序与依赖

```
Task 1 → Task 2（验证 Task 1 的先红后绿，依赖）→ Task 3（独立）→ Task 4（独立，可后置）
```

**待验证检查点**（设计阶段无法确定、实施期确认）：
- spawn 失败时 `child.pid` 的确切值（undefined）——Task 1 的 `child.pid` 守卫已覆盖，实施期单测确认
- 集成测试中最小 RPC 子进程脚本的最简形态（可用 `node -e` 内联，无需完整 pi 二进制）——实施期确认，若不可行则退化为「真实 spawn 长驻脚本 + SIGTERM」
- cw-tool 现有测试对 spawner 的 mock 方式，Task 3 改动是否破坏现有测试契约——实施期跑 `pnpm extensions:test` 确认

---

## 附：设计依据与证据索引

- 事故 handoff：`/var/folders/.../handoff-pi-subagent-worktree-reaper-bug.md`（现场证据链：64s 时间吻合、路径格式吻合、worktree:False 反向成功）
- 本设计新增的独立核实（§2.2 表格，全部源码位置可复查）：header 分支注释自证不触发（`session-runner.ts:834-836`）、RPC mode 固定（`session-runner.ts:481`）、spawn-event-adapter 注释、测试 mock 清单（`session-start-reaper.test.ts:52` / `crash-recovery.test.ts:72` / `index-session-start.test.ts:119`）
- 版本历史：本 bug 由 2026-08-11 cw 递归编排生产事故暴露；此前低频场景未触发（§2.4）
