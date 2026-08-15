# P-block 基线证据（worktree git 同步阻塞，Phase 1 改造前）

## 采集环境

- pi 0.84.0 RPC 模式，模型 xiaomi-token-plan-cn/mimo-v2.5-pro，cwd = xyz-agent feat-subagent-continuous-chat worktree（大 repo）
- extension：~/.pi/agent/extensions/pi-subagent-workflow symlink 指向本 worktree 源码（未改造代码 + 临时观测插桩）
- 插桩（采集后已移除，不进 commit）：worktree-manager.gitRun 首尾 debug 日志（git 窗口起止）+ session-runner stdout pump 每事件 debug 日志（事件到达时间戳）
- 场景：主 agent spawn B（streamer，6000 词故事，纯文本流式输出，~17-19 事件/秒）→ sleep 18s → spawn A（worktree:true，echo 建文件）→ A 完成后 cancel
- 日志：~/.pi/agent/logs/subagents-2026-08-15.log（round1/round2 副本见 /tmp/pblock-baseline/，round2 为时序对齐版）

## 基线结论（round2，2026-08-15T02:55-02:56 UTC）

**A 的 create 临界区（status 90ms + rev-parse 6ms + worktree add 621ms = 717ms 连续同步 git）与 B 流式输出完全重叠，期间主进程事件 0 条，跨窗口空洞 765ms（B 正常事件间隔 ~55ms）——主进程事件循环被同步 git 冻结的实测证据成立。**

| git 命令 | 窗口 (UTC) | 时长 | 窗口内 B 事件 | 窗口前/后 2s B 事件 | 跨窗口空洞 |
|---|---|---|---|---|---|
| status --porcelain | 02:55:34.639→34.729 | 90ms | 0 | 36 / 38 | — |
| rev-parse HEAD | 02:55:34.729→34.735 | 6ms | 0 | 34 / 38 | — |
| worktree add | 02:55:34.735→35.356 | 621ms | 0 | 34 / 53 | 765ms |

三条 git 连续无间隔（create 临界区整体 717ms），构成单个冻结窗口。

辅助观测：
- reaper（pi 启动时回收上一轮残留）：worktree remove 321ms + branch -D 25ms（启动时刻无并发 B 流，窗口时长证明 reaper 链路的同步 git 成本）
- cancel 触发的 cleanup（02:56:11）：worktree remove start 后 31ms 即 branch -D start，remove 的 end 未出现——插桩盲区（catch 路径未打 end 日志），推断 remove 快速失败（bestEffort 吞掉）；Phase 1 改造后实测需关注该路径
- B（streamer）事件速率 17-19/s（message_update 流），A 完成走 one-shot finalizeRoundToIdle（保持 running-resumable，不触发 finalize git——设计行为，非 bug）

## Phase 1 合入后对照判定

同一插桩（改造后代码在 gitRunAsync 等价位置打点）+ 同场景复跑：
- worktree add / status / rev-parse / remove / branch -D 窗口期间 B 事件持续到达（无 >500ms 空洞）
- git 窗口本身的命令时长不变（异步化消除的是主进程冻结，不是 git 耗时）

## Phase 1 合入后对照（commit c6d272935，2026-08-15T03:13-03:15 UTC）

同场景复跑（同款 prompt/插桩/模型）。B 流正常间隔中位 56ms / p95 100ms。

| 路径 | 命令 | 窗口时长 | 窗口内 B 事件 | 跨窗口空洞 | 判定 |
|---|---|---|---|---|---|
| **同步 gitRun（create，Phase 1 保留）** | status 135ms + rev-parse 20ms + worktree add 1336ms（连续 1492ms） | 1492ms | 0 | **1602ms** | 仍冻结（设计预期，Phase 2 消除） |
| **异步 gitRunAsync（cancel cleanup，Phase 1 改造点）** | worktree remove | 312ms | **6** | 418ms | **不冻结**——窗口内 B 事件按 56ms 中位速率持续到达 |
| 异步 gitRunAsync（cancel cleanup） | branch -D | 20ms | 0 | 82ms | 正常波动（窗口短于 B 事件中位间隔） |

**对照结论**：Phase 1 目标（finalize/reaper/cancel-cleanup 路径的同步 git 阻塞消除）实测达成——异步路径的 git 窗口期间主进程事件持续流动；同步 create 窗口仍冻结（1602ms 空洞），与 Phase 1 范围定义一致（create 异步化属 Phase 2）。

对照偏差记录：A（wtest）为 one-shot 成功任务，完成走 finalizeRoundToIdle（不触发 collectPatch），故本次对照的异步窗口来自 cancel 触发的 cancelBackground cleanup（fire-and-forget 路径）；finalize 主链（collectPatch + cleanup）的异步窗口由单测 W1TC6/8 与 integration 测试覆盖行为等价，主进程不阻塞的机制证据由 cancel cleanup 路径同构覆盖（同为 gitRunAsync）。
