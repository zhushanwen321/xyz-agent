# ADR 0035: watchdog 从「事件静默检测」改为「进程健康探测（ping）」

**Status**: Accepted
**Date**: 2026-07-20

## Context

### 触发事故

0.7.2 版本中，主 agent 调用 `ask_user` 工具后，用户思考期间（无操作），watchdog 在 120s 时发「长时间无响应」灰色提示，300s 时触发 `onSilentAbort` → `sessionService.abort()` → pi 子进程被 kill → ask_user 的 `signal` 被 abort → 工具返回 `"User cancelled. Do not assume an answer..."`。

用户全程未操作，却被判定为「取消」。日志铁证（`runtime-2026-07-20.log` 三次 ABORT，时间戳与 pi JSONL 的 ask_user 调用精确对齐）。

### 根因（信号选错，非补丁可救）

旧 watchdog 用「事件静默时长」检测「pi 卡死」：

```
SILENT_WARN_MS  = 120_000  // 静默 120s → 广播 message.stream_warn
SILENT_ABORT_MS = 300_000  // 静默 300s → onSilentAbort → kill pi
```

状态机：`startWatchdog (turn-start) → resetWatchdog (活动事件) / pauseWatchdog (extension-ui) → clearWatchdog (turn-end/agent_end)`。

**「事件静默」≠「pi 卡死」**。pi 在多种合理场景下都会静默：
- ask_user 等待用户响应
- 工具内 await 网络/文件锁/慢操作
- 子进程等待

pauseWatchdog 是为区分这些场景打的补丁。但补丁架构天然脆弱：
1. **已发生的 bug**：`handleExtensionUIRequest` 对每个 ask_user 产出 `[extension-ui, message]` 双事件，`extension-ui` 先 `pauseWatchdog()`，紧跟的 `message` 触发 `resetWatchdog()`，而 resetWatchdog 无条件 `watchdogPaused = false`——pause 被同批事件抹掉。WD6 单测只喂单事件，漏测这个真实翻译器输出契约。
2. **结构性缺陷**：每新增一种「pi 合理等待」场景，都得记着加 pause 点。漏一个就误杀。打地鼠模式。

### ping 可行性验证（决定性）

静态分析 pi 源码（`pi-mono/packages/coding-agent/src/modes/rpc/rpc-mode.ts`）确认：

1. **L784** pi 的 stdin 是事件循环上的异步 listener（`attachJsonlLineReader`），不随 agent loop 阻塞而停止
2. **L128** `ctx.ui.select()` 是 `await`——Node.js 里 `await` 只挂起当前 async 函数的 Promise，**不阻塞事件循环**
3. **L445-461** `get_state` handler 是纯同步读 session 属性，不 await、不依赖 agent loop 状态

结论：**pi 在 ask_user 等待期间（以及任何 `await` 阻塞场景），RPC 事件循环完全活着，能正常响应 get_state**。只有进程真死（死锁/崩溃/无限循环）才会 ping 超时。

ping 能穿透所有「pi 合理等待」场景，从根本上区分「卡死」与「等待」。

## Decision

**用进程健康探测（ping get_state）替代事件静默检测。**

### 新机制

- **删除** `SILENT_WARN_MS`（120s WARN）——价值低噪声大，ping 能准确判定卡死，不需要「不确定时提示」
- **删除** `pauseWatchdog` / `resetWatchdog` / `watchdogPaused` / `watchdogLastActivityAt` / `watchdogWarned` 整套旧状态机
- **保留** `message.stream_warn` 事件类型及其前端 effect（`chat-message-effects.ts` 的 `stream_warn` handler），**但改触发条件**：由旧「事件静默 120s」改为「ping 连续失败 2 次（120s）」。信号源从「事件静默」改为「进程健康探测失败」，语义更准
- **替换为** ping 探测：
  - 每 60s 发一次 `get_state`
  - 连续 2 次（120s）无响应 → 广播 `message.stream_warn` 一次（提示性，不中断流）
  - 连续 3 次（180s）无响应才判定卡死 → `onSilentAbort` → abort
  - turn-start 启动探测，turn-end/agent_end 停止（只在 turn 进行中检测）
- **保留** `case 'extension-ui'` 事件分支（仍需通知 server 缓存 pending 请求），但不再 `pauseWatchdog`

> **[CL2 D1 修订]** 初稿曾决定「删除 `message.stream_warn` 事件类型及其前端 effect」。
> Code review 后修订为保留：WARN 提示对用户仍有诊断价值（提前 60s 提示进程可能卡死，
> 而非等到 abort），只是把触发信号源从「事件静默」改为「ping 失败」。本 ADR 的 Decision
> 段已按 D1 修订更新，superseds 初稿的 stream_warn 删除决策。

### 阈值依据

- **60s 间隔**：平衡 RPC 流量与响应速度。每分钟一次 get_state 是轻量请求
- **连续 3 次=180s**：与旧 ABORT 阈值（300s）接近但更准。正常波动（GC 暂停、系统调度）不会连续 3 次失败；真卡死 3 分钟内发现
- ping 机制本身几乎不误判——pi 活着就一定会响应 get_state，连续 3 次失败是强信号

### ask_user 问题自动消失

ping 不需要知道 pi 当前在等什么。ask_user / 网络 / 文件锁 / 任何合理等待，只要进程活着 ping 就响应。**未来新增任何等待场景也不受影响**。

## Alternatives Considered

### A. 修 pause 被抹掉的 bug（方向 A：resetWatchdog 按 message type 判定）

让 resetWatchdog 只响应 pi 内容事件（text_delta/thinking/tool_call），不响应协议控制帧（extension.ui_request/extension.error/extension.notify）。

- **优点**：改动小（5-10 行），顺带修 extension.error/notify 的同类隐患
- **否决理由**：治标不治本。仍是「事件静默」检测，pause 补丁架构的脆弱性不变——未来新等待场景仍需加 pause 点。本次 bug 本质是架构缺陷，补丁只延后下一次事故

### B. 调整双事件顺序（`[message, extension-ui]`）

让 pause 在最后生效。

- **否决理由**：只是把 bug 挪位置。任何后续真实活动事件（如下一个 text_delta 在 pi 还没收到 user response 的极端竞态）仍可能错误 reset。且改变 send 顺序可能影响前端契约

### C. 保留旧机制作 fallback

新旧两套并存。

- **否决理由**：旧机制有已知 bug（pause 被 reset 抹掉），保留 = 保留 bug。ping 准确率高于事件静默，fallback 价值为零，徒增复杂度

## Consequences

### 正面

- **正面解决** ask_user 误杀问题，且未来任何合理等待场景都免疫
- **简化架构**：删掉 start/reset/pause/clear 四态状态机，换成单一周期定时器
- **语义修正**：「卡死检测」用「进程是否响应」这个正确信号，而非「事件是否静默」这个错误信号
- **测试契约修正**：新测试必须用真实 `translate()` 输出（双事件），杜绝本次「手搓 helper 与翻译器输出脱节」的漏测

### 负面

- **改动面**：event-interpreter.ts 主体重构 + index.ts 注入点改 + 测试重写。单次 PR 改动量中等
- **RPC 流量增加**：turn 进行中每分钟一次 get_state。轻量，但严格非零
- **ping 本身可能误判**：极端情况（pi 进程僵死但事件循环偶发响应、系统级休眠）可能漏判或延后。阈值（连续 3 次）给了缓冲，但非绝对零风险

### 不变

- `onSilentAbort` 回调签名不变（仍是 `{ sessionId } => void`），index.ts 注入点逻辑不变（仍调 `sessionService.abort`）
- `message.stream_warn`（提示性 WARN）保留，触发条件改为 ping 连续失败 2 次（见 Decision 段 [CL2 D1 修订]）
- `message.stream_error`（真错误）不受影响
