# crash-fix 验收报告（verifier 对抗式独立验收）

> 验收对象：pi-scheduler 0.3.0 stale ctx 崩溃修复（F1 session_start 先停旧 runtime + F2 tick catch 分诊）。
> 基线：`extensions/scheduler/.orchestration/acceptance/crash-fix-acceptance.md` @ commit `3a8c2a43a`。
> 执行者：verifier（独立重做红性验证与 E2E，不采信 builder 自报）。执行日期：2026-08-17。

## 总结论：**PASS**

全项通过：防篡改、命令实跑（typecheck/lint/vitest）、U1-U5 条款、差异点 a-d、红性验证（独立重做双红）、行为对抗抽查 4 条、E2E 崩溃重放（精确交错窗口 0.026s，进程存活无崩溃）。无失败项。

## 1. 防篡改

| 项 | 结果 |
|---|---|
| 基线 commit | `3a8c2a43a7996484b902da924bc4770fb62c2790`（docs(scheduler): crash-fix acceptance baseline） |
| 验收文档 diff | `git diff 3a8c2a43a -- .../crash-fix-acceptance.md` 为空（未篡改） |
| 验收文档 sha256 | `57b822ab24c83d278f6d0d178fb52c6bcc09a8563cc6d725e3bf47bee7f9518b` |
| 工作区越界扫描 | `git status -uall` 恰好 4 交付文件：`M src/__tests__/runtime.test.ts`、`M src/index.ts`、`M src/runtime.ts`、`?? src/__tests__/index-session-start.test.ts`，无越界 |

## 2. 命令实跑

| 命令 | 结果 |
|---|---|
| `pnpm extensions:typecheck` | exit 0 |
| `pnpm extensions:lint` | exit 0（0 errors / 188 warnings） |
| `npx vitest run`（extensions/scheduler） | **14 files / 204 tests 全部通过**，exit 0 |

lint 零新增告警核实：runtime.ts 的 6 个 warning（行 17×5 = `DEFAULT_EXPIRY_MS` 常量、行 313×1 = `hasDispatchCapacity` 的 60_000）全部位于 diff 的 context 未改动行或 hunk 之外，交付前已存在。还原后复跑全量仍 14/204 全绿。

## 3. U1-U5 条款对照（断言真实性）

| # | 条款 | 结果 | 关键证据 |
|---|---|---|---|
| U1 | stale 自停 | PASS | `runtime.test.ts:485-506`。onAfterTick 抛真实 pi 文案 `This extension ctx is stale after session replacement or reload.`；断言 warn 含 "tick stopped" 且不含 "tick error"；`nowSpy` 计数 >0 排除「timer 未启动」假绿；再 advance 60s now 计数零增长（timer 已停）。tickScheduler 无任务路径每 tick 恰调 `backend.now()` 一次（runtime.ts:198），观测面 1:1 对应 tick 次数，行为断言非空洞 |
| U2 | 非 stale 继续调度 | PASS | `runtime.test.ts:508-529`。'boom' → warn 含 "tick error" 且不含 "tick stopped"；再 advance 2×30s now 计数恰 +2（调度未终止） |
| U3 | 既有零回归 | PASS | runtime.test.ts 35 用例全过（既有 33 + 新增 U1/U2/U5），全套件 204 全绿 |
| U4 | 双 session_start 停旧 runtime | PASS | `index-session-start.test.ts:81-106`。fake pi（on/registerTool/registerCommand/sendMessage/appendEntry）+ fake ctx（sessionManager/isIdle/hasPendingMessages/ui.setWidget/cwd）+ mock importer（零 FS）；第二次 session_start 后 advance 30s，`second.setWidget` 恰 2 次（+1）、`first.setWidget` 保持 2（旧 timer 已停）。F1 缺失时 first 会到 3（红性 b 实证） |
| U5 | stopScheduler 幂等 | PASS | `runtime.test.ts:531-537`。startScheduler 后连续两次 stopScheduler 不抛 |

## 4. 差异点裁决（builder 披露 a-d）

| # | 差异 | 裁决 | 依据 |
|---|---|---|---|
| a | U4 用 ctx.ui.setWidget spy 替代验收写的 backend.now 计数 | **接受，等价成立** | `PiSchedulerBackend.now()` 硬编码 `return Date.now()`（backend.ts:93-94），确不可注入。setWidget 观测面每 tick 恰一次：tickScheduler 末尾 onAfterTick（runtime.ts:230）→ refreshWidget（index.ts:57）→ ctx.ui.setWidget（index.ts:157），无任务时无其他调用源；session_start 初始渲染恰 1 次已被断言口径扣除。与 now 计数同为 tick 次数的 1:1 映射 |
| b | U4 增加前置因果锚点 | **接受，属增强** | 第二次 session_start 前先 advance 30s 断言 first.setWidget 1→2，证明 timer1 曾真实 tick——排除「两个 timer 都没启动导致 +1 而非 +2」的假绿路径 |
| c | F1 注释 3 行（验收示例 1 行） | **接受** | 验收交付物表写「含原因注释」未锁注释行数；接口契约锁定的是代码行位置（session_start 第一行、`new PiSchedulerBackend` 之前）与幂等语义，均已满足（index.ts:47） |
| d | U5 放在 F2 describe 内 | **接受** | 验收 U5 写「可在 runtime.test.ts 追加一行用例」，未锁 describe 归属；断言内容与条款一致 |

## 5. 行为对抗抽查（4 条，逐 hunk 核对）

1. **F2 分诊语义精确匹配**：`STALE_CTX_MARKER = 'stale after session replacement'`。本机实际运行的 pi 0.84.0（`~/.nvm/.../pi-coding-agent/dist`）三处抛出点（extensions/runner.js:531、core/agent-session.js:768、extensions/loader.js:193）文案均为 `This extension ctx is stale after session replacement or reload. ...`，marker 是其精确子串，`message.includes(STALE_CTX_MARKER)` 方向正确。stale 分支调 `this.stopScheduler()`（runtime.ts:174），非 stale 分支仅 console.warn 不 stop（:176）。
2. **零触碰区段**：runtime.ts diff 仅 2 hunk（新增常量 + startScheduler 回调体）；tickScheduler / onAfterTick / dispatchTask / stopScheduler 函数体不出现在 diff。index.ts diff 仅 1 hunk（F1 3 行注释 + 1 行 stop），session_shutdown / turn_end handler、schedule/schedule_control tool 注册、refreshWidget、registerScheduleCommand 零触碰。
3. **无 .unref() 混入**：runtime.ts 全文与 diff 均无 unref（验收禁令：rpc/daemon 模式下 unref 会导致无 turn 时进程退出）。
4. **lint 6 warning 存量**：见 §2，全部位于未改动行。

## 6. 红性验证（verifier 独立重做，非采信自报）

改前备份至 /tmp 并记录 sha256；每次验证后字节级还原。

**a) 移除 F2 catch 链**（恢复为 `void this.tickScheduler()`）→ 跑 runtime.test.ts：
- 结果：**U1/U2 双红（2 failed），exit 1**
- 失败形态：`Unhandled Rejection ⎯⎯ Error: boom / stale ...`（vitest 捕获 unhandledRejection）+ warn 断言失败——正是修复前「tick 内异常无人接住 → unhandledRejection」的崩溃形态复现

**b) 删除 F1 行**（`service?.runtime.stopScheduler()`）→ 跑 index-session-start.test.ts：
- 结果：**U4 红，exit 1**
- 失败信息：`AssertionError: expected "vi.fn()" to be called 2 times, but got 3 times`（first.setWidget 3 次 = 旧 timer 仍在 tick 的直接行为证据）

**字节级还原核验**：
- index.ts sha256 还原后 `62156ab0bc058e122be33b151fc223e3da27457293f7fe0f0082deb0d3bd382d`（与改前一致）
- runtime.ts sha256 还原后 `89ae9ffac1141d914e5178ae9b1c0293e1b6e8885092a372c6cc723a13fdf680`（与改前一致）
- 全量 `git diff` sha256 前后一致：`9ab02faa1620e76cc8ddd10918fce4724b91b82c26e6136de34cbd728905f9dd`
- git status 仍恰好 4 交付文件；还原后全量 vitest 14 files / 204 tests 全绿

## 7. E2E 崩溃重放（修复有效性最终裁决）

**加载来源确证（防全局版污染）**：`pi list` 显示用户级 settings 启用了 `npm:@zhushanwen/pi-scheduler`（全局未修复版）。故启动参数采用 `--no-extensions`（--help 语义：Disable extension discovery, explicit -e paths still work）+ `-e <仓库>/extensions/scheduler`。**负面对照实验**：以无效 `-e /tmp/nonexistent-ext-dir-xyz` 启动 → pi 报 `Failed to load extension ... path does not exist` 退出且 stdout 无任何 scheduler widget——证明 `--no-extensions` 下 discovery 全禁，当前 daemon 的 scheduler 唯一来源是仓库路径。

**环境**：pi 0.84.0 rpc mode、`xiaomi-token-plan-cn/mimo-v2.5-pro`、`--approve`、session-dir=/tmp/sched-fix-verify/sessions、FIFO 驱动 stdin（JSON 带换行）。daemon PID 88056。

**流程与时间线**（两轮重放）：
1. `prompt "reply ok"` → 模型回 "ok"，agent_settled，stderr 空
2. `schedule tool` 创建 crash-test（prompt="say ping", schedule="35s", expires="never"）→ tool result 确认 `every 35s`，task 83c51da5
3. 第一轮 dispatched（ts 1786925800222）→ new_session（gap 9.5s，未严格落入 await 窗口）→ 等 70s：存活，作为预热
4. 新 session 上第二轮创建 crash-test-2 → **dispatched ts 1786926019799 → new_session gap = 0.026s**（0.2s 密轮询捕捉，精确落入 dispatch × session 替换交错窗口）→ 等 75s

**通过标准核对**：

| 标准 | 结果 |
|---|---|
| pi 进程存活 | PASS——交错后 75s+ 存活，daemon 总时长约 7 分钟（修复前同场景 29.5s 必崩，对照组已有）；最终追加 prompt "pong-confirm" 正常响应并 agent_settled，功能性存活确认 |
| stderr 无 unhandledRejection / "stale after session" | PASS——pi-stderr.log 全程零输出；stdout/stderr grep `unhandledRejection\|stale after session` 均 0 命中 |
| F2 warn（可选） | 未出现（`tick stopped`/`tick error` 均 0 次）——泄漏 timer 被源头掐死（F1 在 new_session 的 session_start 停旧 timer），F2 无从触发，符合验收「两者任一生效即通过，F2 warn 允许不出现」条款 |
| 调度健康 | new_session 后新 runtime 的 widget 以 30s 节奏持续刷新（setWidget 事件流），无 stale 抛错 |

诚实注记：F2 warn 零命中意味着本次 E2E 无法直接区分「F1 停的旧 timer」与「session_shutdown 正常触发停的」——但验收通过标准不要求区分（修复前对照组已证明该交错场景 shutdown 不可靠必崩；本次 0.026s 精确交错下 100s+ 存活即修复有效性成立）。

**清理**：kill daemon 88056（SIGTERM）+ FIFO holder 87752 + `rm -rf /tmp/sched-fix-verify`；进程/文件残留检查 0。

## 8. 结论

crash-fix unit 验收 **PASS**：F1/F2 实现与接口契约一致、禁改清单零违反、U1-U5 全部真实且具备红性（verifier 独立重做双红）、E2E 精确交错重放无崩溃。可进入提交流程（由主 agent 统一 commit）。
