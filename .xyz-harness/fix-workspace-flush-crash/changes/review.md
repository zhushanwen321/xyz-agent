# Code Review — fix-workspace-flush-crash

## 审查范围
- commits: `ae75fb1f` (W0) + `4d4a21a3` (W1)
- 审查方式：subagent 对抗性审查 + 主 agent 交叉验证

## 发现的问题

| # | 维度 | 问题 | 严重度 | 位置 |
|---|------|------|--------|------|
| 1 | 边界条件 | E1 real test 的 W0 catch 内 scheduleFlush 注册的 500ms 重试 timer 在测试结束后可能泄漏到下一个 it | should_fix | recent-workspaces-real.test.ts |
| 2 | 测试覆盖 | E1 注释「atomicWrite 失败」措辞偏差：实际触发的是 writeFileSync(tmp) 的 EACCES，非 mkdirSync | nit | recent-workspaces-real.test.ts |
| 3 | 业务逻辑 | 持续磁盘故障时无限重试（每 500ms 一次 + 每次一条 console.error），无退避。write-back 语义可接受，但日志可能刷屏 | nit | json-store.ts:265-270 |

**已修复**：#1 — E1 测试末尾加 cleanup（恢复权限 + flushAll 成功清 dirty，pending timer 到点时 dirty 为空 → no-op）。#2 注释措辞同步修正。

**确认正确（无问题）**：
- W0 `dirty.clear()` 位于 try 成功路径末尾，catch 保留 dirty（符合 plan）
- W0 flushAll 各分区隔离，一个失败不影响其他
- W1 dirname 跨平台正确（实测 path.win32.dirname）
- W1 isEnoent 区分 ENOENT（静默）/ 损坏（warn），符合 INV-4
- 类型安全：catch 块均用 `e instanceof Error` 守卫，无 any/as 滑入

## plan 覆盖核对

### W1 (commit ae75fb1f) — WriteBackCache.flush 异常隔离
- [x] changes[0]: json-store.ts flush 包 try/catch + console.error + 保留 dirty + scheduleFlush — 完全符合
- [x] changes[1]: json-store.test.ts 新增 flush 失败隔离测试 — 超额（3 条：失败/重试/成功回归）

### W2 (commit 4d4a21a3) — persistToFile dirname + loadFromFile warn
- [x] changes[0]: persistToFile 改 dirname + loadFromFile 加 warn 区分 ENOENT — 完全符合
- [x] changes[1]: recent-workspaces-store.test.ts 新增 dirname 验证 + warn 断言 — 超额（3 条 mock + 2 条 real）

### testCases 覆盖（7/7）
- [x] U1: W0 flush 失败不抛+记日志+保留 dirty+重试
- [x] U2: W0 回归 flush 成功不重试
- [x] U3: W1 persistToFile dirname 推导
- [x] U4: W1 loadFromFile 损坏记 warn
- [x] U5: W1 ENOENT 静默不 warn
- [x] E1: W0 real 只读目录不 crash
- [x] E2: W1 real dirname 落盘

## 结论
- **must_fix: 0**
- should_fix: 1（#1 已修复）
- nit: 2（#2 已修正注释，#3 无限重试可接受）

7/7 testCase 全部落地，3 文件 55 tests 全绿，ESLint 0 error。**建议通过 review**。
