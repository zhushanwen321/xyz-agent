# Retrospect — perf-quick-batch

## 交付概述

打包修复 5 个零设计成本性能点，3 Wave 4 commit + 1 review_fix commit：
- L6：broadcast 单次 stringify（N 客户端从 N 次降到 1 次）
- M8：watchdog 单定时器+时间戳摊还（每帧 4 次定时器操作降到 O(1)）
- M5：打包模式 stdout 不转发 + stderr 文件兜底
- M6：stop 路径 sleep 异步化（消除主进程 200ms 阻塞）
- M4：scrollToBottom rAF trailing 节流（高频调用合并为单帧一次）

9 testCase 全 passed（7 mock + 2 real）。

## 执行过程复盘

### spec_review 阶段的最大价值

初稿判断「5 项方案明确无取舍」过于乐观。禁读重建（派 fresh subagent 不读 spec 从源头重建）暴露 7 个 must-fix：
- **M8 方向错误**（最严重）：初稿写"距上次 schedule 超阈值才重排"，这正是朴素阈值陷阱——会让旧定时器比新 deadline 近 → 提前触发 warn/abort。方向完全错误。改为只锁不变量（不提前+不延后）交实现选择。
- M4 守卫延迟求值、M5 早启动日志兜底、M6 调用方 await 级联——都是 trailing throttle / 异步化 / 禁用转发这类改动的固有陷阱，初稿用一句"不丢日志/不破坏语义"带过。

教训：**「快速批次/零设计成本」的判断要在 spec_review 用禁读重建复核**，否则固有陷阱会在 dev 阶段变成回归。本次若跳过 spec_review，M8 的提前触发 bug 和 M4 的扯回底部 bug 几乎必然引入。

### test 全绿质量自检

逐条核对 testCase 防线（非覆盖率填充）：
- U1/U2：性能特性断言（stringify 次数、定时器调用数）。删掉优化改回旧实现 → 立即红。**真防线**。
- U3/U4：M4 节流合并 + 延迟求值守卫。改回无节流/调用时捕获 stickToBottom → 红。**真防线**。
- U5/U6：M8 语义回归（不提前/不延后）。摊还实现若算错 deadline → 红。**真防线**。
- E1/E2：code review + 回归，防线较弱（非自动化断言），但改动简单 + 回归全绿覆盖。

盲区（已知未自动化）：
- M5 stderr 兜底落盘的实际行为（E1 仅 code review，未验证打包后文件确实写入）
- M6 "事件循环畅通"（INVAR-M6-6）无直接断言——execSync 改 await 是确定的语义改善，但无测试证明"等待期并发任务可执行"

### 过程问题

- **processIssue 1**：W2 的 CW dev validation 只看到 W2b（deea9f63）的 changedFiles，没覆盖 W2a（4771c349 的 process-control M5+M6）。因为 wave 只传一个 commitHash。CW 的 wave-commit 映射不支持多 commit，导致同 wave 多 commit 时 validation 不完整。非阻断（两 commit 都真实存在），但 audit 有缺口。
- **processIssue 2**：pre-existing 失败基线（event-interpreter-isolation ISO2 / event-interpreter-w3 U6 / file-read-permission，82127011 重构遗留）反复干扰判断。每次跑全量都要 stash 对比确认"非本次引入"。建议下个 topic 开始前先修 pre-existing 基线（handoff 也建议了）。
- **processIssue 3**：cwd 跨调用不持久的规则在 multi-workspace 反复踩。runtime 测试在 packages/runtime 跑、renderer 在 packages/renderer 跑、cw 命令在仓库根跑，多次因 cd 残留报错（topic not found / pathspec 不匹配）。每条 bash 都要显式 cd 绝对路径。

## 已知风险

| severity | area | 风险 | unverified |
|----------|------|------|------------|
| medium | M5 stderr 兜底 | 打包模式 stderr→文件兜底未在真实打包环境验证（E1 仅 code review）。getStderrSink 的 mkdirSync/createWriteStream 在打包后路径权限未测 | true |
| medium | M6 事件循环畅通 | INVAR-M6-6（等待期事件循环畅通）无自动化断言。execSync→await 是确定改善，但"并发任务可执行"未测 | true |
| low | M5 WriteStream 背压 | 高吞吐 stderr 时 write 返回 false 未处理 drain，极端情况可能丢尾部行。兜底日志非关键路径，可接受 | false |
| low | M4 pendingResolvers hang | rAF 被取消（卸载）时 pendingResolvers 的 Promise 不 resolve。调用方都是 void/不 await，但 force 路径若被取消会 hang。生产环境 rAF 自动执行不会触发 | false |

## 结论

5 项性能修复全部落地，核心不变量（M8 不提前不延后、M4 延迟求值守卫、L6 一致性）有测试防线。2 个 unverified 风险（M5 打包验证、M6 事件循环）建议在下次打包测试时手动确认。
