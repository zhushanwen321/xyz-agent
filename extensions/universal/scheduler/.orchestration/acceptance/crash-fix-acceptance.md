# crash-fix 验收标准

> **builder 与 verifier 禁止修改本文档**（防篡改基线，commit 后以 git diff 为锚）。
>
> unit：crash-fix — pi-scheduler 0.3.0 stale ctx 崩溃修复（F1 泄漏源头幂等 + F2 tick 防御兜底）。
> 排查依据：2026-08-17 复现报告（dispatch await 窗口 × session 替换交错 → 旧 30s tick timer 泄漏 → `refreshWidget` 访问 stale `ctx.ui` getter 抛 → `void tickScheduler()` fire-and-forget 无 catch → unhandledRejection → pi exit 1）。完整结论见 `extensions/subagent-workflow/.orchestration/ledger.md` 观察项 4。

## 目标

1. **F1（治本）**：session_start 多发/重入时，先停上一代 runtime 的 tick interval，从源头消灭 timer 泄漏（dispatch await 窗口交错下 session_shutdown 路径不可靠，此处为幂等主防线）。
2. **F2（防御）**：tick 回调的 async 链加 catch——stale 类错误自停（泄漏 timer 主动退场），非 stale 错误仅告警不终止调度。任何未预见路径的泄漏不再崩 pi 主进程。

## 交付物（文件级，精确清单）

| 文件 | 变更 |
|---|---|
| `extensions/scheduler/src/index.ts` | F1：session_start handler 开头 `service?.runtime.stopScheduler()`（含原因注释） |
| `extensions/scheduler/src/runtime.ts` | F2：`startScheduler` 的 interval 回调加 `.catch` 分诊（stale → stopScheduler 自杀 + warn；其他 → warn 继续调度）；新增模块级 `STALE_CTX_MARKER` 常量 |
| `extensions/scheduler/src/__tests__/runtime.test.ts` | F2 单测追加（U1/U2） |
| `extensions/scheduler/src/__tests__/index-session-start.test.ts` | **新建**：F1 集成单测（U4） |

仅允许新建/修改上述 4 文件。

## 接口契约（行为语义锁定）

### F1（index.ts）

session_start handler 第一行（在 `new PiSchedulerBackend` 之前）：

```ts
service?.runtime.stopScheduler()
```

- `service` 为 factory 闭包变量（现有），`runtime` 与 `stopScheduler` 均为 public（现有）。
- stopScheduler 幂等（tickTimer 已 null 时 no-op），故 shutdown 已停过再停一次无副作用。
- 禁止改动 handler 其余装配逻辑与 session_shutdown handler。

### F2（runtime.ts）

```ts
const STALE_CTX_MARKER = 'stale after session replacement'  // 匹配 pi ExtensionRunner 的 stale 错误文案片段

startScheduler(): void {
    if (this.tickTimer) return
    this.tickTimer = setInterval(() => {
        void this.tickScheduler().catch((err: unknown) => {
            const message = err instanceof Error ? err.message : String(err)
            if (message.includes(STALE_CTX_MARKER)) {
                console.warn(`[scheduler] tick stopped: stale extension ctx (session replaced); timer self-retired`)
                this.stopScheduler()
            } else {
                console.warn(`[scheduler] tick error: ${message}`)
            }
        })
    }, TICK_INTERVAL_MS)
}
```

- 行为表（验收锚点）：

| # | tick 内异常 | 行为 |
|---|---|---|
| B1 | message 含 `stale after session replacement`（pi stale ctx 错误） | console.warn（含 "tick stopped"）+ `stopScheduler()`；此后不再 tick |
| B2 | 其他任何错误 | console.warn（含 "tick error"）+ 调度继续（下个 30s tick 照常） |
| B3 | 无错误 | 与现状完全一致（零行为变化） |

- **禁止给 tick timer 加 `.unref()`**（rpc/daemon 模式下无 turn 时进程会直接退出，定时任务死——排查期已论证）。
- `tickScheduler` / `onAfterTick` / `dispatchTask` 本体逻辑零改动（防御加在 startScheduler 单点）。

## 单测验收（逐条可查，测试框架 vitest）

**F2（runtime.test.ts 追加 describe「tick 错误分诊（F2）」）**：
- U1 stale 自停：`runtime.onAfterTick(() => { throw new Error('This extension ctx is stale after session replacement or reload.') })` + `startScheduler()` + fake timers `advanceTimersByTime(TICK_INTERVAL_MS)` → console.warn 被 spy 到含 "tick stopped"；再 `advanceTimersByTime(TICK_INTERVAL_MS * 2)` → backend.now 的调用计数不再增长（timer 已停）。红性锚点：去掉 F2 catch 时本测试以 unhandledRejection/进程级失败或断言失败的形式变红（verifier 执行红性验证）
- U2 非 stale 继续调度：`onAfterTick(() => { throw new Error('boom') })` + 同上 advance 一次 → warn 含 "tick error"；再 advance 两次 → now 计数 +2（调度未终止）
- U3 无错误回归：既有 runtime.test.ts 全量用例零回归

**F1（新建 index-session-start.test.ts）**：
- U4 双 session_start 停旧 runtime：构造 fake `ExtensionAPI`（`on`/`registerTool` 记录 handler；commands 注册经 `registerScheduleCommand(pi, getter)` 捕获 service getter——fake pi 需支持 commands.ts 用到的 API 面，读 `commands.ts` 确认最小 fake 集）→ 调 `schedulerExtension(fakePi)` → 手动触发 session_start handler 两次（每次传 fake ctx，需覆盖 `PiSchedulerBackend` 构造用到的 ctx 字段——读 `backend.ts` 确认最小 fake；`loadTasks` 路径若触 IO 可用 tmp 目录 fixture）→ 从 getter 取第一次的 service_1 → `advanceTimersByTime(TICK_INTERVAL_MS)` → 断言 backend.now/appendEntry 等 spy 计数只按**一个** runtime 的节奏增长（旧 timer 已停，非两个）。若 service_1 的 runtime 无公开观测面，以「第二次 session_start 后 advance 30s，now 计数恰 +1」的行为断言为准（两个 timer 都活着时为 +2）
- U5 stopScheduler 幂等：连续调用两次不抛、无副作用（可在 runtime.test.ts 追加一行用例）

## 修复后 E2E 复现验证（verifier 执行项，修复有效性的最终裁决）

按排查期复现方法重放（本次用**仓库源码**加载，不动全局安装版）：

```bash
# daemon（--extension 指向仓库 scheduler 包目录，其余同复现方法）
XYZ_AGENT_DEBUG=1 pi --mode rpc --session-dir <tmp> --model xiaomi-token-plan-cn/mimo-v2.5-pro --approve \
  --extension /Users/zhushanwen/Code/xyz-agent-workspace/feat-subagent-continuous-chat/extensions/scheduler
# FIFO 驱动：prompt 初始化 → schedule tool 创建 "35s" interval 任务（非 force）
# → 观察到 pi-scheduler:dispatched 立即发 {"id":N,"type":"new_session"}
# → 等 ≥70s（覆盖旧 timer 下一 tick）
```

通过标准：pi 进程存活；stderr 无 unhandledRejection；若 F2 路径命中（泄漏 timer 触发 stale catch）则可见 `[scheduler] tick stopped` warn——允许不出现（若 F1 已把泄漏掐死在源头则 F2 无从触发，两者任一生效即通过）。对照：修复前该场景 29.5s 必崩（排查期已证）。结束后清理全部派生进程与 tmp。

## 通过命令（自验 + verifier 实跑）

```bash
zsh -c 'cd /Users/zhushanwen/Code/xyz-agent-workspace/feat-subagent-continuous-chat && pnpm extensions:typecheck'   # exit 0
zsh -c 'cd /Users/zhushanwen/Code/xyz-agent-workspace/feat-subagent-continuous-chat && pnpm extensions:lint'          # exit 0，4 文件零新增告警
zsh -c 'cd /Users/zhushanwen/Code/xyz-agent-workspace/feat-subagent-continuous-chat/extensions/scheduler && npx vitest run'  # 全绿（含既有 13 文件全量）
```

## 禁改清单（违反 = FAIL）

- 验收文档本体
- scheduler 包其余源文件（backend.ts / commands.ts / service.ts / tool.ts / widget.ts / parsing.ts / format.ts / importer.ts / replay.ts / types.ts）
- `runtime.ts` 的 `tickScheduler` / `onAfterTick` / `dispatchTask` / `stopScheduler` 函数体（F2 只改 `startScheduler` + 新增常量；stopScheduler 零改动）
- `index.ts` 除 F1 一行 + 注释外的任何改动（含 session_shutdown handler、tool/command 注册、refreshWidget）
- 其他 extensions/* 包与仓库任何文件
- `~/.pi/` 下任何文件（全局安装版不动，本次验证经 `--extension` 加载仓库源）
- 任何 git 写操作（主 agent 统一提交）

## status: pending
