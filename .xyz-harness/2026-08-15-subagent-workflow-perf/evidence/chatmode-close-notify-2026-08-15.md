# chatMode close 终态通知证据（场景 4 修复后复测，commit 3dec1719d）

## 结论（先行）

**场景 4 修复后判定 = 通过（21/21 断言）**。chatMode subagent 3 轮后 idle 状态下 `action:"close"`，父 session 收到的 bg-notify 消息序列为**「3 条轮次通知 + 1 条终态通知」共 4 条**——最后一条轮次通知（含 ROUND3 增量）未被吞，终态通知独立到达且含 `completed after 3 rounds` 轮次统计 + `Result:\n` 空正文占位 + `Full transcript: <路径>` 指针行，指针路径真实存在且文件含 3 轮全文。one-shot 对照复测通过（6/6 断言）：完成通知仍为 `completed. Result:` 逐字节形态，无轮次统计、无指针行。

修复前对照（同目录 `chatmode-baseline-2026-08-15.md:66`）：close 后父 JSONL **无新增** notify entry（终态通知发送点不存在），修复承诺的行为此前从未发生。

## 采集环境

- 时间：2026-08-16T04:04-04:06 UTC（12:04-12:06 本地）
- pi 0.84.0 RPC 模式，PI_EXT_DEBUG=1
- 被测代码：本 worktree（feat-subagent-continuous-chat）commit `3dec1719d`（close 终态通知 + D2 轮次统计），`git status` 确认 `extensions/subagent-workflow` 工作区干净，`--extension` 显式加载 `extensions/subagent-workflow`
- 模型：`xiaomi-token-plan-cn/mimo-v2.5-pro`（父 + 子同模型）
- cwd：临时干净目录 `/tmp/c4-close-run/run-s4-thQVao/cwd`（无 git repo）
- 父 session：`--session-dir /tmp/c4-close-run/run-s4-thQVao/sessions`，文件 `2026-08-16T04-04-39-871Z_01a008be-3b3f-7f87-8771-e4db4345322b.jsonl`
- 完整复现命令（driver 脚本内逻辑）：

```bash
pi --mode rpc \
   --session-dir /tmp/c4-close-run/run-s4-thQVao/sessions \
   --model xiaomi-token-plan-cn/mimo-v2.5-pro \
   --approve \
   --extension /Users/zhushanwen/Code/xyz-agent-workspace/feat-subagent-continuous-chat/extensions/subagent-workflow
# stdin JSONL：{id:"g1",type:"get_state"} → 1.5s 后 {id:"p1",type:"prompt",message:<编排 prompt>}
```

编排 prompt（与 wave2 场景 2 同协议）：start chatMode subagent（task：只回 `ROUND1-<标记>`）→ 收到含 ROUND1 的轮次通知后立即 `action:"message"` 发 ROUND2 → 同法 ROUND3 → 收到含 ROUND3 的通知后 `action:"close"` → 父回 `DONE`。标记 `ROUNDn-B3K8-M6R1-T9W4-Y2J7-N5C8-H1F6-D4S9-G7V3-X2Q5-L8Z6`（56 字符）。

## 场景 4（idle close）时间线（父 JSONL entry 时间戳）

| 时刻 (UTC) | 事件 | 说明 |
|---|---|---|
| 04:04:47.739 | `subagent` toolCall `action:start`（conversation:true） | 子进程 spawn |
| 04:04:57.875 | notify #1（轮次，len 330，含 ROUND1） | start 后 10.1s |
| 04:05:02.822 | toolCall `action:message`（ROUND2 指令） | 父被轮次通知唤醒 |
| 04:05:08.297 | toolCall `action:message`（重试，缺 subagentId） | 模型侧一次失败重试，不影响通知序列 |
| 04:05:10.515 | notify #2（轮次，len 330，含 ROUND2） | |
| 04:05:13.315 | toolCall `action:message`（ROUND3 指令） | |
| 04:05:15.627 | notify #3（轮次，len 330，含 ROUND3） | **最后一条轮次通知，未被终态吞** |
| 04:05:18.001 | toolCall `action:close` | idle 下 close（closeChatIdle 路径，D2 路径②） |
| **04:05:18.018** | **notify #4（终态，len 283）** | **close 后 17ms 落盘——close tool call 执行中同步持久化** |
| 04:05:19.883 | 父 assistant 回复 `DONE` | 终态通知的 triggerTurn 与本 turn 衔接 |

## 父侧收到的通知原文（4 条 custom_message entry 逐字摘录）

notify #1-#3（轮次通知，仅当轮标记不同；`<PATH>` 代指下方子 session 绝对路径）：

```
Subagent "general-purpose" (sa-4d4e6f43-376a-46ba-bd8f-38f1b38e4354) finished a round. Reply:
ROUND3-B3K8-M6R1-T9W4-Y2J7-N5C8-H1F6-D4S9-G7V3-X2Q5-L8Z6

Full transcript: <PATH>
```

notify #4（**终态通知全文**，len 283）：

```
Subagent "general-purpose" (sa-4d4e6f43-376a-46ba-bd8f-38f1b38e4354) completed after 3 rounds. Result:


Full transcript: <PATH>
```

其中 `<PATH>` = `/Users/zhushanwen/.pi/agent/subagents/--private-tmp-c4-close-run-run-s4-thQVao-cwd--/sessions/2026-08-16T04-04-50-463Z_01a008be-649f-72e1-938a-d6c5cc134162.jsonl`

形态分解（重建长度与实际逐字节吻合 283/283、330/330）：

- 终态 283 = 102（`…completed after 3 rounds. Result:` 头）+ 1（`\n`）+ **0（空正文占位）** + 2（`\n\n`）+ 17（`Full transcript: `）+ 161（路径）
- 轮次 330 = 96（`…finished a round. Reply:` 头）+ 56（当轮标记）+ 2 + 17 + 161
- 终态 details：`{status:"closed", totalRounds:3, sessionFile:"<PATH>"}`（sessionFile 与指针行一致）

## 断言结果（judge.js，15/15 通过）

- close action 被父调用且在 start/message 之后（actions = start,message,message,message,close）：通过
- 恰 4 条 notify，顺序 round,round,round,final：通过
- 第 3 条轮次通知未被吞（含 ROUND3 + 指针行 + 文件存在）：通过
- 终态通知含 `completed after 3 rounds. Result:`：通过
- 终态正文空串占位（`Result:\n` 后直达 `\n\nFull transcript:`，正则锚定）：通过
- 终态通知不含任何轮次标记（idle close 不带末轮增量，D2 路径②语义）：通过
- 终态指针行存在、文件真实存在、文件含 3 轮全部标记（ROUND1/2/3，4532 字节）：通过
- 终态 details.status === "closed"、totalRounds === 3、sessionFile 与指针行一致：通过

## one-shot 对照复测（场景 5，6/6 通过）

同环境另跑（run-s5-eVD7Em，27s）：不带 `conversation` 的普通 background one-shot，完成通知原文：

```
Subagent "general-purpose" (sa-3ce5738b-8a58-4100-9794-8935414391d2) completed. Result:
ONESHOT-MARK-Q5R7-T2W9
```

- 结构级：details keys = id/status/agent/model/result/startedAt/round，无 sessionFile、无 totalRounds：通过
- 语义级：无 `Full transcript:` 指针行、无 `after N rounds` 统计；content 与确定性重建 `Subagent "<agent>" (<id>) completed. Result:\n<result>` 逐字节相等：通过

## 遇到的坑（如实记录）

1. 模型侧一次 message 重试（04:05:08.297 的 toolCall 缺 subagentId）：参数不全的调用失败后模型自动重发正确形态，通知序列不受影响（仍 4 条干净序列）。
2. 扩展日志佐证有限：`~/.pi/agent/logs/subagents-2026-08-16.log` 中该 subagent 仅 1 行 `execCtxAls initialized`，close 路径（notifyClosed/closeChatIdle）无专项 debug 日志输出。判定以父 session JSONL 的 custom_message entry 为权威依据（通知的持久化事实层）。
3. 终态通知在 close tool call 执行中同步落盘（间隔 17ms），并非父 idle 后退避重试才发——notifier 的 isIdle gate 在 tool 执行阶段（assistant 输出已结束）即放行。

## 采集产物（临时目录，不随 commit）

`/tmp/c4-close-run/`：driver.js（驱动）+ judge.js（判定）+ run-s4-thQVao / run-s5-eVD7Em（pi-stdout.jsonl 事件流、pi-stderr.log、父 session 副本目录）。子 session 原件在 `~/.pi/agent/subagents/` 下（路径见上）。
