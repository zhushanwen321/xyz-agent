# pi-scheduler crash-fix — Ledger

> 开发期协调脚手架（cw-orchestrator 机制：验收基线入 git → builder 开发 → verifier 对抗验收 → 主 agent 核对流转 commit）。

## Unit 状态表

| unit | 模块 | 状态 | 验收基线 commit | 备注 |
|---|---|---|---|---|
| crash-fix | index.ts + runtime.ts + tests | committed | 3a8c2a43a | verifier PASS（.orchestration/acceptance/crash-fix-report.md）；F1 session_start 停旧 runtime + F2 tick catch 分诊；红性双红（移 F2 → Unhandled Rejection 复现崩溃形态 / 删 F1 → U4 行为证据红）；E2E 终裁：dispatch×new_session 交错 gap 0.026s（修复前 29.5s 必崩场景）交错后 75s+ 存活零 stale |

## 事件流水（时间倒序追加，永不覆盖）

- 2026-08-17 crash-fix 交付：上游排查（subagent-workflow .orchestration/ledger.md 观察项 4）实证根因——dispatchTask `await sendMessage` 窗口与 session 替换交错 → 旧 30s tick timer 泄漏 → `refreshWidget` 访问 stale `ctx.ui` getter 抛 → fire-and-forget 无 catch → unhandledRejection → pi exit 1（复现成功；idle 对照不崩）。修复 F1+F2 双层：源头幂等（session_start 先 `service?.runtime.stopScheduler()`）+ 防御兜底（tick 回调 catch 分诊，stale → 自停，其他 → warn 继续；不加 unref——rpc/daemon 模式下会致进程提前退出）。测试 200→204 全绿。**注意：全局安装版 `~/.pi/agent/npm/node_modules/@zhushanwen/pi-scheduler`（0.3.0）仍为旧版，bug 到达用户环境需 npm 发版（发布方式归用户决策）**。
