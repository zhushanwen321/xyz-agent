# Code Review — subagent-runtime-push-badge

## 审查范围
- commits: 6c0a9b1e^..HEAD（2 个 commit：W1 + W2）
- 文件：event-interpreter.ts、stores/subagent.ts、useSubagentListSync.ts + 3 个测试文件

## 发现的问题

| 维度 | 问题 | 严重度 | 位置 |
|------|------|--------|------|
| 代码规范 | `status = bgResponse?.status === 'running' ? 'running' : 'running'` 三元两分支同值，无意义。应简化为 `status: SubagentStatus = 'running'` | should_fix | event-interpreter.ts:353 |
| 边界条件 | bg-notify 到达但内存态无对应记录（如 session 恢复后只收到 bg-notify 没收到 tool-call-end）→ 静默跳过（L382 `if (!existing) return`）。这是预期行为（首拉 RPC 兜底），但无日志，调试时不可见 | nit | event-interpreter.ts:382 |
| 类型安全 | `status` 变量缺少 `SubagentStatus` 类型标注，靠 SubagentRecord 的 status 字段隐式推断。加显式标注更清晰 | nit | event-interpreter.ts:353 |

## plan 覆盖核对

### W1 changes
- [x] event-interpreter.ts 新增 subagentRecords Map + pendingStartParams Map — 已落地
- [x] handleToolCallStart 缓存 startParam — 已落地（L208-211 + cacheSubagentStartParam）
- [x] handleToolCallEnd 合并建 running 记录 + 广播 — 已落地（L258-260 + handleSubagentEnd）
- [x] handle(kind:'message') 检测 bg-notify 更新终态 + 广播 — 已落地（L122-124 + handleSubagentBgNotify）
- [x] broadcastSubagents 私有方法 — 已落地（L403-411）
- [x] SubagentRecord 类型无需改 — 确认（slug/task/agent/status 已有）

### W2 changes
- [x] stores/subagent.ts 新增 subscribeSubagentPush — 已落地（L125-137）
- [x] useSubagentListSync.ts 删除 activityKey watch + computed — 已落地
- [x] useSubagentListSync.ts 新增 subscribeSubagentPush watch — 已落地（focusedSessionId watch immediate）
- [x] 删除 SUBAGENT_TOOL_NAMES import — 已落地

## 结论
- must_fix = 0
- should_fix = 1（L353 三元冗余，修后重 commit）
- nit = 2（可接受，不阻断）

修 should_fix 后重新 commit + cw(dev)，然后调 cw(review)。
