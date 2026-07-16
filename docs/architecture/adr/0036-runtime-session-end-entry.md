# ADR 0036：runtime 写 session_end 终态 entry

- 状态：Accepted
- 日期：2026-07-16

## 背景

前端侧栏每个 session 的状态点（done / error / stopped）目前**只能靠加载完整消息历史派生**。为了让侧栏显示准确状态，`loadSessions` 启动时对所有 session 全量预 hydrate 历史——这是启动卡顿 + 内存膨胀（H3）的根因。

要安全去掉预 hydrate，需要 runtime 提供可靠的 session 终态元数据。但现状：

- `SessionStatus` 类型只有 `'active' | 'idle' | 'dead'`
- 磁盘扫描（`scannedToSummary`）对所有历史 session 一律硬编码 `'idle'`
- pi 的 JSONL 文件头不记录终态

经 pi JSONL 格式深度验证（3790 个 session 文件实证）确认：pi JSONL 是 append-only 事件流日志，**不写 session 生命周期终结标记**。仅靠回扫文件尾部 stopReason 只能覆盖 ~2.5% 的情况（pi 自己写出 abort/error），进程崩溃 / kill / 静默卡死（最常见的"坏 session"）在 JSONL 里毫无痕迹。

## 决策

runtime 在 session 结束时**主动 append 一条 `session_end` entry** 到 JSONL 文件：

```json
{"type":"session_end","outcome":"done|error|stopped","reason":"...","timestamp":"..."}
```

三个终态捕获点（runtime 已 100% 知道 session 怎么结束，只是没落盘）：

| 捕获点 | outcome |
|--------|---------|
| `event-interpreter` turn-end handler（正常完成 / LLM 出错） | `done`（stopReason==='error' 时 `error`） |
| `message-dispatcher.abort`（用户 abort） | `stopped` |
| `session-service.onSessionExit`（进程退出 / 崩溃） | `stopped` |

scanner 新增 `extractSessionOutcome`（复用 `extractSessionName` 倒序扫描模式）读终态，`scannedToSummary` 用它替换硬编码 `idle`。

## 替代方案

- **独立 sidecar 文件（`<sessionId>.meta.json`）**：零 pi JSONL 竞态风险。但与 JSONL 可能脱同步（rename/delete session 时 sidecar 不跟随），且 scanner 要多读一个文件。append 到 JSONL 与现有 `persistSessionName`（append `session_info`）同一套路，改动更集中。
- **只读不写（靠 stopReason 推断）**：改动最小，但只能覆盖 pi 自己写出 abort/error 的情况（~2.5%），进程崩溃 / kill（最常见）完全无法识别。覆盖太差，不单独采用。

## 后果

- 正面：runtime session 列表元数据携带可靠终态（done/error/stopped），前端可安全去掉全量预 hydrate（启动秒开 + 内存不再随 session 数膨胀）。
- 正面：`persistSessionEnd` 复用 `persistSessionName` 的 `existsSync` guard + `openSync('a')` 模式，不违反规则 #6（pi `_persist` 的 openSync("wx") 竞态）。
- 正面：pi 忽略未知 entry type（已验证它能容忍 `session_info` 等非自身 entry），`session_end` 零冲突。
- 负面：方案上线前产生的历史 session 没有 session_end entry，scanner 读不到终态 → 一律显示 `idle`（渐进迁移，新 session 逐步积累准确终态）。
- 负面：极端崩溃（OOM kill / SIGKILL）时 `onSessionExit` 可能来不及执行，session_end 写不进去——这类 session 回退 idle。SIGTERM 正常路径能覆盖。
- `SessionStatus` 扩展为 `'active' | 'idle' | 'dead' | 'done' | 'error' | 'stopped'`（纯新增，加在联合类型末尾，现有消费 `active|idle|dead` 的代码不受影响）。
